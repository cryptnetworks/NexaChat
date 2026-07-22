import { readFile } from 'node:fs/promises';
import { request } from 'node:https';

const host = process.env.NEXA_PROBE_HOST;
const address = process.env.NEXA_PROBE_ADDRESS ?? 'edge';
const clientAddress = process.env.NEXA_PROBE_CLIENT ?? '198.51.100.42';
const secret = process.env.NEXA_PROBE_SECRET;
const suffix = process.env.NEXA_PROBE_SUFFIX;
const mode = process.env.NEXA_PROBE_MODE ?? 'trusted';
if (!host || !secret || !suffix) throw new Error('probe configuration missing');
const ca = await readFile('/tmp/tunnel_origin_ca.pem');

function call(path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ?? '';
    const headers = {
      Host: host,
      'CF-Connecting-IP': clientAddress,
      ...(options.headers ?? {}),
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const operation = request(
      {
        hostname: address,
        port: 8443,
        servername: host,
        ca,
        method: options.method ?? 'GET',
        path,
        headers,
      },
      (response) => {
        response.resume();
        response.once('end', () =>
          resolve({ headers: response.headers, status: response.statusCode }),
        );
      },
    );
    operation.once('error', reject);
    if (body) operation.write(body);
    operation.end();
  });
}

function expectStatus(result, expected, label) {
  if (result.status !== expected)
    throw new Error(`${label} returned ${String(result.status)}`);
}

if (mode === 'spoof') {
  expectStatus(await call('/health/live'), 403, 'spoofed connector request');
  console.log('Untrusted connector header was rejected.');
  process.exit(0);
}

expectStatus(await call('/'), 200, 'web route');
expectStatus(await call('/health/ready'), 200, 'readiness route');
expectStatus(
  await call('/v1/account', {
    headers: { 'Cf-Access-Jwt-Assertion': 'synthetic-untrusted-assertion' },
  }),
  401,
  'Access non-bypass route',
);
expectStatus(
  await call('/v1/realtime', {
    headers: {
      Connection: 'Upgrade',
      Origin: `https://${host}`,
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': Buffer.from('nexa-probe-nonce').toString('base64'),
      'Sec-WebSocket-Version': '13',
    },
  }),
  401,
  'WebSocket route',
);

const registration = JSON.stringify({
  username: `probe${suffix}`,
  displayName: `Probe ${suffix}`,
  password: secret,
});
const accepted = await call('/v1/auth/register', {
  method: 'POST',
  body: registration,
  headers: { Origin: `https://${host}` },
});
expectStatus(accepted, 201, 'trusted-origin registration');
const cookie = accepted.headers['set-cookie']?.[0] ?? '';
if (
  !cookie.startsWith('__Host-nexa_session=') ||
  !cookie.includes('; Secure') ||
  !cookie.includes('; HttpOnly') ||
  !cookie.includes('; SameSite=Strict')
)
  throw new Error('secure cookie attributes are missing');

expectStatus(
  await call('/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      username: `denied${suffix}`,
      displayName: `Denied ${suffix}`,
      password: secret,
    }),
    headers: { Origin: 'https://invalid.example.test' },
  }),
  403,
  'invalid-origin registration',
);

console.log(
  'Web, API, WebSocket, secure-cookie, origin, and Access compatibility probes passed.',
);
