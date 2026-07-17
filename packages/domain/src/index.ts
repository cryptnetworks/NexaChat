import { randomUUID } from 'node:crypto';

export interface Account {
  id: string;
  displayName: string;
}
export interface Community {
  id: string;
  name: string;
  ownerId: string;
}
export interface Space {
  id: string;
  communityId: string;
  name: string;
  kind: 'text';
}
export interface Message {
  id: string;
  spaceId: string;
  authorId: string;
  body: string;
  createdAt: string;
}

export class DomainError extends Error {
  constructor(public readonly code: 'not_found' | 'forbidden') {
    super(code);
  }
}

export class InMemoryCommunityService {
  readonly accounts = new Map<string, Account>();
  readonly communities = new Map<string, Community>();
  readonly spaces = new Map<string, Space>();
  readonly messages = new Map<string, Message[]>();

  createAccount(displayName: string): Account {
    const account = { id: randomUUID(), displayName };
    this.accounts.set(account.id, account);
    return account;
  }

  createCommunity(ownerId: string, name: string): Community {
    if (!this.accounts.has(ownerId)) throw new DomainError('not_found');
    const community = { id: randomUUID(), ownerId, name };
    this.communities.set(community.id, community);
    return community;
  }

  createTextSpace(communityId: string, actorId: string, name: string): Space {
    const community = this.communities.get(communityId);
    if (!community) throw new DomainError('not_found');
    if (community.ownerId !== actorId) throw new DomainError('forbidden');
    const space = {
      id: randomUUID(),
      communityId,
      name,
      kind: 'text' as const,
    };
    this.spaces.set(space.id, space);
    return space;
  }

  postMessage(spaceId: string, authorId: string, body: string): Message {
    if (!this.spaces.has(spaceId) || !this.accounts.has(authorId))
      throw new DomainError('not_found');
    const message = {
      id: randomUUID(),
      spaceId,
      authorId,
      body,
      createdAt: new Date().toISOString(),
    };
    this.messages.set(spaceId, [
      ...(this.messages.get(spaceId) ?? []),
      message,
    ]);
    return message;
  }
}
