import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { compileTemplate } from '@vue/compiler-sfc'
import { browserWindow, document } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
import { searchPages } from '../../helpers/pages-api.ts'
import { pageHref } from '../../helpers/admin-pages.ts'

const source = fs.readFileSync('client/components/admin/admin-search.vue', 'utf8')
const script = source.match(/<script lang='ts'>([\s\S]*?)<\/script>/)[1]
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, '').replace('export default', 'return'))
const engine = () => ({ key: 'postgres', title: 'PostgreSQL', isEnabled: true, isAvailable: true, config: [{ key: 'dictLanguage', value: { value: 'english' } }] })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const inspectionStatus = dictionary => ({
  engine: 'postgres',
  inspection: {
    checkedAt: '2026-10-05T00:00:00.000Z',
    publicPages: 1,
    indexedPages: 1,
    missingPages: 0,
    stalePages: 0,
    excludedEntries: 0,
    configuredDictionary: dictionary,
    indexedDictionary: dictionary,
    schemaVersion: 1,
    expectedSchemaVersion: 1
  }
})

function harness() {
  const fetchEngines = vi.fn(async () => [engine()])
  const saveEngines = vi.fn(async () => ({ message: 'saved' }))
  const inspectIndex = vi.fn(async () => ({ engine: 'postgres', inspection: null }))
  const rebuildIndex = vi.fn(async () => ({ message: 'rebuilt' }))
  const options = new Function('AdminSearchEvaluate', 'fetchSearchEngines', 'saveSearchEngines', 'rebuildSearchIndex', 'inspectSearchIndex', 'wikiStore', 'getErrorMessage', 'loadingStart', 'loadingStop', 'showNotification', 'pushGraphError', executable)(
    {}, fetchEngines, saveEngines, rebuildIndex, inspectIndex, {}, (error) => error.message, vi.fn(), vi.fn(), vi.fn(), vi.fn()
  )
  const instance = { ...options.data(), $t: (key) => key }
  for (const [key, value] of Object.entries(options.methods)) { if (typeof value === 'function') instance[key] = value.bind(instance) }
  for (const [key, value] of Object.entries(options.computed)) { if (typeof value === 'function') Object.defineProperty(instance, key, { get: value.bind(instance) }) }
  return { instance, fetchEngines, saveEngines, rebuildIndex, inspectIndex, options }
}

const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')
const mounted = []
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) { app.unmount(); host.remove() }
})
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await Vue.nextTick() }
const evaluatorSource = fs.readFileSync('client/components/admin/admin-search-evaluate.vue', 'utf8')
const evaluatorScript = evaluatorSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const evaluatorExecutable = new Bun.Transpiler({ loader: 'ts' }).transformSync(evaluatorScript.replace(/^import .*$/gm, '')) +
  '\nreturn { query, locale, path, canEvaluate, submitted, loading, error, result, rows, elapsedMs, matchFieldLabel, evaluate, pageHref }'
const setupEvaluator = new Function('computed', 'ref', 'shallowRef', 'onBeforeUnmount', 'searchPages', 'pageHref', 'useTranslate', 'window', evaluatorExecutable)
const evaluatorTemplate = compileTemplate({
  source: evaluatorSource.match(/<template>([\s\S]*?)<\/template>\s*<script/)[1],
  filename: 'admin-search-evaluate.vue',
  id: 'admin-search-evaluator-workflow',
  compilerOptions: { mode: 'function' }
})
if (evaluatorTemplate.errors.length) throw evaluatorTemplate.errors[0]
const evaluatorRender = new Function('Vue', evaluatorTemplate.code)(Vue)
const searchResult = (results = [], nextCursor = null) => ({ results, suggestions: [], totalHits: results.length, nextCursor })
const jsonResponse = payload => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
const pageRow = (id, visibility = 'public') => ({
  id,
  title: `Guide ${id}`,
  description: '',
  path: `guides/${id}`,
  locale: 'en',
  visibility,
  tags: [],
  score: 1,
  matchedFields: ['title']
})
function evaluatorHarness(fetchImpl = vi.fn(async () => jsonResponse(searchResult()))) {
  let state
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp({
    setup() {
      state = setupEvaluator(Vue.computed, Vue.ref, Vue.shallowRef, Vue.onBeforeUnmount, searchPages, pageHref, () => translateEnglish, { fetch: fetchImpl })
      return state
    },
    render: evaluatorRender
  })
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
  app.config.globalProperties.$t = translateEnglish
  app.mount(host)
  mounted.push({ app, host })
  return { state, host, fetchImpl }
}

