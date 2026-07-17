import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { RealtimeEnvelope } from '@nexa/realtime-contracts';

export interface WebsocketHub {
  broadcast(spaceId: string, event: RealtimeEnvelope): void;
}

declare module 'fastify' {
  interface FastifyInstance {
    websocketHub?: WebsocketHub;
  }
}

export function attachWebsocketHub(server: Server): WebsocketHub {
  const sockets = new Map<WebSocket, string>();
  const wss = new WebSocketServer({ server, path: '/v1/realtime' });
  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '', 'http://localhost');
    const spaceId = url.searchParams.get('spaceId');
    if (!spaceId) {
      socket.close(1008, 'spaceId is required');
      return;
    }
    sockets.set(socket, spaceId);
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    broadcast(spaceId, event) {
      const payload = JSON.stringify(event);
      for (const [socket, subscribedSpace] of sockets) {
        if (subscribedSpace === spaceId && socket.readyState === WebSocket.OPEN)
          socket.send(payload);
      }
    },
  };
}
