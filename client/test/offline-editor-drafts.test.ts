import { afterEach, beforeEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import {
  OfflineEditorDraftCoordinator,
  type OfflineEditorDraftIdentity,
  type OfflineEditorDraftValues,
  type OfflineEditorDraftView
} from '../helpers/offline-editor-drafts.ts'
import { invalidateOfflineSession } from '../helpers/offline-session.ts'
import {
  OFFLINE_DRAFT_KEY_MAGIC,
  OFFLINE_KEY_VERSION,
  type DraftKeyContext,
  type OfflineDraftEnvelopeV1
} from '../../shared/offline.ts'
import { OfflineDraftConflictError, type OfflineDraftDeleteOptions, type OfflineDraftWriteOptions, type OfflineStorage, type OfflineStorageGenerationOptions, type OfflineSubmissionFinalizationOptions, type OfflineSubmissionFinalizationResult } from '../helpers/offline-storage.ts'

const ORIGIN = 'https://wiki.example.test'
const SESSION_GENERATION = 0
const originalWindow = globalThis.window

const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

const lengthPrefixed = (value: string): Uint8Array => {
  const bytes = new TextEncoder().encode(value)
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, bytes.byteLength, false)
  return concatBytes([length, bytes])
}

const u64be = (value: number): Uint8Array => {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false)
  return bytes
}

const encodeKeyFrame = (context: DraftKeyContext, keyBytes: Uint8Array): Uint8Array =>
  concatBytes([
    new TextEncoder().encode(OFFLINE_DRAFT_KEY_MAGIC),
    lengthPrefixed(context.canonicalOrigin),
    lengthPrefixed(context.siteId),
    u64be(context.accountId),
    u64be(context.authVersion),
    lengthPrefixed(context.keyVersion),
    keyBytes
  ])

type OwnerKey = {
  readonly context: DraftKeyContext
  readonly keyBytes: Uint8Array
  readonly sessionGeneration: number
}

const ownerKey = (accountId: number, seed = accountId): OwnerKey => {
  const keyBytes = new Uint8Array(32)
  keyBytes.fill(seed)
  return {
    context: {
      canonicalOrigin: ORIGIN,
      siteId: 'site-fixture',
      accountId,
      authVersion: 0,
      keyVersion: OFFLINE_KEY_VERSION
    },
    keyBytes,
    sessionGeneration: SESSION_GENERATION
  }
}

const keyFetch = (source: () => OwnerKey, calls: { count: number }): typeof window.fetch => {
  const fetchImpl = async (): Promise<Response> => {
    calls.count += 1
    const owner = source()
    return new Response(encodeKeyFrame(owner.context, owner.keyBytes) as unknown as BodyInit, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' }
    })
  }
  return fetchImpl as unknown as typeof window.fetch
}

const cloneEnvelope = (envelope: OfflineDraftEnvelopeV1): OfflineDraftEnvelopeV1 => ({
  ...envelope,
  nonce: new Uint8Array(envelope.nonce),
  ciphertext: new Uint8Array(envelope.ciphertext)
})

const immutableSelectorsEqual = (left: OfflineDraftEnvelopeV1, right: OfflineDraftEnvelopeV1): boolean =>
  left.recordId === right.recordId &&
  left.sessionGeneration === right.sessionGeneration &&
  left.draftRevision === right.draftRevision &&
  left.submissionId === right.submissionId
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((value, index) => value === right[index])

const sameEnvelope = (left: OfflineDraftEnvelopeV1, right: OfflineDraftEnvelopeV1): boolean =>
  immutableSelectorsEqual(left, right) &&
  left.schemaVersion === right.schemaVersion &&
  left.accountId === right.accountId &&
  left.authVersion === right.authVersion &&
  left.keyVersion === right.keyVersion &&
  sameBytes(left.nonce, right.nonce) &&
  sameBytes(left.ciphertext, right.ciphertext)


class InMemoryDraftStorage {
  readonly records = new Map<string, OfflineDraftEnvelopeV1>()
  readonly writes: Array<{ envelope: OfflineDraftEnvelopeV1; options: OfflineDraftWriteOptions }> = []
  readonly deletes: Array<{ recordId: string; options: OfflineDraftDeleteOptions }> = []
  readonly finalizations: Array<{ options: OfflineSubmissionFinalizationOptions; result: OfflineSubmissionFinalizationResult }> = []
  generation = SESSION_GENERATION
  failNextPut = false
  conflictNextPut = false

