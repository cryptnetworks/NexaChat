export interface MemberStatus {
  accountId: string;
  text: string | null;
  expiresAt: string | null;
  updatedAt: string;
  version: number;
}
export interface MemberStatusStore {
  find(accountId: string): Promise<MemberStatus | undefined>;
  save(
    value: MemberStatus,
    expectedVersion?: number,
  ): Promise<MemberStatus | undefined>;
}
export interface MemberStatusVisibility {
  mayView(viewerId: string, accountId: string): Promise<boolean>;
}

const normalize = (value: string): string => {
  const text = value.trim().replace(/\s+/g, ' ').normalize('NFC');
  if (
    !text ||
    text.length > 160 ||
    Array.from(text).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  )
    throw new Error('invalid_member_status');
  return text;
};

export class MemberStatusService {
  constructor(
    private readonly store: MemberStatusStore,
    private readonly visibility: MemberStatusVisibility,
  ) {}
  async update(
    accountId: string,
    text: string | null,
    expiresAt: string | null,
    expectedVersion: number | undefined,
    now: Date,
  ): Promise<MemberStatus> {
    if (
      expiresAt &&
      (new Date(expiresAt) <= now ||
        new Date(expiresAt).getTime() > now.getTime() + 30 * 86_400_000)
    )
      throw new Error('invalid_member_status');
    const current = await this.store.find(accountId);
    const saved = await this.store.save(
      {
        accountId,
        text: text === null ? null : normalize(text),
        expiresAt,
        updatedAt: now.toISOString(),
        version: current ? current.version + 1 : 1,
      },
      expectedVersion,
    );
    if (!saved) throw new Error('stale_member_status');
    return saved;
  }
  async view(
    viewerId: string,
    accountId: string,
    now: Date,
  ): Promise<MemberStatus | null> {
    if (!(await this.visibility.mayView(viewerId, accountId))) return null;
    const value = await this.store.find(accountId);
    return value &&
      value.text &&
      (!value.expiresAt || now < new Date(value.expiresAt))
      ? value
      : null;
  }
}
