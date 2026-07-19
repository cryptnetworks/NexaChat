import { buildApp } from './app.js';
import { parseRuntimeConfig, safeConfigurationDiagnostic } from './config.js';
import { initializeDatabase } from './database.js';
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

const database = await initializeDatabase(
  config.database,
  config.authentication,
);
const app = buildApp(
  database.service,
  database.readiness,
  database.auth,
  database.authorization,
  config.server,
);
if (!database.auth) throw new Error('Authentication runtime is unavailable');
await app.listen({ host: config.server.host, port: config.server.port });
app.websocketHub = attachWebsocketHub(app.server, database.service, {
  auth: database.auth,
  trustedOrigin: config.authentication.trustedOrigin,
  limits: config.websocket,
});

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
