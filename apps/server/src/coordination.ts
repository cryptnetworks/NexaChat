import { ValkeyCoordination } from '@nexa/coordination';
import type { RuntimeConfig } from './config.js';
import type { Telemetry } from './telemetry.js';

export interface CoordinationRuntime {
  enabled: boolean;
  check(): Promise<void>;
  close(): Promise<void>;
}

export async function initializeCoordination(
  runtime: RuntimeConfig['coordination'],
  telemetry?: Telemetry,
  failClosed = false,
): Promise<CoordinationRuntime> {
  if (!runtime.enabled || !runtime.config)
    return {
      enabled: false,
      check: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
  const coordination = new ValkeyCoordination(runtime.config, undefined, {
    event: (operation, outcome, durationMs) =>
      telemetry?.coordination(operation, outcome, durationMs),
  });
  let pending: Promise<void> | undefined;
  const check = () => {
    pending ??= coordination.verify().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  try {
    await check();
  } catch {
    if (failClosed) {
      await coordination.close();
      throw new Error('coordination_unavailable');
    }
    process.stderr.write(
      `${JSON.stringify({ event: 'coordination.degraded', code: 'coordination_unavailable' })}\n`,
    );
  }
  return {
    enabled: true,
    check,
    async close() {
      await coordination.close();
    },
  };
}
