import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = 'apps/desktop/src-tauri';

describe('desktop shell contract', () => {
  it('builds the shared web client into one responsive bundled window', async () => {
    const config = JSON.parse(
      await readFile(`${root}/tauri.conf.json`, 'utf8'),
    ) as {
      build: Record<string, unknown>;
      app: { windows: Array<Record<string, unknown>> };
      bundle: Record<string, unknown>;
    };
    expect(config.build).toMatchObject({
      frontendDist: '../../web/dist',
      beforeBuildCommand: 'npm run build --workspace @nexa/web',
    });
    expect(config.app.windows).toEqual([
      expect.objectContaining({
        label: 'main',
        minWidth: 360,
        minHeight: 520,
        resizable: true,
      }),
    ]);
    expect(config.bundle).toMatchObject({ active: true, targets: 'all' });
  });

  it('pins the framework and compiler inputs', async () => {
    const [cargo, toolchain, desktopPackage] = await Promise.all([
      readFile(`${root}/Cargo.toml`, 'utf8'),
      readFile('rust-toolchain.toml', 'utf8'),
      readFile('apps/desktop/package.json', 'utf8'),
    ]);
    expect(cargo).toContain('tauri = { version = "=2.11.5"');
    expect(cargo).toContain('tauri-build = { version = "=2.6.3"');
    expect(toolchain).toContain('channel = "1.97.1"');
    expect(JSON.parse(desktopPackage)).toMatchObject({
      private: true,
      scripts: { 'build:app': 'tauri build --no-bundle' },
    });
  });
});
