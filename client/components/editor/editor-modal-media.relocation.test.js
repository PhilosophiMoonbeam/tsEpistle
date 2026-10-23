import fs from 'node:fs'
import path from 'node:path'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import * as cheerio from 'cheerio'
import pug from 'pug'
import sharp from 'sharp'
import * as lodash from 'lodash-es'
import { isSafeEditorImageSource, isValidEditorImageAlt, normalizeEditorImageDimension } from '../../helpers/editor-image-properties'
import { describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, document } from '../../test/browser-dom.mts'
import { createModalFocusScope } from '../common/modal-focus-scope'

import { translateEnglish } from '../../test/english-translate.mts'
const componentPath = path.join(process.cwd(), 'client/components/editor/editor-modal-media.vue')

const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')

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
    _: lodash,
    createAssetFolder: async () => undefined,
    createModalFocusScope: () => ({ deactivate: () => undefined }),
    defineComponent: value => value,
    deleteAssetRequest: async () => undefined,
    emitEditorInsert: () => undefined,
    fetchAssetBranding: async () => undefined,
    fetchAssetFolders: fetchAssetFolders ?? (async () => []),
    fetchAssets: fetchAssets ?? (async () => []),
    isRecord: value => typeof value === 'object' && value !== null,
    isSafeEditorImageSource,
    isValidEditorImageAlt,
    normalizeEditorImageDimension,
    markRaw: value => value,
    relocateAssetRequest,
    vueFilePond: () => ({ render: () => null }),
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

const createHarness = ({ waitForRelocation, fetchAssets, fetchAssetFolders } = {}) => {
  const notifications = []
  const errors = []
  const loading = []
  const wikiStore = Vue.reactive({
    startLoading: owner => loading.push(`start:${owner}`),
    stopLoading: owner => loading.push(`stop:${owner}`),
    showError: error => errors.push(error),
    showNotification: notification => notifications.push(notification),
    user: { authenticated: true, id: 7 },
    offlineIdentityEpoch: 0,
    editor: {
      editorKey: 'markdown',
      media: {
        currentFileId: 7,
        currentFolderId: 0,
        folderTree: []
      }
    },
    page: { id: 42, locale: 'en', path: 'media', visibility: 'public' }
  })
  const relocationCalls = []
  const component = loadMediaComponent({
    relocateAssetRequest: async (_fetch, assetId, input) => {
      relocationCalls.push({ assetId, input })
      return receiptFor('pending')
    },
    wikiStore,
    window: {
      fetch: async () => undefined,
      setTimeout: browserWindow.setTimeout.bind(browserWindow),
      clearTimeout: browserWindow.clearTimeout.bind(browserWindow)
    },
    fetchAssets,
    fetchAssetFolders
  })
  const asset = { id: 7, filename: 'old.png', folderId: 0 }
  const context = {
    ...component.data.call({ $t: translateEnglish }),
    $t: translateEnglish,
    actionMenuAssetId: 7,
    assets: [asset],
    currentAsset: asset,
    currentFileId: 7,
    currentFolderId: 0,
    disposed: false,
    loadedFolderId: 0,
    loadedFolderPath: '',
    folderTree: [],
    isRenameValid: true,
    relocationFolderId: 0,
    renameAssetName: 'new.png',
    wikiStore
  }
  for (const [name, method] of Object.entries(component.methods)) context[name] = method.bind(context)
  context.waitForRelocation = waitForRelocation ?? (async receipt => receipt)
  Object.defineProperty(context, 'relocationStatusMessage', {
    configurable: true,
    get: () => component.computed.relocationStatusMessage.call(context)
  })
  return { component, context, errors, loading, notifications, relocationCalls }
}

