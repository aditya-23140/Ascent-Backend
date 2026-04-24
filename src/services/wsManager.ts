import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { Server } from 'http';
import { timerEngine } from './timerEngine';

export interface ExtendedWebSocket extends WebSocket {
  isAlive: boolean;
  userId?: string;
}

class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private userSockets: Map<string, Set<ExtendedWebSocket>> = new Map();

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
          this.handleMessage(userId, message);
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

  private handleMessage(userId: string, message: any) {
    switch (message.action) {
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
      default:
        console.warn(`Unknown action: ${message.action}`);
    }
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
