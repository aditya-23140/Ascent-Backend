import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { timerEngine } from '../services/timerEngine';
import { z } from 'zod';

const router = Router();

const startSchema = z.object({
  duration: z.number().int().positive(),
  taskId: z.string().optional()
});

const breakSchema = z.object({
  duration: z.number().int().positive().optional()
});

router.use(authMiddleware);

router.post('/start', (req: AuthRequest, res, next) => {
  try {
    const { duration, taskId } = startSchema.parse(req.body);
    timerEngine.startTimer(req.userId!, duration, taskId);
    res.json({ message: 'Timer started', state: timerEngine.getTimerState(req.userId!) });
  } catch (error) {
    next(error);
  }
});

router.post('/break', (req: AuthRequest, res, next) => {
  try {
    const { duration } = breakSchema.parse(req.body);
    timerEngine.startBreak(req.userId!, duration);
    res.json({ message: 'Break started', state: timerEngine.getTimerState(req.userId!) });
  } catch (error) {
    next(error);
  }
});

router.post('/hyperfocus', (req: AuthRequest, res, next) => {
  try {
    timerEngine.manualEnterHyperFocus(req.userId!);
    res.json({ message: 'Entered HyperFocus', state: timerEngine.getTimerState(req.userId!) });
  } catch (error) {
    next(error);
  }
});

router.post('/pause', (req: AuthRequest, res) => {
  timerEngine.pauseTimer(req.userId!);
  res.json({ message: 'Timer paused' });
});

router.post('/resume', (req: AuthRequest, res) => {
  timerEngine.resumeTimer(req.userId!);
  res.json({ message: 'Timer resumed' });
});

router.post('/skip', (req: AuthRequest, res) => {
  timerEngine.stopTimer(req.userId!);
  res.json({ message: 'Timer skipped' });
});

router.get('/status', (req: AuthRequest, res) => {
    res.json(timerEngine.getTimerState(req.userId!));
});

export default router;