  private assertGeneration(options: OfflineStorageGenerationOptions): void {
    if (options.expectedSessionGeneration !== undefined && options.expectedSessionGeneration !== this.generation) {
      throw new Error('session generation mismatch')
    }
  }

  async currentSessionGeneration(): Promise<number> {
    return this.generation
  }

  async listDraftEnvelopes(_accountId: number, options: OfflineStorageGenerationOptions = {}): Promise<OfflineDraftEnvelopeV1[]> {
    this.assertGeneration(options)
    // Returning every envelope deliberately exercises the coordinator's owner and AEAD gates.
    return [...this.records.values()].map(cloneEnvelope)
  }

  async putDraft(envelope: OfflineDraftEnvelopeV1, options: OfflineDraftWriteOptions = {}): Promise<OfflineDraftEnvelopeV1> {
    const existing = this.records.get(envelope.recordId)
    if (this.failNextPut) {
      this.failNextPut = false
      throw new Error('simulated offline write failure')
    }
    if (this.conflictNextPut) {
      this.conflictNextPut = false
      throw new OfflineDraftConflictError(envelope.recordId)
    }
    this.assertGeneration(options)
    if (options.expectedDraftRevision !== undefined && (existing?.draftRevision ?? null) !== options.expectedDraftRevision) {
      throw new Error('draft revision conflict')
    }
    if (options.expectedSubmissionId !== undefined && (existing?.submissionId ?? null) !== options.expectedSubmissionId) {
      throw new Error('submission selector conflict')
    }
    if (existing && existing.submissionId !== null && !sameEnvelope(existing, envelope)) {
      throw new Error('immutable submission overwrite')
    }
    const saved = cloneEnvelope(envelope)
    this.records.set(saved.recordId, saved)
    this.writes.push({ envelope: cloneEnvelope(saved), options: { ...options } })
    return cloneEnvelope(saved)
  }

  async deleteDraft(recordId: string, options: OfflineDraftDeleteOptions = {}): Promise<boolean> {
    this.assertGeneration(options)
    const existing = this.records.get(recordId)
    if (!existing) return false
    if (options.expectedDraftRevision !== undefined && existing.draftRevision !== options.expectedDraftRevision) {
      throw new Error('draft revision conflict')
    }
    if (options.expectedSubmissionId !== undefined && existing.submissionId !== options.expectedSubmissionId) {
      throw new Error('submission selector conflict')
    }
    this.deletes.push({ recordId, options: { ...options } })
    this.records.delete(recordId)
    return true
  }
  async finalizeSubmission(options: OfflineSubmissionFinalizationOptions): Promise<OfflineSubmissionFinalizationResult> {
    this.assertGeneration(options)
    const receipt = this.records.get(options.expectedReceipt.recordId)
    if (!receipt || !sameEnvelope(receipt, options.expectedReceipt)) throw new Error('immutable receipt conflict')
    const expectedSource = options.expectedSource
    const source = expectedSource === null ? null : this.records.get(expectedSource.recordId)
    if (expectedSource && (!source || !sameEnvelope(source, expectedSource))) throw new Error('source conflict')
    const expectedSurvivingFork = options.expectedSurvivingFork
    const oldFork = expectedSurvivingFork === null ? null : this.records.get(expectedSurvivingFork.recordId)
    if (expectedSurvivingFork && (!oldFork || !sameEnvelope(oldFork, expectedSurvivingFork))) throw new Error('fork conflict')
    const survivingFork = options.survivingFork
    if (expectedSurvivingFork && !survivingFork) throw new Error('fork replacement missing')
    if (survivingFork && (!source || survivingFork.draftRevision <= source.draftRevision)) throw new Error('fork conflict')
    if (survivingFork && expectedSurvivingFork) {
      if (survivingFork.recordId !== expectedSurvivingFork.recordId || survivingFork.draftRevision <= expectedSurvivingFork.draftRevision) {
        throw new Error('fork replacement conflict')
      }
    } else if (survivingFork && this.records.has(survivingFork.recordId)) {
      throw new Error('fork record conflict')
    }

    this.records.delete(receipt.recordId)
    if (source) this.records.delete(source.recordId)
    if (oldFork) this.records.delete(oldFork.recordId)
    if (survivingFork) this.records.set(survivingFork.recordId, cloneEnvelope(survivingFork))
    const result: OfflineSubmissionFinalizationResult = {
      receiptDeleted: true,
      sourceDeleted: source !== null,
      survivingFork: survivingFork ? cloneEnvelope(survivingFork) : null
    }
    const recordedOptions: OfflineSubmissionFinalizationOptions = {
      ...options,
      expectedReceipt: cloneEnvelope(options.expectedReceipt),
      expectedSource: expectedSource ? cloneEnvelope(expectedSource) : null,
      expectedSurvivingFork: expectedSurvivingFork ? cloneEnvelope(expectedSurvivingFork) : null,
      survivingFork: survivingFork ? cloneEnvelope(survivingFork) : null
    }
    this.finalizations.push({ options: recordedOptions, result })
    return {
      ...result,
      survivingFork: result.survivingFork ? cloneEnvelope(result.survivingFork) : null
    }
  }
  async recoverOrdinaryDraft(
    expectedEnvelope: OfflineDraftEnvelopeV1,
    replacementEnvelope: OfflineDraftEnvelopeV1,
    options: OfflineStorageGenerationOptions = {}
  ): Promise<OfflineDraftEnvelopeV1> {
    this.assertGeneration(options)
    if (
      expectedEnvelope.submissionId !== null ||
      replacementEnvelope.submissionId !== null ||
      expectedEnvelope.recordId !== replacementEnvelope.recordId ||
      expectedEnvelope.accountId !== replacementEnvelope.accountId ||
      expectedEnvelope.authVersion !== replacementEnvelope.authVersion ||
      expectedEnvelope.keyVersion !== replacementEnvelope.keyVersion ||
      expectedEnvelope.draftRevision !== replacementEnvelope.draftRevision ||
      replacementEnvelope.sessionGeneration <= expectedEnvelope.sessionGeneration
    )
      throw new Error('ordinary recovery selector conflict')
    const existing = this.records.get(expectedEnvelope.recordId)
    if (!existing || !sameEnvelope(existing, expectedEnvelope)) throw new Error('ordinary recovery CAS conflict')
    const replacement = cloneEnvelope(replacementEnvelope)
    this.records.set(replacement.recordId, replacement)
    return cloneEnvelope(replacement)
  }



