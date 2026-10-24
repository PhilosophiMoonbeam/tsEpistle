import { createHash, randomBytes, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import type { Knex } from 'knex'
import * as Y from 'yjs'
import { decodeCollaborationUpdate, encodeCollaborationUpdate } from '../../shared/collaboration.ts'
import {
  LIVE_NOTE_MAX_STATE_BYTES,
  LIVE_NOTE_MAX_TEXT_BYTES,
  LIVE_NOTE_MAX_UPDATE_BYTES,
  LIVE_NOTE_TEXT_KEY,
  LIVE_NOTE_WEBSOCKET_PATH,
  isLiveNoteAccess,
  isLiveNoteKey,
  isLiveNoteRequestId,
  isLiveNoteRevision,
  liveNoteExactKeys,
  type LiveNoteAccess,
  type LiveNoteView,
  type LiveNoteSummary,
  type LiveNoteSession,
  type LiveNoteList,
  type LiveNoteHistoryList
} from '../../shared/live-notes.ts'
import { accountSessionIsCurrent, sessionVersion } from '../helpers/account-session.ts'
import errors from './errors.ts'

const { ApplicationError } = errors
export type LiveNoteRequester = Express.User | undefined
interface Account {
  id: number
  isActive: boolean
  authVersion: number
  providerKey?: string
}
interface Group {
  id: number
  permissions: unknown
}
interface Note {
  id: string
  key: string
  ownerId: number | null
  access: LiveNoteAccess
  state: string
  title: string
  revision: number | string
  everEdited: boolean
  createdAt: Date | string
  updatedAt: Date | string
  touchedAt: Date | string
  deletedAt: Date | string | null
}
interface Revision {
  noteId: string
  revision: number | string
  state: string
  title: string
  access: LiveNoteAccess
  actorId: number | null
  createdAt: Date | string
}
export interface LiveNotePrincipal extends Express.User {
  id: number
  authVersion: number
  isActive: boolean
  permissions: string[]
}
interface Authority {
  principal: LiveNotePrincipal
  read: boolean
  write: boolean
  system: boolean
}
interface Dependencies {
  db: Knex
  secret: string
  audience: string
  now?: () => Date
  onCommitted?: (key: string) => void
}
interface PageQuery {
  limit?: unknown
  cursor?: unknown
}
export interface LiveNoteSessionAuthorization {
  key: string
  principal: LiveNotePrincipal
  expiresAt: string
}
export interface LiveNotesOperations {
  list(requester: LiveNoteRequester, query?: PageQuery): Promise<LiveNoteList>
  create(requester: LiveNoteRequester, input: unknown): Promise<LiveNoteView>
  read(requester: LiveNoteRequester, key: string): Promise<LiveNoteView>
  updateAccess(requester: LiveNoteRequester, key: string, input: unknown): Promise<LiveNoteView>
  remove(requester: LiveNoteRequester, key: string, input: unknown): Promise<{ deleted: true }>
  history(requester: LiveNoteRequester, key: string, query?: PageQuery): Promise<LiveNoteHistoryList>
  revision(requester: LiveNoteRequester, key: string, revision: number): Promise<LiveNoteView>
  restore(requester: LiveNoteRequester, key: string, revision: number, input: unknown): Promise<LiveNoteView>
  session(requester: LiveNoteRequester, key: string): Promise<LiveNoteSession>
  applyUpdate(requester: LiveNoteRequester, key: string, input: unknown): Promise<LiveNoteView>
  authorizeSession(token: string): Promise<LiveNoteSessionAuthorization>
  lease(key: string, connectionId: string, expiresAt: Date): Promise<void>
  release(connectionId: string): Promise<void>
  sweepUntouched(): Promise<number>
}
function fail(message: string, status = 400, code = 'INVALID_INPUT'): never {
  throw new ApplicationError(message, { status, code })
}
function missing(): never {
  return fail('This live note does not exist.', 404, 'NOTE_NOT_FOUND')
}
function invalid(): never {
  return fail('Live note input is invalid.')
}
const iso = (value: Date | string): string => new Date(value).toISOString()
const revisionNumber = (value: number | string): number => {
  const result = typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value) ? Number(value) : value
  if (!isLiveNoteRevision(result)) throw new Error('Stored live note revision is invalid')
  return result
}
const permissions = (value: unknown): string[] => {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return []
    }
  }
  return Array.isArray(parsed) && parsed.every(p => typeof p === 'string') ? parsed : []
}
// Inspect update-v1 structs before integration, including causally pending items.
// Plain CodeMirror text needs only strings, deleted content, and GC/skip ranges.
// Parent IDs denote nested shared types; null parents inherit a neighbour's root.
const plainTextUpdate = (update: Uint8Array): Uint8Array => {
  try {
    for (const struct of Y.decodeUpdate(update).structs) {
      if (struct instanceof Y.GC || struct instanceof Y.Skip) continue
      if (!(struct instanceof Y.Item)) invalid()
      const parent: unknown = struct.parent
      if (
        !(struct.content instanceof Y.ContentString || struct.content instanceof Y.ContentDeleted) ||
        struct.parentSub !== null ||
        (parent !== LIVE_NOTE_TEXT_KEY && !(parent === null && (struct.origin !== null || struct.rightOrigin !== null)))
      )
        invalid()
    }
    return update
  } catch {
    return invalid()
  }
}
const plainTextState = (state: string): Uint8Array => {
  try {
    return plainTextUpdate(decodeCollaborationUpdate(state, LIVE_NOTE_MAX_STATE_BYTES))
  } catch {
    return invalid()
  }
}
const document = (state: string): Y.Doc => {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, plainTextState(state))
    return doc
  } catch (error) {
    doc.destroy()
    throw error
  }
}
const titleWhitespace = /\s/u
const whitespace = (character: string): boolean => titleWhitespace.test(character)
const control = (code: number): boolean => code < 32 || code === 127
const titleLabel = (text: string, start: number, end: number): string => {
  while (start < end && (whitespace(text[start]!) || control(text.charCodeAt(start)))) start++
  while (end > start && (whitespace(text[end - 1]!) || control(text.charCodeAt(end - 1)))) end--
  let label = ''
  for (let index = start; index < end && label.length < 200; index++) {
    if (!control(text.charCodeAt(index))) label += text[index]
  }
  return label
}
// Prefer the first ATX H1, otherwise the first nonblank line. Scan line ranges
// linearly and allocate at most 200 label characters, even for long headings.
// Closing hashes are Markdown delimiters only when separated by whitespace.
const noteTitle = (text: string): string => {
  let fallback = ''
  for (let start = 0; start < text.length; ) {
    let end = start
    while (end < text.length) {
      const code = text.charCodeAt(end)
      if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) break
      end++
    }
    if (!fallback) fallback = titleLabel(text, start, end)
    let marker = start
    while (marker < end && marker - start < 3 && text[marker] === ' ') marker++
    if (text[marker] === '#' && marker + 1 < end && (text[marker + 1] === ' ' || text[marker + 1] === '\t')) {
      let first = marker + 2,
        last = end
      while (first < last && whitespace(text[first]!)) first++
      while (last > first && whitespace(text[last - 1]!)) last--
      let hashes = last
      while (hashes > first && text[hashes - 1] === '#') hashes--
      if (hashes < last && (hashes === first || whitespace(text[hashes - 1]!))) last = hashes
      const heading = titleLabel(text, first, last)
      if (heading) return heading
    }
    start = end + 1
  }
  return fallback
}
const textAndTitle = (doc: Y.Doc): { text: string; title: string } => {
  const content = doc.getText(LIVE_NOTE_TEXT_KEY)
  if ([...doc.share.keys()].some(key => key !== LIVE_NOTE_TEXT_KEY)) invalid()
  const text = content.toString()
  if (Buffer.byteLength(text, 'utf8') > LIVE_NOTE_MAX_TEXT_BYTES) fail('Live note content is too large.', 413, 'NOTE_TOO_LARGE')
  const title = noteTitle(text)
  return { text, title }
}
const stateContent = (state: string): string => {
  const doc = document(state)
  try {
    return textAndTitle(doc).text
  } finally {
    doc.destroy()
  }
}
const encodeState = (value: Uint8Array): string => encodeCollaborationUpdate(value, LIVE_NOTE_MAX_STATE_BYTES)
const queryPage = (query: PageQuery): { limit: number; cursor: string | null } => {
  if (!liveNoteExactKeys(query, [], ['limit', 'cursor'])) invalid()
  const limit = query.limit === undefined ? 30 : typeof query.limit === 'string' && /^[1-9][0-9]{0,2}$/u.test(query.limit) ? Number(query.limit) : query.limit
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid()
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length < 1 || query.cursor.length > 256)) invalid()
  return { limit, cursor: typeof query.cursor === 'string' ? query.cursor : null }
}
const expected = (row: Note, input: unknown, extra: readonly string[] = []): Record<string, unknown> => {
  if (!liveNoteExactKeys(input, ['expectedRevision', ...extra]) || !isLiveNoteRevision(input.expectedRevision)) invalid()
  if (revisionNumber(row.revision) !== input.expectedRevision) fail('The live note changed. Reload it before trying again.', 409, 'NOTE_CONFLICT')
  return input
}

