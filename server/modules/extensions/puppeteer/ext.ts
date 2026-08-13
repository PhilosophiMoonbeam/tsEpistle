import commandExistsModule from 'command-exists'
import os from 'node:os'

type CommandExists = (commandName: string) => Promise<string>

const isCommandExists = (value: unknown): value is CommandExists => typeof value === 'function'

if (!isCommandExists(commandExistsModule)) {
  throw new TypeError('command-exists does not export a callable function.')
}
const commandExists = commandExistsModule

const plugin = {
  key: 'puppeteer',
  title: 'Puppeteer',
  description: 'Headless chromium browser for server-side rendering. Required for generating PDF versions of pages and render content elements on the server (e.g. Mermaid diagrams)',
  async isCompatible () {
    return os.arch() === 'x64'
  },
  isInstalled: false,
  async check () {
    try {
      await commandExists('pandoc')
      this.isInstalled = true
    } catch {
      this.isInstalled = false
    }
    return this.isInstalled
  }
}

export default plugin
