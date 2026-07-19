import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';

const url = required('NEXA_VERIFY_WS_URL');
const origin = required('NEXA_VERIFY_ORIGIN');
const cookie = required('NEXA_VERIFY_COOKIE');
const certificate = readFileSync(required('NEXA_VERIFY_CA_FILE'));

await new Promise((resolve, reject) => {
  const socket = new WebSocket(url, {
    origin,
    headers: { cookie },
    ca: certificate,
    handshakeTimeout: 10_000,
    lookup(_hostname, options, callback) {
      if (options?.all) {
        callback(null, [{ address: '127.0.0.1', family: 4 }]);
        return;
      }
      callback(null, '127.0.0.1', 4);
    },
  });
  const timeout = setTimeout(() => {
    socket.terminate();
    reject(new Error('websocket verification timed out'));
  }, 15_000);

  socket.once('open', () => {
    socket.send(JSON.stringify({ version: 1, type: 'heartbeat' }));
  });
  socket.once('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (
        message.version !== 1 ||
        message.type !== 'heartbeat' ||
        typeof message.occurredAt !== 'string'
      ) {
        throw new Error('unexpected websocket heartbeat response');
      }
      clearTimeout(timeout);
      socket.close(1000, 'verified');
      resolve();
    } catch (error) {
      clearTimeout(timeout);
      socket.terminate();
      reject(error);
    }
  });
  socket.once('error', (error) => {
    clearTimeout(timeout);
    reject(error);
  });
});

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
