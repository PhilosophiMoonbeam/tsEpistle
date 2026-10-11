import type { SourceContext, SourceSpan, SourceUnit } from './source-document.ts'
import type { WikiSynthesisAnswer } from './wiki-synthesis.ts'
import type { WikiVerificationSource } from './wiki-verification.ts'

const spanKey = (span: SourceSpan): string => `${span.start}:${span.end}`

const closedSource = (source: WikiVerificationSource): boolean => {
  if (!source.complete || !source.text || !source.evidenceId || !source.sourceRevision || !source.unitId) return false
  if (source.kind === 'page-title') return source.unitId === 'metadata:page-title' && source.closure === null
  const closure = source.closure
  if (closure === null) return false
  const { unit, units, contexts, record, links, dependencies } = closure
  if (!unit.complete || unit.kind !== source.kind || !unit.sourceSpans.length) return false
  if ((unit.kind === 'heading' || unit.kind === 'summary' || unit.kind === 'table-row' || (record?.fields.length ?? 0) > 0) &&
    source.text !== unit.normalizedText) return false
  const owned = new Map(units.map(entry => [entry.id, entry]))
  const governing = new Map(contexts.map(entry => [entry.id, entry]))
  if (owned.size !== units.length || governing.size !== contexts.length || JSON.stringify(owned.get(unit.id)) !== JSON.stringify(unit)) return false
  if (units.some(entry => !entry.id || !entry.complete || !entry.sourceSpans.length) || contexts.some(entry => !entry.id || !entry.complete || !entry.sourceSpans.length)) return false
  if (unit.recordId !== (record?.id ?? null) || (record !== null && (!record.complete || !record.unitIds.includes(unit.id) ||
    record.fields.some(field => !field.complete || !field.unitIds.length || !field.sourceSpans.length)))) return false
  const requiredUnits = new Set([unit.id, ...(record?.unitIds ?? []), ...(record?.fields.flatMap(field => field.unitIds) ?? [])])
  if (requiredUnits.size !== owned.size || [...requiredUnits].some(id => !owned.has(id))) return false
  const requiredContexts = new Set([...units.flatMap(entry => entry.contextIds), ...(record?.contextIds ?? [])])
  if (requiredContexts.size !== governing.size || [...requiredContexts].some(id => !governing.has(id))) return false
  for (const context of contexts) {
    const ancestry = new Set([context.id])
    let parent = context.parentId
    while (parent !== null) {
      if (ancestry.has(parent) || !governing.has(parent)) return false
      ancestry.add(parent)
      parent = governing.get(parent)!.parentId
    }
  }
  const ownedLinks = units.flatMap(entry => entry.links)
  if (ownedLinks.some(link => !owned.has(link.unitId)) || links.some(link => !ownedLinks.some(entry => JSON.stringify(entry) === JSON.stringify(link)))) return false
  const spans = [...units.flatMap(entry => entry.sourceSpans), ...contexts.flatMap(entry => entry.sourceSpans),
    ...(record?.fields.flatMap(field => field.sourceSpans) ?? []), ...ownedLinks.flatMap(link => [...link.sourceSpans, ...link.dependencySpans])]
  const requiredSpans = new Set(spans.map(spanKey))
  const supplied = new Set<string>()
  for (const { span, text } of dependencies) {
    const key = spanKey(span)
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start ||
      text.length !== span.end - span.start || !requiredSpans.has(key) || supplied.has(key)) return false
    supplied.add(key)
  }
  return requiredSpans.size === supplied.size
}

const ownContext = (source: WikiVerificationSource, unit: SourceUnit = source.closure!.unit): SourceContext | undefined =>
  source.closure!.contexts.find(context => context.kind === unit.kind && context.normalizedLabel === unit.normalizedText &&
    context.sourceSpans.some(span => unit.sourceSpans.some(own => spanKey(own) === spanKey(span))))

const governingContexts = (source: WikiVerificationSource, unit: SourceUnit = source.closure!.unit): readonly SourceContext[] => {
  const contexts = new Map(source.closure!.contexts.map(context => [context.id, context]))
  const ancestors: SourceContext[] = []
  const self = ownContext(source, unit)
  let id = self ? self.parentId : unit.contextIds.at(-1) ?? null
  while (id !== null) {
    const context = contexts.get(id)!
    ancestors.push(context)
    id = context.parentId
  }
  return ancestors.reverse()
}

