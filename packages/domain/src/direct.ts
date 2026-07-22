import { createHash, randomUUID } from 'node:crypto';

export interface DirectConversation {
  id: string;
  participantLowId: string;
  participantHighId: string;
  createdAt: string;
  createdEventId: string;
  version: number;
}

export interface DirectParticipantState {
  conversationId: string;
  accountId: string;
  lastReadSequence: number;
  removedAt: string | null;
  version: number;
}

export interface DirectMessage {
  id: string;
  conversationId: string;
  authorId: string;
  body: string | null;
  attachmentReferenceIds: string[];
  replyToId: string | null;
  sequence: number;
  idempotencyKey: string;
  requestFingerprint: string;
  createdEventId: string;
  createdAt: string;
  deletedAt: string | null;
  version: number;
}

export interface DirectPage {
  items: DirectMessage[];
  nextCursor: string | null;
}

export interface DirectStore {
  findConversation(id: string): Promise<DirectConversation | undefined>;
  findConversationByPair(
    lowId: string,
    highId: string,
  ): Promise<DirectConversation | undefined>;
  createConversation(
    conversation: DirectConversation,
    participants: readonly DirectParticipantState[],
  ): Promise<DirectConversation>;
  findParticipant(
    conversationId: string,
    accountId: string,
  ): Promise<DirectParticipantState | undefined>;
  updateParticipant(
    conversationId: string,
    accountId: string,
    expectedVersion: number,
    patch: Partial<DirectParticipantState>,
  ): Promise<DirectParticipantState | undefined>;
  createMessage(message: DirectMessage): Promise<DirectMessage>;
  findMessage(id: string): Promise<DirectMessage | undefined>;
  findMessageByIdempotencyKey(
    conversationId: string,
    authorId: string,
    key: string,
  ): Promise<DirectMessage | undefined>;
  nextSequence(conversationId: string): Promise<number>;
  listMessages(
    conversationId: string,
    input: { limit: number; cursor?: string },
  ): Promise<DirectPage>;
  tombstoneMessage(
    id: string,
    expectedVersion: number,
    deletedAt: string,
  ): Promise<DirectMessage | undefined>;
  countUnread(
    conversationId: string,
    actorId: string,
    afterSequence: number,
  ): Promise<number>;
  transaction<T>(work: (store: DirectStore) => Promise<T>): Promise<T>;
}

export interface DirectAuthorization {
  assertAccountActive(accountId: string): Promise<void>;
  assertDirectAllowed(actorId: string, otherId: string): Promise<void>;
}

function pair(left: string, right: string): [string, string] {
  if (!left || !right || left === right) throw new Error('direct_unavailable');
  return left.localeCompare(right) < 0 ? [left, right] : [right, left];
}

function directBody(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n').normalize('NFC').trim();
  if (!normalized || normalized.length > 4000)
    throw new Error('invalid_direct_message');
  return normalized;
}

function directKey(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(normalized))
    throw new Error('invalid_idempotency_key');
  return normalized;
}

function attachments(values: readonly string[]): string[] {
  if (
    values.length > 10 ||
    new Set(values).size !== values.length ||
    values.some((value) => !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value))
  )
    throw new Error('invalid_direct_attachments');
  return [...values];
}

export class DirectConversationService {
  constructor(
    private readonly store: DirectStore,
    private readonly authorization: DirectAuthorization,
  ) {}

  async start(actorId: string, otherId: string): Promise<DirectConversation> {
    const [low, high] = pair(actorId, otherId);
    await this.authorizePair(actorId, otherId);
    return this.store.transaction(async (store) => {
      await this.authorizePair(actorId, otherId);
      const existing = await store.findConversationByPair(low, high);
      if (existing) return existing;
      const createdAt = new Date().toISOString();
      const conversation: DirectConversation = {
        id: randomUUID(),
        participantLowId: low,
        participantHighId: high,
        createdAt,
        createdEventId: randomUUID(),
        version: 1,
      };
      return store.createConversation(
        conversation,
        [low, high].map((accountId) => ({
          conversationId: conversation.id,
          accountId,
          lastReadSequence: 0,
          removedAt: null,
          version: 1,
        })),
      );
    });
  }

  async get(
    conversationId: string,
    actorId: string,
  ): Promise<DirectConversation> {
    const conversation = await this.store.findConversation(conversationId);
    await this.authorizeConversation(conversation, actorId);
    return conversation as DirectConversation;
  }

