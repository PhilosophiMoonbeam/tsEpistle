import type { OptionalExtensionDefinition } from '../../../../shared/extensions-workspace.ts'

const plugin: OptionalExtensionDefinition = {
  key: 'puppeteer',
  title: 'Puppeteer',
  description: 'A legacy optional browser entry that is not provided by the application process.',
  installation: {
    boundary: 'separate-image',
    detail:
      'Browser automation uses the separately deployed Agent Browser image with Playwright Chromium. The application image does not include Puppeteer or a server-side PDF renderer.',
    recovery:
      'Do not add or execute a browser package from Administration. If the Agent Browser service is unavailable, repair its reviewed deployment and verify it through the Agent workspace.'
  },
  capabilities: [
    {
      title: 'No application-process renderer',
      detail: 'This application build has no page-PDF or Mermaid workflow that invokes Puppeteer.',
      configuration: { label: 'Open Agent Browser', path: '/agents', hash: 'browser' }
    }
  ],
  dependencies: [
    {
      title: 'Separate Agent Browser image',
      detail: 'Its Chromium dependency is installed and sandboxed in the dedicated Agent Browser image, outside this application process.'
    }
  ],
  async observe() {
    return {
      state: 'not-provided',
      compatibility: 'not-applicable',
      evidence: 'No Puppeteer package or browser executable is inspected from the application process.'
    }
  }
}

export default plugin
