import { describe, expect, it } from 'bun:test'
import { parseSourceDocument } from '../../agents/providers/source-document.ts'
import { getLiteralSourceStatement, isLiteralSourceClaim } from '../../agents/providers/wiki-source-quotation.ts'
import type { WikiVerificationSource } from '../../agents/providers/wiki-verification.ts'
import type { WikiSynthesisAnswer } from '../../agents/providers/wiki-synthesis.ts'

const fixture = (raw: string): WikiVerificationSource[] => {
  const document = parseSourceDocument(raw, { representation: 'markdown', truncated: false })
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
