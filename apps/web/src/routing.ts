export type AppRoute =
  | { kind: 'login'; requiresAuth: false }
  | { kind: 'home' | 'settings'; requiresAuth: true }
  | { kind: 'community'; communityId: string; requiresAuth: true }
  | {
      kind: 'space';
      communityId: string;
      spaceId: string;
      messageId?: string;
      requiresAuth: true;
    }
  | { kind: 'not-found'; requiresAuth: false };

const identifier = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
export function resolveAppRoute(pathname: string): AppRoute {
  const parts = pathname.replace(/\/+$/u, '').split('/').filter(Boolean);
  if (parts.length === 0) return { kind: 'home', requiresAuth: true };
  if (parts.length === 1 && parts[0] === 'login')
    return { kind: 'login', requiresAuth: false };
  if (parts.length === 1 && parts[0] === 'settings')
    return { kind: 'settings', requiresAuth: true };
  if (parts[0] === 'communities' && parts[1] && identifier.test(parts[1])) {
    if (parts.length === 2)
      return { kind: 'community', communityId: parts[1], requiresAuth: true };
    if (parts[2] === 'spaces' && parts[3] && identifier.test(parts[3])) {
      const route: AppRoute = {
        kind: 'space',
        communityId: parts[1],
        spaceId: parts[3],
        requiresAuth: true,
      };
      if (
        parts[4] === 'messages' &&
        parts[5] &&
        identifier.test(parts[5]) &&
        parts.length === 6
      )
        return { ...route, messageId: parts[5] };
      if (parts.length === 4) return route;
    }
  }
  return { kind: 'not-found', requiresAuth: false };
}
export function guardRoute(
  route: AppRoute,
  authenticated: boolean,
  currentPath: string,
): { route: AppRoute; returnTo: string | null } {
  return route.requiresAuth && !authenticated
    ? {
        route: { kind: 'login', requiresAuth: false },
        returnTo:
          currentPath.startsWith('/') && !currentPath.startsWith('//')
            ? currentPath
            : '/',
      }
    : { route, returnTo: null };
}
export function restoreRouteFocus(documentValue: {
  querySelector(selector: string): { tabIndex: number; focus(): void } | null;
}): void {
  const heading = documentValue.querySelector('main h1, main [role="heading"]');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus();
  }
}
