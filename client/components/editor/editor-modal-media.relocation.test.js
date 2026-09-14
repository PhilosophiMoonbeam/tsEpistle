import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from '../../../server/test/bun-test.mts'

const componentPath = path.join(process.cwd(), 'client/components/editor/editor-modal-media.vue')

const readMediaScript = () => {
  const source = fs.readFileSync(componentPath, 'utf8')
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  expect(match).not.toBeNull()
  return match[1]
}

const loadMediaComponent = ({ relocateAssetRequest, wikiStore, window, fetchAssets, fetchAssetFolders }) => {
  const script = readMediaScript()
    .replace(/^import[^\n]*(?:\n|$)/gm, '')
    .replace('export default defineComponent(', 'const component = defineComponent(')
  const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script)
  const dependencies = {
    PageBrandingAssignmentSchema: { safeParse: () => ({ success: false }) },
    PageBrandingViewSchema: { safeParse: () => ({ success: false }) },
    _: {},
    createAssetFolder: async () => undefined,
    createModalFocusScope: () => ({ deactivate: () => undefined }),
    defineComponent: value => value,
    deleteAssetRequest: async () => undefined,
    emitEditorInsert: () => undefined,
    fetchAssetBranding: async () => undefined,
    fetchAssetFolders: fetchAssetFolders ?? (async () => []),
    fetchAssets: fetchAssets ?? (async () => []),
    isRecord: value => typeof value === 'object' && value !== null,
    markRaw: value => value,
    relocateAssetRequest,
    vueFilePond: () => ({}),
    wikiStore,
    window
  }
  return new Function(...Object.keys(dependencies), `${executable}\nreturn component`)(...Object.values(dependencies))
}

const receiptFor = status => ({
  id: '00000000-0000-4000-8000-000000000001',
  assetId: 7,
  sourcePath: 'old.png',
  destinationPath: 'new.png',
  status,
  statusUrl: '/_api/assets/relocations/00000000-0000-4000-8000-000000000001',
  effects: []
})

const createHarness = ({ waitForRelocation, loadMedia, fetchAssets, fetchAssetFolders } = {}) => {
  const notifications = []
  const errors = []
  const loading = []
  const wikiStore = {
    startLoading: owner => loading.push(`start:${owner}`),
    stopLoading: owner => loading.push(`stop:${owner}`),
    showError: error => errors.push(error),
    showNotification: notification => notifications.push(notification),
    editor: {
      editorKey: 'markdown',
      media: {
        currentFileId: 7,
        currentFolderId: 0,
        folderTree: []
      }
    },
    page: { visibility: 'public' }
  }
  const relocationCalls = []
  const component = loadMediaComponent({
    relocateAssetRequest: async (_fetch, assetId, input) => {
      relocationCalls.push({ assetId, input })
      return receiptFor('pending')
    },
    wikiStore,
    window: { fetch: async () => undefined },
    fetchAssets,
    fetchAssetFolders
  })
  const asset = { id: 7, filename: 'old.png', folderId: 0 }
  const context = {
    ...component.data(),
    $t: key => key,
    actionMenuAssetId: 7,
    assets: [asset],
    currentAsset: asset,
    currentFileId: 7,
    currentFolderId: 0,
    disposed: false,
    isRenameValid: true,
    relocationFolderId: 0,
    renameAssetName: 'new.png',
    wikiStore
  }
  for (const [name, method] of Object.entries(component.methods)) context[name] = method.bind(context)
  context.waitForRelocation = waitForRelocation ?? (async receipt => receipt)
  if (loadMedia) context.loadMedia = loadMedia
  Object.defineProperty(context, 'relocationStatusMessage', {
    configurable: true,
    get: () => component.computed.relocationStatusMessage.call(context)
  })
  return { context, errors, loading, notifications, relocationCalls }
}

