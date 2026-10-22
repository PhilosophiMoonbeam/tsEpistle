import type { Knex } from 'knex'
import {
  GLOSSARY_LIMITS,
  GLOSSARY_RULE_PATH,
  glossaryNameKey,
  type GlossaryAccess,
  type GlossaryAutolinkTerm,
  type GlossaryDocumentation,
  type GlossaryPage,
  type GlossaryReference,
  type GlossaryTerm,
  type GlossaryTermInput,
  type GlossaryTermSummary
} from '../../shared/glossary.ts'
import { publicationWindowOpen } from '../../shared/publication-window.ts'
import { accountSessionIsCurrent } from '../helpers/account-session.ts'
import { isApiPrincipal } from '../helpers/api-principal.ts'
import { evaluateGroupAccess, pageRuleAuthorityMatchesRequester, type PageRuleAuthority } from '../helpers/group-access.ts'
import { pageAuthorizationContext, pageRoute, principalId, type PagePrincipal, type PageVisibilityRecord } from '../helpers/page-access.ts'
import { renderCommentMarkdown } from '../helpers/comment-markdown.ts'
import errors from './errors.ts'

const { ApplicationError } = errors
interface Dependencies {
  db: Knex
  enabled(): boolean
  loadAuthority(requester: PagePrincipal, tx: Knex.Transaction): Promise<PageRuleAuthority>
}
export interface GlossaryRequestContext {
  requester: PagePrincipal
  sessionId: string
}
type RequestContext = GlossaryRequestContext
export interface GlossaryCatalogInput {
  locale?: unknown
  query?: unknown
  limit?: unknown
  cursor?: unknown
}
export interface GlossaryOperations {
  access(context: GlossaryRequestContext, locale: unknown): Promise<GlossaryAccess>
  list(context: GlossaryRequestContext, input: GlossaryCatalogInput): Promise<GlossaryPage<GlossaryTermSummary>>
  autolink(context: GlossaryRequestContext, input: GlossaryCatalogInput): Promise<GlossaryPage<GlossaryAutolinkTerm>>
  get(context: GlossaryRequestContext, id: unknown, locale?: unknown): Promise<GlossaryTerm>
  lookup(context: GlossaryRequestContext, locale: unknown, name: unknown): Promise<GlossaryTerm>
  create(context: GlossaryRequestContext, input: unknown): Promise<GlossaryTerm>
  update(context: GlossaryRequestContext, id: unknown, input: unknown): Promise<GlossaryTerm>
  remove(context: GlossaryRequestContext, id: unknown, expectedRevision: unknown): Promise<{ deleted: true }>
}
interface TermRow extends Omit<GlossaryTermInput, 'aliases' | 'relatedIds'> {
  id: number
  revision: number
  createdAt: string | Date
  updatedAt: string | Date
}
type TermTable = Knex.CompositeTableType<TermRow, Omit<TermRow, 'id' | 'references'> & { references: string }>
interface NameRow {
  locale: string
  termId: number
  name: string
  key: string
  isAlias: boolean
}
interface RelationRow {
  leftId: number
  rightId: number
  locale: string
}
interface DocumentationRow extends PageVisibilityRecord {
  id: number
  title: string
  localeCode: string
  isPublished: boolean
  publishStartDate: string | null
  publishEndDate: string | null
}
const fail = (message: string, status = 400, code = 'GLOSSARY_INVALID_INPUT'): never => {
  throw new ApplicationError(message, { status, code })
}
const positiveInteger = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) return fail('Choose a valid integer ID or revision.')
  return value
}
const localeValue = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 35 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value)) return fail('Choose a valid locale.')
  return value
}
const hasInvalidTextControl = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) return true
  }
  return false
}
const text = (value: unknown, maximum: number, required = false): string => {
  if (typeof value !== 'string' || value.length > maximum || hasInvalidTextControl(value)) return fail('A glossary text field is invalid or too long.')
  const result = value.normalize('NFC').trim()
  if (required && !result) return fail('A term or alias must not be empty.')
  return result
}
const definitionText = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > GLOSSARY_LIMITS.definition || hasInvalidTextControl(value))
    return fail('Glossary Markdown is invalid or too long.')
  // Markdown indentation and trailing spaces are authored source, not name normalization.
  return value
}
const array = (value: unknown, maximum: number): unknown[] => {
  if (!Array.isArray(value) || value.length > maximum) return fail('A glossary collection is invalid or too long.')
  return value
}
const parseInput = (raw: unknown): GlossaryTermInput => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Supply a glossary term.')
  const value = raw as Record<string, unknown>
  const term = text(value.term, GLOSSARY_LIMITS.name, true).replace(/\s+/gu, ' ')
  const aliases = array(value.aliases ?? [], GLOSSARY_LIMITS.aliases).map(alias => text(alias, GLOSSARY_LIMITS.name, true).replace(/\s+/gu, ' '))
  const keys = [term, ...aliases].map(glossaryNameKey)
  if (new Set(keys).size !== keys.length) return fail('Term and aliases must have distinct names.')
  const references = array(value.references ?? [], GLOSSARY_LIMITS.references).map(reference => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return fail('Supply a reference label and URL.')
    const record = reference as Record<string, unknown>
    const label = text(record.label, GLOSSARY_LIMITS.name, true),
      url = text(record.url, 2048, true)
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return fail('Reference URLs must be absolute HTTP or HTTPS URLs.')
    }
    // text() rejects other controls; URLs must additionally exclude all whitespace.
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || /\s/u.test(url))
      return fail('Reference URLs must be safe HTTP or HTTPS URLs.')
    return { label, url } satisfies GlossaryReference
  })
  const relatedIds = array(value.relatedIds ?? [], GLOSSARY_LIMITS.relatedIds).map(positiveInteger)
  if (new Set(relatedIds).size !== relatedIds.length) return fail('Related terms must be distinct.')
  if ((value.caseSensitive !== undefined && typeof value.caseSensitive !== 'boolean') || (value.autoLink !== undefined && typeof value.autoLink !== 'boolean'))
    return fail('Glossary flags must be booleans.')
  return {
    locale: localeValue(value.locale),
    term,
    aliases,
    references,
    relatedIds,
    expansion: text(value.expansion ?? '', GLOSSARY_LIMITS.name),
    definition: definitionText(value.definition ?? ''),
    category: text(value.category ?? '', GLOSSARY_LIMITS.name),
    documentationLabel: text(value.documentationLabel ?? '', GLOSSARY_LIMITS.name),
    documentationPageId: value.documentationPageId === undefined || value.documentationPageId === null ? null : positiveInteger(value.documentationPageId),
    caseSensitive: value.caseSensitive === true,
    autoLink: value.autoLink !== false
  }
}
const summary = (row: TermRow): GlossaryTermSummary => ({
  id: row.id,
  revision: row.revision,
  locale: row.locale,
  term: row.term,
  expansion: row.expansion,
  category: row.category
})
const allowed = (authority: PageRuleAuthority, locale: string, permission: string): boolean =>
  evaluateGroupAccess(authority.permissions, [permission], authority.groups, { path: GLOSSARY_RULE_PATH, locale, tags: [] }, authority.tagAliases, false)
    .allowed
