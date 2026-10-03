import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as cheerio from 'cheerio'
import { load } from 'js-yaml'
import { describe, expect, it } from '../bun-test.mts'
import renderer from '../../modules/rendering/asciidoc-core/renderer.ts'

const definitionUrl = new URL('../../modules/rendering/asciidoc-core/definition.yml', import.meta.url)

describe('AsciiDoc renderer security', () => {
  it('renders document content without reading local files under the shipped policy', async () => {
    const definition = load(await readFile(definitionUrl, 'utf8')) as { props: { safeMode: { default: string } } }
    const directory = await mkdtemp(path.join(os.tmpdir(), 'wiki-asciidoc-include-'))
    const previousDirectory = process.cwd()
    const canary = `Private filesystem content ${randomUUID()}`
    try {
      await writeFile(path.join(directory, 'canary.adoc'), canary)
      process.chdir(directory)
      const html = await renderer.render.call({
        config: { safeMode: definition.props.safeMode.default },
        input: '== Visible content\n\ninclude::canary.adoc[]'
      })
      const document = cheerio.load(html)
      expect(document('h2').text()).toBe('Visible content')
      expect(document.text()).not.toContain(canary)
    } finally {
      process.chdir(previousDirectory)
      await rm(directory, { recursive: true, force: true })
    }
  })
})
