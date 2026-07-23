interface OrderedMessage {
  id: string;
  createdAt: string;
}

function compareMessages(left: OrderedMessage, right: OrderedMessage): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

export function upsertOrderedMessage<T extends OrderedMessage>(
  current: readonly T[],
  message: T,
): T[] {
  const existingIndex = current.findIndex((item) => item.id === message.id);
  const existing = current[existingIndex];
  if (existing !== undefined && compareMessages(existing, message) === 0) {
    const updated = [...current];
    updated[existingIndex] = message;
    return updated;
  }

  const withoutCurrent =
    existingIndex < 0
      ? [...current]
      : [
          ...current.slice(0, existingIndex),
          ...current.slice(existingIndex + 1),
        ];
  let low = 0;
  let high = withoutCurrent.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = withoutCurrent[middle];
    if (candidate !== undefined && compareMessages(candidate, message) <= 0)
      low = middle + 1;
    else high = middle;
  }
  withoutCurrent.splice(low, 0, message);
  return withoutCurrent;
}
