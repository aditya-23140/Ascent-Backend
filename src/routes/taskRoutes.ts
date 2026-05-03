import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { z } from 'zod';
import { GoogleGenAI } from '@google/genai';
import { levelService } from '../services/levelService';
import { Subtask } from '../types';
import { wsManager } from '../services/wsManager';
import { timerEngine } from '../services/timerEngine';

const router = Router();
router.use(authMiddleware);

// Helper to map Prisma 'id' to frontend '_id'
const mapId = (obj: any): any => {
  if (!obj) return obj;
  if (Array.isArray(obj)) return obj.map(mapId);
  const { id, ...rest } = obj;
  const mapped = { ...rest, _id: id };
  if (mapped.subtasks && Array.isArray(mapped.subtasks)) {
    mapped.subtasks = mapped.subtasks.map(mapId);
  }
  return mapped;
};

// ------------------- SCHEMAS -------------------

const taskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  status: z.enum(['pending', 'todo', 'in_progress', 'completed']).optional(),
  deadline: z.string().optional().nullable(),
  subtasks: z.array(z.object({
    title: z.string(),
    duration: z.number().int().positive()
  })).optional()
});

const updateTaskSchema = taskSchema.partial();

const subtaskSchema = z.object({
  title: z.string().min(1),
  duration: z.number().int().positive(),
});

const aiSchema = z.array(
  z.object({
    title: z.string(),
    duration: z.number().int().positive(),
  })
);

const reorderSchema = z.array(z.object({
  id: z.string(),
  position: z.number().int()
}));

// ------------------- SPECIAL ROUTES (High Priority) -------------------

// Helper for exponential backoff retry
const retryRequest = async <T>(fn: () => Promise<T>, maxRetries = 3, initialDelay = 1000): Promise<T> => {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const status = err?.status || err?.response?.status;
      // Retry on 429 (Rate Limit) or 5xx (Server Error)
      if (status === 429 || (status >= 500 && status < 600)) {
        const delay = initialDelay * Math.pow(2, i);
        console.warn(`[AI] Retry ${i + 1}/${maxRetries} after ${delay}ms due to status ${status}`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err; // Don't retry other errors
    }
  }
  throw lastError;
};

// AI Subtask Generation (Must be above /:id and /:taskId/subtasks)
router.post('/generate-subtasks', async (req: AuthRequest, res, next) => {
  try {
    const { title, description } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    if (!process.env.GOOGLE_GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Missing Gemini API key' });
    }

    const genAI = new GoogleGenAI({ apiKey: process.env.GOOGLE_GEMINI_API_KEY! });

    const prompt = `
      Break the following task into 3-6 atomic, actionable subtasks.
      Each subtask must be a single, concrete step that can be completed in one sitting.
      Assign a realistic duration (in minutes) to each step, between 10 and 45 minutes.
      Total duration should reflect the complexity of the task.

      Task: "${title}"
      Description: "${description || ''}"

      Return ONLY valid JSON in this exact format:
      [
        { "title": "Step description", "duration": 25 }
      ]
    `;

    let subtasks = [];
    try {
      const response = await retryRequest(async () => {
        return await genAI.models.generateContent({
          model: "gemini-flash-lite-latest",
          contents: [{ role: 'user', parts: [{ text: prompt }] }]
        });
      });

      const text = response.text || "";
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('No JSON returned');

      const parsed = JSON.parse(jsonMatch[0]);
      subtasks = aiSchema.parse(parsed);

    } catch (err: any) {
      console.warn('[AI] Generation failed, using fallback:', err.message);
      subtasks = [
        { title: "Break down requirements", duration: 15 },
        { title: "Execute core implementation", duration: 45 },
        { title: "Final verification and testing", duration: 20 }
      ];
    }

    res.json({ success: true, data: { subtasks } });
  } catch (err) {
    console.error('[CRITICAL] generate-subtasks error:', err);
    next(err);
  }
});

// Subtask Specific Actions (Must be above /:id)
router.post('/subtasks/:id/complete', async (req: AuthRequest, res, next) => {
  try {
    const { id } = req.params;
    const subtask = await prisma.subtask.update({
      where: { id },
      data: {
        completed: true,
        completedAt: new Date()
      }
    });

    // Award Task Completion Bonus: 50 XP
    await levelService.addXp(req.userId!, 50);

    // Check if all subtasks for this parent task are now complete
    const parentTask = await prisma.task.findUnique({
      where: { id: subtask.taskId },
      include: { subtasks: true }
    });

    if (parentTask && parentTask.subtasks.length > 0 && parentTask.subtasks.every((s: Subtask) => s.completed)) {
      await prisma.task.update({
        where: { id: parentTask.id },
        data: { 
          status: 'completed',
          completed: true
        }
      });
    }

    // Stop the running timer since the subtask is done
    timerEngine.stopTimer(req.userId!);
    
    // Sync back to all user devices
    await wsManager.sendDashboard(req.userId!);

    res.json({ success: true, data: { subtask: mapId(subtask) } });
  } catch (err) {
    next(err);
  }
});

