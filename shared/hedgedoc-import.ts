import { isLiveNoteKey, isLiveNoteRevision, liveNoteExactKeys, LIVE_NOTE_MAX_TEXT_BYTES } from './live-notes.ts'
import { hasAsciiControlCharacters } from './text-safety.ts'

export const HEDGEDOC_MAX_BYTES = 8 * 1024 * 1024
export const HEDGEDOC_MAX_NOTES = 25
export const HEDGEDOC_MAX_ASSET_BYTES = 1024 * 1024
export interface HedgeDocPatch { start: number; deleteCount: number; insert: string; beforeDigest: string; afterDigest: string }
export type HedgeDocRevision = { id: string; author: string; timestamp: string } & ({ markdown: string } | { patch: HedgeDocPatch })
export interface HedgeDocAsset { id: string; url: string; mime: string; base64: string; sha256: string }
export interface HedgeDocSourceNote { id: string; markdown: string; author: string; timestamp: string; history: HedgeDocRevision[]; historyComplete: boolean; assets: HedgeDocAsset[] }
export interface HedgeDocSnapshot { format: 'hedgedoc-content-v1'; namespace: string; notes: HedgeDocSourceNote[] }
export type HedgeDocAssetChoice = { sourceId: string; action: 'import'; filename: string; rewrite: boolean } | { sourceId: string; action: 'skip' }
export interface HedgeDocChoice { sourceId: string; ownerId: number; target: { kind: 'create'; key: string } | { kind: 'update'; key: string; expectedRevision: number }; assets: HedgeDocAssetChoice[] }
export interface HedgeDocReviewItem { sourceId: string; sourceDigest: string; reviewDigest: string; key: string; ownerId: number; currentRevision: number | null; history: 'complete' | 'incomplete'; historyCount: number; assets: Array<{ sourceId: string; action: 'import' | 'skip'; rewrite: boolean; url: string; destination: string | null; digest: string }>; status: 'ready' | 'imported' }
export interface HedgeDocReview { snapshotDigest: string; reviewDigest: string; items: HedgeDocReviewItem[]; warnings: string[] }
export interface HedgeDocReceipt { sourceId: string; key: string; revision: number; status: 'imported' | 'already-imported'; assets: Array<{ sourceId: string; status: 'imported' | 'skipped'; destination: string | null }> }
export interface HedgeDocProvenance { untrusted: true; namespace: string; sourceDigest: string; snapshotDigest: string; source: HedgeDocSourceNote; importedBy: number | null; importedAt: string; nativeRevision: number; assets: HedgeDocReceipt['assets'] }
const textBytes = (value: string) => new TextEncoder().encode(value).byteLength
const label = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128 && !hasAsciiControlCharacters(v)
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v)
const text = (v: unknown): v is string => typeof v === 'string' && textBytes(v) <= LIVE_NOTE_MAX_TEXT_BYTES && new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(v)) === v
const timestamp = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d\d-\d\dT/u.test(v) && Number.isFinite(Date.parse(v))
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const unique = (values: string[]) => new Set(values).size === values.length
export const isHedgeDocAssetFilename = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}\.(?:png|jpg|jpeg|gif|webp|pdf|txt)$/u.test(v)
function invalid(): never { throw new Error('Unsupported or invalid HedgeDoc snapshot. Use hedgedoc-content-v1; select at most 25 notes, 100 revisions and 20 export-only assets per note within the 8 MiB request budget. No accounts, credentials, paths, aliases or remote connectors are accepted.') }
export interface HedgeDocInput { snapshot: HedgeDocSnapshot; choices: HedgeDocChoice[]; reviewDigest?: string }
export function parseHedgeDocInput(value: unknown, execute = false): HedgeDocInput {
  if (!liveNoteExactKeys(value, execute ? ['snapshot', 'choices', 'reviewDigest'] : ['snapshot', 'choices'])) invalid()
  if (textBytes(JSON.stringify(value)) > HEDGEDOC_MAX_BYTES) invalid()
  const s = value.snapshot
  if (!liveNoteExactKeys(s, ['format', 'namespace', 'notes']) || s.format !== 'hedgedoc-content-v1' || !label(s.namespace) || !Array.isArray(s.notes) || s.notes.length < 1 || s.notes.length > HEDGEDOC_MAX_NOTES) invalid()
  for (const n of s.notes) {
    if (!liveNoteExactKeys(n, ['id', 'markdown', 'author', 'timestamp', 'history', 'historyComplete', 'assets']) || !label(n.id) || !text(n.markdown) || !label(n.author) || !timestamp(n.timestamp) || typeof n.historyComplete !== 'boolean' || !Array.isArray(n.history) || n.history.length > 100 || !Array.isArray(n.assets) || n.assets.length > 20) invalid()
    for (const r of n.history) {
      if (!liveNoteExactKeys(r, ['id', 'author', 'timestamp'], ['markdown', 'patch']) || !label(r.id) || !label(r.author) || !timestamp(r.timestamp) || (Object.hasOwn(r, 'markdown') === Object.hasOwn(r, 'patch'))) invalid()
      if (Object.hasOwn(r, 'markdown')) { if (!text(r.markdown)) invalid() }
      else {
        const p = r.patch
        if (!liveNoteExactKeys(p, ['start', 'deleteCount', 'insert', 'beforeDigest', 'afterDigest']) || !integer(p.start) || !integer(p.deleteCount) || !text(p.insert) || !digest(p.beforeDigest) || !digest(p.afterDigest)) invalid()
      }
    }
    for (const a of n.assets) {
      if (!liveNoteExactKeys(a, ['id', 'url', 'mime', 'base64', 'sha256']) || !label(a.id) || typeof a.url !== 'string' || a.url.length < 1 || a.url.length > 2048 || hasAsciiControlCharacters(a.url) || a.url.includes(' ') || typeof a.mime !== 'string' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'].includes(a.mime) || typeof a.base64 !== 'string' || a.base64.length > Math.ceil(HEDGEDOC_MAX_ASSET_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(a.base64) || !digest(a.sha256)) invalid()
    }
    if (!unique(n.history.map((r: HedgeDocRevision) => r.id)) || !unique(n.assets.map((a: HedgeDocAsset) => a.id))) invalid()
  }
  if (!unique(s.notes.map((n: HedgeDocSourceNote) => n.id)) || !Array.isArray(value.choices) || value.choices.length < 1 || value.choices.length > HEDGEDOC_MAX_NOTES || (execute && value.choices.length !== 1)) invalid()
  for (const c of value.choices) {
    if (!liveNoteExactKeys(c, ['sourceId', 'ownerId', 'target', 'assets']) || !label(c.sourceId) || !integer(c.ownerId) || c.ownerId < 1 || !Array.isArray(c.assets)) invalid()
    const n = s.notes.find((n: HedgeDocSourceNote) => n.id === c.sourceId)
    if (!n || c.assets.length !== n.assets.length || !unique(c.assets.map((a: HedgeDocAssetChoice) => a.sourceId))) invalid()
    const t = c.target
    if (!liveNoteExactKeys(t, ['kind', 'key'], ['expectedRevision']) || !isLiveNoteKey(t.key) || (t.kind !== 'create' && t.kind !== 'update') || (t.kind === 'create' ? Object.hasOwn(t, 'expectedRevision') : !isLiveNoteRevision(t.expectedRevision))) invalid()
    for (const a of c.assets) if (!liveNoteExactKeys(a, ['sourceId', 'action'], ['filename', 'rewrite']) || !n.assets.some((s: HedgeDocAsset) => s.id === a.sourceId) || (a.action !== 'skip' && a.action !== 'import') || (a.action === 'skip' ? Object.hasOwn(a, 'filename') || Object.hasOwn(a, 'rewrite') : !isHedgeDocAssetFilename(a.filename) || typeof a.rewrite !== 'boolean')) invalid()
    if (!unique(c.assets.filter((a: HedgeDocAssetChoice) => a.action === 'import').map((a: { filename: string }) => a.filename))) invalid()
  }
  if (!unique(value.choices.map((c: HedgeDocChoice) => c.sourceId)) || !unique(value.choices.map((c: HedgeDocChoice) => c.target.key)) || (execute && !digest(value.reviewDigest))) invalid()
  const destinations = value.choices.flatMap((c: HedgeDocChoice) => c.assets.flatMap(a => a.action === 'import' ? [a.filename] : []))
  if (!unique(destinations)) invalid()
  return value as unknown as HedgeDocInput
}