// Group policy → account → note is also the administration lock order. Share
// locks fence revocation/membership changes throughout the note transaction.
const authority = async (tx: Knex.Transaction, requester: LiveNoteRequester): Promise<Authority> => {
  if (
    !requester ||
    typeof requester.id !== 'number' ||
    !Number.isSafeInteger(requester.id) ||
    requester.id < 1 ||
    'api' in requester ||
    'grp' in requester ||
    ('ownershipUserId' in requester && requester.ownershipUserId !== requester.id && !(requester.id === 2 && requester.ownershipUserId === null))
  )
    fail('A current browser account is required.', 401, 'AUTH_REQUIRED')
  const groups = await tx<Group>('groups').select('id', 'permissions').orderBy('id').forShare()
  const account = await tx<Account>('users').where('id', requester.id).forShare().first()
  const current =
    requester.id === 2
      ? account?.id === 2 &&
        account.isActive === true &&
        sessionVersion(requester.authVersion) !== null &&
        sessionVersion(requester.authVersion) === sessionVersion(account.authVersion)
      : accountSessionIsCurrent({ id: requester.id, authVersion: requester.authVersion }, account)
  if (!current || !account) fail('Your account session changed. Sign in again.', 401, 'AUTH_REQUIRED')
  const memberships = await tx<{ groupId: number }>('userGroups').where('userId', account.id).select('groupId')
  const ids = new Set(memberships.map(item => item.groupId))
  const grants = account.id === 1 ? ['manage:system'] : [...new Set(groups.filter(group => ids.has(group.id)).flatMap(group => permissions(group.permissions)))]
  const system = account.id !== 2 && grants.includes('manage:system')
  const write = account.id !== 2 && (system || grants.includes('write:notes'))
  const read = system || grants.includes('read:notes') || write
  const authVersion = sessionVersion(account.authVersion)
  if (authVersion === null) fail('Your account session changed. Sign in again.', 401, 'AUTH_REQUIRED')
  const principal: LiveNotePrincipal = { ...account, authVersion, permissions: grants }
  return { principal, read, write, system }
}
export const authorizePageCreationAccount = async (tx: Knex.Transaction, requester: LiveNoteRequester): Promise<LiveNotePrincipal> => {
  const access = await authority(tx, requester)
  if (access.principal.id === 2) fail('A current browser account is required.', 401, 'AUTH_REQUIRED')
  return access.principal
}

