import express from 'express';
import { createServer } from 'http';
import dotenv from 'dotenv';
dotenv.config();
import cors from 'cors';
import { wsManager } from './services/wsManager';
import { verifyUserToken } from './utils/authUtils';
import taskRoutes from './routes/taskRoutes';
import timerRoutes from './routes/timerRoutes';
import userRoutes from './routes/userRoutes';
import rewardRoutes from './routes/rewardRoutes';
import { errorHandler } from './middleware/error';
import { prisma } from './lib/prisma';
import cron from 'node-cron';
import { spoonService } from './services/spoonService';
import { streakService } from './services/streakService';


const app = express();
const httpServer = createServer(app);
const PORT = Number(process.env.PORT) || 5000;

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/tasks', taskRoutes);
app.use('/api/timer', timerRoutes);
app.use('/api/user', userRoutes);
app.use('/api/rewards', rewardRoutes);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Global error handler
app.use(errorHandler);

// WebSocket Manager Initialization
wsManager.init(httpServer);

// WebSocket Upgrade Handling with Auth
httpServer.on('upgrade', async (request, socket, head) => {
  try {
    const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token');

    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const result = await verifyUserToken(token);
    if (!result) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wsManager.handleUpgrade(request, socket, head, result.userId);
  } catch (error) {
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    socket.destroy();
  }
});

// Daily Maintenance Cron Job (Runs at midnight every day)
cron.schedule('0 0 * * *', async () => {
  try {
    await spoonService.resetAllSpoons();
    await streakService.midnightProcessing();
  } catch (err) {
    console.error('[CRON] Maintenance failed:', err);
  }
});

// Bind to 0.0.0.0 for Render compatibility
httpServer.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 Ascent Backend running on port ${PORT}`);

  try {
    await prisma.$connect();
    console.log(`✓ Database connected\n`);
  } catch (dbError) {
    console.error('✗ Database connection failed:', dbError);
  }
});