describe('editor media relocation admission state', () => {
  test('invalidates the old path before polling and keeps a timed-out receipt stale without resubmitting', async () => {
    const pending = receiptFor('pending')
    let observedAtPoll
    const harness = createHarness({
      waitForRelocation: async receipt => {
        observedAtPoll = {
          actionMenuAssetId: harness.context.actionMenuAssetId,
          currentFileId: harness.context.currentFileId,
          staleAssetIds: [...harness.context.staleAssetIds]
        }
        return receipt
      }
    })

    await harness.context.relocateAsset()

    expect(observedAtPoll).toEqual({ actionMenuAssetId: null, currentFileId: null, staleAssetIds: [7] })
    expect(harness.context.relocationReceipt).toEqual(pending)
    expect(harness.context.isAssetActionable(7)).toBe(false)
    expect(harness.notifications).toEqual([
      { message: 'editor:assets.relocationSubmitted', style: 'info', icon: 'clock-outline' },
      { message: 'editor:assets.relocationPendingRetry', style: 'warning', icon: 'clock-outline' }
    ])
    expect(harness.relocationCalls).toHaveLength(1)

    await harness.context.relocateAsset()
    expect(harness.relocationCalls).toHaveLength(1)
  })
  test('ignores a deferred pre-admission media response after relocation is accepted', async () => {
    let resolveAssets
    let resolveFolders
    const assetsResponse = new Promise(resolve => {
      resolveAssets = resolve
    })
    const foldersResponse = new Promise(resolve => {
      resolveFolders = resolve
    })
    const harness = createHarness({
      fetchAssets: async () => assetsResponse,
      fetchAssetFolders: async () => foldersResponse
    })
    const initialLoad = harness.context.loadMedia()
    const mediaController = harness.context.mediaAbortController
    const initialAssets = harness.context.assets
    expect(mediaController).not.toBeNull()
    expect(harness.context.mediaRequest).toBe(1)
    await harness.context.relocateAsset()

    expect(mediaController.signal.aborted).toBe(true)
    expect(harness.context.mediaRequest).toBe(2)
    expect(harness.context.staleAssetIds).toEqual([7])

    resolveAssets([{ id: 7, filename: 'old.png', folderId: 0 }])
    resolveFolders([])
    expect(await initialLoad).toBe(false)
    expect(harness.context.assets).toBe(initialAssets)
    expect(harness.context.staleAssetIds).toEqual([7])
  })

  test('keeps an accepted receipt and stale old path when polling fails because the worker is down', async () => {
    const pending = receiptFor('pending')
    const workerError = new Error('worker unavailable')
    const harness = createHarness({
      waitForRelocation: async () => {
        throw workerError
      }
    })

    await harness.context.relocateAsset()

    expect(harness.context.relocationReceipt).toEqual(pending)
    expect(harness.context.staleAssetIds).toEqual([7])
    expect(harness.context.currentFileId).toBeNull()
    expect(harness.context.isAssetActionable(7)).toBe(false)
    expect(harness.errors).toEqual([workerError])
    expect(harness.notifications).toEqual([
      { message: 'editor:assets.relocationSubmitted', style: 'info', icon: 'clock-outline' }
    ])
    expect(harness.relocationCalls).toHaveLength(1)
  })

  test('allows a successful canonical refresh to clear stale state and report success', async () => {
    const succeeded = { ...receiptFor('succeeded'), effects: [{ id: 'effect-1', targetKey: 'page-1', status: 'succeeded', lastError: null }] }
    const harness = createHarness({
      waitForRelocation: async () => succeeded,
      loadMedia: async () => {
        harness.context.assets = [{ id: 7, filename: 'new.png', folderId: 0 }]
        return true
      }
    })

    await harness.context.relocateAsset()

    expect(harness.context.relocationReceipt).toEqual(succeeded)
    expect(harness.context.staleAssetIds).toEqual([])
    expect(harness.context.currentFileId).toBeNull()
    expect(harness.context.assets[0].filename).toBe('new.png')
    expect(harness.notifications).toEqual([
      { message: 'editor:assets.relocationSubmitted', style: 'info', icon: 'clock-outline' },
      { message: 'editor:assets.relocationSuccess', style: 'success', icon: 'check' }
    ])
  })
})
