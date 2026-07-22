export type MessageCatalog = Record<string, string>;
export const enCatalog: MessageCatalog = {
  'common.retry': 'Try again',
  'notifications.count.one': '{count} notification',
  'notifications.count.other': '{count} notifications',
  'route.welcome': 'Welcome, {name}',
};
export const arCatalog: MessageCatalog = {
  'common.retry': 'حاول مرة أخرى',
  'notifications.count.zero': 'لا إشعارات',
  'notifications.count.one': 'إشعار واحد',
  'notifications.count.two': 'إشعاران',
  'notifications.count.few': '{count} إشعارات',
  'notifications.count.many': '{count} إشعارًا',
  'notifications.count.other': '{count} إشعار',
  'route.welcome': 'مرحبًا، {name}',
};

const rtlLanguages = new Set(['ar', 'fa', 'he', 'ur']);
export class Localizer {
  readonly locale: string;
  readonly direction: 'ltr' | 'rtl';
  constructor(
    locale: string,
    private readonly catalog: MessageCatalog,
    private readonly fallback: MessageCatalog = enCatalog,
    private readonly strict = true,
  ) {
    this.locale = Intl.DateTimeFormat.supportedLocalesOf([locale])[0] ?? 'en';
    this.direction = rtlLanguages.has(this.locale.split('-')[0] ?? '')
      ? 'rtl'
      : 'ltr';
  }
  message(key: string, values: Record<string, string | number> = {}): string {
    const template = this.catalog[key] ?? this.fallback[key];
    if (!template) {
      if (this.strict) throw new Error(`missing_translation:${key}`);
      return `[${key}]`;
    }
    return template.replace(
      /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g,
      (_match, name: string) => {
        const value = values[name];
        if (value === undefined)
          throw new Error(`missing_translation_value:${key}:${name}`);
        return String(value);
      },
    );
  }
  plural(key: string, count: number): string {
    const category = new Intl.PluralRules(this.locale).select(count);
    return this.message(`${key}.${category}`, { count });
  }
  date(value: Date): string {
    return new Intl.DateTimeFormat(this.locale, { dateStyle: 'medium' }).format(
      value,
    );
  }
  time(value: Date): string {
    return new Intl.DateTimeFormat(this.locale, { timeStyle: 'short' }).format(
      value,
    );
  }
  number(value: number): string {
    return new Intl.NumberFormat(this.locale).format(value);
  }
  applyDocument(root: Pick<HTMLElement, 'lang' | 'dir'>): void {
    root.lang = this.locale;
    root.dir = this.direction;
  }
}