  close(): void {}
}

const identity = (pageId = 42): OfflineEditorDraftIdentity => ({
  editorKey: 'markdown',
  pageId,
  createIdentity: null,
  locale: 'en',
  path: '/docs/example',
  baseSourceRevision: 'source-1',
  baseUpdatedAt: '2026-01-01T00:00:00.000Z'
})

const values = (content: string): OfflineEditorDraftValues => ({
  title: 'Example',
  description: 'A local example',
  content
})

type CoordinatorSetup = {
  readonly coordinator: OfflineEditorDraftCoordinator
  readonly changes: OfflineEditorDraftView[]
  readonly fetchCalls: { count: number }
}

const makeCoordinator = (options: {
  readonly storage: InMemoryDraftStorage
  readonly owner: OwnerKey
  readonly accountId?: number
  readonly fetchOwner?: () => OwnerKey
  readonly currentValues: () => OfflineEditorDraftValues
  readonly currentIdentity?: () => OfflineEditorDraftIdentity
}): CoordinatorSetup => {
  const changes: OfflineEditorDraftView[] = []
  const fetchCalls = { count: 0 }
  const accountId = options.accountId ?? options.owner.context.accountId
  const coordinator = new OfflineEditorDraftCoordinator({
    fetchImpl: keyFetch(options.fetchOwner ?? (() => options.owner), fetchCalls),
    isAuthenticated: () => true,
    accountId: () => accountId,
    getIdentity: options.currentIdentity ?? (() => identity()),
    getValues: options.currentValues,
    isDirty: () => true,
    isOnline: () => false,
    storage: options.storage as unknown as OfflineStorage,
    debounceMs: 10,
    onChange: view => changes.push(view)
  })
  return { coordinator, changes, fetchCalls }
}

beforeEach(() => {
  globalThis.window = { location: { origin: ORIGIN } } as unknown as Window & typeof globalThis
  invalidateOfflineSession()
})

afterEach(() => {
  invalidateOfflineSession()
  vi.useRealTimers()
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
  else globalThis.window = originalWindow
})

