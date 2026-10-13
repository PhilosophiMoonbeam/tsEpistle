import { describe, expect, it } from 'bun:test'
import { load } from 'cheerio'
import * as markdownItModule from 'markdown-it'
import { formatAgentCitationMarkers } from '../../../client/components/agents/agent-citations.ts'
import { parseSourceDocument } from '../../agents/providers/source-document.ts'
import { getLiteralSourceStatement, isLiteralSourceClaim } from '../../agents/providers/wiki-source-quotation.ts'
import type { WikiVerificationSource } from '../../agents/providers/wiki-verification.ts'
import { validateWikiVerificationSource } from '../../agents/providers/wiki-verification.ts'
import { renderWikiSynthesisAnswer, type WikiSynthesisAnswer } from '../../agents/providers/wiki-synthesis.ts'

const fixture = (
  raw: string,
  options: Parameters<typeof parseSourceDocument>[1] = { representation: 'markdown', truncated: false }
): WikiVerificationSource[] => {
  const document = parseSourceDocument(raw, options)
  return document.units.map(unit => {
    const record = document.records.find(entry => entry.id === unit.recordId) ?? null
    const required = new Set([unit.id, ...(record?.unitIds ?? []), ...(record?.fields.flatMap(field => field.unitIds) ?? [])])
    const units = document.units.filter(entry => required.has(entry.id))
    const contextIds = new Set([...units.flatMap(entry => entry.contextIds), ...(record?.contextIds ?? [])])
    const contexts = document.contexts.filter(entry => contextIds.has(entry.id))
    const links = units.flatMap(entry => entry.links)
    const spans = [...units.flatMap(entry => entry.sourceSpans), ...contexts.flatMap(entry => entry.sourceSpans),
      ...(record?.fields.flatMap(field => field.sourceSpans) ?? []), ...links.flatMap(link => [...link.sourceSpans, ...link.dependencySpans])]
    const unique = new Map(spans.map(span => [`${span.start}:${span.end}`, span]))
    return {
      evidenceId: 'page:75:revision:3', sourceRevision: '3', unitId: `${unit.id}:assertion:0`,
      context: contexts.map(context => context.normalizedLabel).join(' › '), text: unit.normalizedText, kind: unit.kind,
      complete: unit.complete && units.every(entry => entry.complete) && contexts.every(entry => entry.complete) &&
        (record === null || record.complete && record.fields.every(field => field.complete)),
      closure: { unit, units, contexts, record, links, dependencies: [...unique.values()].map(span => ({ span, text: raw.slice(span.start, span.end) })) }
    }
  })
}
const sourceFor = (sources: readonly WikiVerificationSource[], text: string): WikiVerificationSource => {
  const source = sources.find(entry => entry.text === text)
  if (!source) throw new Error('Fixture source is missing')
  return source
}
const claim = (source: WikiVerificationSource, statement: string): WikiSynthesisAnswer['claims'][number] => ({
  evidenceId: source.evidenceId, sourceRevision: source.sourceRevision, unitId: source.unitId, statement
})

