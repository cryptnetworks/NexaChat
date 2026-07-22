import { describe, expect, it } from 'vitest';
import {
  ThreadService,
  type MessageThread,
  type ThreadReply,
  type ThreadStore,
} from '../src/threads.js';

describe('message threads', () => {
  it('supports idempotent replies, stable sequence pages, tombstoned roots, and unread state', async () => {
    let thread: MessageThread | undefined;
    const replies: ThreadReply[] = [];
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const store: ThreadStore = {
      root: async () => ({ id: 'root', deletedAt: '2026-01-01' }),
      thread: async () => thread,
      findRetry: async (r, a, k) =>
        replies.find(
          (v) =>
            v.rootMessageId === r && v.authorId === a && v.idempotencyKey === k,
        ),
      append: async (reply) => {
        replies.push(reply);
        thread = {
          rootMessageId: 'root',
          replyCount: replies.length,
          lastSequence: reply.sequence,
          updatedAt: reply.createdAt,
        };
        return { reply, thread };
      },
      list: async (_r, p) =>
        replies.filter((v) => v.sequence > p.after).slice(0, p.limit),
      readSequence: async () => 0,
      advanceRead: async (_r, _a, s) => s,
      transaction: (work) => work(store),
    };
    const service = new ThreadService(store, {
      assertRead: async () => {},
      assertReply: async () => {},
    });
    /* eslint-enable @typescript-eslint/require-await */
    const first = await service.reply('root', 'u', 'reply', 'thread-key-01');
    expect(
      (await service.reply('root', 'u', 'reply', 'thread-key-01')).reply.id,
    ).toBe(first.reply.id);
    expect(await service.unread('root', 'other')).toBe(1);
    expect((await service.list('root', 'u', 10))[0]?.sequence).toBe(1);
  });
});
