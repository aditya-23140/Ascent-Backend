import { wsManager } from './wsManager';
import { prisma } from '../lib/prisma';
import { spoonService } from './spoonService';
import { rewardService } from './rewardService';
import { levelService } from './levelService';
import { streakService } from './streakService';

export type TimerStateName = 'IDLE' | 'FOCUS' | 'HYPERFOCUS' | 'BREAK' | 'DISENGAGED';

export interface TimerState {
  userId: string;
  taskId?: string;
  subtaskId?: string;
  subtaskTitle?: string;
  state: TimerStateName;
  secondsElapsed: number;
  plannedSeconds: number;
  remainingSeconds: number; // Used for countdowns (Focus/Break)
  interval?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  pomodoroMode: string;
  cycleCount: number;
  hyperFocusDuration: number; // in seconds
}

class TimerEngine {
  private activeTimers: Map<string, TimerState> = new Map();
  private HYPERFOCUS_CAP_MINUTES = 45;
  private DEFAULT_BREAK_MINUTES = 5;
  private DISENGAGEMENT_IDLE_SECONDS = 30;

  private VALID_TRANSITIONS: Record<TimerStateName | 'COMPLETED', (TimerStateName | 'COMPLETED')[]> = {
    'IDLE': ['FOCUS'],
    'FOCUS': ['HYPERFOCUS', 'BREAK', 'DISENGAGED', 'COMPLETED', 'IDLE'],
    'HYPERFOCUS': ['BREAK', 'DISENGAGED', 'COMPLETED', 'IDLE'],
    'BREAK': ['FOCUS', 'IDLE'],
    'DISENGAGED': ['FOCUS', 'IDLE'],
    'COMPLETED': ['IDLE']
  };

  private validateTransition(current: TimerStateName | 'COMPLETED', next: TimerStateName | 'COMPLETED'): boolean {
    return this.VALID_TRANSITIONS[current].includes(next);
  }