  async send(input: {
    conversationId: string;
    actorId: string;
    body: string;
    attachmentReferenceIds?: readonly string[];
    replyToId?: string | null;
    idempotencyKey: string;
  }): Promise<DirectMessage> {
    const body = directBody(input.body);
    const refs = attachments(input.attachmentReferenceIds ?? []);
    const key = directKey(input.idempotencyKey);
    const replyToId = input.replyToId ?? null;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ body, refs, replyToId }))
      .digest('hex');
    return this.store.transaction(async (store) => {
      const conversation = await store.findConversation(input.conversationId);
      await this.authorizeConversation(conversation, input.actorId, store);
      const retried = await store.findMessageByIdempotencyKey(
        input.conversationId,
        input.actorId,
        key,
      );
      if (retried) {
        if (retried.requestFingerprint !== fingerprint)
          throw new Error('idempotency_conflict');
        return retried;
      }
      if (replyToId) {
        const reply = await store.findMessage(replyToId);
        if (!reply || reply.conversationId !== input.conversationId)
          throw new Error('direct_unavailable');
      }
      const createdAt = new Date().toISOString();
      return store.createMessage({
        id: randomUUID(),
        conversationId: input.conversationId,
        authorId: input.actorId,
        body,
        attachmentReferenceIds: refs,
        replyToId,
        sequence: await store.nextSequence(input.conversationId),
        idempotencyKey: key,
        requestFingerprint: fingerprint,
        createdEventId: randomUUID(),
        createdAt,
        deletedAt: null,
        version: 1,
      });
    });
  }

  async list(
    conversationId: string,
    actorId: string,
    input: { limit: number; cursor?: string },
  ): Promise<DirectPage> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new Error('invalid_direct_page');
    const conversation = await this.store.findConversation(conversationId);
    await this.authorizeConversation(conversation, actorId);
    return this.store.listMessages(conversationId, input);
  }

  async unread(conversationId: string, actorId: string): Promise<number> {
    const conversation = await this.store.findConversation(conversationId);
    await this.authorizeConversation(conversation, actorId);
    const state = await this.store.findParticipant(conversationId, actorId);
    if (!state) throw new Error('direct_unavailable');
    return this.store.countUnread(
      conversationId,
      actorId,
      state.lastReadSequence,
    );
  }

  async markRead(
    conversationId: string,
    actorId: string,
    messageId: string,
  ): Promise<DirectParticipantState> {
    return this.store.transaction(async (store) => {
      const conversation = await store.findConversation(conversationId);
      await this.authorizeConversation(conversation, actorId, store);
      const message = await store.findMessage(messageId);
      const state = await store.findParticipant(conversationId, actorId);
      if (!message || message.conversationId !== conversationId || !state)
        throw new Error('direct_unavailable');
      if (message.sequence <= state.lastReadSequence) return state;
      const updated = await store.updateParticipant(
        conversationId,
        actorId,
        state.version,
        { lastReadSequence: message.sequence },
      );
      if (!updated) throw new Error('stale_direct_state');
      return updated;
    });
  }

  async remove(
    conversationId: string,
    actorId: string,
  ): Promise<DirectParticipantState> {
    return this.store.transaction(async (store) => {
      const conversation = await store.findConversation(conversationId);
      await this.authorizeConversation(conversation, actorId, store);
      const state = await store.findParticipant(conversationId, actorId);
      if (!state) throw new Error('direct_unavailable');
      if (state.removedAt) return state;
      const updated = await store.updateParticipant(
        conversationId,
        actorId,
        state.version,
        { removedAt: new Date().toISOString() },
      );
      if (!updated) throw new Error('stale_direct_state');
      return updated;
    });
  }

  async deleteMessage(
    messageId: string,
    actorId: string,
    expectedVersion: number,
  ): Promise<DirectMessage> {
    return this.store.transaction(async (store) => {
      const message = await store.findMessage(messageId);
      if (!message || message.authorId !== actorId)
        throw new Error('direct_unavailable');
      const conversation = await store.findConversation(message.conversationId);
      await this.authorizeConversation(conversation, actorId, store);
      if (message.deletedAt) return message;
      const deleted = await store.tombstoneMessage(
        message.id,
        expectedVersion,
        new Date().toISOString(),
      );
      if (!deleted) throw new Error('stale_direct_state');
      return deleted;
    });
  }

  private async authorizePair(actorId: string, otherId: string): Promise<void> {
    try {
      await this.authorization.assertAccountActive(actorId);
      await this.authorization.assertAccountActive(otherId);
      await this.authorization.assertDirectAllowed(actorId, otherId);
    } catch {
      throw new Error('direct_unavailable');
    }
  }

  private async authorizeConversation(
    conversation: DirectConversation | undefined,
    actorId: string,
    store: DirectStore = this.store,
  ): Promise<void> {
    if (!conversation) throw new Error('direct_unavailable');
    const otherId =
      conversation.participantLowId === actorId
        ? conversation.participantHighId
        : conversation.participantHighId === actorId
          ? conversation.participantLowId
          : null;
    if (!otherId) throw new Error('direct_unavailable');
    const state = await store.findParticipant(conversation.id, actorId);
    if (!state || state.removedAt) throw new Error('direct_unavailable');
    await this.authorizePair(actorId, otherId);
  }
}

