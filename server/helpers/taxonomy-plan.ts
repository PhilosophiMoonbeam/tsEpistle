import { createHash } from 'node:crypto'
import type { TaxonomyChange, TaxonomyPage, TaxonomyPreview, TaxonomyRuleImpact, TaxonomyTag } from '../../shared/taxonomy.ts'
import { tagAliasMap } from './tag-aliases.ts'
import errors from '../operations/errors.ts'

const { ApplicationError } = errors
export type TagRow = Omit<TaxonomyTag, 'pageCount' | 'historyCount' | 'ruleCount'>
export interface TagAssignment {
  pageId: number
  tagId: number
}
export interface TagGroup {
  id: number
  name: string
  permissions: string[]
  pageRules: { match: string; path: string; deny: boolean; roles: string[]; locales?: string[] }[]
}
export interface TaxonomySnapshot {
  tags: TagRow[]
  assignments: TagAssignment[]
  pages: TaxonomyPage[]
  groups: TagGroup[]
  history: { tagId: number; count: number }[]
}
const hasControlCharacters = (value: string): boolean => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
const invalid = (message: string): never => {
  throw new ApplicationError(message, { status: 400, code: 'INVALID_TAXONOMY_CHANGE' })
}
export const tagName = (value: unknown): string => {
  if (typeof value !== 'string') return invalid('Use a tag name of 1–255 characters without control characters.')
  const canonical = value.trim().toLowerCase()
  if (!canonical || canonical.length > 255 || hasControlCharacters(value)) return invalid('Use a tag name of 1–255 characters without control characters.')
  return canonical
}
export const tagNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) return invalid('Tags must be an array.')
  if (value.length > 100) return invalid('Use no more than 100 tags.')
  const names: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const name = tagName(item)
    if (!seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}
export const tagDefinition = (value: unknown): { tag: string; title: string } => {
  if (!value || typeof value !== 'object') return invalid('A tag definition is required.')
  const tag = tagName(Reflect.get(value, 'tag'))
  const title = Reflect.get(value, 'title')
  if (typeof title !== 'string' || title.trim().length > 255 || hasControlCharacters(title))
    return invalid('Use a display label of up to 255 characters without control characters.')
  return { tag, title: title.trim() }
}
export const taxonomyChange = (value: unknown): TaxonomyChange => {
  if (!value || typeof value !== 'object') return invalid('A taxonomy change is required.')
  const action = Reflect.get(value, 'action')
  const tagId = Reflect.get(value, 'tagId')
  if (!Number.isSafeInteger(tagId) || tagId < 1) return invalid('Select a valid source tag.')
  if (action === 'edit') return { action, tagId, ...tagDefinition(value) }
  if (action === 'merge') {
    const targetId = Reflect.get(value, 'targetId')
    if (!Number.isSafeInteger(targetId) || targetId < 1 || targetId === tagId) return invalid('Select a different destination tag.')
    return { action, tagId, targetId }
  }
  if (action === 'archive' || action === 'restore') return { action, tagId }
  return invalid('Choose edit, merge, archive or restore.')
}
const canonicalId = (tags: TagRow[], id: number): number => {
  const byId = new Map(tags.map(tag => [tag.id, tag]))
  let tag = byId.get(id)
  const visited = new Set<number>()
  while (tag?.redirectToId != null) {
    if (visited.has(tag.id)) throw new Error('Taxonomy contains a redirect cycle')
    visited.add(tag.id)
    tag = byId.get(tag.redirectToId)
  }
  if (!tag) throw new Error('Taxonomy destination is missing')
  return tag.id
}
export const taxonomyInventory = (snapshot: TaxonomySnapshot): TaxonomyTag[] => {
  const aliases = tagAliasMap(snapshot.tags)
  const pagesByTag = new Map<number, Set<number>>()
  for (const assignment of snapshot.assignments) {
    if (!pagesByTag.has(assignment.tagId)) pagesByTag.set(assignment.tagId, new Set())
    pagesByTag.get(assignment.tagId)!.add(assignment.pageId)
  }
  const historyByTag = new Map(snapshot.history.map(h => [h.tagId, h.count]))
  const rules = snapshot.groups.flatMap(g => g.pageRules).filter(r => r.match === 'TAG')
  return snapshot.tags.map(tag => {
    const target = canonicalId(snapshot.tags, tag.id)
    return {
      ...tag,
      pageCount: tag.isArchived ? 0 : (pagesByTag.get(target)?.size ?? 0),
      historyCount: historyByTag.get(tag.id) ?? 0,
      ruleCount: rules.filter(r => r.path === tag.tag || (!tag.isArchived && aliases[r.path] === aliases[tag.tag])).length
    }
  })
}
const ruleMatches = (snapshot: TaxonomySnapshot, rule: TagGroup['pageRules'][number]): Set<number> => {
  const aliases = tagAliasMap(snapshot.tags)
  const name = aliases[rule.path]
  if (!name) return new Set()
  const ids = new Set(snapshot.tags.filter(t => aliases[t.tag] === name && !t.isArchived).map(t => t.id))
  const pages = new Set(snapshot.pages.filter(p => p.visibility === 'public' && (!rule.locales?.length || rule.locales.includes(p.locale))).map(p => p.id))
  return new Set(snapshot.assignments.filter(a => ids.has(a.tagId) && pages.has(a.pageId)).map(a => a.pageId))
}
export const taxonomyRules = (before: TaxonomySnapshot, after: TaxonomySnapshot, names: Set<string>): TaxonomyRuleImpact[] =>
  before.groups.flatMap(group =>
    group.pageRules
      .filter(rule => rule.match === 'TAG' && names.has(rule.path))
      .map(rule => {
        const previous = ruleMatches(before, rule)
        const next = ruleMatches(after, rule)
        return {
          groupId: group.id,
          groupName: group.name,
          path: rule.path,
          deny: rule.deny,
          roles: rule.roles,
          locales: rule.locales ?? [],
          before: previous.size,
          after: next.size,
          added: [...next].filter(id => !previous.has(id)).length,
          removed: [...previous].filter(id => !next.has(id)).length
        }
      })
  )

