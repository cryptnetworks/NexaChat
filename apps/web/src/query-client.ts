export type QueryState<T> =
  | { status: 'loading'; data?: T }
  | { status: 'ready'; data: T; stale: boolean }
  | { status: 'offline'; data?: T }
  | { status: 'error'; data?: T; retryable: boolean };

const stableKey = (parts: readonly (string | number)[]): string =>
  JSON.stringify(parts);
export class QueryClient {
  private readonly cache = new Map<
    string,
    { value: unknown; expiresAt: number }
  >();
  private readonly active = new Map<string, AbortController>();
  constructor(
    private readonly fetcher: typeof fetch,
    private readonly online: () => boolean = () => navigator.onLine,
  ) {}
  async query<T>(
    parts: readonly (string | number)[],
    url: string,
    options: { staleMs?: number; signal?: AbortSignal } = {},
  ): Promise<QueryState<T>> {
    const key = stableKey(parts);
    const cached = this.cache.get(key) as
      { value: T; expiresAt: number } | undefined;
    if (!this.online())
      return cached
        ? { status: 'offline', data: cached.value }
        : { status: 'offline' };
    this.active.get(key)?.abort();
    const controller = new AbortController();
    this.active.set(key, controller);
    const abort = () => {
      controller.abort();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await this.fetcher(url, {
            method: 'GET',
            signal: controller.signal,
            credentials: 'include',
          });
          if (!response.ok) {
            if (response.status < 500 || attempt === 2)
              return {
                status: 'error',
                ...(cached ? { data: cached.value } : {}),
                retryable: response.status >= 500,
              };
            continue;
          }
          const value = (await response.json()) as T;
          this.cache.set(key, {
            value,
            expiresAt: Date.now() + (options.staleMs ?? 30_000),
          });
          return { status: 'ready', data: value, stale: false };
        } catch (error) {
          if (controller.signal.aborted) throw error;
          if (attempt === 2)
            return {
              status: 'error',
              ...(cached ? { data: cached.value } : {}),
              retryable: true,
            };
        }
      }
      return { status: 'error', retryable: true };
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (this.active.get(key) === controller) this.active.delete(key);
    }
  }
  cached<T>(parts: readonly (string | number)[]): QueryState<T> | undefined {
    const value = this.cache.get(stableKey(parts)) as
      { value: T; expiresAt: number } | undefined;
    return value
      ? {
          status: 'ready',
          data: value.value,
          stale: Date.now() >= value.expiresAt,
        }
      : undefined;
  }
  invalidate(prefix: readonly (string | number)[]): void {
    const serialized = JSON.stringify(prefix).slice(0, -1);
    for (const key of this.cache.keys())
      if (key.startsWith(serialized)) this.cache.delete(key);
  }
  cancel(parts: readonly (string | number)[]): void {
    this.active.get(stableKey(parts))?.abort();
  }
}
