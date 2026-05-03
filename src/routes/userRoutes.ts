import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const router = Router();

router.use(authMiddleware);

// Helper to map Prisma 'id' to frontend '_id'
const mapId = (obj: any): any => {
  if (!obj) return obj;
  const { id, ...rest } = obj;
  return { ...rest, _id: id };
};

// GET /api/user/profile
router.get('/profile', async (req: AuthRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId }
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Default preferences if missing
    const defaultPrefs = {
      theme: "dark",
      emailNotifications: true,
      dailyDigest: true
    };

    res.json({ 
      success: true, 
      data: {
        ...mapId(user),
        preferences: user.preferences || defaultPrefs
      } 
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/user/stats
router.get('/stats', async (req: AuthRequest, res, next) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { points: true, level: true, avgDurationByPriority: true }
    });

    const totalTasksCompleted = await prisma.task.count({
      where: { userId: req.userId, status: 'completed' }
    });

    const tasksCompletedToday = await prisma.task.count({
      where: { 
        userId: req.userId, 
        status: 'completed',
        updatedAt: { gte: startOfToday }
      }
    });

    const focusSessions = await prisma.session.aggregate({
      where: { userId: req.userId, phase: 'work', status: 'completed' },
      _sum: { duration: true }
    });

    const focusSessionsToday = await prisma.session.aggregate({
      where: { 
        userId: req.userId, 
        phase: 'work', 
        status: 'completed',
        startedAt: { gte: startOfToday }
      },
      _sum: { duration: true }
    });

    const focusTimeToday = Math.floor((focusSessionsToday._sum.duration || 0) / 60);

    const { spoonService } = await import('../services/spoonService');
    const spoonState = await spoonService.getSpoonState(req.userId!);

    const { streakService } = await import('../services/streakService');
    const currentStreak = await streakService.calculateCurrentStreak(req.userId!);

    res.json({
      success: true,
      data: {
        totalTasksCompleted,
        totalFocusTime: Math.floor((focusSessions._sum.duration || 0) / 60),
        currentStreak,
        longestStreak: currentStreak, // Simplified for now
        pointsEarned: user?.points || 0,
        level: user?.level || 1,
        nextLevelPoints: (user?.level || 1) * 1000,
        tasksCompletedToday,
        focusTimeToday,
        spoonState,
        avgDurationByPriority: user?.avgDurationByPriority || {}
      }
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/user/profile
router.patch('/profile', async (req: AuthRequest, res, next) => {
  try {
    const { timezone, preferences, role, dailySpoonBudget, hyperFocusDuration } = req.body;

    const updated = await prisma.user.update({
      where: { id: req.userId },
      data: {
        timezone,
        role,
        dailySpoonBudget: dailySpoonBudget ? parseInt(dailySpoonBudget) : undefined,
        hyperFocusDuration: hyperFocusDuration ? parseInt(hyperFocusDuration) : undefined,
        preferences: preferences ? preferences : undefined
      }
    });

    res.json({ success: true, data: mapId(updated) });
  } catch (error) {
    next(error);
  }
});

// POST /api/user/device/pair — generate a permanent device token and link via WS code
router.post('/device/pair', async (req: AuthRequest, res, next) => {
  try {
    const { code, name } = req.body;

    // We must lazily import wsManager here to avoid circular dependency issues if any
    const { wsManager } = await import('../services/wsManager');

    if (!code || !wsManager.pendingPairings.has(code)) {
      return res.status(400).json({ error: 'Invalid or expired pairing code. Please generate a new code on your device.' });
    }

    // Generate a 40-char hex token
    const plainToken = 'ascent_esp_' + crypto.randomBytes(20).toString('hex');
    const tokenHash = await bcrypt.hash(plainToken, 10);

    const device = await prisma.device.create({
      data: {
        userId: req.userId!,
        tokenHash,
        name: name || 'FocusOS Hub',
      },
    });

    // Notify the device over WebSockets
    const success = wsManager.completePairing(code, plainToken, req.userId!);

    res.json({
      success: true,
      message: success ? 'Device paired successfully!' : 'Device saved, but WS notification failed.',
      data: {
        id: device.id,
        name: device.name,
        createdAt: device.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/user/devices — list registered devices (no tokens returned)
router.get('/devices', async (req: AuthRequest, res, next) => {
  try {
    const devices = await prisma.device.findMany({
      where: { userId: req.userId! },
      select: { id: true, name: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: devices });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/user/device/:id — revoke a device token
router.delete('/device/:id', async (req: AuthRequest, res, next) => {
  try {
    const device = await prisma.device.findUnique({ where: { id: req.params.id } });
    if (!device || device.userId !== req.userId) {
      return res.status(404).json({ error: 'Device not found' });
    }
    await prisma.device.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: 'Device token revoked' });
  } catch (error) {
    next(error);
  }
});

export default router;

