export const MAX_LINKS_PER_MESSAGE = 10;
export const MAX_LINK_DISPLAY = 80;

export type LinkSegment =
  | { type: 'text'; value: string }
  | { type: 'link'; value: string; href: string; label: string };

const internalNavigationOrigin = 'https://nexa.invalid';

export function safeInternalHref(value: string): string | undefined {
  if (!value.startsWith('/') || value.startsWith('//')) return undefined;
  try {
    const parsed = new URL(value, internalNavigationOrigin);
    if (parsed.origin !== internalNavigationOrigin) return undefined;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return undefined;
  }
}

/** Pure client-side parsing: this function never fetches a destination. */
export function safeLinkSegments(value: string): LinkSegment[] {
  const result: LinkSegment[] = [];
  const expression = /https?:\/\/[^\s<>"']+/giu;
  let offset = 0;
  let links = 0;
  for (const match of value.matchAll(expression)) {
    if (links >= MAX_LINKS_PER_MESSAGE) break;
    if (match.index > offset)
      result.push({ type: 'text', value: value.slice(offset, match.index) });
    const raw = match[0];
    let href: string | undefined;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        href = parsed.href;
    } catch {
      // Malformed destinations stay inert text.
    }
    if (href) {
      const label =
        raw.length > MAX_LINK_DISPLAY
          ? `${raw.slice(0, MAX_LINK_DISPLAY - 1)}…`
          : raw;
      result.push({ type: 'link', value: raw, href, label });
      links += 1;
    } else result.push({ type: 'text', value: raw });
    offset = match.index + raw.length;
  }
  if (offset < value.length)
    result.push({ type: 'text', value: value.slice(offset) });
  return result.length ? result : [{ type: 'text', value }];
}
