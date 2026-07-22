export const MAX_DRAFT_LENGTH = 4000;
const PREFIX = 'nexa:draft:v1';

export function draftKey(accountId: string, spaceId: string): string {
  return `${PREFIX}:${accountId}:${spaceId}`;
}

export function loadDraft(
  storage: Pick<Storage, 'getItem'>,
  accountId: string,
  spaceId: string,
): string {
  try {
    return (storage.getItem(draftKey(accountId, spaceId)) ?? '').slice(
      0,
      MAX_DRAFT_LENGTH,
    );
  } catch {
    return '';
  }
}

export function saveDraft(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  accountId: string,
  spaceId: string,
  value: string,
): void {
  try {
    const bounded = value.slice(0, MAX_DRAFT_LENGTH);
    if (bounded) storage.setItem(draftKey(accountId, spaceId), bounded);
    else storage.removeItem(draftKey(accountId, spaceId));
  } catch {
    // Private browsing and storage quotas must not break the composer.
  }
}

export function clearDraft(
  storage: Pick<Storage, 'removeItem'>,
  accountId: string,
  spaceId: string,
): void {
  try {
    storage.removeItem(draftKey(accountId, spaceId));
  } catch {
    // Sending succeeded; an unavailable cache needs no recovery action.
  }
}
