import { buildApp } from './app.js';
import { parseRuntimeConfig, safeConfigurationDiagnostic } from './config.js';
import { initializeDatabase } from './database.js';
import { initializeObjectStorage } from './object-storage.js';
import { initializeCoordination } from './coordination.js';
import { attachWebsocketHub } from './websocket.js';

let config;
try {
  config = parseRuntimeConfig(process.env);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ event: 'configuration.invalid', ...safeConfigurationDiagnostic(error) })}\n`,
  );
  process.exitCode = 1;
  throw error;
}

const coordination = await initializeCoordination(config.coordination);
const objectStorage = await initializeObjectStorage(config.objectStorage);
const database = await initializeDatabase(
  config.database,
  config.authentication,
  config.webPush.config,
  coordination,
);
const app = buildApp(
  database.service,
  database.readiness,
  database.auth,
  database.authorization,
  config.server,
  database.experience,
);
if (!database.auth) throw new Error('Authentication runtime is unavailable');
await app.listen({ host: config.server.host, port: config.server.port });
app.websocketHub = attachWebsocketHub(app.server, database.service, {
  auth: database.auth,
  trustedOrigin: config.authentication.trustedOrigin,
  limits: config.websocket,
  ...(coordination ? { coordination } : {}),
  ...(database.experience.presence
    ? { presence: database.experience.presence }
    : {}),
});
database.experience.notificationReadState.setPublisher({
  publish(state) {
    app.websocketHub?.broadcastAccount(state.accountId, {
      version: 1,
      type: 'notification_read',
      state: {
        stream: state.stream,
        sequence: state.sequence,
        eventId: state.eventId,
        updatedAt: state.updatedAt,
        version: state.version,
      },
    });
    return Promise.resolve();
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(
    signal,
    () =>
      void app.websocketHub
        ?.close()
        .then(() => app.close())
        .then(() => database.pool.end())
        .then(() => objectStorage?.close())
        .then(() => coordination?.close())
        .then(() => process.exit(0)),
  );
}