describe('editor media relocation admission state', () => {
  test('invalidates the old path before polling and keeps a pending poll result stale without resubmitting', async () => {
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
    expect(harness.notifications.map(notification => notification.style)).toEqual(['info', 'warning'])
    expect(harness.relocationCalls).toHaveLength(1)

    harness.context.currentFileId = 7
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
    await harness.context.relocateAsset()

    expect(mediaController.signal.aborted).toBe(true)
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
    expect(harness.notifications.map(notification => notification.style)).toEqual(['info'])
    expect(harness.relocationCalls).toHaveLength(1)
  })

  test('allows a successful canonical refresh to clear stale state and report success', async () => {
    const succeeded = { ...receiptFor('succeeded'), effects: [{ id: 'effect-1', targetKey: 'page-1', status: 'succeeded', lastError: null }] }
    const harness = createHarness({
      waitForRelocation: async () => succeeded,
      fetchAssets: async () => [{ id: 7, filename: 'new.png', folderId: 0 }],
      fetchAssetFolders: async () => []
    })

    await harness.context.relocateAsset()

    expect(harness.context.relocationReceipt).toEqual(succeeded)
    expect(harness.context.staleAssetIds).toEqual([])
    expect(harness.context.currentFileId).toBeNull()
    expect(harness.context.assets[0].filename).toBe('new.png')
    expect(harness.notifications.map(notification => notification.style)).toEqual(['info', 'success'])

    const refreshError = new Error('canonical asset refresh unavailable')
    const failedRefresh = createHarness({
      waitForRelocation: async () => succeeded,
      fetchAssets: async () => {
        throw refreshError
      },
      fetchAssetFolders: async () => []
    })
    const oldAssets = failedRefresh.context.assets

    await failedRefresh.context.relocateAsset()

    expect(failedRefresh.context.relocationReceipt).toEqual(succeeded)
    expect(failedRefresh.context.assets).toBe(oldAssets)
    expect(failedRefresh.context.assets[0].filename).toBe('old.png')
    expect(failedRefresh.context.staleAssetIds).toEqual([7])
    expect(failedRefresh.context.currentFileId).toBeNull()
    expect(failedRefresh.context.isAssetActionable(7)).toBe(false)
    expect(failedRefresh.errors).toEqual([refreshError])
    expect(failedRefresh.notifications.map(notification => notification.style)).toEqual(['info'])
  })
})

describe('editor media upload and thumbnails', () => {
  test('builds encoded thumbnail URLs, file icons and folder-aware insert paths', () => {
    const { context } = createHarness()
    context.loadedFolderPath = 'brand kit'
    expect(context.assetPath({ filename: 'logo mark.png' })).toBe('/brand kit/logo mark.png')
    expect(context.assetUrl({ filename: 'logo mark.png' })).toBe('/brand%20kit/logo%20mark.png')
    expect(context.assetIcon({ kind: 'BINARY', ext: '.PDF' })).toBe('mdi-file-pdf-box')
    expect(context.assetIcon({ kind: 'BINARY', ext: '.bin' })).toBe('mdi-file-outline')
    const asset = { id: 5, filename: 'broken.png' }
    context.assets = [asset]
    const image = document.createElement('img')
    image.setAttribute('src', context.assetUrl(asset))
    context.markThumbnailFailed(asset, { currentTarget: image })
    context.markThumbnailFailed(asset, { currentTarget: image })
    expect(context.failedThumbnailUrls).toEqual({ 5: '/brand%20kit/broken.png' })
  })

  test('counts staged files and runs one upload at a time', async () => {
    const { context } = createHarness({ fetchAssets: async () => [], fetchAssetFolders: async () => [] })
    context.syncQueuedFiles([{}, {}])
    expect(context.queuedFileCount).toBe(2)
    let release
    let processCalls = 0
    context.$refs = {
      pond: {
        getFiles: () => [{ setMetadata: () => undefined }],
        processFiles: () => {
          processCalls++
          return new Promise(resolve => {
            release = resolve
          })
        }
      }
    }
    context.loadMedia = async () => true
    const first = context.upload()
    expect(context.uploading).toBe(true)
    await context.upload()
    expect(processCalls).toBe(1)
    release([])
    await first
    expect(context.uploading).toBe(false)
  })
})

