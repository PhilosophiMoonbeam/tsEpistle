import { defineConfig, devices } from '@playwright/test'

const performanceViewport = { width: 1440, height: 900 }
const performanceExecution = {
  workers: 1,
  retries: process.env.CI ? 2 : 0
}
const linuxWebGpuCapabilityFlags = process.platform === 'linux' ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] : []
const hardwareWebGlLaunchFlags = ['--use-gl=angle', '--use-angle=gl']
const swiftShaderLaunchFlags = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']

export default defineConfig({
  testDir: './dev/e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  retryStrategy: 'immediate',
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    serviceWorkers: 'allow'
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
      use: { ...devices['iPad Mini'], browserName: 'chromium' }
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
      name: 'responsive-chromium-desktop',
      dependencies: ['chromium'],
      testMatch: ['**/responsive.e2e.ts', '**/login-logo.e2e.ts', '**/editor-panels.e2e.ts', '**/tags.e2e.ts', '**/offline.e2e.ts', '**/agent-media.e2e.ts'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 }
      }
    },
    {
      name: 'responsive-firefox-desktop',
      dependencies: ['chromium'],
      testMatch: ['**/responsive.e2e.ts', '**/login-logo.e2e.ts', '**/editor-panels.e2e.ts', '**/tags.e2e.ts', '**/offline.e2e.ts', '**/agent-media.e2e.ts'],
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1440, height: 900 }
      }
    },
    {
      name: 'responsive-webkit-desktop',
      dependencies: ['chromium'],
      testMatch: ['**/responsive.e2e.ts', '**/login-logo.e2e.ts', '**/editor-panels.e2e.ts', '**/tags.e2e.ts', '**/offline.e2e.ts', '**/agent-media.e2e.ts'],
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 1440, height: 900 }
      }
    },
    {
      name: 'responsive-chromium-wide',
      dependencies: ['chromium'],
      testMatch: ['**/responsive.e2e.ts', '**/login-logo.e2e.ts', '**/editor-panels.e2e.ts', '**/tags.e2e.ts'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 2560, height: 1440 }
      }
    },
    {
      name: 'responsive-chromium-tablet',
      dependencies: ['chromium'],
      testMatch: ['**/responsive.e2e.ts', '**/login-logo.e2e.ts', '**/editor-panels.e2e.ts', '**/tags.e2e.ts'],
      use: { ...devices['iPad Mini landscape'], browserName: 'chromium' }
    },
    {
      name: 'responsive-chromium-mobile',
      dependencies: ['chromium'],
      testMatch: ['**/responsive.e2e.ts', '**/login-logo.e2e.ts', '**/editor-panels.e2e.ts', '**/tags.e2e.ts', '**/offline.e2e.ts', '**/agent-media.e2e.ts'],
      use: { ...devices['Pixel 7'] }
    },
    {
      name: 'responsive-webkit-mobile',
      dependencies: ['chromium'],
      testMatch: ['**/responsive.e2e.ts', '**/login-logo.e2e.ts', '**/editor-panels.e2e.ts', '**/tags.e2e.ts', '**/offline.e2e.ts', '**/agent-media.e2e.ts'],
      use: { ...devices['iPhone 13'] }
    },
    {
      name: 'responsive-webkit-mobile-landscape',
      dependencies: ['chromium'],
      testMatch: ['**/responsive.e2e.ts', '**/login-logo.e2e.ts', '**/editor-panels.e2e.ts', '**/tags.e2e.ts', '**/offline.e2e.ts', '**/agent-media.e2e.ts'],
      use: { ...devices['iPhone 13 landscape'] }
    },
    {
      name: 'performance-desktop',
      dependencies: ['chromium'],
      ...performanceExecution,
      testMatch: '**/runtime-performance.e2e.ts',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'performance-webgpu',
      dependencies: ['chromium'],
      ...performanceExecution,
      testMatch: '**/logo-particle-performance.e2e.ts',
      metadata: {
        webgpuCapabilityFlags: linuxWebGpuCapabilityFlags,
        webgpuCapabilityFlagsPurpose: 'runner-capability-enablement-only',
        launchFlags: linuxWebGpuCapabilityFlags,
        launchFlagsPurpose: 'WebGPU capability enablement only',
        headless: true
      },
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
        viewport: performanceViewport,
        launchOptions: { args: linuxWebGpuCapabilityFlags }
      }
    },
    {
      name: 'performance-webgl2',
      dependencies: ['chromium'],
      ...performanceExecution,
      testMatch: '**/logo-particle-performance.e2e.ts',
      metadata: {
        webgpuCapabilityFlags: [],
        webgpuCapabilityFlagsPurpose: 'not-applicable',
        launchFlags: hardwareWebGlLaunchFlags,
        launchFlagsPurpose: 'explicit hardware ANGLE desktop WebGL2 profile',
        headless: true
      },
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
        viewport: performanceViewport,
        launchOptions: { args: hardwareWebGlLaunchFlags }
      }
    },
    {
      name: 'performance-webgl2-swiftshader',
      dependencies: ['chromium'],
      ...performanceExecution,
      testMatch: '**/logo-particle-performance.e2e.ts',
      metadata: {
        webgpuCapabilityFlags: [],
        webgpuCapabilityFlagsPurpose: 'not-applicable',
        launchFlags: swiftShaderLaunchFlags,
        launchFlagsPurpose: 'explicit SwiftShader software diagnostic only',
        performanceProfile: 'swiftshader-webgl2-diagnostic',
        headless: true
      },
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
        viewport: performanceViewport,
        launchOptions: { args: swiftShaderLaunchFlags }
      }
    }
  ]
})
