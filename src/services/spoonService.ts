import { prisma } from '../lib/prisma';
import { startOfDay, format } from 'date-fns';

export interface SpoonState {
  spoonsUsed: number;
  remainingSpoons: number;
  effortMultiplier: number;
  isHighEffort: boolean;
}

class SpoonService {
  private DEFAULT_DAILY_BUDGET = 12;

  /**
   * Deducts spoons from a user's daily budget.
   * @param userId Internal Prisma User ID
   * @param amount Amount of spoons to deduct
   * @param allowOverdraft If true, clamp to zero instead of throwing
   */
  async deductSpoons(userId: string, amount: number, allowOverdraft = false): Promise<SpoonState> {
    const today = format(new Date(), 'yyyy-MM-dd');

    // 1. Get or Create Daily Log and Apply Pulses
    let log = await this.getOrCreateLog(userId, today);
    log = await this.applyPulses(userId, log);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { dailySpoonBudget: true }
    });

    const budget = user?.dailySpoonBudget || this.DEFAULT_DAILY_BUDGET;
    const remaining = budget - log.spoonsUsed;

    if (!allowOverdraft && remaining < amount && amount > 0) {
      throw new Error('NOT_ENOUGH_ENERGY');
    }

    const newSpoonsUsed = Math.max(0, Math.min(log.spoonsUsed + amount, budget));

    // 2. Calculate Tiered Effort Multiplier
    const newRemaining = budget - newSpoonsUsed;
    let multiplier = 1.0;

    if (newRemaining >= 8) {
      multiplier = 1.5;
    } else if (newRemaining >= 4) {
      multiplier = 1.0;
    } else if (newRemaining >= 1) {
      multiplier = 0.5;
    } else {
      multiplier = 0.0;
    }

    // 3. Update Log
    const updatedLog = await prisma.dailySpoonLog.update({
      where: { id: log.id },
      data: {
        spoonsUsed: newSpoonsUsed,
        effortMultiplier: multiplier,
        lastUpdatedAt: new Date()
      }
    });

    return {
      spoonsUsed: updatedLog.spoonsUsed,
      remainingSpoons: budget - updatedLog.spoonsUsed,
      effortMultiplier: updatedLog.effortMultiplier,
      isHighEffort: newRemaining >= 8
    };
  }

  private async getOrCreateLog(userId: string, today: string) {
    let log = await prisma.dailySpoonLog.findUnique({
      where: { userId_date: { userId, date: today } }
    });

    if (!log) {
      log = await prisma.dailySpoonLog.create({
        data: {
          userId,
          date: today,
          spoonsUsed: 0,
          effortMultiplier: 1.5,
          pulsesApplied: []
        }
      });
    }
    return log;
  }

  private async applyPulses(userId: string, log: any) {
    const now = new Date();
    const hour = now.getHours();
    const applied = new Set<string>(log.pulsesApplied || []);
    let spoonsToRecover = 0;
    let resetToZero = false;

    // Morning Pulse (6 AM): Reset to 12 (spoonsUsed = 0)
    if (hour >= 6 && !applied.has('morning')) {
      resetToZero = true;
      applied.add('morning');
    }

    // Noon Pulse (12 PM): +4 (spoonsUsed -= 4)
    if (hour >= 12 && !applied.has('noon')) {
      spoonsToRecover += 4;
      applied.add('noon');
    }

    // Evening Pulse (6 PM): +2 (spoonsUsed -= 2)
    if (hour >= 18 && !applied.has('evening')) {
      spoonsToRecover += 2;
      applied.add('evening');
    }

    if (resetToZero || spoonsToRecover > 0) {
      const newSpoonsUsed = resetToZero ? 0 : Math.max(0, log.spoonsUsed - spoonsToRecover);
      
      // Re-calculate multiplier after recovery
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { dailySpoonBudget: true } });
      const budget = user?.dailySpoonBudget || this.DEFAULT_DAILY_BUDGET;
      const remaining = budget - newSpoonsUsed;
      let multiplier = 1.0;
      if (remaining >= 8) multiplier = 1.5;
      else if (remaining >= 4) multiplier = 1.0;
      else if (remaining >= 1) multiplier = 0.5;
      else multiplier = 0.0;

      return await prisma.dailySpoonLog.update({
        where: { id: log.id },
        data: {
          spoonsUsed: newSpoonsUsed,
          pulsesApplied: Array.from(applied),
          effortMultiplier: multiplier,
          lastUpdatedAt: new Date()
        }
      });
    }

    return log;
  }

  /**
   * Gets the current spoon state for a user.
   */
  async getSpoonState(userId: string): Promise<SpoonState> {
    const today = format(new Date(), 'yyyy-MM-dd');
    let log = await this.getOrCreateLog(userId, today);
    log = await this.applyPulses(userId, log);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { dailySpoonBudget: true }
    });

    const budget = user?.dailySpoonBudget || this.DEFAULT_DAILY_BUDGET;
    const remaining = budget - log.spoonsUsed;

    return {
      spoonsUsed: log.spoonsUsed,
      remainingSpoons: remaining,
      effortMultiplier: log.effortMultiplier,
      isHighEffort: remaining >= 8
    };
  }

  /**
   * Resets spoons for all users. Intended for use by a cron job.
   */
  async resetAllSpoons() {
    const today = format(new Date(), 'yyyy-MM-dd');
    
    const users = await prisma.user.findMany({ select: { id: true, dailySpoonBudget: true } });
    
    for (const user of users) {
      await prisma.dailySpoonLog.upsert({
        where: { userId_date: { userId: user.id, date: today } },
        update: {}, // Don't overwrite if it exists
        create: {
          userId: user.id,
          date: today,
          spoonsUsed: 0,
          effortMultiplier: 1.5,
          pulsesApplied: []
        }
      });
    }
  }
}

export const spoonService = new SpoonService();
