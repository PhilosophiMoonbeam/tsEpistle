import type { Knex } from 'knex'
import { z } from 'zod'
import {
  DELETED_PAGE_RECOVERY_MAX_PAGE_SIZE,
  DeletedPageRecoveryInspectSchema,
  DeletedPageRecoveryListRequestSchema,
  DeletedPageRecoveryListSchema,
  DeletedPageRecoveryResultSchema,
  DeletedPageRecoveryRestoreRequestSchema,
  type DeletedPageRecoveryInspect,
  type DeletedPageRecoveryItem,
  type DeletedPageRecoveryList,
  type DeletedPageRecoveryResult,
  type DeletedPageRecoveryRestoreRequest
} from '../../shared/deleted-page-recovery.ts'
import { principalId, type PagePrincipal } from '../helpers/page-access.ts'
import errors from './errors.ts'
import pageOperations from './pages.ts'

const { ApplicationError } = errors

const RevisionSchema = z.union([z.string(), z.number().int().positive().safe()]).transform(value => String(value)).pipe(z.string().regex(/^[1-9][0-9]*$/))
const SecurityContextSchema = z.strictObject({
  version: z.literal(1),
  former: z.strictObject({
    path: z.string().min(1).max(1024),
    localeCode: z.string().min(1).max(35),
    visibility: z.enum(['public', 'private']),
    ownerId: z.number().int().positive().safe().nullable(),
    tags: z.array(z.string().min(1)).max(10_000)
  }),
  protection: z.strictObject({
    passwordHash: z.string().min(1).max(255),
    version: z.number().int().positive().safe(),
    updatedBy: z.number().int().positive().safe(),
    updatedAt: z.union([z.string().min(1), z.date()])
  }).nullable()
})

type HistoryRow = {
  id: number
  pageId: number
  sourceRevision: string | number
  path: string
  localeCode: string
  title: string
  description: string | null
  visibility: 'public' | 'private'
  ownerId: number | null
  contentType: string
  editorKey: string
  content?: string
}
type RecoveryRecordRow = {
  pageId: number
  deletionVersionId: number
  deletionRevision: string | number
  securityContext: unknown
  createdAt: Date | string
}
interface DeletedSnapshot {
  history: HistoryRow
  tags: string[]
  recoveryRecord?: RecoveryRecordRow
}
interface DeletedPageRecoveryRepository {
  listCurrentDeletedSnapshots(input: { beforeVersionId?: number; limit: number }): Promise<DeletedSnapshot[]>
  findCurrentDeletedSnapshot(input: { pageId: number; versionId: number; includeSource: boolean }): Promise<DeletedSnapshot | undefined>
  ownerExists(id: number): Promise<boolean>
}
type RestoreInput = {
  requester: PagePrincipal
  pageId: number
  deletionVersionId: number
  destination: DeletedPageRecoveryRestoreRequest['destination']
  ownerId?: number
}
type RestoreWriterResult = { pageId: number; sourceRevision: string | number; quarantined: boolean }
interface StoreDependencies {
  repository: DeletedPageRecoveryRepository
  hasSystemAccess(requester: PagePrincipal): boolean
  restore(input: RestoreInput): Promise<RestoreWriterResult>
  principalId?(requester: PagePrincipal): number | null
}

const notFound = (): never => {
  throw new ApplicationError('Deleted page not found.', { code: 'PAGE_RECOVERY_NOT_FOUND', status: 404 })
}
const conflict = (): never => {
  throw new ApplicationError('The selected deletion is no longer current. Refresh the recycle bin before restoring.', {
    code: 'PAGE_RECOVERY_CONFLICT',
    status: 409
  })
}
const invalidInput = (message: string): never => {
  throw new ApplicationError(message, { code: 'INVALID_INPUT', status: 400 })
}
const ownerRequired = (): never => {
  throw new ApplicationError('The deleted page owner no longer exists. Select a valid recovery owner before restoring.', {
    code: 'PAGE_RECOVERY_OWNER_REQUIRED',
    status: 400
  })
}
const invalidOwner = (): never => {
  throw new ApplicationError('The selected recovery owner is invalid.', { code: 'PAGE_RECOVERY_INVALID_OWNER', status: 400 })
}

