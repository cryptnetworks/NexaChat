export type PresenceState = 'online' | 'idle' | 'offline';
export interface PresenceValue {
  accountId: string;
  state: Exclude<PresenceState, 'offline'>;
  expiresAt: string;
  revision: string;
}
export interface PresenceCoordination {
  get(accountId: string): Promise<PresenceValue | undefined>;
  set(value: PresenceValue, ttlSeconds: number): Promise<void>;
  publish(value: PresenceValue): Promise<void>;
  allowUpdate(accountId: string, intervalSeconds: number): Promise<boolean>;
}
export interface PresenceVisibility {
  mayView(viewerId: string, accountId: string): Promise<boolean>;
}

export class PresenceService {
  constructor(
    private readonly coordination: PresenceCoordination,
    private readonly visibility: PresenceVisibility,
  ) {}
  async heartbeat(
    accountId: string,
    available: boolean,
    now: Date,
  ): Promise<PresenceValue> {
    if (!(await this.coordination.allowUpdate(accountId, 15)))
      throw new Error('presence_rate_limited');
    // Presence is intentionally coarse: window focus, routes, and precise last
    // activity are never accepted or stored.
    const value: PresenceValue = {
      accountId,
      state: available ? 'online' : 'idle',
      expiresAt: new Date(now.getTime() + 90_000).toISOString(),
      revision: `${String(now.getTime())}:${accountId}`,
    };
    await this.coordination.set(value, 90);
    await this.coordination.publish(value);
    return value;
  }
  async view(
    viewerId: string,
    accountId: string,
    now: Date,
  ): Promise<PresenceState> {
    if (!(await this.visibility.mayView(viewerId, accountId))) return 'offline';
    const value = await this.coordination.get(accountId);
    return value && now < new Date(value.expiresAt) ? value.state : 'offline';
  }
}
