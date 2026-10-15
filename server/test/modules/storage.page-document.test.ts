import { describe, expect, it } from '../bun-test.mts'

import type { StoragePageEncodingInput } from '../../modules/storage/page-document.ts'

Reflect.set(globalThis, 'WIKI', {
  config: { lang: { code: 'en' } },
  data: { reservedPaths: [] }
})
// Dynamic import is intentional: the page helper captures the test WIKI global during module initialization.
const { classifyStoragePageDocument, classifyStoragePageImport, encodeStoragePageDocument } = await import('../../modules/storage/page-document.ts')

const encodingInput = (isPublished: boolean): StoragePageEncodingInput => ({
  path: 'guides/start',
  localeCode: 'en',
  title: 'Start',
  description: 'A guide.',
  contentType: 'markdown',
  content: 'Body',
  sourceRevision: '17',
  authorId: 7,
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
  extra: {
    okf: {
      type: 'Procedure',
      status: 'draft',
      vendor_extension: { retained: true }
    }
  },
  isPublished,
  editorKey: 'markdown',
  tags: ['one']
})

const classify = (rawDocument: string) =>
  classifyStoragePageDocument({
    rawDocument,
    contentType: 'markdown',
    locale: 'en',
    pagePath: 'guides/start',
    importer: 'import:test',
    now: new Date('2026-08-31T00:00:00.000Z')
  })

describe('storage page-document x-wiki publication state', () => {
  it.each([false, true])('round-trips canonical published=%s without replacing metadata authority', isPublished => {
    const encoded = encodeStoragePageDocument(encodingInput(isPublished))
    if (typeof encoded !== 'object' || encoded === null || !('markdown' in encoded) || typeof encoded.markdown !== 'string')
      throw new TypeError('Expected an encoded OKF page document')

    const parsed = classify(encoded.markdown)

    expect(parsed).toMatchObject({
      format: 'okf_valid',
      isPublished,
      fields: { isPublished, tags: ['one'] },
      okfMetadata: {
        type: 'Procedure',
        status: 'draft',
        vendor_extension: { retained: true },
        'x-wiki': {
          published: isPublished,
          editor: 'markdown',
          source_revision: '17',
          created_at: '2026-08-29T00:00:00.000Z',
          updated_at: '2026-08-30T00:00:00.000Z'
        }
      },
      diagnostics: []
    })
  })

  it('leaves publication authority absent when no publication field is claimed and preserves extensions', () => {
    const parsed = classify(['---', 'type: Reference', 'x-wiki:', '  editor: external', 'vendor_extension:', '  retained: true', '---', '', 'Body'].join('\n'))

    expect(parsed).toMatchObject({
      format: 'okf_valid',
      fields: { tags: [] },
      okfMetadata: {
        'x-wiki': { editor: 'external' },
        vendor_extension: { retained: true }
      },
      diagnostics: []
    })
    expect(parsed.isPublished).toBeUndefined()
    expect(parsed.fields.isPublished).toBeUndefined()
  })

  it.each([
    ['a string publication field', 'x-wiki:\n  published: "false"'],
    ['a numeric publication field', 'x-wiki:\n  published: 1'],
    ['a null publication field', 'x-wiki:\n  published: null']
  ])('rejects %s as claimed invalid OKF instead of publishing or downgrading', (_name, extension) => {
    const parsed = classify(`---\ntype: Reference\n${extension}\n---\n\nBody`)

    expect(parsed.format).toBe('okf_invalid')
    expect(parsed.okfMetadata).toBeNull()
    expect(parsed.isPublished).toBeUndefined()
    expect(parsed.fields.isPublished).toBeUndefined()
    expect(parsed.diagnostics).toEqual([expect.stringContaining('x-wiki')])
  })
})

