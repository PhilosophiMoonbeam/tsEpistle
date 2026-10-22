import MarkdownIt from 'markdown-it'
import { load } from '@asciidoctor/core'
import { describe, expect, it } from '../../../../server/test/bun-test.mts'
import { mapAsciiDocDocument, markdownHeadings } from './source-outline'

const markdown = new MarkdownIt({ html: true })

describe('source editor contents', () => {
  it('uses Markdown heading tokens including setext and nested headings, but never code or HTML lookalikes', () => {
    const source = [
      '# Alpha **bold**',
      '',
      'Beta `code`',
      '---',
      '',
      '```md',
      '# Not a heading',
      '```',
      '',
      '    ## Not a heading either',
      '',
      '> ### Nested [link](https://example.com)',
      '',
      '<h2>Not a Markdown heading</h2>'
    ].join('\n')
    expect(markdownHeadings(markdown.parse(source, {}))).toEqual([
      { line: 0, level: 1, title: 'Alpha bold' },
      { line: 2, level: 2, title: 'Beta code' },
      { line: 11, level: 3, title: 'Nested link' }
    ])
  })

  it('replaces old outline positions after edits without needing a preview DOM', () => {
    const original = '# First\n\n## Second'
    expect(markdownHeadings(markdown.parse(original, {})).map(heading => heading.line)).toEqual([0, 2])
    const edited = '\n\n# First\n\n```\n## Second\n```'
    expect(markdownHeadings(markdown.parse(edited, {}))).toEqual([{ line: 2, level: 1, title: 'First' }])
  })

  it('maps actual AsciiDoc ATX/setext sections and blocks while keeping editor anchors out of ordinary conversion', async () => {
    const source = ['= Document', '', '== Alpha', '', '----', '== Not a heading', '----', '', 'Beta', '~~~~', '', 'Body'].join('\n')
    const options = { sourcemap: true, safe: 'secure', standalone: false }
    const document = await load(source, options)
    const headings = mapAsciiDocDocument(document)
    expect(headings.filter(heading => heading.title !== 'Document')).toEqual([
      { line: 2, level: 2, title: 'Alpha' },
      { line: 8, level: 3, title: 'Beta' }
    ])
    const editorHTML = await document.convert()
    expect(editorHTML).toContain('editor-source-line-2')
    expect(editorHTML).toContain('editor-source-line-4')
    expect(editorHTML).toContain('editor-source-line-8')
    const ordinary = await load(source, options)
    expect(await ordinary.convert()).not.toContain('editor-source-line-')
  })
})
