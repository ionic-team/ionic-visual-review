import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '*.e2e.js',
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html'], ['github']],
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },
});
