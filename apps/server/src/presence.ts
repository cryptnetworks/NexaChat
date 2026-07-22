import type { EphemeralCoordination } from '@nexa/coordination';
import type { PresenceCoordination, PresenceValue } from '@nexa/domain';

export const PRESENCE_CHANNEL = 'presence:events';
export const MEMBER_STATUS_CHANNEL = 'status:events';

export class CoordinatedPresence implements PresenceCoordination {
  constructor(private readonly coordination: EphemeralCoordination) {}

  async get(accountId: string): Promise<PresenceValue | undefined> {
    try {
      const value = await this.coordination.get(`presence:${accountId}`);
      return value ? parsePresence(value) : undefined;
    } catch {
      // Presence is fail-closed. Dependency loss never fabricates availability.
      return undefined;
    }
  }

  set(value: PresenceValue, ttlSeconds: number): Promise<void> {
    return this.coordination.set(
      `presence:${value.accountId}`,
      JSON.stringify(value),
      ttlSeconds,
    );
  }

  async publish(value: PresenceValue): Promise<void> {
    await this.coordination
      .publish(PRESENCE_CHANNEL, JSON.stringify(value))
      .catch(() => undefined);
  }

  allowUpdate(accountId: string, intervalSeconds: number): Promise<boolean> {
    return this.coordination.setIfAbsent(
      `presence-rate:${accountId}`,
      '1',
      intervalSeconds,
    );
  }
}

export function parsePresence(raw: string): PresenceValue {
  const value = JSON.parse(raw) as Partial<PresenceValue>;
  if (
    typeof value.accountId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(value.accountId) ||
    (value.state !== 'online' && value.state !== 'idle') ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    typeof value.revision !== 'string' ||
    value.revision.length > 128
  )
    throw new Error('invalid_presence_event');
  return value as PresenceValue;
}
