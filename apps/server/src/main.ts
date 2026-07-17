import { buildApp } from './app.js';
import { attachWebsocketHub } from './websocket.js';

const app = buildApp();
const port = Number(process.env.NEXA_SERVER_PORT ?? 3000);
await app.listen({ host: '0.0.0.0', port });
app.websocketHub = attachWebsocketHub(app.server);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}
