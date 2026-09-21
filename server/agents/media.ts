import sharp from 'sharp'
import { getCachedAgentPdf } from './pdf-cache.ts'
import { chmod, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareAgentPdfFromPath, type PreparedAgentPdf } from './pdf-preparation.ts'
import { AGENT_ATTACHMENT_MAX_BYTES, AGENT_PDF_ATTACHMENT_MAX_BYTES, AGENT_GENERATED_VIDEO_MAX_BYTES, AGENT_GENERATED_AUDIO_MAX_BYTES } from '../../shared/agents/media-limits.ts'
import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { AgentMediaView } from '../../shared/agents/contracts.ts'
import { AgentRepositoryError, getOwnedAgentSession } from './repository.ts'
import { AgentProviderAdapterConfigSchema } from './providers/registry.ts'

export const AGENT_MEDIA_MAX_BYTES = AGENT_PDF_ATTACHMENT_MAX_BYTES
export const AGENT_MEDIA_OWNER_MAX_BYTES = 1024 * 1024 * 1024
export const AGENT_MEDIA_GLOBAL_MAX_BYTES = 10 * 1024 * 1024 * 1024
export const AGENT_MEDIA_PROMPT_MAX_BYTES = 1024 * 1024 * 1024
export const AGENT_MEDIA_PROMPT_MAX_FILES = 16
export const AGENT_MEDIA_MAX_ATTACHMENTS = 4
export interface AgentMediaPayload {
  readonly id: string
  readonly mimeType: string
  readonly filename: string
  readonly byteLength: number
  readonly payload: Buffer
}
export interface AgentMediaSource extends Omit<AgentMediaPayload, 'payload'> {
  readonly payload?: Buffer
  readonly loadPayload?: (signal: AbortSignal) => Promise<Buffer>
  readonly preparePdf?: (signal: AbortSignal) => Promise<PreparedAgentPdf>
  readonly promptTokens?: number | null | undefined
  /** Persists a provider-measured prompt token count so compaction planning can use real media exposure. Best-effort. */
  readonly recordPromptTokens?: (tokens: number) => Promise<void>
}
export const loadAgentMediaPayload = async (source: AgentMediaSource, signal: AbortSignal): Promise<Buffer> => {
  signal.throwIfAborted()
  if (source.byteLength > AGENT_ATTACHMENT_MAX_BYTES) throw new AgentRepositoryError('INVALID_AGENT_MEDIA', 'This media operation accepts files up to 10 MB.', 413)
  const payload = source.payload ?? await source.loadPayload?.(signal)
  if (!payload || payload.length !== Number(source.byteLength ?? payload.length)) throw new AgentRepositoryError('AGENT_MEDIA_CORRUPT', 'Saved attachment failed integrity validation.', 500)
  return payload
}
export interface AgentMediaRow extends AgentMediaPayload {
  readonly sha256: string
  readonly ownerId: number
  readonly sessionId: string
  readonly messageId: string | null
  readonly runId: string | null
  readonly kind: 'attachment' | 'generated-image' | 'generated-video' | 'generated-audio'
  readonly expiresAt: Date | string | null
  readonly promptTokens: number | null
  readonly detachedAt: Date | string | null
}
export const projectAgentMedia = (row: Pick<AgentMediaRow, 'id' | 'kind' | 'filename' | 'mimeType' | 'byteLength' | 'expiresAt' | 'detachedAt'>): AgentMediaView => ({
  id: row.id,
  kind: row.kind,
  filename: row.filename,
  mimeType: row.mimeType,
  byteLength: Number(row.byteLength),
  available: row.expiresAt === null || new Date(row.expiresAt).valueOf() > Date.now(),
  detached: row.detachedAt !== null
})
const invalid = (): never => {
  throw new AgentRepositoryError('INVALID_AGENT_MEDIA', 'Choose a PDF up to 250 MB, or a supported image or audio recording up to 10 MB.', 400)
}
export const validateAgentMedia = (payload: Buffer, declaredType: string): string => {
  if (payload.length === 0 || payload.length > AGENT_MEDIA_MAX_BYTES) return invalid()
  const type = declaredType.split(';')[0]!.toLowerCase().trim()
  if (type !== 'application/pdf' && payload.length > AGENT_ATTACHMENT_MAX_BYTES) return invalid()
  const ascii = (start: number, end: number) => payload.subarray(start, end).toString('ascii')
  const matches =
    type === 'image/png'
      ? payload.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : type === 'image/jpeg'
        ? payload[0] === 255 && payload[1] === 216 && payload[2] === 255
        : type === 'image/webp'
          ? ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
          : type === 'application/pdf'
            ? ascii(0, 5) === '%PDF-'
            : type === 'audio/webm'
              ? payload.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))
              : type === 'audio/ogg'
                ? ascii(0, 4) === 'OggS'
                : type === 'audio/wav' || type === 'audio/x-wav'
                  ? ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE'
                  : type === 'audio/mp4' || type === 'audio/m4a'
                    ? ascii(4, 8) === 'ftyp'
                    : type === 'audio/mpeg'
                      ? ascii(0, 3) === 'ID3' || (payload[0] === 255 && (payload[1]! & 224) === 224)
                      : false
  if (!matches) return invalid()
  return type === 'audio/x-wav' ? 'audio/wav' : type === 'audio/m4a' ? 'audio/mp4' : type
}
export const assertAgentMediaIntegrity = (row: AgentMediaRow): void => {
  if (row.payload.length !== Number(row.byteLength) || createHash('sha256').update(row.payload).digest('hex') !== row.sha256)
    throw new AgentRepositoryError('AGENT_MEDIA_CORRUPT', 'Saved attachment failed integrity validation.', 500)
}
export const mediaFilename = (value: string): string =>
  Array.from(value)
    .map(character => (character === '/' || character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? '_' : character))
    .join('')
    .slice(0, 180)
    .trim() || 'attachment'
