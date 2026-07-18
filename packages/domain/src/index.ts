import { createHash, randomUUID } from 'node:crypto';

export interface Account {
  id: string;
  displayName: string;
}

export interface Community {
  id: string;
  name: string;
  ownerId: string;
}

export interface Membership {
  id: string;
  communityId: string;
  accountId: string;
  status: 'active' | 'invited' | 'left' | 'removed' | 'suspended';
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: string;
  communityId: string;
  name: string;
  position: number;
  archivedAt: string | null;
}

export interface Space {
  id: string;
  communityId: string;
  categoryId: string | null;
  name: string;
  kind: 'text';
  position: number;
  archivedAt: string | null;
}

export interface Message {
  id: string;
  spaceId: string;
  authorId: string;
  body: string;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  accountId: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface Persistence {
  accounts: {
    create(account: Account): Promise<Account>;
    findById(id: string): Promise<Account | undefined>;
  };
  communities: {
    create(community: Community): Promise<Community>;
    findById(id: string): Promise<Community | undefined>;
  };
  memberships: {
    create(membership: Membership): Promise<Membership>;
    findByCommunityAndAccount(
      communityId: string,
      accountId: string,
    ): Promise<Membership | undefined>;
  };
  categories: {
    create(category: Category): Promise<Category>;
    findById(id: string): Promise<Category | undefined>;
    rename(id: string, name: string): Promise<Category | undefined>;
    remove(id: string): Promise<boolean>;
  };
  spaces: {
    create(space: Space): Promise<Space>;
    findById(id: string): Promise<Space | undefined>;
    rename(id: string, name: string): Promise<Space | undefined>;
    remove(id: string): Promise<boolean>;
  };
  messages: {
    create(message: Message): Promise<Message>;
    findById(id: string): Promise<Message | undefined>;
    remove(id: string): Promise<boolean>;
  };
  sessions: {
    create(session: SessionRecord): Promise<SessionRecord>;
    findByTokenHash(tokenHash: string): Promise<SessionRecord | undefined>;
    revoke(id: string, revokedAt: string): Promise<boolean>;
  };
  transaction<T>(work: (persistence: Persistence) => Promise<T>): Promise<T>;
}

export class DomainError extends Error {
  constructor(public readonly code: 'not_found' | 'forbidden') {
    super(code);
  }
}

export interface AuthorizationGateway {
  enforce(
    actorId: string,
    permission: 'space.manage' | 'message.create' | 'space.view',
    scopes: readonly { type: 'community' | 'category' | 'space'; id: string }[],
  ): Promise<unknown>;
}

export class CommunityService {
  constructor(
    public readonly persistence: Persistence,
    private readonly authorization?: AuthorizationGateway,
  ) {}

  createAccount(displayName: string): Promise<Account> {
    return this.persistence.accounts.create({ id: randomUUID(), displayName });
  }