router.post('/reorder', async (req: AuthRequest, res, next) => {
  try {
    const items = reorderSchema.parse(req.body);
    
    // Batch update positions
    await Promise.all(items.map(item => 
      prisma.task.update({
        where: { id: item.id, userId: req.userId! },
        data: { position: item.position }
      })
    ));

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/subtasks/reorder', async (req: AuthRequest, res, next) => {
  try {
    const { id: taskId } = req.params;
    const items = reorderSchema.parse(req.body);
    
    // Batch update subtask positions
    await Promise.all(items.map(item => 
      prisma.subtask.update({
        where: { id: item.id, taskId },
        data: { position: item.position }
      })
    ));

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.put('/subtasks/:id', async (req: AuthRequest, res, next) => {
  try {
    const { id } = req.params;
    const data = subtaskSchema.partial().parse(req.body);
    const subtask = await prisma.subtask.update({
      where: { id },
      data
    });
    res.json({ success: true, data: mapId(subtask) });
  } catch (err) {
    next(err);
  }
});

// ------------------- TASK ROUTES -------------------

router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const tasks = await prisma.task.findMany({
      where: { userId: req.userId },
      include: { 
        subtasks: {
          orderBy: { position: 'asc' }
        } 
      },
      orderBy: { position: 'asc' }
    });
    res.json({ success: true, data: { tasks: mapId(tasks) } });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req: AuthRequest, res, next) => {
  try {
    const { subtasks: subtasksData, ...data } = taskSchema.parse(req.body);
    
    // Get max position
    const maxTask = await prisma.task.findFirst({
      where: { userId: req.userId! },
      orderBy: { position: 'desc' }
    });
    const nextPosition = (maxTask?.position || 0) + 1;

    const task = await prisma.task.create({
      data: {
        ...data,
        deadline: data.deadline ? new Date(data.deadline) : null,
        userId: req.userId!,
        position: nextPosition,
        subtasks: subtasksData ? {
          create: subtasksData.map((s: { title: string; duration: number }, i: number) => ({ ...s, position: i }))
        } : undefined
      },
      include: { subtasks: true }
    });
    res.status(201).json({ success: true, data: { task: mapId(task) } });
  } catch (err) {
    next(err);
  }
});

// ------------------- PARAMETER ROUTES (Low Priority) -------------------

router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const { id } = req.params;
    const task = await prisma.task.findFirst({
      where: { id, userId: req.userId },
      include: { subtasks: true }
    });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json({ success: true, data: mapId(task) });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req: AuthRequest, res, next) => {
  try {
    const { id } = req.params;
    const { subtasks: _, ...data } = updateTaskSchema.parse(req.body);

    const task = await prisma.task.findUnique({
      where: { id }
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (task.userId !== req.userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const updated = await prisma.task.update({
      where: { id },
      data: {
        ...data,
        deadline: data.deadline ? new Date(data.deadline) : (data.deadline === null ? null : undefined)
      },
      include: { subtasks: true }
    });
    res.json({ success: true, data: mapId(updated) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const { id } = req.params;

    const task = await prisma.task.findUnique({
      where: { id }
    });

    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.userId !== req.userId) return res.status(403).json({ error: 'Unauthorized' });

    await prisma.task.delete({
      where: { id }
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.post('/:taskId/subtasks', async (req: AuthRequest, res, next) => {
  try {
    const { taskId } = req.params;
    const data = subtaskSchema.parse(req.body);
    const task = await prisma.task.findFirst({
      where: { id: taskId, userId: req.userId }
    });
    if (!task) return res.status(403).json({ error: 'Unauthorized' });

    const subtask = await prisma.subtask.create({
      data: { ...data, taskId }
    });

    const updatedTask = await prisma.task.findUnique({
      where: { id: taskId },
      include: { subtasks: true }
    });

    res.status(201).json({
      success: true,
      data: {
        subtask: mapId(subtask),
        task: mapId(updatedTask)
      }
    });
  } catch (err) {
    next(err);
  }
});

export default router;