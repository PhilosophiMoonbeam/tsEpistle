import { createHash, randomUUID } from 'node:crypto'
import MarkdownIt, { type Token } from 'markdown-it'
import type { Knex } from 'knex'
import type { WikiAuth } from '../controllers/_types.ts'
import { hasMethod, isRecord } from '../models/moduleTypes.ts'
import { parseHedgeDocInput, HEDGEDOC_MAX_ASSET_BYTES, type HedgeDocInput, type HedgeDocSnapshot, type HedgeDocChoice, type HedgeDocReview, type HedgeDocSourceNote, type HedgeDocReceipt, type HedgeDocProvenance } from '../../shared/hedgedoc-import.ts'
import { LIVE_NOTE_MAX_TEXT_BYTES } from '../../shared/live-notes.ts'
import { authorizeLiveNoteImport, writeLiveNoteImport, type LiveNoteRequester, type LiveNotePrincipal } from './live-notes.ts'
import assetHelper from '../helpers/asset.ts'
import { assertAssetLocationReservations, lockAssetLocation, withAssetLocationLocks } from '../helpers/asset-location-lock.ts'
import { assertNoPublicStoragePageAtPath, assertStorageAssetDestinationAllowed } from '../helpers/storage-path-admission.ts'
import { enqueueAssetStorageMutation } from '../jobs/storage-mutations.ts'
import errors from './errors.ts'

const { ApplicationError } = errors
interface Association { namespace: string; sourceId: string; sourceDigest: string; snapshotDigest: string; reviewDigest: string; noteId: string; nativeRevision: string | number; importedBy: number | null; importedAt: Date | string; source: string; assets: string }
interface Destination { id: string; key: string; ownerId: number | null; revision: string | number; deletedAt: Date | string | null }
interface Dependencies {
  db: Knex
  maxAssetBytes: () => number
  authorizeAsset: (tx: Knex.Transaction, principal: LiveNotePrincipal, path: string) => Promise<void>
  onCommitted?: (key: string) => void
}
function refuse(message: string, code = 'HEDGEDOC_INVALID', status = 400): never { throw new ApplicationError(message, { code, status }) }
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`).join(',')}}`
  const result = JSON.stringify(value)
  if (result === undefined) throw new TypeError('Snapshot contains a non-JSON value')
  return result
}
export const hedgeDocDigest = (value: string): string => createHash('sha256').update(value).digest('hex')

