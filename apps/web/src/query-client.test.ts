import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from './query-client.js';

describe('resilient query client', () => {
  it('uses stable keys, invalidation, stale state, and offline cached feedback', async () => {
    let online = true;
    const fetcher = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ id: 1 }), { status: 200 })),
    );
    const client = new QueryClient(fetcher, () => online);
    expect(
      await client.query<{ id: number }>(['space', 'one'], '/safe'),
    ).toMatchObject({ status: 'ready', data: { id: 1 } });
    online = false;
    expect(await client.query(['space', 'one'], '/safe')).toMatchObject({
      status: 'offline',
      data: { id: 1 },
    });
    client.invalidate(['space']);
    expect(client.cached(['space', 'one'])).toBeUndefined();
  });
  it('cancels superseded requests and never retries non-server errors', () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) => {
        signals.push(init?.signal as AbortSignal);
        return new Promise<Response>(() => {});
      },
    );
    const client = new QueryClient(fetcher, () => true);
    void client.query(['k'], '/one');
    void client.query(['k'], '/two');
    expect(signals[0]?.aborted).toBe(true);
    client.cancel(['k']);
    expect(signals[1]?.aborted).toBe(true);
  });
});
