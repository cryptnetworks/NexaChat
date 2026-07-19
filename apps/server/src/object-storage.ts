import { S3PrivateObjectStore } from '@nexa/object-storage';
import type { RuntimeConfig } from './config.js';
import type { Telemetry } from './telemetry.js';

export interface ObjectStorageRuntime {
  enabled: boolean;
  check(): Promise<void>;
  close(): Promise<void>;
}

export async function initializeObjectStorage(
  runtime: RuntimeConfig['objectStorage'],
  telemetry?: Telemetry,
): Promise<ObjectStorageRuntime> {
  if (!runtime.enabled || !runtime.config)
    return {
      enabled: false,
      check: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
  const store = new S3PrivateObjectStore(runtime.config, undefined, {
    event: (operation, outcome, durationMs) =>
      telemetry?.objectStorage(operation, outcome, durationMs),
  });
  let pending: Promise<void> | undefined;
  const check = () => {
    pending ??= store.verify().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  try {
    await check();
  } catch {
    process.stderr.write(
      `${JSON.stringify({ event: 'object_storage.degraded', code: 'object_storage_unavailable' })}\n`,
    );
  }
  return {
    enabled: true,
    check,
    close() {
      store.close();
      return Promise.resolve();
    },
  };
}
