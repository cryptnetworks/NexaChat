import { buildApp } from './app.js';
import { attachWebsocketHub } from './websocket.js';
import { InMemoryCommunityService } from '@nexa/domain';

const service = new InMemoryCommunityService();
const app = buildApp(service);
const port = Number(process.env.NEXA_SERVER_PORT ?? 3000);
await app.listen({ host: '0.0.0.0', port });
app.websocketHub = attachWebsocketHub(app.server, service);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(
    signal,
    () =>
      void app.websocketHub
        ?.close()
        .then(() => app.close())
        .then(() => process.exit(0)),
  );
}
