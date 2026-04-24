import { prisma } from '../lib/prisma';

export interface LevelState {
  level: number;
  xp: number;
  nextLevelXp: number;
  progress: number;
  shields: number;
  leveledUp: boolean;
}

class LevelService {
  /**
   * Adds XP to a user and handles level-up logic.
   * Level = floor(sqrt(XP / 100)) + 1
   */
  async addXp(userId: string, amount: number): Promise<LevelState> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { totalXP: true, level: true, streakShields: true }
    });

    if (!user) throw new Error('User not found');

    const newXp = (user.totalXP || 0) + Math.floor(amount);
    const newLevel = Math.floor(Math.sqrt(newXp / 100)) + 1;
    const leveledUp = newLevel > user.level;

    let newShields = user.streakShields;
    if (leveledUp) {
      // Award 1 Streak Shield on Level Up (Max 3)
      newShields = Math.min(3, user.streakShields + 1);
      
      // Log Level History
      await prisma.userLevelHistory.create({
        data: {
          userId,
          level: newLevel,
          xpAtTime: newXp
        }
      });
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        totalXP: newXp,
        level: newLevel,
        streakShields: newShields
      }
    });

    const nextLevelXp = Math.pow(newLevel, 2) * 100;
    const currentLevelBaseXp = Math.pow(newLevel - 1, 2) * 100;
    const progress = ((newXp - currentLevelBaseXp) / (nextLevelXp - currentLevelBaseXp)) * 100;

    return {
      level: newLevel,
      xp: newXp,
      nextLevelXp,
      progress,
      shields: newShields,
      leveledUp
    };
  }

  async getLevelState(userId: string): Promise<LevelState> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { totalXP: true, level: true, streakShields: true }
    });

    if (!user) throw new Error('User not found');

    const xp = user.totalXP || 0;
    const level = user.level;
    const nextLevelXp = Math.pow(level, 2) * 100;
    const currentLevelBaseXp = Math.pow(level - 1, 2) * 100;
    const progress = ((xp - currentLevelBaseXp) / (nextLevelXp - currentLevelBaseXp)) * 100;

    return {
      level,
      xp,
      nextLevelXp,
      progress,
      shields: user.streakShields,
      leveledUp: false
    };
  }
}

export const levelService = new LevelService();
