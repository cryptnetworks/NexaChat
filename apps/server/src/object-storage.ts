import {
  S3PrivateObjectStore,
  type PrivateObjectStore,
} from '@nexa/object-storage';
import type { RuntimeConfig } from './config.js';

export async function initializeObjectStorage(
  runtime: RuntimeConfig['objectStorage'],
): Promise<PrivateObjectStore | undefined> {
  if (!runtime.enabled || !runtime.config) return undefined;
  const store = new S3PrivateObjectStore(runtime.config);
  try {
    await store.verify();
    return store;
  } catch (error) {
    store.close();
    process.stderr.write(
      `${JSON.stringify({ event: 'object_storage.startup_failed', code: 'object_storage_unavailable' })}\n`,
    );
    throw error;
  }
}
