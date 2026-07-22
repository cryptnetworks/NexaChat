import { describe, expect, it } from 'vitest';
import { applyTheme, readThemePreference, resolveTheme } from './theme.js';

describe('accessible themes', () => {
  it('resolves system preference, survives blocked storage, and applies before render', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(readThemePreference({ getItem: () => 'light' })).toBe('light');
    expect(
      readThemePreference({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe('system');
    const root = {
      dataset: {} as DOMStringMap,
      style: { colorScheme: '' } as CSSStyleDeclaration,
    };
    applyTheme(root, 'light', true);
    expect(root.dataset.theme).toBe('light');
    expect(root.style.colorScheme).toBe('light');
  });
});