describe('search administration drafts', () => {
  it('requires a change before saving and resets a draft without mutating its baseline', async () => {
    const { instance, saveEngines } = harness()
    await instance.loadEngines()
    expect(instance.canSave).toBe(false)
    await instance.save()
    expect(saveEngines).not.toHaveBeenCalled()
    instance.engine.config[0].value.value = 'simple'
    expect(instance.dirty).toBe(true)
    expect(instance.canSave).toBe(true)
    expect(instance.savedEngines[0].config[0].value.value).toBe('english')
    instance.resetDraft()
    expect(instance.engine.config[0].value.value).toBe('english')
    expect(instance.dirty).toBe(false)
  })

  it('retains a failed save as a dirty draft and does not refresh it away', async () => {
    const { instance, fetchEngines, saveEngines } = harness()
    await instance.loadEngines()
    instance.engine.config[0].value.value = 'simple'
    saveEngines.mockRejectedValueOnce(new Error('Connection failed'))
    await instance.save()
    expect(instance.dirty).toBe(true)
    expect(instance.operationError).toBe('Connection failed')
    expect(instance.saving).toBe(false)
    await instance.refresh()
    expect(fetchEngines).toHaveBeenCalledTimes(1)
  })

  it('requires an explicit decision before leaving a dirty configuration', async () => {
    const { instance, options } = harness()
    await instance.loadEngines()
    expect(options.beforeRouteLeave.call(instance)).toBe(true)
    instance.engine.config[0].value.value = 'simple'
    const pending = options.beforeRouteLeave.call(instance)
    instance.finishLeave(false)
    expect(await pending).toBe(false)
    expect(instance.dirty).toBe(true)
  })

  it('does not call an unsupported inspection healthy', async () => {
    const { instance, inspectIndex } = harness()
    await instance.inspect()
    expect(inspectIndex).not.toHaveBeenCalled()
    await instance.loadEngines()
    await instance.inspect()
    expect(instance.inspectionUnsupported).toBe(true)
    expect(inspectIndex).toHaveBeenCalledOnce()
    expect(instance.indexAligned).toBe(false)
    await instance.loadEngines()
    expect(instance.inspectionUnsupported).toBe(false)
    expect(instance.inspection).toBeNull()
  })

  for (const oldOutcome of ['resolve', 'reject']) {
    it(`clears the inspection on reload and ignores its stale ${oldOutcome} without ending a fresh inspection`, async () => {
      const { instance, fetchEngines, inspectIndex } = harness()
      await instance.loadEngines()
      inspectIndex.mockResolvedValueOnce(inspectionStatus('english'))
      await instance.inspect()
      expect(instance.indexAligned).toBe(true)

      const old = deferred()
      const reload = deferred()
      const fresh = deferred()
      inspectIndex.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
      fetchEngines.mockReturnValueOnce(reload.promise)
      const inspectingOld = instance.inspect()
      const oldController = instance.inspectController
      const reloading = instance.loadEngines()
      expect(oldController.signal.aborted).toBe(true)
      expect(instance.inspection).toBeNull()
      expect(instance.inspectedEngine).toBe('')
      expect(instance.inspectionUnsupported).toBe(false)
      expect(instance.indexAligned).toBe(false)
      expect(instance.inspecting).toBe(false)
      await instance.inspect()
      expect(inspectIndex).toHaveBeenCalledTimes(2)

      reload.resolve([engine()])
      await reloading
      const inspectingFresh = instance.inspect()
      const freshController = instance.inspectController
      if (oldOutcome === 'resolve') old.resolve(inspectionStatus('obsolete'))
      else old.reject(new Error('Obsolete inspection failed'))
      await inspectingOld
      expect(instance.inspection).toBeNull()
      expect(instance.inspectionError).toBe('')
      expect(instance.inspecting).toBe(true)
      expect(instance.inspectController).toBe(freshController)

      const status = inspectionStatus('english')
      fresh.resolve(status)
      await inspectingFresh
      expect(instance.inspection).toBe(status.inspection)
      expect(instance.indexAligned).toBe(true)
      expect(instance.inspecting).toBe(false)
      expect(instance.inspectController).toBeNull()
    })
  }

  for (const operation of ['save', 'rebuild']) {
    for (const oldOutcome of ['resolve', 'reject']) {
      it(`invalidates inspection ${oldOutcome} and its finalizer after a successful ${operation}`, async () => {
        const { instance, fetchEngines, saveEngines, rebuildIndex, inspectIndex } = harness()
        await instance.loadEngines()
        const old = deferred()
        const mutation = deferred()
        const fresh = deferred()
        inspectIndex.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
        if (operation === 'save') {
          instance.engine.config[0].value.value = 'simple'
          fetchEngines.mockResolvedValueOnce([{ ...engine(), config: [{ key: 'dictLanguage', value: { value: 'simple' } }] }])
          saveEngines.mockReturnValueOnce(mutation.promise)
        } else {
          rebuildIndex.mockReturnValueOnce(mutation.promise)
        }

        const inspectingOld = instance.inspect()
        const oldController = instance.inspectController
        expect(instance.inspecting).toBe(true)
        const mutating = instance[operation]()
        expect(oldController.signal.aborted).toBe(true)
        expect(instance.inspecting).toBe(false)
        await instance.inspect()
        expect(inspectIndex).toHaveBeenCalledTimes(1)
        mutation.resolve()
        await mutating
        expect(instance.inspection).toBeNull()
        expect(instance.inspectionUnsupported).toBe(false)
        expect(instance.inspectionError).toBe('')
        expect(instance.saving).toBe(false)
        expect(instance.rebuilding).toBe(false)

        const inspectingFresh = instance.inspect()
        const freshController = instance.inspectController
        expect(freshController).not.toBe(oldController)
        if (oldOutcome === 'resolve') old.resolve(inspectionStatus('english'))
        else old.reject(new Error('Obsolete inspection failed'))
        await inspectingOld
        expect(instance.inspection).toBeNull()
        expect(instance.inspectionError).toBe('')
        expect(instance.inspecting).toBe(true)
        expect(instance.inspectController).toBe(freshController)

        const status = inspectionStatus(operation === 'save' ? 'simple' : 'english')
        fresh.resolve(status)
        await inspectingFresh
        expect(instance.inspection).toBe(status.inspection)
        expect(instance.indexAligned).toBe(true)
        expect(instance.inspecting).toBe(false)
        expect(instance.inspectController).toBeNull()
      })
    }
  }
})

