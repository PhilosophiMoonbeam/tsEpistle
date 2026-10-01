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
  const ide = path.join(root, 'node_modules/@graphql-yoga/graphiql')
  fs.mkdirSync(path.join(ide, 'dist/monacoeditorwork'), { recursive: true })
  fs.writeFileSync(path.join(ide, 'package.json'), '{"version":"4.4.4"}')
  fs.writeFileSync(path.join(ide, 'LICENSE'), 'MIT fixture')
  for (const file of ['yoga-graphiql.umd.js', 'graphiql.css', 'monacoeditorwork/editor.worker.bundle.js']) {
    fs.writeFileSync(path.join(ide, 'dist', file), file === 'graphiql.css' ? '.graphiql-container{color:green}' : 'fixture asset')
  }
  return root
}

const invokeHook = async (hook: unknown): Promise<void> => {
  await (hook as () => Promise<void>)()
}

describe('Vite runtime asset lifecycle', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true })
  })

  it('provisions same-origin static and Prism assets when the development server starts', async () => {
    const root = createProjectRoot()
    const plugin = runtimeAssetsPlugin('serve', root)

    await invokeHook(plugin.configureServer)

    expect(fs.readFileSync(path.join(root, 'assets/svg/icon-tsepistle.svg'), 'utf8')).toBe('<svg />')
    expect(fs.readFileSync(path.join(root, 'assets/js/prism/prism-javascript.min.js'), 'utf8')).toBe('Prism.languages.javascript={};')
    expect(fs.readFileSync(path.join(root, 'assets/graphiql/4.4.4/yoga-graphiql.umd.js'), 'utf8')).toBe('fixture asset')
    expect(fs.readFileSync(path.join(root, 'assets/graphiql/4.4.4/graphiql.css'), 'utf8')).toBe('.graphiql-container{color:green}')
    expect(fs.readFileSync(path.join(root, 'assets/graphiql/4.4.4/monacoeditorwork/editor.worker.bundle.js'), 'utf8')).toBe('fixture asset')
  })

  it('provisions Prism and same-origin IDE assets at production build completion', async () => {
    const root = createProjectRoot()
    const plugin = runtimeAssetsPlugin('build', root)

    await invokeHook(plugin.closeBundle)

    expect(fs.readFileSync(path.join(root, 'assets/js/prism/prism-javascript.min.js'), 'utf8')).toBe('Prism.languages.javascript={};')
    expect(fs.readFileSync(path.join(root, 'assets/graphiql/4.4.4/yoga-graphiql.umd.js'), 'utf8')).toBe('fixture asset')
    expect(fs.readFileSync(path.join(root, 'assets/graphiql/4.4.4/graphiql.css'), 'utf8')).toBe('.graphiql-container{color:green}')
    expect(fs.readFileSync(path.join(root, 'assets/graphiql/4.4.4/monacoeditorwork/editor.worker.bundle.js'), 'utf8')).toBe('fixture asset')
  })

  it('rejects mismatched IDE assets before shipping a broken editor', async () => {
    const root = createProjectRoot()
    fs.writeFileSync(path.join(root, 'node_modules/@graphql-yoga/graphiql/package.json'), '{"version":"4.4.3"}')
    await expect(invokeHook(runtimeAssetsPlugin('build', root).closeBundle)).rejects.toThrow(Error)
    expect(fs.existsSync(path.join(root, 'assets/graphiql/4.4.4'))).toBe(false)
  })
})
