import { describe, expect, it } from 'vitest';
import {
  MessageSearchService,
  type MessageSearchCandidate,
  type SearchableMessage,
} from '../src/search.js';

describe('scoped message search', () => {
  it('reauthorizes every candidate and excludes stale edits and deletions', async () => {
    const messages = new Map<string, SearchableMessage>([
      [
        'allowed',
        {
          id: 'allowed',
          scope: { type: 'space', id: 's' },
          authorId: 'a',
          body: '<script>alert</script> needle',
          createdAt: '2026-01-03',
          updatedAt: '2026-01-03',
          deletedAt: null,
        },
      ],
      [
        'revoked',
        {
          id: 'revoked',
          scope: { type: 'space', id: 's' },
          authorId: 'b',
          body: 'needle private',
          createdAt: '2026-01-02',
          updatedAt: '2026-01-02',
          deletedAt: null,
        },
      ],
      [
        'edited',
        {
          id: 'edited',
          scope: { type: 'space', id: 's' },
          authorId: 'a',
          body: 'no longer matches',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-04',
          deletedAt: null,
        },
      ],
      [
        'deleted',
        {
          id: 'deleted',
          scope: { type: 'space', id: 's' },
          authorId: 'a',
          body: null,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-04',
          deletedAt: '2026-01-04',
        },
      ],
    ]);
    const candidates: MessageSearchCandidate[] = [...messages.values()].map(
      (message, index) => ({
        messageId: message.id,
        score: 10 - index,
        createdAt: message.createdAt,
      }),
    );
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const service = new MessageSearchService(
      {
        candidates: async () => candidates,
        message: async (id) => messages.get(id),
      },
      {
        assertScope: async () => {},
        assertMessage: async (_actor, message) => {
          if (message.id === 'revoked') throw new Error('denied');
        },
      },
    );
    /* eslint-enable @typescript-eslint/require-await */
    const page = await service.search({
      actorId: 'u',
      query: 'needle',
      scope: { type: 'space', id: 's' },
      limit: 10,
    });
    expect(page.items.map((item) => item.messageId)).toEqual(['allowed']);
    expect(page.items[0]?.excerpt).toContain('<script>');
    expect(page.items[0]?.highlights).toEqual([{ start: 23, end: 29 }]);
  });

  it('bounds query amplification and uses deterministic opaque cursors', async () => {
    let requested = 0;
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const service = new MessageSearchService(
      {
        candidates: async (input) => {
          requested = input.limit;
          return Array.from({ length: input.limit }, (_, index) => ({
            messageId: String(index),
            score: 1,
            createdAt: `2026-01-${String(index + 1).padStart(2, '0')}`,
          }));
        },
        message: async (id) => ({
          id,
          scope: { type: 'community', id: 'c' },
          authorId: 'a',
          body: 'safe query',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
          deletedAt: null,
        }),
      },
      { assertScope: async () => {}, assertMessage: async () => {} },
    );
    /* eslint-enable @typescript-eslint/require-await */
    const page = await service.search({
      actorId: 'u',
      query: 'safe query',
      scope: { type: 'community', id: 'c' },
      limit: 50,
    });
    expect(requested).toBe(250);
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('uses the same private not-found behavior for unauthorized scopes and malformed bounds', async () => {
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const service = new MessageSearchService(
      { candidates: async () => [], message: async () => undefined },
      {
        assertScope: async () => {
          throw new Error('denied');
        },
        assertMessage: async () => {},
      },
    );
    /* eslint-enable @typescript-eslint/require-await */
    await expect(
      service.search({
        actorId: 'u',
        query: 'ok',
        scope: { type: 'direct', id: 'private' },
        limit: 10,
      }),
    ).rejects.toThrow('search_unavailable');
    await expect(
      service.search({
        actorId: 'u',
        query: 'x',
        scope: { type: 'space', id: 's' },
        limit: 10,
      }),
    ).rejects.toThrow('invalid_search_query');
  });
});
