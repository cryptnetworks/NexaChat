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
const profile = {
  id: ids.account,
  username: 'local-explorer',
  displayName: 'Local Explorer',
  avatar: null,
  createdAt: '2026-07-19T12:00:00.000Z',
  updatedAt: '2026-07-19T12:00:00.000Z',
  version: 1,
};
const sessionFixtures = [
  {
    handle: 'sess_AAAAAAAAAAAAAAAA',
    createdAt: '2026-07-19T10:00:00.000Z',
    lastSeenAt: '2026-07-19T12:00:00.000Z',
    recentAuthAt: '2026-07-19T10:00:00.000Z',
    expiresAt: '2026-07-26T10:00:00.000Z',
    current: true,
  },
  {
    handle: 'sess_BBBBBBBBBBBBBBBB',
    createdAt: '2026-07-18T10:00:00.000Z',
    lastSeenAt: '2026-07-18T12:00:00.000Z',
    recentAuthAt: '2026-07-18T10:00:00.000Z',
    expiresAt: '2026-07-25T10:00:00.000Z',
    current: false,
  },
];
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

function historyMessage(index: number) {
  const createdAt = new Date(
    Date.parse('2026-07-19T12:00:00.000Z') + index * 1_000,
  ).toISOString();
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    spaceId: ids.space,
    authorId: ids.account,
    body: `History message ${String(index)}`,
    replyToId: null,
    idempotencyKey: `history-${String(index)}`,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    version: 1,
  };
}

async function fulfillJson(route: Route, json: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', json });
}