describe('storage page-document frontmatter safety', () => {
  it.each([
    ['bare type with LF', '---\ntype: Reference\n\nBody'],
    ['bare type with CRLF', '---\r\ntype: Reference\r\n\r\nBody'],
    ['quoted type', '---\n"type": Reference\n\nBody'],
    ['flow type', '---\n{type: Reference}\n\nBody']
  ])('quarantines unterminated %s frontmatter', (_name, source) => {
    const parsed = classify(source)

    expect(parsed.format).toBe('okf_invalid')
    expect(parsed.okfMetadata).toBeNull()
    expect(parsed.diagnostics).toEqual([expect.stringContaining('closing delimiter')])
  })

  it('quarantines oversized frontmatter', () => {
    const parsed = classify(`---\ntype: Reference\nfiller: ${'x'.repeat(65_536)}\n---\n\nBody`)

    expect(parsed.format).toBe('okf_invalid')
    expect(parsed.okfMetadata).toBeNull()
    expect(parsed.diagnostics).toEqual([expect.stringContaining('exceeds')])
  })

  it('keeps Markdown without an opening frontmatter delimiter unchanged', () => {
    const source = '# Heading\n\nText with --- inside it.'
    const parsed = classify(source)

    expect(parsed).toMatchObject({
      format: 'plain_markdown',
      body: source,
      fields: { tags: [] },
      diagnostics: []
    })
  })

  it.each([
    ['quoted type', '"type": Reference\nbroken: ['],
    ['flow type', '{type: Reference, broken: [}']
  ])('quarantines malformed %s frontmatter instead of downgrading it', (_name, frontmatter) => {
    const parsed = classify(`---\n${frontmatter}\n---\n\nBody`)

    expect(parsed.format).toBe('okf_invalid')
    expect(parsed.okfMetadata).toBeNull()
    expect(parsed.diagnostics).not.toEqual([])
  })

  it('keeps valid bounded non-OKF metadata on the legacy path', () => {
    const parsed = classify('---\ntitle: Legacy title\ntags: [one, two]\n---\n\nBody')

    expect(parsed).toMatchObject({
      format: 'legacy_wiki',
      body: 'Body',
      fields: { title: 'Legacy title', tags: ['one', 'two'] },
      diagnostics: []
    })
  })

  it('rejects aliases, merge expansion, and excessive nesting in legacy frontmatter', () => {
    const excessiveNesting = [
      'extension:',
      ...Array.from({ length: 20 }, (_, index) => `${'  '.repeat(index + 1)}level_${index}:`).map((line, index, lines) =>
        index === lines.length - 1 ? `${line} value` : line
      )
    ].join('\n')
    const hostileFrontmatter = ['extension: &extension [*extension]', 'defaults: &defaults { owner: platform }\nextension:\n  <<: *defaults', excessiveNesting]

    for (const frontmatter of hostileFrontmatter) {
      const source = `---\n${frontmatter}\n---\n\nBody`
      expect(Buffer.byteLength(source, 'utf8')).toBeLessThanOrEqual(65_536)
      expect(classify(source)).toMatchObject({ format: 'okf_invalid', okfMetadata: null })
    }
  })
})

describe('external storage ingestion policy', () => {
  const importSource = (source: string, contentType = 'markdown', relativePath = 'README.md') =>
    classifyStoragePageImport(
      {
        rawDocument: source,
        contentType,
        locale: 'en',
        pagePath: relativePath === 'README.md' ? 'README' : relativePath.replace(/\.[^.]+$/u, ''),
        importer: 'import:test',
        now: new Date('2026-08-31T00:00:00.000Z')
      },
      relativePath,
      { stripLeadingH1: true, mapReadmeToHome: true }
    )

  it.each([
    ['ATX Markdown', '# Welcome\n\nBody', 'markdown'],
    ['Setext Markdown', 'Welcome\n=======\n\nBody', 'markdown'],
    ['legacy Markdown', '---\ntitle: Metadata title\n---\n\n# Welcome\n\nBody', 'markdown'],
    ['AsciiDoc', '= Welcome\n\nBody', 'asciidoc']
  ])('strips only the leading %s heading and preserves source fingerprint', (_label, source, contentType) => {
    const imported = importSource(source, contentType)
    expect(imported.identity).toEqual({ locale: 'en', path: 'home' })
    expect(imported.document.body).toBe('Body')
    expect(imported.document.title).toBe(_label === 'legacy Markdown' ? 'Metadata title' : 'Welcome')
    expect(imported.document.sha256).toBe(classify(source).sha256)
  })

  it.each([
    ['heading-only Markdown', '# Welcome\n', 'markdown'],
    ['heading-only AsciiDoc', '= Welcome\n\n', 'asciidoc'],
    ['AsciiDoc author/revision', '= Welcome\nJane Doe <jane@example.test>\nv1.0, 2026-10-01\n\nBody', 'asciidoc'],
    ['AsciiDoc attributes', '= Welcome\n\n:toc:\n\nBody', 'asciidoc'],
    ['non-H1 Markdown', '## Welcome\n\nBody', 'markdown'],
    ['indented code', '    Welcome\n    =======\n\nBody', 'markdown'],
    ['a fenced heading', '```\n# Welcome\n```\n\nBody', 'markdown']
  ])('retains %s without emptying or corrupting the document', (_label, source, contentType) => {
    expect(importSource(source, contentType).document.body).toBe(source)
  })

  it.each([
    ['valid OKF', '---\ntype: Reference\n---\n\n# Retain\n\nBody', 'okf_valid'],
    ['invalid OKF', '---\ntype: [broken\n---\n\n# Retain\n\nBody', 'okf_invalid']
  ])('never maps or strips %s', (_label, source, format) => {
    const imported = importSource(source)
    expect(imported.identity).toEqual({ locale: 'en', path: 'README' })
    expect(imported.document).toEqual(classify(source))
    expect(imported.document.format).toBe(format)
  })

  it('does not map nested README or transform reserved concept sources', () => {
    expect(importSource('# Nested\n\nBody', 'markdown', 'docs/README.md').identity).toEqual({ locale: 'en', path: 'docs/README' })
    const reserved = importSource('# Index\n\nBody', 'markdown', 'index.concept.md')
    expect(reserved.document.body).toBe('# Index\n\nBody')
  })
})
