import { describe, expect, it } from './bun-test.mts'

import {
  createOkfPageDocument,
  exportOkfLinks,
  importOkfLinks,
  mutateOkfMetadata,
  OKF_MAX_DOCUMENT_BYTES,
  okfFilePath,
  OkfDocumentError,
  parseOkfFilePath,
  parseOkfDocument,
  renderOkfDocument,
  summarizeOkfTrust,
  validateStoredOkfMetadata
} from '../okf/format.ts'

const document = `---
type: Playbook
title: Incident response
description: Restore service safely.
tags: [oncall, recovery]
status: draft
generated: { by: agent/example, at: 2026-08-20T12:00:00Z }
verified: { by: human:42, at: 2026-08-21T12:00:00Z }
stale_after: 2026-09-01T00:00:00Z
sources:
  - id: runbook
    resource: https://example.com/runbook
extension_family:
  score: 7
---

# Steps

See [the service](/en/services/core).
`

describe('OKF v0.2 documents', () => {
  it('parses trust, lifecycle, provenance, and producer extensions', () => {
    const parsed = parseOkfDocument(document, new Date('2026-08-22T00:00:00Z'))
    expect(parsed).toMatchObject({
      version: '0.2',
      metadata: {
        type: 'Playbook',
        status: 'draft',
        tags: ['oncall', 'recovery'],
        extension_family: { score: 7 }
      },
      trust: {
        trustTier: 'human-reviewed',
        verification: 'current',
        status: 'draft',
        stale: false,
        verifiedAt: '2026-08-21T12:00:00Z'
      }
    })
    expect(parsed.body).toBe('# Steps\n\nSee [the service](/en/services/core).\n')
  })

  it('marks verification older than generation as outdated and honors stale_after', () => {
    const parsed = parseOkfDocument(
      document.replace('2026-08-21T12:00:00Z', '2026-08-19T12:00:00Z').replace('2026-09-01T00:00:00Z', '2026-08-21T00:00:00Z'),
      new Date('2026-08-22T00:00:00Z')
    )
    expect(parsed.trust).toMatchObject({ verification: 'outdated', stale: true })
  })

  it('renders deterministic frontmatter while preserving extensions', () => {
    const parsed = parseOkfDocument(document)
    const first = renderOkfDocument(parsed.metadata, parsed.body)
    const second = renderOkfDocument(parseOkfDocument(first).metadata, parseOkfDocument(first).body)
    expect(second).toBe(first)
    expect(first.indexOf('type: Playbook')).toBeLessThan(first.indexOf('extension_family:'))
  })

  it('bounds aggregate canonical frontmatter across validation, mutation, import, and rendering', () => {
    const atCap = {
      type: 'Reference',
      extension_a: 'x'.repeat(32_747),
      extension_b: 'x'.repeat(32_746)
    }
    const rendered = renderOkfDocument(atCap, '')
    const serialized = /^---\n([\s\S]*?)\n---/u.exec(rendered)?.[1]
    expect(Buffer.byteLength(serialized!, 'utf8')).toBe(65_536)
    expect(parseOkfDocument(rendered).metadata).toEqual(atCap)
    expect(validateStoredOkfMetadata(atCap)?.metadata).toEqual(atCap)

    const aboveCap = { ...atCap, extension_b: `${atCap.extension_b}x` }
    const oversizedKeys = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => [`extension_${String(index).padStart(4, '0')}_${'k'.repeat(50)}`, true])
    )
    expect(validateStoredOkfMetadata(aboveCap)).toBeNull()
    for (const operation of [
      () => renderOkfDocument(aboveCap, ''),
      () =>
        mutateOkfMetadata({
          existing: atCap,
          producer: 'import:disk',
          knowledgeChanged: true,
          at: '2026-08-22T00:00:00Z'
        }),
      () => renderOkfDocument({ type: 'Reference', ...oversizedKeys }, '')
    ])
      expect(operation).toThrow(expect.objectContaining<Partial<OkfDocumentError>>({ code: 'OKF_FRONTMATTER_TOO_LARGE' }))

    const values = Array.from({ length: 4_000 }, () => 'x').join(', ')
    const compactImport = `---\ntype: Reference\nextension: [${values}]\nfiller: ${'x'.repeat(50_000)}\n---\n`
    expect(Buffer.byteLength(/^---\n([\s\S]*?)\n---/u.exec(compactImport)![1]!, 'utf8')).toBeLessThanOrEqual(65_536)
    expect(() => parseOkfDocument(compactImport)).toThrow(
      expect.objectContaining<Partial<OkfDocumentError>>({ code: 'OKF_FRONTMATTER_TOO_LARGE' })
    )
  })

  it('rejects documents beyond the document byte ceiling', () => {
    expect(() => renderOkfDocument({ type: 'Reference' }, 'x'.repeat(OKF_MAX_DOCUMENT_BYTES))).toThrow(
      expect.objectContaining<Partial<OkfDocumentError>>({ code: 'OKF_DOCUMENT_TOO_LARGE' })
    )
  })

  it.each([
    ['missing frontmatter', '# Body', 'MISSING_OKF_FRONTMATTER'],
    ['missing type', '---\ntitle: No type\n---\n\nBody', 'INVALID_TYPE'],
    ['duplicate keys', '---\ntype: Reference\ntype: Playbook\n---\n\nBody', 'INVALID_OKF_YAML'],
    ['impossible timestamp', '---\ntype: Reference\nstale_after: 2026-02-30T00:00:00Z\n---\n\nBody', 'INVALID_STALE_AFTER'],
    ['invalid UTC offset', '---\ntype: Reference\nstale_after: 2026-08-22T00:00:00+14:01\n---\n\nBody', 'INVALID_STALE_AFTER']
  ])('rejects %s', (_label, value, code) => {
    expect(() => parseOkfDocument(value)).toThrow(expect.objectContaining<Partial<OkfDocumentError>>({ code }))
  })

  it('rejects aliases, merge expansion, and parser nesting beyond the JSON tree limit', () => {
    const recursiveAlias = '---\ntype: Reference\nextension: &extension [*extension]\n---\n'
    const mergedMapping = '---\ntype: Reference\ndefaults: &defaults { owner: platform }\nextension:\n  <<: *defaults\n---\n'
    const excessiveNesting = [
      '---',
      'type: Reference',
      'extension:',
      ...Array.from({ length: 20 }, (_, index) => `${'  '.repeat(index + 1)}level_${index}:`).map(
        (line, index, lines) => index === lines.length - 1 ? `${line} value` : line
      ),
      '---',
      ''
    ].join('\n')

    expect(Buffer.byteLength(recursiveAlias, 'utf8')).toBeLessThanOrEqual(65_536)
    for (const hostile of [recursiveAlias, mergedMapping, excessiveNesting])
      expect(() => parseOkfDocument(hostile)).toThrow(
        expect.objectContaining<Partial<OkfDocumentError>>({ code: 'INVALID_OKF_YAML' })
      )
  })

  it('strictly validates stored metadata before producing trust', () => {
    const metadata = {
      type: 'Reference',
      status: 'draft',
      verified: { by: 'human:7', at: '2026-08-22T12:00:00Z' }
    }
    expect(validateStoredOkfMetadata(metadata, new Date('2026-08-23T00:00:00Z'))).toEqual({
      metadata,
      trust: {
        trustTier: 'human-reviewed',
        verification: 'current',
        status: 'draft',
        stale: false,
        generatedAt: null,
        verifiedAt: '2026-08-22T12:00:00Z'
      }
    })
    for (const malformed of [
      { type: 'Reference', verified: { by: '', at: '2026-08-22T12:00:00Z' } },
      { type: 'Reference', verified: { by: 'human:7', at: '2026-08-22T12:00:00+14:01' } },
      { type: 'Reference', status: 'trusted', verified: { by: 'human:7', at: '2026-08-22T12:00:00Z' } }
    ])
      expect(validateStoredOkfMetadata(malformed)).toBeNull()
  })
})

