import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '*.e2e.js',
  /* Matches core, so the reports look the same in both repositories. */
  reporter: [['html'], ['github']],
  use: { ...devices['Desktop Chrome'] },
});
