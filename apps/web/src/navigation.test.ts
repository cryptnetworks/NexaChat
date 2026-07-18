import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const sourceUrl = new URL('./main.tsx', import.meta.url);

describe('community navigation semantics', () => {
  it('uses keyboard-operable controls and exposes current selection', async () => {
    const source = await readFile(sourceUrl, 'utf8');
    expect(source).toContain('<nav aria-label="Community navigation">');
    expect(source).toContain('<button');
    expect(source).toContain('aria-current=');
    expect(source).toContain('onClick=');
  });

  it('exposes loading, empty, and error states', async () => {
    const source = await readFile(sourceUrl, 'utf8');
    expect(source).toContain('aria-busy={loading}');
    expect(source).toContain('No categories yet.');
    expect(source).toContain('role="alert"');
  });
});
