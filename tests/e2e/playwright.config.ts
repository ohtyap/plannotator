/**
 * Headless browser tests for the review and annotate UI. Build the binary
 * first (`bun run build:cli`), then `bun run test:e2e`. One spec:
 * `bunx playwright test -c tests/e2e/playwright.config.ts <name>.spec.ts`.
 *
 * Each spec says what it proves in its own header comment. A new
 * `tests/e2e/*.spec.ts` runs in the `chromium` project with no edit to this
 * file; name it `*-webkit.spec.ts` to run it in the `webkit` project only.
 */
import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { quarantineFilter } from './quarantine';

process.env.PLANNOTATOR_E2E_BINARY ??= resolve(
  __dirname, '../../dist', process.platform === 'win32' ? 'plannotator.exe' : 'plannotator',
);
/** Specs that run in the `webkit` project only. */
const WEBKIT_ONLY = '*-webkit.spec.ts';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  // In CI, the flaky tests in quarantine.json are left out; `bun run test:e2e:quarantine` runs their specs locally.
  ...quarantineFilter(process.env),
  outputDir: '../../.local/test-results',
  // Feedback never reaches the live Worker, and agent CLI stubs go first on PATH: a stub that is called fails the run (global-setup.ts, agent-cli-stubs.ts).
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    // Keep a screenshot on failure without recording traces for passing tests.
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--use-mock-keychain', '--password-store=basic'] },
  },
  projects: [
    { name: 'chromium', testIgnore: WEBKIT_ONLY },
    // The WebKit-only specs, and the toolstrip's right-to-left check in WebKit too. No Chromium flags here: WebKit refuses them.
    { name: 'webkit', testMatch: [WEBKIT_ONLY, 'toolstrip-rtl.spec.ts'], use: { browserName: 'webkit', launchOptions: { args: [] } } },
  ],
});