describe('search query evaluation', () => {
  it('allows 256 characters but blocks 257 at both the form and method boundaries', async () => {
    const { state, host, fetchImpl } = evaluatorHarness()
    const input = host.querySelector('input')
    const button = host.querySelector('button[type="submit"]')
    expect(input.maxLength).toBe(256)
    input.value = 'x'.repeat(256)
    input.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
    await settle()
    expect(button.disabled).toBe(false)
    host.querySelector('form').dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, options] = fetchImpl.mock.calls[0]
    const params = new URL(url, 'http://localhost').searchParams
    expect(params.get('query')).toBe('x'.repeat(256))
    expect(params.has('locale')).toBe(false)
    expect(params.has('path')).toBe(false)
    expect(params.get('paginated')).toBe('true')
    expect(options.credentials).toBe('same-origin')
    expect(state.loading.value).toBe(false)
    expect(state.error.value).toBe('')
    const acceptedResult = state.result.value

    // DOM assignment bypasses native maxlength, as programmatic input can.
    input.value = 'x'.repeat(257)
    input.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
    await settle()
    expect(button.disabled).toBe(true)
    await state.evaluate()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(state.submitted.value.query).toBe('x'.repeat(256))
    expect(state.result.value).toBe(acceptedResult)
    expect(state.loading.value).toBe(false)
    expect(state.error.value).toBe('')
  })

  it('validates the trimmed query and handles cleared or whitespace input without a request', async () => {
    const { state, fetchImpl } = evaluatorHarness()
    state.query.value = ` ${'x'.repeat(256)} `
    await state.evaluate()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(new URL(fetchImpl.mock.calls[0][0], 'http://localhost').searchParams.get('query')).toBe('x'.repeat(256))
    for (const query of [` ${'x'.repeat(257)} `, null, '   ']) {
      state.query.value = query
      expect(state.canEvaluate.value).toBe(false)
      await state.evaluate()
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('uses the submitted scope for cursors despite edited invalid input and preserves private links and unique rows', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(searchResult([pageRow(1, 'private')], 'next-page')))
      .mockResolvedValueOnce(jsonResponse(searchResult([pageRow('1', 'private'), pageRow(2)])))
    const { state, host } = evaluatorHarness(fetchImpl)
    state.query.value = ' optical '
    state.locale.value = ' en '
    state.path.value = ' guides '
    await state.evaluate()
    state.query.value = 'x'.repeat(257)
    state.locale.value = 'fr'
    state.path.value = 'other'
    await state.evaluate('next-page')
    await settle()

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const params = new URL(fetchImpl.mock.calls[1][0], 'http://localhost').searchParams
    expect(params.get('query')).toBe('optical')
    expect(params.get('locale')).toBe('en')
    expect(params.get('path')).toBe('guides')
    expect(params.get('cursor')).toBe('next-page')
    expect(state.submitted.value).toEqual({ query: 'optical', locale: 'en', path: 'guides' })
    expect(state.rows.value.map(row => row.id)).toEqual([1, 2])
    expect(host.querySelector('.query-results a').getAttribute('href')).toBe('/_private/en/guides/1')
  })

  it('retains the loading guard, reports request errors, and clears them on a successful retry', async () => {
    const request = deferred()
    const fetchImpl = vi.fn()
      .mockReturnValueOnce(request.promise)
      .mockResolvedValueOnce(jsonResponse(searchResult()))
    const { state, host } = evaluatorHarness(fetchImpl)
    state.query.value = 'optical'
    const pending = state.evaluate()
    await settle()
    expect(state.loading.value).toBe(true)
    expect(host.querySelector('button[type="submit"]').disabled).toBe(true)
    await state.evaluate()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    request.reject(new Error('Permission denied'))
    await pending
    expect(state.loading.value).toBe(false)
    expect(state.error.value).toBe('Permission denied')
    expect(state.result.value).toBeNull()

    await state.evaluate()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(state.loading.value).toBe(false)
    expect(state.error.value).toBe('')
    expect(state.result.value).not.toBeNull()
  })
})