  async startTimer(userId: string, durationMinutes: number, taskId?: string, subtaskId?: string, subtaskTitle?: string) {
    this.cleanup(userId);

    // 1. Fetch user preferences
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { pomodoroMode: true, role: true, hyperFocusDuration: true }
    });

    // 2. Deduction: Starting a focus session costs 1 spoon (allow overdraft)
    try {
      await spoonService.deductSpoons(userId, 1, true);
    } catch (err: any) {
      console.error('[TimerEngine] Spoon deduction failed:', err.message);
      if (err.message === 'NOT_ENOUGH_ENERGY') {
        throw new Error('Insufficient spoons to start session');
      }
      // Continue for other errors? Or throw?
      throw err;
    }

    const durationSeconds = durationMinutes * 60;
    
    // Get current cycle count from recent sessions
    const lastSession = await prisma.session.findFirst({
      where: { userId, status: 'completed' },
      orderBy: { endedAt: 'desc' },
      select: { cycleCount: true }
    });
    const cycleCount = ((lastSession?.cycleCount || 0) % 4) + 1;

    const state: TimerState = {
      userId,
      taskId,
      subtaskId,
      subtaskTitle,
      state: 'FOCUS',
      secondsElapsed: 0,
      plannedSeconds: durationSeconds,
      remainingSeconds: durationSeconds,
      pomodoroMode: user?.pomodoroMode || 'flexible',
      cycleCount,
      hyperFocusDuration: (user?.hyperFocusDuration || 45) * 60
    };

    // 3. Persist Initial Session
    try {
      await prisma.session.create({
        data: {
          userId,
          state: 'FOCUS',
          status: 'in_progress',
          phase: 'work',
          duration: 0,
          plannedDuration: durationMinutes,
          pomodoroMode: state.pomodoroMode,
          cycleCount: state.cycleCount,
          startedAt: new Date()
        }
      });
    } catch (err) {
      console.error('[TimerEngine] Failed to create session:', err);
    }

    state.interval = setInterval(() => this.tick(userId), 1000);
    this.activeTimers.set(userId, state);
    this.broadcastState(userId);
  }

  private async tick(userId: string) {
    const state = this.activeTimers.get(userId);
    if (!state || !state.interval) return;

    if (state.state === 'FOCUS') {
      state.secondsElapsed++;
      if (state.remainingSeconds > 0) {
        state.remainingSeconds--;
      } else {
        // FOCUS timer ended. 
        // We stay in FOCUS but with remainingSeconds at 0, 
        // and let the idle timer handle the auto-advance to HYPERFOCUS after 30s.
        if (!state.idleTimer) {
          this.startIdleTimer(userId, 'HYPERFOCUS', 30);
        }
      }
    } else if (state.state === 'HYPERFOCUS') {
      state.secondsElapsed++;
      const hyperFocusElapsed = state.secondsElapsed - state.plannedSeconds;
      if (hyperFocusElapsed >= state.hyperFocusDuration) {
        // Force break on cap reached (Yellow state)
        await this.startBreak(userId);
      }
    } else if (state.state === 'BREAK') {
      if (state.remainingSeconds > 0) {
        state.remainingSeconds--;
      } else {
        // BREAK ends -> Enter IDLE period to wait for disengagement
        // We keep the timer running to check for the 30s disengagement
        this.stopTick(userId);
        this.startIdleTimer(userId);
      }
    } else if (state.state === 'DISENGAGED') {
      // "progress slowly decreases"
      if (state.secondsElapsed > 0) {
        state.secondsElapsed = Math.max(0, state.secondsElapsed - 1);
      }
    }

    this.broadcastState(userId);
  }

  private async enterHyperFocus(userId: string) {
    const state = this.activeTimers.get(userId);
    if (!state) return;

    state.state = 'HYPERFOCUS';
    
    try {
      // HyperFocus bonus deduction: -2 spoons on entry (allowed overdraft)
      await spoonService.deductSpoons(userId, 2, true);
      
      const currentSession = await prisma.session.findFirst({
        where: { userId, status: 'in_progress' },
        orderBy: { startedAt: 'desc' }
      });

      if (currentSession) {
        await prisma.session.update({
          where: { id: currentSession.id },
          data: { 
            state: 'HYPERFOCUS',
            hyperFocusStartedAt: new Date()
          }
        });
      }
      
      // Push fresh stats to all clients (web + device) immediately
      await wsManager.sendDashboard(userId);
    } catch (err) {
      console.error('[TimerEngine] HyperFocus entry failed:', err);
    }
  }

  async startBreak(userId: string, durationMinutes?: number) {
    const state = this.activeTimers.get(userId);
    const breakDuration = (durationMinutes || this.DEFAULT_BREAK_MINUTES) * 60;

    if (state) {
      const wasWork = state.state === 'FOCUS' || state.state === 'HYPERFOCUS';
      if (wasWork) {
        await this.finalizeWork(userId, state);
      }

      state.state = 'BREAK';
      state.remainingSeconds = breakDuration;
      state.plannedSeconds = breakDuration; // For consistency
      // We keep secondsElapsed as is for disengaged decay later if needed, 
      // but the break timer is driven by remainingSeconds.
      
      if (!state.interval) {
        state.interval = setInterval(() => this.tick(userId), 1000);
      }
    } else {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { hyperFocusDuration: true }
      });

      const newState: TimerState = {
          userId,
          state: 'BREAK',
          secondsElapsed: 0,
          plannedSeconds: breakDuration,
          remainingSeconds: breakDuration,
          pomodoroMode: 'flexible', // Default for now
          cycleCount: 0,
          hyperFocusDuration: (user?.hyperFocusDuration || 45) * 60
      };
      newState.interval = setInterval(() => this.tick(userId), 1000);
      this.activeTimers.set(userId, newState);
    }

    this.broadcastState(userId);
  }

  private async finalizeWork(userId: string, state: TimerState) {
    try {
      // Completing a session costs 1 spoon (allowed even if at zero)
      await spoonService.deductSpoons(userId, 1, true);

      const spoonState = await spoonService.getSpoonState(userId);
      
      const plannedMinutes = Math.floor(state.plannedSeconds / 60);
      const actualMinutes = Math.floor(state.secondsElapsed / 60);
      const overflowMinutes = Math.max(0, actualMinutes - plannedMinutes);
      
      // Points: (Planned Minutes * 10) + (Overflow Minutes * 12) * Multiplier
      const pointsEarned = ( (plannedMinutes * 10) + (overflowMinutes * 12) ) * spoonState.effortMultiplier;
      
      // XP: 1 min FOCUS = 10 XP, HYPERFOCUS = 12 XP / min (Multiplied by effort multiplier)
      const xpEarned = ((plannedMinutes * 10) + (overflowMinutes * 12)) * spoonState.effortMultiplier;

      const currentSession = await prisma.session.findFirst({
        where: { userId, status: 'in_progress' },
        orderBy: { startedAt: 'desc' }
      });

      if (currentSession) {
        await prisma.session.update({
          where: { id: currentSession.id },
          data: {
            status: 'completed',
            endedAt: new Date(),
            duration: state.secondsElapsed,
            actualDuration: actualMinutes,
            overflowMinutes: Math.max(0, Math.floor((state.secondsElapsed - state.plannedSeconds) / 60)),
            longBreakSuggested: state.cycleCount >= 4
          }
        });
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { points: true, role: true, avgDurationByPriority: true }
      });

      // Update XP and Level
      await levelService.addXp(userId, xpEarned);

      // Update Streak
      await streakService.updateStreak(userId);

      // Update Calibration: new_avg = 0.8 * old_avg + 0.2 * actualDuration
      if (state.taskId) {
        const task = await prisma.task.findUnique({ where: { id: state.taskId }, select: { priority: true } });
        if (task) {
          const priority = task.priority.toUpperCase();
          const avgs = (user?.avgDurationByPriority as Record<string, number>) || {};
          const oldAvg = avgs[priority] || 25;
          avgs[priority] = Math.round(0.8 * oldAvg + 0.2 * actualMinutes);

          await prisma.user.update({
            where: { id: userId },
            data: { 
              points: { increment: Math.floor(pointsEarned) },
              avgDurationByPriority: avgs
            }
          });
        }
      } else {
        await prisma.user.update({
          where: { id: userId },
          data: { points: { increment: Math.floor(pointsEarned) } }
        });
      }

      // Award tokens if student
      if (user?.role === 'student') {
        await rewardService.awardTokens(userId, xpEarned);
      }
      
      // Auto-sync stats (Spoons, Points, XP) immediately after finalizing session
      await wsManager.sendDashboard(userId);
    } catch (err) {
      console.error('[TimerEngine] Finalization failed:', err);
    }
  }

  private startIdleTimer(userId: string, targetState: TimerStateName = 'DISENGAGED', seconds: number = 30) {
    this.clearIdleTimer(userId);
    const state = this.activeTimers.get(userId);
    if (!state) return;

    state.idleTimer = setTimeout(async () => {
      if (targetState === 'HYPERFOCUS') {
        await this.enterHyperFocus(userId);
      } else {
        await this.enterDisengaged(userId);
      }
    }, seconds * 1000);
  }

  async manualEnterHyperFocus(userId: string) {
    this.clearIdleTimer(userId);
    await this.enterHyperFocus(userId);
  }

  private async enterDisengaged(userId: string) {
    const state = this.activeTimers.get(userId);
    if (!state) return;

    state.state = 'DISENGAGED';
    // Restart interval for decay if it was stopped
    if (!state.interval) {
        state.interval = setInterval(() => this.tick(userId), 1000);
    }
    
    this.broadcastState(userId);

    try {
      // Disengagement penalty: -1 spoon (allowed even if at zero)
      await spoonService.deductSpoons(userId, 1, true);
    } catch (err) {
      console.error('[TimerEngine] Disengagement penalty failed:', err);
    }
  }

  pauseTimer(userId: string) {
    const state = this.activeTimers.get(userId);
    if (state && state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
      this.broadcastState(userId);
    }
  }

  resumeTimer(userId: string) {
    const state = this.activeTimers.get(userId);
    if (state && !state.interval) {
      state.interval = setInterval(() => this.tick(userId), 1000);
      this.broadcastState(userId);
    }
  }

  async stopTimer(userId: string) {
    const state = this.activeTimers.get(userId);
    if (state) {
      if (state.state === 'FOCUS' || state.state === 'HYPERFOCUS') {
        await this.finalizeWork(userId, state);
      }
      this.cleanup(userId);
    }
    this.broadcastState(userId, 'IDLE');
  }

  private cleanup(userId: string) {
    const state = this.activeTimers.get(userId);
    if (state) {
      if (state.interval) clearInterval(state.interval);
      this.clearIdleTimer(userId);
      this.activeTimers.delete(userId);
    }
  }

  private stopTick(userId: string) {
    const state = this.activeTimers.get(userId);
    if (state && state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }

  private clearIdleTimer(userId: string) {
    const state = this.activeTimers.get(userId);
    if (state && state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
  }

  private broadcastState(userId: string, overrideState?: TimerStateName) {
    const state = this.activeTimers.get(userId);
    const message = {
      type: 'timer_update',
      payload: state ? {
        state: overrideState || state.state,
        remainingSeconds: state.remainingSeconds,
        secondsElapsed: state.secondsElapsed,
        plannedSeconds: state.plannedSeconds,
        taskId: state.taskId,
        subtaskId: state.subtaskId,
        subtaskTitle: state.subtaskTitle,
        isRunning: !!state.interval
      } : { state: 'IDLE', remainingSeconds: 0, secondsElapsed: 0, plannedSeconds: 0, isRunning: false }
    };
    wsManager.broadcastToUser(userId, message);
  }

  getTimerState(userId: string) {
    const state = this.activeTimers.get(userId);
    if (!state) return { state: 'IDLE', remainingSeconds: 0 };
    return {
      state: state.state,
      remainingSeconds: state.remainingSeconds,
      secondsElapsed: state.secondsElapsed,
      plannedSeconds: state.plannedSeconds,
      taskId: state.taskId,
      isRunning: !!state.interval
    };
  }
}

export const timerEngine = new TimerEngine();