export class InMemoryDirectStore implements DirectStore {
  private conversations = new Map<string, DirectConversation>();
  private participants = new Map<string, DirectParticipantState>();
  private messages = new Map<string, DirectMessage>();
  private queue: Promise<void> = Promise.resolve();
  /* eslint-disable @typescript-eslint/require-await -- storage-port parity */
  findConversation = async (id: string) => this.conversations.get(id);
  findConversationByPair = async (low: string, high: string) =>
    [...this.conversations.values()].find(
      (value) =>
        value.participantLowId === low && value.participantHighId === high,
    );
  createConversation = async (
    value: DirectConversation,
    participants: readonly DirectParticipantState[],
  ) => {
    const existing = await this.findConversationByPair(
      value.participantLowId,
      value.participantHighId,
    );
    if (existing) return existing;
    this.conversations.set(value.id, value);
    for (const participant of participants)
      this.participants.set(
        `${value.id}:${participant.accountId}`,
        participant,
      );
    return value;
  };
  findParticipant = async (conversationId: string, accountId: string) =>
    this.participants.get(`${conversationId}:${accountId}`);
  updateParticipant = async (
    conversationId: string,
    accountId: string,
    version: number,
    patch: Partial<DirectParticipantState>,
  ) => {
    const key = `${conversationId}:${accountId}`;
    const current = this.participants.get(key);
    if (!current || current.version !== version) return undefined;
    const next = { ...current, ...patch, version: version + 1 };
    this.participants.set(key, next);
    return next;
  };
  createMessage = async (value: DirectMessage) => {
    const existing = await this.findMessageByIdempotencyKey(
      value.conversationId,
      value.authorId,
      value.idempotencyKey,
    );
    if (existing) return existing;
    this.messages.set(value.id, value);
    return value;
  };
  findMessage = async (id: string) => this.messages.get(id);
  findMessageByIdempotencyKey = async (
    conversationId: string,
    authorId: string,
    key: string,
  ) =>
    [...this.messages.values()].find(
      (value) =>
        value.conversationId === conversationId &&
        value.authorId === authorId &&
        value.idempotencyKey === key,
    );
  nextSequence = async (conversationId: string) =>
    Math.max(
      0,
      ...[...this.messages.values()]
        .filter((value) => value.conversationId === conversationId)
        .map((value) => value.sequence),
    ) + 1;
  listMessages = async (
    conversationId: string,
    input: { limit: number; cursor?: string },
  ) => {
    const after = input.cursor
      ? Number(Buffer.from(input.cursor, 'base64url').toString())
      : 0;
    const values = [...this.messages.values()]
      .filter(
        (value) =>
          value.conversationId === conversationId && value.sequence > after,
      )
      .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    const items = values.slice(0, input.limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        values.length > input.limit && last
          ? Buffer.from(String(last.sequence)).toString('base64url')
          : null,
    };
  };
  tombstoneMessage = async (id: string, version: number, deletedAt: string) => {
    const current = this.messages.get(id);
    if (!current || current.version !== version) return undefined;
    const next = {
      ...current,
      body: null,
      attachmentReferenceIds: [],
      deletedAt: current.deletedAt ?? deletedAt,
      version: version + 1,
    };
    this.messages.set(id, next);
    return next;
  };
  countUnread = async (
    conversationId: string,
    actorId: string,
    afterSequence: number,
  ) =>
    [...this.messages.values()].filter(
      (value) =>
        value.conversationId === conversationId &&
        value.authorId !== actorId &&
        value.sequence > afterSequence,
    ).length;
  /* eslint-enable @typescript-eslint/require-await */
  async transaction<T>(work: (store: DirectStore) => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release = () => {};
    this.queue = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await work(this);
    } finally {
      release();
    }
  }
}