export const assertAgentMediaCapability = async (
  db: Knex | Knex.Transaction,
  versionId: string,
  kind: 'attachments' | 'imageGeneration' | 'videoGeneration' | 'musicGeneration' | 'transcription'
): Promise<void> => {
  const row = (await db('agentProviderProfileVersions').where({ id: versionId }).first('transportKind', 'baseUrl', 'adapterConfig')) as
    | { transportKind: string; baseUrl: string; adapterConfig: string }
    | undefined
  let config
  let official = false
  try {
    config = row && AgentProviderAdapterConfigSchema.parse(JSON.parse(row.adapterConfig))
    official = Boolean(row && new URL(row.baseUrl).origin === 'https://generativelanguage.googleapis.com')
  } catch {
    /* fail closed */
  }
  if (!row || row.transportKind !== 'gemini-api' || !official || !config?.media?.[kind])
    throw new AgentRepositoryError('AGENT_MEDIA_DISABLED', 'This media feature is not enabled for the selected provider.', 403)
}
export const storeAgentMedia = async (
  db: Knex,
  input: {
    ownerId: number
    sessionId: string
    payload: Buffer
    mimeType: string
    filename: string
    kind?: 'attachment' | 'generated-image' | 'generated-video' | 'generated-audio'
    messageId?: string
    runId?: string
    leaseOwner?: string | null
    leaseToken?: string | null
  }
): Promise<AgentMediaRow> => {
  const generated = input.kind !== undefined && input.kind !== 'attachment'
  if (generated && (!input.messageId || !input.runId || !input.leaseOwner || !input.leaseToken))
    throw new AgentRepositoryError('INVALID_AGENT_MEDIA', 'Generated media requires an active run lease.', 500)
  let mimeType: string
  if (input.kind === 'generated-video' || input.kind === 'generated-audio') {
    const video = input.kind === 'generated-video'
    mimeType = video ? 'video/mp4' : 'audio/mpeg'
    const signature = video
      ? input.payload.length >= 12 && input.payload.toString('ascii', 4, 8) === 'ftyp'
      : input.payload.toString('ascii', 0, 3) === 'ID3' || (input.payload[0] === 255 && (input.payload[1]! & 224) === 224)
    if (input.mimeType !== mimeType || !signature || input.payload.length > (video ? AGENT_GENERATED_VIDEO_MAX_BYTES : AGENT_GENERATED_AUDIO_MAX_BYTES))
      throw new AgentRepositoryError('INVALID_AGENT_MEDIA', 'The provider returned an unsupported or oversized media file.', 502)
  } else {
    mimeType = validateAgentMedia(input.payload, input.mimeType)
    if (input.kind === 'generated-image' && !mimeType.startsWith('image/'))
      throw new AgentRepositoryError('INVALID_AGENT_MEDIA', 'The provider returned an unsupported image file.', 502)
  }
  if (mimeType.startsWith('image/')) {
    try {
      const decoder = sharp(input.payload, { limitInputPixels: 25_000_000, failOn: 'warning', unlimited: false })
      const metadata = await decoder.metadata()
      if (
        !metadata.width ||
        !metadata.height ||
        metadata.width > 8192 ||
        metadata.height > 8192 ||
        (metadata.pages ?? 1) !== 1 ||
        mimeType !== `image/${metadata.format}`
      )
        invalid()
      await decoder.raw().toBuffer()
    } catch {
      invalid()
    }
  }
  return db.transaction(async tx => {
    // A single transaction lock makes the global budget atomic across owners.
    // SQLite's serialized writers provide the equivalent fixture boundary.
    if (tx.client.config.client === 'pg') await tx.raw('select pg_advisory_xact_lock(?, ?)', [0x41474d44, 1])
    // Serialize storage accounting for this owner, including concurrent uploads across sessions.
    await tx('users').where({ id: input.ownerId }).forUpdate().first('id')
    await getOwnedAgentSession(tx, input.ownerId, input.sessionId)
    const now = new Date()
    await tx('agentMedia').where({ ownerId: input.ownerId }).whereNull('messageId').where('expiresAt', '<=', now).delete()
    const usage = (await tx('agentMedia').where({ ownerId: input.ownerId }).sum('byteLength as bytes').count('id as count').first()) as {
      bytes: string | number | null
      count: string | number
    }
    if (Number(usage.bytes ?? 0) + input.payload.length > AGENT_MEDIA_OWNER_MAX_BYTES || Number(usage.count) >= 200)
      throw new AgentRepositoryError(
        'AGENT_MEDIA_QUOTA',
        'Your saved chat attachments have reached the storage limit. Delete unused conversations to free space.',
        413
      )
    const globalUsage = await tx('agentMedia').sum('byteLength as bytes').first() as { bytes: string | number | null }
    if (Number(globalUsage.bytes ?? 0) + input.payload.length > AGENT_MEDIA_GLOBAL_MAX_BYTES)
      throw new AgentRepositoryError('AGENT_MEDIA_QUOTA', 'The wiki attachment storage limit has been reached. Ask an administrator to free storage.', 413)
    const row = {
      id: randomUUID(),
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      messageId: input.messageId ?? null,
      runId: input.runId ?? null,
      kind: input.kind ?? 'attachment',
      mimeType,
      filename: mediaFilename(input.filename),
      byteLength: input.payload.length,
      payload: input.payload,
      sha256: createHash('sha256').update(input.payload).digest('hex'),
      createdAt: now,
      expiresAt: input.messageId ? null : new Date(now.valueOf() + 3600_000),
      promptTokens: null,
      detachedAt: null,
      metadata: '{}'
    }
    if (input.runId && input.messageId) {
      const run = await tx('agentRuns')
        .where({
          id: input.runId,
          ownerId: input.ownerId,
          sessionId: input.sessionId,
          assistantMessageId: input.messageId,
          ...(input.leaseToken ? { leaseOwner: input.leaseOwner, leaseToken: input.leaseToken } : {})
        })
        .forUpdate()
        .whereIn('status', ['running', 'awaiting_approval'])
        .whereNull('cancelRequestedAt')
        .first('id')
      if (!run) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run is no longer active.', 409)
      await tx('agentRuns').where({ id: input.runId }).update({ sideEffectsStarted: true })
    }
    await tx('agentMedia').insert(row)
    return row
  })
}
export const getOwnedAgentMedia = async (db: Knex, ownerId: number, id: string): Promise<AgentMediaRow> => {
  const row = (await db('agentMedia').where({ id, ownerId }).first()) as AgentMediaRow | undefined
  if (!row || (row.expiresAt !== null && new Date(row.expiresAt).valueOf() <= Date.now()))
    throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Attachment was not found.', 404)
  await getOwnedAgentSession(db, ownerId, row.sessionId)
  assertAgentMediaIntegrity(row)
  return row
}
export const bindAgentMedia = async (
  tx: Knex.Transaction,
  input: { ownerId: number; sessionId: string; attachmentIds: readonly string[]; messageId: string; runId: string; transcription?: boolean }
): Promise<void> => {
  if (input.attachmentIds.length > AGENT_MEDIA_MAX_ATTACHMENTS || new Set(input.attachmentIds).size !== input.attachmentIds.length) invalid()
  for (const id of input.attachmentIds) {
    const row = (await tx('agentMedia')
      .where({ id, ownerId: input.ownerId, sessionId: input.sessionId, kind: 'attachment' })
      .whereNull('messageId')
      .where('expiresAt', '>', new Date())
      .forUpdate()
      .first('mimeType')) as { mimeType: string } | undefined
    if (!row) throw new AgentRepositoryError('AGENT_MEDIA_UNAVAILABLE', 'An attachment is no longer available. Attach it again.', 409)
    if (Boolean(input.transcription) !== row.mimeType.startsWith('audio/')) invalid()
    await tx('agentMedia').where({ id }).update({ messageId: input.messageId, runId: input.runId, expiresAt: null })
  }
}