/** Read-only within the caller's transaction: current policy fences retained snapshots. */
export const readLiveNotePublication = async (
  tx: Knex.Transaction,
  requester: LiveNoteRequester,
  noteId: string,
  revision?: number
): Promise<{ text: string; revision: number } | null> => {
  const access = await authority(tx, requester)
  if (access.principal.id === 2) fail('A current browser account is required.', 401, 'AUTH_REQUIRED')
  const row = await tx<Note>('liveNotes').where({ id: noteId }).whereNull('deletedAt').forShare().first()
  if (!row || !access.read || (!access.system && row.ownerId !== access.principal.id && row.access === 'private')) return missing()
  if (revision === undefined) return null
  if (!isLiveNoteRevision(revision)) invalid()
  const captured = await tx<Revision>('liveNoteRevisions').where({ noteId: row.id, revision }).first()
  if (!captured) fail('The captured live note revision is unavailable.', 409, 'NOTE_REVISION_UNAVAILABLE')
  return { text: stateContent(captured.state), revision: revisionNumber(captured.revision) }
}

export const createLiveNotesStore = ({ db, secret, audience, now = () => new Date(), onCommitted }: Dependencies): LiveNotesOperations => {
  const capabilities = (access: Authority, row: Note) => ({
    canEdit: access.write && (access.system || row.ownerId === access.principal.id || row.access === 'edit'),
    canManage: access.write && (access.system || row.ownerId === access.principal.id)
  })
  const note = async (tx: Knex.Transaction, access: Authority, key: string, mode: 'read' | 'write' | 'manage' = 'read'): Promise<Note> => {
    if (!isLiveNoteKey(key)) return missing()
    const row = await tx<Note>('liveNotes').where({ key }).whereNull('deletedAt').forUpdate().first()
    if (!row || !access.read || (!access.system && row.ownerId !== access.principal.id && row.access === 'private')) return missing()
    const allowed = capabilities(access, row)
    if ((mode === 'write' && !allowed.canEdit) || (mode === 'manage' && !allowed.canManage)) return missing()
    return row
  }
  const summary = (access: Authority, row: Note): LiveNoteSummary => ({
    id: row.id,
    key: row.key,
    ownerId: row.ownerId,
    title: row.title,
    access: row.access,
    revision: revisionNumber(row.revision),
    updatedAt: iso(row.updatedAt),
    ...capabilities(access, row)
  })
  const view = (access: Authority, row: Note): LiveNoteView => {
    plainTextState(row.state)
    return { ...summary(access, row), state: row.state }
  }
  const touch = async (tx: Knex.Transaction, row: Note): Promise<void> => {
    await tx('liveNotes').where('id', row.id).update({ touchedAt: now() })
  }
  const snapshot = async (tx: Knex.Transaction, row: Note, actorId: number): Promise<void> => {
    await tx('liveNoteRevisions').insert({
      noteId: row.id,
      revision: row.revision,
      state: row.state,
      title: row.title,
      access: row.access,
      actorId,
      createdAt: row.updatedAt
    })
  }
  const save = async (tx: Knex.Transaction, access: Authority, row: Note, changes: Partial<Note>): Promise<Note> => {
    const nextRevision = revisionNumber(row.revision) + 1
    if (!Number.isSafeInteger(nextRevision)) fail('The live note revision limit was reached.', 409, 'NOTE_CONFLICT')
    const next: Note = { ...row, ...changes, revision: nextRevision, updatedAt: now(), touchedAt: now() }
    const count = await tx('liveNotes')
      .where({ id: row.id, revision: row.revision })
      .update({ ...changes, revision: next.revision, updatedAt: next.updatedAt, touchedAt: next.touchedAt })
    if (count !== 1) throw new Error('Live note changed while locked')
    await snapshot(tx, next, access.principal.id)
    return next
  }
  const changed = (key: string): void => {
    onCommitted?.(key)
  }
  const read = (requester: LiveNoteRequester, key: string): Promise<LiveNoteView> =>
    db.transaction(async tx => {
      const access = await authority(tx, requester),
        row = await note(tx, access, key)
      await touch(tx, row)
      return view(access, row)
    })
  return {
    async list(requester: LiveNoteRequester, query: PageQuery = {}): Promise<LiveNoteList> {
      const { limit, cursor } = queryPage(query)
      if (cursor && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(cursor)) invalid()
      return db.transaction(async tx => {
        const access = await authority(tx, requester)
        if (!access.read || access.principal.id === 2) fail('Live note access is required.', 403, 'NOTE_FORBIDDEN')
        const rows: Note[] = await tx<Note>('liveNotes')
          .where({ ownerId: access.principal.id })
          .whereNull('deletedAt')
          .modify(builder => {
            if (cursor) builder.where('id', '>', cursor)
          })
          .orderBy('id')
          .limit(limit + 1)
        const items = rows.slice(0, limit).map(row => summary(access, row)),
          hasMore = rows.length > limit
        return { items, hasMore, nextCursor: hasMore ? items.at(-1)!.id : null }
      })
    },
    async create(requester: LiveNoteRequester, input: unknown): Promise<LiveNoteView> {
      if (!liveNoteExactKeys(input, [], ['key']) || (input.key !== undefined && !isLiveNoteKey(input.key))) invalid()
      const key = typeof input.key === 'string' ? input.key : randomBytes(16).toString('hex')
      try {
        const result = await db.transaction(async tx => {
          const access = await authority(tx, requester)
          if (!access.write) fail('Live note write access is required.', 403, 'NOTE_FORBIDDEN')
          const doc = new Y.Doc(),
            state = encodeState(Y.encodeStateAsUpdate(doc))
          doc.destroy()
          const row: Note = {
            id: randomUUID(),
            key,
            ownerId: access.principal.id,
            access: 'private',
            state,
            title: '',
            revision: 0,
            everEdited: false,
            createdAt: now(),
            updatedAt: now(),
            touchedAt: now(),
            deletedAt: null
          }
          await tx('liveNotes').insert(row)
          await snapshot(tx, row, access.principal.id)
          return view(access, row)
        })
        changed(key)
        return result
      } catch (error) {
        if (typeof error === 'object' && error !== null && ['23505', 'SQLITE_CONSTRAINT_UNIQUE'].includes(String(Reflect.get(error, 'code'))))
          fail('This live note key is unavailable.', 409, 'NOTE_KEY_CONFLICT')
        throw error
      }
    },
    read,
    async updateAccess(requester: LiveNoteRequester, key: string, input: unknown): Promise<LiveNoteView> {
      const result = await db.transaction(async tx => {
        const access = await authority(tx, requester),
          row = await note(tx, access, key, 'manage'),
          values = expected(row, input, ['access'])
        if (!isLiveNoteAccess(values.access)) invalid()
        return view(access, await save(tx, access, row, { access: values.access }))
      })
      changed(key)
      return result
    },
    async remove(requester: LiveNoteRequester, key: string, input: unknown): Promise<{ deleted: true }> {
      await db.transaction(async tx => {
        const access = await authority(tx, requester),
          row = await note(tx, access, key, 'manage')
        expected(row, input)
        await tx('liveNotes').where('id', row.id).update({ deletedAt: now(), touchedAt: now() })
        await tx('liveNoteConnections').where('noteId', row.id).delete()
      })
      changed(key)
      return { deleted: true }
    },
    async history(requester: LiveNoteRequester, key: string, query: PageQuery = {}): Promise<LiveNoteHistoryList> {
      const { limit, cursor } = queryPage(query)
      if (cursor && (!/^(0|[1-9][0-9]*)$/u.test(cursor) || !isLiveNoteRevision(Number(cursor)))) invalid()
      return db.transaction(async tx => {
        const access = await authority(tx, requester),
          row = await note(tx, access, key)
        const rows: Revision[] = await tx<Revision>('liveNoteRevisions')
          .where('noteId', row.id)
          .modify(builder => {
            if (cursor !== null) builder.where('revision', '<', cursor)
          })
          .orderBy('revision', 'desc')
          .limit(limit + 1)
        await touch(tx, row)
        const items = rows
            .slice(0, limit)
            .map(item => ({ revision: revisionNumber(item.revision), createdAt: iso(item.createdAt), actorId: item.actorId, title: item.title })),
          hasMore = rows.length > limit
        return { items, hasMore, nextCursor: hasMore ? String(items.at(-1)!.revision) : null }
      })
    },
    async revision(requester: LiveNoteRequester, key: string, target: number): Promise<LiveNoteView> {
      if (!isLiveNoteRevision(target)) invalid()
      return db.transaction(async tx => {
        const access = await authority(tx, requester),
          row = await note(tx, access, key)
        const historical = await tx<Revision>('liveNoteRevisions').where({ noteId: row.id, revision: target }).first()
        if (!historical) return missing()
        plainTextState(historical.state)
        await touch(tx, row)
        // Current policy and capabilities authorize every historical source.
        return {
          ...view(access, row),
          state: historical.state,
          title: historical.title,
          revision: revisionNumber(historical.revision),
          updatedAt: iso(historical.createdAt)
        }
      })
    },
    async restore(requester: LiveNoteRequester, key: string, target: number, input: unknown): Promise<LiveNoteView> {
      if (!isLiveNoteRevision(target)) invalid()
      const result = await db.transaction(async tx => {
        const access = await authority(tx, requester),
          row = await note(tx, access, key, 'write')
        expected(row, input)
        const historical = await tx<Revision>('liveNoteRevisions').where({ noteId: row.id, revision: target }).first()
        if (!historical) return missing()
        const content = stateContent(historical.state),
          doc = document(row.state)
        try {
          const before = Y.encodeStateVector(doc),
            text = doc.getText(LIVE_NOTE_TEXT_KEY)
          doc.transact(() => {
            text.delete(0, text.length)
            if (content) text.insert(0, content)
          }, 'restore')
          const state = encodeState(Y.mergeUpdates([decodeCollaborationUpdate(row.state, LIVE_NOTE_MAX_STATE_BYTES), Y.encodeStateAsUpdate(doc, before)]))
          return view(access, await save(tx, access, row, { state, title: textAndTitle(doc).title, everEdited: true }))
        } finally {
          doc.destroy()
        }
      })
      changed(key)
      return result
    },
    async applyUpdate(requester: LiveNoteRequester, key: string, input: unknown): Promise<LiveNoteView> {
      if (
        !liveNoteExactKeys(input, ['update', 'requestId']) ||
        !isLiveNoteRequestId(input.requestId) ||
        typeof input.update !== 'string' ||
        input.update.length > Math.ceil(LIVE_NOTE_MAX_UPDATE_BYTES / 3) * 4
      )
        invalid()
      let update: Uint8Array
      try {
        update = plainTextUpdate(decodeCollaborationUpdate(input.update, LIVE_NOTE_MAX_UPDATE_BYTES))
      } catch {
        return invalid()
      }
      const updateHash = createHash('sha256').update(update).digest('hex')
      const requestId = input.requestId
      const result = await db.transaction(async tx => {
        const access = await authority(tx, requester),
          row = await note(tx, access, key, 'write')
        const duplicate = await tx<{ noteId: string; actorId: number; requestId: string; updateHash: string }>('liveNoteRequests')
          .where({ noteId: row.id, actorId: access.principal.id, requestId })
          .first()
        if (duplicate) {
          if (duplicate.updateHash !== updateHash) fail('This update request ID was already used.', 409, 'NOTE_CONFLICT')
          await touch(tx, row)
          return view(access, row)
        }
        let state: string, title: string
        try {
          state = encodeState(Y.mergeUpdates([plainTextState(row.state), update]))
          const doc = document(state)
          try {
            title = textAndTitle(doc).title
          } finally {
            doc.destroy()
          }
        } catch (error) {
          if (error instanceof ApplicationError) throw error
          return invalid()
        }
        const next = state === row.state ? row : await save(tx, access, row, { state, title, everEdited: true })
        if (next === row) await touch(tx, row)
        await tx('liveNoteRequests').insert({ noteId: row.id, actorId: access.principal.id, requestId, updateHash })
        return view(access, next)
      })
      changed(key)
      return result
    },
    async session(requester: LiveNoteRequester, key: string): Promise<LiveNoteSession> {
      return db.transaction(async tx => {
        const access = await authority(tx, requester),
          row = await note(tx, access, key)
        const issuedAt = Math.floor(now().getTime() / 1000),
          expiresAt = issuedAt + 300
        const token = jwt.sign(
          {
            kind: 'live-note',
            noteId: row.id,
            key: row.key,
            userId: access.principal.id,
            authVersion: access.principal.authVersion,
            iat: issuedAt,
            exp: expiresAt
          },
          secret,
          { algorithm: 'HS256', audience, issuer: 'urn:wiki.js' }
        )
        await touch(tx, row)
        return { token, key, websocketPath: LIVE_NOTE_WEBSOCKET_PATH, expiresAt: new Date(expiresAt * 1000).toISOString() }
      })
    },
    async authorizeSession(token: string): Promise<LiveNoteSessionAuthorization> {
      let claims: Record<string, unknown>
      try {
        if (typeof token !== 'string' || token.length > 8192) throw new Error('Invalid token')
        const value = jwt.verify(token, secret, { algorithms: ['HS256'], audience, issuer: 'urn:wiki.js', clockTimestamp: Math.floor(now().getTime() / 1000) })
        if (
          !liveNoteExactKeys(value, ['kind', 'noteId', 'key', 'userId', 'authVersion', 'iat', 'exp', 'aud', 'iss']) ||
          value.kind !== 'live-note' ||
          typeof value.noteId !== 'string' ||
          !isLiveNoteKey(value.key) ||
          typeof value.userId !== 'number' ||
          !Number.isSafeInteger(value.userId) ||
          value.userId < 1 ||
          sessionVersion(value.authVersion) === null ||
          !Number.isSafeInteger(value.iat) ||
          !Number.isSafeInteger(value.exp) ||
          Number(value.exp) - Number(value.iat) !== 300 ||
          Number(value.iat) > Math.floor(now().getTime() / 1000)
        )
          throw new Error('Invalid claims')
        claims = value
      } catch {
        return fail('Live note session is invalid or expired.', 401, 'NOTE_SESSION_INVALID')
      }
      return db.transaction(async tx => {
        const access = await authority(tx, { id: claims.userId, authVersion: claims.authVersion } as Express.User),
          row = await note(tx, access, String(claims.key))
        if (row.id !== claims.noteId) return missing()
        return { key: row.key, principal: access.principal, expiresAt: new Date(Number(claims.exp) * 1000).toISOString() }
      })
    },
    async lease(key: string, connectionId: string, expiresAt: Date): Promise<void> {
      const instant = now()
      if (
        !isLiveNoteRequestId(connectionId) ||
        !(expiresAt instanceof Date) ||
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt <= instant ||
        expiresAt.getTime() - instant.getTime() > 300_000
      )
        invalid()
      await db.transaction(async tx => {
        const row = await tx<Note>('liveNotes').where({ key }).whereNull('deletedAt').forUpdate().first()
        if (!row) return missing()
        const existing = await tx<{ noteId: string }>('liveNoteConnections').where('id', connectionId).first()
        if (existing && existing.noteId !== row.id) invalid()
        await tx('liveNoteConnections').insert({ id: connectionId, noteId: row.id, expiresAt }).onConflict('id').merge(['expiresAt'])
        await touch(tx, row)
      })
    },
    async release(connectionId: string): Promise<void> {
      await db('liveNoteConnections').where('id', connectionId).delete()
    },
    async sweepUntouched(): Promise<number> {
      const instant = now(),
        cutoff = new Date(instant.getTime() - 24 * 60 * 60 * 1000)
      const keys = await db.transaction(async tx => {
        // Bounded candidate scan and note row locks serialize with lease/write.
        const scan = tx<Note>('liveNotes')
          .where({ everEdited: false })
          .whereNull('deletedAt')
          .where('touchedAt', '<', cutoff)
          .orderBy('touchedAt')
          .orderBy('id')
          .limit(100)
          .forUpdate()
        const candidates = await (db.client.config.client === 'pg' ? scan.skipLocked() : scan)
        const removed: string[] = []
        for (const row of candidates) {
          const active = await tx('liveNoteConnections').where('noteId', row.id).where('expiresAt', '>', instant).first('id')
          if (active || stateContent(row.state) !== '') continue
          const edited = await tx('liveNoteRevisions').where('noteId', row.id).where('revision', '>', 0).first('revision')
          if (edited) continue
          await tx('liveNotes').where('id', row.id).delete()
          removed.push(row.key)
        }
        // Lease expiry is independently bounded; never scan/delete unrelated data.
        const expired = await tx<{ id: string }>('liveNoteConnections').where('expiresAt', '<=', instant).orderBy('expiresAt').limit(100).select('id')
        if (expired.length)
          await tx('liveNoteConnections')
            .whereIn(
              'id',
              expired.map(item => item.id)
            )
            .delete()
        return removed
      })
      keys.forEach(changed)
      return keys.length
    }
  }
}

