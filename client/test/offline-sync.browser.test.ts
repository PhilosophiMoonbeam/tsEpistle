import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from '../../server/test/bun-test.mts'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { chromium, type Browser, type Page } from 'playwright-core'
import type { OfflinePagePolicyRecord, OfflineSnapshotRecord } from '../../shared/offline.ts'
import { createOfflineSyncUnavailableResult, type OfflineSyncPassResult } from '../helpers/offline-sync.ts'

const storagePath = fileURLToPath(new URL('../helpers/offline-storage.ts', import.meta.url))
const syncPath = fileURLToPath(new URL('../helpers/offline-sync.ts', import.meta.url))
const executablePath = process.env.CHROME_BIN ?? '/usr/bin/google-chrome'
const siteId = 'https://offline-sync.example.test'
const currentTime = '2026-09-16T00:00:00.000Z'
const oldTime = '2026-07-01T00:00:00.000Z'

type SyncRun = {
  result: OfflineSyncPassResult
  pages: OfflinePagePolicyRecord[]
  snapshots: OfflineSnapshotRecord[]
  policyRevision: number
  sessionGeneration: number
  requests: string[]
}

type Outcome = { ok: true; value: SyncRun } | { ok: false; error: { message: string } }

const driverSource = (absoluteStoragePath: string, absoluteSyncPath: string): string => `
import { openOfflineStorage } from ${JSON.stringify(absoluteStoragePath)};
import { createOfflineSyncCoordinator } from ${JSON.stringify(absoluteSyncPath)};

const SITE_ID = ${JSON.stringify(siteId)};
const CURRENT_TIME = ${JSON.stringify(currentTime)};
const OLD_TIME = ${JSON.stringify(oldTime)};

const selector = (pageId, locale = 'en') => ({ siteId: SITE_ID, pageId, locale });
const makeSnapshot = (pageId, capturedAt = CURRENT_TIME, locale = 'en') => ({
  schemaVersion: 1,
  pageId,
  locale,
  path: 'docs/' + locale + '/' + pageId,
  canonicalPath: 'docs/' + locale + '/' + pageId,
  title: 'Page ' + pageId,
  description: 'Description ' + pageId,
  sourceRevision: 'revision-' + pageId,
  capturedAt,
  expiresAt: null,
  content: {
    representation: 'sanitized-html-fragment',
    sanitizerVersion: 'offline-html-allowlist-v1',
    html: '<p>Page ' + pageId + '</p>'
  },
  searchText: 'page ' + pageId,
  contentType: 'sanitized-html-fragment',
  integrity: 'sha256:page-' + pageId
});
const makePageRow = (pageId, tags) => ({
  id: pageId,
  locale: 'en',
  path: 'docs/' + pageId,
  title: 'Page ' + pageId,
  description: 'Description ' + pageId,
  visibility: 'public',
  ownerId: null,
  contentType: 'markdown',
  createdAt: CURRENT_TIME,
  updatedAt: CURRENT_TIME,
  tags
});
const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' }
});
const errorValue = (error) => ({
  name: error && typeof error.name === 'string' ? error.name : 'Error',
  message: error instanceof Error ? error.message : String(error)
});

export async function run(operation, payload = {}) {
  if (operation === 'cleanup') {
    for (const name of Array.isArray(payload.names) ? payload.names : []) {
      const { promise, resolve, reject } = Promise.withResolvers();
      const request = indexedDB.deleteDatabase(String(name));
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error('IndexedDB delete failed.'));
      request.onblocked = () => reject(new Error('IndexedDB delete was blocked.'));
      await promise;
    }
    return { ok: true, value: true };
  }
  if (operation !== 'scenario') throw new Error('Unknown coordinator test operation.');

  const databaseName = String(payload.name);
  const kind = String(payload.kind);
  const storage = await openOfflineStorage({ databaseName });
  const requests = [];
  let fenceMutationDone = false;
  const disposeFetchStartedGate = Promise.withResolvers();
  const disposeFetchStarted = disposeFetchStartedGate.promise;
  let releaseDisposeFetch = () => {};
  const disposePutStartedGate = Promise.withResolvers();
  const disposePutStarted = disposePutStartedGate.promise;
  let releaseDisposePut = () => {};
  let restorePut = () => {};
  const fetchImpl = async (input) => {
    const requestURL = new URL(input, SITE_ID);
    requests.push(requestURL.pathname + requestURL.search);
    if (requestURL.pathname === '/_api/pages' && requestURL.searchParams.has('tags')) {
      const tag = requestURL.searchParams.get('tags');
      if (kind === 'tag-error' && tag === 'broken') return json({ message: 'Tag discovery failed.' }, 503);
      const ids = tag === 'alpha' ? [200, 201] : tag === 'beta' ? [200, 202] : tag === 'keep' ? (kind === 'rotation' || kind === 'disable' ? [3] : [92]) : [];
      return json(ids.map(pageId => makePageRow(pageId, [tag])));
    }
    if (requestURL.pathname.endsWith('/offline-snapshot')) {
      const pageId = Number(requestURL.pathname.split('/').at(-2));
      if (kind === 'fence' && !fenceMutationDone) {
        fenceMutationDone = true;
        await storage.recordEligibleReaderVisit(selector(pageId));
        await storage.bumpSessionGeneration();
      }
      if (kind === 'dispose') {
        disposeFetchStartedGate.resolve();
        const releaseGate = Promise.withResolvers();
        releaseDisposeFetch = releaseGate.resolve;
        await releaseGate.promise;
      }
      if ((kind === 'refill' || kind === 'refill-locales') && pageId === 1) return json({ message: 'Snapshot not found.' }, 404);
      if (kind === 'refill-locales' && pageId === 2) return json({ message: 'Snapshot not found.' }, 404);
      if (kind === 'transient' && pageId === 1) return json({ message: 'Temporary failure.' }, 503);
      const allowed = kind === 'manual' || kind === 'fence' || kind === 'dispose' || kind === 'dispose-commit'
        ? [1]
        : kind === 'automatic'
          ? Array.from({ length: 10 }, (_value, index) => index + 1)
          : kind === 'refill'
            ? Array.from({ length: 11 }, (_value, index) => index + 1)
            : kind === 'refill-locales'
              ? Array.from({ length: 12 }, (_value, index) => index + 1)
              : kind === 'transient'
                ? Array.from({ length: 10 }, (_value, index) => index + 1)
                : kind === 'rotation'
                  ? Array.from({ length: 11 }, (_value, index) => index + 1)
                  : kind === 'disable'
                    ? [2, 3]
                    : kind === 'tags'
                      ? [200, 201, 202]
                      : [91, 92];
      if (!allowed.includes(pageId)) return json({ message: 'Snapshot not found.' }, 404);
      return json(makeSnapshot(pageId));
    }
    return json([]);
  };

  try {
    if (kind === 'manual') {
      await storage.setManualOfflineIntent(selector(1), true);
    } else if (kind === 'automatic') {
      await storage.setAutomaticSavingEnabled(true);
      const originalToISOString = Date.prototype.toISOString;
      try {
        Date.prototype.toISOString = () => CURRENT_TIME;
        for (let pageId = 1; pageId <= 10; pageId += 1) {
          for (let visit = 0; visit < 12 - pageId; visit += 1) await storage.recordEligibleReaderVisit(selector(pageId));
        }
        Date.prototype.toISOString = () => OLD_TIME;
        for (let visit = 0; visit < 40; visit += 1) await storage.recordEligibleReaderVisit(selector(11));
      } finally {
        Date.prototype.toISOString = originalToISOString;
      }
    } else if (kind === 'refill' || kind === 'transient' || kind === 'refill-locales') {
      await storage.setAutomaticSavingEnabled(true);
      const originalToISOString = Date.prototype.toISOString;
      try {
        Date.prototype.toISOString = () => CURRENT_TIME;
        const maximumPageId = kind === 'refill-locales' ? 12 : 11;
        for (let pageId = 1; pageId <= maximumPageId; pageId += 1) {
          for (let visit = 0; visit < 24 - pageId; visit += 1) await storage.recordEligibleReaderVisit(selector(pageId));
        }
        if (kind === 'refill-locales') {
          for (let visit = 0; visit < 12; visit += 1) await storage.recordEligibleReaderVisit(selector(11, 'fr'));
        }
      } finally {
        Date.prototype.toISOString = originalToISOString;
      }
      if (kind === 'transient') await storage.putSnapshot(SITE_ID, makeSnapshot(1), { provenance: { automatic: true } });
    } else if (kind === 'offline' || kind === 'offline-remove' || kind === 'dispose' || kind === 'dispose-commit' || kind === 'closed') {
      if (kind === 'offline-remove') {
        const initialPolicy = await storage.readOfflinePolicy();
        const expectedSessionGeneration = initialPolicy.sessionGeneration;
        const readPolicyRevision = async () =>
          (await storage.readOfflinePolicy({ expectedSessionGeneration })).state.policyRevision;
        let expectedPolicyRevision = initialPolicy.state.policyRevision;
        expectedPolicyRevision = (
          await storage.setAutomaticSavingEnabled(true, { expectedSessionGeneration, expectedPolicyRevision })
        ).policyRevision;
        await storage.updateAutomaticSelections([selector(1)], {
          expectedSessionGeneration,
          expectedPolicyRevision,
          asOf: CURRENT_TIME
        });
        expectedPolicyRevision = await readPolicyRevision();
        await storage.setManualOfflineIntent(selector(1), true, { expectedSessionGeneration, expectedPolicyRevision });
        expectedPolicyRevision = await readPolicyRevision();
        expectedPolicyRevision = (
          await storage.setOfflineTagSubscriptions(['keep'], { expectedSessionGeneration, expectedPolicyRevision })
        ).policyRevision;
        await storage.synchronizeTagProvenance('keep', [selector(1)], { expectedSessionGeneration, expectedPolicyRevision });
        expectedPolicyRevision = await readPolicyRevision();
        await storage.putSnapshot(SITE_ID, makeSnapshot(1), {
          expectedSessionGeneration,
          expectedPolicyRevision,
          provenance: { manual: true, automatic: true, tagNames: ['keep'] }
        });
        expectedPolicyRevision = await readPolicyRevision();
        await storage.setPageAvailability(selector(1), 'ineligible', { expectedSessionGeneration, expectedPolicyRevision });
        expectedPolicyRevision = await readPolicyRevision();
        await storage.removeOfflinePage(selector(1), { expectedSessionGeneration, expectedPolicyRevision });
      } else {
        await storage.setManualOfflineIntent(selector(1), true);
      }
      if (kind === 'closed') storage.close();
    } else if (kind === 'rotation') {
      await storage.setAutomaticSavingEnabled(true);
      const originalToISOString = Date.prototype.toISOString;
      try {
        Date.prototype.toISOString = () => CURRENT_TIME;
        for (let pageId = 2; pageId <= 10; pageId += 1) await storage.recordEligibleReaderVisit(selector(pageId));
        for (let visit = 0; visit < 40; visit += 1) await storage.recordEligibleReaderVisit(selector(11));
      } finally {
        Date.prototype.toISOString = originalToISOString;
      }
      const initial = Array.from({ length: 10 }, (_value, index) => selector(index + 1));
      await storage.updateAutomaticSelections(initial, { asOf: CURRENT_TIME });
      await storage.setManualOfflineIntent(selector(2), true);
      await storage.setOfflineTagSubscriptions(['keep']);
      await storage.synchronizeTagProvenance('keep', [selector(3)]);
      await storage.putSnapshot(SITE_ID, makeSnapshot(1), { provenance: { automatic: true } });
      await storage.putSnapshot(SITE_ID, makeSnapshot(2), { provenance: { manual: true, automatic: true } });
      await storage.putSnapshot(SITE_ID, makeSnapshot(3), { provenance: { automatic: true, tagNames: ['keep'] } });
    } else if (kind === 'disable') {
      await storage.setAutomaticSavingEnabled(true);
      await storage.updateAutomaticSelections([selector(1), selector(2), selector(3)], { asOf: CURRENT_TIME });
      await storage.setManualOfflineIntent(selector(2), true);
      await storage.setOfflineTagSubscriptions(['keep']);
      await storage.synchronizeTagProvenance('keep', [selector(3)]);
      await storage.putSnapshot(SITE_ID, makeSnapshot(1), { provenance: { automatic: true } });
      await storage.putSnapshot(SITE_ID, makeSnapshot(2), { provenance: { manual: true, automatic: true } });
      await storage.putSnapshot(SITE_ID, makeSnapshot(3), { provenance: { automatic: true, tagNames: ['keep'] } });
      await storage.setAutomaticSavingEnabled(false);
    } else if (kind === 'tags') {
      await storage.setOfflineTagSubscriptions(['alpha', 'beta']);
    } else if (kind === 'tag-error') {
      await storage.setOfflineTagSubscriptions(['broken']);
    } else if (kind === 'expiry') {
      const automaticOnly = selector(90);
      const manualPage = selector(91);
      const taggedPage = selector(92);
      await storage.updateAutomaticSelections([automaticOnly, manualPage, taggedPage], { asOf: OLD_TIME });
      await storage.setManualOfflineIntent(manualPage, true);
      await storage.setOfflineTagSubscriptions(['keep']);
      await storage.synchronizeTagProvenance('keep', [taggedPage]);
      await storage.putSnapshot(SITE_ID, makeSnapshot(90, OLD_TIME), { provenance: { automatic: true } });
      await storage.putSnapshot(SITE_ID, makeSnapshot(91, OLD_TIME), { provenance: { manual: true, automatic: true } });
      await storage.putSnapshot(SITE_ID, makeSnapshot(92, OLD_TIME), { provenance: { automatic: true, tagNames: ['keep'] } });
      await storage.setAutomaticSavingEnabled(true);
    } else if (kind === 'fence') {
      await storage.setManualOfflineIntent(selector(1), true);
    } else {
      throw new Error('Unknown coordinator scenario.');
    }

    if (kind === 'dispose-commit') {
      const originalPut = IDBObjectStore.prototype.put;
      let held = false;
      let released = false;
      releaseDisposePut = () => { released = true };
      const keepTransactionAlive = (transaction) => {
        const continueHolding = () => {
          if (released) return;
          try {
            const request = transaction.objectStore('meta').get('state');
            request.onsuccess = continueHolding;
            request.onerror = () => {};
          } catch {
            released = true;
          }
        };
        transaction.addEventListener('abort', () => { released = true; }, { once: true });
        continueHolding();
      };
      IDBObjectStore.prototype.put = function (...args) {
        const request = originalPut.apply(this, args);
        const value = args[0];
        if (!held && this.name === 'meta' && value && typeof value === 'object' && Number(value.corpusRevision) > 0) {
          held = true;
          disposePutStartedGate.resolve();
          keepTransactionAlive(this.transaction);
        }
        return request;
      };
      restorePut = () => {
        released = true;
        IDBObjectStore.prototype.put = originalPut;
      };
    }

    const coordinator = createOfflineSyncCoordinator({
      storage,
      siteId: SITE_ID,
      fetchImpl,
      now: () => CURRENT_TIME,
      isOnline: () => kind !== 'offline' && kind !== 'offline-remove',
      isForeground: () => true,
      maxConcurrentFetches: 2
    });
    let result;
    if (kind === 'offline-remove') {
      await storage.removeOfflinePage(selector(1));
      result = await coordinator.reconcile('manual');
    } else if (kind === 'dispose') {
      const pending = coordinator.reconcile('manual');
      await disposeFetchStarted;
      coordinator.dispose();
      releaseDisposeFetch();
      result = await pending;
    } else if (kind === 'dispose-commit') {
      const pending = coordinator.reconcile('manual');
      await disposePutStarted;
      coordinator.dispose();
      releaseDisposePut();
      result = await pending;
      restorePut();
      restorePut = () => {};
    } else {
      result = await coordinator.reconcile('manual');
    }
    if (kind === 'closed') {
      return {
        ok: true,
        value: {
          result,
          pages: [],
          snapshots: [],
          policyRevision: 0,
          sessionGeneration: 0,
          requests
        }
      };
    }
    const policy = await storage.readOfflinePolicy();
    return {
      ok: true,
      value: {
        result,
        pages: await storage.listPagePolicies(SITE_ID),
        snapshots: await storage.listSnapshots(SITE_ID),
        policyRevision: policy.state.policyRevision,
        sessionGeneration: policy.sessionGeneration,
        requests
      }
    };
  } catch (error) {
    return { ok: false, error: errorValue(error) };
  } finally {
    restorePut();
    releaseDisposePut();
    storage.close();
  }
}
`

