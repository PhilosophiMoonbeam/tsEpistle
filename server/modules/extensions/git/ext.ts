import commandExistsModule from 'command-exists'

type CommandExists = (commandName: string) => Promise<string>

const isCommandExists = (value: unknown): value is CommandExists => typeof value === 'function'

if (!isCommandExists(commandExistsModule)) {
  throw new TypeError('command-exists does not export a callable function.')
}
const commandExists = commandExistsModule

const plugin = {
  key: 'git',
  title: 'Git',
  description: 'Distributed version control system. Required for the Git storage module.',
  isInstalled: false,
  async isCompatible () {
    return true
  },
  async check () {
    try {
      await commandExists('git')
      this.isInstalled = true
    } catch {
      this.isInstalled = false
    }
    return this.isInstalled
  }
}

export default plugin
