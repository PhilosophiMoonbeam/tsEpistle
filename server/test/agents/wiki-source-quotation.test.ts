import { describe, expect, it } from 'bun:test'
import { parseSourceDocument } from '../../agents/providers/source-document.ts'
import { getLiteralSourceStatement, isLiteralSourceClaim } from '../../agents/providers/wiki-source-quotation.ts'
import type { WikiVerificationSource } from '../../agents/providers/wiki-verification.ts'
import type { WikiSynthesisAnswer } from '../../agents/providers/wiki-synthesis.ts'

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
    const sources = fixture(`# ${heading}\n\n${qualification}\n\n${authored}`)
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

  it('preserves sibling status and prerequisites under each original derived assertion binding', () => {
    const body = 'These recipes are authored. They remain untested. Total times are estimates.'
    const source = sourceFor(fixture(`# Recipe Collection\n\n## Only after safety review\n\n${body}\n`), body)
    const expected = `Recipe Collection › Only after safety review: ${body}`
    for (const [index, text] of ['These recipes are authored.', 'They remain untested.', 'Total times are estimates.'].entries()) {
      const derived = { ...source, text, unitId: `${source.closure!.unit.id}:assertion:${index}` }
      expect(getLiteralSourceStatement(derived)).toBe(expected)
      expect(isLiteralSourceClaim(claim(derived, expected), derived)).toBe(true)
      expect(isLiteralSourceClaim(claim(derived, text), derived)).toBe(false)
      expect(isLiteralSourceClaim(claim(derived, expected.replace('untested', 'tested')), derived)).toBe(false)
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

  it('rejects incomplete ownership, absent dependencies and uncontained assertions', () => {
    const body = 'Atlas is a named example. It remains untested.'
    const source = sourceFor(fixture(`# Catalog\n\n${body}\n`), body)
    for (const modified of [
      { ...source, complete: false },
      { ...source, text: 'A foreign assertion absent from the original unit.' },
      { ...source, closure: { ...source.closure!, dependencies: source.closure!.dependencies.slice(1) } }
    ]) expect(getLiteralSourceStatement(modified)).toBeNull()
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
