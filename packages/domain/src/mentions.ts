export interface ResolvedMention {
  type: 'user' | 'role' | 'everyone';
  targetId: string;
  accountIds: string[];
}
export interface MentionDirectory {
  visibleUser(
    actorId: string,
    spaceId: string,
    accountId: string,
  ): Promise<boolean>;
  roleMembers(
    actorId: string,
    spaceId: string,
    roleId: string,
    limit: number,
  ): Promise<string[]>;
  mayMentionEveryone(actorId: string, spaceId: string): Promise<boolean>;
  spaceMembers(
    actorId: string,
    spaceId: string,
    limit: number,
  ): Promise<string[]>;
  blocked(actorId: string, targetId: string): Promise<boolean>;
}

export async function resolveMentions(
  directory: MentionDirectory,
  input: { actorId: string; spaceId: string; body: string },
): Promise<{ mentions: ResolvedMention[]; recipientIds: string[] }> {
  const tokens = [
    ...input.body.matchAll(
      /<@([0-9a-f-]{36})>|<@&([0-9a-f-]{36})>|@everyone/gi,
    ),
  ].slice(0, 100);
  const mentions: ResolvedMention[] = [];
  const recipients = new Set<string>();
  for (const token of tokens) {
    if (token[0].toLowerCase() === '@everyone') {
      if (!(await directory.mayMentionEveryone(input.actorId, input.spaceId)))
        continue;
      const members = (
        await directory.spaceMembers(input.actorId, input.spaceId, 101)
      ).filter((id) => id !== input.actorId);
      if (members.length > 100) throw new Error('mention_fanout_exceeded');
      const allowed: string[] = [];
      for (const id of members)
        if (!(await directory.blocked(input.actorId, id))) {
          recipients.add(id);
          allowed.push(id);
        }
      mentions.push({
        type: 'everyone',
        targetId: input.spaceId,
        accountIds: allowed,
      });
      continue;
    }
    if (token[1]) {
      if (
        !(await directory.visibleUser(
          input.actorId,
          input.spaceId,
          token[1],
        )) ||
        (await directory.blocked(input.actorId, token[1]))
      )
        continue;
      mentions.push({
        type: 'user',
        targetId: token[1],
        accountIds: [token[1]],
      });
      recipients.add(token[1]);
    } else if (token[2]) {
      const members = (
        await directory.roleMembers(input.actorId, input.spaceId, token[2], 101)
      ).filter((id) => id !== input.actorId);
      if (members.length > 100) throw new Error('mention_fanout_exceeded');
      const allowed: string[] = [];
      for (const id of members)
        if (!(await directory.blocked(input.actorId, id))) {
          recipients.add(id);
          allowed.push(id);
        }
      mentions.push({ type: 'role', targetId: token[2], accountIds: allowed });
    }
    if (recipients.size > 100) throw new Error('mention_fanout_exceeded');
  }
  return { mentions, recipientIds: [...recipients].sort() };
}
