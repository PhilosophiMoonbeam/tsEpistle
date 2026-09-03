import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { runtimeAssetsPlugin } from '../../../vite.config.mts'
import { afterEach, describe, expect, it } from '../bun-test.mts'

const temporaryDirectories: string[] = []

const createProjectRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-vite-assets-'))
  temporaryDirectories.push(root)
  fs.mkdirSync(path.join(root, 'client/static/svg'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules/prismjs/components'), { recursive: true })
  fs.writeFileSync(path.join(root, 'client/static/svg/icon-tsepistle.svg'), '<svg />')
  fs.writeFileSync(path.join(root, 'node_modules/prismjs/components/prism-javascript.min.js'), 'Prism.languages.javascript={};')
  return root
}

const invokeHook = async (hook: unknown): Promise<void> => {
  expect(typeof hook).toBe('function')
  await (hook as () => Promise<void>)()
}

describe('Vite runtime asset lifecycle', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true })
  })

  it('provisions same-origin static and Prism assets when the development server starts', async () => {
    const root = createProjectRoot()
    const plugin = runtimeAssetsPlugin('serve', root)

    expect(plugin.closeBundle).toBeUndefined()
    await invokeHook(plugin.configureServer)

    expect(fs.readFileSync(path.join(root, 'assets/svg/icon-tsepistle.svg'), 'utf8')).toBe('<svg />')
    expect(fs.readFileSync(path.join(root, 'assets/js/prism/prism-javascript.min.js'), 'utf8')).toBe('Prism.languages.javascript={};')
  })

  it('retains Prism copying at production closeBundle without a development startup hook', async () => {
    const root = createProjectRoot()
    const plugin = runtimeAssetsPlugin('build', root)

    expect(plugin.configureServer).toBeUndefined()
    await invokeHook(plugin.closeBundle)

    expect(fs.readFileSync(path.join(root, 'assets/js/prism/prism-javascript.min.js'), 'utf8')).toBe('Prism.languages.javascript={};')
    expect(fs.existsSync(path.join(root, 'assets/svg/icon-tsepistle.svg'))).toBe(false)
  })
})