/** Every accepted patch is exact, not fuzzy: no offset search, ignored failure or invented segment. */
export const validateHedgeDocHistory = (note: HedgeDocSourceNote): void => {
  let current: string | null = null
  let replayBytes = 0
  for (const revision of note.history) {
    if ('markdown' in revision) current = revision.markdown
    else {
      const patch = revision.patch
      if (current === null || hedgeDocDigest(current) !== patch.beforeDigest || patch.start > current.length || patch.deleteCount > current.length - patch.start) refuse('History patch has no matching exact base. Export a full Markdown revision for the missing segment.', 'HEDGEDOC_HISTORY_INVALID')
      const next: string = current.slice(0, patch.start) + patch.insert + current.slice(patch.start + patch.deleteCount)
      if (Buffer.byteLength(next) > LIVE_NOTE_MAX_TEXT_BYTES || Buffer.from(next).toString('utf8') !== next || hedgeDocDigest(next) !== patch.afterDigest) refuse('History patch failed its result digest, Unicode boundaries or content bound. Correct the snapshot before review.', 'HEDGEDOC_HISTORY_INVALID')
      current = next
    }
    replayBytes += Buffer.byteLength(current)
    if (replayBytes > 16 * 1024 * 1024) refuse('Reconstructed history exceeds the 16 MiB replay budget. Select fewer original revisions.', 'HEDGEDOC_HISTORY_INVALID')
  }
  if (note.historyComplete && (current === null || current !== note.markdown)) refuse('Complete history must end at the exact selected Markdown. Mark unavailable segments incomplete instead of inventing history.', 'HEDGEDOC_HISTORY_INVALID')
}
const assetBytes = (asset: HedgeDocSourceNote['assets'][number], filename: string, maximum: number): Buffer => {
  const bytes = Buffer.from(asset.base64, 'base64')
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || bytes.length > Math.min(maximum, HEDGEDOC_MAX_ASSET_BYTES) || bytes.toString('base64') !== asset.base64) refuse('Asset exceeds current native upload policy or has invalid encoding.', 'HEDGEDOC_ASSET_INVALID')
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) refuse('Asset bytes do not match the reviewed SHA-256 digest.', 'HEDGEDOC_ASSET_INVALID')
  const ext = filename.slice(filename.lastIndexOf('.') + 1)
  const valid = asset.mime === 'image/png' ? ext === 'png' && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : asset.mime === 'image/jpeg' ? ['jpg', 'jpeg'].includes(ext) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : asset.mime === 'image/gif' ? ext === 'gif' && /^GIF8[79]a/u.test(bytes.subarray(0, 6).toString('ascii'))
    : asset.mime === 'image/webp' ? ext === 'webp' && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    : asset.mime === 'application/pdf' ? ext === 'pdf' && /^%PDF-1\.[0-7][\r\n]/u.test(bytes.subarray(0, 9).toString('ascii')) && /%%EOF[\t\n\f\r ]*$/u.test(bytes.subarray(-1024).toString('ascii'))
    : ext === 'txt' && !bytes.includes(0) && Buffer.from(bytes.toString('utf8')).equals(bytes)
  if (!valid) refuse('Asset type, filename extension and bytes disagree. Only bounded PNG/JPEG/GIF/WebP/PDF/UTF-8 text exports are admitted.', 'HEDGEDOC_ASSET_INVALID')
  return bytes
}
const importedMarkdown = (source: HedgeDocSourceNote, decisions: HedgeDocChoice['assets']): string => {
  const replacements = new Map<string, string>()
  for (const decision of decisions) {
    if (decision.action === 'import' && decision.rewrite) replacements.set(source.assets.find(asset => asset.id === decision.sourceId)!.url, `/${decision.filename}`)
  }
  if (replacements.size === 0) return source.markdown
  const markdown = new MarkdownIt({ html: true, linkify: false, typographer: false })
  // MarkdownIt normally shares its helpers object. Isolate capture from concurrent native rendering.
  markdown.helpers = { ...markdown.helpers }
  const environment: Record<string, unknown> = {}
  const blocks: Token[] = []
  markdown.block.parse(source.markdown, markdown, environment, blocks)
  const starts = [0]
  for (let index = 0; index < source.markdown.length; index++) if (source.markdown[index] === '\n') starts.push(index + 1)
  type Destination = { ok: boolean; pos: number; str: string }
  type DestinationParser = (text: string, start: number, end: number) => Destination
  const original = markdown.helpers.parseLinkDestination as unknown as DestinationParser
  const edits: Array<{ start: number; end: number; replacement: string }> = []
  const markerPrefix = `#hedgedoc-import-${randomUUID()}-`
  let activeContent = ''
  let captures = new Map<string, { start: number; end: number; replacement: string }>()
  // As in native page-move rewriting, parser-only markers prove a captured source
  // destination actually produced a native link/image token (not code or malformed syntax).
  markdown.helpers.parseLinkDestination = ((text, start, end) => {
    const result = original(text, start, end)
    if (!result.ok || text !== activeContent) return result
    const angled = text[start] === '<'
    const from = start + (angled ? 1 : 0)
    const to = result.pos - (angled ? 1 : 0)
    const replacement = replacements.get(text.slice(from, to))
    if (replacement === undefined) return result
    const marked = `${result.str}${markerPrefix}${captures.size}`
    captures.set(markdown.normalizeLink(marked), { start: from, end: to, replacement })
    return { ...result, str: marked }
  }) as typeof markdown.helpers.parseLinkDestination
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!
    if (block.type !== 'inline' || !block.map || block.level !== 1 || blocks[index - 1]?.type !== 'paragraph_open') continue
    const base = starts[block.map[0]]
    // Deliberately support only exact source-mapped plain paragraphs. Headings,
    // containers, reference definitions, HTML and extensions remain manual.
    if (base === undefined || source.markdown.slice(base, base + block.content.length) !== block.content) continue
    activeContent = block.content
    captures = new Map()
    const children: Token[] = []
    markdown.inline.parse(block.content, markdown, environment, children)
    if (children.some(token => token.type === 'html_inline')) continue
    for (const token of children) {
      const href = token.type === 'image' ? token.attrGet('src') : token.type === 'link_open' ? token.attrGet('href') : null
      if (href === null) continue
      const destination = String(href)
      const capture = captures.get(destination)
      if (!capture) continue
      captures.delete(destination)
      edits.push({ start: base + capture.start, end: base + capture.end, replacement: capture.replacement })
    }
  }
  let bytes = Buffer.byteLength(source.markdown)
  for (const edit of edits) bytes += edit.replacement.length - Buffer.byteLength(source.markdown.slice(edit.start, edit.end))
  if (bytes > LIVE_NOTE_MAX_TEXT_BYTES) refuse('Approved Markdown destinations exceed the native note size limit. Choose shorter destinations or preserve source URLs.', 'HEDGEDOC_BUDGET', 413)
  let result = source.markdown
  let boundary = result.length
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    if (edit.end > boundary) continue
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end)
    boundary = edit.start
  }
  return result
}
export const createHedgeDocImportStore = ({ db, maxAssetBytes, authorizeAsset, onCommitted }: Dependencies) => {
  const inspect = async (tx: Knex.Transaction, requester: LiveNoteRequester, snapshot: HedgeDocSnapshot, choices: HedgeDocChoice[], executing = false): Promise<HedgeDocReview> => {
    const principal = await authorizeLiveNoteImport(tx, requester)
    const deadline = Date.now() + 5000
    const assetLimit = maxAssetBytes()
    const snapshotDigest = hedgeDocDigest(canonical(snapshot))
    const items: HedgeDocReview['items'] = []
    for (const choice of choices) {
      if (Date.now() > deadline) refuse('Inventory exceeded its five-second processing budget. Select fewer notes or revisions.', 'HEDGEDOC_BUDGET', 413)
      if (choice.ownerId !== principal.id) refuse('Native imports require the mapped owner to execute their own import. Sign in as that existing owner and review only their selected notes; administrator status does not impersonate another owner.', 'HEDGEDOC_OWNER_REQUIRED', 403)
      const source = snapshot.notes.find(note => note.id === choice.sourceId)!
      validateHedgeDocHistory(source)
      const sourceDigest = hedgeDocDigest(canonical(source))
      const association = await tx<Association>('hedgedocImports').where({ namespace: snapshot.namespace, sourceId: source.id }).first()
      const destination = await tx<Destination>('liveNotes').where({ key: choice.target.key }).modify(q => { if (executing) q.forUpdate() }).first()
      if (destination && (destination.deletedAt !== null || destination.ownerId !== principal.id)) refuse('Destination is unavailable to this owner. Select your own live note or an unused key.', 'HEDGEDOC_DESTINATION_CONFLICT', 409)
      if (destination && !association && await tx('hedgedocImports').where({ noteId: destination.id }).first('noteId')) refuse('Destination already belongs to another imported source. Choose a different note; stable source associations cannot be reassigned.', 'HEDGEDOC_DESTINATION_CONFLICT', 409)
      if (association) {
        if (association.sourceDigest !== sourceDigest || association.snapshotDigest !== snapshotDigest || !destination || destination.id !== association.noteId) refuse('Source association or snapshot changed. Preserve the original snapshot and resume using its original review; select a new source identity only for a genuinely different source.', 'HEDGEDOC_SOURCE_CONFLICT', 409)
        // A repeat never rewrites a note, even when the native owner subsequently edited it.
      } else if (choice.target.kind === 'create' ? !!destination : !destination || Number(destination.revision) !== choice.target.expectedRevision) refuse('Destination exists or its revision changed. Review an explicit update at the current native revision; no native content was replaced.', 'HEDGEDOC_DESTINATION_CONFLICT', 409)
      const assets: HedgeDocReview['items'][number]['assets'] = []
      for (const decision of choice.assets) {
        if (Date.now() > deadline) refuse('Asset inventory exceeded its five-second processing budget. Select fewer assets.', 'HEDGEDOC_BUDGET', 413)
        const asset = source.assets.find(asset => asset.id === decision.sourceId)!
        if (decision.action === 'import' && decision.rewrite && source.assets.filter(candidate => candidate.url === asset.url).length !== 1) refuse('Source URL maps to multiple asset identities. Resolve the export ambiguity before approving URL replacement.', 'HEDGEDOC_ASSET_INVALID')
        if (decision.action === 'skip') { assets.push({ sourceId: asset.id, action: 'skip', rewrite: false, url: asset.url, destination: null, digest: asset.sha256 }); continue }
        assetBytes(asset, decision.filename, assetLimit)
        assertStorageAssetDestinationAllowed(decision.filename)
        await authorizeAsset(tx, principal, decision.filename)
        if (!association && await tx('assets').where({ hash: assetHelper.generateHash(decision.filename) }).first('id')) refuse('Asset destination already exists. Choose a new filename; imports never overwrite or silently reuse existing assets.', 'HEDGEDOC_ASSET_CONFLICT', 409)
        if (association) {
          const persisted = await tx<{ data: Buffer }>('assetData').join('assets', 'assets.id', 'assetData.id').where('assets.hash', assetHelper.generateHash(decision.filename)).first('assetData.data')
          if (!persisted || createHash('sha256').update(persisted.data).digest('hex') !== asset.sha256) refuse('A previously imported asset is missing or changed. Preserve current native assets and resolve this destination explicitly; resume will not overwrite it.', 'HEDGEDOC_ASSET_CONFLICT', 409)
        }
        assets.push({ sourceId: asset.id, action: 'import', rewrite: decision.rewrite, url: asset.url, destination: `/${decision.filename}`, digest: asset.sha256 })
      }
      importedMarkdown(source, choice.assets)
      const reviewDigest = hedgeDocDigest(canonical({ snapshotDigest, choice, actorId: principal.id, configuration: { format: 1, assetLimit } }))
      items.push({ sourceId: source.id, sourceDigest, reviewDigest, key: choice.target.key, ownerId: principal.id, currentRevision: association ? null : destination ? Number(destination.revision) : null, history: source.historyComplete ? 'complete' : 'incomplete', historyCount: source.history.length, assets, status: association ? 'imported' : 'ready' })
    }
    // Current revision is already an explicit part of update choices. Keep repeat fingerprints stable.
    const reviewDigest = hedgeDocDigest(canonical({ snapshotDigest, choices, actorId: principal.id, configuration: { format: 1, assetLimit } }))
    for (const item of items) {
      const association = await tx<Association>('hedgedocImports').where({ namespace: snapshot.namespace, sourceId: item.sourceId }).first()
      if (association && association.reviewDigest !== item.reviewDigest) refuse('Import choices changed since the durable checkpoint. Resume the exact reviewed mapping and asset decisions.', 'HEDGEDOC_REVIEW_CONFLICT', 409)
    }
    return { snapshotDigest, reviewDigest, items, warnings: ['All source authors, times and history are untrusted provenance, not native edit attribution. Review selected source content for secrets before import or publication.', 'Notes remain private. Assets retain independent native authorization; importing an asset does not make it private with the note. Skipped source URLs remain unchanged and are never fetched.', 'Approved URL rewrites apply only to exact native Markdown link/image destinations in source-mapped plain paragraphs. Code, literals, prose, headings, containers, references, HTML and extension directives remain unchanged; inspect and manually edit unsupported source destinations in the native note.', 'Incomplete history is retained as incomplete. Imported source records are available through provenance; native history records only the actual importer and native commit time.'] }
  }
  return {
    async review(requester: LiveNoteRequester, input: unknown): Promise<HedgeDocReview> {
      let parsed: HedgeDocInput
      try { parsed = parseHedgeDocInput(input) } catch (error) { return refuse(error instanceof Error ? error.message : 'Invalid snapshot.') }
      return db.transaction(async tx => {
        await tx.raw("SET LOCAL statement_timeout = '5s'")
        return inspect(tx, requester, parsed.snapshot, parsed.choices)
      })
    },
    async execute(requester: LiveNoteRequester, input: unknown): Promise<HedgeDocReceipt> {
      let parsed: HedgeDocInput
      try { parsed = parseHedgeDocInput(input, true) } catch (error) { return refuse(error instanceof Error ? error.message : 'Invalid snapshot.') }
      const { snapshot, choices } = parsed
      const choice = choices[0]!
      const receipt = await withAssetLocationLocks(['assets', ...choice.assets.flatMap(asset => asset.action === 'import' ? [asset.filename] : [])], (_assertHeld, connection) => db.transaction(async tx => {
        await tx.raw("SET LOCAL statement_timeout = '5s'")
        // Cross-process lock also covers first association creation and first destination selection.
        await tx.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [0x4844494d, canonical([snapshot.namespace, choice.sourceId])])
        await tx.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [0x48444b59, choice.target.key])
        const review = await inspect(tx, requester, snapshot, choices, true)
        if (parsed.reviewDigest !== review.items[0]!.reviewDigest) refuse('The reviewed snapshot or choices changed. Inventory again before importing.', 'HEDGEDOC_REVIEW_CONFLICT', 409)
        const existing = await tx<Association>('hedgedocImports').where({ namespace: snapshot.namespace, sourceId: choice.sourceId }).first()
        if (existing) return { sourceId: choice.sourceId, key: choice.target.key, revision: Number(existing.nativeRevision), status: 'already-imported' as const, assets: JSON.parse(existing.assets) as HedgeDocReceipt['assets'] }
        const principal = await authorizeLiveNoteImport(tx, requester)
        const source = snapshot.notes.find(note => note.id === choice.sourceId)!
        const outcomes: HedgeDocReceipt['assets'] = []
        const deadline = Date.now() + 5000
        const markdown = importedMarkdown(source, choice.assets)
        for (const decision of choice.assets) {
          if (Date.now() > deadline) refuse('Import exceeded its five-second processing budget. Reduce selected assets and review again; this item is rolled back.', 'HEDGEDOC_BUDGET', 413)
          if (decision.action === 'skip') { outcomes.push({ sourceId: decision.sourceId, status: 'skipped', destination: null }); continue }
          const asset = source.assets.find(asset => asset.id === decision.sourceId)!
          const bytes = assetBytes(asset, decision.filename, maxAssetBytes())
          await authorizeAsset(tx, principal, decision.filename)
          await assertNoPublicStoragePageAtPath(tx, decision.filename)
          await lockAssetLocation(tx, decision.filename)
          await assertAssetLocationReservations(tx, [decision.filename])
          const hash = assetHelper.generateHash(decision.filename)
          if (await tx('assets').where({ hash }).first('id')) refuse('Asset destination changed after review. Choose a new filename and review again.', 'HEDGEDOC_ASSET_CONFLICT', 409)
          const [row] = await tx('assets').insert({ filename: decision.filename, hash, ext: decision.filename.slice(decision.filename.lastIndexOf('.')), kind: asset.mime.startsWith('image/') ? 'image' : 'binary', mime: asset.mime, fileSize: bytes.length, folderId: null, authorId: principal.id, metadata: '{}', createdAt: new Date(), updatedAt: new Date() }).returning('id') as Array<{ id: number }>
          if (!row) throw new Error('Native asset insert returned no identity')
          await tx('assetData').insert({ id: row.id, data: bytes })
          const account = await tx<{ name: string; email: string }>('users').where('id', principal.id).first('name', 'email')
          if (!account) refuse('Native importing account is unavailable.', 'AUTH_REQUIRED', 401)
          await enqueueAssetStorageMutation(tx, { assetId: row.id, paths: [decision.filename], author: { id: principal.id, name: account.name, email: account.email } })
          outcomes.push({ sourceId: asset.id, status: 'imported', destination: `/${decision.filename}` })
        }
        if (Date.now() > deadline) refuse('Import exceeded its five-second processing budget. No part of this item was committed.', 'HEDGEDOC_BUDGET', 413)
        const note = await writeLiveNoteImport(tx, requester, choice.target, markdown)
        await tx('hedgedocImports').insert({ namespace: snapshot.namespace, sourceId: source.id, sourceDigest: review.items[0]!.sourceDigest, snapshotDigest: review.snapshotDigest, reviewDigest: review.items[0]!.reviewDigest, noteId: note.id, nativeRevision: note.revision, importedBy: principal.id, importedAt: new Date(), source: JSON.stringify(source), assets: JSON.stringify(outcomes) })
        return { sourceId: source.id, key: note.key, revision: note.revision, status: 'imported' as const, assets: outcomes }
      }, { connection }), db)
      onCommitted?.(receipt.key)
      return receipt
    },
    async provenance(requester: LiveNoteRequester, key: string): Promise<HedgeDocProvenance> {
      return db.transaction(async tx => {
        const principal = await authorizeLiveNoteImport(tx, requester)
        const note = await tx<Destination>('liveNotes').where({ key, ownerId: principal.id }).whereNull('deletedAt').forShare().first()
        if (!note) return refuse('Imported note is unavailable to this owner.', 'NOTE_NOT_FOUND', 404)
        const row = await tx<Association>('hedgedocImports').where({ noteId: note.id }).first()
        if (!row) return refuse('No imported source provenance exists for this note.', 'NOTE_NOT_FOUND', 404)
        return { untrusted: true, namespace: row.namespace, sourceDigest: row.sourceDigest, snapshotDigest: row.snapshotDigest, source: JSON.parse(row.source) as HedgeDocSourceNote, importedBy: row.importedBy, importedAt: new Date(row.importedAt).toISOString(), nativeRevision: Number(row.nativeRevision), assets: JSON.parse(row.assets) as HedgeDocReceipt['assets'] }
      })
    }
  }
}

