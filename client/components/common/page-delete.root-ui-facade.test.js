import fs from 'node:fs'
import path from 'node:path'
import { deletePage as deletePageById } from '../../helpers/pages-api.ts'

const componentPath = path.join(process.cwd(), 'client/components/common/page-delete.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script lang='ts'>([\s\S]*?)<\/script>/)?.[1]

if (!script) {
  throw new Error('Page delete script block missing')
}

const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, '').replace('export default', 'return'))

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
  const timers = new Map()
  const classes = new Set()
  let nextTimerId = 0
  const document = {
    body: {
      classList: {
        add: (...names) => {
          for (const name of names) classes.add(name)
        },
        remove: (...names) => {
          for (const name of names) classes.delete(name)
        },
        contains: name => classes.has(name)
      }
    }
  }
  const window = {
    fetch: (url, init) => {
      requests.push({ url, init })
      return fetch(url, init)
    },
    setTimeout: callback => {
      const id = ++nextTimerId
      timers.set(id, callback)
      return id
    },
    clearTimeout: id => timers.delete(id),
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

  const runTimers = () => {
    while (timers.size > 0) {
      const [id, callback] = timers.entries().next().value
      timers.delete(id)
      callback()
    }
  }

  return { component, document, emitted, errors, loadingEvents, redirects, requests, runTimers, timers, vm, wikiStore }
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

  test('closes after success and redirects after the dialog transition', async () => {
    const harness = createHarness()

    await harness.vm.deletePage()

    expect(harness.vm.modelValue).toBe(false)
    expect(harness.emitted).toEqual([['update:modelValue', false]])
    expect(harness.redirects).toEqual([])

    harness.runTimers()

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
    expect(harness.timers.size).toBe(0)
    expect(harness.redirects).toEqual([])
  })

  test('cancels pending transition and redirect work when unmounted after deletion', async () => {
    for (const transitionStarted of [false, true]) {
      const harness = createHarness()
      await harness.vm.deletePage()
      harness.document.body.classList.add('page-deleted-pending')

      if (transitionStarted) {
        const [id, callback] = harness.timers.entries().next().value
        harness.timers.delete(id)
        callback()
        expect(harness.document.body.classList.contains('page-deleted')).toBe(true)
      }

      harness.component.beforeUnmount.call(harness.vm)
      expect(harness.timers.size).toBe(0)
      harness.runTimers()
      expect(harness.redirects).toEqual([])
      expect(harness.document.body.classList.contains('page-deleted')).toBe(false)
      expect(harness.document.body.classList.contains('page-deleted-pending')).toBe(false)
    }
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
    harness.document.body.classList.add('page-deleted-pending')

    expect(harness.vm.pageTitle).toBe('A page')
    expect(harness.vm.pagePath).toBe('a-page')
    expect(harness.vm.pageLocale).toBe('en')

    harness.vm.discard()

    expect(harness.vm.modelValue).toBe(false)
    expect(harness.emitted).toEqual([['update:modelValue', false]])
    expect(harness.document.body.classList.contains('page-deleted-pending')).toBe(false)
  })

  test('keeps the delete dialog name and description connected for assistive technology', () => {
    expect(source).toContain("aria-labelledby='page-delete-dialog-title'")
    expect(source).toContain("aria-describedby='page-delete-dialog-description'")
    expect(source).toContain('span#page-delete-dialog-title')
    expect(source).toContain('v-card-text#page-delete-dialog-description')
  })

  test('disables cancel and delete controls while deletion is pending', () => {
    const template = source.match(/<template lang='pug'>([\s\S]*?)<\/template>/)?.[1] ?? ''
    const expectDisabledWhileLoading = handler => {
      const button = template.match(new RegExp(`^\\s*v-btn\\b[^\\n]*@click='${handler}'[^\\n]*$`, 'm'))?.[0]
      expect(button).toBeDefined()
      expect(button).toContain(":disabled='loading'")
    }

    expectDisabledWhileLoading('discard')
    expectDisabledWhileLoading('deletePage')
  })
})
