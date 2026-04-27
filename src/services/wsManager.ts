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
  public pendingPairings: Map<string, ExtendedWebSocket> = new Map();

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

    // Heartbeat interval (30s)
    const interval = setInterval(() => {
      if (!this.wss) return;
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

  private handleMessage(userId: string, message: any, ws: ExtendedWebSocket) {
    switch (message.action) {
      case 'pair_init':
        if (message.code) {
          this.pendingPairings.set(message.code, ws);
          console.log(`[Pairing] Registered pending pairing for code: ${message.code}`);
        }
        break;
      case 'start':
        if (message.duration) {
          timerEngine.startTimer(userId, message.duration, message.taskId);
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
        timerEngine.stopTimer(userId);
        break;
      case 'fetch_dashboard':
        this.sendDashboard(userId);
        break;
      default:
        console.warn(`Unknown action: ${message.action}`);
    }
  }

  private async sendDashboard(userId: string) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { points: true, level: true }
      });
      const tasks = await prisma.task.findMany({
        where: { userId },
        include: { subtasks: { orderBy: { position: 'asc' } } },
        orderBy: { position: 'asc' }
      });
      const spoonState = await spoonService.getSpoonState(userId);
      const currentStreak = await streakService.calculateCurrentStreak(userId);

      this.broadcastToUser(userId, {
        type: 'dashboard_update',
        payload: {
          stats: {
            pointsEarned: user?.points || 0,
            level: user?.level || 1,
            currentStreak,
            spoonState
          },
          tasks: tasks.map(t => ({
            _id: t.id,
            title: t.title,
            priority: t.priority,
            progress: 0, // Simplified
            subtasks: t.subtasks.map(s => ({ title: s.title }))
          }))
        }
      });
    } catch (err) {
      console.error('Failed to send dashboard over WS:', err);
    }
  }

  completePairing(code: string, deviceToken: string) {
    const ws = this.pendingPairings.get(code);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'pair_success',
        payload: { deviceToken }
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
