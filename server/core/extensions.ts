import fs from 'fs-extra'
import path from 'node:path'
import type { ExtensionWorkspaceExtension, OptionalExtensionDefinition, OptionalExtensionRuntimeObservation } from '../../shared/extensions-workspace.ts'

interface WikiContext {
  SERVERPATH: string
  extensions: ExtensionService
  logger: { info(message: string): void }
}

interface ExtensionService {
  readonly ext: Readonly<Record<string, OptionalExtensionDefinition>>
  init(): Promise<void>
  inspect(): Promise<ExtensionWorkspaceExtension[]>
}

const loadDefinitions = async (): Promise<Readonly<Record<string, OptionalExtensionDefinition>>> => {
  const ext: Record<string, OptionalExtensionDefinition> = {}
  const extDirs = (await fs.readdir(path.join(wiki.SERVERPATH, 'modules/extensions'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  for (const dir of extDirs) {
    // Modules are discovered from the immutable application image at runtime; a static import cannot represent its plugin registry.
    const moduleUrl = new URL(`../modules/extensions/${dir}/ext.ts`, import.meta.url)
    const loaded = (await import(moduleUrl.href)) as { default: OptionalExtensionDefinition }
    if (!loaded.default || loaded.default.key !== dir) throw new TypeError(`Optional extension module ${dir} has an invalid definition.`)
    ext[dir] = loaded.default
  }
  return Object.freeze(ext)
}

const present = async (extension: OptionalExtensionDefinition): Promise<ExtensionWorkspaceExtension> => {
  let observation: OptionalExtensionRuntimeObservation
  try {
    observation = await extension.observe()
  } catch {
    observation = {
      state: 'unknown',
      compatibility: 'unknown',
      evidence: 'The bounded extension observation did not complete.'
    }
  }
  return {
    key: extension.key,
    title: extension.title,
    description: extension.description,
    installation: { ...extension.installation },
    capabilities: extension.capabilities.map(capability => ({
      title: capability.title,
      detail: capability.detail,
      ...(capability.configuration === undefined
        ? {}
        : {
            configuration: {
              ...capability.configuration,
              ...(capability.configuration.query === undefined ? {} : { query: { ...capability.configuration.query } })
            }
          })
    })),
    dependencies: extension.dependencies.map(dependency => ({ ...dependency })),
    observation: { ...observation, checkedAt: new Date().toISOString() }
  }
}

const wiki = WIKI as unknown as WikiContext
let initialized = false
let initializing: Promise<void> | undefined
let registry: Readonly<Record<string, OptionalExtensionDefinition>> = Object.freeze({})

const extensions: ExtensionService = {
  get ext() {
    return registry
  },
  async init() {
    if (initialized) return
    initializing ??= (async () => {
      wiki.logger.info('Checking deployment-owned optional extensions...')
      const loaded = await loadDefinitions()
      registry = loaded
      initialized = true
      for (const extension of await this.inspect()) {
        wiki.logger.info(
          extension.observation.state === 'usable'
            ? `Optional extension ${extension.key} is usable. [ OK ]`
            : `Optional extension ${extension.key} is ${extension.observation.state}. [ CHECK ]`
        )
      }
    })()
    await initializing
  },
  async inspect() {
    if (!initialized) throw Object.assign(new Error('The deployed extension library is still initializing.'), { status: 503 })
    return await Promise.all(
      Object.values(registry)
        .sort((left, right) => left.key.localeCompare(right.key))
        .map(present)
    )
  }
}

export default extensions
