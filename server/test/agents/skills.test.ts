import { describe, expect, it } from '../bun-test.mts'

import { buildApprovedSkillBundle, parseSkillMarkdown, SkillValidationError } from '../../agents/skills/parser.ts'
import { SkillPathError, validateSkillVirtualPath } from '../../agents/skills/virtual-path.ts'

const skill = (body = 'Use [the API](references/API.md).\n') =>
  Buffer.from(
    `---\nname: release-notes\ndescription: Prepare release notes\nlicense: MIT\ncompatibility: tsEpistle\nmetadata:\n  owner: docs\nallowed-tools:\n  - wiki_search_pages\n  - wiki_get_page\nfuture-field: preserved\n---\n${body}`
  )

describe('page-native Agent Skill parsing', () => {
  it('parses exact UTF-8 bytes, preserves unknown metadata, and discovers relative resources', () => {
    const parsed = parseSkillMarkdown(skill(), 'release-notes')
    expect(parsed.frontmatter).toMatchObject({
      name: 'release-notes',
      description: 'Prepare release notes',
      metadata: { owner: 'docs' },
      allowedTools: ['wiki_get_page', 'wiki_search_pages'],
      unknown: { 'future-field': 'preserved' }
    })
    expect(parsed.references).toEqual(['references/API.md'])
    expect(parsed.bytes.equals(skill())).toBe(true)
    expect(parsed.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it.each([
    [Buffer.from('no frontmatter'), 'frontmatter'],
    [Buffer.from('---\nname: Wrong_Name\ndescription: valid\n---\nbody'), 'lowercase hyphens'],
    [Buffer.from('---\nname: release-notes\ndescription: valid\nmetadata: []\n---\nbody'), 'metadata'],
    [Buffer.from('---\nname: release-notes\ndescription: &shared valid\nother: *shared\n---\nbody'), 'aliases'],
    [skill('Read [remote](https://example.test/file.md).'), 'remote URLs'],
    [skill('<script>alert(1)</script>'), 'active content'],
    [skill('-----BEGIN PRIVATE KEY-----'), 'secret pattern']
  ])('rejects invalid skill input', (bytes, message) => {
    expect(() => parseSkillMarkdown(bytes, 'release-notes')).toThrow(message)
  })

  it.each(['../secret', '/absolute', 'references\\API.md', 'references/%2e%2e/secret', 'references//API.md', 'references/./API.md'])(
    'rejects unsafe virtual path %s',
    path => {
      expect(() => validateSkillVirtualPath(path)).toThrow(SkillPathError)
    }
  )
})

describe('immutable skill bundles', () => {
  const reference = {
    path: 'references/API.md',
    bytes: Buffer.from('# API\n'),
    mediaType: 'text/markdown; charset=utf-8',
    sourceId: 'page:42',
    sourceRevision: '7'
  }

  it('builds a deterministic bounded manifest and marks scripts non-executable', () => {
    const entry = skill('Read [the API](references/API.md) and [the helper](scripts/check.js).\n')
    const resources = [
      reference,
      {
        path: 'scripts/check.js',
        bytes: Buffer.from('export const check = true\n'),
        mediaType: 'application/javascript',
        sourceId: 'asset:9',
        sourceRevision: 'sha256:asset'
      }
    ]
    const first = buildApprovedSkillBundle(entry, 'release-notes', resources)
    const second = buildApprovedSkillBundle(entry, 'release-notes', [...resources].reverse())
    expect(first.contentHash).toBe(second.contentHash)
    expect(first.manifestJson).toBe(second.manifestJson)
    expect(first.resources.map(resource => [resource.path, resource.executable])).toEqual([
      ['references/API.md', false],
      ['scripts/check.js', false]
    ])
  })

  it('rejects missing, extra, and active resources', () => {
    let missingResourceError: unknown
    try {
      buildApprovedSkillBundle(skill(), 'release-notes', [])
    } catch (error) {
      missingResourceError = error
    }
    expect(missingResourceError).toBeInstanceOf(SkillValidationError)
    expect(missingResourceError).toMatchObject({ message: expect.stringContaining('missing') })
    expect(() => buildApprovedSkillBundle(skill('No resources.\n'), 'release-notes', [reference])).toThrow('not explicitly referenced')
    expect(() =>
      buildApprovedSkillBundle(skill('Use [HTML](references/page.html).'), 'release-notes', [
        {
          ...reference,
          path: 'references/page.html',
          bytes: Buffer.from('<script>alert(1)</script>'),
          mediaType: 'text/html'
        }
      ])
    ).toThrow('blocked media type')
  })
})
