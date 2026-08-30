import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs-then'
import type { Knex } from 'knex'
import { canReadPage, canWritePage, managesSystem, principalId, type PagePrincipal, type PageVisibilityRecord } from '../helpers/page-access.ts'
import errors from './errors.ts'

const { ApplicationError } = errors
const BCRYPT_COST = 12
const GRANT_LIFETIME_MS = 12 * 60 * 60 * 1_000
const FAKE_PASSWORD_HASH = '$2a$12$irXbAcQSY59pcQQfNQpY8uyhfSw48nzDikAmr60drI501nR.PuBx2'

interface ProtectedPage extends PageVisibilityRecord, Record<string, unknown> {
  id: number
  title: string
  content?: string
  render?: string
}

interface ProtectionRow {
  pageId: number
  passwordHash: string
  version: number
  updatedBy: number
  updatedAt: string | Date
}

interface WikiContext {
  auth: { checkAccess(user: PagePrincipal, permissions: readonly string[], context?: unknown): boolean }
  data: { searchEngine: { updated(page: unknown): Promise<void> } }
  models: {
    knex: Knex
    pages: {
      getPageFromDb(id: number): Promise<ProtectedPage | undefined>
      query(): {
        findById(id: number): { select(...columns: string[]): Promise<Record<string, unknown> | undefined> }
      }
      cleanHTML(value: string): string
    }
  }
}

const wiki = (global as typeof globalThis & { WIKI: unknown }).WIKI as unknown as WikiContext

const authenticatedId = (requester: PagePrincipal): number => {
  const id = principalId(requester)
  const email = requester && typeof requester === 'object' ? Reflect.get(requester, 'email') : undefined
  if (id === null || id === 2 || email === 'api@localhost') throw new ApplicationError('Authentication is required', { status: 401, code: 'AUTH_REQUIRED' })
  return id
}

const manageablePage = async (requester: PagePrincipal, pageId: number): Promise<ProtectedPage> => {
  const page = await wiki.models.pages.getPageFromDb(pageId)
  if (!page || !canWritePage(requester, page)) throw new ApplicationError('Page not found', { status: 404, code: 'PAGE_NOT_FOUND' })
  return page
}

const normalizedAssetPath = (value: string): string | null => {
  try {
    const parsed = new URL(value, 'https://wiki.local')
    if (parsed.origin !== 'https://wiki.local') return null
    const path = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
    if (!path || path.length > 512 || path.startsWith('_') || path.startsWith('api/')) return null
    return path
  } catch {
    return null
  }
}

export const extractProtectedAssetPaths = (content: string, render: string): string[] => {
  const values = new Set<string>()
  const patterns = [/(?:src|href)\s*=\s*["']([^"'#]+)["']/gi, /!?\[[^\]]*\]\(([^\s)#]+)(?:\s+[^)]*)?\)/g, /url\(\s*["']?([^"')#]+)["']?\s*\)/gi]
  for (const source of [content, render]) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      for (const match of source.matchAll(pattern)) {
        const path = normalizedAssetPath(match[1] ?? '')
        if (path) values.add(path)
      }
    }
  }
  return [...values].sort()
}

export const syncProtectedPageAssets = async (knex: Knex | Knex.Transaction, pageId: number, content: string, render: string): Promise<void> => {
  const protection = await knex<ProtectionRow>('pageAccessPasswords').where({ pageId }).first()
  if (!protection) return
  const paths = extractProtectedAssetPaths(content, render)
  await knex('pageProtectedAssets').where({ pageId }).delete()
  if (paths.length > 0) await knex('pageProtectedAssets').insert(paths.map(assetPath => ({ pageId, assetPath })))
}

export const redactProtectedPageForSearch = async <T extends { id: number; safeContent?: string }>(page: T): Promise<T> => {
  const protectedPage = await wiki.models.knex<ProtectionRow>('pageAccessPasswords').where({ pageId: page.id }).first()
  if (protectedPage) page.safeContent = ''
  return page
}

export const getPageProtection = async (requester: PagePrincipal, pageId: number): Promise<Record<string, unknown>> => {
  await manageablePage(requester, pageId)
  const protection = await wiki.models.knex<ProtectionRow>('pageAccessPasswords').where({ pageId }).first()
  return protection
    ? { protected: true, version: protection.version, updatedBy: protection.updatedBy, updatedAt: protection.updatedAt }
    : { protected: false, version: 0, updatedBy: null, updatedAt: null }
}

export const isPageProtected = async (pageId: number): Promise<boolean> =>
  Boolean(await wiki.models.knex<ProtectionRow>('pageAccessPasswords').where({ pageId }).first())

export const setPageProtection = async (input: {
  requester: PagePrincipal
  pageId: number
  password: string
  sessionId: string
}): Promise<Record<string, unknown>> => {
  const userId = authenticatedId(input.requester)
  const page = await manageablePage(input.requester, input.pageId)
  if (input.password.length < 12 || input.password.length > 1024) {
    throw new ApplicationError('Page passwords must contain between 12 and 1024 characters', { status: 400, code: 'INVALID_PASSWORD' })
  }
  if (!input.sessionId) throw new ApplicationError('A session is required', { status: 401, code: 'SESSION_REQUIRED' })
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST)
  const now = new Date()
  let version = 0
  await wiki.models.knex.transaction(async transaction => {
    const pageContents = await transaction('pages').where({ id: page.id }).select('content', 'render').forUpdate().first()
    const existing = await transaction<ProtectionRow>('pageAccessPasswords').where({ pageId: page.id }).forUpdate().first()
    version = (existing?.version ?? 0) + 1
    if (existing) {
      await transaction('pageAccessPasswords').where({ pageId: page.id }).update({ passwordHash, version, updatedBy: userId, updatedAt: now })
      await transaction('pageUnlockGrants').where({ pageId: page.id }).delete()
    } else {
      await transaction('pageAccessPasswords').insert({ pageId: page.id, passwordHash, version, updatedBy: userId, updatedAt: now })
    }
    await syncProtectedPageAssets(transaction, page.id, String(pageContents?.content ?? ''), String(pageContents?.render ?? ''))
    await transaction('pageUnlockGrants').insert({
      id: randomUUID(),
      pageId: page.id,
      sessionId: input.sessionId,
      userId,
      passwordVersion: version,
      createdAt: now,
      expiresAt: new Date(now.valueOf() + GRANT_LIFETIME_MS)
    })
  })
  Reflect.set(page, 'safeContent', '')
  await wiki.data.searchEngine.updated(page)
  return { protected: true, version, updatedBy: userId, updatedAt: now }
}