export type AgentMediaMetadata = Omit<AgentMediaRow, 'payload'>
export const AGENT_MEDIA_METADATA_COLUMNS = ['id', 'ownerId', 'sessionId', 'messageId', 'runId', 'kind', 'mimeType', 'filename', 'byteLength', 'sha256', 'expiresAt', 'promptTokens', 'detachedAt'] as const
export const getOwnedAgentMediaMetadata = async (db: Knex, ownerId: number, id: string): Promise<AgentMediaMetadata> => {
  const row = await db('agentMedia').where({ id, ownerId }).first(...AGENT_MEDIA_METADATA_COLUMNS) as AgentMediaMetadata | undefined
  if (!row || (row.expiresAt !== null && new Date(row.expiresAt).valueOf() <= Date.now())) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Attachment was not found.', 404)
  await getOwnedAgentSession(db, ownerId, row.sessionId)
  return row
}

/** Chunked bytea access prevents a large document from becoming an application-sized buffer. */
export const stageOwnedAgentMedia = async (db: Knex, ownerId: number, id: string, signal: AbortSignal): Promise<{ path: string; media: AgentMediaMetadata; cleanup: () => Promise<void> }> => {
  signal.throwIfAborted()
  const media = await getOwnedAgentMediaMetadata(db, ownerId, id)
  if (Number(media.byteLength) < 1 || Number(media.byteLength) > AGENT_MEDIA_MAX_BYTES) throw new AgentRepositoryError('AGENT_MEDIA_CORRUPT', 'Saved attachment failed integrity validation.', 500)
  const directory = await mkdtemp(join(tmpdir(), 'wiki-agent-original-'))
  await chmod(directory, 0o700)
  let cleanupPromise: Promise<void> | undefined
  const cleanup = () => cleanupPromise ??= rm(directory, { recursive: true, force: true })
  const path = join(directory, 'input.pdf')
  try {
    const file = await open(path, 'wx', 0o600)
    try {
      const digest = createHash('sha256')
      for (let offset = 0; offset < Number(media.byteLength); offset += 1024 * 1024) {
        signal.throwIfAborted()
        const length = Math.min(1024 * 1024, Number(media.byteLength) - offset)
        const expression = db.client.config.client === 'pg' ? 'substring(?? from ? for ?) as chunk' : 'substr(??, ?, ?) as chunk'
        const row = await db('agentMedia').where({ id, ownerId, sessionId: media.sessionId, sha256: media.sha256, byteLength: media.byteLength }).first(db.raw(expression, ['payload', offset + 1, length])) as { chunk: Uint8Array } | undefined
        if (!row || !(row.chunk instanceof Uint8Array) || row.chunk.length !== length) throw new AgentRepositoryError('AGENT_MEDIA_CORRUPT', 'Saved attachment failed integrity validation.', 500)
        digest.update(row.chunk)
        await file.writeFile(row.chunk)
      }
      if (digest.digest('hex') !== media.sha256) throw new AgentRepositoryError('AGENT_MEDIA_CORRUPT', 'Saved attachment failed integrity validation.', 500)
    } finally { await file.close() }
    signal.throwIfAborted()
    await getOwnedAgentMediaMetadata(db, ownerId, id)
    return { path, media, cleanup }
  } catch (error) { await cleanup(); throw error }
}