describe('standalone shared asset workspace', () => {
  const compileComponentRender = filename => {
    const descriptor = parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor
    const compiled = compileTemplate({
      source: descriptor.template.content,
      filename,
      id: filename,
      preprocessLang: descriptor.template.lang,
      preprocessOptions: { doctype: 'html' },
      compilerOptions: { mode: 'function' }
    })
    if (compiled.errors.length) throw compiled.errors[0]
    return new Function('Vue', compiled.code)(Vue)
  }
  const mountManager = async (purpose, options = {}) => {
    const rootAsset = { id: 7, filename: 'shared-logo.png', folderId: 0, kind: 'IMAGE', ext: '.png', fileSize: 80, createdAt: '2026-01-01T00:00:00Z', description: '' }
    const folderAsset = { ...rootAsset, id: 8, filename: 'folder-logo.png', folderId: 3 }
    const { component, context } = createHarness({
      fetchAssets: options.fetchAssets ?? (async (_fetch, folderId) => folderId === 0 ? [rootAsset] : [folderAsset]),
      fetchAssetFolders: options.fetchAssetFolders ?? (async (_fetch, folderId) => folderId === 0 ? [{ id: 3, name: 'logos', slug: 'logos' }] : [])
    })
    context.wikiStore.page.visibility = 'private'
    context.wikiStore.editor.activeModal = 'editorModalMedia'
    context.wikiStore.editor.media = {
      currentFolderId: 91,
      currentFileId: 92,
      folderTree: [{ id: 91, name: 'editor-folder', slug: 'editor-folder' }]
    }
    const before = structuredClone({ page: Vue.toRaw(context.wikiStore.page), editor: Vue.toRaw(context.wikiStore.editor) })
    if (options.filePondComponent) component.components.FilePond = options.filePondComponent
    if (options.filePondServerOpts) component.computed.filePondServerOpts = () => options.filePondServerOpts
    const app = Vue.createApp({ ...component, render: compileComponentRender(componentPath) }, { purpose, embedded: true })
    app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
    app.component('VCardChin', Vue.defineComponent({
      render: compileComponentRender(path.join(process.cwd(), 'client/components/common/v-card-chin.vue'))
    }))
    app.component('i18next', Vue.defineComponent({
      props: { tag: { type: String, default: 'div' } },
      setup: (props, { slots }) => () => Vue.h(props.tag, slots.default?.())
    }))
    app.config.globalProperties.$t = translateEnglish
    app.config.globalProperties.$helpers = { formatMoment: () => 'recently' }
    const root = document.body.appendChild(document.createElement('div'))
    const model = app.mount(root)
    await vi.waitFor(() => expect(model.loading).toBe(false))
    return { app, root, model, store: context.wikiStore, before }
  }

  test('opens shared assets at root, navigates folders independently and exposes management without editor insertion', async () => {
    const { app, root, model, store, before } = await mountManager('manage')
    try {
      expect(root.textContent).toContain('shared-logo.png')
      expect(model.currentFolderId).toBe(0)
      expect(root.querySelector('.editor-media-upload-header')).not.toBeNull()
      expect(root.querySelector('.editor-media-actions')).toBeNull()
      model.selectAsset(7)
      await Vue.nextTick()
      expect(model.currentAsset.filename).toBe('shared-logo.png')
      expect(root.querySelector('textarea')).toBeNull()
      expect(model.isResizableAsset(model.currentAsset)).toBe(true)
      model.insert()
      model.cancel()
      root.querySelector('.editor-media-folder').click()
      await vi.waitFor(() => expect(root.textContent).toContain('folder-logo.png'))
      expect(model.assetPath(model.currentAsset ?? model.assets[0])).toBe('/logos/folder-logo.png')
      const parent = root.querySelector('.editor-media-folders .editor-media-icon-button')
      parent.click()
      await vi.waitFor(() => expect(root.textContent).toContain('shared-logo.png'))
      expect(model.currentFolderId).toBe(0)
      expect({ page: store.page, editor: store.editor }).toEqual(before)
    } finally {
      app.unmount()
      root.remove()
    }
  })

  test('retains both raster files while the native FilePond queue waits for each upload acknowledgment', async () => {
    const objectUrlDescriptor = Object.getOwnPropertyDescriptor(browserWindow.URL, 'createObjectURL')
    const globalDescriptors = ['CustomEvent', 'FileReader', 'File', 'Blob'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
    Object.defineProperty(browserWindow.URL, 'createObjectURL', { configurable: true, value: () => 'blob:asset-upload-fixture' })
    Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, value: browserWindow.CustomEvent })
    Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: browserWindow.FileReader })
    Object.defineProperty(globalThis, 'File', { configurable: true, value: browserWindow.File })
    Object.defineProperty(globalThis, 'Blob', { configurable: true, value: browserWindow.Blob })
    // FilePond detects browser support at import time, after this fixture installs its browser APIs.
    const { default: vueFilePond } = await import('vue-filepond')
    const started = []
    const accepted = []
    const acknowledgments = []
    let active = 0
    let maximumActive = 0
    const { app, root, model } = await mountManager('manage', {
      filePondComponent: vueFilePond(),
      fetchAssets: async () => [...accepted],
      filePondServerOpts: {
        process: (_fieldName, file, metadata, load, error) => {
          active++
          maximumActive = Math.max(maximumActive, active)
          started.push({ filename: file.name, folderId: metadata.folderId })
          if (active > 1) {
            active--
            error('Asset location is still being reconciled.')
            return { abort: () => undefined }
          }
          acknowledgments.push(() => {
            active--
            accepted.push({ id: accepted.length + 1, filename: file.name, folderId: 0, kind: 'IMAGE', ext: file.name.endsWith('.png') ? '.png' : '.jpg', fileSize: file.size, createdAt: '2026-01-01T00:00:00Z' })
            load('ok')
          })
          return { abort: () => undefined }
        }
      }
    })
    try {
      const raster = sharp({ create: { width: 2, height: 2, channels: 3, background: '#236fa1' } })
      const png = await raster.clone().png().toBuffer()
      const jpeg = await raster.clone().jpeg().toBuffer()
      const pond = model.$refs.pond
      await pond.addFiles([
        new browserWindow.File([png], 'first.png', { type: 'image/png' }),
        new browserWindow.File([jpeg], 'second.jpg', { type: 'image/jpeg' })
      ])
      await Vue.nextTick()
      await vi.waitFor(() => expect(model.queuedFileCount).toBe(2))
      root.querySelector('.editor-media-upload-action').click()
      await vi.waitFor(() => expect(started).toHaveLength(1), { timeout: 5_000 })
      expect(accepted).toHaveLength(0)
      expect(model.uploading).toBe(true)
      acknowledgments.shift()()
      await vi.waitFor(() => expect(started).toHaveLength(2), { timeout: 5_000 })
      expect(accepted.map(asset => asset.filename)).toEqual(['first.png'])
      acknowledgments.shift()()
      await vi.waitFor(() => expect(model.uploading).toBe(false), { timeout: 5_000 })
      await vi.waitFor(() => expect(root.textContent).toContain('second.jpg'))
      expect(maximumActive).toBe(1)
      expect(started).toEqual([{ filename: 'first.png', folderId: 0 }, { filename: 'second.jpg', folderId: 0 }])
      expect(model.assets.map(asset => asset.filename)).toEqual(['first.png', 'second.jpg'])
      expect(root.textContent).toContain('first.png')
    } finally {
      app.unmount()
      root.remove()
      if (objectUrlDescriptor) Object.defineProperty(browserWindow.URL, 'createObjectURL', objectUrlDescriptor)
      else Reflect.deleteProperty(browserWindow.URL, 'createObjectURL')
      for (const [name, descriptor] of globalDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    }
  }, 15_000)

  test('never renders old rows under a new folder prefix and fences late loads and image errors', async () => {
    const rootAsset = { id: 7, filename: 'root.png', folderId: 0, kind: 'IMAGE', ext: '.png', fileSize: 80, createdAt: '2026-01-01T00:00:00Z' }
    let childAsset = { ...rootAsset, id: 8, filename: 'child.png', folderId: 3 }
    const deferred = Promise.withResolvers()
    let deferChild = true
    const { app, root, model } = await mountManager('manage', {
      fetchAssets: async (_fetch, id) => {
        if (id === 0) return [{ ...rootAsset }]
        if (deferChild) return deferred.promise
        return [{ ...childAsset }]
      }
    })
    try {
      const originalImage = root.querySelector('.editor-media-thumb img')
      expect(originalImage.getAttribute('src')).toBe('/root.png')
      root.querySelector('.editor-media-folder').click()
      await Vue.nextTick()
      expect(root.querySelector('.editor-media-thumb img')).toBeNull()
      originalImage.dispatchEvent(new browserWindow.Event('error'))
      expect(model.failedThumbnailUrls).toEqual({})
      root.querySelector('.editor-media-folders .editor-media-icon-button').click()
      await vi.waitFor(() => expect(root.querySelector('.editor-media-thumb img')?.getAttribute('src')).toBe('/root.png'))
      deferred.resolve([{ ...childAsset }])
      await Vue.nextTick()
      await Vue.nextTick()
      expect(model.assets[0].filename).toBe('root.png')
      deferChild = false
      root.querySelector('.editor-media-folder').click()
      await vi.waitFor(() => expect(root.querySelector('.editor-media-thumb img')?.getAttribute('src')).toBe('/logos/child.png'))
      const failedImage = root.querySelector('.editor-media-thumb img')
      failedImage.dispatchEvent(new browserWindow.Event('error'))
      await Vue.nextTick()
      expect(root.querySelector('.editor-media-thumb img')).toBeNull()
      await model.refresh()
      await Vue.nextTick()
      expect(root.querySelector('.editor-media-thumb img')).toBeNull()
      childAsset = { ...childAsset, filename: 'renamed.png' }
      await model.refresh()
      await Vue.nextTick()
      expect(root.querySelector('.editor-media-thumb img')?.getAttribute('src')).toBe('/logos/renamed.png')
      failedImage.dispatchEvent(new browserWindow.Event('error'))
      await Vue.nextTick()
      expect(root.querySelector('.editor-media-thumb img')?.getAttribute('src')).toBe('/logos/renamed.png')
    } finally {
      deferred.resolve([])
      app.unmount()
      root.remove()
    }
  })

  test('renders current, ancestor, child and root destinations with canonical rename paths and authoritative receipts', async () => {
    const image = { id: 8, filename: 'copy.png', folderId: 4, kind: 'IMAGE', ext: '.png', fileSize: 80, createdAt: '2026-01-01T00:00:00Z' }
    const parent = { id: 3, name: 'Brand Assets', slug: 'brand-assets' }
    const nested = { id: 4, name: 'Logos', slug: 'logos' }
    const child = { id: 5, name: 'Icons', slug: 'icons' }
    const { app, root, model } = await mountManager('manage', {
      fetchAssets: async (_fetch, id) => id === 4 ? [{ ...image }] : [],
      fetchAssetFolders: async (_fetch, id) => id === 0 ? [parent] : id === 3 ? [nested] : [child]
    })
    try {
      model.downFolder(parent)
      await vi.waitFor(() => expect(model.loadedFolderId).toBe(3))
      model.downFolder(nested)
      await vi.waitFor(() => expect(root.textContent).toContain('copy.png'))
      model.openRenameDialog(8)
      model.renameAssetName = 'renamed.png'
      await Vue.nextTick()
      expect(model.relocationFolderItems).toEqual([
        { title: '/', value: 0, path: '' },
        { title: '/Brand Assets', value: 3, path: 'brand-assets' },
        { title: '/Brand Assets/Logos', value: 4, path: 'brand-assets/logos' },
        { title: '/Brand Assets/Logos/Icons', value: 5, path: 'brand-assets/logos/icons' }
      ])
      await vi.waitFor(() => expect(document.body.textContent).toContain('brand-assets/logos/copy.png → brand-assets/logos/renamed.png'))
      const dialog = document.querySelector('[aria-labelledby="editor-media-rename-title"]')
      expect(dialog.textContent).toContain('/Brand Assets/Logos')
      model.relocationFolderId = 3
      await Vue.nextTick()
      expect(dialog.textContent).toContain('brand-assets/logos/copy.png → brand-assets/renamed.png')
      model.relocationFolderId = 5
      await Vue.nextTick()
      expect(dialog.textContent).toContain('brand-assets/logos/icons/renamed.png')
      model.relocationFolderId = 0
      await Vue.nextTick()
      expect(dialog.textContent).toContain('brand-assets/logos/copy.png → renamed.png')
      model.relocationReceipt = receiptFor('succeeded')
      await Vue.nextTick()
      expect(dialog.textContent).toContain('old.png → new.png')
    } finally {
      app.unmount()
      root.remove()
    }
  })

  test('keeps private-page editor uploads prohibited and preserves insertion controls', async () => {
    const { app, root, model } = await mountManager('insert')
    try {
      expect(root.querySelector('.editor-media-upload-header')).toBeNull()
      expect(root.querySelectorAll('input[type="file"]')).toHaveLength(0)
      expect(root.querySelector('.editor-media-actions')).not.toBeNull()
      await expect(model.upload()).rejects.toThrow(translateEnglish('editor:editorModalMedia.assetsSiteWideCannot'))
      model.selectAsset(8)
      await Vue.nextTick()
      expect(model.currentAsset?.id).toBe(8)
      expect(root.querySelector('textarea')).not.toBeNull()
    } finally {
      app.unmount()
      root.remove()
    }
  })
})