const notFound = (): never => fail('Glossary term not found.', 404, 'GLOSSARY_NOT_FOUND')
const conflict = (): never => fail('This term changed. Reload it before saving.', 409, 'GLOSSARY_REVISION_CONFLICT')
const relationQuery = (tx: Knex.Transaction, id: number) =>
  tx<RelationRow>('glossaryTermRelations').where(query => query.where('leftId', id).orWhere('rightId', id))
const peerIds = (rows: RelationRow[], id: number): number[] => rows.map(row => (row.leftId === id ? row.rightId : row.leftId)).sort((a, b) => a - b)
const cursorId = (value: unknown, locale: string, query: string, mode: string): number => {
  if (value === undefined || value === null || value === '') return 0
  if (typeof value !== 'string' || value.length > 2048) return fail('Invalid glossary continuation.')
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (!Array.isArray(cursor) || cursor.length !== 4 || cursor[0] !== locale || cursor[1] !== query || cursor[2] !== mode)
      return fail('Invalid glossary continuation.')
    return positiveInteger(cursor[3])
  } catch {
    return fail('Invalid glossary continuation.')
  }
}
const limitValue = (raw: unknown, maximum: number, fallback: number): number => {
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^\d+$/.test(raw))) return fail('Choose a valid glossary page size.')
  const limit = Number(raw)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) return fail(`Glossary page size must be between 1 and ${maximum}.`)
  return limit
}

