import fs from 'node:fs'
import path from 'node:path'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import i18next from 'i18next'
import { afterEach, describe, expect, test } from '../../../server/test/bun-test.mts'
import { document } from '../../test/browser-dom.mts'
import { deletePage as deletePageById } from '../../helpers/pages-api.ts'

const componentPath = path.join(process.cwd(), 'client/components/common/page-delete.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script lang='ts'>([\s\S]*?)<\/script>/)?.[1]

if (!script) {
  throw new Error('Page delete script block missing')
}

const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, '').replace('export default', 'return'))

const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')
const translations = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'server/locales/en.json'), 'utf8')).common
const translator = i18next.createInstance()
await translator.init({ lng: 'en', fallbackLng: 'en', resources: { en: { common: translations } }, defaultNS: 'common' })
const compileRender = filename => {
  const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  if (errors.length || !descriptor.template) throw new Error(`Cannot parse ${filename}: ${errors}`)
  const compiled = compileTemplate({
    filename,
    id: 'page-delete-presentation-test',
    source: descriptor.template.content,
    preprocessLang: descriptor.template.lang,
    preprocessOptions: { doctype: 'html' },
    compilerOptions: { mode: 'function' }
  })
  if (compiled.errors.length) throw new Error(`Cannot compile ${filename}: ${compiled.errors}`)
  return new Function('Vue', compiled.code)(Vue)
}
const renderDialog = compileRender(componentPath)
const CardChin = { render: compileRender(path.join(process.cwd(), 'client/components/common/v-card-chin.vue')) }
const mountedDialogs = []
const settleDialog = async () => {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}

afterEach(() => {
  for (const cleanup of mountedDialogs.splice(0)) cleanup()
})

const createComponentOptions = (wikiStore, window, document) =>
  new Function('defineComponent', 'wikiStore', 'deletePageById', 'window', 'document', executableScript)(
    component => component,
    wikiStore,
    deletePageById,
    window,
    document
  )

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, resolve, reject }
}

const jsonResponse = (payload, ok = true) => ({
  ok,
  status: ok ? 200 : 409,
  headers: { get: () => 'application/json' },
  json: async () => payload
})

const createHarness = ({
  page = { id: 41, title: 'A page', path: 'a-page', locale: 'en', sourceRevision: 'revision-1' },
  fetch = async () => jsonResponse({ message: 'Page has been deleted.' })
} = {}) => {
  const requests = []
  const errors = []
  const loadingEvents = []
  const emitted = []
  const redirects = []
  const window = {
    fetch: (url, init) => {
      requests.push({ url, init })
      return fetch(url, init)
    },
    location: { assign: url => redirects.push(url) }
  }
  const wikiStore = {
    page,
    startLoading: name => loadingEvents.push(`start:${name}`),
    stopLoading: name => loadingEvents.push(`stop:${name}`),
    showError: error => errors.push(error)
  }
  const component = createComponentOptions(wikiStore, window, document)
  const vm = {
    ...component.data(),
    modelValue: true,
    $refs: {},
    $nextTick: () => Promise.resolve(),
    $t: () => 'Unexpected error',
    $emit: (event, value) => {
      emitted.push([event, value])
      if (event === 'update:modelValue') {
        vm.modelValue = value
      }
    }
  }

  for (const [name, computed] of Object.entries(component.computed)) {
    if (typeof computed === 'function') {
      Object.defineProperty(vm, name, { get: () => computed.call(vm) })
    } else {
      Object.defineProperty(vm, name, {
        get: () => computed.get.call(vm),
        set: value => computed.set.call(vm, value)
      })
    }
  }
  for (const [name, method] of Object.entries(component.methods)) {
    vm[name] = method.bind(vm)
  }

  return { component, emitted, errors, loadingEvents, redirects, requests, vm, wikiStore, window }
}

const mountDeleteDialog = async (options = {}) => {
  const harness = createHarness(options)
  const shown = Vue.ref(true)
  const component = createComponentOptions(harness.wikiStore, harness.window, document)
  component.render = renderDialog
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp({
    setup: () => () => Vue.h(component, {
      modelValue: shown.value,
      'onUpdate:modelValue': value => {
        harness.emitted.push(['update:modelValue', value])
        shown.value = value
      }
    })
  })
  app.use(createVuetify({
    components: vuetifyComponents,
    directives: vuetifyDirectives,
    defaults: { VDialog: { transition: false } }
  }))
  app.component('v-card-chin', CardChin)
  app.config.globalProperties.$t = (key, options) => translator.t(key, options)
  app.config.globalProperties.$i18n = translator
  const cleanup = () => {
    app.unmount()
    host.remove()
  }
  mountedDialogs.push(cleanup)
  app.mount(host)
  await settleDialog()
  const dialog = document.querySelector('[role="dialog"]')
  if (!dialog) throw new Error('Delete dialog did not render.')
  const button = label => {
    const control = Array.from(dialog.querySelectorAll('button')).find(candidate => candidate.textContent.trim() === label)
    if (!control) throw new Error(`Dialog control "${label}" did not render.`)
    return control
  }
  return { ...harness, dialog, button, shown, cleanup }
}