const sourceRevision = (value: unknown): string => {
  const parsed = RevisionSchema.safeParse(value)
  if (!parsed.success) throw new ApplicationError('Deleted page history has an invalid source revision.', { code: 'PAGE_RECOVERY_INVALID_HISTORY', status: 409 })
  return parsed.data
}
const timestamp = (value: Date | string): string => {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.valueOf())) throw new ApplicationError('Deleted-page recovery record has an invalid timestamp.', { code: 'PAGE_RECOVERY_INVALID_HISTORY', status: 409 })
  return date.toISOString()
}
const parsedSecurityContext = (snapshot: DeletedSnapshot): z.infer<typeof SecurityContextSchema> | null => {
  const record = snapshot.recoveryRecord
  if (!record || record.pageId !== snapshot.history.pageId || record.deletionVersionId !== snapshot.history.id) return null
  let raw: unknown = record.securityContext
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  const parsed = SecurityContextSchema.safeParse(raw)
  if (!parsed.success) return null
  const context = parsed.data
  if (context.former.path !== snapshot.history.path || context.former.localeCode !== snapshot.history.localeCode) return null
  const deletionRevision = RevisionSchema.safeParse(record.deletionRevision)
  const historyRevision = RevisionSchema.safeParse(snapshot.history.sourceRevision)
  if (!deletionRevision.success || !historyRevision.success) return null
  const recordedAt = record.createdAt instanceof Date ? record.createdAt : new Date(record.createdAt)
  if (!Number.isFinite(recordedAt.valueOf())) return null
  return context
}
const itemFrom = (snapshot: DeletedSnapshot): DeletedPageRecoveryItem => {
  const history = snapshot.history
  const securityContext = parsedSecurityContext(snapshot)
  const deletionRevision = securityContext && snapshot.recoveryRecord
    ? RevisionSchema.safeParse(snapshot.recoveryRecord.deletionRevision)
    : null
  const preservedDeletionRevision = deletionRevision?.success ? deletionRevision.data : null
  return {
    pageId: history.pageId,
    deletionVersionId: history.id,
    deletionRevision: preservedDeletionRevision,
    title: history.title,
    description: history.description ?? '',
    path: securityContext?.former.path ?? history.path,
    localeCode: securityContext?.former.localeCode ?? history.localeCode,
    contentType: history.contentType,
    editorKey: history.editorKey,
    visibility: securityContext?.former.visibility ?? history.visibility,
    ownerId: securityContext ? securityContext.former.ownerId : history.ownerId,
    tags: securityContext ? [...securityContext.former.tags] : [...snapshot.tags],
    deletedAt: securityContext && snapshot.recoveryRecord ? timestamp(snapshot.recoveryRecord.createdAt) : null,
    restoreMode: securityContext ? 'preserve' : 'quarantine',
    protection: {
      isProtected: securityContext?.protection !== null && securityContext?.protection !== undefined,
      version: securityContext?.protection?.version ?? null
    }
  }
}

const authorize = (dependencies: StoreDependencies, requester: PagePrincipal): number => {
  const id = (dependencies.principalId ?? principalId)(requester)
  if (!requester || id === null || !dependencies.hasSystemAccess(requester)) return notFound()
  return id
}

