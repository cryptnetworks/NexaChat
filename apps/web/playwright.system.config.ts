import { defineConfig } from '@playwright/test';

const baseURL = process.env.NEXA_E2E_BASE_URL;
if (!baseURL) throw new Error('NEXA_E2E_BASE_URL is required');
const outputDir = process.env.NEXA_E2E_OUTPUT_DIR;
if (!outputDir) throw new Error('NEXA_E2E_OUTPUT_DIR is required');

const parsedBaseURL = new URL(baseURL);
if (
  parsedBaseURL.protocol !== 'http:' ||
  parsedBaseURL.username ||
  parsedBaseURL.password ||
  parsedBaseURL.pathname !== '/' ||
  parsedBaseURL.search ||
  parsedBaseURL.hash
)
  throw new Error('NEXA_E2E_BASE_URL must be a local HTTP origin');

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.pw.ts',
  testIgnore: ['**/accessibility.pw.ts', '**/*.performance.pw.ts'],
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: 'list',
  outputDir,
  use: {
    baseURL,
    browserName: 'chromium',
    screenshot: 'off',
    trace: 'off',
    video: 'off',
    viewport: { width: 1280, height: 720 },
  },
});
