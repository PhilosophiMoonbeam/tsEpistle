import { describe, expect, it } from '../bun-test.mts'

import {
  getSourceCodeLiteral,
  parseSourceDocument,
  type ParsedSourceDocument,
  type SourceSpan,
  type SourceUnit
} from '../../agents/providers/source-document.ts'
import { getLiteralSourceStatement, isLiteralSourceClaim } from '../../agents/providers/wiki-source-quotation.ts'
import { admittedWikiBody } from '../../agents/providers/wiki-source-view.ts'
import type { WikiVerificationSource } from '../../agents/providers/wiki-verification.ts'

const parse = (source: string): ParsedSourceDocument => parseSourceDocument(source, { representation: 'markdown', truncated: false })
const slices = (document: ParsedSourceDocument, spans: readonly SourceSpan[]): string[] => spans.map(span => document.source.slice(span.start, span.end))
const member = (document: ParsedSourceDocument, text: string): SourceUnit => {
  const result = document.units.find(unit => unit.normalizedText === text)
  if (!result) throw new Error(`Missing visible source unit: ${text}`)
  return result
}
const labels = (document: ParsedSourceDocument, unit: SourceUnit): string[] =>
  unit.contextIds.map(id => document.contexts.find(context => context.id === id)!.normalizedLabel)

// These cases protect the parser's offset/dependency and ownership boundary.
// Layout acceptance and adversarial publication are exercised in engine tests.
describe('source document original-source dependencies', () => {
  it('keeps UTF-16 CRLF offsets, repeated-location identity, and reference definitions outside a section', () => {
    const title = '# Café😀\r\n\r\n'
    const first = 'A **same** [Guide][g].\r\n\r\n'
    const child = '## Child\r\n\r\n'
    const repeated = 'A **same** [Guide][g].\r\n\r\n'
    const definition = '[g]: /en/guide "Not factual vocabulary"\r\n'
    const document = parse(title + first + child + repeated + definition)
    const copies = document.units.filter(unit => unit.normalizedText === 'A same Guide.')
    expect(copies.map(unit => unit.sourceSpans)).toEqual([
      [{ start: title.length, end: title.length + first.length - 2 }],
      [{ start: title.length + first.length + child.length, end: title.length + first.length + child.length + repeated.length - 2 }]
    ])
    expect(copies[0]!.id).not.toBe(copies[1]!.id)
    expect(slices(document, copies[0]!.sourceSpans)).toEqual(['A **same** [Guide][g].\r\n'])
    expect(document.sections.map(section => section.ancestry)).toEqual([['Café😀'], ['Café😀', 'Child']])
    expect(document.sections[0]!.unitIds).toContain(copies[1]!.id)
    expect(document.sections[1]!.unitIds).toContain(copies[1]!.id)
    expect(document.sections[1]!.unitIds).not.toContain(copies[0]!.id)
    expect(copies[1]!.links.map(link => ({ label: link.label, destination: link.destination, kind: link.kind, unitId: link.unitId }))).toEqual([
      { label: 'Guide', destination: '/en/guide', kind: 'link', unitId: copies[1]!.id }
    ])
    expect(copies[1]!.structuralLabels).toEqual(['Guide'])
    expect(slices(document, copies[1]!.links[0]!.dependencySpans)).toEqual([definition])
    expect(document.units.some(unit => unit.normalizedText.includes('Not factual vocabulary'))).toBe(false)
  })

  it.each([
    ['heading', '# [Ada][a]\n\nRoute: east.\n\n'],
    ['summary', '<details><summary>[Ada][a]</summary>\nRoute: east.\n</details>\n\n'],
    ['table-header', '[Name][a] | Route\n--- | ---\nAda | east\n\n']
  ] as const)('includes reference definitions required by a %s context', (kind, body) => {
    const definition = '[a]: /people/ada\n'
    const document = parse(body + definition)
    const context = document.contexts.find(item => item.kind === kind)!
    expect(slices(document, context.sourceSpans)).toContain(definition)
    expect(context.complete).toBe(true)
    const truncated = parseSourceDocument(body + definition.trimEnd(), { representation: 'recent-excerpt', truncated: true })
    expect(truncated.contexts.find(item => item.kind === kind)!.complete).toBe(false)
  })

  it('does not attach a same-destination reference dependency to an inline link', () => {
    const document = parse('[Inline](/route) and [Reference][r].\n\n[r]: /route\n')
    const links = member(document, 'Inline and Reference.').links
    expect(links[0]!.dependencySpans).toEqual([])
    expect(slices(document, links[1]!.dependencySpans)).toEqual(['[r]: /route\n'])
  })

  it('resolves one reference environment across bounded Markdown disclosure runs', () => {
    const document = parse('<details><summary>Manual</summary>\n- [Guide][g]\n</details>\n\n[g]: /guide/a_(b)\n')
    const guide = member(document, 'Guide')
    expect(labels(document, guide)).toContain('Manual')
    expect(guide.links[0]!.destination).toBe('/guide/a_(b)')
    expect(slices(document, guide.links[0]!.dependencySpans)).toEqual(['[g]: /guide/a_(b)\n'])
  })

  it('uses the first original reference definition rather than bounded-run parsing order', () => {
    const document = parse('<details><summary>Manual</summary>\n[g]: /first\n\n[Guide][g]\n</details>\n\n[g]: /later\n')
    const guide = member(document, 'Guide')
    expect(guide.links[0]!.destination).toBe('/first')
    expect(slices(document, guide.links[0]!.dependencySpans)).toEqual(['[g]: /first\n'])
  })

  it('binds canonical OKF body units to original document offsets and excludes metadata', () => {
    const frontmatter = '---\r\ntype: Procedure\r\ntitle: Metadata owner\r\ndescription: Metadata facts 999\r\n---\r\n\r\n'
    const document = parseSourceDocument(frontmatter + '# Body😀\r\n\r\nActual facts 12.\r\n', { representation: 'okf', truncated: false })
    expect(document.units.map(unit => unit.normalizedText)).toEqual(['Body😀', 'Actual facts 12.'])
    expect(document.units[0]!.sourceSpans).toEqual([{ start: frontmatter.length, end: frontmatter.length + '# Body😀\r\n'.length }])
    expect(slices(document, document.units[1]!.sourceSpans)).toEqual(['Actual facts 12.\r\n'])
  })
})