export const ownedAgentMediaSource = (db: Knex, ownerId: number, sessionId: string, row: AgentMediaMetadata): AgentMediaSource => ({
  id: row.id, filename: row.filename, mimeType: row.mimeType, byteLength: Number(row.byteLength),
  promptTokens: row.promptTokens === null ? undefined : Number(row.promptTokens),
  recordPromptTokens: async tokens => {
    if (!Number.isSafeInteger(tokens) || tokens < 1 || Number(row.byteLength) < 1) return
    await db('agentMedia').where({ id: row.id, ownerId, sessionId, sha256: row.sha256, byteLength: Number(row.byteLength) }).update({ promptTokens: tokens })
  },
  loadPayload: async signal => {
    signal.throwIfAborted()
    if (Number(row.byteLength) > AGENT_ATTACHMENT_MAX_BYTES) throw new AgentRepositoryError('INVALID_AGENT_MEDIA', 'Use document preparation for large PDFs.', 413)
    const fresh = await getOwnedAgentMedia(db, ownerId, row.id)
    if (fresh.sessionId !== sessionId || fresh.sha256 !== row.sha256) throw new AgentRepositoryError('AGENT_MEDIA_CORRUPT', 'Saved attachment failed integrity validation.', 500)
    signal.throwIfAborted()
    return fresh.payload
  },
  ...(row.mimeType === 'application/pdf' ? { preparePdf: async (signal: AbortSignal) => getCachedAgentPdf(db, { id: row.id, ownerId, sessionId, sha256: row.sha256, byteLength: Number(row.byteLength) }, signal, async () => {
    const staged = await stageOwnedAgentMedia(db, ownerId, row.id, signal)
    try {
      if (staged.media.sessionId !== sessionId || staged.media.sha256 !== row.sha256) throw new AgentRepositoryError('AGENT_MEDIA_CORRUPT', 'Saved attachment failed integrity validation.', 500)
      return await prepareAgentPdfFromPath(staged.path, signal)
    } finally { await staged.cleanup() }
  }) } : {})
})

