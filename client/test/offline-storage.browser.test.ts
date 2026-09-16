import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from '../../server/test/bun-test.mts'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { chromium, type Browser, type Page } from 'playwright-core'
import {
  OFFLINE_KEY_VERSION,
  type OfflineDraftEnvelopeV1,
  type OfflinePageSnapshotV1
} from '../../shared/offline.ts'

const storagePath = fileURLToPath(new URL('../helpers/offline-storage.ts', import.meta.url))
const sessionPath = fileURLToPath(new URL('../helpers/offline-session.ts', import.meta.url))
const executablePath = process.env.CHROME_BIN ?? '/usr/bin/google-chrome'
const capturedAt = '2026-09-01T00:00:00.000Z'

type Outcome =
  | { ok: true; value: unknown }
  | { ok: false; error: { name: string; code?: string; message: string } }

type SnapshotDump = {
  meta: Record<string, unknown> | undefined
  policy: Array<Record<string, unknown>>
  snapshots: Array<Record<string, unknown>>
  searchDocuments: Array<Record<string, unknown>>
  drafts: Array<Record<string, unknown>>
}

type StorageEstimate = {
  managedBytes: number
  snapshotCount: number
  policyPageCount: number
  lockedDraftCount: number
  sessionGeneration: number
  policyRevision: number
}

const makeSnapshot = (locale = 'en', pageId = 42, overrides: Partial<OfflinePageSnapshotV1> = {}): OfflinePageSnapshotV1 => ({
  schemaVersion: 1,
  pageId,
  locale,
  path: `docs/${locale}/${pageId}`,
  canonicalPath: `docs/${locale}/${pageId}`,
  title: `Page ${locale}`,
  description: `Description ${locale}`,
  sourceRevision: `revision-${locale}`,
  capturedAt,
  expiresAt: null,
  content: {
    representation: 'sanitized-html-fragment',
    sanitizerVersion: 'offline-html-allowlist-v1',
    html: `<p>${locale} ${pageId}</p>`
  },
  searchText: `search ${locale}`,
  contentType: 'sanitized-html-fragment',
  integrity: `sha256:${locale}-${pageId}`,
  ...overrides
})

const makeLegacySnapshotRecord = (siteId: string, snapshot: OfflinePageSnapshotV1): Record<string, unknown> => {
  const withoutSize = {
    siteId,
    pageId: snapshot.pageId,
    locale: snapshot.locale,
    snapshot,
    lastOpenedAt: capturedAt
  }
  return {
    ...withoutSize,
    byteSize: new TextEncoder().encode(JSON.stringify(withoutSize)).byteLength
  }
}

const makeEnvelope = (recordId: string, options: {
  generation?: number
  revision?: number
  submissionId?: string | null
  seed?: number
  accountId?: number
} = {}): OfflineDraftEnvelopeV1 => {
  const seed = options.seed ?? recordId.length
  return {
    schemaVersion: 1,
    recordId,
    accountId: options.accountId ?? 1,
    authVersion: 1,
    keyVersion: OFFLINE_KEY_VERSION,
    sessionGeneration: options.generation ?? 0,
    draftRevision: options.revision ?? 1,
    submissionId: options.submissionId ?? null,
    nonce: Uint8Array.from({ length: 12 }, (_value, index) => (seed + index) & 0xff),
    ciphertext: Uint8Array.from({ length: 24 }, (_value, index) => (seed + index * 3) & 0xff)
  }
}

const draftLogicalBytes = (envelope: OfflineDraftEnvelopeV1): number => {
  const metadata = {
    schemaVersion: envelope.schemaVersion,
    recordId: envelope.recordId,
    accountId: envelope.accountId,
    authVersion: envelope.authVersion,
    keyVersion: envelope.keyVersion,
    sessionGeneration: envelope.sessionGeneration,
    draftRevision: envelope.draftRevision,
    submissionId: envelope.submissionId,
    nonceBytes: envelope.nonce.byteLength,
    ciphertextBytes: envelope.ciphertext.byteLength
  }
  return new TextEncoder().encode(JSON.stringify(metadata)).byteLength + envelope.nonce.byteLength + envelope.ciphertext.byteLength
}

const policyLogicalBytes = (record: Record<string, unknown>): number => {
  const { byteSize: _byteSize, ...withoutSize } = record
  return new TextEncoder().encode(JSON.stringify(withoutSize)).byteLength
}

const policyManagedBytes = (dump: SnapshotDump): number =>
  dump.policy.reduce((total, record) => total + policyLogicalBytes(record), 0)


