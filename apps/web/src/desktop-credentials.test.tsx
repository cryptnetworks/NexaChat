import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DesktopCredentialControls } from './desktop-credential-controls.js';
import {
  DesktopCredentialError,
  createDesktopCredentialClient,
  type StoredDesktopAccount,
} from './desktop-credentials.js';

const account: StoredDesktopAccount = {
  serverOrigin: 'https://chat.example.test',
  accountId: '11111111-1111-4111-8111-111111111111',
  accountLabel: 'Aster',
  expiresAt: '2026-08-01T00:00:00Z',
  selected: true,
};

describe('desktop credential bridge', () => {
  it('is unavailable in a browser and validates bounded native responses', async () => {
    expect(createDesktopCredentialClient(vi.fn(), false)).toBeUndefined();
    const invoke = vi.fn((command: string) => {
      if (command === 'credential_store_status')
        return Promise.resolve({
          state: 'available',
          accountCount: 1,
          maxAccounts: 20,
          recoveredSelection: false,
        });
      return Promise.resolve({
        accounts: [account],
        recoveredSelection: false,
      });
    });
    const client = createDesktopCredentialClient(invoke, true);
    expect(await client?.status()).toMatchObject({ state: 'available' });
    expect((await client?.list())?.accounts).toEqual([account]);
  });

  it('redacts native failures instead of propagating backend or secret details', async () => {
    const token = 'A'.repeat(43);
    const invoke = vi.fn(() =>
      Promise.reject(new Error(`keychain rejected ${token}`)),
    );
    const client = createDesktopCredentialClient(invoke, true);
    await expect(
      client?.store({
        ...account,
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        makeActive: true,
        userConsented: true,
        sessionToken: token,
      }),
    ).rejects.toEqual(new DesktopCredentialError('store_unavailable'));
    await expect(
      client?.store({
        ...account,
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        makeActive: true,
        userConsented: true,
        sessionToken: token,
      }),
    ).rejects.not.toThrow(token);
  });
});

describe('desktop credential controls', () => {
  it('announces unavailable storage without offering an insecure fallback', () => {
    const markup = renderToStaticMarkup(
      <DesktopCredentialControls
        status={{
          state: 'unavailable',
          accountCount: 0,
          maxAccounts: 20,
          recoveredSelection: false,
        }}
        busy={false}
        message=""
        onSelect={() => {}}
        onRemove={() => {}}
        onClear={() => {}}
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('will not fall back to a plain-text file');
    expect(markup).toContain('aria-live="polite"');
  });

  it('labels account switching and removal without rendering secret material', () => {
    const markup = renderToStaticMarkup(
      <DesktopCredentialControls
        status={{
          state: 'available',
          accountCount: 1,
          maxAccounts: 20,
          recoveredSelection: false,
        }}
        inventory={{ accounts: [account], recoveredSelection: false }}
        busy={false}
        message="Ready"
        onSelect={() => {}}
        onRemove={() => {}}
        onClear={() => {}}
      />,
    );
    expect(markup).toContain('Use saved sign-in for Aster');
    expect(markup).toContain('Remove saved sign-in for Aster');
    expect(markup).toContain('Session secrets are kept');
    expect(markup).not.toContain('sessionToken');
  });
});
