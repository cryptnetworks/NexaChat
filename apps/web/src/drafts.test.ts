import { describe, expect, it } from 'vitest';
import { clearDraft, draftKey, loadDraft, saveDraft } from './drafts.js';

describe('space drafts', () => {
  it('isolates accounts and spaces and clears only the confirmed target', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
    saveDraft(storage, 'account-a', 'space-a', 'first');
    saveDraft(storage, 'account-b', 'space-a', 'second');
    expect(loadDraft(storage, 'account-a', 'space-a')).toBe('first');
    expect(loadDraft(storage, 'account-b', 'space-a')).toBe('second');
    clearDraft(storage, 'account-a', 'space-a');
    expect(values.has(draftKey('account-a', 'space-a'))).toBe(false);
    expect(loadDraft(storage, 'account-b', 'space-a')).toBe('second');
  });
});
