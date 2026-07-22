import { describe, expect, it } from 'vitest';
import { resolveMentions } from '../src/mentions.js';

describe('user and role mentions', () => {
  it('resolves server-side, filters blocks, enforces broad permission and bounds fanout', async () => {
    /* eslint-disable @typescript-eslint/require-await -- adapter parity */
    const directory = {
      visibleUser: async () => true,
      roleMembers: async () => ['u1', 'blocked'],
      mayMentionEveryone: async () => false,
      blocked: async (_a: string, t: string) => t === 'blocked',
    };
    /* eslint-enable @typescript-eslint/require-await */
    const user = '123e4567-e89b-12d3-a456-426614174000';
    const role = '123e4567-e89b-12d3-a456-426614174001';
    const result = await resolveMentions(directory, {
      actorId: 'author',
      spaceId: 's',
      body: `Hi <@${user}> <@&${role}> @everyone`,
    });
    expect(result.recipientIds).toEqual([user, 'u1'].sort());
    expect(result.mentions.some((value) => value.type === 'everyone')).toBe(
      false,
    );
  });
});
