/**
 * Playwright config for the headless-render mount lane (tests/e2e).
 *
 * The lane does NOT spawn the server itself: `scripts/e2e-mount.sh` boots a
 * real `dsh web` instance (with the npm-packed plugin mounted through the
 * official `dsh plugin add` channel) and injects the base URL via
 * `DSH_E2E_URL`. The spec renders that URL in a headless Chromium and proves
 * the plugin mounts without crashing the shell.
 *
 * Specs are named `*.e2e.ts` so vitest's default include never collects them.
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  retries: 0,
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
  },
})