describe('page-delete component behavior', () => {
  test('deletes the current page once through the REST helper while a request is pending', async () => {
    const response = deferred()
    const harness = createHarness({ fetch: () => response.promise })
    harness.wikiStore.page = {
      id: 73,
      title: 'Current page',
      path: 'current-page',
      locale: 'fr',
      sourceRevision: 'revision-current'
    }

    const deletion = harness.vm.deletePage()
    const duplicate = harness.vm.deletePage()
    await Promise.resolve()
    const requestsWhilePending = harness.requests.length
    const loadingWhilePending = harness.vm.loading
    const loadingEventsWhilePending = [...harness.loadingEvents]
    const request = harness.requests[0]

    response.resolve(jsonResponse({ message: 'Page has been deleted.' }))
    await Promise.all([deletion, duplicate])

    expect(requestsWhilePending).toBe(1)
    expect(request.url).toBe('/_api/pages/73')
    expect(request.init.method).toBe('DELETE')
    expect(JSON.parse(request.init.body)).toEqual({ expectedSourceRevision: 'revision-current' })
    expect(request.init.signal.aborted).toBe(false)
    expect(loadingWhilePending).toBe(true)
    expect(loadingEventsWhilePending).toEqual(['start:page-delete'])

    expect(harness.loadingEvents).toEqual(['start:page-delete', 'stop:page-delete'])
    expect(harness.vm.loading).toBe(false)
  })

  test('reports a live delete failure and clears loading state', async () => {
    const harness = createHarness({
      fetch: async () => jsonResponse({ error: 'This page no longer exists.' }, false)
    })

    await harness.vm.deletePage()

    expect(harness.errors).toHaveLength(1)
    expect(harness.errors[0].message).toBe('This page no longer exists.')
    expect(harness.loadingEvents).toEqual(['start:page-delete', 'stop:page-delete'])
    expect(harness.vm.loading).toBe(false)
    expect(harness.vm.modelValue).toBe(true)
  })

  test('closes after success and returns to the home destination', async () => {
    const harness = createHarness()

    await harness.vm.deletePage()

    expect(harness.vm.modelValue).toBe(false)
    expect(harness.emitted).toEqual([['update:modelValue', false]])

    expect(harness.redirects).toEqual(['/'])
  })

  test('aborts on unmount and ignores a successful response that arrives afterward', async () => {
    const response = deferred()
    const harness = createHarness({ fetch: () => response.promise })
    const deletion = harness.vm.deletePage()
    await Promise.resolve()
    const signal = harness.requests[0].init.signal

    harness.component.beforeUnmount.call(harness.vm)

    expect(signal.aborted).toBe(true)
    response.resolve(jsonResponse({ message: 'Page has been deleted.' }))
    await deletion

    expect(harness.vm.modelValue).toBe(true)
    expect(harness.emitted).toEqual([])
    expect(harness.errors).toEqual([])
    expect(harness.redirects).toEqual([])
  })


  test('does not report a rejected delete after unmount', async () => {
    const response = deferred()
    const harness = createHarness({ fetch: () => response.promise })
    const deletion = harness.vm.deletePage()
    await Promise.resolve()

    harness.component.beforeUnmount.call(harness.vm)
    response.reject(new Error('Late network failure'))
    await deletion

    expect(harness.errors).toEqual([])
    expect(harness.redirects).toEqual([])
  })

  test('exposes current page metadata and lets the reader cancel', () => {
    const harness = createHarness()

    expect(harness.vm.pageTitle).toBe('A page')
    expect(harness.vm.pagePath).toBe('a-page')
    expect(harness.vm.pageLocale).toBe('en')

    harness.vm.discard()

    expect(harness.vm.modelValue).toBe(false)
    expect(harness.emitted).toEqual([['update:modelValue', false]])
  })

  test('keeps the delete dialog name and description connected for assistive technology', async () => {
    const mounted = await mountDeleteDialog()
    const referencedText = attribute => {
      const ids = mounted.dialog.getAttribute(attribute)?.trim().split(/\s+/) ?? []
      expect(ids.length).toBeGreaterThan(0)
      return ids.map(id => {
        const target = document.getElementById(id)
        expect(target).not.toBeNull()
        expect(mounted.dialog.contains(target)).toBe(true)
        const text = target?.textContent?.trim()
        expect(text).toBeTruthy()
        return text
      }).join(' ')
    }

    expect(referencedText('aria-labelledby')).toContain(translator.t('page.delete'))
    expect(referencedText('aria-describedby')).toContain(mounted.wikiStore.page.title)
    expect(referencedText('aria-describedby')).toContain(translator.t('page.deleteSubtitle'))
  })

  test('disables cancel and delete controls while deletion is pending', async () => {
    for (const outcome of ['success', 'failure']) {
      const response = deferred()
      const mounted = await mountDeleteDialog({ fetch: () => response.promise })
      const cancel = mounted.button(translator.t('actions.cancel'))
      const remove = mounted.button(translator.t('actions.delete'))
      expect(cancel.disabled).toBe(false)
      expect(remove.disabled).toBe(false)

      remove.click()
      await settleDialog()
      expect(mounted.requests).toHaveLength(1)
      expect(cancel.disabled).toBe(true)
      expect(remove.disabled).toBe(true)
      cancel.click()
      remove.click()
      await settleDialog()
      expect(mounted.shown.value).toBe(true)
      expect(mounted.emitted).toEqual([])
      expect(mounted.requests).toHaveLength(1)

      if (outcome === 'success') response.resolve(jsonResponse({ message: 'Page has been deleted.' }))
      else response.reject(new Error('Delete failed'))
      await settleDialog()
      if (outcome === 'success') {
        expect(mounted.shown.value).toBe(false)
        expect(mounted.emitted).toEqual([['update:modelValue', false]])
        expect(mounted.errors).toEqual([])
      } else {
        expect(mounted.shown.value).toBe(true)
        expect(mounted.errors.map(error => error.message)).toEqual(['Delete failed'])
        expect(cancel.disabled).toBe(false)
        expect(remove.disabled).toBe(false)
        cancel.click()
        await settleDialog()
        expect(mounted.shown.value).toBe(false)
      }
      mounted.cleanup()
      mountedDialogs.pop()
    }
  })
})
