import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = 'apps/desktop/src-tauri';

describe('desktop process boundary', () => {
  it('starts one hardened, Rust-controlled webview', async () => {
    const config = JSON.parse(
      await readFile(`${root}/tauri.conf.json`, 'utf8'),
    ) as {
      app: {
        windows: Array<Record<string, unknown>>;
        security: {
          csp: Record<string, string>;
          devCsp: Record<string, string>;
        };
      };
    };

    expect(config.app.windows).toEqual([
      expect.objectContaining({
        label: 'main',
        create: false,
        devtools: false,
        dragDropEnabled: false,
      }),
    ]);
    expect(config.app.security.csp['connect-src']).toBe(
      "'self' ipc: http://ipc.localhost",
    );
    expect(config.app.security.devCsp['connect-src']).toBe(
      "'self' ipc: http://ipc.localhost http://localhost:5173 ws://localhost:5173",
    );
    expect(JSON.stringify(config.app.security)).not.toMatch(
      /unsafe-eval|https: wss:|file:/,
    );
  });

  it('grants only bounded credential IPC and no shell capability', async () => {
    const [capability, cargo, runtime] = await Promise.all([
      readFile(`${root}/capabilities/main.json`, 'utf8'),
      readFile(`${root}/Cargo.toml`, 'utf8'),
      readFile(`${root}/src/lib.rs`, 'utf8'),
    ]);

    expect(JSON.parse(capability)).toMatchObject({
      windows: ['main'],
      permissions: [
        'allow-credential-store-status',
        'allow-list-stored-accounts',
        'allow-store-session-credential',
        'allow-select-stored-account',
        'allow-remove-stored-account',
        'allow-clear-stored-accounts',
      ],
    });
    expect(cargo).toContain('tauri-plugin-opener = "=2.5.4"');
    expect(cargo).not.toContain('tauri-plugin-shell');
    expect(runtime).toContain('.on_navigation(');
    expect(runtime).toContain('.on_new_window(');
    expect(runtime).toContain('NewWindowResponse::Deny');
    expect(runtime).toContain('tauri::generate_handler!');
    expect(runtime.indexOf('tauri_plugin_single_instance::init')).toBeLessThan(
      runtime.indexOf('tauri_plugin_opener::init'),
    );
    expect(capability).not.toContain('core:default');
    expect(capability).not.toContain('opener:');
  });
});