let tempDirectory: string
let browser: Browser
let page: Page
let driverURL: string
let testServer: { url: URL; stop: (closeActiveConnections?: boolean) => void }
const databaseNames = new Set<string>()

const invoke = async (operation: string, payload: Record<string, unknown> = {}): Promise<unknown> => {
  return await page.evaluate(
    async ({ moduleURL, operationName, operationPayload }) => {
      const driver = (await import(moduleURL)) as { run: (name: string, value: Record<string, unknown>) => Promise<unknown> }
      return await driver.run(operationName, operationPayload)
    },
    { moduleURL: driverURL, operationName: operation, operationPayload: payload }
  )
}

const freshDatabase = (kind: string): string => {
  const name = 'offline-sync-' + kind + '-' + crypto.randomUUID()
  databaseNames.add(name)
  return name
}

const runScenario = async (kind: string): Promise<SyncRun> => {
  const outcome = (await invoke('scenario', { name: freshDatabase(kind), kind })) as Outcome
  expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true)
  if (!outcome.ok) throw new Error(outcome.error.message)
  return outcome.value
}

const pageIds = (run: SyncRun): number[] => run.snapshots.map(snapshot => snapshot.snapshot.pageId).sort((left, right) => left - right)
const policyFor = (run: SyncRun, pageId: number): OfflinePagePolicyRecord | undefined => run.pages.find(page => page.pageId === pageId)
const snapshotRequests = (run: SyncRun): number[] =>
  run.requests
    .filter(request => request.endsWith('/offline-snapshot'))
    .map(request => Number(request.split('/').at(-2)))
    .sort((left, right) => left - right)