type Runtime = {
  models: { knex: Knex }
  config: { sessionSecret: string; auth: { audience: string } }
  events?: { outbound?: { emit(event: string, payload: unknown): void } }
  logger?: { warn(error: unknown): void }
}
const store = () => {
  const wiki = Reflect.get(globalThis, 'WIKI') as Runtime
  return createLiveNotesStore({
    db: wiki.models.knex,
    secret: wiki.config.sessionSecret,
    audience: wiki.config.auth.audience,
    onCommitted: key => {
      try {
        wiki.events?.outbound?.emit('liveNoteUpdated', { key })
      } catch (error) {
        wiki.logger?.warn(error)
      }
    }
  })
}
export const liveNotes: LiveNotesOperations = {
  list: (requester, query) => store().list(requester, query),
  create: (requester, input) => store().create(requester, input),
  read: (requester, key) => store().read(requester, key),
  updateAccess: (requester, key, input) => store().updateAccess(requester, key, input),
  remove: (requester, key, input) => store().remove(requester, key, input),
  history: (requester, key, query) => store().history(requester, key, query),
  revision: (requester, key, revision) => store().revision(requester, key, revision),
  restore: (requester, key, revision, input) => store().restore(requester, key, revision, input),
  session: (requester, key) => store().session(requester, key),
  applyUpdate: (requester, key, input) => store().applyUpdate(requester, key, input),
  authorizeSession: token => store().authorizeSession(token),
  lease: (key, connectionId, expiresAt) => store().lease(key, connectionId, expiresAt),
  release: connectionId => store().release(connectionId),
  sweepUntouched: () => store().sweepUntouched()
}
