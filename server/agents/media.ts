import sharp from 'sharp'
import { AGENT_ATTACHMENT_MAX_BYTES, AGENT_PDF_ATTACHMENT_MAX_BYTES } from '../../shared/agents/media-limits.ts'
import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { AgentMediaView } from '../../shared/agents/contracts.ts'
import { AgentRepositoryError, getOwnedAgentSession } from './repository.ts'
import { AgentProviderAdapterConfigSchema } from './providers/registry.ts'

export const AGENT_MEDIA_MAX_BYTES = AGENT_PDF_ATTACHMENT_MAX_BYTES
export const AGENT_MEDIA_OWNER_MAX_BYTES = 100 * 1024 * 1024
export const AGENT_MEDIA_MAX_ATTACHMENTS = 4
export interface AgentMediaPayload {
  readonly id: string
  readonly mimeType: string
  readonly filename: string
  readonly byteLength: number
  readonly payload: Buffer
}
export interface AgentMediaRow extends AgentMediaPayload {
  readonly sha256: string
  readonly ownerId: number
  readonly sessionId: string
  readonly messageId: string | null
  readonly runId: string | null
  readonly kind: 'attachment' | 'generated-image'
  readonly expiresAt: Date | string | null
}
export const projectAgentMedia = (row: Pick<AgentMediaRow, 'id' | 'kind' | 'filename' | 'mimeType' | 'byteLength' | 'expiresAt'>): AgentMediaView => ({
  id: row.id,
  kind: row.kind,
  filename: row.filename,
  mimeType: row.mimeType,
  byteLength: Number(row.byteLength),
  available: row.expiresAt === null || new Date(row.expiresAt).valueOf() > Date.now()
})
const invalid = (): never => {
  throw new AgentRepositoryError('INVALID_AGENT_MEDIA', 'Choose a PDF up to 100 MB, or a supported image or audio recording up to 10 MB.', 400)
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
  kind: 'attachments' | 'imageGeneration' | 'transcription'
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
    kind?: 'attachment' | 'generated-image'
    messageId?: string
    runId?: string
    leaseOwner?: string | null
    leaseToken?: string | null
  }
): Promise<AgentMediaRow> => {
  const mimeType = validateAgentMedia(input.payload, input.mimeType)
  if (input.kind === 'generated-image' && (!mimeType.startsWith('image/') || !input.messageId || !input.runId || !input.leaseOwner || !input.leaseToken))
    throw new AgentRepositoryError('INVALID_AGENT_MEDIA', 'Generated media requires an active run lease.', 500)
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
