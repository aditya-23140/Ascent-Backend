import { prisma } from '../lib/prisma';
import { differenceInDays, startOfDay } from 'date-fns';

class StreakService {
  /**
   * Updates the user's streak when they complete a session.
   * Handles streak shield consumption if they missed a day.
   */
  async updateStreak(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { currentStreak: true, lastSessionAt: true, streakShields: true }
    });

    if (!user) return;

    const now = new Date();
    const today = startOfDay(now);
    const lastSessionDate = user.lastSessionAt ? startOfDay(user.lastSessionAt) : null;

    if (!lastSessionDate) {
      // First session ever
      await prisma.user.update({
        where: { id: userId },
        data: { currentStreak: 1, lastSessionAt: now }
      });
      return;
    }

    const daysSinceLast = differenceInDays(today, lastSessionDate);

    if (daysSinceLast === 0) {
      // Already had a session today, just update the timestamp
      await prisma.user.update({
        where: { id: userId },
        data: { lastSessionAt: now }
      });
    } else if (daysSinceLast === 1) {
      // Consecutive day! Increment streak.
      await prisma.user.update({
        where: { id: userId },
        data: { 
          currentStreak: { increment: 1 },
          lastSessionAt: now
        }
      });
    } else {
      // Missed one or more days. 
      // Check for Streak Shields.
      const shieldsToConsume = Math.min(user.streakShields, daysSinceLast - 1);
      
      if (user.streakShields > 0) {
        // Shield(s) consumed! Streak preserved.
        await prisma.user.update({
          where: { id: userId },
          data: {
            streakShields: { decrement: 1 }, // Just consume one per "incident"? 
            // Prompts says: "Shields prevent streak reset... auto-consumed if user fails to log a session for 24h"
            // I'll consume 1 shield to bridge the gap.
            currentStreak: { increment: 1 },
            lastSessionAt: now
          }
        });
      } else {
        // No shields. Reset.
        await prisma.user.update({
          where: { id: userId },
          data: {
            currentStreak: 1,
            lastSessionAt: now
          }
        });
      }
    }
  }

  async calculateCurrentStreak(userId: string): Promise<number> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { currentStreak: true, lastSessionAt: true, streakShields: true }
    });
    if (!user) return 0;

    // If more than 1 day since last session, the streak is effectively broken 
    // (unless updateStreak handles it with shields when they actually log a session)
    // For display, we show the current field.
    return user.currentStreak || 0;
  }
  /**
   * Automated midnight process to consume shields or reset streaks for inactive users.
   */
  async midnightProcessing() {
    const yesterday = startOfDay(new Date());
    yesterday.setDate(yesterday.getDate() - 1);

    // Find users who haven't logged a session since before yesterday
    const inactiveUsers = await prisma.user.findMany({
      where: {
        lastSessionAt: { lt: yesterday },
        currentStreak: { gt: 0 }
      },
      select: { id: true, streakShields: true, currentStreak: true }
    });

    for (const user of inactiveUsers) {
      if (user.streakShields > 0) {
        // Consume 1 shield to protect streak
        await prisma.user.update({
          where: { id: user.id },
          data: { 
            streakShields: { decrement: 1 },
            // Note: We don't increment currentStreak here, 
            // we just prevent it from being reset.
          }
        });
        console.log(`[StreakService] Shield consumed for user ${user.id}`);
      } else {
        // No shields, reset streak
        await prisma.user.update({
          where: { id: user.id },
          data: { currentStreak: 0 }
        });
        console.log(`[StreakService] Streak reset for user ${user.id}`);
      }
    }
  }
}

export const streakService = new StreakService();
