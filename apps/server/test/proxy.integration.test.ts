import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('HTTP trusted proxy boundary', () => {
  it('uses canonical forwarded clients for request admission only behind a trusted peer', async () => {
    const app = application(['10.0.0.2/32']);

    const first = await request(app, '10.0.0.2', '198.51.100.7');
    const limited = await request(app, '10.0.0.2', '198.51.100.7');
    const independent = await request(app, '10.0.0.2', '198.51.100.8');

    expect(first.json()).toEqual({ address: '198.51.100.7' });
    expect(limited.statusCode).toBe(429);
    expect(independent.json()).toEqual({ address: '198.51.100.8' });
    await app.close();
  });

  it('ignores spoofed forwarding when the socket peer is not trusted', async () => {
    const app = application([]);

    const first = await request(app, '192.0.2.2', '198.51.100.7');
    const limited = await request(app, '192.0.2.2', '198.51.100.8');

    expect(first.json()).toEqual({ address: '192.0.2.2' });
    expect(limited.statusCode).toBe(429);
    await app.close();
  });
});

function application(trustedProxyCidrs: string[]) {
  const app = buildApp(undefined, undefined, undefined, undefined, {
    host: '127.0.0.1',
    port: 3000,
    bodyLimitBytes: 16_384,
    requestTimeoutMs: 15_000,
    shutdownTimeoutMs: 10_000,
    rateLimit: 1,
    rateWindowMs: 60_000,
    logLevel: 'error',
    trustedProxyCidrs,
  });
  app.get('/test/client-address', (request) => ({
    address: request.clientAddress,
  }));
  return app;
}

function request(
  app: ReturnType<typeof buildApp>,
  remoteAddress: string,
  forwardedFor: string,
) {
  return app.inject({
    method: 'GET',
    url: '/test/client-address',
    remoteAddress,
    headers: { 'x-forwarded-for': forwardedFor },
  });
}