export const removePageProtection = async (input: { requester: PagePrincipal; pageId: number }): Promise<{ protected: false }> => {
  const page = await manageablePage(input.requester, input.pageId)
  await wiki.models.knex('pageAccessPasswords').where({ pageId: page.id }).delete()
  const contents = await wiki.models.pages.query().findById(page.id).select('render')
  Reflect.set(page, 'safeContent', wiki.models.pages.cleanHTML(String(contents?.render ?? '')))
  await wiki.data.searchEngine.updated(page)
  return { protected: false }
}

export const unlockPage = async (input: { requester: PagePrincipal; pageId: number; password: string; sessionId: string }): Promise<void> => {
  if (!input.sessionId || typeof input.password !== 'string') throw new ApplicationError('Access denied', { status: 403, code: 'PAGE_LOCKED' })
  const [protection, page] = await Promise.all([
    wiki.models.knex<ProtectionRow>('pageAccessPasswords').where({ pageId: input.pageId }).first(),
    wiki.models.pages.getPageFromDb(input.pageId)
  ])
  const valid = await bcrypt.compare(input.password, protection?.passwordHash ?? FAKE_PASSWORD_HASH)
  if (!protection || !valid || !page || !canReadPage(input.requester, page)) {
    throw new ApplicationError('Access denied', { status: 403, code: 'PAGE_LOCKED' })
  }
  const now = new Date()
  await wiki.models.knex('pageUnlockGrants').where({ pageId: input.pageId, sessionId: input.sessionId }).delete()
  await wiki.models.knex('pageUnlockGrants').insert({
    id: randomUUID(),
    pageId: input.pageId,
    sessionId: input.sessionId,
    userId: principalId(input.requester),
    passwordVersion: protection.version,
    createdAt: now,
    expiresAt: new Date(now.valueOf() + GRANT_LIFETIME_MS)
  })
}

export const pageRequiresUnlock = async (input: { requester: PagePrincipal; pageId: number; sessionId: string; now?: Date }): Promise<boolean> => {
  if (managesSystem(input.requester)) return false
  const protection = await wiki.models.knex<ProtectionRow>('pageAccessPasswords').where({ pageId: input.pageId }).first()
  if (!protection) return false
  const now = input.now ?? new Date()
  await wiki.models.knex('pageUnlockGrants').where('expiresAt', '<=', now).delete()
  if (!input.sessionId) return true
  const grant = await wiki.models
    .knex('pageUnlockGrants')
    .where({ pageId: input.pageId, sessionId: input.sessionId, userId: principalId(input.requester), passwordVersion: protection.version })
    .where('expiresAt', '>', now)
    .first()
  return !grant
}

export const assertPageUnlocked = async (input: { requester: PagePrincipal; pageId: number; sessionId: string }): Promise<void> => {
  const page = await wiki.models.pages.getPageFromDb(input.pageId)
  if (!page || !canReadPage(input.requester, page)) {
    throw new ApplicationError('Page not found', { status: 404, code: 'PAGE_NOT_FOUND' })
  }
  if (await pageRequiresUnlock(input)) throw new ApplicationError('Access denied', { status: 403, code: 'PAGE_LOCKED' })
}

export const protectedAssetRequiresUnlock = async (input: { requester: PagePrincipal; assetPath: string; sessionId: string; now?: Date }): Promise<boolean> => {
  if (managesSystem(input.requester)) return false
  const links = await wiki.models.knex<{ pageId: number; assetPath: string }>('pageProtectedAssets').where({ assetPath: input.assetPath }).select('pageId')
  if (links.length === 0) return false
  const now = input.now ?? new Date()
  await wiki.models.knex('pageUnlockGrants').where('expiresAt', '<=', now).delete()
  if (!input.sessionId) return true
  const pageIds = links.map(link => link.pageId)
  const grants = await wiki.models
    .knex<{ pageId: number }>('pageUnlockGrants')
    .join('pageAccessPasswords', 'pageAccessPasswords.pageId', 'pageUnlockGrants.pageId')
    .whereIn('pageUnlockGrants.pageId', pageIds)
    .where({
      'pageUnlockGrants.sessionId': input.sessionId,
      'pageUnlockGrants.userId': principalId(input.requester)
    })
    .whereRaw('?? = ??', ['pageUnlockGrants.passwordVersion', 'pageAccessPasswords.version'])
    .where('pageUnlockGrants.expiresAt', '>', now)
    .select('pageUnlockGrants.pageId')
  const pages = await Promise.all(grants.map(grant => wiki.models.pages.getPageFromDb(grant.pageId)))
  return !pages.some(page => page && canReadPage(input.requester, page))
}
