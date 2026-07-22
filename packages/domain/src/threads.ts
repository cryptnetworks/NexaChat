import { createHash, randomUUID } from 'node:crypto';
export interface ThreadReply {
  id: string;
  rootMessageId: string;
  authorId: string;
  body: string | null;
  sequence: number;
  idempotencyKey: string;
  fingerprint: string;
  eventId: string;
  createdAt: string;
  deletedAt: string | null;
}
export interface MessageThread {
  rootMessageId: string;
  replyCount: number;
  lastSequence: number;
  updatedAt: string;
}
export interface ThreadStore {
  root(
    id: string,
  ): Promise<{ id: string; deletedAt: string | null } | undefined>;
  thread(rootId: string): Promise<MessageThread | undefined>;
  findRetry(
    rootId: string,
    authorId: string,
    key: string,
  ): Promise<ThreadReply | undefined>;
  append(
    reply: ThreadReply,
  ): Promise<{ reply: ThreadReply; thread: MessageThread }>;
  list(
    rootId: string,
    input: { limit: number; after: number },
  ): Promise<ThreadReply[]>;
  readSequence(rootId: string, accountId: string): Promise<number>;
  advanceRead(
    rootId: string,
    accountId: string,
    sequence: number,
  ): Promise<number>;
  transaction<T>(work: (store: ThreadStore) => Promise<T>): Promise<T>;
}
export interface ThreadAuthorization {
  assertRead(actorId: string, rootId: string): Promise<void>;
  assertReply(actorId: string, rootId: string): Promise<void>;
}

export class ThreadService {
  constructor(
    private readonly store: ThreadStore,
    private readonly authorization: ThreadAuthorization,
  ) {}
  async reply(
    rootId: string,
    actorId: string,
    bodyValue: string,
    key: string,
  ): Promise<{ reply: ThreadReply; thread: MessageThread }> {
    const body = bodyValue.trim().normalize('NFC');
    if (!body || body.length > 4000 || !/^[A-Za-z0-9._:-]{8,128}$/.test(key))
      throw new Error('invalid_thread_reply');
    const fingerprint = createHash('sha256').update(body).digest('hex');
    return this.store.transaction(async (store) => {
      await this.authorization.assertReply(actorId, rootId);
      const root = await store.root(rootId);
      if (!root) throw new Error('thread_unavailable');
      const retry = await store.findRetry(rootId, actorId, key);
      if (retry) {
        if (retry.fingerprint !== fingerprint)
          throw new Error('idempotency_conflict');
        const thread = await store.thread(rootId);
        if (!thread) throw new Error('thread_unavailable');
        return { reply: retry, thread };
      }
      const thread = await store.thread(rootId);
      return store.append({
        id: randomUUID(),
        rootMessageId: rootId,
        authorId: actorId,
        body,
        sequence: (thread?.lastSequence ?? 0) + 1,
        idempotencyKey: key,
        fingerprint,
        eventId: randomUUID(),
        createdAt: new Date().toISOString(),
        deletedAt: null,
      });
    });
  }
  async list(
    rootId: string,
    actorId: string,
    limit: number,
    after = 0,
  ): Promise<ThreadReply[]> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(after) ||
      after < 0
    )
      throw new Error('invalid_thread_page');
    await this.authorization.assertRead(actorId, rootId);
    if (!(await this.store.root(rootId))) throw new Error('thread_unavailable');
    return this.store.list(rootId, { limit, after });
  }
  async unread(rootId: string, actorId: string): Promise<number> {
    await this.authorization.assertRead(actorId, rootId);
    const thread = await this.store.thread(rootId);
    return Math.max(
      0,
      (thread?.lastSequence ?? 0) -
        (await this.store.readSequence(rootId, actorId)),
    );
  }
}
