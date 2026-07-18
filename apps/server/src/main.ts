import { buildApp } from './app.js';
import { initializeDatabase } from './database.js';
import { attachWebsocketHub } from './websocket.js';

const database = await initializeDatabase();
const app = buildApp(database.service, database.readiness);
const port = Number(process.env.NEXA_SERVER_PORT ?? 3000);
await app.listen({ host: '0.0.0.0', port });
app.websocketHub = attachWebsocketHub(app.server, database.service);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(
    signal,
    () =>
      void app.websocketHub
        ?.close()
        .then(() => app.close())
        .then(() => database.pool.end())
        .then(() => process.exit(0)),
  );
}
