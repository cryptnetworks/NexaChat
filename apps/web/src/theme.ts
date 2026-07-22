export type ThemePreference = 'system' | 'light' | 'dark';
export function readThemePreference(
  storage: Pick<Storage, 'getItem'>,
): ThemePreference {
  try {
    const value = storage.getItem('nexa:theme');
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}
export function resolveTheme(
  preference: ThemePreference,
  prefersDark: boolean,
): 'light' | 'dark' {
  return preference === 'system'
    ? prefersDark
      ? 'dark'
      : 'light'
    : preference;
}
export function applyTheme(
  root: Pick<HTMLElement, 'dataset' | 'style'>,
  preference: ThemePreference,
  prefersDark: boolean,
): void {
  root.dataset.theme = resolveTheme(preference, prefersDark);
  root.style.colorScheme = resolveTheme(preference, prefersDark);
}
export function saveThemePreference(
  storage: Pick<Storage, 'setItem'>,
  root: Pick<HTMLElement, 'dataset' | 'style'>,
  preference: ThemePreference,
  prefersDark: boolean,
): void {
  storage.setItem('nexa:theme', preference);
  applyTheme(root, preference, prefersDark);
}
