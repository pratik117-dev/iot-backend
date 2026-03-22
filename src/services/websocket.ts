import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';

export interface ExtendedWebSocket extends WebSocket {
  userId?: string;
  role?: string;
  isAlive?: boolean;
}

export const connectedClients = new Set<ExtendedWebSocket>();

export function setupWebSocket(wss: WebSocketServer) {
  wss.on('connection', (ws: ExtendedWebSocket, req) => {
    ws.isAlive = true;

    // Extract token from query string
    const url = new URL(req.url || '', `http://localhost`);
    const token = url.searchParams.get('token');

    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret') as any;
        ws.userId = decoded.id;
        ws.role = decoded.role;
      } catch (err) {
        console.log('Invalid WS token');
      }
    }

    connectedClients.add(ws);
    console.log(`WS client connected. Total: ${connectedClients.size}`);

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'PING') {
          ws.send(JSON.stringify({ type: 'PONG', payload: null }));
        }
      } catch (err) {
        // ignore
      }
    });

    ws.on('close', () => {
      connectedClients.delete(ws);
      console.log(`WS client disconnected. Total: ${connectedClients.size}`);
    });

    ws.on('error', (err) => {
      console.error('WS error:', err.message);
      connectedClients.delete(ws);
    });

    // Send welcome
    ws.send(JSON.stringify({ type: 'PING', payload: { message: 'Connected to EnviroLog' } }));
  });

  // Heartbeat to detect dead connections
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws: ExtendedWebSocket) => {
      if (!ws.isAlive) {
        connectedClients.delete(ws);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(heartbeat));
}

export function broadcast(wss: WebSocketServer, message: object) {
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}
