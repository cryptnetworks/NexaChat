import { describe, expect, it, vi } from 'vitest';
import { guardRoute, resolveAppRoute, restoreRouteFocus } from './routing.js';

describe('application routing', () => {
  it('supports guarded deep links and not-found routes', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const route = resolveAppRoute(
      `/communities/${id}/spaces/${id}/messages/${id}`,
    );
    expect(route).toMatchObject({ kind: 'space', messageId: id });
    expect(guardRoute(route, false, `/communities/${id}`)).toMatchObject({
      route: { kind: 'login' },
      returnTo: `/communities/${id}`,
    });
    expect(resolveAppRoute('/private/unknown').kind).toBe('not-found');
  });
  it('restores keyboard focus to the destination heading', () => {
    const focus = vi.fn();
    const heading = { tabIndex: 0, focus };
    restoreRouteFocus({ querySelector: () => heading });
    expect(heading.tabIndex).toBe(-1);
    expect(focus).toHaveBeenCalled();
  });
});