  async createCommunity(ownerId: string, name: string): Promise<Community> {
    if (!(await this.persistence.accounts.findById(ownerId)))
      throw new DomainError('not_found');
    return this.persistence.transaction(async (persistence) => {
      const community = await persistence.communities.create({
        id: randomUUID(),
        ownerId,
        name,
      });
      const now = new Date().toISOString();
      await persistence.memberships.create({
        id: randomUUID(),
        communityId: community.id,
        accountId: ownerId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      return community;
    });
  }

  async createTextSpace(
    communityId: string,
    actorId: string,
    name: string,
  ): Promise<Space> {
    const community = await this.persistence.communities.findById(communityId);
    if (!community) throw new DomainError('not_found');
    if (this.authorization)
      await this.authorization.enforce(actorId, 'space.manage', [
        { type: 'community', id: communityId },
      ]);
    else if (community.ownerId !== actorId) throw new DomainError('forbidden');
    return this.persistence.spaces.create({
      id: randomUUID(),
      communityId,
      categoryId: null,
      name,
      kind: 'text',
      position: 0,
      archivedAt: null,
    });
  }

  async postMessage(
    spaceId: string,
    authorId: string,
    body: string,
  ): Promise<Message> {
    const space = await this.persistence.spaces.findById(spaceId);
    if (!space || !(await this.persistence.accounts.findById(authorId)))
      throw new DomainError('not_found');
    if (this.authorization)
      await this.authorization.enforce(authorId, 'message.create', [
        { type: 'community', id: space.communityId },
        ...(space.categoryId
          ? [{ type: 'category' as const, id: space.categoryId }]
          : []),
        { type: 'space', id: space.id },
      ]);
    return this.persistence.messages.create({
      id: randomUUID(),
      spaceId,
      authorId,
      body,
      createdAt: new Date().toISOString(),
    });
  }

  async authorizeSpaceSubscription(
    spaceId: string,
    actorId: string,
  ): Promise<void> {
    const space = await this.persistence.spaces.findById(spaceId);
    if (!space || !(await this.persistence.accounts.findById(actorId)))
      throw new DomainError('not_found');
    const community = await this.persistence.communities.findById(
      space.communityId,
    );
    if (!community) throw new DomainError('not_found');
    if (this.authorization)
      await this.authorization.enforce(actorId, 'space.view', [
        { type: 'community', id: community.id },
        ...(space.categoryId
          ? [{ type: 'category' as const, id: space.categoryId }]
          : []),
        { type: 'space', id: space.id },
      ]);
    else if (community.ownerId !== actorId) throw new DomainError('forbidden');
  }
}

type MemoryState = {
  accounts: Map<string, Account>;
  communities: Map<string, Community>;
  memberships: Map<string, Membership>;
  categories: Map<string, Category>;
  spaces: Map<string, Space>;
  messages: Map<string, Message>;
  sessions: Map<string, SessionRecord>;
};

function copyState(state: MemoryState): MemoryState {
  return {
    accounts: new Map(state.accounts),
    communities: new Map(state.communities),
    memberships: new Map(state.memberships),
    categories: new Map(state.categories),
    spaces: new Map(state.spaces),
    messages: new Map(state.messages),
    sessions: new Map(state.sessions),
  };
}

export class InMemoryPersistence implements Persistence {
  private state: MemoryState = {
    accounts: new Map(),
    communities: new Map(),
    memberships: new Map(),
    categories: new Map(),
    spaces: new Map(),
    messages: new Map(),
    sessions: new Map(),
  };

  /* eslint-disable @typescript-eslint/require-await -- async parity with storage ports */
  readonly accounts = {
    create: async (account: Account) => {
      this.state.accounts.set(account.id, account);
      return account;
    },
    findById: async (id: string) => this.state.accounts.get(id),
  };

  readonly communities = {
    create: async (community: Community) => {
      this.state.communities.set(community.id, community);
      return community;
    },
    findById: async (id: string) => this.state.communities.get(id),
  };

  readonly memberships = {
    create: async (membership: Membership) => {
      this.state.memberships.set(membership.id, membership);
      return membership;
    },
    findByCommunityAndAccount: async (communityId: string, accountId: string) =>
      [...this.state.memberships.values()].find(
        (membership) =>
          membership.communityId === communityId &&
          membership.accountId === accountId,
      ),
  };

  readonly categories = {
    create: async (category: Category) => {
      this.state.categories.set(category.id, category);
      return category;
    },
    findById: async (id: string) => this.state.categories.get(id),
    rename: async (id: string, name: string) => {
      const category = this.state.categories.get(id);
      if (!category) return undefined;
      const renamed = { ...category, name };
      this.state.categories.set(id, renamed);
      return renamed;
    },
    remove: async (id: string) => this.state.categories.delete(id),
  };

  readonly spaces = {
    create: async (space: Space) => {
      this.state.spaces.set(space.id, space);
      return space;
    },
    findById: async (id: string) => this.state.spaces.get(id),
    rename: async (id: string, name: string) => {
      const space = this.state.spaces.get(id);
      if (!space) return undefined;
      const renamed = { ...space, name };
      this.state.spaces.set(id, renamed);
      return renamed;
    },
    remove: async (id: string) => this.state.spaces.delete(id),
  };

  readonly messages = {
    create: async (message: Message) => {
      this.state.messages.set(message.id, message);
      return message;
    },
    findById: async (id: string) => this.state.messages.get(id),
    remove: async (id: string) => this.state.messages.delete(id),
  };

  readonly sessions = {
    create: async (session: SessionRecord) => {
      this.state.sessions.set(session.id, session);
      return session;
    },
    findByTokenHash: async (tokenHash: string) =>
      [...this.state.sessions.values()].find(
        (session) => session.tokenHash === tokenHash,
      ),
    revoke: async (id: string, revokedAt: string) => {
      const session = this.state.sessions.get(id);
      if (!session) return false;
      this.state.sessions.set(id, { ...session, revokedAt });
      return true;
    },
  };
  /* eslint-enable @typescript-eslint/require-await */

  async transaction<T>(
    work: (persistence: Persistence) => Promise<T>,
  ): Promise<T> {
    const snapshot = copyState(this.state);
    try {
      return await work(this);
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }
}

export class InMemoryCommunityService extends CommunityService {
  constructor(persistence = new InMemoryPersistence()) {
    super(persistence);
  }
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