beforeAll(async () => {
  tempDirectory = await mkdtemp(`${tmpdir()}/tsepistle-offline-sync-`)
  const entry = `${tempDirectory}/browser-entry.ts`
  await Bun.write(entry, driverSource(storagePath, syncPath))
  const build = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', sourcemap: 'none' })
  if (!build.success) throw new Error(build.logs.map(log => log.message).join('\n'))
  const output = await build.outputs[0]!.text()
  testServer = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/adapter.js') return new Response(output, { headers: { 'content-type': 'text/javascript' } })
      return new Response('<!doctype html><title>offline sync test</title>', { headers: { 'content-type': 'text/html' } })
    }
  })
  driverURL = `${testServer.url}adapter.js`
  browser = await chromium.launch({ headless: true, executablePath, chromiumSandbox: false })
  page = await browser.newPage()
  await page.goto(`${testServer.url}blank`, { waitUntil: 'load' })
})

beforeEach(() => {
  databaseNames.clear()
})

afterEach(async () => {
  if (page && databaseNames.size > 0) await invoke('cleanup', { names: Array.from(databaseNames) })
  databaseNames.clear()
})

afterAll(async () => {
  try {
    if (page) await page.close()
    if (browser) await browser.close()
  } finally {
    testServer?.stop(true)
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true })
  }
})