describe('complete original source quotations', () => {
  it.each([
    ['Ingredients', '- 200 g orzo\r\n- 1 lemon\r\n- 500 ml vegetable stock\r\n- Salt, only if needed\r\n', '200 g orzo'],
    ['Method', '1. Heat vegetable stock.\n2. Add orzo only after it boils.\n   Keep covered until tender.\n3. Stir, then add lemon.\n', 'Heat vegetable stock.']
  ])('quotes the complete authored %s list without expanding any individual item binding', (heading, authored, first) => {
    const qualification = 'Untested; use only after approval.'
    const raw = `# ${heading}\n\n${qualification}\n\n${authored}`
    const sources = fixture(raw)
    const container = sourceFor(sources, authored)
    const statement = `${heading}: ${authored}`
    expect(getLiteralSourceStatement(container)).toBe(statement)
    expect(isLiteralSourceClaim(claim(container, statement), container)).toBe(true)
    expect(getLiteralSourceStatement(sourceFor(sources, qualification))).toBe(`${heading}: ${qualification}`)
    const item = sourceFor(sources, first)
    expect(getLiteralSourceStatement(item)).toBe(`${heading}: ${first}`)
    expect(isLiteralSourceClaim(claim(item, statement), item)).toBe(false)
    expect(isLiteralSourceClaim(claim(container, `${heading}: ${first}`), container)).toBe(false)
    expect(isLiteralSourceClaim(claim(container, statement.replace('lemon', 'lime')), container)).toBe(false)
  })

  it('keeps nested list quotations within their parent condition and retains external link definitions', () => {
    const authored = '  - [Guide][g]\n  - Review every condition\n'
    const sources = fixture(`# Policies\n\n- Only after approval\n${authored}- Unrelated sibling\n\n[g]: /manual\n`)
    const container = sourceFor(sources, authored)
    const statement = `Policies › Only after approval: ${authored}`
    expect(getLiteralSourceStatement(container)).toBe(statement)
    expect(isLiteralSourceClaim(claim(container, statement.replace(' › Only after approval', '')), container)).toBe(false)
    expect(isLiteralSourceClaim(claim(container, `${statement}- Unrelated sibling\n`), container)).toBe(false)
    const link = container.closure!.links[0]!
    expect(link.unitId).toBe(container.closure!.unit.id)
    expect(link.destination).toBe('/manual')
    expect(container.closure!.dependencies.some(dependency => dependency.text === '[g]: /manual\n')).toBe(true)
    const missingDefinition = {
      ...container,
      closure: { ...container.closure!, dependencies: container.closure!.dependencies.filter(dependency => dependency.text !== '[g]: /manual\n') }
    }
    expect(getLiteralSourceStatement(missingDefinition)).toBeNull()
  })

  it.each([
    '- First\n\n  ### Only after review\n\n  Condition.\n- Second\n',
    '- Visible\n\n  ```\n  Hidden 999\n  ```\n\n- Second\n',
    '- Visible `Hidden 999`\n- Second\n',
    '- Visible\n\n  <script>Hidden 999</script>\n\n- Second\n',
    '- Visible <span data-hidden="999">fact</span>\n- Second\n',
    '<ul><li>First</li><li>Second</li></ul>\n',
    '<ul><li>First</li><li>Second</ul>\n',
    '- First {.hidden}\n- Second\n',
    '- ![First](/hidden-999)\n- Second\n',
    '- https://example.test/hidden-999\n- Second\n',
    '- First\n\n  [g]: /hidden-999\n\n- Second\n',
    '[g]: /original\n\n- First\n\n  [g]: /hidden-999\n\n- Second\n',
    '- Owner\n  - Route: east\n  - Route: west\n'
  ])('does not turn masked, malformed or mixed-scope list content into a complete quotation: %s', raw => {
    const sources = fixture(raw)
    expect(sources.some(source => source.kind === 'list' && getLiteralSourceStatement(source) !== null)).toBe(false)
  })

  it('retains a bounded earlier list but does not quote a truncated list tail or required definition', () => {
    const earlier = '- Earlier entry\n\n'
    const sources = fixture(`${earlier}Afterward.\n\n- Last entry\n- Unfinished`, { representation: 'recent-excerpt', truncated: true })
    expect(getLiteralSourceStatement(sourceFor(sources, earlier))).toBe(earlier)
    const tail = sourceFor(sources, 'Unfinished')
    expect(getLiteralSourceStatement(tail)).toBeNull()
    expect(sources.some(source => source.kind === 'list' && source.text.includes('Last entry'))).toBe(false)
    const reference = fixture('- [Guide][g]\n- Review\n\n[g]: /manual', { representation: 'recent-excerpt', truncated: true })
    expect(reference.some(source => source.kind === 'list' && getLiteralSourceStatement(source) !== null)).toBe(false)
  })

  it('requires the complete native list text to match its exact original dependency', () => {
    const authored = '- First\n- Second\n'
    const source = sourceFor(fixture(authored), authored)
    expect(getLiteralSourceStatement({ ...source, text: '- First\n' })).toBeNull()
    const altered = '- Third\n- Second\n'
    const unit = { ...source.closure!.unit, normalizedText: altered }
    const forged = { ...source, text: altered, closure: { ...source.closure!, unit, units: [unit] } }
    expect(getLiteralSourceStatement(forged)).toBeNull()
  })
  it('quotes an original comparison matrix with its governing condition, never a union of row bindings', () => {
    const table = '| Feature | [Atlas][a] | Boreal |\r\n| --- | --- | --- |\r\n| Threshold | USD 500 | USD 750 |\r\n| Basis | [mainland only][m] | remote islands only |\r\n'
    const raw = `# Fictional, non-operative policies\r\n\r\n## Only after approval\r\n\r\n${table}\r\n[a]: /atlas\r\n[m]: /mainland "Authored scope"\r\n[foreign]: /unrequested\r\n`
    const sources = fixture(raw)
    const native = sourceFor(sources, table)
    const statement = `Fictional, non-operative policies › Only after approval:\n\n${table}\n[a]: /atlas\r\n\n[m]: /mainland "Authored scope"\r\n`
    expect(native.kind).toBe('table')
    expect(native.closure!.units).toEqual([native.closure!.unit])
    expect(native.closure!.record).toBeNull()
    expect(native.closure!.contexts.map(context => context.kind)).toEqual(['heading', 'heading'])
    expect(native.closure!.links.map(link => [link.label, link.destination])).toEqual([['mainland only', '/mainland'], ['Atlas', '/atlas']])
    expect(getLiteralSourceStatement(native)).toBe(statement)
    expect(() => validateWikiVerificationSource(native)).not.toThrow()
    expect(isLiteralSourceClaim(claim(native, statement), native)).toBe(true)
    const blocks = new Map([[JSON.stringify([native.evidenceId, native.sourceRevision, native.unitId]), statement]])
    const rendered = renderWikiSynthesisAnswer({ claims: [claim(native, statement)], unresolvedFacets: [], observations: [], recommendations: '' }, new Set([statement]), blocks)
    const MarkdownIt = 'default' in markdownItModule ? markdownItModule.default : markdownItModule
    const markdown = (MarkdownIt as typeof markdownItModule.default)({ html: false, breaks: true, linkify: true, typographer: false })
    const dom = load(markdown.render(formatAgentCitationMarkers(rendered, () => ({ number: 1, label: 'Original fictional table', href: '/source/fictional' }))))
    expect(dom('table')).toHaveLength(1)
    expect(dom('th a').text()).toBe('Atlas')
    expect(dom('th a').attr('href')).toBe('/atlas')
    expect(dom('td a').text()).toBe('mainland only')
    expect(dom('td a').attr('href')).toBe('/mainland')
    expect(dom('td a').attr('title')).toBe('Authored scope')
    expect(dom('p a').text()).toBe('1')
    expect(dom('p a').attr('href')).toBe('/source/fictional')
    expect(dom('body').text()).toContain('Fictional, non-operative policies › Only after approval:')
    expect(dom('body').text()).not.toContain('[Atlas][a]')
    expect(rendered).not.toContain('[foreign]')
    for (const changed of [
      statement.replace(' › Only after approval', ''),
      statement.replace('Fictional, non-operative policies', 'Policies'),
      statement.replace('USD 500 | USD 750', 'USD 750 | USD 500'),
      statement.replace('Threshold |', 'Minimum |'),
      statement.replace('[Atlas][a]', '[Atlas](/boreal)'),
      statement.replace('| Basis | [mainland only][m] | remote islands only |\r\n', ''),
      table
    ]) expect(isLiteralSourceClaim(claim(native, changed), native)).toBe(false)
    const row = sourceFor(sources, 'Atlas: USD 500')
    expect(isLiteralSourceClaim(claim(row, statement), row)).toBe(false)
    expect(isLiteralSourceClaim({ ...claim(native, statement), evidenceId: 'foreign-page' }, native)).toBe(false)
    const missing = { ...native, closure: { ...native.closure!, links: [] } }
    expect(getLiteralSourceStatement(missing)).toBeNull()
    expect(() => validateWikiVerificationSource(missing)).toThrow()
    const required = native.closure!.dependencies.find(dependency => dependency.text === '[a]: /atlas\r\n')!
    const withoutDefinition = { ...native, closure: { ...native.closure!, dependencies: native.closure!.dependencies.filter(dependency => dependency !== required) } }
    expect(getLiteralSourceStatement(withoutDefinition)).toBeNull()
    for (const text of ['[a]: /other\r\n', '[x]: /atlas\r\n', '[a]: `fake`\r\n']) {
      const changedDefinition = { ...native, closure: { ...native.closure!, dependencies: native.closure!.dependencies.map(dependency =>
        dependency === required ? { ...dependency, text } : dependency) } }
      expect(getLiteralSourceStatement(changedDefinition)).toBeNull()
    }
    for (const changed of [
      statement.replace('[a]: /atlas', '[a]: /other'),
      statement.replace('[a]: /atlas\r\n', ''),
      `${statement}[foreign]: /unrequested\r\n`,
      `${statement}Injected assertion.\r\n`,
      `${statement}<script>bad</script>\r\n`,
      `${statement}[[cite:foreign]]\r\n`
    ]) expect(isLiteralSourceClaim(claim(native, changed), native)).toBe(false)
  })

  it.each([
    'Name | Route\n--- | ---\nAda\n',
    'Name | Route\n--- | ---\nAda | east | discarded\n',
    'Name | Name\n--- | ---\nAda | east\n',
    'Name | Route\n--- | ---\nAda | `hidden 999`\n',
    'Name | Route\n--- | ---\nAda | <span data-hidden="999">east</span>\n',
    'Name | Route\n--- | ---\nAda | ![east](/hidden-999)\n',
    'Name | Route\n--- | ---\nAda | https://example.test/hidden-999\n',
    'Name | Route\n--- | ---\nAda | east {.hidden}\n',
    '[Name][missing] | Route\n--- | ---\nAda | east\n',
    'Name | Route\n--- | ---\n[Guide][missing] | east\n\n[foreign]: /manual\n',
    '<table><tr><th>Name</th><th>Route</th></tr><tr><td>Ada</td><td>east</td></tr></table>\n'
  ])('does not quote parser-repaired or masked tables as complete original bodies: %s', raw => {
    expect(fixture(raw).some(source => source.kind === 'table')).toBe(false)
  })

  it('rejects truncated table tails and unresolved original reference dependencies', () => {
    const earlier = 'Name | Route\n--- | ---\nAda | east\n'
    const sources = fixture(`${earlier}\nAfterward.\n\nName | Route\n--- | ---\nBea | west`, {
      representation: 'recent-excerpt', truncated: true
    })
    expect(getLiteralSourceStatement(sourceFor(sources, earlier))).toBe(earlier)
    expect(sources.some(source => source.kind === 'table' && source.text.includes('Bea'))).toBe(false)
    const reference = fixture('Name | Route\n--- | ---\n[Guide][g] | east\n\n[g]: /manual', {
      representation: 'recent-excerpt', truncated: true
    })
    expect(reference.some(source => source.kind === 'table')).toBe(false)
  })

  it('requires native table text and its own exact body dependency to agree before literal admission', () => {
    const table = 'Name | Route\n--- | ---\nAda | east\nBea | west\n'
    const source = sourceFor(fixture(table), table)
    const changed = table.replace('Ada | east', 'Ada | west')
    const unit = { ...source.closure!.unit, normalizedText: changed }
    const forged = { ...source, text: changed, closure: { ...source.closure!, unit, units: [unit] } }
    expect(getLiteralSourceStatement(forged)).toBeNull()
    expect(() => validateWikiVerificationSource(forged)).toThrow()
    const subset = { ...source, text: 'Name | Route\n--- | ---\nAda | east\n' }
    expect(getLiteralSourceStatement(subset)).toBeNull()
    expect(() => validateWikiVerificationSource(subset)).toThrow()
    const foreign = sourceFor(fixture('Name | Route\n--- | ---\nCal | north\n'), 'Name | Route\n--- | ---\nCal | north\n')
    expect(getLiteralSourceStatement({ ...source, closure: { ...source.closure!, units: foreign.closure!.units } })).toBeNull()
  })

  it('keeps derived assertions within their selected original scope and governing qualifications', () => {
    const body = 'These recipes are authored. They remain untested. Total times are estimates.'
    const source = sourceFor(fixture(`# Recipe Collection\n\n## Only after safety review\n\n${body}\n`), body)
    const expanded = `Recipe Collection › Only after safety review: ${body}`
    for (const [index, text] of ['These recipes are authored.', 'They remain untested.', 'Total times are estimates.'].entries()) {
      const derived = { ...source, text, unitId: `${source.closure!.unit.id}:assertion:${index}` }
      const expected = `Recipe Collection › Only after safety review: ${text}`
      expect(getLiteralSourceStatement(derived)).toBe(expected)
      expect(isLiteralSourceClaim(claim(derived, expanded), derived)).toBe(false)
      expect(isLiteralSourceClaim(claim(derived, text), derived)).toBe(false)
      expect(isLiteralSourceClaim(claim(derived, expected.replace('safety review', 'approval')), derived)).toBe(false)
      expect(isLiteralSourceClaim({ ...claim(derived, expected), evidenceId: 'foreign' }, derived)).toBe(false)
    }
  })

  it('preserves every record field and condition regardless of the selected row part', () => {
    const sources = fixture('# Catalog\n\nDetail | Value | Condition\n--- | --- | ---\nElapsed time | 30 minutes | Only after approval\nServings | 4 | Base recipe\n')
    const expected = 'Catalog › Detail | Value | Condition: Detail: Elapsed time | Value: 30 minutes | Condition: Only after approval'
    for (const text of ['Detail: Elapsed time', 'Value: 30 minutes', 'Condition: Only after approval']) {
      const source = sourceFor(sources, text)
      expect(getLiteralSourceStatement(source)).toBe(expected)
      expect(isLiteralSourceClaim(claim(source, expected), source)).toBe(true)
      for (const changed of [expected.replace('30 minutes', '50 minutes'), expected.replace(' | Condition: Only after approval', ''), text])
        expect(isLiteralSourceClaim(claim(source, changed), source)).toBe(false)
      expect(isLiteralSourceClaim({ ...claim(source, expected), sourceRevision: '4' }, source)).toBe(false)
    }
    expect(isLiteralSourceClaim(claim(sourceFor(sources, 'Value: 4'), expected), sourceFor(sources, 'Value: 4'))).toBe(false)
  })

  it('quotes an explicitly complete list record once under its inherited condition, never a sibling record', () => {
    const sources = fixture('# Fictional non-operative policies\n\n## Only after approval\n\n- Free delivery threshold: USD 500; Scope: mainland orders only.\n- Free delivery threshold: USD 750; Scope: remote-island orders only.\n')
    const source = sourceFor(sources, 'Free delivery threshold: USD 500')
    const statement = 'Fictional non-operative policies › Only after approval: Free delivery threshold: USD 500; Scope: mainland orders only.'
    expect(getLiteralSourceStatement(source)).toBe(statement)
    expect(isLiteralSourceClaim(claim(source, statement), source)).toBe(true)
    for (const changed of [
      statement.replace(' › Only after approval', ''),
      statement.replace('Scope: mainland orders only.', 'Scope: remote-island orders only.'),
      statement.replace('USD 500', 'USD 750'),
      statement.replace('; Scope: mainland orders only.', '')
    ]) expect(isLiteralSourceClaim(claim(source, changed), source)).toBe(false)
    expect(isLiteralSourceClaim(claim(sourceFor(sources, 'Free delivery threshold: USD 750'), statement), sourceFor(sources, 'Free delivery threshold: USD 750'))).toBe(false)
  })


  it('admits owned linked labels without asserting their other row attributes', () => {
    const sources = fixture('# Catalog\n\n## Only after review\n\nEntry | Time | Condition\n--- | --- | ---\n[Atlas](/atlas) | 30 minutes | Requires approval\n[Beacon](/beacon) | 50 minutes | Untested\n')
    const source = sourceFor(sources, 'Entry: Atlas')
    const expected = 'Catalog › Only after review › Entry | Time | Condition: The source links to "Atlas" in the "Entry" field.'
    expect(getLiteralSourceStatement(source)).toBe(expected)
    expect(isLiteralSourceClaim(claim(source, expected), source)).toBe(true)
    for (const changed of [
      expected.replace('Atlas', 'Beacon'),
      expected.replace(' › Only after review', ''),
      expected.replace('The source links to "Atlas" in the "Entry" field.', 'Atlas takes 30 minutes.')
    ]) expect(isLiteralSourceClaim(claim(source, changed), source)).toBe(false)
    expect(isLiteralSourceClaim(claim(sourceFor(sources, 'Entry: Beacon'), expected), sourceFor(sources, 'Entry: Beacon'))).toBe(false)
    expect(isLiteralSourceClaim(claim(sourceFor(sources, 'Time: 30 minutes'), 'Time: 30 minutes'), sourceFor(sources, 'Time: 30 minutes'))).toBe(false)
  })

  it('keeps proposition-like link labels quoted as source links rather than world assertions', () => {
    const source = sourceFor(fixture('# Policies\n\nLabel | Restriction\n--- | ---\n[Staff may access records](/policy) | Only with approval\n'), 'Label: Staff may access records')
    const statement = getLiteralSourceStatement(source)!
    expect(statement).toBe('Policies › Label | Restriction: The source links to "Staff may access records" in the "Label" field.')
    expect(isLiteralSourceClaim(claim(source, statement), source)).toBe(true)
    expect(isLiteralSourceClaim(claim(source, 'Staff may access records.'), source)).toBe(false)
  })


  it('retains exact linked membership punctuation and governing conditions in the explicit statement', () => {
    const label = 'Staff may access records? [only after review]'
    const value = 'Staff may access records "only if approved" [restricted] #1; otherwise wait.'
    const raw = '# Catalog\n\n## Only after review\n\nStaff may access records? \\[only after review\\] | Time | Condition\n--- | --- | ---\n[Staff may access records "only if approved" \\[restricted\\] #1; otherwise wait.](/policy) | 30 minutes | Requires approval\n'
    const source = sourceFor(fixture(raw), `${label}: ${value}`)
    const statement = getLiteralSourceStatement(source)!
    expect(statement).toBe(`Catalog › Only after review › ${label} | Time | Condition: The source links to "${value}" in the "${label}" field.`)
    expect(isLiteralSourceClaim(claim(source, statement), source)).toBe(true)
    expect(isLiteralSourceClaim(claim(source, value), source)).toBe(false)
    expect(isLiteralSourceClaim(claim(source, statement.replace('Only after review', 'Approved')), source)).toBe(false)
    expect(getLiteralSourceStatement({ ...source, complete: false })).toBeNull()
  })

  it('does not discard nested units or preconditions from a numeric quotation', () => {
    const source = sourceFor(fixture('# Rice preparations\n\n## Durations in hours\n\n### Only when previously cooled rice is available\n\nDetail | Value\n--- | ---\nElapsed time | 2\n'), 'Value: 2')
    const expected = 'Rice preparations › Durations in hours › Only when previously cooled rice is available › Detail | Value: Detail: Elapsed time | Value: 2'
    expect(getLiteralSourceStatement(source)).toBe(expected)
    expect(isLiteralSourceClaim(claim(source, expected), source)).toBe(true)
    for (const omitted of [' › Durations in hours', ' › Only when previously cooled rice is available'])
      expect(isLiteralSourceClaim(claim(source, expected.replace(omitted, '')), source)).toBe(false)
  })

  it('refuses field shortcuts with incompatible original governing conditions', () => {
    const sources = fixture('# Measurements\n\n- Name: Bench\n\n  ### Only after approval\n\n  Duration: 10 hours\n')
    for (const text of ['Name: Bench', 'Duration: 10 hours']) {
      const source = sourceFor(sources, text)
      expect(getLiteralSourceStatement(source)).toBeNull()
      expect(isLiteralSourceClaim(claim(source, 'Measurements: Name: Bench | Duration: 10 hours'), source)).toBe(false)
      expect(isLiteralSourceClaim(claim(source, text), source)).toBe(false)
    }
  })

  it('rejects partial, reordered and altered field metadata', () => {
    const source = sourceFor(fixture('# Catalog\n\nDetail | Value | Condition\n--- | --- | ---\nElapsed time | 30 minutes | Only after approval\n'), 'Value: 30 minutes')
    const statement = getLiteralSourceStatement(source)!
    const originalFields = source.closure!.record!.fields
    for (const fields of [originalFields.slice(0, 2), [...originalFields].reverse(), originalFields.map(field => ({ ...field, value: field.label === 'Value' ? '50 minutes' : field.value }))]) {
      const modified = { ...source, closure: { ...source.closure!, record: { ...source.closure!.record!, fields } } }
      expect(getLiteralSourceStatement(modified)).toBeNull()
      expect(isLiteralSourceClaim(claim(modified, statement), modified)).toBe(false)
    }
  })

  it('rejects incomplete ownership, absent dependencies, uncontained assertions and stale quotations', () => {
    const body = 'Atlas is a named example. It remains untested.'
    const source = sourceFor(fixture(`# Catalog\n\n${body}\n`), body)
    const statement = getLiteralSourceStatement(source)!
    for (const modified of [
      { ...source, complete: false },
      { ...source, text: 'A foreign assertion absent from the original unit.' },
      { ...source, closure: null },
      { ...source, closure: { ...source.closure!, units: [] } },
      { ...source, closure: { ...source.closure!, dependencies: source.closure!.dependencies.slice(1) } }
    ]) {
      expect(getLiteralSourceStatement(modified)).toBeNull()
    }
    const currentBody = 'Atlas is a named example. It remains untested; only use after review.'
    const current = {
      ...sourceFor(fixture(`# Catalog\n\n${currentBody}\n`), currentBody),
      evidenceId: 'page:75:revision:4',
      sourceRevision: '4'
    }
    expect(isLiteralSourceClaim(claim(current, statement), current)).toBe(false)
    expect(getLiteralSourceStatement(current)).toBe(`Catalog: ${currentBody}`)
    const multi = sourceFor(fixture('# Catalog\n\n- Atlas is a named example.\n\n  It remains untested.\n'), 'Atlas is a named example.')
    expect(getLiteralSourceStatement(multi)).toBeNull()
  })

  it('accepts only the exact authoritative title template and its bound revision', () => {
    const source: WikiVerificationSource = { evidenceId: 'page:75:revision:3', sourceRevision: '3', unitId: 'metadata:page-title', context: '', text: 'Catalog', kind: 'page-title', complete: true, closure: null }
    expect(isLiteralSourceClaim(claim(source, 'The page is titled "Catalog"'), source)).toBe(true)
    expect(isLiteralSourceClaim(claim(source, 'The page is titled "Catalog".'), source)).toBe(true)
    expect(isLiteralSourceClaim(claim(source, 'Catalog'), source)).toBe(false)
    expect(isLiteralSourceClaim({ ...claim(source, 'The page is titled "Catalog"'), unitId: 'unit:foreign' }, source)).toBe(false)
  })
})
