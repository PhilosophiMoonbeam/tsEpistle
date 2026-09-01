import fs from 'node:fs'
import path from 'node:path'

const extractScript = source => {
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const extractMethod = (script, name) => {
  const methodStart = script.search(new RegExp('async\\s+' + name + '\\s*\\('))
  if (methodStart === -1) {
    return null
  }

  const bodyStart = script.indexOf('{', methodStart)
  let depth = 0
  for (let idx = bodyStart; idx < script.length; idx++) {
    if (script[idx] === '{') {
      depth++
    } else if (script[idx] === '}') {
      depth--
      if (depth === 0) {
        return script.slice(methodStart, idx + 1)
      }
    }
  }

  return null
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

const compileMethod = (method, dependencies) => {
  const executable = method.replace(/^async\s+\w+\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/, 'async function () {')
  return new Function(...Object.keys(dependencies), `return (${executable})`)(...Object.values(dependencies))
}

const createWikiStore = () => {
  const loadingEvents = []
  const notifications = []
  const errors = []
  return {
    loadingEvents,
    notifications,
    errors,
    store: {
      startLoading: id => loadingEvents.push(['start', id]),
      stopLoading: id => loadingEvents.push(['stop', id]),
      showNotification: notification => notifications.push(notification),
      showError: error => errors.push(error)
    }
  }
}

describe('admin-api REST mutation migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-api.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const globalSwitchSource = script && extractMethod(script, 'globalSwitch')
  const revokeConfirmSource = script && extractMethod(script, 'revokeConfirm')
  const windowStub = { fetch: () => {} }

  test('uses typed REST helpers without restoring inline GraphQL mutations', () => {
    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bfetchAdminApiBootstrap\b)(?=[^}]*\brevokeAdminApiKey\b)(?=[^}]*\bsetAdminApiState\b)(?=[^}]*\btype AdminApiKey\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/auth-api['"]/
    )
    expect(script).toContain("import { getErrorMessage } from '../../helpers/root-ui-store'")
    expect(script).toMatch(/keys:\s*\[\]\s+as\s+AdminApiKey\[\]/)
    expect(script).toMatch(/current:\s*null\s+as\s+AdminApiKey\s*\|\s*null/)
    expect(script).toMatch(/revoke\s*\(\s*key:\s*AdminApiKey\s*\)/)
    expect(script).not.toContain('graphql-tag')
    expect(script).not.toContain('this.$apollo.mutate')
    expect(script).not.toContain('mutation: gql`')
    expect(script).not.toMatch(/\bsetApiState\s*\(/)
    expect(script).not.toMatch(/\brevokeApiKey\s*\(/)
  })

  test('globalSwitch serializes toggles and refreshes before reporting REST success', async () => {
    const mutation = deferred()
    const mutationCalls = []
    const refreshCalls = []
    const wiki = createWikiStore()
    const globalSwitch = compileMethod(globalSwitchSource, {
      setAdminApiState: (fetchImplementation, enabled) => {
        mutationCalls.push({ fetchImplementation, enabled })
        return mutation.promise
      },
      wikiStore: wiki.store,
      window: windowStub
    })
    const viewModel = {
      enabled: false,
      isToggleLoading: false,
      revokeLoading: false,
      loadState: 'success',
      refresh: async notify => {
        refreshCalls.push(notify)
        return true
      },
      $t: key => key
    }

    const firstToggle = globalSwitch.call(viewModel)
    await globalSwitch.call(viewModel)

    expect(mutationCalls).toHaveLength(1)
    expect(mutationCalls[0].enabled).toBe(true)
    expect(typeof mutationCalls[0].fetchImplementation).toBe('function')
    expect(viewModel.isToggleLoading).toBe(true)
    mutation.resolve()
    await firstToggle

    expect(refreshCalls).toEqual([false])
    expect(wiki.notifications).toEqual([
      {
        style: 'success',
        message: 'admin:api.toggleStateEnabledSuccess',
        icon: 'check'
      }
    ])
    expect(wiki.errors).toEqual([])
    expect(wiki.loadingEvents).toEqual([
      ['start', 'admin-api-toggle'],
      ['stop', 'admin-api-toggle']
    ])
    expect(viewModel.isToggleLoading).toBe(false)
  })

  test('globalSwitch retains state guards and always releases loading after REST errors', async () => {
    let mutationCalls = 0
    const failure = new Error('toggle failed')
    const wiki = createWikiStore()
    const globalSwitch = compileMethod(globalSwitchSource, {
      setAdminApiState: async () => {
        mutationCalls++
        throw failure
      },
      wikiStore: wiki.store,
      window: windowStub
    })
    const viewModel = {
      enabled: true,
      isToggleLoading: false,
      revokeLoading: true,
      loadState: 'success',
      refresh: async () => true,
      $t: key => key
    }

    await globalSwitch.call(viewModel)
    expect(mutationCalls).toBe(0)

    viewModel.revokeLoading = false
    viewModel.loadState = 'error'
    await globalSwitch.call(viewModel)
    expect(mutationCalls).toBe(0)

    viewModel.loadState = 'success'
    await globalSwitch.call(viewModel)
    expect(mutationCalls).toBe(1)
    expect(wiki.errors).toEqual([failure])
    expect(wiki.notifications).toEqual([])
    expect(wiki.loadingEvents).toEqual([
      ['start', 'admin-api-toggle'],
      ['stop', 'admin-api-toggle']
    ])
    expect(viewModel.isToggleLoading).toBe(false)
  })

  test('revokeConfirm guards missing and concurrent selections, then refreshes before notifying', async () => {
    const mutation = deferred()
    const revokeCalls = []
    const refreshCalls = []
    const wiki = createWikiStore()
    const revokeConfirm = compileMethod(revokeConfirmSource, {
      revokeAdminApiKey: (fetchImplementation, id) => {
        revokeCalls.push({ fetchImplementation, id })
        return mutation.promise
      },
      wikiStore: wiki.store,
      window: windowStub
    })
    const viewModel = {
      current: null,
      revokeLoading: false,
      isRevokeConfirmDialogShown: true,
      refresh: async notify => {
        refreshCalls.push(notify)
        return true
      },
      $t: key => key
    }

    await revokeConfirm.call(viewModel)
    expect(revokeCalls).toEqual([])
    expect(wiki.loadingEvents).toEqual([])

    viewModel.current = { id: 42, name: 'deployment' }
    const firstRevoke = revokeConfirm.call(viewModel)
    await revokeConfirm.call(viewModel)
    expect(revokeCalls).toHaveLength(1)
    expect(revokeCalls[0].id).toBe(42)
    expect(typeof revokeCalls[0].fetchImplementation).toBe('function')
    expect(viewModel.revokeLoading).toBe(true)

    mutation.resolve()
    await firstRevoke

    expect(refreshCalls).toEqual([false])
    expect(wiki.notifications).toEqual([
      {
        style: 'success',
        message: 'admin:api.revokeSuccess',
        icon: 'check'
      }
    ])
    expect(wiki.errors).toEqual([])
    expect(wiki.loadingEvents).toEqual([
      ['start', 'admin-api-revoke'],
      ['stop', 'admin-api-revoke']
    ])
    expect(viewModel.isRevokeConfirmDialogShown).toBe(false)
    expect(viewModel.revokeLoading).toBe(false)
  })

  test('revokeConfirm reports REST failures and closes the guarded operation cleanly', async () => {
    const failure = new Error('revoke failed')
    const wiki = createWikiStore()
    const revokeConfirm = compileMethod(revokeConfirmSource, {
      revokeAdminApiKey: async () => {
        throw failure
      },
      wikiStore: wiki.store,
      window: windowStub
    })
    const viewModel = {
      current: { id: 7, name: 'broken' },
      revokeLoading: false,
      isRevokeConfirmDialogShown: true,
      refresh: async () => {
        throw new Error('failed revocation must not refresh')
      },
      $t: key => key
    }

    await revokeConfirm.call(viewModel)

    expect(wiki.errors).toEqual([failure])
    expect(wiki.notifications).toEqual([])
    expect(wiki.loadingEvents).toEqual([
      ['start', 'admin-api-revoke'],
      ['stop', 'admin-api-revoke']
    ])
    expect(viewModel.isRevokeConfirmDialogShown).toBe(false)
    expect(viewModel.revokeLoading).toBe(false)
  })
})
