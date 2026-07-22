export function accessibleTimestamp(value: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(new Date(value));
}

export interface RateLimitedAnnouncer {
  announceMessage(): void;
  dispose(): void;
}

export function createRateLimitedAnnouncer(
  emit: (message: string) => void,
  intervalMilliseconds = 3_000,
): RateLimitedAnnouncer {
  let pending = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    announceMessage() {
      pending += 1;
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        emit(
          pending === 1
            ? '1 new message received.'
            : `${String(pending)} new messages received.`,
        );
        pending = 0;
        timer = undefined;
      }, intervalMilliseconds);
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      pending = 0;
      timer = undefined;
    },
  };
}
