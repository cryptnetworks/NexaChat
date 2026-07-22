import { createHash } from 'node:crypto';

export interface SpamRules {
  windowSeconds: number;
  floodThreshold: number;
  repetitionThreshold: number;
}
export interface SpamObservation {
  occurredAt: string;
  contentDigest: string;
}
export interface SpamSignal {
  type: 'flood' | 'repetition';
  explanationCode: 'message_rate_exceeded' | 'content_digest_repeated';
  score: number;
  contentDigest: string;
}

export function contentDigest(body: string): string {
  return createHash('sha256')
    .update(body.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase())
    .digest('hex');
}

/** Advisory only. Callers must never convert signals directly into moderation. */
export function evaluateSpamSignals(
  body: string,
  history: readonly SpamObservation[],
  rules: SpamRules,
  now: Date,
): SpamSignal[] {
  if (
    !Number.isInteger(rules.windowSeconds) ||
    rules.windowSeconds < 5 ||
    rules.windowSeconds > 3600 ||
    !Number.isInteger(rules.floodThreshold) ||
    rules.floodThreshold < 2 ||
    rules.floodThreshold > 100 ||
    !Number.isInteger(rules.repetitionThreshold) ||
    rules.repetitionThreshold < 2 ||
    rules.repetitionThreshold > 20
  )
    throw new Error('invalid_spam_rules');
  const digest = contentDigest(body);
  const cutoff = now.getTime() - rules.windowSeconds * 1000;
  const recent = history
    .slice(-100)
    .filter((item) => new Date(item.occurredAt).getTime() >= cutoff);
  const signals: SpamSignal[] = [];
  if (recent.length + 1 >= rules.floodThreshold)
    signals.push({
      type: 'flood',
      explanationCode: 'message_rate_exceeded',
      score: Math.min(100, 40 + recent.length),
      contentDigest: digest,
    });
  const repetitions = recent.filter(
    (item) => item.contentDigest === digest,
  ).length;
  if (repetitions + 1 >= rules.repetitionThreshold)
    signals.push({
      type: 'repetition',
      explanationCode: 'content_digest_repeated',
      score: Math.min(100, 50 + repetitions * 5),
      contentDigest: digest,
    });
  return signals;
}