const literalRecordStatement = (source: WikiVerificationSource): string | null => {
  const closure = source.closure!
  const record = closure.record
  if (!record?.fields.length) return null
  const units = new Map(closure.units.map(unit => [unit.id, unit]))
  const covered = new Set<string>()
  const fields = new Set<string>()
  const governing = governingContexts(source).filter(context => context.kind !== 'table-header')
  const contexts = new Map(closure.contexts.map(context => [context.id, context]))
  for (const [index, field] of record.fields.entries()) {
    if (field.order !== index || !field.id || fields.has(field.id) || !field.label ||
      field.unitIds.length !== 1 || !field.sourceSpans.length) return null
    fields.add(field.id)
    const unit = units.get(field.unitIds[0]!)
    if (!unit || unit.recordId !== record.id || covered.has(unit.id) ||
      unit.normalizedText !== `${field.label}: ${field.value}` ||
      field.sourceSpans.length !== unit.sourceSpans.length ||
      field.sourceSpans.some((span, position) => spanKey(span) !== spanKey(unit.sourceSpans[position]!))) return null
    const self = ownContext(source, unit)
    let contextId = self ? self.parentId : unit.contextIds.at(-1) ?? null
    let ancestor = governing.length - 1
    while (contextId !== null) {
      const context = contexts.get(contextId)!
      if (context.kind !== 'table-header') {
        if (context.id !== governing[ancestor]?.id) return null
        ancestor--
      }
      contextId = context.parentId
    }
    if (ancestor !== -1) return null
    covered.add(unit.id)
  }
  // A field-only copy must not omit an assertion or condition owned by the record.
  if (record.unitIds.length !== covered.size || record.unitIds.some(id => !covered.has(id))) return null
  const statement = record.fields.map(field => `${field.label}: ${field.value}`).join(' | ')
  const labels = governingContexts(source).map(context => context.normalizedLabel)
  return labels.length ? `${labels.join(' › ')}: ${statement}` : statement
}

/** An exact owned linked label proves a named member, not its other row facts. */
export const getLiteralSourceMembershipStatement = (source: WikiVerificationSource): string | null => {
  if (!closedSource(source) || source.closure === null || source.closure.record?.kind !== 'table-row') return null
  const { unit, record } = source.closure
  const fields = record.fields.filter(field => field.unitIds.length === 1 && field.unitIds[0] === unit.id)
  if (fields.length !== 1) return null
  const field = fields[0]!
  if (!field.label || !field.value || unit.normalizedText !== `${field.label}: ${field.value}` ||
    JSON.stringify(field.sourceSpans) !== JSON.stringify(unit.sourceSpans) ||
    !unit.links.some(link => link.kind === 'link' && link.unitId === unit.id && link.label === field.value &&
      source.closure!.links.some(owned => JSON.stringify(owned) === JSON.stringify(link)))) return null
  const labels = governingContexts(source).map(context => context.normalizedLabel)
  const statement = `The source links to "${field.value}" in the "${field.label}" field.`
  return labels.length ? `${labels.join(' › ')}: ${statement}` : statement
}

/** Complete original quotation with its governing context; not a world-fact inference. */
export const getLiteralSourceStatement = (source: WikiVerificationSource): string | null => {
  if (!closedSource(source)) return null
  if (source.kind === 'page-title') return `The page is titled "${source.text}"`
  const { unit, record } = source.closure!
  if (record?.fields.length) return getLiteralSourceMembershipStatement(source) ?? literalRecordStatement(source)
  if (!unit.normalizedText.includes(source.text) ||
    (record && (record.unitIds.length !== 1 || record.unitIds[0] !== unit.id))) return null
  const labels = governingContexts(source).map(context => context.normalizedLabel)
  return labels.length ? `${labels.join(' › ')}: ${unit.normalizedText}` : unit.normalizedText
}

/** Exact linked members and complete quotations are mechanical; other claims need semantic support. */
export const isLiteralSourceClaim = (claim: WikiSynthesisAnswer['claims'][number], source: WikiVerificationSource): boolean => {
  if (claim.evidenceId !== source.evidenceId || claim.sourceRevision !== source.sourceRevision || claim.unitId !== source.unitId) return false
  const statement = getLiteralSourceStatement(source)
  return statement !== null && (claim.statement === statement || source.kind === 'page-title' && claim.statement === `${statement}.` ||
    (source.closure?.record?.fields.length ?? 0) > 0 && claim.statement === literalRecordStatement(source))
}
