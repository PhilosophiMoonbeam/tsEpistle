import fs from 'node:fs'
import path from 'node:path'

const extractMethod = (script, name) => {
  const declaration = new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?${name}\\s*\\(`)
  const found = declaration.exec(script)
  if (!found) return null

  const methodStart = found.index + (found[0][0] === '\n' ? 1 : 0)
  const bodyStart = script.indexOf('{', methodStart)
  let depth = 0
  for (let idx = bodyStart; idx < script.length; idx++) {
    if (script[idx] === '{') {
      depth++
    } else if (script[idx] === '}') {
      depth--
      if (depth === 0) return script.slice(methodStart, idx + 1).trim()
    }
  }
  return null
}

const compileMethod = (method, dependencies) => {
  const isAsync = method.startsWith('async ')
  const executable = method.replace(/^(?:async\s+)?\w+\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/, `${isAsync ? 'async ' : ''}function () {`)
  return new Function(...Object.keys(dependencies), `return (${executable})`)(...Object.values(dependencies))
}

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const cloneDeep = value => (value == null ? value : JSON.parse(JSON.stringify(value)))
const lodash = {
  cloneDeep,
  get: (object, path, fallback) => {
    const value = path.split('.').reduce((current, key) => current?.[key], object)
    return value === undefined ? fallback : value
  },
  isEqual: (left, right) => JSON.stringify(left) === JSON.stringify(right)
}

const createConfig = () => ({
  host: 'https://example.com',
  title: 'Example',
  description: 'Example site',
  robots: ['index', 'follow'],
  analyticsService: '',
  analyticsId: '',
  company: 'Example Inc.',
  contentLicense: 'ccby',
  footerOverride: '',
  banner: {
    isEnabled: true,
    title: 'Notice',
    content: 'Scheduled maintenance'
  },
  logoUrl: '/logo.svg',
  pageExtensions: 'html',
  featurePageRatings: false,
  featurePageComments: true,
  featurePersonalWikis: false,
  featureTinyPNG: true,
  editFab: true,
  editMenuBar: true,
  editMenuBtn: true,
  editMenuExternalBtn: false,
  editMenuExternalName: '',
  editMenuExternalIcon: '',
  editMenuExternalUrl: '',
  serverOnlyRevision: 7
})

const createRootUi = () => {
  const loadingEvents = []
  const errors = []
  const notifications = []
  return {
    loadingEvents,
    errors,
    notifications,
    loadingStart: (_store, key) => loadingEvents.push(['start', key]),
    loadingStop: (_store, key) => loadingEvents.push(['stop', key]),
    setLoading: (_store, key, value) => loadingEvents.push(['set', key, value]),
    pushGraphError: (_store, error) => errors.push(error),
    showNotification: (_store, notification) => notifications.push(notification)
  }
}

describe('admin-general site REST facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-general.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)[1]
  const loadConfigSource = extractMethod(script, 'loadConfig')
  const saveSource = extractMethod(script, 'save')
  const siteConfigPayload = compileMethod(extractMethod(script, 'siteConfigPayload'), { _: lodash })
  const dirty = compileMethod(extractMethod(script, 'dirty'), { _: lodash })
  const beforeUnmount = compileMethod(extractMethod(script, 'beforeUnmount'), {
    offEditorInsert: jest.fn()
  })
  const windowStub = { fetch: jest.fn() }

  const createWikiStore = () => ({
    site: {
      title: '',
      company: '',
      contentLicense: '',
      footerOverride: '',
      banner: {},
      logoUrl: ''
    },
    editor: {}
  })

  const createViewModel = overrides => {
    const viewModel = {
      config: createConfig(),
      persistedConfig: null,
      initialLoading: true,
      loaded: false,
      saving: false,
      formValid: true,
      loadRequestId: 0,
      saveRequestId: 0,
      siteTitle: '',
      company: '',
      contentLicense: '',
      footerOverride: '',
      logoUrl: '',
      siteConfigPayload,
      handleEditorInsert: jest.fn(),
      $t: key => key,
      ...overrides
    }
    Object.defineProperty(viewModel, 'dirty', {
      get: () => dirty.call(viewModel)
    })
    return viewModel
  }

  const compileLoadConfig = (rootUi, wikiStore, fetchSiteConfig) =>
    compileMethod(loadConfigSource, {
      _: lodash,
      fetchSiteConfig,
      setLoading: rootUi.setLoading,
      pushGraphError: rootUi.pushGraphError,
      wikiStore,
      window: windowStub
    })

  const compileSave = (rootUi, wikiStore, saveSiteConfig) =>
    compileMethod(saveSource, {
      _: lodash,
      titleRegex: /[<>"]/i,
      saveSiteConfig,
      loadingStart: rootUi.loadingStart,
      loadingStop: rootUi.loadingStop,
      pushGraphError: rootUi.pushGraphError,
      showNotification: rootUi.showNotification,
      wikiStore,
      window: windowStub
    })

  test('uses typed site REST and root UI facades without restoring Apollo', () => {
    expect(loadConfigSource).not.toBeNull()
    expect(saveSource).not.toBeNull()
    expect(script).toContain("import { fetchSiteConfig, saveSiteConfig, type SiteConfig } from '../../helpers/site-api'")
    expect(script).toContain("import { loadingStart, loadingStop, pushGraphError, setLoading, showNotification } from '../../helpers/root-ui-store'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).not.toMatch(/graphql-tag|this\.\$apollo|apollo\s*:/)
  })

  test('both apply controls submit the owned valid form', () => {
    expect(source).toContain('v-form#general-form(')
    expect(source).toContain("@submit.prevent='save'")
    expect(source).toContain("v-model='formValid'")
    expect(source.match(/type='submit'\s+form='general-form'/g) || []).toHaveLength(2)
    expect(source).not.toContain("@click='save'")
  })

  test('loads a cloned response while snapshotting only the projected editable config', async () => {
    const response = createConfig()
    const rootUi = createRootUi()
    const wikiStore = createWikiStore()
    const fetchSiteConfig = jest.fn(async () => response)
    const loadConfig = compileLoadConfig(rootUi, wikiStore, fetchSiteConfig)
    const viewModel = createViewModel()

    await loadConfig.call(viewModel)

    expect(fetchSiteConfig).toHaveBeenCalledWith(expect.any(Function))
    expect(viewModel.config).toEqual(response)
    expect(viewModel.config).not.toBe(response)
    expect(viewModel.config.banner).not.toBe(response.banner)
    expect(viewModel.persistedConfig).toEqual(viewModel.siteConfigPayload())
    expect(viewModel.persistedConfig).not.toHaveProperty('serverOnlyRevision')
    expect(viewModel.persistedConfig).not.toHaveProperty('featureTinyPNG')
    expect(viewModel.loaded).toBe(true)
    expect(viewModel.initialLoading).toBe(false)
    expect(viewModel.dirty).toBe(false)

    viewModel.config.serverOnlyRevision++
    expect(viewModel.dirty).toBe(false)
    viewModel.config.host = 'https://changed.example.com'
    expect(viewModel.dirty).toBe(true)
    expect(rootUi.errors).toEqual([])
    expect(rootUi.loadingEvents).toEqual([
      ['set', 'admin-site-refresh', true],
      ['set', 'admin-site-refresh', false]
    ])
  })

  test('surfaces an active load error and releases initial loading', async () => {
    const failure = new Error('site config failed')
    const rootUi = createRootUi()
    const wikiStore = createWikiStore()
    const loadConfig = compileLoadConfig(rootUi, wikiStore, async () => {
      throw failure
    })
    const viewModel = createViewModel()

    await loadConfig.call(viewModel)

    expect(viewModel.loaded).toBe(false)
    expect(viewModel.initialLoading).toBe(false)
    expect(viewModel.persistedConfig).toBeNull()
    expect(rootUi.errors).toEqual([failure])
    expect(rootUi.loadingEvents).toEqual([
      ['set', 'admin-site-refresh', true],
      ['set', 'admin-site-refresh', false]
    ])
  })

  test('ignores a load response after unmount while balancing refresh loading', async () => {
    const request = deferred()
    const rootUi = createRootUi()
    const wikiStore = createWikiStore()
    const loadConfig = compileLoadConfig(rootUi, wikiStore, () => request.promise)
    const viewModel = createViewModel()

    const loading = loadConfig.call(viewModel)
    beforeUnmount.call(viewModel)
    request.resolve(createConfig())
    await loading

    expect(viewModel.loaded).toBe(false)
    expect(viewModel.persistedConfig).toBeNull()
    expect(viewModel.initialLoading).toBe(true)
    expect(rootUi.errors).toEqual([])
    expect(rootUi.loadingEvents).toEqual([
      ['set', 'admin-site-refresh', true],
      ['set', 'admin-site-refresh', false]
    ])
  })

  test('saves the projected payload, clears dirty state, and updates the public site snapshot', async () => {
    const rootUi = createRootUi()
    const wikiStore = createWikiStore()
    const saveSiteConfig = jest.fn(async () => undefined)
    const save = compileSave(rootUi, wikiStore, saveSiteConfig)
    const viewModel = createViewModel({
      initialLoading: false,
      loaded: true
    })
    viewModel.persistedConfig = cloneDeep(viewModel.siteConfigPayload())
    viewModel.config.title = 'Changed title'
    viewModel.config.company = 'Changed Inc.'
    expect(viewModel.dirty).toBe(true)

    await save.call(viewModel)

    const payload = saveSiteConfig.mock.calls[0][1]
    expect(payload).toEqual(viewModel.siteConfigPayload())
    expect(payload).not.toHaveProperty('serverOnlyRevision')
    expect(payload).not.toHaveProperty('featureTinyPNG')
    expect(viewModel.persistedConfig).toEqual(payload)
    expect(viewModel.persistedConfig).not.toBe(payload)
    expect(viewModel.dirty).toBe(false)
    expect(viewModel.saving).toBe(false)
    expect(viewModel.siteTitle).toBe('Changed title')
    expect(viewModel.company).toBe('Changed Inc.')
    expect(viewModel.contentLicense).toBe(viewModel.config.contentLicense)
    expect(viewModel.footerOverride).toBe(viewModel.config.footerOverride)
    expect(viewModel.logoUrl).toBe(viewModel.config.logoUrl)
    expect(wikiStore.site.banner).toEqual(viewModel.config.banner)
    expect(wikiStore.site.banner).not.toBe(viewModel.config.banner)
    expect(rootUi.notifications).toEqual([
      {
        style: 'success',
        message: 'admin:general.saveSuccess',
        icon: 'check'
      }
    ])
    expect(rootUi.errors).toEqual([])
    expect(rootUi.loadingEvents).toEqual([
      ['start', 'admin-site-update'],
      ['stop', 'admin-site-update']
    ])
  })

  test('keeps dirty state and reports an active save error after releasing save loading', async () => {
    const failure = new Error('save failed')
    const rootUi = createRootUi()
    const wikiStore = createWikiStore()
    const save = compileSave(rootUi, wikiStore, async () => {
      throw failure
    })
    const viewModel = createViewModel({
      initialLoading: false,
      loaded: true
    })
    viewModel.persistedConfig = cloneDeep(viewModel.siteConfigPayload())
    viewModel.config.company = 'Unsaved Inc.'

    await save.call(viewModel)

    expect(viewModel.dirty).toBe(true)
    expect(viewModel.saving).toBe(false)
    expect(rootUi.errors).toEqual([failure])
    expect(rootUi.notifications).toEqual([])
    expect(rootUi.loadingEvents).toEqual([
      ['start', 'admin-site-update'],
      ['stop', 'admin-site-update']
    ])
  })

  test('does not submit an invalid title or settle a save after unmount', async () => {
    const rootUi = createRootUi()
    const wikiStore = createWikiStore()
    const request = deferred()
    const saveSiteConfig = jest.fn(() => request.promise)
    const save = compileSave(rootUi, wikiStore, saveSiteConfig)
    const viewModel = createViewModel({
      initialLoading: false,
      loaded: true
    })
    viewModel.persistedConfig = cloneDeep(viewModel.siteConfigPayload())
    viewModel.config.title = '<invalid>'

    await save.call(viewModel)
    expect(saveSiteConfig).not.toHaveBeenCalled()
    expect(rootUi.notifications).toEqual([
      {
        style: 'error',
        message: 'admin:general.siteTitleInvalidChars',
        icon: 'alert'
      }
    ])
    expect(rootUi.loadingEvents).toEqual([])

    rootUi.notifications.length = 0
    viewModel.config.title = 'Valid but stale'
    const saving = save.call(viewModel)
    beforeUnmount.call(viewModel)
    request.resolve()
    await saving

    expect(viewModel.persistedConfig.title).toBe('Example')
    expect(viewModel.siteTitle).toBe('')
    expect(rootUi.notifications).toEqual([])
    expect(rootUi.errors).toEqual([])
    expect(rootUi.loadingEvents).toEqual([
      ['start', 'admin-site-update'],
      ['stop', 'admin-site-update']
    ])
  })
})