test('exposes an explicit unavailable service result', () => {
  expect(createOfflineSyncUnavailableResult('storage is opening')).toMatchObject({
    status: 'unavailable',
    outcome: 'unavailable',
    kind: 'unavailable',
    error: 'storage is opening',
    attempted: 0,
    saved: 0,
    retained: 0,
    removed: 0,
    failed: 0,
    pending: 0,
    diagnostics: null
  })
})

describe('foreground offline sync coordinator', () => {
  test('reconciles a manual offline intent immediately with a typed success outcome', async () => {
    const run = await runScenario('manual')
    expect(run.result.status).toBe('complete')
    expect(run.result.outcome).toBe('success')
    expect(run.result.kind).toBe('success')
    expect(run.result.saved).toBe(1)
    expect(pageIds(run)).toEqual([1])
    expect(snapshotRequests(run)).toEqual([1])
    expect(policyFor(run, 1)).toMatchObject({ manual: true, automatic: false, tag: false, excluded: false })
  })

  test('excludes a stale high-ranked automatic page before selecting the top ten', async () => {
    const run = await runScenario('automatic')
    expect(run.result.status).toBe('complete')
    expect(run.result.saved).toBe(10)
    expect(pageIds(run)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(snapshotRequests(run)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(policyFor(run, 10)).toMatchObject({ automatic: true, manual: false, tag: false, excluded: false })
    expect(policyFor(run, 11)).toMatchObject({ automatic: false, manual: false, tag: false, lastVisitedAt: oldTime })
  })

  test('refills one denied automatic slot from the eleventh ranked candidate without duplicate attempts', async () => {
    const run = await runScenario('refill')
    expect(run.result.outcome).toBe('success')
    expect(run.result).toMatchObject({
      attempted: 11,
      saved: 10,
      retained: 0,
      removed: 0,
      failed: 0,
      pending: 0
    })
    expect(pageIds(run)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(snapshotRequests(run)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(new Set(snapshotRequests(run)).size).toBe(11)
    expect(policyFor(run, 1)).toMatchObject({ automatic: false, manual: false, tag: false, excluded: false, availability: 'ineligible' })
    expect(policyFor(run, 11)).toMatchObject({ automatic: true })
  })
  test('refills denied slots with distinct immutable pages when ranked locales overlap', async () => {
    const run = await runScenario('refill-locales')
    expect(run.result.outcome).toBe('success')
    expect(run.result).toMatchObject({
      attempted: 12,
      saved: 10,
      retained: 0,
      removed: 0,
      failed: 0,
      pending: 0
    })
    expect(pageIds(run)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(snapshotRequests(run)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(new Set(snapshotRequests(run)).size).toBe(12)
    expect(run.snapshots.find(snapshot => snapshot.snapshot.pageId === 11)?.snapshot.locale).toBe('en')
    expect(policyFor(run, 11)).toMatchObject({ automatic: true })
    expect(policyFor(run, 12)).toMatchObject({ automatic: true })
  })

  test('retains an existing body on transient automatic failure without losing its slot', async () => {
    const run = await runScenario('transient')
    expect(run.result.status).toBe('partial')
    expect(run.result.outcome).toBe('error')
    expect(run.result).toMatchObject({
      attempted: 10,
      saved: 9,
      retained: 1,
      removed: 0,
      failed: 1,
      pending: 0
    })
    expect(run.result.error).toBe(run.result.diagnostics.lastError)
    expect(run.result.error).not.toBeNull()
    expect(pageIds(run)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(snapshotRequests(run)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(new Set(snapshotRequests(run)).size).toBe(10)
    expect(snapshotRequests(run)).not.toContain(11)
    expect(policyFor(run, 1)).toMatchObject({ automatic: true, availability: 'transient-failure' })
    expect(policyFor(run, 11)).toMatchObject({ automatic: false, manual: false, tag: false })
  })

  test('reports selected work as pending while offline without dispatching requests', async () => {
    const run = await runScenario('offline')
    expect(run.result.status).toBe('offline')
    expect(run.result.outcome).toBe('offline')
    expect(run.result.pending).toBe(1)
    expect(run.result.diagnostics.pendingCount).toBe(1)
    expect(policyFor(run, 1)).toMatchObject({ manual: true, automatic: false, tag: false, excluded: false })
  })

  test('removes every local source and body while offline after admission is denied', async () => {
    const run = await runScenario('offline-remove')
    expect(run.result.pending).toBe(0)
    expect(run.result.saved).toBe(0)
    expect(snapshotRequests(run)).toEqual([])
    expect(pageIds(run)).toEqual([])
    expect(policyFor(run, 1)).toMatchObject({
      manual: false,
      automatic: false,
      tag: false,
      tagNames: [],
      excluded: true,
      availability: 'unknown'
    })
  })

  test('returns an explicit error outcome when storage closes before a pass', async () => {
    const run = await runScenario('closed')
    expect(run.result.status).toBe('error')
    expect(run.result.error).toBe(run.result.diagnostics.lastError)
    expect(run.result.error).toContain('closed')
    expect(run.result.diagnostics.lastError).toContain('closed')
  })

  test('aborting and disposing a pass prevents its late snapshot commit', async () => {
    const run = await runScenario('dispose')
    expect(run.result.status).toBe('offline')
    expect(run.result.outcome).toBe('offline')
    expect(run.result.saved).toBe(0)
    expect(run.snapshots).toEqual([])
  })
  test('invalidating while snapshot transaction completion is held prevents its commit', async () => {
    const run = await runScenario('dispose-commit')
    expect(run.result.status).toBe('offline')
    expect(run.result.outcome).toBe('offline')
    expect(run.result.saved).toBe(0)
    expect(run.snapshots).toEqual([])
  })

  test('rotates automatic membership without retaining an eleventh automatic page', async () => {
    const run = await runScenario('rotation')
    expect(run.result.status).toBe('complete')
    expect(run.result.saved).toBe(10)
    expect(pageIds(run)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(snapshotRequests(run)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(run.pages.filter(page => page.automatic)).toHaveLength(10)
    expect(policyFor(run, 1)).toMatchObject({ automatic: false, automaticSelectedAt: null, manual: false, tag: false })
    expect(policyFor(run, 2)).toMatchObject({ automatic: true, manual: true })
    expect(policyFor(run, 3)).toMatchObject({ automatic: true, tag: true, tagNames: ['keep'] })
  })

  test('disables automatic copies without removing manual or tag-backed pages', async () => {
    const run = await runScenario('disable')
    expect(run.result.status).toBe('complete')
    expect(run.result.saved).toBe(2)
    expect(pageIds(run)).toEqual([2, 3])
    expect(snapshotRequests(run)).toEqual([2, 3])
    expect(policyFor(run, 1)).toMatchObject({ automatic: false, automaticSelectedAt: null, manual: false, tag: false })
    expect(policyFor(run, 2)).toMatchObject({ automatic: false, manual: true })
    expect(policyFor(run, 3)).toMatchObject({ automatic: false, tag: true, tagNames: ['keep'] })
  })

  test('unions selected tag subscriptions and stores each discovered page once', async () => {
    const run = await runScenario('tags')
    expect(run.result.status).toBe('complete')
    expect(run.result.saved).toBe(3)
    expect(pageIds(run)).toEqual([200, 201, 202])
    expect(snapshotRequests(run)).toEqual([200, 201, 202])
    expect(policyFor(run, 200)).toMatchObject({ manual: false, automatic: false, tag: true, tagNames: ['alpha', 'beta'], excluded: false })
    expect(policyFor(run, 201)).toMatchObject({ manual: false, automatic: false, tag: true, tagNames: ['alpha'], excluded: false })
    expect(policyFor(run, 202)).toMatchObject({ manual: false, automatic: false, tag: true, tagNames: ['beta'], excluded: false })
  })
  test('reports tag discovery errors in both the typed outcome and diagnostics', async () => {
    const run = await runScenario('tag-error')
    expect(run.result.status).toBe('partial')
    expect(run.result.outcome).toBe('error')
    expect(run.result.failed).toBe(1)
    expect(run.result.error).toBe(run.result.diagnostics.lastError)
    expect(run.result.error).not.toBeNull()
  })

  test('expires only stale automatic-only bodies after sixty days', async () => {
    const run = await runScenario('expiry')
    expect(run.result.status).toBe('complete')
    expect(pageIds(run)).toEqual([91, 92])
    expect(snapshotRequests(run)).toEqual([91, 92])
    expect(policyFor(run, 90)).toMatchObject({ automatic: false, manual: false, tag: false, automaticSelectedAt: null })
    expect(policyFor(run, 91)).toMatchObject({ automatic: false, automaticSelectedAt: null, manual: true })
    expect(policyFor(run, 92)).toMatchObject({ automatic: false, automaticSelectedAt: null, tag: true, tagNames: ['keep'] })
  })

  test('fences stale generation and policy writes before retrying in the current session', async () => {
    const run = await runScenario('fence')
    expect(run.result.status).toBe('complete')
    expect(run.result.saved).toBe(1)
    expect(run.sessionGeneration).toBe(1)
    expect(run.policyRevision).toBe(2)
    expect(snapshotRequests(run)).toEqual([1, 1])
    expect(pageIds(run)).toEqual([1])
  })
})
