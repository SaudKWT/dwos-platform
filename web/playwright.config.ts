import { defineConfig, devices } from '@playwright/test'

/**
 * Chromium only, deliberately: KOC is a Windows/Edge organisation, and WebKit
 * would be testing a browser no KOC user has.
 *
 * The dev server is started for the run, but the API is NOT — these screens read
 * real data, so `dotnet run --project server/Koc.Vessels.Api` has to be up on
 * 5280 first, with a migrated and seeded database behind it. A suite that
 * silently passed against an empty API would be worse than one that fails.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4200',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:4200',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
