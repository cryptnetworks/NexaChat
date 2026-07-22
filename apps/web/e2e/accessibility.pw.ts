import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

const ids = {
  account: '00000000-0000-4000-8000-000000000001',
  community: '00000000-0000-4000-8000-000000000002',
  category: '00000000-0000-4000-8000-000000000003',
  space: '00000000-0000-4000-8000-000000000004',
  invitation: '00000000-0000-4000-8000-000000000005',
};
const invitationToken = 'A'.repeat(43);

const account = { id: ids.account, displayName: 'Local Explorer' };
const community = {
  id: ids.community,
  ownerId: ids.account,
  name: 'Field Notes',
  archivedAt: null,
  version: 1,
};
const category = {
  id: ids.category,
  communityId: ids.community,
  name: 'General',
  position: 0,
  archivedAt: null,
  version: 1,
};
const space = {
  id: ids.space,
  communityId: ids.community,
  name: 'trailhead',
  kind: 'text',
  categoryId: ids.category,
  position: 0,
  archivedAt: null,
  version: 1,
};

async function fulfillJson(route: Route, json: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', json });
}

async function mockApplicationApi(page: Page, failAccount = false) {
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/v1/dev/accounts') {
      await fulfillJson(
        route,
        failAccount ? { error: 'dependency_unavailable' } : account,
        failAccount ? 503 : 201,
      );
    } else if (path === '/v1/communities') {
      await fulfillJson(route, community, 201);
    } else if (path.endsWith('/categories')) {
      await fulfillJson(route, category, 201);
    } else if (path.endsWith('/spaces')) {
      await fulfillJson(route, space, 201);
    } else if (path.endsWith('/messages') && request.method() === 'GET') {
      await fulfillJson(route, { items: [], nextCursor: null });
    } else if (path.endsWith('/messages')) {
      await fulfillJson(route, { accepted: true }, 201);
    } else if (path.endsWith('/invitations')) {
      await fulfillJson(
        route,
        {
          invitation: {
            id: ids.invitation,
            communityId: ids.community,
            creatorId: ids.account,
            targetAccountId: null,
            createdAt: '2026-07-19T12:00:00.000Z',
            expiresAt: '2026-07-20T12:00:00.000Z',
            maxUses: 1,
            useCount: 0,
            revokedAt: null,
            version: 1,
          },
          token: invitationToken,
        },
        201,
      );
    } else if (path === '/v1/invitations/preview') {
      await fulfillJson(route, {
        communityId: ids.community,
        communityName: 'Field Notes',
        expiresAt: '2026-07-20T12:00:00.000Z',
      });
    } else if (path === '/v1/invitations/accept') {
      await fulfillJson(route, { accepted: true });
    } else {
      await fulfillJson(route, { error: 'not_found' }, 404);
    }
  });
}

async function expectNoAutomatedWcagViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

async function enterDemoSpace(page: Page) {
  const create = page.getByRole('button', { name: 'Create the demo space' });
  await create.focus();
  await page.keyboard.press('Enter');
  const heading = page.getByRole('heading', { name: 'trailhead' });
  await expect(heading).toBeFocused();
}

test('critical keyboard flows and rendered states pass WCAG A/AA rules', async ({
  page,
}) => {
  await mockApplicationApi(page);
  await page.goto('/');
  await expectNoAutomatedWcagViolations(page);

  await page.keyboard.press('Tab');
  const skipLink = page.getByRole('link', { name: 'Skip to conversation' });
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeFocused();

  await enterDemoSpace(page);
  await expectNoAutomatedWcagViolations(page);

  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.focus();
  await composer.fill('Keyboard-authored message');
  await page.keyboard.press('Enter');
  await expect(composer).toHaveValue('');
  await expect(composer).toBeFocused();

  const createInvitation = page.getByRole('button', {
    name: 'Create one-use invitation',
  });
  await createInvitation.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: 'Invitation created' }),
  ).toBeVisible();
  await expectNoAutomatedWcagViolations(page);
});

test('invitation acceptance and error recovery are keyboard operable', async ({
  page,
}) => {
  await mockApplicationApi(page);
  await page.goto(`/#invite=${invitationToken}`);
  await enterDemoSpace(page);
  const accept = page.getByRole('button', { name: 'Accept invitation' });
  await accept.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: 'Invitation accepted' }),
  ).toBeVisible();
  await expectNoAutomatedWcagViolations(page);

  const failurePage = await page.context().newPage();
  await mockApplicationApi(failurePage, true);
  await failurePage.goto('/');
  const create = failurePage.getByRole('button', {
    name: 'Create the demo space',
  });
  await create.focus();
  await failurePage.keyboard.press('Enter');
  await expect(failurePage.getByRole('alert')).toContainText(
    'Request failed (503)',
  );
  await expect(create).toBeFocused();
  await expectNoAutomatedWcagViolations(failurePage);
});

test('narrow reflow, large targets, reduced motion, and forced colors remain usable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await mockApplicationApi(page);
  await page.goto('/');
  await enterDemoSpace(page);

  await expectNoAutomatedWcagViolations(page);

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  for (const control of await page.getByRole('button').all()) {
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await expect(
    page.getByRole('navigation', { name: 'Community navigation' }),
  ).toBeVisible();

  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.focus();
  expect(
    await composer.evaluate((element) => getComputedStyle(element).borderStyle),
  ).toBe('solid');
  expect(
    await composer.evaluate(
      (element) => getComputedStyle(element).outlineStyle,
    ),
  ).toBe('solid');
});