describe('source document explicit ownership', () => {
  it('keeps a prose clock inside its exact complete literal source statement', () => {
    const text = 'Cedar warehouse closes at 18:30 on Fridays.'
    const document = parse(text)
    const unit = member(document, text)
    const source: WikiVerificationSource = {
      evidenceId: 'read:clock',
      sourceRevision: 'revision:clock',
      unitId: unit.id,
      context: '',
      text: unit.normalizedText,
      kind: unit.kind,
      complete: unit.complete,
      closure: {
        unit,
        units: document.units,
        contexts: document.contexts,
        record: document.records[0] ?? null,
        links: unit.links,
        dependencies: unit.sourceSpans.map(span => ({ span, text: document.source.slice(span.start, span.end) }))
      }
    }
    expect(getLiteralSourceStatement(source)).toBe(text)
    expect(isLiteralSourceClaim({ evidenceId: source.evidenceId, sourceRevision: source.sourceRevision, unitId: source.unitId, statement: text }, source)).toBe(
      true
    )
    expect(unit.kind).toBe('paragraph')
    expect(unit.complete).toBe(true)
    expect(unit.recordId).toBeNull()
    expect(document.records).toEqual([])
  })

  it.each(['Hours:18:30\n', 'Hours: 18:30\n', '| Hours |\n| --- |\n| 18:30 |\n'])(
    'retains authored Hours field ownership and its complete clock value: %s',
    text => {
      const document = parse(text)
      const record = document.records[0]!
      expect(record.complete).toBe(true)
      expect(record.fields.map(field => [field.label, field.value])).toEqual([['Hours', '18:30']])
      const field = record.fields[0]!
      const unit = document.units.find(entry => entry.id === field.unitIds[0])!
      expect(unit.recordId).toBe(record.id)
      expect(unit.complete).toBe(true)
    }
  )

  it('adds complete list ownership without changing original item or later assertion identities', () => {
    const document = parse('- Ada\n- Bea\n\nOutside.\n')
    const ada = member(document, 'Ada')
    const bea = member(document, 'Bea')
    expect(ada.id).toBe('unit:0:6:2')
    expect(ada.contextIds).toEqual(['context:0:6:0'])
    expect(ada.recordId).toBe('record:0:6:1')
    expect(ada.kind).toBe('list-item')
    expect(bea.recordId).not.toBe(ada.recordId)
    expect(member(document, 'Outside.').id).toBe('unit:13:22:6')
    const container = document.units.find(unit => unit.kind === 'list')!
    expect(container.recordId).toBeNull()
    expect(slices(document, container.sourceSpans)).toEqual(['- Ada\n- Bea\n\n'])
    expect(document.records.find(record => record.id === ada.recordId)!.unitIds).toEqual([ada.id])
  })

  it('assigns appended containers to only their original heading sections', () => {
    const first = '- First\n\n'
    const second = '1. Second\n'
    const document = parse(`# Root\n\n${first}## Child\n\n${second}`)
    const parent = member(document, first)
    const child = member(document, second)
    expect(labels(document, parent)).toEqual(['Root'])
    expect(labels(document, child)).toEqual(['Root', 'Child'])
    expect(document.sections[0]!.unitIds).toContain(parent.id)
    expect(document.sections[0]!.unitIds).toContain(child.id)
    expect(document.sections[1]!.unitIds).toContain(child.id)
    expect(document.sections[1]!.unitIds).not.toContain(parent.id)
  })

  it('keeps nested labeled fields with their actual list identity and parent condition', () => {
    const document = parse(
      '# Operations\n\n- Only during maintenance:\n  - Ada\n    - **Channel:** east\n    - Window: before 17:00\n  - Bea\n    - Channel: west\n'
    )
    const ada = document.records.find(record => record.fields.some(field => field.value === 'east'))!
    const bea = document.records.find(record => record.fields.some(field => field.value === 'west'))!
    expect(ada.fields.map(field => [field.label, field.value, field.order])).toEqual([
      ['Channel', 'east', 0],
      ['Window', 'before 17:00', 1]
    ])
    expect(bea.fields.map(field => [field.label, field.value])).toEqual([['Channel', 'west']])
    const east = member(document, 'Channel: east')
    expect(east.recordId).toBe(ada.id)
    expect(labels(document, east)).toEqual(['Operations', 'Only during maintenance:', 'Ada', 'Channel: east'])
    expect(labels(document, member(document, 'Channel: west'))).not.toContain('Ada')
    expect(ada.contextIds.map(id => document.contexts.find(context => context.id === id)!.normalizedLabel)).toEqual([
      'Operations',
      'Only during maintenance:',
      'Ada'
    ])
    expect(slices(document, east.sourceSpans)).toEqual(['    - **Channel:** east\n'])
  })

  it('keeps loose/lazy continuations in their list item without joining independent paragraphs', () => {
    const document = parse(
      '- Ada handles east\n  only before 17:00.\n\n  Requests must be approved.\n\n- Bea handles west.\n\nAda owns a pager.\n\nAda travels tomorrow.\n'
    )
    const ada = member(document, 'Ada handles east only before 17:00.')
    const approval = member(document, 'Requests must be approved.')
    expect(ada.recordId).toBe(approval.recordId)
    expect(member(document, 'Bea handles west.').recordId).not.toBe(ada.recordId)
    expect(member(document, 'Ada owns a pager.').recordId).toBeNull()
    expect(member(document, 'Ada travels tomorrow.').recordId).toBeNull()
  })

  it('gives multiline labeled fields distinct link-owning identities even with shared enclosing spans', () => {
    const document = parse('Name: Ada\nPrimary: [desk](/east)\nSecondary: [desk](/west)\n')
    const record = document.records[0]!
    expect(record.fields.map(field => [field.label, field.value, field.order])).toEqual([
      ['Name', 'Ada', 0],
      ['Primary', 'desk', 1],
      ['Secondary', 'desk', 2]
    ])
    const primary = document.units.find(unit => unit.id === record.fields[1]!.unitIds[0])!
    const secondary = document.units.find(unit => unit.id === record.fields[2]!.unitIds[0])!
    expect(primary.links.map(link => link.destination)).toEqual(['/east'])
    expect(secondary.links.map(link => link.destination)).toEqual(['/west'])
    expect(primary.id).not.toBe(secondary.id)
    expect(slices(document, primary.sourceSpans)).toEqual(['Name: Ada\nPrimary: [desk](/east)\nSecondary: [desk](/west)\n'])
  })

  it('preserves delimiter-separated field associations and their local links without splitting literals', () => {
    const source = 'Name: Ada | Primary: [desk](/east); Secondary: [desk](/west) | Token: `value; Fake: field`\n'
    const document = parse(source)
    const record = document.records[0]!
    expect(record.fields.map(field => [field.label, field.value])).toEqual([
      ['Name', 'Ada'],
      ['Primary', 'desk'],
      ['Secondary', 'desk'],
      ['Token', '`value; Fake: field`']
    ])
    const primary = document.units.find(unit => unit.id === record.fields[1]!.unitIds[0])!
    const secondary = document.units.find(unit => unit.id === record.fields[2]!.unitIds[0])!
    expect(primary.links.map(link => link.destination)).toEqual(['/east'])
    expect(secondary.links.map(link => link.destination)).toEqual(['/west'])
    expect(slices(document, primary.sourceSpans)).toEqual([source])
  })

  it.each([
    '| Name | Primary | Secondary |\n| --- | --- | --- |\n| Ada | [desk](/east) | [desk](/west) |\n',
    'Name | Primary | Secondary\n--- | --- | ---\nAda | [desk](/east) | [desk](/west)\n'
  ])('preserves table column order and same-label link ownership: %s', source => {
    const document = parse(source)
    const record = document.records[0]!
    expect(record.fields.map(field => [field.label, field.value, field.order])).toEqual([
      ['Name', 'Ada', 0],
      ['Primary', 'desk', 1],
      ['Secondary', 'desk', 2]
    ])
    const primary = document.units.find(unit => unit.id === record.fields[1]!.unitIds[0])!
    const secondary = document.units.find(unit => unit.id === record.fields[2]!.unitIds[0])!
    expect(primary.links.map(link => link.destination)).toEqual(['/east'])
    expect(secondary.links.map(link => link.destination)).toEqual(['/west'])
    expect(primary.id).not.toBe(secondary.id)
    expect(slices(document, primary.sourceSpans)).toEqual([source.split('\n')[2]! + '\n'])
    const header = document.contexts.find(context => context.kind === 'table-header')!
    expect(slices(document, header.sourceSpans)).toEqual([source.split('\n').slice(0, 2).join('\n') + '\n'])
    const container = document.units.find(unit => unit.kind === 'table')!
    expect(container.normalizedText).toBe(source)
    expect(slices(document, container.sourceSpans)).toEqual([source])
    expect(container.recordId).toBeNull()
    expect(container.contextIds).toEqual([])
    expect(container.links.map(link => [link.label, link.destination, link.unitId])).toEqual([
      ['desk', '/east', container.id],
      ['desk', '/west', container.id]
    ])
    expect(record.unitIds).not.toContain(container.id)
    expect(document.units.indexOf(container)).toBeGreaterThan(document.units.indexOf(secondary))
  })

  it('retains bare email identity values without borrowing their destination vocabulary', () => {
    const document = parse('Name: Maya\nEmail: maya@example.test\n')
    expect(document.records[0]!.fields.map(field => [field.label, field.value])).toEqual([
      ['Name', 'Maya'],
      ['Email', 'maya@example.test']
    ])
    const email = member(document, 'Email: maya@example.test')
    expect(email.links.map(link => [link.label, link.destination, link.kind])).toEqual([['maya@example.test', 'mailto:maya@example.test', 'autolink']])
    expect(email.normalizedText).not.toContain('mailto:')
  })

  it('leaves duplicate field labels and merged-cell tables unestablished', () => {
    const duplicate = parse('- Ada\n  - Route: east\n  - Route: west\n')
    const record = duplicate.records.find(item => item.fields.length === 2)!
    expect(record.complete).toBe(false)
    expect(record.fields.map(field => field.complete)).toEqual([false, false])
    const table = parse('<table><tr><th>Name</th><th>Route</th></tr><tr><td colspan="2">Ada east</td></tr></table>')
    expect(table.records.every(item => !item.complete)).toBe(true)
    expect(table.records.flatMap(item => item.fields)).toEqual([])
  })

  it('marks EOF-cut recent assertions and records incomplete while retaining bounded earlier facts', () => {
    const document = parseSourceDocument('Earlier fact.\n\nName: Ada\nRoute: east', { representation: 'recent-excerpt', truncated: true })
    expect(member(document, 'Earlier fact.').complete).toBe(true)
    expect(member(document, 'Route: east').complete).toBe(false)
    expect(document.records[0]!.complete).toBe(false)
    expect(document.records[0]!.fields.every(field => !field.complete)).toBe(true)
  })

  it.each([
    'Recent page 10 records release delta 10.',
    '**Maya Quinn approves release.**',
    '"Maya Quinn approves release."',
    'Maya Quinn operates `release`.',
    'Maya Quinn approves release.\r\n'
  ])('retains a syntactically closed ordinary EOF assertion: %s', source => {
    const document = parseSourceDocument(source, { representation: 'recent-excerpt', truncated: true })
    expect(document.units[0]?.complete).toBe(true)
    expect(document.records).toEqual([])
  })

  it.each([
    'Maya Quinn approves release',
    'Maya Quinn approves release. Unfinished continuation',
    'Maya Quinn reports to Dr.',
    'Maya Quinn reports to J.',
    'Maya Quinn reads node.config.',
    'Maya Quinn waits...',
    'Maya Quinn operates `release.`',
    'Maya Quinn references <https://example.test/release.>',
    '**Maya Quinn approves release.',
    '"Maya Quinn approves release.',
    '<span>Maya Quinn approves release.'
  ])('does not manufacture EOF sentence closure from incomplete or opaque syntax: %s', source => {
    const document = parseSourceDocument(source, { representation: 'recent-excerpt', truncated: true })
    expect(document.units.every(unit => !unit.complete)).toBe(true)
  })

  it('does not complete EOF records or required reference definitions from their periods', () => {
    const record = parseSourceDocument('Name: Ada.\nRoute: east.', { representation: 'recent-excerpt', truncated: true })
    expect(record.records[0]?.complete).toBe(false)
    expect(record.units.every(unit => !unit.complete)).toBe(true)
    const reference = parseSourceDocument('The [manual][ref] covers recovery.\n\n[ref]: https://example.test/recovery.', {
      representation: 'recent-excerpt',
      truncated: true
    })
    expect(reference.units[0]?.complete).toBe(false)
  })
})

