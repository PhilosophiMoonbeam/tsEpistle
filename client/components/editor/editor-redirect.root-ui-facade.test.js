import fs from 'node:fs'
import path from 'node:path'

const componentPath = path.join(process.cwd(), 'client/components/editor/editor-redirect.vue')
const source = fs.readFileSync(componentPath, 'utf8')

const loadRedirectComponent = dependencies => {
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  expect(match).not.toBeNull()
  const script = match[1].replace(/^import[^\n]*(?:\n|$)/gm, '').replace('export default {', 'const component = {')
  const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script)
  return new Function(...Object.keys(dependencies), `${executable}\nreturn component`)(...Object.values(dependencies))
}

const createRedirectHarness = ({
  groups = [],
  mode = 'update',
  fetchGroupOptions,
  getErrorMessage = error => (error instanceof Error ? error.message : String(error)),
  markRaw = value => value
} = {}) => {
  const wikiStore = {
    editor: {
      content: 'existing content',
      editorKey: '',
      mode
    },
    page: {
      locale: 'en',
      path: 'docs/start'
    }
  }
  const fetchCalls = []
  const loadingCalls = []
  const component = loadRedirectComponent({
    AbortController,
    AsyncState: {},
    fetchGroupOptions:
      fetchGroupOptions ??
      (async fetcher => {
        await fetcher('/api/groups/options', { method: 'GET' })
        return groups
      }),
    getErrorMessage,
    markRaw,
    setLoading: (_store, key, loading) => loadingCalls.push([key, loading]),
    wikiStore,
    window: {
      fetch: async (url, init) => {
        fetchCalls.push([url, init])
        return { ok: true }
      }
    }
  })
  const context = {
    ...component.data(),
    ...component.methods,
    mode
  }

  return { component, context, fetchCalls, loadingCalls, wikiStore }
}

describe('editor redirect REST migration guard', () => {
  test('loads a raw group snapshot through an abortable request and balances root loading state', async () => {
    const groups = [
      { id: 1, name: 'Editors' },
      { id: 2, name: 'Guests' }
    ]
    const rawValues = []
    const harness = createRedirectHarness({
      groups,
      markRaw: value => {
        rawValues.push(value)
        return value
      }
    })

    await harness.context.loadGroups()

    expect(harness.fetchCalls).toHaveLength(1)
    expect(harness.fetchCalls[0][0]).toBe('/api/groups/options')
    expect(harness.fetchCalls[0][1]).toMatchObject({ method: 'GET' })
    expect(harness.fetchCalls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(harness.context.groups).toBe(groups)
    expect(rawValues).toContain(groups)
    expect(harness.context.groupsError).toBe('')
    expect(harness.context.groupsLoading).toBe(false)
    expect(harness.context.groupsAbortController).toBeNull()
    expect(harness.loadingCalls).toEqual([
      ['editor-redirect-groups', true],
      ['editor-redirect-groups', false]
    ])
  })

  test('publishes a truthful empty group snapshot and error when the REST request fails', async () => {
    const emptySnapshots = []
    const harness = createRedirectHarness({
      fetchGroupOptions: async () => {
        throw new Error('Groups unavailable')
      },
      markRaw: value => {
        if (Array.isArray(value) && value.length === 0) emptySnapshots.push(value)
        return value
      }
    })

    await harness.context.loadGroups()

    expect(harness.context.groups).toBe(emptySnapshots.at(-1))
    expect(harness.context.groups).toEqual([])
    expect(harness.context.groupsError).toBe('Groups unavailable')
    expect(harness.context.groupsLoading).toBe(false)
    expect(harness.context.groupsAbortController).toBeNull()
    expect(harness.loadingCalls).toEqual([
      ['editor-redirect-groups', true],
      ['editor-redirect-groups', false]
    ])
  })

  test('aborts group loading and clears the root loading lease before unmount', async () => {
    let resolveGroups
    const groupsResponse = new Promise(resolve => {
      resolveGroups = resolve
    })
    const harness = createRedirectHarness({
      fetchGroupOptions: async fetcher => {
        await fetcher('/api/groups/options', { method: 'GET' })
        return groupsResponse
      }
    })

    const loading = harness.context.loadGroups()
    const controller = harness.context.groupsAbortController
    harness.component.beforeUnmount.call(harness.context)

    expect(controller.signal.aborted).toBe(true)
    expect(harness.context.groupsAbortController).toBeNull()
    expect(harness.context.groupsLoading).toBe(false)
    expect(harness.loadingCalls).toEqual([
      ['editor-redirect-groups', true],
      ['editor-redirect-groups', false]
    ])

    resolveGroups([{ id: 1, name: 'Editors' }])
    await loading
    expect(harness.context.groups).toEqual([])
    expect(harness.loadingCalls).toHaveLength(2)
  })

  test('initializes redirect editing and creates stable, independent conditional rules', async () => {
    const harness = createRedirectHarness({ mode: 'create' })

    await harness.component.mounted.call(harness.context)
    harness.context.addConditionalRule()
    harness.context.addConditionalRule()

    expect(harness.wikiStore.editor.editorKey).toBe('redirect')
    expect(harness.wikiStore.editor.content).toBe('<h1>Title</h1>\n\n<p>Some text here</p>')
    expect(harness.context.conditionalRules).toEqual([
      {
        key: 0,
        groups: [],
        mode: 'page',
        url: 'https://'
      },
      {
        key: 1,
        groups: [],
        mode: 'page',
        url: 'https://'
      }
    ])
    expect(harness.context.conditionalRules[0].groups).not.toBe(harness.context.conditionalRules[1].groups)
    expect(harness.context.nextRuleKey).toBe(2)
  })
})
