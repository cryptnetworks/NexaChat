export function publicRequestError(
  status: number,
  retryAfter: string | null,
): Error {
  const seconds = retryAfter === null ? undefined : Number(retryAfter);
  const retry =
    seconds !== undefined &&
    Number.isSafeInteger(seconds) &&
    seconds >= 1 &&
    seconds <= 3_600
      ? ` Try again in ${String(seconds)} seconds.`
      : '';
  return new Error(`Request failed (${String(status)}).${retry}`);
}
