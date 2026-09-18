import type { Knex } from 'knex'
import { AGENT_ATTACHMENT_MAX_BYTES, AGENT_PDF_ATTACHMENT_MAX_BYTES } from '../../shared/agents/media-limits.ts'
import { assertAssetLocationAssetSettled, withAssetLocationLocks } from '../helpers/asset-location-lock.ts'
import assetHelper from '../helpers/asset.ts'
import { AgentRepositoryError } from './repository.ts'
import { validateAgentMedia } from './media.ts'

const unavailable = () => new AgentRepositoryError('AGENT_ASSET_UNAVAILABLE', 'This Wiki asset is unavailable or you no longer have access to it.', 404)
const unsafeSegment = (value: string): boolean =>
  Array.from(value).some(character => character === '/' || character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
const mimeTypes: Readonly<Record<string, string>> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
/** Resolve an authorized immutable snapshot. Never fetch user-supplied URLs or expose unlock credentials. */
export const readAgentWikiAsset = async (
  db: Knex,
  input: { assetId: number; signal: AbortSignal; authorize: (path: string, transaction: Knex.Transaction) => Promise<void> }
): Promise<{ filename: string; mimeType: string; payload: Buffer }> =>
  withAssetLocationLocks(
    ['assets'],
    async () =>
      db.transaction(async tx => {
        input.signal.throwIfAborted()
        const asset = await tx('assets').where({ id: input.assetId }).forShare().first('id', 'filename', 'folderId', 'hash', 'ext', 'fileSize')
        if (!asset || typeof asset.filename !== 'string' || unsafeSegment(asset.filename) || ['.', '..'].includes(asset.filename)) throw unavailable()
        const segments = [asset.filename]
        const seen = new Set<number>()
        let parentId = Number(asset.folderId ?? 0)
        while (parentId) {
          if (!Number.isSafeInteger(parentId) || parentId < 1 || seen.has(parentId) || seen.size >= 64) throw unavailable()
          seen.add(parentId)
          const folder = await tx('assetFolders').where({ id: parentId }).forShare().first('id', 'slug', 'parentId')
          if (!folder || typeof folder.slug !== 'string' || !folder.slug || unsafeSegment(folder.slug) || ['.', '..'].includes(folder.slug)) throw unavailable()
          segments.unshift(folder.slug)
          parentId = Number(folder.parentId ?? 0)
        }
        const path = segments.join('/')
        if (asset.hash !== assetHelper.generateHash(path)) throw unavailable()
        await input.authorize(path, tx)
        await assertAssetLocationAssetSettled(tx, asset.id)
        const mimeType = mimeTypes[String(asset.ext).toLowerCase()]
        if (!mimeType) throw new AgentRepositoryError('INVALID_AGENT_MEDIA', 'Choose a PDF, PNG, JPEG, or WebP image.', 400)
        const limit = mimeType === 'application/pdf' ? AGENT_PDF_ATTACHMENT_MAX_BYTES : AGENT_ATTACHMENT_MAX_BYTES
        if (!Number.isSafeInteger(Number(asset.fileSize)) || Number(asset.fileSize) < 1 || Number(asset.fileSize) > limit)
          throw new AgentRepositoryError('INVALID_AGENT_MEDIA', 'Choose a PDF up to 250 MB or an image up to 10 MB.', 413)
        const data = await tx('assetData').where({ id: asset.id }).first('data')
        if (!data || !(data.data instanceof Uint8Array) || data.data.byteLength !== Number(asset.fileSize)) throw unavailable()
        const payload = Buffer.isBuffer(data.data) ? data.data : Buffer.from(data.data)
        validateAgentMedia(payload, mimeType)
        input.signal.throwIfAborted()
        await input.authorize(path, tx)
        return { filename: asset.filename, mimeType, payload }
      }),
    db
  )
