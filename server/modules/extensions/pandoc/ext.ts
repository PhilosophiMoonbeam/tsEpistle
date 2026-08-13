import commandExistsModule from 'command-exists'
import os from 'node:os'

type CommandExists = (commandName: string) => Promise<string>

const isCommandExists = (value: unknown): value is CommandExists => typeof value === 'function'

if (!isCommandExists(commandExistsModule)) {
  throw new TypeError('command-exists does not export a callable function.')
}
const commandExists = commandExistsModule

const plugin = {
  key: 'pandoc',
  title: 'Pandoc',
  description: 'Convert between markup formats. Required for converting from other formats such as MediaWiki, AsciiDoc, Textile and other wikis.',
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