describe('OKF page interchange', () => {
  it('maps Wiki links to portable concept files and back without touching assets or code', () => {
    const wiki = [
      'See [Core](/en/services/core#health) and [external](https://example.com/doc.md).',
      '![Diagram](/en/services/core)',
      '`[literal](/en/services/core)`',
      '`` `tick` [literal](/en/services/core) ``',
      '````md',
      '```',
      '[literal](/en/services/core)',
      '```',
      '````'
    ].join('\n')
    const exported = exportOkfLinks(wiki)
    expect(exported).toContain('[Core](/en/services/core.md#health)')
    expect(exported).toContain('![Diagram](/en/services/core)')
    expect(exported).toContain('`[literal](/en/services/core)`')
    expect(exported).toContain('`` `tick` [literal](/en/services/core) ``')
    expect(exported).toContain('````md\n```\n[literal](/en/services/core)\n```\n````')
    expect(importOkfLinks(exported, 'en', 'handbook/start')).toBe(wiki)
  })

  it('escapes reserved OKF filenames and imports relative concept links', () => {
    expect(okfFilePath('en', 'guides/index')).toBe('en/guides/index.concept.md')
    expect(importOkfLinks('See [Index](../index.concept.md).', 'en', 'guides/start')).toBe('See [Index](/en/index).')
  })

  it('safely inverts canonical OKF file paths only', () => {
    expect(parseOkfFilePath(okfFilePath('en', 'guides/start'))).toEqual({ locale: 'en', pagePath: 'guides/start' })
    expect(parseOkfFilePath(okfFilePath('en', 'index'))).toEqual({ locale: 'en', pagePath: 'index' })
    expect(parseOkfFilePath(okfFilePath('en', 'guides/Index'))).toEqual({ locale: 'en', pagePath: 'guides/Index' })
    expect(parseOkfFilePath('en/topic.concept.md')).toEqual({ locale: 'en', pagePath: 'topic.concept' })

    for (const invalid of [
      'home.md',
      '/en/home.md',
      'en/index.md',
      'en/guides/../home.md',
      'en//home.md',
      'en/.md',
      'en/home.markdown'
    ])
      expect(parseOkfFilePath(invalid)).toBeNull()
  })

  it('exports legacy pages as conformant concepts with explicit authorship', () => {
    const result = createOkfPageDocument({
      locale: 'en',
      path: 'handbook/start',
      title: 'Start here',
      description: 'Entry point.',
      tags: ['handbook'],
      content: '# Start here\n\nSee [Core](/en/services/core).\n',
      updatedAt: '2026-08-22T12:00:00Z',
      authorId: 7
    })
    expect(result).toMatchObject({
      version: '0.2',
      conceptId: 'en/handbook/start',
      filePath: 'en/handbook/start.md',
      metadata: { type: 'Reference', title: 'Start here', tags: ['handbook'], generated: { by: 'human:7' } },
      trust: { trustTier: 'unverified', status: 'stable' }
    })
    expect(result.markdown).toContain('[Core](/en/services/core.md)')
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('strictly mutates metadata, preserves extensions, and owns trust provenance', () => {
    const existing = {
      type: 'Metric',
      verified: { by: 'human:9', at: '2026-08-01T00:00:00Z' },
      generated: { by: 'human:7', at: '2026-08-01T00:00:00Z' },
      sources: [{ resource: 'https://example.com/source' }],
      vendor: { retained: true }
    }
    const noOp = mutateOkfMetadata({
      existing,
      proposed: { type: 'Metric', vendor: { retained: false } },
      producer: 'agent:run-12',
      knowledgeChanged: false,
      at: '2026-08-22T00:00:00Z'
    })
    expect(noOp).toMatchObject({
      generated: existing.generated,
      verified: existing.verified,
      vendor: { retained: false }
    })
    const changed = mutateOkfMetadata({
      existing,
      proposed: { type: 'Metric', vendor: { retained: false } },
      producer: 'agent:run-12',
      knowledgeChanged: true,
      at: '2026-08-22T00:00:00Z'
    })
    expect(changed).toMatchObject({
      generated: { by: 'agent:run-12', at: '2026-08-22T00:00:00Z' },
      verified: existing.verified,
      vendor: { retained: false }
    })
    expect(summarizeOkfTrust(changed)).toMatchObject({ trustTier: 'human-reviewed', verification: 'outdated' })
    expect(() => mutateOkfMetadata({
      existing,
      proposed: { type: 'Metric', verified: { by: '', at: '2026-08-01T00:00:00Z' } },
      producer: 'agent:run-12',
      knowledgeChanged: true
    })).toThrow(expect.objectContaining<Partial<OkfDocumentError>>({ code: 'INVALID_VERIFIED' }))
    expect(() => createOkfPageDocument({
      locale: 'en',
      path: 'bad',
      title: 'Bad',
      description: '',
      tags: [],
      content: '# Bad',
      updatedAt: '2026-08-22T12:00:00Z',
      authorId: 7,
      metadata: { type: 'Reference', tags: [''] }
    })).toThrow(expect.objectContaining<Partial<OkfDocumentError>>({ code: 'INVALID_TAGS' }))
  })

  it('replaces editable authority without replacing server-owned trust', () => {
    const existing = {
      type: 'Metric',
      resource: 'https://example.com/metric',
      sources: [{ resource: 'https://example.com/source' }],
      vendor: { retained: true },
      generated: { by: 'human:7', at: '2026-08-01T00:00:00Z' },
      verified: { by: 'human:9', at: '2026-08-02T00:00:00Z' },
      restored_from: { revision: '11', by: 'agent:restore-11', at: '2026-08-03T00:00:00Z' }
    }
    const replaced = mutateOkfMetadata({
      existing,
      proposed: {
        type: 'Metric',
        title: 'Current metric',
        generated: { by: 'human:999', at: '2026-08-20T00:00:00Z' },
        verified: { by: 'human:999', at: '2026-08-20T00:00:00Z' },
        restored_from: { revision: '999', by: 'human:999', at: '2026-08-20T00:00:00Z' }
      },
      producer: 'human:7',
      knowledgeChanged: true,
      mode: 'replace',
      at: '2026-08-22T00:00:00Z'
    })

    expect(replaced).toEqual({
      type: 'Metric',
      title: 'Current metric',
      generated: { by: 'human:7', at: '2026-08-22T00:00:00Z' },
      verified: existing.verified,
      restored_from: existing.restored_from
    })

    const merged = mutateOkfMetadata({
      existing,
      proposed: { type: 'Metric', title: 'Partial internal edit' },
      producer: 'agent:partial-edit',
      knowledgeChanged: false,
      at: '2026-08-22T00:00:00Z'
    })
    expect(merged).toMatchObject({
      resource: existing.resource,
      sources: existing.sources,
      vendor: existing.vendor,
      generated: existing.generated,
      verified: existing.verified,
      restored_from: existing.restored_from
    })
  })

  it('does not promote imported human claims to local verification', () => {
    const imported = mutateOkfMetadata({
      proposed: {
        type: 'Reference',
        verified: { by: 'human:9', at: '2026-08-01T00:00:00Z' },
        vendor: { source: 'external' }
      },
      producer: 'import:partner-run-4',
      knowledgeChanged: true,
      at: '2026-08-22T00:00:00Z'
    })
    expect(imported).toMatchObject({
      generated: { by: 'import:partner-run-4', at: '2026-08-22T00:00:00Z' },
      vendor: { source: 'external' }
    })
    expect(imported.verified).toBeUndefined()
    expect(summarizeOkfTrust(imported).trustTier).toBe('unverified')
  })

  it('records restore provenance without forging verification', () => {
    const restored = mutateOkfMetadata({
      existing: { type: 'Reference', verified: { by: 'human:4', at: '2026-08-01T00:00:00Z' } },
      proposed: { type: 'Reference', vendor: { historical: true } },
      producer: 'agent:restore-run-4',
      knowledgeChanged: true,
      at: '2026-08-22T00:00:00Z',
      restore: { revision: '17' }
    })
    expect(restored).toMatchObject({
      generated: { by: 'agent:restore-run-4', at: '2026-08-22T00:00:00Z' },
      verified: { by: 'human:4', at: '2026-08-01T00:00:00Z' },
      restored_from: { revision: '17', by: 'agent:restore-run-4', at: '2026-08-22T00:00:00Z' }
    })
    expect(summarizeOkfTrust(restored).verification).toBe('outdated')
  })
})
