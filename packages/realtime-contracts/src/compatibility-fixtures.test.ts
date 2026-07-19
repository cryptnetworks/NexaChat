import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createMessageSchema,
  createdInvitationSchema,
  errorResponseSchema,
  messageSchema,
  pageQuerySchema,
  registrationSchema,
  websocketClientMessageSchema,
  websocketServerMessageSchema,
} from '@nexa/api-contracts';
import { realtimeDeliverySchema } from './index.js';

interface FixtureFile {
  version: number;
  valid: Record<string, unknown>;
  invalid: Record<string, unknown>;
}

describe('committed version-1 compatibility fixtures', () => {
  it('continues accepting every published HTTP fixture', async () => {
    const fixtures = await fixture('http.json');
    const schemas = {
      registration: registrationSchema,
      pageQuery: pageQuerySchema,
      createMessage: createMessageSchema,
      message: messageSchema,
      createdInvitation: createdInvitationSchema,
      error: errorResponseSchema,
    };
    expect(fixtures.version).toBe(1);
    for (const [name, schema] of Object.entries(schemas)) {
      expect(schema.safeParse(fixtures.valid[name]).success, name).toBe(true);
      expect(schema.safeParse(fixtures.invalid[name]).success, name).toBe(
        false,
      );
    }
  });

  it('continues accepting every published realtime fixture', async () => {
    const fixtures = await fixture('realtime.json');
    const schemas = {
      client: websocketClientMessageSchema,
      server: websocketServerMessageSchema,
      delivery: realtimeDeliverySchema,
    };
    expect(fixtures.version).toBe(1);
    for (const [name, schema] of Object.entries(schemas)) {
      expect(schema.safeParse(fixtures.valid[name]).success, name).toBe(true);
      expect(schema.safeParse(fixtures.invalid[name]).success, name).toBe(
        false,
      );
    }
  });
});

async function fixture(name: string): Promise<FixtureFile> {
  return JSON.parse(
    await readFile(resolve('contracts/v1', name), 'utf8'),
  ) as FixtureFile;
}
