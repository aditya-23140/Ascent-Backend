import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { rewardService } from '../services/rewardService';
import { z } from 'zod';
import { ChildWithRewards, RedemptionRequest } from '../types';

const router = Router();
router.use(authMiddleware);

// --- Student Routes ---

// GET /api/rewards/tokens
router.get('/tokens', async (req: AuthRequest, res, next) => {
  try {
    const tokens = await prisma.rewardToken.findUnique({
      where: { studentId: req.userId }
    });
    res.json({ success: true, data: tokens || { balance: 0, lifetimeEarned: 0 } });
  } catch (err) {
    next(err);
  }
});

// GET /api/rewards/available
router.get('/available', async (req: AuthRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user?.parentId) {
      return res.json({ success: true, data: [] });
    }

    const rewards = await prisma.rewardItem.findMany({
      where: { parentId: user.parentId }
    });
    res.json({ success: true, data: rewards });
  } catch (err) {
    next(err);
  }
});

// POST /api/rewards/redeem
router.post('/redeem', async (req: AuthRequest, res, next) => {
  try {
    const { rewardItemId } = req.body;
    await rewardService.requestRedemption(req.userId!, rewardItemId);
    res.json({ success: true, message: 'Redemption request sent' });
  } catch (err) {
    next(err);
  }
});

// --- Parent Routes ---

const checkParent = async (req: AuthRequest, res: any, next: any) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (user?.role !== 'parent') {
    return res.status(403).json({ error: 'Access denied. Parent role required.' });
  }
  next();
};

// GET /api/rewards/parent/dashboard
router.get('/parent/dashboard', checkParent, async (req: AuthRequest, res, next) => {
  try {
    const children = await prisma.user.findMany({
      where: { parentId: req.userId },
      include: {
        rewardTokens: true,
        redemptionRequests: {
          where: { status: 'PENDING' },
          include: { rewardItem: true },
          orderBy: { requestedAt: 'desc' }
        },
        spoonLogs: {
          orderBy: { date: 'desc' },
          take: 1
        }
      }
    });

    // Map to frontend StudentStats structure
    const stats = children.map((child: ChildWithRewards) => ({
      id: child.id,
      name: child.name || 'Student',
      email: child.email || '',
      tokens: child.rewardTokens?.balance || 0,
      points: child.points,
      currentStreak: child.currentStreak,
      spoonsRemaining: 12 - (child.spoonLogs[0]?.spoonsUsed || 0)
    }));

    // Extract all pending requests
    const pendingRequests = children.flatMap((child: ChildWithRewards) => 
      child.redemptionRequests.map((req: RedemptionRequest) => ({
        id: req.id,
        studentName: child.name || 'Student',
        rewardName: req.rewardItem.name,
        tokenCost: req.rewardItem.tokenCost,
        status: req.status.toLowerCase(),
        createdAt: req.requestedAt
      }))
    );

    res.json({ success: true, data: { students: stats, requests: pendingRequests } });
  } catch (err) {
    next(err);
  }
});

// POST /api/rewards/parent/items
const rewardSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  tokenCost: z.number().int().positive(),
  category: z.enum(['screen-time', 'subscription', 'learning-tool', 'custom'])
});

router.post('/parent/items', checkParent, async (req: AuthRequest, res, next) => {
  try {
    const data = rewardSchema.parse(req.body);
    const item = await prisma.rewardItem.create({
      data: {
        ...data,
        parentId: req.userId!
      }
    });
    res.json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
});

// POST /api/rewards/parent/resolve
router.post('/parent/resolve', checkParent, async (req: AuthRequest, res, next) => {
  try {
    const { requestId, approve } = req.body;
    await rewardService.resolveRequest(requestId, req.userId!, approve);
    res.json({ success: true, message: approve ? 'Request approved' : 'Request rejected' });
  } catch (err) {
    next(err);
  }
});

export default router;