/** Reads only the requested immutable bytea range, never a full video-sized Buffer. */
export async function* readOwnedAgentMediaRange(db: Knex, ownerId: number, media: AgentMediaMetadata, start: number, end: number, signal: AbortSignal): AsyncGenerator<Buffer> {
  const fresh = await getOwnedAgentMediaMetadata(db, ownerId, media.id)
  if (fresh.sha256 !== media.sha256 || Number(fresh.byteLength) !== Number(media.byteLength) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= Number(media.byteLength))
    throw new AgentRepositoryError('AGENT_MEDIA_CORRUPT', 'Saved attachment failed integrity validation.', 500)
  const digest = start === 0 && end === Number(media.byteLength) - 1 ? createHash('sha256') : null
  for (let offset = start; offset <= end; offset += 1024 * 1024) {
    signal.throwIfAborted()
    const length = Math.min(1024 * 1024, end - offset + 1)
    const expression = db.client.config.client === 'pg' ? 'substring(?? from ? for ?) as chunk' : 'substr(??, ?, ?) as chunk'
    const row = await db('agentMedia').where({ id: media.id, ownerId, sessionId: media.sessionId, sha256: media.sha256, byteLength: media.byteLength }).first(db.raw(expression, ['payload', offset + 1, length])) as { chunk: Uint8Array } | undefined
    if (!row || !(row.chunk instanceof Uint8Array) || row.chunk.byteLength !== length) throw new AgentRepositoryError('AGENT_MEDIA_CORRUPT', 'Saved attachment failed integrity validation.', 500)
    signal.throwIfAborted()
    digest?.update(row.chunk)
    if (digest && offset + length > end && digest.digest('hex') !== media.sha256) throw new AgentRepositoryError('AGENT_MEDIA_CORRUPT', 'Saved attachment failed integrity validation.', 500)
    yield Buffer.isBuffer(row.chunk) ? row.chunk : Buffer.from(row.chunk)
  }
}