const bytes = (value: unknown): number[] => Array.isArray(value) ? value.map(item => Number(item)) : []
const driverSource = (absoluteStoragePath: string, absoluteSessionPath: string): string => `
import { openOfflineStorage, type OfflineStorage } from ${JSON.stringify(absoluteStoragePath)};
import {
  invalidateOfflineSession,
  registerOfflineIdentityBoundaryOwner,
  requestDraftKey
} from ${JSON.stringify(absoluteSessionPath)};

type RawHandle = IDBDatabase;
const handles = new Map<string, OfflineStorage>();
const rawHolds = new Map<string, RawHandle>();
const stores = ['meta', 'snapshots', 'drafts', 'searchDocuments', 'policy'];
const legacyStores = ['meta', 'snapshots', 'drafts', 'searchDocuments'];
let boundaryDatabaseName: string | undefined;
registerOfflineIdentityBoundaryOwner(async request => {
  if (
    boundaryDatabaseName === undefined ||
    (request.reason !== 'draft-key-denied' && request.reason !== 'unauthorized')
  )
    return false;
  invalidateOfflineSession();
  const storage = await openOfflineStorage({ databaseName: boundaryDatabaseName });
  try {
    const currentGeneration = await storage.currentSessionGeneration();
    await storage.bumpSessionGeneration(undefined, { expectedSessionGeneration: currentGeneration });
    return true;
  } catch {
    return false;
  } finally {
    storage.close();
  }
});

const requestValue = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
});
const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
  transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
});
const openDatabase = (name: string, version?: number, upgrade?: (database: IDBDatabase, transaction: IDBTransaction) => void): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
  request.onupgradeneeded = () => {
    if (upgrade && request.transaction) upgrade(request.result, request.transaction);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened.'));
  request.onblocked = () => reject(new Error('IndexedDB open was blocked.'));
});
const createStores = (database: IDBDatabase): void => {
  if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta', { keyPath: 'key' });
  if (!database.objectStoreNames.contains('snapshots')) {
    const store = database.createObjectStore('snapshots', { keyPath: ['siteId', 'pageId', 'locale'] });
    store.createIndex('by-site', 'siteId');
  }
  if (!database.objectStoreNames.contains('drafts')) {
    const store = database.createObjectStore('drafts', { keyPath: 'recordId' });
    store.createIndex('by-account', 'accountId');
  }
  if (!database.objectStoreNames.contains('searchDocuments')) {
    const store = database.createObjectStore('searchDocuments', { keyPath: ['siteId', 'pageId', 'locale'] });
    store.createIndex('by-site', 'siteId');
  }
};
const legacyMeta = () => ({
  key: 'state',
  schemaVersion: 1,
  sessionGeneration: 0,
  lastCleanupAt: null,
  storage: { usageBytes: null, quotaBytes: null, persisted: null, persistenceRequested: false }
});
const byteValues = (value: unknown): number[] => {
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(item => Number(item));
  return [];
};
const normalizeEnvelope = (value: Record<string, unknown>): Record<string, unknown> => ({
  ...value,
  nonce: new Uint8Array(byteValues(value.nonce)),
  ciphertext: new Uint8Array(byteValues(value.ciphertext))
});
const seedLegacy = async (
  name: string,
  value: Record<string, unknown>,
  corrupt: boolean,
  snapshot?: Record<string, unknown>
): Promise<void> => {
  const database = await openDatabase(name, 1, (db, transaction) => {
    createStores(db);
    transaction.objectStore('meta').put(legacyMeta());
  });
  const transaction = database.transaction(legacyStores, 'readwrite');
  transaction.objectStore('drafts').put(normalizeEnvelope(value));
  if (snapshot !== undefined) transaction.objectStore('snapshots').put(snapshot);
  if (corrupt) transaction.objectStore('drafts').put({ recordId: 'opaque-row', accountId: 1, ciphertext: new Uint8Array([4, 5, 6]) });
  await transactionDone(transaction);
  database.close();
};
const putOpaque = async (name: string): Promise<void> => {
  const database = await openDatabase(name);
  const transaction = database.transaction('drafts', 'readwrite');
  transaction.objectStore('drafts').put({ recordId: 'opaque-boundary-row', accountId: 1, ciphertext: new Uint8Array([7, 8, 9]) });
  await transactionDone(transaction);
  database.close();
};
const seedUnknownMeta = async (name: string): Promise<void> => {
  const database = await openDatabase(name, 2, (db) => createStores(db));
  const transaction = database.transaction('meta', 'readwrite');
  transaction.objectStore('meta').put({
    key: 'state', schemaVersion: 99, sessionGeneration: 4, managedBytes: 12, snapshotCount: 3, corpusRevision: 8,
    accountingComplete: true, lastCleanupAt: null,
    storage: { usageBytes: null, quotaBytes: null, persisted: null, persistenceRequested: false }
  });
  await transactionDone(transaction);
  database.close();
};
const holdLegacy = async (name: string): Promise<void> => {
  const database = await openDatabase(name, 1, (db, transaction) => {
    createStores(db);
    transaction.objectStore('meta').put(legacyMeta());
  });
  rawHolds.set(name, database);
};
const closeRawHold = (name: string): void => {
  rawHolds.get(name)?.close();
  rawHolds.delete(name);
};
const serialise = (value: unknown): unknown => {
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
    return Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (Array.isArray(value)) return value.map(serialise);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialise(item)]));
  return value;
};
const dump = async (name: string): Promise<unknown> => {
  const database = await openDatabase(name);
  const transaction = database.transaction(stores, 'readonly');
  const [meta, policy, snapshots, searchDocuments, drafts] = await Promise.all([
    requestValue(transaction.objectStore('meta').get('state')),
    requestValue(transaction.objectStore('policy').getAll()),
    requestValue(transaction.objectStore('snapshots').getAll()),
    requestValue(transaction.objectStore('searchDocuments').getAll()),
    requestValue(transaction.objectStore('drafts').getAll())
  ]);
  await transactionDone(transaction);
  database.close();
  return serialise({ meta, policy, snapshots, searchDocuments, drafts });
};
const deleteDatabase = (name: string): Promise<void> => new Promise((resolve, reject) => {
  const request = indexedDB.deleteDatabase(name);
  request.onsuccess = () => resolve();
  request.onerror = () => reject(request.error ?? new Error('IndexedDB delete failed.'));
  request.onblocked = () => reject(new Error('IndexedDB delete was blocked.'));
});
const openHandle = async (id: string, name: string, blockedTimeoutMs?: number): Promise<number | null> => {
  handles.get(id)?.close();
  handles.delete(id);
  const storage = await openOfflineStorage({ databaseName: name, ...(blockedTimeoutMs === undefined ? {} : { blockedTimeoutMs }) });
  handles.set(id, storage);
  return storage.hasUnsupportedSchema ? null : await storage.currentSessionGeneration();
};
const storageFor = (id: unknown): OfflineStorage => {
  const storage = typeof id === 'string' ? handles.get(id) : undefined;
  if (!storage) throw new Error('Unknown storage handle.');
  return storage;
};
const errorResult = (error: unknown): { ok: false; error: { name: string; code?: string; message: string; cause?: string } } => {
  const value = error as { name?: unknown; code?: unknown; message?: unknown; cause?: { name?: unknown; message?: unknown } };
  const cause = value.cause && typeof value.cause.message === 'string' ? String(value.cause.name ?? 'Error') + ': ' + value.cause.message : undefined;
  return { ok: false, error: {
    name: typeof value.name === 'string' ? value.name : 'Error',
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    message: typeof value.message === 'string' ? value.message : String(error),
    ...(cause === undefined ? {} : { cause })
  } };
};
export async function run(operation: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  try {
    if (operation === 'seedLegacy') { await seedLegacy(String(payload.name), payload.draft as Record<string, unknown>, payload.corrupt === true, payload.snapshot as Record<string, unknown> | undefined); return { ok: true, value: { seeded: true } }; }
    if (operation === 'putOpaque') { await putOpaque(String(payload.name)); return { ok: true, value: { seeded: true } }; }
    if (operation === 'seedUnknownMeta') { await seedUnknownMeta(String(payload.name)); return { ok: true, value: { seeded: true } }; }
    if (operation === 'holdLegacy') { await holdLegacy(String(payload.name)); return { ok: true, value: { held: true } }; }
    if (operation === 'release') { closeRawHold(String(payload.name)); return { ok: true, value: { released: true } }; }
    if (operation === 'deleteDatabase') { await deleteDatabase(String(payload.name)); return { ok: true, value: { deleted: true } }; }
    if (operation === 'dump') return { ok: true, value: await dump(String(payload.name)) };
    if (operation === 'open') return { ok: true, value: await openHandle(String(payload.id), String(payload.name), typeof payload.blockedTimeoutMs === 'number' ? payload.blockedTimeoutMs : undefined) };
    if (operation === 'close') { handles.get(String(payload.id))?.close(); handles.delete(String(payload.id)); return { ok: true, value: true }; }
    if (operation === 'terminate') { storageFor(payload.id).markTerminated(); return { ok: true, value: true }; }
    if (operation === 'denyKey') {
      boundaryDatabaseName = String(payload.name);
      const frame = new Uint8Array(Array.isArray(payload.frame) ? payload.frame.map(value => Number(value)) : [0]);
      const fetchImpl = async (): Promise<Response> =>
        new Response(frame, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      try {
        await requestDraftKey(fetchImpl as typeof window.fetch, {
          expectedAccountId: Number(payload.accountId),
          expectedSessionGeneration: Number(payload.sessionGeneration)
        });
        return { ok: true, value: { unexpected: true } };
      } catch (error) {
        return errorResult(error);
      }
    }
    if (operation === 'isClosed') return { ok: true, value: storageFor(payload.id).isClosed };
    if (operation === 'bump') return { ok: true, value: await storageFor(payload.id).bumpSessionGeneration(undefined, payload.options as never) };
    if (operation === 'putSnapshot') return { ok: true, value: await storageFor(payload.id).putSnapshot(String(payload.siteId), payload.snapshot as never, payload.options as never) };
    if (operation === 'setManual') return { ok: true, value: await storageFor(payload.id).setManualOfflineIntent(payload.selector as never, payload.selected as boolean, payload.options as never) };
    if (operation === 'removeOffline') return { ok: true, value: await storageFor(payload.id).removeOfflinePage(payload.selector as never, payload.options as never) };
    if (operation === 'delete') return { ok: true, value: await storageFor(payload.id).deleteDraft(String(payload.recordId), payload.options as never) };
    if (operation === 'removeSnapshot') { await storageFor(payload.id).removeSnapshot(String(payload.siteId), Number(payload.pageId), typeof payload.locale === 'string' ? payload.locale : undefined, payload.options as never); return { ok: true, value: true }; }
    if (operation === 'listSnapshots') return { ok: true, value: await storageFor(payload.id).listSnapshots(String(payload.siteId)) };
    if (operation === 'search') return { ok: true, value: await storageFor(payload.id).searchDocuments(String(payload.siteId)) };
    if (operation === 'estimate') return { ok: true, value: await storageFor(payload.id).storageEstimate() };
    if (operation === 'putDraft') return { ok: true, value: await storageFor(payload.id).putDraft(payload.envelope as never, payload.options as never) };
    if (operation === 'deleteRaw') return { ok: true, value: await storageFor(payload.id).deleteDraftRaw(String(payload.recordId)) };
    if (operation === 'recover') return { ok: true, value: await storageFor(payload.id).recoverOrdinaryDraft(payload.expectedEnvelope as never, payload.replacementEnvelope as never, payload.options as never) };
    if (operation === 'recoverAbort') {
      const storage = storageFor(payload.id)
      const result = storage.recoverOrdinaryDraft(payload.expectedEnvelope as never, payload.replacementEnvelope as never, payload.options as never)
      storage.close()
      return { ok: true, value: await result }
    }
    if (operation === 'rewrap') return { ok: true, value: await storageFor(payload.id).rewrapSubmission(payload.expectedEnvelope as never, payload.replacementEnvelope as never, payload.options as never) };
    if (operation === 'rewrapAbort') {
      const storage = storageFor(payload.id)
      const result = storage.rewrapSubmission(payload.expectedEnvelope as never, payload.replacementEnvelope as never, payload.options as never)
      storage.close()
      return { ok: true, value: await result }
    }
    if (operation === 'invalidateAccount') return { ok: true, value: await storageFor(payload.id).invalidateAccountSession(Number(payload.accountId), payload.options as never) };
    if (operation === 'finalize') return { ok: true, value: await storageFor(payload.id).finalizeSubmission(payload.options as never) };
    if (operation === 'clear') {
      if (payload.confirmed !== true) return { ok: true, value: { cancelled: true, generation: await storageFor(payload.id).currentSessionGeneration() } };
      return { ok: true, value: { cancelled: false, generation: await storageFor(payload.id).clearDeviceData() } };
    }
    if (operation === 'cleanup') {
      for (const storage of handles.values()) storage.close();
      handles.clear();
      for (const database of rawHolds.values()) database.close();
      rawHolds.clear();
      for (const name of (Array.isArray(payload.names) ? payload.names : [])) await deleteDatabase(String(name));
      return { ok: true, value: true };
    }
    throw new Error('Unknown driver operation.');
  } catch (error) {
    return errorResult(error);
  }
}
`

