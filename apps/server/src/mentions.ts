import type { Pool, PoolClient } from 'pg';
import type { AuthorizationService } from '@nexa/authorization';
import {
  resolveMentions,
  type MentionDirectory,
  type Message,
  type NotificationService,
} from '@nexa/domain';

export class MentionRuntime {
  constructor(
    private readonly pool: Pool,
    private readonly authorization: AuthorizationService,
    private readonly notifications: NotificationService,
  ) {}

  async process(message: Message): Promise<void> {
    const client = await this.pool.connect();
    let recipients: string[];
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const context = await client.query<{ community_id: string }>(
        `SELECT s.community_id FROM messages m JOIN spaces s ON s.id=m.space_id
         JOIN memberships member ON member.community_id=s.community_id
           AND member.account_id=m.author_id AND member.status='active'
         WHERE m.id=$1 AND m.author_id=$2 AND m.deleted_at IS NULL
           AND s.archived_at IS NULL FOR UPDATE OF m`,
        [message.id, message.authorId],
      );
      const communityId = context.rows[0]?.community_id;
      if (!communityId) throw new Error('mention_message_not_found');
      const resolved = await resolveMentions(
        this.directory(client, communityId),
        {
          actorId: message.authorId,
          spaceId: message.spaceId,
          body: message.body ?? '',
        },
      );
      for (const mention of resolved.mentions)
        await client.query(
          `INSERT INTO message_mentions
           (message_id,mention_type,target_id,created_at)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [message.id, mention.type, mention.targetId, message.createdAt],
        );
      recipients = resolved.recipientIds;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    for (const accountId of recipients)
      await this.notifications.create({
        accountId,
        actorId: message.authorId,
        kind: 'mention',
        scopeId: message.spaceId,
        resourceId: message.id,
        aggregationKey: message.spaceId,
        eventId: message.createdEventId,
        now: new Date(message.createdAt),
      });
  }

  private directory(client: PoolClient, communityId: string): MentionDirectory {
    const activeMembers = async (spaceId: string, limit: number) => {
      const result = await client.query<{ account_id: string }>(
        `SELECT m.account_id FROM memberships m JOIN spaces s
           ON s.community_id=m.community_id
         WHERE s.id=$1 AND s.archived_at IS NULL AND m.status='active'
         ORDER BY m.account_id LIMIT $2`,
        [spaceId, limit],
      );
      return result.rows.map((row) => row.account_id);
    };
    return {
      visibleUser: async (_actorId, spaceId, accountId) =>
        (await activeMembers(spaceId, 101)).includes(accountId),
      roleMembers: async (_actorId, spaceId, roleId, limit) => {
        const result = await client.query<{ account_id: string }>(
          `SELECT a.actor_id AS account_id FROM authorization_role_assignments a
           JOIN authorization_roles r ON r.id=a.role_id
           JOIN memberships m ON m.account_id=a.actor_id
             AND m.community_id=r.community_id AND m.status='active'
           JOIN spaces s ON s.community_id=r.community_id
           WHERE s.id=$1 AND a.role_id=$2 ORDER BY a.actor_id LIMIT $3`,
          [spaceId, roleId, limit],
        );
        return result.rows.map((row) => row.account_id);
      },
      mayMentionEveryone: async (actorId, spaceId) =>
        (
          await this.authorization.preview(actorId, 'message.manage', [
            { type: 'community', id: communityId },
            { type: 'space', id: spaceId },
          ])
        ).allowed,
      spaceMembers: (_actorId, spaceId, limit) => activeMembers(spaceId, limit),
      blocked: async (actorId, targetId) => {
        const result = await client.query(
          `SELECT 1 FROM account_blocks WHERE
           (blocker_id=$1 AND blocked_id=$2) OR
           (blocker_id=$2 AND blocked_id=$1) LIMIT 1`,
          [actorId, targetId],
        );
        return result.rows.length > 0;
      },
    };
  }
}