async function mockApplicationApi(
  page: Page,
  failAccount = false,
  authenticatedProfile = false,
  history = [] as ReturnType<typeof historyMessage>[],
) {
  let signedIn = authenticatedProfile;
  let sessions = [...sessionFixtures];
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/v1/account' && request.method() === 'GET') {
      await fulfillJson(
        route,
        signedIn ? profile : { error: 'unauthenticated' },
        signedIn ? 200 : 401,
      );
    } else if (path === '/v1/account' && request.method() === 'PATCH') {
      const body = request.postDataJSON() as {
        username: string;
        displayName: string;
      };
      await fulfillJson(route, { ...profile, ...body, version: 2 });
    } else if (path === '/v1/account/password') {
      await route.fulfill({ status: 204 });
    } else if (path === '/v1/sessions' && request.method() === 'GET') {
      await fulfillJson(route, sessions);
    } else if (
      path.startsWith('/v1/sessions/sess_') &&
      request.method() === 'DELETE'
    ) {
      const handle = path.split('/').at(-1);
      sessions = sessions.filter((session) => session.handle !== handle);
      await route.fulfill({ status: 204 });
    } else if (path === '/v1/sessions/revoke-others') {
      sessions = sessions.filter((session) => session.current);
      await route.fulfill({ status: 204 });
    } else if (path === '/v1/auth/login' || path === '/v1/auth/register') {
      signedIn = true;
      await fulfillJson(route, account, path.endsWith('/register') ? 201 : 200);
    } else if (path === '/v1/auth/logout') {
      signedIn = false;
      await route.fulfill({ status: 204 });
    } else if (path === '/v1/dev/accounts') {
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
      const query = new URL(request.url()).searchParams;
      const direction = query.get('direction');
      const cursor = query.get('cursor');
      const end = cursor ? Number(cursor) : history.length;
      const start = Math.max(0, end - 100);
      await fulfillJson(
        route,
        direction === 'backward'
          ? {
              items: history.slice(start, end),
              nextCursor: start > 0 ? String(start) : null,
            }
          : { items: history, nextCursor: null },
      );
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

test('authenticated profile editing is labelled, keyboard operable, and announced', async ({
  page,
}) => {
  await mockApplicationApi(page, false, true);
  await page.goto('/');
  const heading = page.getByRole('heading', { name: 'Your profile' });
  await expect(heading).toBeVisible();
  await expectNoAutomatedWcagViolations(page);
  const displayName = page.getByRole('textbox', { name: 'Display name' });
  await displayName.focus();
  await displayName.fill('Ada Lovelace');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(
    page.getByRole('region', { name: 'Your profile' }).getByRole('status'),
  ).toContainText('Profile saved.');
  await expect(displayName).toHaveValue('Ada Lovelace');
  await expectNoAutomatedWcagViolations(page);
});

test('password change is labelled, keyboard operable, private, and announced', async ({
  page,
}) => {
  await mockApplicationApi(page, false, true);
  await page.goto('/');
  const section = page.getByRole('region', { name: 'Change password' });
  await section.getByLabel('Current password').fill('old password value');
  await section
    .getByLabel('New password', { exact: true })
    .fill('new password value');
  await section.getByLabel('Confirm new password').fill('new password value');
  await section.getByRole('button', { name: 'Change password' }).click();
  await expect(section.getByRole('status')).toContainText('Password changed.');
  await expect(section.getByLabel('Current password')).toHaveValue('');
  await expectNoAutomatedWcagViolations(page);
});

test('registration, login, device inventory, confirmation, and tab sync are accessible', async ({
  page,
}) => {
  await mockApplicationApi(page);
  await page.goto('/');
  await expect(
    page.getByRole('region', { name: 'Account access' }),
  ).toBeVisible();
  await expectNoAutomatedWcagViolations(page);
  await page.getByLabel('Username', { exact: true }).first().fill('Ada');
  await page
    .getByLabel('Password', { exact: true })
    .first()
    .fill('safe password value');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  const inventory = page.getByRole('region', { name: 'Signed-in devices' });
  await expect(inventory.getByText('Current device')).toBeVisible();
  await expect(inventory.getByText('Other signed-in device')).toBeVisible();
  await expect(page.getByText('sess_BBBBBBBBBBBBBBBB')).toHaveCount(0);
  await inventory.getByRole('button', { name: 'Sign out device' }).click();
  const confirmation = page.getByRole('alertdialog');
  await expect(
    confirmation.getByRole('button', { name: 'Confirm sign-out' }),
  ).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(
    confirmation.getByRole('button', { name: 'Cancel' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirmation).toHaveCount(0);
  await expect(
    inventory.getByRole('button', { name: 'Sign out device' }),
  ).toBeFocused();
  await inventory.getByRole('button', { name: 'Sign out device' }).click();
  await confirmation.getByRole('button', { name: 'Confirm sign-out' }).click();
  await expect(inventory.getByRole('status')).toContainText(
    'selected device was signed out',
  );
  await expect(inventory.getByText('Other signed-in device')).toHaveCount(0);
  await expectNoAutomatedWcagViolations(page);

  await page.evaluate(() => {
    const channel = new BroadcastChannel('nexa-session-v1');
    channel.postMessage({ type: 'signed_out' });
    channel.close();
  });
  await expect(
    page.getByRole('region', { name: 'Account access' }),
  ).toBeVisible();
});

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

test('history pagination is bounded, keyboard operable, and announced', async ({
  page,
}) => {
  await mockApplicationApi(
    page,
    false,
    true,
    Array.from({ length: 250 }, (_, index) => historyMessage(index + 1)),
  );
  await page.goto('/');
  await enterDemoSpace(page);
  const messages = page.locator('.messages article');
  await expect(messages).toHaveCount(100);
  const loadOlder = page.getByRole('button', { name: 'Load older messages' });
  await expect(loadOlder).toBeEnabled();
  await loadOlder.focus();
  await page.keyboard.press('Enter');
  await expect(messages).toHaveCount(200);
  await expect(
    page.locator('.history-controls').getByRole('status'),
  ).toContainText('earlier window');
  await expect(
    page.getByRole('button', { name: 'Return to latest messages' }),
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
