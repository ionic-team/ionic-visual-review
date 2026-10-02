import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '*.e2e.js',
  reporter: [['html'], ['github']],
  use: { ...devices['Desktop Chrome'] },
});