let tempDirectory: string
let browser: Browser
let page: Page
let driverURL: string
const databaseNames = new Set<string>()

const invoke = async (operation: string, payload: Record<string, unknown> = {}): Promise<Outcome> => {
  return await page.evaluate(async ({ moduleURL, operationName, operationPayload }) => {
    // The test server URL is runtime-selected so the production adapter executes in a real browser origin.
    const driver = await import(moduleURL) as { run: (name: string, value: Record<string, unknown>) => Promise<unknown> }
    return await driver.run(operationName, operationPayload) as Outcome
  }, { moduleURL: driverURL, operationName: operation, operationPayload: payload })
}

const succeeded = async <Value,>(operation: string, payload: Record<string, unknown> = {}): Promise<Value> => {
  const outcome = await invoke(operation, payload)
  expect(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome)).toBe(true)
  if (!outcome.ok) throw new Error(outcome.error.message)
  return outcome.value as Value
}

const failedWith = async (operation: string, payload: Record<string, unknown>, code: string): Promise<void> => {
  const outcome = await invoke(operation, payload)
  expect(outcome.ok).toBe(false)
  if (outcome.ok) return
  expect(outcome.error.code).toBe(code)
}

const freshDatabase = (prefix: string): string => {
  const name = `offline-adapter-${prefix}-${crypto.randomUUID()}`
  databaseNames.add(name)
  return name
}

