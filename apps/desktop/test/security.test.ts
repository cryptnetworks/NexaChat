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

  it('grants no frontend IPC permissions or shell capability', async () => {
    const [capability, cargo, runtime] = await Promise.all([
      readFile(`${root}/capabilities/main.json`, 'utf8'),
      readFile(`${root}/Cargo.toml`, 'utf8'),
      readFile(`${root}/src/lib.rs`, 'utf8'),
    ]);

    expect(JSON.parse(capability)).toMatchObject({
      windows: ['main'],
      permissions: [],
    });
    expect(cargo).toContain('tauri-plugin-opener = "=2.5.4"');
    expect(cargo).not.toContain('tauri-plugin-shell');
    expect(runtime).toContain('.on_navigation(');
    expect(runtime).toContain('.on_new_window(');
    expect(runtime).toContain('NewWindowResponse::Deny');
    expect(runtime).not.toContain('invoke_handler');
  });
});