describe('source document private literal code bodies', () => {
  it.each([
    ['fenced', '```text\n\talpha\n\n&amp; &#65;\n```\n', '\talpha\n\n&amp; &#65;\n'],
    ['indented', '    alpha\n    \tbeta\n\n    gamma\n', 'alpha\n\tbeta\n\ngamma\n'],
    [
      'nested blockquote',
      '> > `````text\n> > \talpha\n> >\n> > ````mermaid\n> > graph LR\n> > ````\n> > &amp;\n> > `````\n',
      '\talpha\n\n````mermaid\ngraph LR\n````\n&amp;\n'
    ],
    ['CRLF', '```\r\nalpha\r\n\r\nbeta\r\n```\r\n', 'alpha\n\nbeta\n'],
    ['empty fenced', '```\n```\n', '']
  ])('returns the parser-rendered %s body without changing native source projections', (_, raw, literal) => {
    const document = parse(raw)
    const unit = document.units.find(unit => unit.kind === 'code')!
    expect(getSourceCodeLiteral(unit, raw)).toBe(literal)
    expect(unit.visibleText).toBe(raw)
    expect(unit.normalizedText).toBe(raw.replace(/\s+/gu, ' ').trim())
    expect(unit.sourceSpans).toEqual([{ start: 0, end: raw.length }])
    expect(unit.links).toEqual([])
    expect(admittedWikiBody(document)).toBe(raw)
  })

  it.each([
    ['<pre><code>\t&lt;script&gt;&amp; &#65;\n\n</code></pre>', '\t<script>& A\n\n'],
    ['<pre>\nalpha\n</pre>', 'alpha\n'],
    ['<code>&lt;x&gt;&amp;</code>', '<x>&'],
    ['<pre><code></code></pre>', '']
  ])('uses only exact admitted HTML code text, including entities and absent terminal LF: %s', (raw, literal) => {
    const unit = parse(raw).units.find(unit => unit.kind === 'code')!
    expect(getSourceCodeLiteral(unit, raw)).toBe(literal)
    expect(unit.sourceSpans).toEqual([{ start: 0, end: raw.length }])
  })

  it('rejects foreign sources, forged identities, and changed unit provenance', () => {
    const raw = '# Scope\n\n> ```\n> alpha\n> ```\n'
    const original = parse(raw).units.find(unit => unit.kind === 'code')!
    expect(getSourceCodeLiteral(original, raw)).toBe('alpha\n')
    expect(getSourceCodeLiteral({ ...original }, raw)).toBeNull()
    expect(getSourceCodeLiteral(original, `${raw}\nForeign appendix.\n`)).toBeNull()
    const mutations: Array<(unit: SourceUnit) => void> = [
      unit => {
        Object.assign(unit.sourceSpans[0]!, { start: 0 })
      },
      unit => {
        Object.assign(unit.sourceSpans[0]!, { end: raw.length - 1 })
      },
      unit => {
        Object.assign(unit, { complete: false })
      },
      unit => {
        Object.assign(unit, { visibleText: 'alpha\n' })
      },
      unit => {
        Object.assign(unit, { normalizedText: 'alpha' })
      },
      unit => {
        Object.assign(unit, { contextIds: [] })
      },
      unit => {
        Object.assign(unit, { id: 'forged' })
      }
    ]
    for (const mutate of mutations) {
      const unit = parse(raw).units.find(unit => unit.kind === 'code')!
      mutate(unit)
      expect(getSourceCodeLiteral(unit, raw)).toBeNull()
    }
  })

  it('does not register truncated, hidden, masked, or repaired HTML bodies', () => {
    for (const [raw, literal] of [
      ['```\nalpha\n', 'alpha\n'],
      ['```\nalpha\n\n', 'alpha\n\n'],
      ['    alpha\n\n', 'alpha\n'],
      ['```\nalpha\n```', 'alpha\n']
    ]) {
      const whole = parse(raw).units.find(unit => unit.kind === 'code')!
      expect(getSourceCodeLiteral(whole, raw)).toBe(literal)
      const cut = parseSourceDocument(raw, { representation: 'recent-excerpt', truncated: true }).units.find(unit => unit.kind === 'code')!
      expect(getSourceCodeLiteral(cut, raw)).toBeNull()
      Object.assign(cut, { complete: true })
      expect(getSourceCodeLiteral(cut, raw)).toBeNull()
    }
    for (const source of [
      '<pre hidden><code>secret</code></pre>',
      '<div style="display:none"><pre>secret</pre></div>',
      '<pre><code>visible<span hidden>secret</span></code></pre>',
      '<pre><script>secret</script>visible</pre>',
      '<pre><code>unclosed</pre>',
      '<pre><code>`<x>`</code></pre>',
      '> <pre><code>\n> alpha\n> </code></pre>\n'
    ]) {
      const document = parse(source)
      expect(document.units.every(unit => getSourceCodeLiteral(unit, source) === null)).toBe(true)
    }
    const prose = parse('alpha\n').units[0]!
    expect(getSourceCodeLiteral(prose, 'alpha\n')).toBeNull()
  })

  it('proves a recent code boundary from a terminated closing fence or an observed dedent', () => {
    for (const raw of ['```\nalpha\n```\n', '~~~text\nalpha\n~~~~\n', '    alpha\n\nVisible next paragraph.']) {
      const code = parseSourceDocument(raw, { representation: 'recent-excerpt', truncated: true }).units.find(unit => unit.kind === 'code')!
      expect(getSourceCodeLiteral(code, raw)).toBe('alpha\n')
    }
  })
})

