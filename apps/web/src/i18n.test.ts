import { describe, expect, it } from 'vitest';
import { Localizer, arCatalog, enCatalog } from './i18n.js';

describe('localization infrastructure', () => {
  it('formats catalogs, pluralization, dates, numbers, fallback, and RTL', () => {
    const en = new Localizer('en-US', enCatalog);
    expect(en.plural('notifications.count', 2)).toBe('2 notifications');
    expect(en.message('route.welcome', { name: 'Nexa' })).toBe('Welcome, Nexa');
    expect(en.number(1234)).toMatch(/1,234/);
    expect(en.date(new Date('2026-01-01T12:00:00Z'))).toBeTruthy();
    const ar = new Localizer('ar', arCatalog);
    expect(ar.direction).toBe('rtl');
    expect(ar.message('common.retry')).toBe('حاول مرة أخرى');
    expect(ar.plural('notifications.count', 2)).toBe('إشعاران');
    const root = { lang: '', dir: '' };
    ar.applyDocument(root);
    expect(root).toEqual({ lang: 'ar', dir: 'rtl' });
  });
  it('detects missing keys and placeholders instead of concatenating fragments', () => {
    const i18n = new Localizer('en', enCatalog);
    expect(() => i18n.message('missing.key')).toThrow('missing_translation');
    expect(() => i18n.message('route.welcome')).toThrow(
      'missing_translation_value',
    );
  });
});
