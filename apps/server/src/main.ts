import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { parseRuntimeConfig, safeConfigurationDiagnostic } from './config.js';
import { initializeDatabase } from './database.js';
import {
  initializeObjectStorage,
  type ObjectStorageRuntime,
} from './object-storage.js';
import {
  initializeCoordination,
  type CoordinationRuntime,
} from './coordination.js';
import {
  OperationalReadiness,
  closeWithinDeadline,
  type ShutdownResource,
} from './health.js';
import { Telemetry } from './telemetry.js';
import { attachWebsocketHub } from './websocket.js';
import { loadFileBackedSecrets } from './secrets.js';

class StartupInterrupted extends Error {}

async function start(): Promise<void> {
  let config;
  try {
    config = parseRuntimeConfig(loadFileBackedSecrets(process.env));
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ event: 'configuration.invalid', ...safeConfigurationDiagnostic(error) })}\n`,
    );
    throw error;
  }

  const telemetry = new Telemetry({
    traceSampleRate: config.observability.traceSampleRate,
  });
  telemetry.lifecycle('starting');
  telemetry.startProcessCollection();

  let coordination: CoordinationRuntime | undefined;
  let objectStorage: ObjectStorageRuntime | undefined;
  let database: Awaited<ReturnType<typeof initializeDatabase>> | undefined;
  let app: FastifyInstance | undefined;
  let readiness: OperationalReadiness | undefined;
  let startupComplete = false;
  let shutdownSignal: 'SIGINT' | 'SIGTERM' | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let startupShutdownDeadline = 0;
  let startupShutdownTimer: ReturnType<typeof setTimeout> | undefined;
  let forced = false;

  const shutdownResources = (): ShutdownResource[] => [
    {
      name: 'websocket',
      close: () => app?.websocketHub?.close() ?? Promise.resolve(),
    },
    {
      name: 'http',
      close: async () => {
        await app?.drainHttp?.();
        await app?.close();
      },
    },
    {
      name: 'postgres',
      close: () => database?.pool.end() ?? Promise.resolve(),
    },
    {
      name: 'object_storage',
      close: () => objectStorage?.close() ?? Promise.resolve(),
    },
    {
      name: 'coordination',
      close: () => coordination?.close() ?? Promise.resolve(),
    },
  ];
  const shutdownLog = (record: Record<string, unknown>) => {
    if (!app) {
      try {
        process.stderr.write(`${JSON.stringify(record)}\n`);
      } catch {
        telemetry.recordFailure();
      }
      return;
    }
    try {
      if (record.event === 'shutdown.failed') app.log.error(record);
      else if (record.event === 'shutdown.resource_failed')
        app.log.warn(record);
      else app.log.info(record);
    } catch {
      telemetry.recordFailure();
    }
  };
  const forceShutdown = () => {
    if (forced) return;
    forced = true;
    try {
      app?.server.closeAllConnections();
    } catch {
      telemetry.recordFailure();
    }
    telemetry.lifecycle('stopped');
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 100);
  };
  const beginReadyShutdown = (signal: 'SIGINT' | 'SIGTERM') => {
    if (shutdownPromise) return;
    readiness?.beginDrain();
    shutdownPromise = Promise.resolve()
      .then(() =>
        closeWithinDeadline(
          shutdownResources(),
          config.server.shutdownTimeoutMs,
          telemetry,
          shutdownLog,
        ),
      )
      .catch(forceShutdown);
    try {
      app?.log.info({ event: 'shutdown.signal', signal }, 'shutdown requested');
    } catch {
      telemetry.recordFailure();
    }
  };
  const requestShutdown = (signal: 'SIGINT' | 'SIGTERM') => {
    if (shutdownSignal) return;
    shutdownSignal = signal;
    if (startupComplete) {
      beginReadyShutdown(signal);
      return;
    }
    startupShutdownDeadline = Date.now() + config.server.shutdownTimeoutMs;
    telemetry.lifecycle('draining');
    shutdownLog({ event: 'shutdown.signal', signal, phase: 'startup' });
    startupShutdownTimer = setTimeout(
      forceShutdown,
      config.server.shutdownTimeoutMs,
    );
  };
  const interruptIfRequested = () => {
    if (shutdownSignal) throw new StartupInterrupted();
  };
  const onSigint = () => {
    requestShutdown('SIGINT');
  };
  const onSigterm = () => {
    requestShutdown('SIGTERM');
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  try {
    const failClosedProviders =
      config.deployment.profile === 'single-host-private';
    coordination = await initializeCoordination(
      config.coordination,
      telemetry,
      failClosedProviders,
    );
    interruptIfRequested();
    objectStorage = await initializeObjectStorage(
      config.objectStorage,
      telemetry,
      failClosedProviders,
    );
    interruptIfRequested();
    database = await initializeDatabase(
      config.database,
      config.authentication,
      telemetry,
      config.webPush.config,
      coordination.coordination,
    );
    interruptIfRequested();
    readiness = new OperationalReadiness(
      database.readiness,
      [
        {
          name: 'coordination',
          enabled: coordination.enabled,
          check: () => coordination?.check() ?? Promise.resolve(),
        },
        {
          name: 'objectStorage',
          enabled: objectStorage.enabled,
          check: () => objectStorage?.check() ?? Promise.resolve(),
        },
      ],
      telemetry,
    );
    app = buildApp(
      database.service,
      readiness,
      database.auth,
      database.authorization,
      config.server,
      telemetry,
      coordination.coordination,
      database.experience,
    );
    if (!database.auth) throw new Error('authentication_unavailable');
    await app.listen({
      host: config.server.host,
      port: config.server.port,
      listenTextResolver: () => 'service listener active',
    });
    interruptIfRequested();
    app.websocketHub = attachWebsocketHub(app.server, database.service, {
      auth: database.auth,
      trustedOrigin: config.authentication.trustedOrigin,
      trustedProxyCidrs: config.server.trustedProxyCidrs,
      limits: config.websocket,
      metrics: telemetry.websocketMetrics(),
      rateLimiter: app.requestRateLimiter,
      ...(coordination.coordination
        ? { coordination: coordination.coordination }
        : {}),
      ...(database.experience.presence
        ? { presence: database.experience.presence }
        : {}),
      memberStatus: database.experience.memberStatus,
    });
    const currentApp = app;
    database.auth.recovery?.setSessionInvalidationPublisher(
      (accountId) =>
        currentApp.websocketHub?.invalidateAccountSessions?.(accountId) ??
        Promise.resolve(),
    );
    await app.websocketHub.ready();
    database.experience.notificationReadState.setPublisher({
      publish(state) {
        app?.websocketHub?.broadcastAccount(state.accountId, {
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
    readiness.markStarted();
    app.log.info({ event: 'startup.ready' }, 'service ready');
    startupComplete = true;
    if (shutdownSignal) beginReadyShutdown(shutdownSignal);
  } catch (error) {
    if (shutdownSignal) {
      readiness?.beginDrain();
      const remainingMs = Math.max(1, startupShutdownDeadline - Date.now());
      try {
        await closeWithinDeadline(
          shutdownResources(),
          remainingMs,
          telemetry,
          shutdownLog,
        );
        if (startupShutdownTimer) clearTimeout(startupShutdownTimer);
      } catch {
        forceShutdown();
      }
      return;
    }
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    telemetry.stopProcessCollection();
    await Promise.allSettled([
      app?.websocketHub?.close() ?? Promise.resolve(),
      app?.close() ?? Promise.resolve(),
      database?.pool.end() ?? Promise.resolve(),
      objectStorage?.close() ?? Promise.resolve(),
      coordination?.close() ?? Promise.resolve(),
    ]);
    throw error;
  }
}

try {
  await start();
} catch {
  process.stderr.write(
    `${JSON.stringify({ event: 'startup.failed', code: 'startup_failed' })}\n`,
  );
  process.exitCode = 1;
}
