import { describe, expect, it } from 'vitest';
import {
  SavedMessageService,
  type SavedMessage,
} from '../src/saved-messages.js';

describe('saved messages', () => {
  it('is owner-private, idempotent, and safely represents inaccessible sources', async () => {
    const values: SavedMessage[] = [];
    let visible = true;
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const service = new SavedMessageService(
      {
        find: async (a, m) =>
          values.find((v) => v.accountId === a && v.messageId === m),
        create: async (v) => (values.push(v), v),
        remove: async (a, m) =>
          Boolean(values.find((v) => v.accountId === a && v.messageId === m)),
        list: async (a) => ({
          items: values.filter((v) => v.accountId === a),
          nextCursor: null,
        }),
      },
      { mayView: async () => visible },
    );
    /* eslint-enable @typescript-eslint/require-await */
    const first = await service.save('u', 'm', new Date('2026-01-01'));
    expect((await service.save('u', 'm', new Date())).id).toBe(first.id);
    visible = false;
    expect((await service.list('u', { limit: 20 })).items[0]?.available).toBe(
      false,
    );
    expect((await service.list('other', { limit: 20 })).items).toEqual([]);
  });
});
