import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './dev/e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000',
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'chromium',
      testMatch: '**/setup.e2e.ts',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'accessibility-keyboard',
      dependencies: ['chromium'],
      testMatch: '**/quality.e2e.ts',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'accessibility-dark',
      dependencies: ['chromium'],
      testMatch: '**/quality.e2e.ts',
      use: { ...devices['Desktop Chrome'], colorScheme: 'dark' }
    },
    {
      name: 'accessibility-mobile',
      dependencies: ['chromium'],
      testMatch: '**/quality.e2e.ts',
      use: { ...devices['Pixel 7'] }
    },
    {
      name: 'accessibility-tablet',
      dependencies: ['chromium'],
      testMatch: '**/quality.e2e.ts',
      use: { ...devices['iPad Mini'] }
    },
    {
      name: 'accessibility-wide',
      dependencies: ['chromium'],
      testMatch: '**/quality.e2e.ts',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 }
      }
    },
    {
      name: 'performance-desktop',
      dependencies: ['chromium'],
      testMatch: '**/runtime-performance.e2e.ts',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
})
