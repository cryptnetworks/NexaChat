export type MessageSearchScope =
  | { type: 'community'; id: string }
  | { type: 'space'; id: string }
  | { type: 'direct'; id: string };

export interface MessageSearchCandidate {
  messageId: string;
  score: number;
  createdAt: string;
}

export interface SearchableMessage {
  id: string;
  scope: MessageSearchScope;
  authorId: string;
  body: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface MessageSearchResult {
  messageId: string;
  scope: MessageSearchScope;
  authorId: string;
  excerpt: string;
  highlights: { start: number; end: number }[];
  createdAt: string;
}

export interface MessageSearchPage {
  items: MessageSearchResult[];
  nextCursor: string | null;
}

export interface MessageSearchStore {
  candidates(input: {
    normalizedQuery: string;
    scope: MessageSearchScope;
    after?: { score: number; createdAt: string; messageId: string };
    limit: number;
  }): Promise<MessageSearchCandidate[]>;
  message(id: string): Promise<SearchableMessage | undefined>;
}

export interface MessageSearchAuthorization {
  assertScope(actorId: string, scope: MessageSearchScope): Promise<void>;
  assertMessage(actorId: string, message: SearchableMessage): Promise<void>;
}

function normalizeQuery(value: string): string {
  const normalized = value
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFKC')
    .toLocaleLowerCase();
  if (
    normalized.length < 2 ||
    normalized.length > 100 ||
    normalized.split(' ').length > 10
  )
    throw new Error('invalid_search_query');
  return normalized;
}

function cursor(value: {
  score: number;
  createdAt: string;
  messageId: string;
}): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function parseCursor(
  value?: string,
): { score: number; createdAt: string; messageId: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString(),
    ) as Record<string, unknown>;
    if (
      typeof parsed.score !== 'number' ||
      !Number.isFinite(parsed.score) ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.messageId !== 'string'
    )
      throw new Error('bad');
    return {
      score: parsed.score,
      createdAt: parsed.createdAt,
      messageId: parsed.messageId,
    };
  } catch {
    throw new Error('invalid_search_cursor');
  }
}

function safeExcerpt(
  body: string,
  query: string,
): Pick<MessageSearchResult, 'excerpt' | 'highlights'> {
  const lower = body.toLocaleLowerCase();
  const terms = [...new Set(query.split(' '))];
  const first = Math.min(
    ...terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0),
  );
  const center = Number.isFinite(first) ? first : 0;
  const start = Math.max(0, center - 80);
  const excerpt = body.slice(start, start + 240);
  const excerptLower = excerpt.toLocaleLowerCase();
  const highlights = terms
    .flatMap((term) => {
      const ranges: { start: number; end: number }[] = [];
      let index = excerptLower.indexOf(term);
      while (index >= 0 && ranges.length < 10) {
        ranges.push({ start: index, end: index + term.length });
        index = excerptLower.indexOf(term, index + term.length);
      }
      return ranges;
    })
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .slice(0, 20);
  return { excerpt, highlights };
}

export class MessageSearchService {
  constructor(
    private readonly store: MessageSearchStore,
    private readonly authorization: MessageSearchAuthorization,
  ) {}

  async search(input: {
    actorId: string;
    query: string;
    scope: MessageSearchScope;
    limit: number;
    cursor?: string;
  }): Promise<MessageSearchPage> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)
      throw new Error('invalid_search_page');
    const query = normalizeQuery(input.query);
    const after = parseCursor(input.cursor);
    await this.safeAuthorizeScope(input.actorId, input.scope);
    const candidates = await this.store.candidates({
      normalizedQuery: query,
      scope: input.scope,
      ...(after ? { after } : {}),
      limit: Math.min(250, input.limit * 5),
    });
    const items: MessageSearchResult[] = [];
    let last: MessageSearchCandidate | undefined;
    for (const candidate of candidates) {
      last = candidate;
      const message = await this.store.message(candidate.messageId);
      if (
        !message ||
        message.deletedAt ||
        !message.body ||
        message.scope.type !== input.scope.type ||
        message.scope.id !== input.scope.id
      )
        continue;
      // The current authoritative body must still match after edits/index lag.
      const normalizedBody = message.body.normalize('NFKC').toLocaleLowerCase();
      if (!query.split(' ').every((term) => normalizedBody.includes(term)))
        continue;
      try {
        await this.authorization.assertMessage(input.actorId, message);
      } catch {
        continue;
      }
      items.push({
        messageId: message.id,
        scope: message.scope,
        authorId: message.authorId,
        ...safeExcerpt(message.body, query),
        createdAt: message.createdAt,
      });
      if (items.length === input.limit) break;
    }
    return {
      items,
      nextCursor:
        candidates.length === Math.min(250, input.limit * 5) && last
          ? cursor(last)
          : null,
    };
  }

  private async safeAuthorizeScope(
    actorId: string,
    scope: MessageSearchScope,
  ): Promise<void> {
    try {
      await this.authorization.assertScope(actorId, scope);
    } catch {
      throw new Error('search_unavailable');
    }
  }
}
