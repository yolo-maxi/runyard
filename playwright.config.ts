import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the runyard Hub e2e suite.
 *
 * There is intentionally NO global `webServer`: every test boots its own
 * fully-isolated Hub server (fresh temp data dir + free TCP port) via the
 * `hub` fixture in tests/e2e/fixtures.ts. That keeps workers hermetic and
 * lets the suite run fully in parallel without cross-test state.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "line",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