interface Runtime { models: { knex: Knex }; config: { uploads: { maxFileSize: number; maxFiles: number } }; auth: Pick<WikiAuth, 'loadPageRuleAuthority' | 'checkPageAccess'>; events?: { outbound?: { emit(event: string, value: unknown): void } }; logger?: { warn(error: unknown): void } }
function isRuntime(value: unknown): value is Runtime {
  if (!isRecord(value) || !isRecord(value.models) || typeof value.models.knex !== 'function' || !hasMethod(value.models.knex, 'transaction') || !hasMethod(value.models.knex, 'raw')) return false
  if (!isRecord(value.config) || !isRecord(value.config.uploads) || typeof value.config.uploads.maxFileSize !== 'number' || typeof value.config.uploads.maxFiles !== 'number') return false
  if (!isRecord(value.auth) || !hasMethod(value.auth, 'loadPageRuleAuthority') || !hasMethod(value.auth, 'checkPageAccess')) return false
  if (value.events !== undefined && (!isRecord(value.events) || (value.events.outbound !== undefined && (!isRecord(value.events.outbound) || !hasMethod(value.events.outbound, 'emit'))))) return false
  return value.logger === undefined || (isRecord(value.logger) && hasMethod(value.logger, 'warn'))
}
const runtimeStore = () => {
  const wiki: unknown = Reflect.get(globalThis, 'WIKI')
  if (!isRuntime(wiki)) throw new Error('Native HedgeDoc import services are not initialized')
  return createHedgeDocImportStore({
    db: wiki.models.knex,
    maxAssetBytes: () => wiki.config.uploads.maxFiles > 0 ? wiki.config.uploads.maxFileSize : 0,
    authorizeAsset: async (tx, principal, path) => {
      const authority = await wiki.auth.loadPageRuleAuthority(principal, tx)
      if (!wiki.auth.checkPageAccess(principal, ['write:assets', 'manage:system'], { path }, authority)) refuse('Native asset write authority is required at every selected destination.', 'HEDGEDOC_ASSET_FORBIDDEN', 403)
    },
    onCommitted: key => { try { wiki.events?.outbound?.emit('liveNoteUpdated', { key }) } catch (error) { wiki.logger?.warn(error) } }
  })
}
export const hedgedocImport = {
  review: (requester: LiveNoteRequester, input: unknown) => runtimeStore().review(requester, input),
  execute: (requester: LiveNoteRequester, input: unknown) => runtimeStore().execute(requester, input),
  provenance: (requester: LiveNoteRequester, key: string) => runtimeStore().provenance(requester, key)
}
