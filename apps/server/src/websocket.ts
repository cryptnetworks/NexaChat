import type { Server } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  websocketClientMessageSchema,
  websocketServerMessageSchema,
  type WebsocketServerMessage,
} from '@nexa/api-contracts';
import { DomainError, type InMemoryCommunityService } from '@nexa/domain';
import type { RealtimeEnvelope } from '@nexa/realtime-contracts';

export interface WebsocketHub {
  broadcast(spaceId: string, event: RealtimeEnvelope): void;
  close(): Promise<void>;
}

declare module 'fastify' {
  interface FastifyInstance {
    websocketHub?: WebsocketHub;
  }
}

function send(socket: WebSocket, message: WebsocketServerMessage): void {
  socket.send(JSON.stringify(websocketServerMessageSchema.parse(message)));
}

function textFromRawData(data: RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}

export function attachWebsocketHub(
  server: Server,
  service: InMemoryCommunityService,
): WebsocketHub {
  const sockets = new Map<WebSocket, string | undefined>();
  const wss = new WebSocketServer({ server, path: '/v1/realtime' });
  wss.on('connection', (socket) => {
    if (
      process.env.NODE_ENV !== 'development' ||
      process.env.NEXA_ENABLE_DEV_AUTH !== 'true'
    ) {
      send(socket, { type: 'error', error: 'development_only' });
      socket.close(1008, 'development only');
      return;
    }
    sockets.set(socket, undefined);
    socket.on('message', (data, isBinary) => {
      let raw: unknown;
      try {
        raw = isBinary ? undefined : JSON.parse(textFromRawData(data));
      } catch {
        raw = undefined;
      }
      const parsed = websocketClientMessageSchema.safeParse(raw);
      if (!parsed.success) {
        send(socket, { type: 'error', error: 'invalid_message' });
        return;
      }
      try {
        service.authorizeSpaceSubscription(
          parsed.data.spaceId,
          parsed.data.actorId,
        );
        sockets.set(socket, parsed.data.spaceId);
        send(socket, { type: 'subscribed', spaceId: parsed.data.spaceId });
      } catch (error) {
        send(socket, {
          type: 'error',
          error: error instanceof DomainError ? error.code : 'invalid_message',
        });
      }
    });
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
    close() {
      for (const socket of sockets.keys()) socket.close(1001, 'server closing');
      return new Promise((resolve, reject) => {
        wss.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
