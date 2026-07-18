import {
  ValkeyCoordination,
  type EphemeralCoordination,
} from '@nexa/coordination';
import type { RuntimeConfig } from './config.js';

export async function initializeCoordination(
  runtime: RuntimeConfig['coordination'],
): Promise<EphemeralCoordination | undefined> {
  if (!runtime.enabled || !runtime.config) return undefined;
  const coordination = new ValkeyCoordination(runtime.config);
  try {
    await coordination.verify();
    return coordination;
  } catch (error) {
    await coordination.close();
    process.stderr.write(
      `${JSON.stringify({ event: 'coordination.startup_failed', code: 'coordination_unavailable' })}\n`,
    );
    throw error;
  }
}
