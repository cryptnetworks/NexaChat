import { expect, test } from '@playwright/test';

const runId = process.env.NEXA_E2E_RUN_ID;
if (!runId || !/^\d{1,12}$/.test(runId))
  throw new Error('NEXA_E2E_RUN_ID must be a bounded numeric identifier');

const username = `e2e_${runId}`;
const password = 'browser-e2e-test-passphrase';

test('registration, authenticated profile access, and logout use the live service stack', async ({
  page,
}) => {
  const unauthenticatedAccount = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/v1/account' &&
      response.status() === 401,
  );
  await page.goto('/');
  await unauthenticatedAccount;
  await expect(
    page.getByRole('region', { name: 'Account access' }),
  ).toBeVisible();

  const registrationUsername = page.locator('#registration-username');
  const registrationDisplayName = page.locator('#registration-display-name');
  const registrationPassword = page.locator('#registration-password');
  await expect(registrationUsername).toHaveCount(1);
  await expect(registrationDisplayName).toHaveCount(1);
  await expect(registrationPassword).toHaveCount(1);
  await registrationUsername.fill(username);
  await registrationDisplayName.fill('Browser E2E');
  await registrationPassword.fill(password);

  const createAccount = page.getByRole('button', {
    name: 'Create account',
    exact: true,
  });
  await expect(createAccount).toHaveCount(1);
  const registered = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/v1/auth/register' &&
      response.status() === 201,
  );
  const authenticatedAccount = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/v1/account' &&
      response.status() === 200,
  );
  await createAccount.click();
  await registered;
  await authenticatedAccount;
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  await expect(page.getByText(`@${username}`)).toBeVisible();

  const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
  await expect(signOut).toHaveCount(1);
  const loggedOut = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/v1/auth/logout' &&
      response.status() === 204,
  );
  await signOut.click();
  await loggedOut;
  await expect(
    page.getByRole('region', { name: 'Account access' }),
  ).toBeVisible();
});
