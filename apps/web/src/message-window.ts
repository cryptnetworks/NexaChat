import { upsertOrderedMessage } from './ordered-messages.js';

export interface WindowMessage {
  id: string;
  createdAt: string;
}

export const maximumLiveMessages = 200;

export type WindowRetention = 'oldest' | 'newest';

function trimWindow<T>(
  messages: readonly T[],
  retention: WindowRetention,
  maximum: number,
): T[] {
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new Error('message window maximum must be a positive integer');
  if (messages.length <= maximum) return [...messages];
  return retention === 'newest'
    ? messages.slice(messages.length - maximum)
    : messages.slice(0, maximum);
}

export function upsertMessageWindow<T extends WindowMessage>(
  current: readonly T[],
  message: T,
  retention: WindowRetention = 'newest',
  maximum = maximumLiveMessages,
): T[] {
  return trimWindow(upsertOrderedMessage(current, message), retention, maximum);
}

export function mergeMessageWindow<T extends WindowMessage>(
  current: readonly T[],
  incoming: readonly T[],
  retention: WindowRetention = 'newest',
  maximum = maximumLiveMessages,
): T[] {
  const byId = new Map<string, T>();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return trimWindow(
    [...byId.values()].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    ),
    retention,
    maximum,
  );
}
