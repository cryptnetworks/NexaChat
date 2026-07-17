import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import type { WebsocketServerMessage } from '@nexa/api-contracts';
import type { RealtimeEnvelope } from '@nexa/realtime-contracts';
import { buildApp } from '../src/app.js';
import { attachWebsocketHub } from '../src/websocket.js';
import { InMemoryCommunityService } from '@nexa/domain';

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try {
        resolve(JSON.parse(textFromRawData(data)));
      } catch (error) {
        reject(error instanceof Error ? error : new Error('invalid JSON'));
      }
    });
    socket.once('error', reject);
  });
}

function textFromRawData(data: RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}

function open(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', resolve));
}

describe('real WebSocket integration', () => {
  const priorNodeEnv = process.env.NODE_ENV;
  let service: InMemoryCommunityService;
  let app: ReturnType<typeof buildApp>;
  let endpoint: string;

  beforeEach(async () => {
    process.env.NODE_ENV = 'development';
    process.env.NEXA_ENABLE_DEV_AUTH = 'true';
    service = new InMemoryCommunityService();
    app = buildApp(service);
    await app.listen({ host: '127.0.0.1', port: 0 });
    app.websocketHub = attachWebsocketHub(app.server, service);
    const address = app.server.address() as AddressInfo;
    endpoint = `ws://127.0.0.1:${String(address.port)}/v1/realtime`;
  });

  afterEach(async () => {
    await app.websocketHub?.close();
    await app.close();
    process.env.NODE_ENV = priorNodeEnv;
    delete process.env.NEXA_ENABLE_DEV_AUTH;
  });

  it('connects, subscribes, receives a message, handles malformed input, and disconnects cleanly', async () => {
    const owner = service.createAccount('Owner');
    const community = service.createCommunity(owner.id, 'Workshop');
    const space = service.createTextSpace(community.id, owner.id, 'planning');
    const socket = new WebSocket(endpoint);
    await open(socket);

    socket.send('{');
    await expect(nextMessage(socket)).resolves.toEqual({
      type: 'error',
      error: 'invalid_message',
    } satisfies WebsocketServerMessage);

    socket.send(
      JSON.stringify({
        type: 'subscribe',
        spaceId: space.id,
        actorId: owner.id,
      }),
    );
    await expect(nextMessage(socket)).resolves.toEqual({
      type: 'subscribed',
      spaceId: space.id,
    } satisfies WebsocketServerMessage);

    const delivered = nextMessage(socket);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${space.id}/messages`,
      payload: { authorId: owner.id, body: 'Hello over WebSocket' },
    });
    expect(response.statusCode).toBe(201);
    const event = (await delivered) as RealtimeEnvelope;
    expect(event).toMatchObject({
      type: 'message.created',
      payload: { message: { body: 'Hello over WebSocket', spaceId: space.id } },
    });

    const closeEvent = closed(socket);
    socket.close(1000, 'test complete');
    await expect(closeEvent).resolves.toBe(1000);
  });

  it('rejects unknown and unauthorized subscriptions', async () => {
    const owner = service.createAccount('Owner');
    const other = service.createAccount('Other');
    const community = service.createCommunity(owner.id, 'Workshop');
    const space = service.createTextSpace(community.id, owner.id, 'planning');
    const socket = new WebSocket(endpoint);
    await open(socket);

    socket.send(
      JSON.stringify({
        type: 'subscribe',
        spaceId: crypto.randomUUID(),
        actorId: owner.id,
      }),
    );
    await expect(nextMessage(socket)).resolves.toEqual({
      type: 'error',
      error: 'not_found',
    });

    socket.send(
      JSON.stringify({
        type: 'subscribe',
        spaceId: space.id,
        actorId: other.id,
      }),
    );
    await expect(nextMessage(socket)).resolves.toEqual({
      type: 'error',
      error: 'forbidden',
    });
    const closeEvent = closed(socket);
    socket.close(1000);
    await closeEvent;
  });

  it('rejects every connection outside explicitly enabled development mode', async () => {
    process.env.NODE_ENV = 'production';
    const socket = new WebSocket(endpoint);
    const closeEvent = closed(socket);
    const rejection = nextMessage(socket);
    await open(socket);
    await expect(rejection).resolves.toEqual({
      type: 'error',
      error: 'development_only',
    });
    await expect(closeEvent).resolves.toBe(1008);
  });
});
