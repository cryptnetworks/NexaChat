import { randomUUID } from 'node:crypto';
export interface SavedMessage {
  id: string;
  accountId: string;
  messageId: string;
  createdAt: string;
}
export interface SavedMessageStore {
  find(accountId: string, messageId: string): Promise<SavedMessage | undefined>;
  create(value: SavedMessage): Promise<SavedMessage>;
  remove(accountId: string, messageId: string): Promise<boolean>;
  list(
    accountId: string,
    input: { limit: number; cursor?: string },
  ): Promise<{ items: SavedMessage[]; nextCursor: string | null }>;
}
export interface SavedMessageAuthorization {
  mayView(accountId: string, messageId: string): Promise<boolean>;
}
export class SavedMessageService {
  constructor(
    private readonly store: SavedMessageStore,
    private readonly authorization: SavedMessageAuthorization,
  ) {}
  async save(
    accountId: string,
    messageId: string,
    now: Date,
  ): Promise<SavedMessage> {
    if (!(await this.authorization.mayView(accountId, messageId)))
      throw new Error('message_unavailable');
    return (
      (await this.store.find(accountId, messageId)) ??
      this.store.create({
        id: randomUUID(),
        accountId,
        messageId,
        createdAt: now.toISOString(),
      })
    );
  }
  remove(accountId: string, messageId: string): Promise<boolean> {
    return this.store.remove(accountId, messageId);
  }
  async list(
    accountId: string,
    input: { limit: number; cursor?: string },
  ): Promise<{
    items: { saved: SavedMessage; available: boolean }[];
    nextCursor: string | null;
  }> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new Error('invalid_saved_page');
    const page = await this.store.list(accountId, input);
    return {
      items: await Promise.all(
        page.items.map(async (saved) => ({
          saved,
          available: await this.authorization.mayView(
            accountId,
            saved.messageId,
          ),
        })),
      ),
      nextCursor: page.nextCursor,
    };
  }
}