describe('offline editor draft coordinator', () => {
  it('captures the latest values after debounced rescheduling and advances the CAS revision', async () => {
    vi.useFakeTimers()
    const storage = new InMemoryDraftStorage()
    let current = values('first capture')
    const { coordinator } = makeCoordinator({ storage, owner: ownerKey(7), currentValues: () => current })

    await expect(coordinator.initialize()).resolves.toMatchObject({ state: null, candidate: null, committed: false })
    await expect(coordinator.captureNow({ force: true })).resolves.toBe(true)

    current = values('intermediate value that must never be persisted')
    coordinator.scheduleCapture()
    current = values('latest debounced value')
    coordinator.scheduleCapture()

    await vi.advanceTimersByTimeAsync(10)
    await coordinator.captureNow()

    expect(storage.writes.map(write => write.envelope.draftRevision)).toEqual([1, 2])
    expect(coordinator.hasCommittedCurrentValues).toBe(true)
    expect(coordinator.view).toEqual({
      state: 'local',
      candidate: null,
      candidates: [],
      committed: true,
      submissionCandidates: [],
      inFlight: false,
      error: null
    })
    expect(storage.records.size).toBe(1)
    coordinator.destroy()
  })

  it('rewraps a same-owner ordinary draft after a generation-only identity boundary', async () => {
    const storage = new InMemoryDraftStorage()
    const writer = makeCoordinator({
      storage,
      owner: ownerKey(7),
      currentValues: () => values('retained across the identity fence')
    }).coordinator
    await expect(writer.captureNow({ force: true })).resolves.toBe(true)
    const oldEnvelope = cloneEnvelope([...storage.records.values()][0]!)
    writer.destroy()

    storage.generation = SESSION_GENERATION + 1
    invalidateOfflineSession()
    const reader = makeCoordinator({
      storage,
      owner: ownerKey(7),
      currentValues: () => values('server text')
    }).coordinator

    const recovered = await reader.initialize()
    expect(recovered.candidate?.payload.content).toBe('retained across the identity fence')
    expect(storage.records.get(oldEnvelope.recordId)?.sessionGeneration).toBe(storage.generation)
    reader.destroy()
  })

  it('surfaces recovery only with a verified owner key and never recovers cross-owner ciphertext', async () => {
    const storage = new InMemoryDraftStorage()
    const ownerSeven = ownerKey(7)
    const ownerEight = ownerKey(8)

    const foreignValues = values('owner seven private text')
    const foreignWriter = makeCoordinator({ storage, owner: ownerSeven, currentValues: () => foreignValues }).coordinator
    await expect(foreignWriter.captureNow({ force: true })).resolves.toBe(true)
    const foreignRecord = cloneEnvelope([...storage.records.values()][0]!)
    foreignWriter.destroy()
    invalidateOfflineSession()

    // Spoofing clear selectors must not make ciphertext encrypted for account 7 recoverable by account 8.
    storage.records.set(foreignRecord.recordId, { ...foreignRecord, accountId: ownerEight.context.accountId })

    const ownedValues = values('owner eight private text')
    const ownedWriter = makeCoordinator({ storage, owner: ownerEight, currentValues: () => ownedValues }).coordinator
    await expect(ownedWriter.captureNow({ force: true })).resolves.toBe(true)
    const ownedRecordId = [...storage.records.values()].find(
      record => record.accountId === ownerEight.context.accountId && record.recordId !== foreignRecord.recordId
    )?.recordId
    expect(ownedRecordId).toBeDefined()
    ownedWriter.destroy()
    invalidateOfflineSession()

    const readerValues = values('editor currently differs')
    let servedOwner = ownerSeven
    const reader = makeCoordinator({
      storage,
      owner: ownerEight,
      accountId: ownerEight.context.accountId,
      fetchOwner: () => servedOwner,
      currentValues: () => readerValues
    }).coordinator

    const unverified = await reader.initialize()
    expect(unverified).toEqual({
      state: null,
      candidate: null,
      candidates: [],
      committed: false,
      submissionCandidates: [],
      inFlight: false,
      error: 'A verified connection is required to recover local drafts.'
    })

    servedOwner = ownerEight
    invalidateOfflineSession()
    const verified = await reader.initialize()
    expect(verified.candidate?.recordId).toBe(ownedRecordId)
    expect(verified.candidate?.payload.content).toBe('owner eight private text')
    expect(verified.candidate?.recordId).not.toBe(foreignRecord.recordId)
    expect(verified.state).toBe('local')
    expect(verified.error).toBeNull()
    reader.destroy()
  })

  it('freezes an exact receipt, atomically finalizes it, and preserves a later fork for a fresh consumer', async () => {
    const storage = new InMemoryDraftStorage()
    let current = values('text captured before publish')
    let editorIdentity = identity()
    const { coordinator } = makeCoordinator({
      storage,
      owner: ownerKey(7),
      currentValues: () => current,
      currentIdentity: () => editorIdentity
    })

    const submission = await coordinator.prepareSubmission()
    expect(submission).not.toBeNull()
    if (!submission) throw new Error('Expected an immutable submission receipt')
    const storedBeforePublish = cloneEnvelope(storage.records.get(submission.recordId)!)
    expect(Object.isFrozen(submission)).toBe(true)
    expect(Object.isFrozen(submission.envelope)).toBe(true)
    expect(Object.isFrozen(submission.payload)).toBe(true)
    expect(storedBeforePublish).toEqual(submission.envelope)
    expect(storedBeforePublish.submissionId).toBe(submission.submissionId)
    expect(storedBeforePublish.draftRevision).toBe(submission.draftRevision)
    expect(coordinator.view).toMatchObject({
      state: 'publishing',
      committed: true,
      submissionCandidates: [],
      inFlight: false,
      error: null
    })

    current = values('text edited after receipt creation')
    coordinator.scheduleCapture()
    await coordinator.captureNow()
    expect(storage.records.get(submission.recordId)).toEqual(storedBeforePublish)
    editorIdentity = identity(43)
    await expect(coordinator.captureNow({ force: true })).resolves.toBe(true)

    await expect(coordinator.completeSubmission(submission, { kind: 'success', identity: editorIdentity })).resolves.toBe(true)
    const expectedFork = storage.writes
      .filter(write => write.envelope.submissionId === null && write.envelope.recordId !== submission.sourceEnvelope?.recordId)
      .map(write => write.envelope)
      .pop()
    expect(expectedFork).toBeDefined()
    expect(storage.deletes).toHaveLength(0)
    expect(storage.finalizations).toHaveLength(1)
    const finalization = storage.finalizations[0]!
    expect(finalization.options.expectedReceipt).toEqual(storedBeforePublish)
    expect(finalization.options.expectedSource).toEqual(submission.sourceEnvelope)
    expect(finalization.options.expectedSurvivingFork).toEqual(expectedFork)
    expect(finalization.options.survivingFork).toBeDefined()
    expect(finalization.options.survivingFork?.recordId).toBe(expectedFork?.recordId)
    expect(finalization.options.survivingFork?.draftRevision).toBeGreaterThan(expectedFork?.draftRevision ?? 0)
    expect(finalization.result).toMatchObject({ receiptDeleted: true, sourceDeleted: true })
    expect(storage.records.has(submission.recordId)).toBe(false)
    const survivingFork = [...storage.records.values()].find(record => record.submissionId === null)
    expect(survivingFork).toBeDefined()
    expect(survivingFork?.draftRevision).toBeGreaterThan(submission.draftRevision)
    expect(coordinator.hasCommittedCurrentValues).toBe(true)
    expect(coordinator.view).toMatchObject({ state: 'local', candidate: null, committed: true, inFlight: false, error: null })
    coordinator.destroy()
    invalidateOfflineSession()

    const reader = makeCoordinator({
      storage,
      owner: ownerKey(7),
      currentValues: () => values('server version'),
      currentIdentity: () => identity(43)
    }).coordinator
    const recovered = await reader.initialize()
    expect(recovered.candidate?.payload.content).toBe('text edited after receipt creation')
    expect(recovered.candidate?.payload.state).toBe('local')
    reader.destroy()
  })

  it('captures a later edit before finalizing a known post-write failure', async () => {
    const storage = new InMemoryDraftStorage()
    let current = values('text captured before publish')
    const { coordinator } = makeCoordinator({
      storage,
      owner: ownerKey(7),
      currentValues: () => current
    })

    const submission = await coordinator.prepareSubmission()
    expect(submission).not.toBeNull()
    if (!submission) throw new Error('Expected an immutable submission receipt')

    current = values('text edited while the known write was finishing')
    await expect(
      coordinator.completeSubmission(submission, {
        kind: 'post-write',
        status: 200,
        reason: 'visibility refresh failed'
      })
    ).resolves.toBe(true)

    expect(storage.records.has(submission.recordId)).toBe(false)
    expect(storage.finalizations).toHaveLength(1)
    expect(storage.finalizations[0]?.result.survivingFork).toBeDefined()
    coordinator.destroy()
    invalidateOfflineSession()

    const reader = makeCoordinator({
      storage,
      owner: ownerKey(7),
      currentValues: () => values('server version')
    }).coordinator
    const recovered = await reader.initialize()
    expect(recovered.candidate?.payload.content).toBe('text edited while the known write was finishing')
    reader.destroy()
  })

  it('keeps a forbidden resource unavailable across later local captures', async () => {
    const storage = new InMemoryDraftStorage()
    let current = values('resource was rejected')
    const { coordinator } = makeCoordinator({
      storage,
      owner: ownerKey(7),
      currentValues: () => current
    })

    const submission = await coordinator.prepareSubmission()
    expect(submission).not.toBeNull()
    if (!submission) throw new Error('Expected an immutable submission receipt')
    await expect(coordinator.completeSubmission(submission, { kind: 'rejected', status: 403, reason: 'forbidden' })).resolves.toBe(true)
    expect(coordinator.view.state).toBe('unavailable')

    current = values('edited while the resource remains unavailable')
    await expect(coordinator.captureNow({ force: true })).resolves.toBe(true)
    coordinator.destroy()
    invalidateOfflineSession()

    const reader = makeCoordinator({
      storage,
      owner: ownerKey(7),
      currentValues: () => values('server version')
    }).coordinator
    const recovered = await reader.initialize()
    expect(recovered.candidate?.payload.content).toBe('edited while the resource remains unavailable')
    expect(recovered.candidate?.payload.state).toBe('unavailable')
    reader.destroy()
  })

  it('serializes a 403 unavailable capture after an in-flight autosave at the same version', async () => {
    const storage = new InMemoryDraftStorage()
    const { coordinator } = makeCoordinator({
      storage,
      owner: ownerKey(7),
      currentValues: () => values('autosaved before the response')
    })

    const autosave = coordinator.captureThrough(1)
    const unavailable = coordinator.captureNow({ force: true, state: 'unavailable', editVersion: 1 })
    expect(unavailable).not.toBe(autosave)
    await expect(autosave).resolves.toBe(true)
    await expect(unavailable).resolves.toBe(true)
    expect(coordinator.view.state).toBe('unavailable')

    coordinator.destroy()
    invalidateOfflineSession()
  })

  it('latches unavailable when that capture cannot persist and preserves it on the next capture', async () => {
    const storage = new InMemoryDraftStorage()
    let current = values('local before the forbidden response')
    const { coordinator } = makeCoordinator({
      storage,
      owner: ownerKey(7),
      currentValues: () => current
    })

    await expect(coordinator.captureNow({ force: true })).resolves.toBe(true)
    storage.failNextPut = true
    current = values('forbidden response could not be persisted')
    await expect(coordinator.captureNow({ force: true, state: 'unavailable' })).resolves.toBe(false)
    expect(coordinator.view.state).toBe('unavailable')

    storage.conflictNextPut = true
    current = values('conflict after unavailable response')
    await expect(coordinator.captureNow({ force: true })).resolves.toBe(false)
    expect(coordinator.view.state).toBe('unavailable')

    current = values('later local edit remains unavailable')
    await expect(coordinator.captureNow({ force: true })).resolves.toBe(true)
    expect(coordinator.view.state).toBe('unavailable')
    const writesBeforeReconnect = storage.writes.length
    await expect(coordinator.markReconnected()).resolves.toBe(true)
    expect(coordinator.view.state).toBe('unavailable')
    expect(storage.writes).toHaveLength(writesBeforeReconnect)
    coordinator.destroy()
    invalidateOfflineSession()
    const reader = makeCoordinator({
      storage,
      owner: ownerKey(7),
      currentValues: () => current
    }).coordinator
    await expect(reader.initialize()).resolves.toMatchObject({ state: 'unavailable' })
    reader.destroy()
  })

  it('atomically replaces a known 409 rejection with an actionable conflict draft for a fresh consumer', async () => {
    const storage = new InMemoryDraftStorage()
    const { coordinator } = makeCoordinator({ storage, owner: ownerKey(7), currentValues: () => values('conflicting publish') })

    const submission = await coordinator.prepareSubmission()
    expect(submission).not.toBeNull()
    if (!submission) throw new Error('Expected an immutable submission receipt')
    await expect(coordinator.completeSubmission(submission, { kind: 'rejected', status: 409, reason: 'conflict' })).resolves.toBe(true)

    expect(storage.deletes).toHaveLength(0)
    expect(storage.finalizations).toHaveLength(1)
    expect(storage.finalizations[0]?.options.expectedReceipt).toEqual(submission.envelope)
    expect(storage.finalizations[0]?.options.expectedSource).toEqual(submission.sourceEnvelope)
    expect(storage.finalizations[0]?.options.expectedSurvivingFork).toBeNull()
    expect(storage.finalizations[0]?.options.survivingFork).toBeDefined()
    expect(storage.records.has(submission.recordId)).toBe(false)
    const conflictDraft = [...storage.records.values()].find(record => record.submissionId === null)
    expect(conflictDraft).toBeDefined()
    expect(coordinator.view).toMatchObject({ state: 'conflict', candidate: null, committed: true, inFlight: false, error: null })
    expect(coordinator.view.submissionCandidates).toHaveLength(0)
    coordinator.destroy()
    invalidateOfflineSession()

    const reader = makeCoordinator({
      storage,
      owner: ownerKey(7),
      currentValues: () => values('server version')
    }).coordinator
    const recovered = await reader.initialize()
    expect(recovered.candidate?.payload.content).toBe('conflicting publish')
    expect(recovered.candidate?.payload.state).toBe('conflict')
    expect(recovered.state).toBe('conflict')
    reader.destroy()
  })

  it('retains an exact outcome-unknown receipt and performs no automatic replay', async () => {
    const storage = new InMemoryDraftStorage()
    const owner = ownerKey(7)
    let current = values('transport-uncertain publish')
    const { coordinator, fetchCalls } = makeCoordinator({ storage, owner, currentValues: () => current })

    const submission = await coordinator.prepareSubmission()
    expect(submission).not.toBeNull()
    if (!submission) throw new Error('Expected an immutable submission receipt')
    const receiptBeforeOutcome = cloneEnvelope(storage.records.get(submission.recordId)!)

    await expect(coordinator.completeSubmission(submission, { kind: 'unknown', status: 503, reason: 'transport lost' })).resolves.toBe(true)
    const retained = storage.records.get(submission.recordId)
    expect(retained).toBeDefined()
    expect(retained?.submissionId).toBe(submission.submissionId)
    expect(retained?.draftRevision).toBe(submission.draftRevision)
    expect(retained).toEqual(receiptBeforeOutcome)
    expect(storage.deletes).toHaveLength(0)
    expect(storage.finalizations).toHaveLength(0)
    expect(storage.records.size).toBe(2)
    expect(coordinator.view).toMatchObject({ state: 'outcome-unknown', candidate: null, committed: true, inFlight: false })
    expect(coordinator.view.submissionCandidates).toHaveLength(1)
    expect(fetchCalls.count).toBe(1)

    current = values('must not be replayed automatically')
    expect(coordinator.hasInFlightWork).toBe(false)
    expect(storage.records.get(submission.recordId)).toEqual(receiptBeforeOutcome)
    expect(storage.finalizations).toHaveLength(0)
    coordinator.destroy()
  })
  it('locks on logout and clears all recovery metadata while retaining the opaque stored record', async () => {
    const storage = new InMemoryDraftStorage()
    const owner = ownerKey(7)
    const writer = makeCoordinator({ storage, owner, currentValues: () => values('saved secret metadata') }).coordinator
    await expect(writer.captureNow({ force: true })).resolves.toBe(true)
    writer.destroy()
    invalidateOfflineSession()

    const reader = makeCoordinator({ storage, owner, currentValues: () => values('different live editor text') }).coordinator
    const initialized = await reader.initialize()
    expect(initialized.candidate?.payload.content).toBe('saved secret metadata')
    expect(reader.hasCommittedDraft).toBe(true)

    reader.lock()
    expect(reader.view).toEqual({
      state: 'locked',
      candidate: null,
      candidates: [],
      submissionCandidates: [],
      committed: false,
      inFlight: false,
      error: null
    })
    expect(reader.candidate).toBeNull()
    expect(reader.hasCommittedDraft).toBe(false)
    expect(reader.hasCommittedCurrentValues).toBe(false)
    expect(storage.records.size).toBe(1)
    reader.destroy()
  })
})