describe('editor media teleported controls', () => {
  test('keeps the native alignment menu actionable without releasing the modal background', async () => {
    const descriptor = parse(fs.readFileSync(componentPath, 'utf8'), { filename: componentPath }).descriptor
    const markup = cheerio.load(pug.render(descriptor.template.content))
    const alignment = markup('v-select[label="Image alignment"]')
    expect(alignment).toHaveLength(1)
    // Exercise the production invocation and Vuetify teleport, not a copied menu configuration.
    const compiled = compileTemplate({
      source: alignment.toString(),
      filename: componentPath,
      id: 'media-alignment-focus-scope',
      compilerOptions: { mode: 'function' }
    })
    if (compiled.errors.length) throw compiled.errors[0]
    const { context } = createHarness()
    const background = document.body.appendChild(document.createElement('button'))
    const root = document.body.appendChild(document.createElement('div'))
    root.tabIndex = -1
    const app = Vue.createApp({
      data: () => ({ imageAlignment: context.imageAlignment, imageAlignments: context.imageAlignments }),
      render: new Function('Vue', compiled.code)(Vue)
    })
    app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
    app.config.globalProperties.$t = translateEnglish
    const model = app.mount(root)
    const scope = createModalFocusScope({
      root,
      restoreTarget: background,
      additionalRoots: context.mediaModalAdditionalRoots,
      onEscape: () => undefined
    })
    try {
      await Vue.nextTick()
      const field = root.querySelector('.v-field')
      expect(field).not.toBeNull()
      field.dispatchEvent(new browserWindow.MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      field.dispatchEvent(new browserWindow.MouseEvent('mouseup', { bubbles: true }))
      field.click()
      let centered
      await vi.waitFor(() => {
        centered = Array.from(document.querySelectorAll('[role="option"]')).find(option => option.textContent.trim() === 'Centered')
        expect(centered).toBeDefined()
        expect(centered.closest('.v-overlay').inert).not.toBe(true)
        expect(centered.closest('[aria-hidden="true"]')).toBeNull()
        expect(background.inert).toBe(true)
      })
      centered.click()
      await vi.waitFor(() => expect(model.imageAlignment).toBe('center'))
    } finally {
      scope.deactivate({ restoreFocus: false })
      app.unmount()
      root.remove()
      background.remove()
    }
  })
})
