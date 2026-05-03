import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { Server } from 'http';
import { timerEngine } from './timerEngine';
import { prisma } from '../lib/prisma';
import { levelService } from './levelService';
import { spoonService } from './spoonService';
import { streakService } from './streakService';

export interface ExtendedWebSocket extends WebSocket {
  isAlive: boolean;
  userId?: string;
}

class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private userSockets: Map<string, Set<ExtendedWebSocket>> = new Map();
  public pendingPairings: Map<string, { ws: ExtendedWebSocket; expiresAt: number }> = new Map();

  init(server: Server) {
    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on('connection', (ws: ExtendedWebSocket, request: IncomingMessage, userId: string) => {
      ws.isAlive = true;
      ws.userId = userId;

      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId)?.add(ws);

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('close', () => {
        this.removeSocket(userId, ws);
      });

      ws.on('error', () => {
        this.removeSocket(userId, ws);
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(userId, message, ws);
        } catch (e) {
          console.error('Failed to parse WS message:', e);
        }
      });
    });

    // Heartbeat and Cleanup interval (30s)
    const interval = setInterval(() => {
      if (!this.wss) return;

      const now = Date.now();
      // Prune expired pairing codes
      for (const [code, entry] of this.pendingPairings.entries()) {
        if (now > entry.expiresAt) {
          this.pendingPairings.delete(code);
        }
      }

      this.wss.clients.forEach((ws: WebSocket) => {
        const extWs = ws as ExtendedWebSocket;
        if (extWs.isAlive === false) {
          return extWs.terminate();
        }

        extWs.isAlive = false;
        extWs.ping();
      });
    }, 30000);

    this.wss.on('close', () => {
      clearInterval(interval);
    });
  }

  private removeSocket(userId: string, ws: ExtendedWebSocket) {
    const sockets = this.userSockets.get(userId);
    if (sockets) {
      sockets.delete(ws);
      if (sockets.size === 0) {
        this.userSockets.delete(userId);
      }
    }
  }

  private async handleMessage(userId: string, message: any, ws: ExtendedWebSocket) {
    // Unauthenticated device sockets (pairing lobby) may only send pair_init.
    // Block all other actions to prevent unauthorized access to user data.
    const isUnauthed = userId.startsWith('device:') || userId === 'unauthenticated_device';
    if (isUnauthed && message.action !== 'pair_init') {
      console.warn(`[WS] Blocked action '${message.action}' from unauthenticated device ${userId}`);
      return;
    }

    switch (message.action) {
      case 'pair_init':
        if (message.code) {
          this.pendingPairings.set(message.code, { 
            ws, 
            expiresAt: Date.now() + 5 * 60 * 1000 // 5 minute TTL
          });
          console.log(`[Pairing] Registered pending pairing for code: ${message.code}, deviceId: ${userId} (expires in 5m)`);
        }
        break;
      case 'start':
        if (message.duration) {
          timerEngine.startTimer(
            userId, 
            message.duration, 
            message.taskId, 
            message.subtaskId, 
            message.subtaskTitle
          );
        }
        break;
      case 'pause':
        timerEngine.pauseTimer(userId);
        break;
      case 'resume':
        timerEngine.resumeTimer(userId);
        break;
      case 'skip':
      case 'stop':
        await timerEngine.stopTimer(userId);
        await this.sendDashboard(userId);
        break;
      case 'complete_subtask':
        if (message.subtaskId) {
          this.handleCompleteSubtask(userId, message.subtaskId);
        }
        break;
      case 'fetch_dashboard':
        this.sendDashboard(userId);
        break;
      default:
        console.warn(`Unknown action: ${message.action}`);
    }
  }

  private async handleCompleteSubtask(userId: string, subtaskId: string) {
    try {
      const subtask = await prisma.subtask.update({
        where: { id: subtaskId },
        data: {
          completed: true,
          completedAt: new Date()
        }
      });

      // Award XP
      await levelService.addXp(userId, 50);

      // Check if task is complete
      const parentTask = await prisma.task.findUnique({
        where: { id: subtask.taskId },
        include: { subtasks: true }
      });

      if (parentTask && parentTask.subtasks.every(s => s.completed)) {
        await prisma.task.update({
          where: { id: parentTask.id },
          data: { status: 'completed', completed: true }
        });
      }

      // Stop the running timer since the subtask is done
      await timerEngine.stopTimer(userId);

      // Sync back to all user devices
      await this.sendDashboard(userId);
    } catch (err) {
      console.error('Failed to complete subtask over WS:', err);
    }
  }

  public async sendDashboard(userId: string) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { 
          points: true, 
          level: true, 
          totalXP: true,
          avgDurationByPriority: true, 
          preferredBreakDuration: true,
          hyperFocusDuration: true,
          dailySpoonBudget: true,
          pomodoroMode: true
        }
      });

      // Filter: only active tasks (both status and boolean check)
      const tasks = await prisma.task.findMany({
        where: { 
          userId, 
          completed: false,
          status: { not: "completed" }
        },
        include: { subtasks: { orderBy: { position: 'asc' } } },
        orderBy: { position: 'asc' }
      });
      
      const spoonState = await spoonService.getSpoonState(userId);
      const currentStreak = await streakService.calculateCurrentStreak(userId);
      const avgs = (user?.avgDurationByPriority as Record<string, number>) || {};

      this.broadcastToUser(userId, {
        type: 'dashboard_update',
        payload: {
          stats: {
            pointsEarned: user?.points || 0,
            totalXP: user?.totalXP || 0,
            level: user?.level || 1,
            currentStreak,
            spoonState: {
              ...spoonState,
              total: user?.dailySpoonBudget || 12
            },
            preferredBreakDuration: user?.preferredBreakDuration || 5,
            hyperFocusDuration: user?.hyperFocusDuration || 45,
            pomodoroMode: user?.pomodoroMode || 'flexible',
            cycleCount: (await prisma.session.findFirst({
              where: { userId, status: 'completed' },
              orderBy: { endedAt: 'desc' },
              select: { cycleCount: true }
            }))?.cycleCount || 0
          },
          tasks: tasks.map(t => {
            const priority = t.priority.toUpperCase();
            
            // Find first incomplete subtask to get its specific duration
            const firstPending = t.subtasks.find(s => !s.completed);
            
            // Priority: Subtask Duration > Calibrated Average > Default 25
            const suggestedDuration = firstPending?.duration || avgs[priority] || 25;
            
            return {
              _id: t.id,
              title: t.title,
              priority: t.priority,
              progress: 0, 
              suggestedDuration,
              subtasks: t.subtasks.map(s => ({ 
                _id: s.id,
                title: s.title,
                completed: s.completed 
              }))
            };
          })
        }
      });
    } catch (err) {
      console.error('Failed to send dashboard over WS:', err);
    }
  }

  completePairing(code: string, deviceToken: string, userId: string) {
    const entry = this.pendingPairings.get(code);
    if (!entry) return false;

    if (Date.now() > entry.expiresAt) {
      this.pendingPairings.delete(code);
      return false;
    }

    const { ws } = entry;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'pair_success',
        payload: { deviceToken, userId }
      }));
      this.pendingPairings.delete(code);
      return true;
    }
    return false;
  }

  broadcastToUser(userId: string, message: any) {
    const sockets = this.userSockets.get(userId);
    if (sockets) {
      const data = JSON.stringify(message);
      sockets.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });
    }
  }

  handleUpgrade(request: IncomingMessage, socket: any, head: Buffer, userId: string) {
    this.wss?.handleUpgrade(request, socket, head, (ws) => {
      this.wss?.emit('connection', ws, request, userId);
    });
  }
}

export const wsManager = new WebSocketManager();