export const createDeletedPageRecoveryStore = (dependencies: StoreDependencies) => ({
  async list(requester: PagePrincipal, rawInput: unknown = {}) : Promise<DeletedPageRecoveryList> {
    authorize(dependencies, requester)
    const parsed = DeletedPageRecoveryListRequestSchema.safeParse(rawInput)
    if (!parsed.success) return invalidInput('Deleted-page recovery list options are invalid.')
    const limit = parsed.data.limit
    const rows = await dependencies.repository.listCurrentDeletedSnapshots({
      ...(parsed.data.beforeVersionId === undefined ? {} : { beforeVersionId: parsed.data.beforeVersionId }),
      limit: Math.min(limit, DELETED_PAGE_RECOVERY_MAX_PAGE_SIZE) + 1
    })
    const hasMore = rows.length > limit
    const selected = rows.slice(0, limit)
    const items = selected.map(row => itemFrom(row))
    const result = {
      items,
      hasMore,
      nextBeforeVersionId: hasMore && selected.length ? selected[selected.length - 1]!.history.id : null
    }
    return DeletedPageRecoveryListSchema.parse(result)
  },

  async inspect(requester: PagePrincipal, input: { pageId: unknown; versionId: unknown }): Promise<DeletedPageRecoveryInspect> {
    authorize(dependencies, requester)
    const pageId = z.number().int().positive().safe().safeParse(input.pageId)
    const versionId = z.number().int().positive().safe().safeParse(input.versionId)
    if (!pageId.success || !versionId.success) return invalidInput('Deleted page identifiers are invalid.')
    const snapshot = await dependencies.repository.findCurrentDeletedSnapshot({ pageId: pageId.data, versionId: versionId.data, includeSource: true })
    if (!snapshot || typeof snapshot.history.content !== 'string') return notFound()
    const item = itemFrom(snapshot)
    const securityContext = parsedSecurityContext(snapshot)
    let ownerResolutionRequired = false
    if (securityContext?.former.visibility === 'private') {
      ownerResolutionRequired = securityContext.former.ownerId === null || !(await dependencies.repository.ownerExists(securityContext.former.ownerId))
    }
    return DeletedPageRecoveryInspectSchema.parse({
      ...item,
      sourceRevision: sourceRevision(snapshot.history.sourceRevision),
      content: snapshot.history.content,
      ownerResolutionRequired
    })
  },

  async restore(requester: PagePrincipal, input: { pageId: unknown; versionId: unknown; body: unknown }): Promise<DeletedPageRecoveryResult> {
    const recoveringAdminId = authorize(dependencies, requester)
    const pageId = z.number().int().positive().safe().safeParse(input.pageId)
    const versionId = z.number().int().positive().safe().safeParse(input.versionId)
    const body = DeletedPageRecoveryRestoreRequestSchema.safeParse(input.body)
    if (!pageId.success || !versionId.success || !body.success) return invalidInput('Deleted-page restore input is invalid.')
    const snapshot = await dependencies.repository.findCurrentDeletedSnapshot({ pageId: pageId.data, versionId: versionId.data, includeSource: false })
    if (!snapshot) return conflict()
    const securityContext = parsedSecurityContext(snapshot)
    let ownerId: number | undefined
    if (!securityContext) {
      if (body.data.ownerId !== undefined) return invalidOwner()
      ownerId = recoveringAdminId
    } else if (securityContext.former.visibility === 'public') {
      if (body.data.ownerId !== undefined) return invalidOwner()
      ownerId = undefined
    } else {
      const formerOwnerId = securityContext.former.ownerId
      const formerOwnerExists = formerOwnerId !== null && await dependencies.repository.ownerExists(formerOwnerId)
      if (formerOwnerExists) {
        if (body.data.ownerId !== undefined && body.data.ownerId !== formerOwnerId) return invalidOwner()
        ownerId = formerOwnerId
      } else {
        if (body.data.ownerId === undefined) return ownerRequired()
        if (!(await dependencies.repository.ownerExists(body.data.ownerId))) return invalidOwner()
        ownerId = body.data.ownerId
      }
    }
    const restored = await dependencies.restore({
      requester,
      pageId: pageId.data,
      deletionVersionId: versionId.data,
      destination: body.data.destination,
      ...(ownerId === undefined ? {} : { ownerId })
    })
    if (restored.pageId !== pageId.data) throw new ApplicationError('Deleted page recovery returned a different page identity.', { code: 'PAGE_RECOVERY_INVALID_RESULT', status: 500 })
    return DeletedPageRecoveryResultSchema.parse({
      ...restored,
      sourceRevision: sourceRevision(restored.sourceRevision),
      path: body.data.destination.path,
      localeCode: body.data.destination.localeCode
    })
  }
})

const historyColumns = [
  'history.id as id',
  'history.pageId as pageId',
  'history.sourceRevision as sourceRevision',
  'history.path as path',
  'history.localeCode as localeCode',
  'history.title as title',
  'history.description as description',
  'history.visibility as visibility',
  'history.ownerId as ownerId',
  'history.contentType as contentType',
  'history.editorKey as editorKey',
] as const
const currentDeletionQuery = (db: Knex) => db('pageHistory as history')
  .leftJoin('pages as currentPage', 'currentPage.id', 'history.pageId')
  .where('history.action', 'deleted')
  .whereNull('currentPage.id')
  .whereNotExists(function (this: Knex.QueryBuilder) {
    this.select(db.raw('1'))
      .from('pageHistory as newer')
      .whereRaw('?? = ??', ['newer.pageId', 'history.pageId'])
      .whereRaw('?? > ??', ['newer.id', 'history.id'])
  })
