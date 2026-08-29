import { describe, expect, it } from './bun-test.mts'

import {
  createOkfPageDocument,
  exportOkfLinks,
  importOkfLinks,
  okfFilePath,
  okfMetadataForHumanMutation,
  OkfDocumentError,
  parseOkfDocument,
  renderOkfDocument
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
    const parsed = parseOkfDocument(document
      .replace('2026-08-21T12:00:00Z', '2026-08-19T12:00:00Z')
      .replace('2026-09-01T00:00:00Z', '2026-08-21T00:00:00Z'), new Date('2026-08-22T00:00:00Z'))
    expect(parsed.trust).toMatchObject({ verification: 'outdated', stale: true })
  })

  it('renders deterministic frontmatter while preserving extensions', () => {
    const parsed = parseOkfDocument(document)
    const first = renderOkfDocument(parsed.metadata, parsed.body)
    const second = renderOkfDocument(parseOkfDocument(first).metadata, parseOkfDocument(first).body)
    expect(second).toBe(first)
    expect(first.indexOf('type: Playbook')).toBeLessThan(first.indexOf('extension_family:'))
  })

  it.each([
    ['missing frontmatter', '# Body', 'MISSING_OKF_FRONTMATTER'],
    ['missing type', '---\ntitle: No type\n---\n\nBody', 'INVALID_TYPE'],
    ['duplicate keys', '---\ntype: Reference\ntype: Playbook\n---\n\nBody', 'INVALID_OKF_YAML'],
    ['impossible timestamp', '---\ntype: Reference\nstale_after: 2026-02-30T00:00:00Z\n---\n\nBody', 'INVALID_STALE_AFTER']
  ])('rejects %s', (_label, value, code) => {
    expect(() => parseOkfDocument(value)).toThrow(expect.objectContaining<Partial<OkfDocumentError>>({ code }))
  })
})

describe('OKF page interchange', () => {
  it('maps Wiki links to portable concept files and back without touching assets or code', () => {
    const wiki = [
      'See [Core](/en/services/core#health) and [external](https://example.com/doc.md).',
      '![Diagram](/en/services/core)',
      '`[literal](/en/services/core)`',
      '```md',
      '[literal](/en/services/core)',
      '```'
    ].join('\n')
    const exported = exportOkfLinks(wiki)
    expect(exported).toContain('[Core](/en/services/core.md#health)')
    expect(exported).toContain('![Diagram](/en/services/core)')
    expect(exported).toContain('`[literal](/en/services/core)`')
    expect(exported).toContain('```md\n[literal](/en/services/core)\n```')
    expect(importOkfLinks(exported, 'en', 'handbook/start')).toBe(wiki)
  })

  it('escapes reserved OKF filenames and imports relative concept links', () => {
    expect(okfFilePath('en', 'guides/index')).toBe('en/guides/index.concept.md')
    expect(importOkfLinks('See [Index](../index.concept.md).', 'en', 'guides/start')).toBe('See [Index](/en/index).')
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

  it('stamps meaningful human changes without discarding trust or provenance', () => {
    expect(okfMetadataForHumanMutation({
      type: 'Metric',
      verified: { by: 'human:9', at: '2026-08-01T00:00:00Z' },
      sources: [{ resource: 'https://example.com/source' }],
      vendor: { retained: true }
    }, 12, '2026-08-22T00:00:00Z')).toEqual({
      type: 'Metric',
      verified: { by: 'human:9', at: '2026-08-01T00:00:00Z' },
      sources: [{ resource: 'https://example.com/source' }],
      vendor: { retained: true },
      generated: { by: 'human:12', at: '2026-08-22T00:00:00Z' }
    })
  })
})