export const planTaxonomy = (snapshot: TaxonomySnapshot, input: unknown): { preview: TaxonomyPreview; after: TaxonomySnapshot; changedPageIds: number[] } => {
  const change = taxonomyChange(input)
  const source = taxonomyInventory(snapshot).find(t => t.id === change.tagId)
  if (!source) throw new ApplicationError('This tag no longer exists.', { status: 404, code: 'TAG_NOT_FOUND' })
  const after = structuredClone(snapshot)
  const nextSource = after.tags.find(t => t.id === source.id)!
  const aliases = snapshot.tags.filter(t => t.id !== source.id && canonicalId(snapshot.tags, t.id) === source.id)
  let destination: TagRow | null = null
  if (change.action === 'edit' || change.action === 'merge') {
    if (source.isArchived || source.redirectToId !== null)
      return invalid('Only active canonical tags can be edited or merged. Open the destination, or restore this tag first.')
    if (change.action === 'edit' && change.tag === source.tag) {
      if (change.title === source.title) return invalid('There are no changes to save.')
      nextSource.title = change.title
    } else {
      if (change.action === 'edit') {
        if (snapshot.tags.some(t => t.tag === change.tag))
          return invalid('This name is already reserved by a tag, alias or archived tag. Choose another name, or merge into an active tag.')
        destination = { ...nextSource, id: -1, tag: change.tag, title: change.title }
        after.tags.push(destination)
      } else {
        destination = after.tags.find(t => t.id === change.targetId) ?? null
        if (!destination || destination.isArchived || destination.redirectToId !== null)
          return invalid('The merge destination must be an active canonical tag.')
      }
      nextSource.redirectToId = destination.id
      for (const alias of aliases) after.tags.find(t => t.id === alias.id)!.redirectToId = destination.id
      for (const assignment of after.assignments) if (assignment.tagId === source.id) assignment.tagId = destination.id
      after.assignments = [...new Map(after.assignments.map(a => [`${a.pageId}:${a.tagId}`, a])).values()]
    }
  } else if (change.action === 'archive') {
    if (source.isArchived) return invalid('This tag is already archived.')
    nextSource.isArchived = true
    if (source.redirectToId === null) {
      for (const alias of aliases) after.tags.find(t => t.id === alias.id)!.isArchived = true
      after.assignments = after.assignments.filter(a => a.tagId !== source.id)
    }
  } else {
    if (!source.isArchived) return invalid('This tag is already active.')
    if (source.redirectToId !== null && after.tags.find(t => t.id === canonicalId(after.tags, source.id))?.isArchived)
      return invalid('Restore the canonical destination before restoring this alias.')
    nextSource.isArchived = false
  }
  const pageAssignments = (state: TaxonomySnapshot): Map<number, string> => {
    const byPage = new Map<number, number[]>()
    for (const assignment of state.assignments) {
      if (!byPage.has(assignment.pageId)) byPage.set(assignment.pageId, [])
      byPage.get(assignment.pageId)!.push(assignment.tagId)
    }
    return new Map([...byPage].map(([id, tags]) => [id, tags.sort((a, b) => a - b).join(',')]))
  }
  const previousAssignments = pageAssignments(snapshot),
    nextAssignments = pageAssignments(after)
  const changedPageIds = snapshot.pages.filter(page => previousAssignments.get(page.id) !== nextAssignments.get(page.id)).map(page => page.id)
  const beforeMap = tagAliasMap(snapshot.tags)
  const afterMap = tagAliasMap(after.tags)
  const names = new Set(
    snapshot.tags
      .filter(
        t => t.id === source.id || aliases.some(a => a.id === t.id) || beforeMap[t.tag] === source.tag || (destination && afterMap[t.tag] === destination.tag)
      )
      .map(t => t.tag)
  )
  if (destination) names.add(destination.tag)
  const rules = taxonomyRules(snapshot, after, names)
  const inventory = taxonomyInventory(after)
  const sourceCanonical = canonicalId(snapshot.tags, source.id)
  const relevantTagIds = new Set(
    snapshot.tags
      .filter(t => canonicalId(snapshot.tags, t.id) === sourceCanonical || (destination && canonicalId(snapshot.tags, t.id) === destination.id))
      .map(t => t.id)
  )
  const relevantAssignments = snapshot.assignments.filter(a => relevantTagIds.has(a.tagId))
  const relevantPageIds = new Set(relevantAssignments.map(a => a.pageId))
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        change,
        tags: snapshot.tags,
        groups: snapshot.groups,
        assignments: relevantAssignments,
        pages: snapshot.pages.filter(p => relevantPageIds.has(p.id)),
        history: snapshot.history.filter(h => relevantTagIds.has(h.tagId))
      })
    )
    .digest('hex')
  return {
    after,
    changedPageIds,
    preview: {
      fingerprint,
      change,
      source,
      destination: destination ? inventory.find(t => t.id === destination.id)! : null,
      pages: snapshot.pages.filter(p => changedPageIds.includes(p.id)),
      aliases: taxonomyInventory(snapshot).filter(t => aliases.some(a => a.id === t.id)),
      rules,
      accessChanges: rules.some(r => r.added > 0 || r.removed > 0),
      pageCount: changedPageIds.length
    }
  }
}