const createKnexRepository = (db: Knex): DeletedPageRecoveryRepository => {
  const hydrate = async (historyRows: HistoryRow[]): Promise<DeletedSnapshot[]> => {
    if (!historyRows.length) return []
    const versionIds = historyRows.map(row => row.id)
    const tagRows = await db<{ versionId: number; tag: string }>('pageHistoryTags as historyTags')
      .innerJoin('tags', 'tags.id', 'historyTags.tagId')
      .whereIn('historyTags.pageId', versionIds)
      .orderBy('historyTags.pageId', 'asc')
      .orderBy('tags.tag', 'asc')
      .select('historyTags.pageId as versionId', 'tags.tag')
    const tagsByVersion = new Map<number, string[]>()
    for (const row of tagRows) {
      const tags = tagsByVersion.get(row.versionId) ?? []
      tags.push(row.tag)
      tagsByVersion.set(row.versionId, tags)
    }
    const recoveryRows = await db<RecoveryRecordRow>('deletedPageRecovery')
      .whereIn('deletionVersionId', versionIds)
      .select('pageId', 'deletionVersionId', 'deletionRevision', 'securityContext', 'createdAt')
    const recoveryByVersion = new Map<number, RecoveryRecordRow>()
    for (const row of recoveryRows) recoveryByVersion.set(row.deletionVersionId, row)
    return historyRows.map(history => {
      const recoveryRecord = recoveryByVersion.get(history.id)
      return {
        history,
        tags: tagsByVersion.get(history.id) ?? [],
        ...(recoveryRecord ? { recoveryRecord } : {})
      }
    })
  }
  return {
    async listCurrentDeletedSnapshots({ beforeVersionId, limit }) {
      let query = currentDeletionQuery(db)
      if (beforeVersionId !== undefined) query = query.where('history.id', '<', beforeVersionId)
      const rows = await query.select(...historyColumns).orderBy('history.id', 'desc').limit(limit) as unknown as HistoryRow[]
      return hydrate(rows)
    },
    async findCurrentDeletedSnapshot({ pageId, versionId, includeSource }) {
      const columns = includeSource ? [...historyColumns, 'history.content as content'] : historyColumns
      const row = await currentDeletionQuery(db)
        .select(...columns)
        .where('history.pageId', pageId)
        .where('history.id', versionId)
        .first() as HistoryRow | undefined
      if (!row) return undefined
      return (await hydrate([row]))[0]
    },
    async ownerExists(id) {
      const row = await db<{ id: number }>('users').where({ id }).first('id')
      return row !== undefined
    }
  }
}

interface WikiRecoveryContext {
  auth: { checkAccess(requester: PagePrincipal, permissions: readonly string[]): boolean }
  models: { knex: Knex }
}
const getRecoveryWiki = (): WikiRecoveryContext => {
  const runtime: unknown = WIKI
  if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime)) {
    throw new Error('Deleted-page recovery runtime is unavailable')
  }
  const models = Reflect.get(runtime, 'models')
  const auth = Reflect.get(runtime, 'auth')
  if (
    typeof models !== 'object' || models === null || Array.isArray(models) ||
    typeof auth !== 'object' || auth === null || Array.isArray(auth) ||
    typeof Reflect.get(models, 'knex') !== 'function' ||
    typeof Reflect.get(auth, 'checkAccess') !== 'function'
  ) {
    throw new Error('Deleted-page recovery runtime is unavailable')
  }
  return runtime as unknown as WikiRecoveryContext
}
const pageRestore = pageOperations as unknown as { restoreDeletedPage(input: RestoreInput): Promise<RestoreWriterResult> }
const liveStore = () => {
  const wiki = getRecoveryWiki()
  return createDeletedPageRecoveryStore({
    repository: createKnexRepository(wiki.models.knex),
    hasSystemAccess: requester => wiki.auth.checkAccess(requester, ['manage:system']),
    restore: input => pageRestore.restoreDeletedPage(input)
  })
}
export const listDeletedPages = (requester: PagePrincipal, input: unknown = {}) => liveStore().list(requester, input)
export const inspectDeletedPage = (requester: PagePrincipal, input: { pageId: unknown; versionId: unknown }) => liveStore().inspect(requester, input)
export const restoreDeletedPageRecovery = (requester: PagePrincipal, input: { pageId: unknown; versionId: unknown; body: unknown }) => liveStore().restore(requester, input)
export default {
  list: listDeletedPages,
  inspect: inspectDeletedPage,
  restore: restoreDeletedPageRecovery
}