const readDump = async (name: string): Promise<SnapshotDump> => await succeeded<SnapshotDump>('dump', { name })

beforeAll(async () => {
  tempDirectory = await mkdtemp(`${tmpdir()}/tsepistle-offline-storage-`)
  const entry = `${tempDirectory}/browser-entry.ts`
  await Bun.write(entry, driverSource(storagePath, sessionPath))
  const build = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', sourcemap: 'none' })
  if (!build.success) throw new Error(build.logs.map(log => log.message).join('\n'))
  const output = await build.outputs[0]!.text()
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/adapter.js') return new Response(output, { headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' } })
      return new Response('<!doctype html><title>offline adapter test</title>', { headers: { 'content-type': 'text/html' } })
    }
  })
  driverURL = `${server.url}adapter.js`
  browser = await chromium.launch({ headless: true, executablePath, chromiumSandbox: false })
  page = await browser.newPage()
  await page.goto(`${server.url}blank`, { waitUntil: 'load' })
  ;(globalThis as Record<string, unknown>).__offlineAdapterTestServer = server
})

beforeEach(() => {
  databaseNames.clear()
})

afterEach(async () => {
  if (page) await invoke('cleanup', { names: Array.from(databaseNames) })
  databaseNames.clear()
})

afterAll(async () => {
  try {
    if (page) await page.close()
    if (browser) await browser.close()
  } finally {
    const server = (globalThis as Record<string, unknown>).__offlineAdapterTestServer as { stop: (closeActiveConnections?: boolean) => void } | undefined
    server?.stop(true)
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true })
  }
})

