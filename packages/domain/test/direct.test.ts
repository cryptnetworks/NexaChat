import { describe, expect, it } from 'vitest';
import {
  DirectConversationService,
  InMemoryDirectStore,
} from '../src/direct.js';

const setup = () => {
  const active = new Set(['alice', 'bob', 'mallory']);
  const blocked = new Set<string>();
  /* eslint-disable @typescript-eslint/require-await -- adapter parity */
  const service = new DirectConversationService(new InMemoryDirectStore(), {
    assertAccountActive: async (id) => {
      if (!active.has(id)) throw new Error('inactive');
    },
    assertDirectAllowed: async (actor, other) => {
      if (blocked.has(`${actor}:${other}`) || blocked.has(`${other}:${actor}`))
        throw new Error('blocked');
    },
  });
  /* eslint-enable @typescript-eslint/require-await */
  return { service, active, blocked };
};

describe('one-to-one direct conversations', () => {
  it('creates one deterministic pair under concurrent retries and hides it from outsiders', async () => {
    const { service } = setup();
    const [first, second] = await Promise.all([
      service.start('alice', 'bob'),
      service.start('bob', 'alice'),
    ]);
    expect(second.id).toBe(first.id);
    await expect(service.get(first.id, 'mallory')).rejects.toThrow(
      'direct_unavailable',
    );
  });

  it('provides idempotent messages, replies, stable paging, unread state, and monotonic reads', async () => {
    const { service } = setup();
    const conversation = await service.start('alice', 'bob');
    const first = await service.send({
      conversationId: conversation.id,
      actorId: 'alice',
      body: 'hello',
      idempotencyKey: 'message-key-01',
    });
    expect(
      (
        await service.send({
          conversationId: conversation.id,
          actorId: 'alice',
          body: 'hello',
          idempotencyKey: 'message-key-01',
        })
      ).id,
    ).toBe(first.id);
    const second = await service.send({
      conversationId: conversation.id,
      actorId: 'alice',
      body: 'reply',
      replyToId: first.id,
      attachmentReferenceIds: ['123e4567-e89b-12d3-a456-426614174000'],
      idempotencyKey: 'message-key-02',
    });
    expect(await service.unread(conversation.id, 'bob')).toBe(2);
    await service.markRead(conversation.id, 'bob', second.id);
    await service.markRead(conversation.id, 'bob', first.id);
    expect(await service.unread(conversation.id, 'bob')).toBe(0);
    const page = await service.list(conversation.id, 'bob', { limit: 1 });
    expect(page.items[0]?.id).toBe(first.id);
    if (!page.nextCursor) throw new Error('expected cursor');
    expect(
      (
        await service.list(conversation.id, 'bob', {
          limit: 1,
          cursor: page.nextCursor,
        })
      ).items[0]?.id,
    ).toBe(second.id);
  });

  it('immediately applies blocking, suspension, removal, and deletion tombstones', async () => {
    const { service, active, blocked } = setup();
    const conversation = await service.start('alice', 'bob');
    const message = await service.send({
      conversationId: conversation.id,
      actorId: 'alice',
      body: 'private',
      idempotencyKey: 'message-key-03',
    });
    const deleted = await service.deleteMessage(
      message.id,
      'alice',
      message.version,
    );
    expect(deleted).toMatchObject({ body: null, attachmentReferenceIds: [] });
    blocked.add('alice:bob');
    await expect(
      service.list(conversation.id, 'bob', { limit: 20 }),
    ).rejects.toThrow('direct_unavailable');
    blocked.clear();
    active.delete('alice');
    await expect(
      service.send({
        conversationId: conversation.id,
        actorId: 'bob',
        body: 'no',
        idempotencyKey: 'message-key-04',
      }),
    ).rejects.toThrow('direct_unavailable');
    active.add('alice');
    await service.remove(conversation.id, 'alice');
    await expect(service.get(conversation.id, 'alice')).rejects.toThrow(
      'direct_unavailable',
    );
  });
});