describe('source document HTML and opaque literal boundaries', () => {
  it('restores headings and disclosure scope after same-line and nested details', () => {
    const document = parse(
      '# Root\n\n<details><summary>Only on Monday</summary>\n## Internal\n<details><summary>Inner</summary>- **Route:** east\n</details>\n- Route: north\n</details>\n<details><summary>Tuesday</summary>- Route: west</details>\n\nAfterwards.\n\nChild\n-----\n\nBody.\n'
    )
    expect(document.sections.map(section => [section.ancestry, section.syntax])).toEqual([
      [['Root'], 'atx'],
      [['Root', 'Child'], 'setext']
    ])
    expect(labels(document, member(document, 'Route: east'))).toContain('Inner')
    expect(labels(document, member(document, 'Route: north'))).not.toContain('Inner')
    expect(labels(document, member(document, 'Route: west'))).toContain('Tuesday')
    expect(labels(document, member(document, 'Route: west'))).not.toContain('Only on Monday')
    expect(labels(document, member(document, 'Afterwards.'))).toEqual(['Root'])
    expect(labels(document, member(document, 'Body.'))).toEqual(['Root', 'Child'])
  })

  it('projects HTML anchors and simple rows without allowing attributes, scripts, templates or comments as facts', () => {
    const document = parse(
      '<div data-owner="Injected 999"><p><strong>Ada</strong><br>handles <a href="/east">east</a>.</p><!-- Hidden owner --><script>Fake 123</script><style>Fake 456</style><template>Fake 789</template><table><tr><th>Name</th><th>Route</th></tr><tr><td>Ada</td><td><a href="/east">east</a></td></tr></table></div>'
    )
    expect(member(document, 'Ada handles east.').links.map(link => [link.label, link.destination])).toEqual([['east', '/east']])
    const record = document.records.find(item => item.kind === 'table-row')!
    expect(record.fields.map(field => [field.label, field.value])).toEqual([
      ['Name', 'Ada'],
      ['Route', 'east']
    ])
    expect(document.units.map(unit => unit.normalizedText).join(' ')).not.toMatch(/Injected|Hidden|Fake|999|123|456|789/u)
  })

  it.each([
    'display:none',
    'color: red; DiSpLaY : NoNe ! IMPORTANT ; font-weight: bold',
    'visibility:hidden',
    ' VISIBILITY : COLLAPSE !important ',
    'content-visibility:hidden',
    'CONTENT-VISIBILITY : HIDDEN ! important; color: red',
    'display:none !important;display:block',
    'display:none;display:block',
    'visibility:hidden !important;visibility:visible',
    'visibility:collapse;visibility:visible',
    'content-visibility:hidden !important;content-visibility:auto',
    'content-visibility:hidden;content-visibility:visible'
  ])('excludes inline and block hidden descendants from visible units and admitted body: %s', style => {
    const inline = `Inline <span style="${style}">Secret inline <span>descendant</span> <a href="/secret">link</a>.</span> remains.\n\n`
    const paragraph = `<p>Before <span style="${style}">Secret nested descendant.</span> <span style="color: blue; display: inline; visibility: visible">Visible styled neighbor.</span></p>`
    const source =
      inline +
      `<div>${paragraph}<div style="${style}"><p>Secret block descendant.</p></div><p style="content-visibility: auto; color: green">After styled block.</p></div>`
    const document = parse(source)
    expect(document.source).toBe(source)
    expect(document.requiresVisibilityProjection).toBe(true)
    expect(member(document, 'Inline remains.').links).toEqual([])
    const visible = member(document, 'Before Visible styled neighbor.')
    expect(visible.complete).toBe(true)
    expect(visible.sourceSpans).toEqual([{ start: source.indexOf(paragraph), end: source.indexOf(paragraph) + paragraph.length }])
    expect(member(document, 'After styled block.').complete).toBe(true)
    expect(document.units.map(unit => unit.visibleText).join('\n')).not.toContain('Secret')
    expect(admittedWikiBody(document).replace(/\s+/gu, ' ').trim()).toBe('Inline remains. Before Visible styled neighbor. After styled block.')
  })

  it('excludes hidden HTML descendants inside inline code while preserving escaped literal markup', () => {
    const source = 'Text <code><span hidden>Secret hidden.</span><span style="display:none">Secret style.</span><script>Secret script.</script><template>Secret template.</template>visible &amp; &lt;span hidden&gt;literal&lt;/span&gt;</code>.'
    expect(admittedWikiBody(parse(source))).toBe('Text `visible & <span hidden>literal</span>`.')
  })

  it.each([
    'display:none; visibility:hidden; content-visibility:hidden',
    'display:none !important;display:block; visibility:hidden !important;visibility:visible'
  ])('retains hidden-looking authored code bytes as inert data rather than applying their styles: %s', style => {
    const literal = `<span style="${style}">Authored data.</span>`
    const escaped = literal.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    const source = [
      '# Actual',
      '',
      '```html',
      literal,
      '```',
      '',
      `Literal \`${literal}\` remains.`,
      '',
      `<pre><code>${escaped}</code></pre>`,
      '',
      `<p>HTML <code>${escaped}</code> remains.</p>`
    ].join('\n')
    const document = parse(source)
    const code = document.units.filter(unit => unit.kind === 'code')
    expect(code).toHaveLength(2)
    expect(code.every(unit => unit.visibleText?.includes(literal) && unit.complete && unit.links.length === 0)).toBe(true)
    expect(document.units.filter(unit => unit.kind === 'paragraph').map(unit => [unit.visibleText, unit.complete, unit.links])).toEqual([
      [`Literal \`${literal}\` remains.`, true, []],
      [`HTML \`${literal}\` remains.`, true, []]
    ])
    expect(document.sections.map(section => section.ancestry)).toEqual([['Actual']])
    expect(document.source).toBe(source)
    const body = admittedWikiBody(document)
    expect(body).toContain(JSON.stringify(literal))
    expect(body).toContain(`Literal \`${literal}\` remains.`)
    expect(body).toContain(`HTML \`${literal}\` remains.`)
  })

  it('preserves code and inline literals without creating headings, disclosure owners or links', () => {
    const document = parse(
      '# Actual\n\n````\n# Fake\n<details><summary>Wrong</summary>\n[Fake](/fake)\n```\n`````\n\n    # Indented fake\n    [Fake](/fake)\n\n- Item\n\n      # List code\n\n<details><summary>Real</summary>~~~\n</details>\n# Still code\n~~~~\n- Visible\n</details>\n\nLiteral `a.b [fake](/fake)` remains.\n\n<pre><code># HTML fake [link](/fake)</code></pre>\n'
    )
    expect(document.sections.map(section => section.ancestry)).toEqual([['Actual']])
    expect(document.units.filter(unit => unit.kind === 'code').every(unit => unit.links.length === 0)).toBe(true)
    expect(document.units.flatMap(unit => unit.links)).toEqual([])
    expect(member(document, 'Literal `a.b [fake](/fake)` remains.').kind).toBe('paragraph')
    expect(labels(document, member(document, 'Visible'))).toContain('Real')
    expect(document.contexts.some(context => context.normalizedLabel === 'Wrong')).toBe(false)
  })

  it('keeps indented HTML-looking code inside a disclosure from manufacturing structural owners', () => {
    const document = parse('<details><summary>Actual</summary>\n\n    <h2>Forged</h2>\n    <a href="/forged">False member</a>\n\nVisible.\n</details>')
    expect(document.contexts.map(context => context.normalizedLabel)).toEqual(['Actual'])
    const code = document.units.find(unit => unit.kind === 'code')!
    expect(code.normalizedText).toContain('<h2>Forged</h2>')
    expect(code.normalizedText).toContain('<a href="/forged">False member</a>')
    expect(code.links).toEqual([])
    expect(labels(document, member(document, 'Visible.'))).toEqual(['Actual'])
  })

  it('does not let suppressed HTML content close a disclosure and become neighboring facts', () => {
    const document = parse(
      '<details><summary>Actual owner</summary><script>\n</details>\nInjected fact 999.\n</script>\n<p>Bounded fact 12.</p></details>\n\nOutside fact 34.\n'
    )
    expect(document.units.some(unit => unit.normalizedText.includes('999'))).toBe(false)
    expect(labels(document, member(document, 'Bounded fact 12.'))).toContain('Actual owner')
    expect(labels(document, member(document, 'Outside fact 34.'))).not.toContain('Actual owner')
  })

  it('keeps autolink destinations out of factual vocabulary and retains meaningful nonpresentation braces', () => {
    const document = parse(
      'See <https://example.test/fake-owner-999> and https://example.test/other.\n\n## **Owner** {.presentational}\n\nRoute {owner=Bea} has 12 units, only before 17:00.\n'
    )
    const urls = document.units.find(unit => unit.links.length === 2)!
    expect(urls.links.every(link => link.kind === 'autolink')).toBe(true)
    expect(urls.normalizedText).not.toContain('example.test')
    expect(document.sections[0]!.ancestry).toEqual(['Owner'])
    expect(member(document, 'Route {owner=Bea} has 12 units, only before 17:00.').normalizedText).toContain('{owner=Bea}')
  })

  it('does not fabricate ownership from unclosed or parser-repaired HTML', () => {
    const document = parse('<details><summary>Ada</summary><ul><li>Route: east</ul></details>\n\nRoute: west.\n\n<details><summary>Bea</summary>Route: north')
    expect(document.units.some(unit => unit.normalizedText === 'Route: east')).toBe(false)
    expect(labels(document, member(document, 'Route: west.'))).not.toContain('Ada')
    expect(document.units.some(unit => unit.normalizedText.includes('north'))).toBe(false)
    expect(document.units.some(unit => unit.kind === 'opaque' && !unit.complete)).toBe(true)
  })
})