describe('real IndexedDB offline storage adapter', () => {
  test('upgrades physical v1 to v2 without changing encrypted envelope bytes and marks migrated snapshots manual', async () => {
    const name = freshDatabase('upgrade')
    const envelope = makeEnvelope('legacy-draft', { seed: 19 })
    const snapshot = makeSnapshot('legacy', 7)
    const legacySnapshot = makeLegacySnapshotRecord('legacy-site', snapshot)
    await succeeded('seedLegacy', { name, draft: envelope, snapshot: legacySnapshot })
    await succeeded('open', { id: 'legacy', name })
    const dump = await readDump(name)
    expect(dump.meta?.schemaVersion).toBe(1)
    expect(dump.meta?.sessionGeneration).toBe(0)
    expect(dump.drafts).toHaveLength(1)
    expect(bytes(dump.drafts[0]?.nonce)).toEqual(Array.from(envelope.nonce))
    expect(bytes(dump.drafts[0]?.ciphertext)).toEqual(Array.from(envelope.ciphertext))
    expect(dump.snapshots).toHaveLength(1)
    expect(dump.snapshots[0]?.snapshot).toEqual(snapshot)
    expect(dump.policy.filter(record => record.recordType === 'page')).toHaveLength(1)
    expect(dump.policy.find(record => record.recordType === 'page')).toMatchObject({
      siteId: 'legacy-site',
      pageId: 7,
      locale: 'legacy',
      manual: true,
      automatic: false,
      tag: false,
      availability: 'available'
    })
  })

  test('serializes generation changes across two real connections and fences stale writers after clear', async () => {
    const name = freshDatabase('generation')
    await succeeded('open', { id: 'first', name })
    await succeeded('open', { id: 'second', name })
    const results = await Promise.all([
      invoke('bump', { id: 'first' }),
      invoke('bump', { id: 'second' })
    ])
    expect(results.every(result => result.ok)).toBe(true)
    expect(results.map(result => result.ok ? result.value : null).sort()).toEqual([1, 2])
    const draft = makeEnvelope('stale-draft', { generation: 0 })
    await succeeded('open', { id: 'stale', name })
    await failedWith('putDraft', { id: 'stale', envelope: draft }, 'generation-fenced')
    const clearResult = await succeeded<{ cancelled: boolean; generation: number }>('clear', { id: 'second', confirmed: true })
    expect(clearResult).toEqual({ cancelled: false, generation: 3 })
    await failedWith('putDraft', { id: 'first', envelope: makeEnvelope('after-clear', { generation: 2 }) }, 'generation-fenced')
  })

  test('advances generation without deleting ordinary or receipt rows, while logout purges ordinary drafts only', async () => {
    const name = freshDatabase('identity-boundary')
    await succeeded('open', { id: 'storage', name })
    const ordinary = makeEnvelope('ordinary', { seed: 41 })
    const receipt = makeEnvelope('receipt', { submissionId: 'submission-1', seed: 42 })
    await succeeded('putDraft', { id: 'storage', envelope: ordinary })
    await succeeded('putDraft', { id: 'storage', envelope: receipt })
    await succeeded('putOpaque', { name })

    const advanced = await succeeded<number>('bump', {
      id: 'storage',
      options: { expectedSessionGeneration: 0 }
    })
    expect(advanced).toBe(1)
    const afterKeyDenial = await readDump(name)
    expect(afterKeyDenial.meta?.sessionGeneration).toBe(1)
    expect(afterKeyDenial.drafts.map(draft => draft.recordId).sort()).toEqual(['opaque-boundary-row', 'ordinary', 'receipt'])
    expect(bytes(afterKeyDenial.drafts.find(draft => draft.recordId === 'ordinary')?.ciphertext)).toEqual(Array.from(ordinary.ciphertext))
    expect(bytes(afterKeyDenial.drafts.find(draft => draft.recordId === 'receipt')?.ciphertext)).toEqual(Array.from(receipt.ciphertext))

    await failedWith('putDraft', {
      id: 'storage',
      envelope: makeEnvelope('stale-write', { generation: 0, seed: 43 })
    }, 'generation-fenced')
    const logout = await succeeded<{
      sessionGeneration: number
      deletedCount: number
      preservedOpaqueCount: number
      preservedReceiptCount: number
    }>('invalidateAccount', {
      id: 'storage',
      accountId: 1,
      options: { expectedSessionGeneration: 1 }
    })
    expect(logout).toEqual({
      sessionGeneration: 2,
      deletedCount: 1,
      preservedOpaqueCount: 1,
      preservedReceiptCount: 1
    })
    const afterLogout = await readDump(name)
    expect(afterLogout.meta?.sessionGeneration).toBe(2)
    expect(afterLogout.drafts.map(draft => draft.recordId).sort()).toEqual(['opaque-boundary-row', 'receipt'])
    expect(bytes(afterLogout.drafts.find(draft => draft.recordId === 'receipt')?.ciphertext)).toEqual(Array.from(receipt.ciphertext))
  })

  test('advances the persisted generation after failed draft-key acquisition without deleting recovery rows', async () => {
    const name = freshDatabase('key-denied')
    await succeeded('open', { id: 'storage', name })
    const ordinary = makeEnvelope('denied-ordinary', { seed: 45 })
    const receipt = makeEnvelope('denied-receipt', { submissionId: 'submission-denied', seed: 46 })
    await succeeded('putDraft', { id: 'storage', envelope: ordinary })
    await succeeded('putDraft', { id: 'storage', envelope: receipt })

    const denied = await invoke('denyKey', {
      name,
      accountId: 1,
      sessionGeneration: 0,
      frame: [0]
    })
    expect(denied.ok).toBe(false)
    if (denied.ok) return
    expect(denied.error.name).toBe('OfflineDraftOpaqueError')

    const afterDenial = await readDump(name)
    expect(afterDenial.meta?.sessionGeneration).toBe(1)
    expect(afterDenial.drafts.map(draft => draft.recordId).sort()).toEqual(['denied-ordinary', 'denied-receipt'])
    expect(bytes(afterDenial.drafts.find(draft => draft.recordId === ordinary.recordId)?.ciphertext)).toEqual(Array.from(ordinary.ciphertext))
    expect(bytes(afterDenial.drafts.find(draft => draft.recordId === receipt.recordId)?.ciphertext)).toEqual(Array.from(receipt.ciphertext))
    await failedWith('putDraft', {
      id: 'storage',
      envelope: makeEnvelope('denied-stale-write', { generation: 0, seed: 47 })
    }, 'generation-fenced')
  })

  test('recovers ordinary drafts through the browser adapter with CAS and generation fencing', async () => {
    const name = freshDatabase('recover')
    await succeeded('open', { id: 'storage', name })
    const original = makeEnvelope('recoverable', { generation: 0, revision: 2, seed: 51 })
    const replacement = makeEnvelope('recoverable', { generation: 1, revision: 2, seed: 52 })
    await succeeded('putDraft', { id: 'storage', envelope: original })
    await succeeded('bump', { id: 'storage', options: { expectedSessionGeneration: 0 } })

    const changedEnvelope = { ...original, ciphertext: Uint8Array.from(original.ciphertext).map(value => value ^ 0xff) }
    await failedWith('recover', {
      id: 'storage',
      expectedEnvelope: changedEnvelope,
      replacementEnvelope: replacement,
      options: { expectedSessionGeneration: 1 }
    }, 'draft-conflict')
    await failedWith('recover', {
      id: 'storage',
      expectedEnvelope: original,
      replacementEnvelope: makeEnvelope('different-record', { generation: 1, revision: 2, seed: 53 }),
      options: { expectedSessionGeneration: 1 }
    }, 'invalid-record')
    await failedWith('recover', {
      id: 'storage',
      expectedEnvelope: original,
      replacementEnvelope: replacement,
      options: { expectedSessionGeneration: 0 }
    }, 'generation-fenced')

    const recovered = await succeeded<OfflineDraftEnvelopeV1>('recover', {
      id: 'storage',
      expectedEnvelope: original,
      replacementEnvelope: replacement,
      options: { expectedSessionGeneration: 1 }
    })
    expect(recovered).toMatchObject({ recordId: replacement.recordId, sessionGeneration: 1, draftRevision: replacement.draftRevision, submissionId: null })
    const afterRecovery = await readDump(name)
    expect(afterRecovery.meta?.sessionGeneration).toBe(1)
    expect(afterRecovery.drafts).toHaveLength(1)
    expect(bytes(afterRecovery.drafts[0]?.ciphertext)).toEqual(Array.from(replacement.ciphertext))
  })

  test('rewraps immutable receipts through the browser adapter with CAS and generation fencing', async () => {
    const name = freshDatabase('rewrap')
    await succeeded('open', { id: 'storage', name })
    const original = makeEnvelope('rewrap-receipt', { generation: 0, revision: 4, submissionId: 'submission-4', seed: 61 })
    const replacement = makeEnvelope('rewrap-receipt', { generation: 1, revision: 4, submissionId: 'submission-4', seed: 62 })
    await succeeded('putDraft', { id: 'storage', envelope: original })
    await succeeded('bump', { id: 'storage', options: { expectedSessionGeneration: 0 } })

    const changedEnvelope = { ...original, ciphertext: Uint8Array.from(original.ciphertext).map(value => value ^ 0xff) }
    await failedWith('rewrap', {
      id: 'storage',
      expectedEnvelope: changedEnvelope,
      replacementEnvelope: replacement,
      options: { expectedSessionGeneration: 1 }
    }, 'draft-conflict')
    await failedWith('rewrap', {
      id: 'storage',
      expectedEnvelope: original,
      replacementEnvelope: makeEnvelope('rewrap-receipt', { generation: 1, revision: 5, submissionId: 'submission-4', seed: 63 }),
      options: { expectedSessionGeneration: 1 }
    }, 'invalid-record')
    await failedWith('rewrap', {
      id: 'storage',
      expectedEnvelope: original,
      replacementEnvelope: replacement,
      options: { expectedSessionGeneration: 0 }
    }, 'generation-fenced')

    const rewrapped = await succeeded<OfflineDraftEnvelopeV1>('rewrap', {
      id: 'storage',
      expectedEnvelope: original,
      replacementEnvelope: replacement,
      options: { expectedSessionGeneration: 1 }
    })
    expect(rewrapped).toMatchObject({ recordId: replacement.recordId, sessionGeneration: 1, draftRevision: replacement.draftRevision, submissionId: replacement.submissionId })
    const afterRewrap = await readDump(name)
    expect(afterRewrap.meta?.sessionGeneration).toBe(1)
    expect(afterRewrap.drafts).toHaveLength(1)
    expect(bytes(afterRewrap.drafts[0]?.ciphertext)).toEqual(Array.from(replacement.ciphertext))
  })

  test('reports public lifecycle transaction aborts without changing recover or rewrap rows', async () => {
    const recoverName = freshDatabase('recover-abort')
    await succeeded('open', { id: 'recover', name: recoverName })
    const recoverOriginal = makeEnvelope('recover-abort', { generation: 0, revision: 1, seed: 71 })
    const recoverReplacement = makeEnvelope('recover-abort', { generation: 1, revision: 1, seed: 72 })
    await succeeded('putDraft', { id: 'recover', envelope: recoverOriginal })
    await succeeded('bump', { id: 'recover', options: { expectedSessionGeneration: 0 } })
    const recoverBefore = await readDump(recoverName)
    await failedWith('recoverAbort', {
      id: 'recover',
      expectedEnvelope: recoverOriginal,
      replacementEnvelope: recoverReplacement,
      options: { expectedSessionGeneration: 1 }
    }, 'transaction')
    const recoverAfter = await readDump(recoverName)
    expect(recoverAfter.meta).toEqual(recoverBefore.meta)
    expect(recoverAfter.drafts).toEqual(recoverBefore.drafts)

    const rewrapName = freshDatabase('rewrap-abort')
    await succeeded('open', { id: 'rewrap', name: rewrapName })
    const rewrapOriginal = makeEnvelope('rewrap-abort', { generation: 0, revision: 1, submissionId: 'submission-abort', seed: 81 })
    const rewrapReplacement = makeEnvelope('rewrap-abort', { generation: 1, revision: 1, submissionId: 'submission-abort', seed: 82 })
    await succeeded('putDraft', { id: 'rewrap', envelope: rewrapOriginal })
    await succeeded('bump', { id: 'rewrap', options: { expectedSessionGeneration: 0 } })
    const rewrapBefore = await readDump(rewrapName)
    await failedWith('rewrapAbort', {
      id: 'rewrap',
      expectedEnvelope: rewrapOriginal,
      replacementEnvelope: rewrapReplacement,
      options: { expectedSessionGeneration: 1 }
    }, 'transaction')
    const rewrapAfter = await readDump(rewrapName)
    expect(rewrapAfter.meta).toEqual(rewrapBefore.meta)
    expect(rewrapAfter.drafts).toEqual(rewrapBefore.drafts)
  })

  test('fences equal-byte manual policy flips after re-enabling an excluded page', async () => {
    const name = freshDatabase('manual-policy-revision')
    const selector = { siteId: 'manual-site', pageId: 42, locale: 'en' }
    await succeeded('open', { id: 'storage', name })
    await succeeded('setManual', {
      id: 'storage',
      selector,
      selected: true,
      options: { expectedPolicyRevision: 0 }
    })
    expect((await succeeded<StorageEstimate>('estimate', { id: 'storage' })).policyRevision).toBe(1)

    await succeeded('removeOffline', {
      id: 'storage',
      selector,
      options: { expectedPolicyRevision: 1 }
    })
    expect((await succeeded<StorageEstimate>('estimate', { id: 'storage' })).policyRevision).toBe(2)

    const reenabled = await succeeded<Record<string, unknown>>('setManual', {
      id: 'storage',
      selector,
      selected: true,
      options: { expectedPolicyRevision: 2 }
    })
    expect(reenabled).toMatchObject({ manual: true, excluded: false })
    expect((await succeeded<StorageEstimate>('estimate', { id: 'storage' })).policyRevision).toBe(3)
    await failedWith('setManual', {
      id: 'storage',
      selector,
      selected: false,
      options: { expectedPolicyRevision: 2 }
    }, 'policy-revision-fenced')
  })

  test('keeps exact metadata deltas and one locale variant for each immutable page', async () => {
    const name = freshDatabase('accounting')
    await succeeded('open', { id: 'storage', name })
    await succeeded<Record<string, unknown>>('putSnapshot', { id: 'storage', siteId: 'stable-site', snapshot: makeSnapshot('en') })
    const french = await succeeded<Record<string, unknown>>('putSnapshot', { id: 'storage', siteId: 'stable-site', snapshot: makeSnapshot('fr') })
    const draft = makeEnvelope('accounted-draft', { seed: 7 })
    await succeeded('putDraft', { id: 'storage', envelope: draft })
    const dump = await readDump(name)
    expect(dump.snapshots).toHaveLength(1)
    expect(dump.snapshots[0]?.locale).toBe('fr')
    expect(dump.searchDocuments).toHaveLength(1)
    expect(dump.searchDocuments[0]?.locale).toBe('fr')
    expect(dump.policy.filter(record => record.recordType === 'page')).toHaveLength(2)
    const estimate = await succeeded<StorageEstimate>('estimate', { id: 'storage' })
    expect(estimate.snapshotCount).toBe(1)
    expect(estimate.policyPageCount).toBe(2)
    expect(estimate.lockedDraftCount).toBe(1)
    expect(estimate.sessionGeneration).toBe(0)
    expect(estimate.policyRevision).toBe(0)
    expect(estimate.managedBytes).toBe(
      Number(french.byteSize) +
      Number(dump.searchDocuments[0]?.byteSize) +
      draftLogicalBytes(draft) +
      policyManagedBytes(dump)
    )
    expect(dump.meta?.corpusRevision).toBe(2)
    await succeeded('removeSnapshot', { id: 'storage', siteId: 'stable-site', pageId: 42 })
    const afterRemove = await succeeded<StorageEstimate>('estimate', { id: 'storage' })
    const afterRemoveDump = await readDump(name)
    expect(afterRemove.snapshotCount).toBe(0)
    expect(afterRemove.policyPageCount).toBe(2)
    expect(afterRemove.managedBytes).toBe(draftLogicalBytes(draft) + policyManagedBytes(afterRemoveDump))
    expect(afterRemoveDump.meta?.corpusRevision).toBe(3)
  })

  test('requires an exact stored selector and increasing revision for mutable drafts', async () => {
    const name = freshDatabase('cas')
    await succeeded('open', { id: 'storage', name })
    const first = makeEnvelope('mutable', { revision: 1, seed: 31 })
    const second = makeEnvelope('mutable', { revision: 2, seed: 32 })
    await succeeded('putDraft', { id: 'storage', envelope: first })
    await succeeded('putDraft', {
      id: 'storage',
      envelope: second,
      options: { expectedDraftRevision: first.draftRevision, expectedSubmissionId: first.submissionId }
    })
    await failedWith('putDraft', {
      id: 'storage',
      envelope: makeEnvelope('mutable', { revision: 2, seed: 33 }),
      options: { expectedDraftRevision: first.draftRevision, expectedSubmissionId: first.submissionId }
    }, 'draft-conflict')
    const dump = await readDump(name)
    expect(bytes(dump.drafts[0]?.ciphertext)).toEqual(Array.from(second.ciphertext))
  })

  test('preserves immutable receipts and aborts finalization atomically on a stale source selector', async () => {
    const name = freshDatabase('finalization')
    await succeeded('open', { id: 'storage', name })
    const receipt = makeEnvelope('receipt', { submissionId: 'submission-1', seed: 2 })
    const source = makeEnvelope('source', { revision: 1, seed: 3 })
    const fork = makeEnvelope('fork', { revision: 2, seed: 4 })
    await succeeded('putDraft', { id: 'storage', envelope: receipt })
    await succeeded('putDraft', { id: 'storage', envelope: source })
    await succeeded('putDraft', { id: 'storage', envelope: fork })
    await succeeded('putDraft', { id: 'storage', envelope: receipt })
    const changedReceipt = makeEnvelope('receipt', { submissionId: 'submission-1', seed: 9 })
    await failedWith('putDraft', { id: 'storage', envelope: changedReceipt }, 'immutable-submission')
    await failedWith('delete', { id: 'storage', recordId: 'receipt' }, 'immutable-submission')
    const staleSource = { ...source, nonce: Uint8Array.from(source.nonce).map(value => value ^ 0xff) }
    const replacementFork = makeEnvelope('fork', { revision: 3, seed: 11 })
    await failedWith('finalize', {
      id: 'storage',
      options: {
        expectedReceipt: receipt,
        expectedSource: staleSource,
        expectedSurvivingFork: fork,
        survivingFork: replacementFork
      }
    }, 'draft-conflict')
    const dump = await readDump(name)
    expect(dump.drafts.map(draft => draft.recordId).sort()).toEqual(['fork', 'receipt', 'source'])
    expect(bytes(dump.drafts.find(draft => draft.recordId === 'receipt')?.ciphertext)).toEqual(Array.from(receipt.ciphertext))
    expect(bytes(dump.drafts.find(draft => draft.recordId === 'fork')?.ciphertext)).toEqual(Array.from(fork.ciphertext))
  })

  test('marks opaque private rows incomplete without poisoning valid recovery or raw deletion', async () => {
    const name = freshDatabase('opaque')
    const valid = makeEnvelope('valid', { seed: 21 })
    await succeeded('seedLegacy', { name, draft: valid, corrupt: true })
    await succeeded('open', { id: 'storage', name })
    const dump = await readDump(name)
    expect(dump.drafts.map(draft => draft.recordId).sort()).toEqual(['opaque-row', 'valid'])
    expect(bytes(dump.drafts.find(draft => draft.recordId === 'opaque-row')?.ciphertext)).toEqual([4, 5, 6])
    expect(dump.meta?.accountingComplete).toBe(false)
    expect(dump.policy.filter(record => record.recordType === 'page')).toHaveLength(0)
    const estimate = await succeeded<StorageEstimate>('estimate', { id: 'storage' })
    expect(estimate.policyPageCount).toBe(0)
    expect(estimate.policyRevision).toBe(0)
    expect(estimate.managedBytes).toBe(draftLogicalBytes(valid) + policyManagedBytes(dump))
    await failedWith('putDraft', { id: 'storage', envelope: makeEnvelope('growth', { seed: 22 }) }, 'quota')
    await succeeded('deleteRaw', { id: 'storage', recordId: 'opaque-row' })
    const afterDelete = await readDump(name)
    expect(afterDelete.drafts.map(draft => draft.recordId)).toEqual(['valid'])
    expect(afterDelete.meta?.accountingComplete).toBe(false)
    await succeeded('close', { id: 'storage' })
    await succeeded('open', { id: 'recovered', name })
    await succeeded('putDraft', { id: 'recovered', envelope: makeEnvelope('growth', { seed: 22 }) })
  })

  test('keeps a cancelled clear side-effect free and advances generation only after confirmation', async () => {
    const name = freshDatabase('clear')
    await succeeded('open', { id: 'storage', name })
    const draft = makeEnvelope('clearable')
    await succeeded('putDraft', { id: 'storage', envelope: draft })
    const cancelled = await succeeded<{ cancelled: boolean; generation: number }>('clear', { id: 'storage', confirmed: false })
    expect(cancelled).toEqual({ cancelled: true, generation: 0 })
    expect((await readDump(name)).drafts).toHaveLength(1)
    const confirmed = await succeeded<{ cancelled: boolean; generation: number }>('clear', { id: 'storage', confirmed: true })
    expect(confirmed).toEqual({ cancelled: false, generation: 1 })
    expect((await readDump(name)).drafts).toHaveLength(0)
  })

  test('recovers from a blocked upgrade, versionchange closure, and intentional termination', async () => {
    const blockedName = freshDatabase('blocked')
    await succeeded('holdLegacy', { name: blockedName })
    await failedWith('open', { id: 'blocked', name: blockedName, blockedTimeoutMs: 30 }, 'blocked-upgrade')
    await succeeded('release', { name: blockedName })
    await succeeded('open', { id: 'blocked-retry', name: blockedName })
    await succeeded('terminate', { id: 'blocked-retry' })
    await failedWith('estimate', { id: 'blocked-retry' }, 'closed')
    await succeeded('open', { id: 'blocked-reopened', name: blockedName })
    expect(await succeeded<boolean>('isClosed', { id: 'blocked-reopened' })).toBe(false)
    const versionChangeName = freshDatabase('versionchange')
    await succeeded('open', { id: 'versioned', name: versionChangeName })
    await succeeded('deleteDatabase', { name: versionChangeName })
    expect(await succeeded<boolean>('isClosed', { id: 'versioned' })).toBe(true)
    await succeeded('open', { id: 'versioned-reopened', name: versionChangeName })
  })

  test('preserves unknown metadata schemas and refuses clear as a write', async () => {
    const name = freshDatabase('unknown')
    await succeeded('seedUnknownMeta', { name })
    await succeeded('open', { id: 'unknown', name })
    await failedWith('estimate', { id: 'unknown' }, 'unsupported-schema')
    await failedWith('clear', { id: 'unknown', confirmed: true }, 'unsupported-schema')
    const dump = await readDump(name)
    expect(dump.meta?.schemaVersion).toBe(99)
    expect(dump.meta?.sessionGeneration).toBe(4)
  })
})