export const createGlossaryOperations = (deps: Dependencies): GlossaryOperations => {
  const authorize = async (tx: Knex.Transaction, context: RequestContext, locale: string, write = false, discover = false): Promise<PageRuleAuthority> => {
    if (!deps.enabled()) return fail('Glossary is disabled.', 404, 'GLOSSARY_DISABLED')
    const userId = principalId(context.requester)
    if (write) {
      if (isApiPrincipal(context.requester)) return fail('API-key principals cannot perform direct mutations.', 403, 'API_KEY_MUTATION_FORBIDDEN')
      if (userId === null || !context.sessionId) return fail('Sign in to manage the glossary.', 401, 'AUTH_REQUIRED')
    }
    if (userId !== null) {
      // Security and membership writers lock groups before accounts. Lock the
      // group set first, then retain current account/membership authority below.
      await tx('groups').select('id').orderBy('id').forShare()
      const account = await tx<{ id: number; isActive: boolean; authVersion: number }>('users')
        .where({ id: userId })
        .forShare()
        .first('id', 'isActive', 'authVersion')
      if (!accountSessionIsCurrent({ id: userId, authVersion: context.requester && Reflect.get(context.requester, 'authVersion') }, account))
        return fail('A current account session is required.', 401, 'AUTH_REQUIRED')
      // Membership writers lock the same account; retain this lock until commit.
      await tx('userGroups').where({ userId }).forShare().select('groupId')
    }
    const authority = await deps.loadAuthority(context.requester, tx)
    if (!pageRuleAuthorityMatchesRequester(context.requester, authority)) return fail('Glossary access denied.', 403, 'GLOSSARY_FORBIDDEN')
    if (!discover && !allowed(authority, locale, write ? 'manage:glossary' : 'read:glossary')) return fail('Glossary access denied.', 403, 'GLOSSARY_FORBIDDEN')
    return authority
  }
  const documentation = async (
    tx: Knex.Transaction,
    context: RequestContext,
    authority: PageRuleAuthority,
    row: TermRow
  ): Promise<GlossaryDocumentation | null> => {
    if (row.documentationPageId === null) return null
    const page = await tx<DocumentationRow>('pages')
      .where({ id: row.documentationPageId })
      .first('id', 'title', 'path', 'localeCode', 'visibility', 'ownerId', 'isPublished', 'publishStartDate', 'publishEndDate')
    if (!page) return null
    const tags = await tx<{ tag: string }>('tags')
      .join('pageTags', 'pageTags.tagId', 'tags.id')
      .where('pageTags.pageId', page.id)
      .select(tx.ref('tag').withSchema('tags'))
    const system = authority.permissions.includes('manage:system')
    const pageContext = pageAuthorizationContext({ ...page, tags })
    if (!pageContext) return null
    const ruleAllows = (roles: string[]) =>
      evaluateGroupAccess(authority.permissions, roles, authority.groups, pageContext, authority.tagAliases, false).allowed
    const readable = page.visibility === 'private' ? system || principalId(context.requester) === page.ownerId : ruleAllows(['read:pages'])
    if (!readable || (page.visibility === 'public' && (!page.isPublished || !publicationWindowOpen(page)) && !ruleAllows(['write:pages', 'manage:pages'])))
      return null
    if (!system) {
      const password = await tx<{ pageId: number; version: number }>('pageAccessPasswords').where({ pageId: page.id }).first('version')
      if (password) {
        if (!context.sessionId) return null
        const grant = await tx('pageUnlockGrants')
          .where({ pageId: page.id, sessionId: context.sessionId, userId: principalId(context.requester), passwordVersion: password.version })
          .where('expiresAt', '>', new Date())
          .first('id')
        if (!grant) return null
      }
    }
    return { id: page.id, title: page.title, label: row.documentationLabel || page.title, href: pageRoute(page), locale: page.localeCode, path: page.path }
  }
  const project = async (tx: Knex.Transaction, context: RequestContext, authority: PageRuleAuthority, row: TermRow): Promise<GlossaryTerm> => {
    const names = await tx<NameRow>('glossaryNames').where({ termId: row.id, isAlias: true }).orderBy('key').select('name')
    const relatedIds = peerIds(await relationQuery(tx, row.id), row.id)
    const related = relatedIds.length ? await tx<TermRow>('glossaryTerms').whereIn('id', relatedIds).orderBy('id') : []
    const doc = await documentation(tx, context, authority, row)
    return {
      ...summary(row),
      definition: row.definition,
      definitionHtml: renderCommentMarkdown(row.definition),
      aliases: names.map(name => name.name),
      relatedIds,
      relatedTerms: related.map(summary),
      references: row.references,
      category: row.category,
      autoLink: row.autoLink,
      caseSensitive: row.caseSensitive,
      documentationPageId: doc?.id ?? null,
      documentationLabel: doc ? row.documentationLabel : '',
      documentation: doc,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString()
    }
  }
  const load = async (tx: Knex.Transaction, context: RequestContext, rawId: unknown, rawLocale?: unknown) => {
    if (!deps.enabled()) return fail('Glossary is disabled.', 404, 'GLOSSARY_DISABLED')
    const query = tx<TermRow>('glossaryTerms').where({ id: positiveInteger(rawId) })
    if (rawLocale !== undefined) query.where({ locale: localeValue(rawLocale) })
    const row = await query.first()
    if (!row) return notFound()
    const authority = await authorize(tx, context, row.locale)
    return { row, authority }
  }
  const save = async (context: RequestContext, raw: unknown, rawId?: unknown): Promise<GlossaryTerm> => {
    const input = parseInput(raw),
      id = rawId === undefined ? undefined : positiveInteger(rawId)
    const expectedRevision = id === undefined ? undefined : positiveInteger(Reflect.get(raw as object, 'expectedRevision'))
    try {
      return await deps.db.transaction(async tx => {
        // Serialize the locale's relation sets as well as name swaps across replicas.
        await tx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`tsepistle:glossary:${input.locale}`])
        const authority = await authorize(tx, context, input.locale, true)
        const previous = id === undefined ? undefined : await tx<TermRow>('glossaryTerms').where({ id }).forUpdate().first()
        if (id !== undefined && (!previous || previous.locale !== input.locale)) return notFound()
        if (previous && previous.revision !== expectedRevision) return conflict()
        if (previous) {
          // Redacted reads cannot round-trip protected IDs or labels. Preserve
          // omissions on an unchanged association, but never carry a hidden label
          // onto another page or retain it through unlinking.
          if (Reflect.get(raw as object, 'documentationPageId') === undefined) input.documentationPageId = previous.documentationPageId
          if (Reflect.get(raw as object, 'documentationLabel') === undefined) {
            if (
              previous.documentationPageId !== null &&
              previous.documentationPageId !== input.documentationPageId &&
              !(await documentation(tx, context, authority, previous))
            )
              return fail('Provide an explicit documentation label when changing a protected documentation page.')
            input.documentationLabel = previous.documentationLabel
          }
        }
        if (id !== undefined && input.relatedIds.includes(id)) return fail('A term cannot relate to itself.')
        const related = input.relatedIds.length ? await tx<TermRow>('glossaryTerms').whereIn('id', input.relatedIds).select('id', 'locale') : []
        if (related.length !== input.relatedIds.length || related.some(term => term.locale !== input.locale))
          return fail('Related terms must exist in the same locale.')
        if (input.documentationPageId !== null) {
          const candidate = { ...input, id: id ?? 0, revision: 1, createdAt: new Date(), updatedAt: new Date() }
          const preservesHiddenLink = previous?.documentationPageId === input.documentationPageId && previous.documentationLabel === input.documentationLabel
          if (!preservesHiddenLink && !(await documentation(tx, context, authority, candidate)))
            return fail('Choose a currently readable, unlocked documentation page.')
        }
        const now = new Date(),
          { aliases, relatedIds, ...fields } = input
        let savedId: number
        if (previous) {
          savedId = previous.id
          const changed = await tx('glossaryTerms')
            .where({ id: savedId, revision: expectedRevision })
            .update({ ...fields, references: JSON.stringify(fields.references), revision: previous.revision + 1, updatedAt: now })
          if (!changed) return conflict()
        } else {
          const rows = await tx<TermTable>('glossaryTerms')
            .insert({ ...fields, references: JSON.stringify(fields.references), revision: 1, createdAt: now, updatedAt: now })
            .returning('id')
          savedId = rows[0]!.id
        }
        const oldRelations = await relationQuery(tx, savedId),
          oldPeers = peerIds(oldRelations, savedId)
        const changedPeers = [...new Set([...oldPeers.filter(peer => !relatedIds.includes(peer)), ...relatedIds.filter(peer => !oldPeers.includes(peer))])]
        for (const peer of relatedIds.filter(peer => !oldPeers.includes(peer))) {
          const count = await relationQuery(tx, peer).count<{ count: string }>('* as count').first()
          if (Number(count?.count ?? 0) >= GLOSSARY_LIMITS.relatedIds) return fail('A related term already has the maximum number of relations.')
        }
        await tx('glossaryNames').where({ termId: savedId }).delete()
        await tx('glossaryNames').insert(
          [input.term, ...aliases].map((name, index) => ({ locale: input.locale, key: glossaryNameKey(name), name, termId: savedId, isAlias: index !== 0 }))
        )
        await relationQuery(tx, savedId).delete()
        if (relatedIds.length)
          await tx('glossaryTermRelations').insert(
            relatedIds.map(peer => ({ locale: input.locale, leftId: Math.min(savedId, peer), rightId: Math.max(savedId, peer) }))
          )
        if (changedPeers.length) await tx('glossaryTerms').whereIn('id', changedPeers).increment('revision', 1).update({ updatedAt: now })
        const row = await tx<TermRow>('glossaryTerms').where({ id: savedId }).first()
        if (!row) return notFound()
        return project(tx, context, authority, row)
      })
    } catch (error) {
      if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === '23505')
        return fail('A term or alias already uses this name in this locale.', 409, 'GLOSSARY_NAME_CONFLICT')
      throw error
    }
  }
  type CatalogInput = GlossaryCatalogInput
  async function catalog(context: RequestContext, input: CatalogInput, autolink: true): Promise<GlossaryPage<GlossaryAutolinkTerm>>
  async function catalog(context: RequestContext, input: CatalogInput, autolink?: false): Promise<GlossaryPage<GlossaryTermSummary>>
  async function catalog(context: RequestContext, input: CatalogInput, autolink = false): Promise<GlossaryPage<GlossaryTermSummary | GlossaryAutolinkTerm>> {
    const locale = localeValue(input.locale),
      query = glossaryNameKey(text(input.query ?? '', GLOSSARY_LIMITS.name))
    const limit = limitValue(input.limit, autolink ? GLOSSARY_LIMITS.autolink : GLOSSARY_LIMITS.directory, autolink ? GLOSSARY_LIMITS.autolink : 50)
    const mode = autolink ? 'autolink' : 'directory',
      after = cursorId(input.cursor, locale, query, mode)
    return deps.db.transaction(async tx => {
      await authorize(tx, context, locale)
      const builder = tx<TermRow>('glossaryTerms')
        .where({ locale })
        .where('id', '>', after)
        .orderBy('id')
        .limit(limit + 1)
      if (autolink) builder.where({ autoLink: true })
      if (query)
        builder.where(scope =>
          scope
            .whereExists(tx('glossaryNames').select(tx.raw('1')).whereRaw('"termId" = "glossaryTerms"."id"').whereRaw('position(? in "key") > 0', [query]))
            .orWhereRaw('position(? in lower(expansion)) > 0', [query])
            .orWhereRaw('position(? in lower(category)) > 0', [query])
        )
      const rows = await builder,
        complete = rows.length <= limit,
        page = rows.slice(0, limit)
      let items: Array<GlossaryTermSummary | GlossaryAutolinkTerm> = page.map(summary)
      if (autolink) {
        const names = page.length
          ? await tx<NameRow>('glossaryNames')
              .whereIn(
                'termId',
                page.map(row => row.id)
              )
              .where({ isAlias: true })
              .orderBy('key')
          : []
        const byTerm = new Map<number, string[]>()
        for (const name of names) {
          const aliases = byTerm.get(name.termId) ?? []
          aliases.push(name.name)
          byTerm.set(name.termId, aliases)
        }
        items = page.map(row => ({ id: row.id, term: row.term, aliases: byTerm.get(row.id) ?? [], caseSensitive: row.caseSensitive }))
      }
      return {
        items,
        complete,
        nextCursor: complete ? null : Buffer.from(JSON.stringify([locale, query, mode, page[page.length - 1]!.id])).toString('base64url')
      }
    })
  }
  return {
    async access(context: RequestContext, rawLocale: unknown): Promise<GlossaryAccess> {
      const locale = localeValue(rawLocale)
      if (!deps.enabled()) return { enabled: false, locale, canRead: false, canManage: false }
      return deps.db.transaction(async tx => {
        const authority = await authorize(tx, context, locale, false, true)
        return {
          enabled: true,
          locale,
          canRead: allowed(authority, locale, 'read:glossary'),
          canManage: allowed(authority, locale, 'manage:glossary') && principalId(context.requester) !== null && Boolean(context.sessionId)
        }
      })
    },
    list: (context: RequestContext, input: CatalogInput) => catalog(context, input),
    autolink: (context: RequestContext, input: CatalogInput) => catalog(context, input, true),
    async get(context: RequestContext, id: unknown, locale?: unknown): Promise<GlossaryTerm> {
      return deps.db.transaction(async tx => {
        const { row, authority } = await load(tx, context, id, locale)
        return project(tx, context, authority, row)
      })
    },
    async lookup(context: RequestContext, rawLocale: unknown, name: unknown): Promise<GlossaryTerm> {
      const locale = localeValue(rawLocale),
        key = glossaryNameKey(text(name, GLOSSARY_LIMITS.name, true))
      return deps.db.transaction(async tx => {
        const authority = await authorize(tx, context, locale)
        const claim = await tx<NameRow>('glossaryNames').where({ locale, key }).first('termId')
        const row = claim ? await tx<TermRow>('glossaryTerms').where({ id: claim.termId, locale }).first() : undefined
        if (!row) return notFound()
        return project(tx, context, authority, row)
      })
    },
    create: (context: RequestContext, raw: unknown) => save(context, raw),
    update: (context: RequestContext, id: unknown, raw: unknown) => save(context, raw, id),
    async remove(context: RequestContext, rawId: unknown, rawRevision: unknown): Promise<{ deleted: true }> {
      if (!deps.enabled()) return fail('Glossary is disabled.', 404, 'GLOSSARY_DISABLED')
      const id = positiveInteger(rawId),
        expectedRevision = positiveInteger(rawRevision)
      return deps.db.transaction(async tx => {
        const candidate = await tx<TermRow>('glossaryTerms').where({ id }).first('locale')
        if (!candidate) return notFound()
        await tx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`tsepistle:glossary:${candidate.locale}`])
        await authorize(tx, context, candidate.locale, true)
        const row = await tx<TermRow>('glossaryTerms').where({ id }).forUpdate().first()
        if (!row) return notFound()
        if (row.revision !== expectedRevision) return conflict()
        const peers = peerIds(await relationQuery(tx, id), id)
        if (peers.length) await tx('glossaryTerms').whereIn('id', peers).increment('revision', 1).update({ updatedAt: new Date() })
        await tx('glossaryTerms').where({ id, revision: expectedRevision }).delete()
        return { deleted: true }
      })
    }
  }
}

export const glossaryOperations = (): GlossaryOperations => {
  const wiki = (globalThis as typeof globalThis & { WIKI: unknown }).WIKI as {
    config: { features?: { featureGlossary?: boolean } }
    auth: { loadPageRuleAuthority(requester: PagePrincipal, tx: Knex.Transaction): Promise<PageRuleAuthority> }
    models: { knex: Knex }
  }
  return createGlossaryOperations({
    db: wiki.models.knex,
    enabled: () => wiki.config.features?.featureGlossary !== false,
    loadAuthority: (requester, tx) => wiki.auth.loadPageRuleAuthority(requester, tx)
  })
}
