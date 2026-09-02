import fs from 'node:fs'
import path from 'node:path'

const extractBlock = (source, startIndex, openingBraceIndex) => {
  const bodyStart = openingBraceIndex === undefined ? source.indexOf('{', startIndex) : openingBraceIndex

  if (bodyStart === -1) {
    return null
  }

  let depth = 0

  for (let idx = bodyStart; idx < source.length; idx++) {
    if (source[idx] === '{') {
      depth++
    } else if (source[idx] === '}') {
      depth--

      if (depth === 0) {
        return source.slice(startIndex, idx + 1)
      }
    }
  }

  return null
}

const extractMethod = (script, name) => {
  const methodStart = script.search(new RegExp(`async\\s+${name}\\s*\\(`))

  if (methodStart === -1) {
    return null
  }

  const paramsStart = script.indexOf('(', methodStart)
  let paramsDepth = 0
  let bodyStart = -1

  for (let idx = paramsStart; idx < script.length; idx++) {
    if (script[idx] === '(') {
      paramsDepth++
    } else if (script[idx] === ')') {
      paramsDepth--

      if (paramsDepth === 0) {
        bodyStart = script.indexOf('{', idx)
        break
      }
    }
  }

  if (bodyStart === -1) {
    return null
  }

  return extractBlock(script, methodStart, bodyStart)
}

const executeMethodBody = (method, context, dependencies) => {
  const paramsEnd = method.indexOf(')')
  const bodyStart = method.indexOf('{', paramsEnd)
  const body = method.slice(bodyStart + 1, -1)
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

  return new AsyncFunction(...Object.keys(dependencies), body).call(context, ...Object.values(dependencies))
}

describe('admin-analytics root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-analytics.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]
  const computedStart = script ? script.search(/\bcomputed\s*:/) : -1
  const computedBlock = computedStart >= 0 ? extractBlock(script, computedStart) : null
  const loadProviders = script && extractMethod(script, 'loadProviders')
  const retryLoad = script && extractMethod(script, 'retryLoad')
  const refresh = script && extractMethod(script, 'refresh')
  const save = script && extractMethod(script, 'save')
  const beforeUnmountStart = script ? script.search(/\bbeforeUnmount\s*\(/) : -1
  const beforeUnmount = beforeUnmountStart >= 0 ? extractBlock(script, beforeUnmountStart) : null
  const directRootUiCommit =
    /\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-analytics.vue keeps its REST/error facades, retry path, action busy state, and provider selection', () => {
    expect(script).not.toBeNull()
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(computedBlock).not.toBeNull()

    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bgetErrorMessage\b)(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bfetchAnalyticsProviders\b)(?=[^}]*\bsaveAnalyticsProviders\b)(?=[^}]*\btype\s+AnalyticsProvider\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/analytics-api['"]/
    )
    expect(source).toMatch(/async-state\(v-if=['"]loading['"],?\s+state=['"]loading['"]/)
    expect(source).toMatch(/async-state\(v-else-if=['"]errorMessage['"],?\s+state=['"]error['"][^)]*@retry=['"]retryLoad['"]/)
    expect(source).toMatch(/:loading=['"]refreshing['"][\s\S]*?:disabled=['"]refreshing \|\| saving['"]/)
    expect(source).toMatch(/:loading=['"]saving['"][\s\S]*?:disabled=['"]!canSave['"]/)
    expect(script).toMatch(/canSave\s*\(\s*\)\s*:\s*boolean\s*\{[\s\S]*?!this\.loading\s*&&\s*!this\.refreshing\s*&&\s*!this\.saving/)
    expect(computedBlock).toMatch(
      /provider\s*\(\s*\)\s*:\s*Partial<AnalyticsProvider>\s*\{\s*return\s+this\.providers\.find\s*\(\s*provider\s*=>\s*provider\.key\s*===\s*this\.selectedProvider\s*\)\s*\|\|\s*\{\s*\}\s*\}/
    )
    expect(loadProviders).toMatch(
      /const\s+selected\s*=\s*providers\.find\s*\(\s*provider\s*=>\s*provider\.key\s*===\s*this\.selectedProvider\s*&&\s*provider\.isAvailable\s*\)\s*\|\|[\s\S]*?providers\.find\s*\(\s*provider\s*=>\s*provider\.isAvailable\s*&&\s*provider\.isEnabled\s*\)\s*\|\|[\s\S]*?providers\.find\s*\(\s*provider\s*=>\s*provider\.isAvailable\s*\)[\s\S]*?this\.providers\s*=\s*providers[\s\S]*?this\.selectedProvider\s*=\s*selected\?\.key\s*\|\|\s*['"]['"]/
    )
    expect(retryLoad).toMatch(/await\s+this\.loadProviders\s*\(\s*\)\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/)
  })

  test('loadProviders owns truthful load/refresh/error state while preserving fetch, notification, rethrow, and cleanup', () => {
    expect(loadProviders).not.toBeNull()

    expect(loadProviders).toMatch(
      /this\.loadController\?\.abort\s*\(\s*\)[\s\S]*?const\s+controller\s*=\s*new\s+AbortController\s*\(\s*\)[\s\S]*?this\.loadController\s*=\s*controller/
    )
    expect(loadProviders).toMatch(
      /this\.loading\s*=\s*true[\s\S]*?this\.errorMessage\s*=\s*['"]{2}[\s\S]*?this\.refreshing\s*=\s*notifyError[\s\S]*?loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-analytics-refresh['"]\s*\)/
    )
    expect(loadProviders).toMatch(
      /const\s+providers\s*=\s*await\s+fetchAnalyticsProviders\s*\(\s*createAbortableFetch\s*\(\s*controller\.signal\s*\)\s*,\s*['"]Analytics providers response is invalid['"]\s*\)/
    )
    expect(loadProviders).toMatch(
      /if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s+false\s*\}[\s\S]*?this\.providers\s*=\s*providers[\s\S]*?return\s+true/
    )
    expect(loadProviders).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s+false\s*\}[\s\S]*?this\.errorMessage\s*=\s*getErrorMessage\s*\(\s*err\s*\)\s*\|\|\s*this\.\$t\s*\(\s*['"]common:error\.unexpected['"]\s*\)[\s\S]*?if\s*\(\s*notifyError\s*\)[\s\S]*?showNotification\s*\([\s\S]*?throw\s+err/
    )
    expect(loadProviders).toMatch(
      /finally\s*\{\s*if\s*\(\s*this\.loadController\s*===\s*controller\s*\)\s*\{[\s\S]*?this\.loadController\s*=\s*null[\s\S]*?if\s*\(\s*!this\.isUnmounted\s*\)\s*\{[\s\S]*?this\.loading\s*=\s*false[\s\S]*?this\.refreshing\s*=\s*false[\s\S]*?\}[\s\S]*?\}[\s\S]*?loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-analytics-refresh['"]\s*\)/
    )
    expect(loadProviders).not.toMatch(directRootUiCommit)

    expect(loadProviders.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadProviders.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadProviders.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('overlapping loads abort the old request and only the latest generation can commit or clear busy state', async () => {
    const requests = []
    const wikiStore = {}
    const loadingStart = jest.fn()
    const loadingStop = jest.fn()
    const showNotification = jest.fn()
    const fetchAnalyticsProviders = jest.fn(
      abortableFetch =>
        new Promise((resolve, reject) => {
          requests.push({ resolve, reject, signal: abortableFetch.signal })
        })
    )
    const dependencies = {
      notifyError: true,
      AbortController,
      createAbortableFetch: signal => ({ signal }),
      loadingStart,
      wikiStore,
      fetchAnalyticsProviders,
      showNotification,
      getErrorMessage: err => err.message,
      loadingStop
    }
    const context = {
      $t: key => key,
      providers: [],
      selectedProvider: '',
      loadController: null,
      loading: false,
      errorMessage: '',
      refreshing: false,
      isUnmounted: false
    }

    const staleLoad = executeMethodBody(loadProviders, context, dependencies)
    const staleController = context.loadController
    const latestLoad = executeMethodBody(loadProviders, context, dependencies)

    expect(staleController.signal.aborted).toBe(true)
    expect(requests).toHaveLength(2)

    requests[0].resolve([{ key: 'stale', isAvailable: true, isEnabled: true }])
    await expect(staleLoad).resolves.toBe(false)
    expect(context.providers).toEqual([])
    expect(context.loading).toBe(true)
    expect(context.refreshing).toBe(true)

    requests[1].resolve([
      { key: 'disabled', isAvailable: false, isEnabled: true },
      { key: 'latest', isAvailable: true, isEnabled: false }
    ])
    await expect(latestLoad).resolves.toBe(true)

    expect(context.providers.map(provider => provider.key)).toEqual(['disabled', 'latest'])
    expect(context.selectedProvider).toBe('latest')
    expect(context.loading).toBe(false)
    expect(context.refreshing).toBe(false)
    expect(context.loadController).toBeNull()
    expect(showNotification).not.toHaveBeenCalled()
    expect(loadingStart).toHaveBeenCalledTimes(2)
    expect(loadingStop).toHaveBeenCalledTimes(2)
  })

  test('refresh rejects overlapping actions, settles failures, and reports success only after reload', () => {
    expect(refresh).not.toBeNull()

    expect(refresh).toMatch(/if\s*\(\s*this\.refreshing\s*\|\|\s*this\.saving\s*\)\s*return/)
    expect(refresh).toMatch(
      /try\s*\{\s*const\s+loaded\s*=\s*await\s+this\.loadProviders\s*\(\s*\)\s*if\s*\(\s*!loaded\s*\)\s*return\s*\}\s*catch\s*\{\s*return\s*\}/
    )
    expect(refresh).toMatch(
      /showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*this\.\$t\s*\(\s*['"]admin:analytics\.refreshSuccess['"]\s*\)\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)/
    )
    expect(refresh.indexOf('await this.loadProviders()')).toBeLessThan(refresh.indexOf('showNotification'))
    expect(refresh).not.toMatch(directRootUiCommit)

    expect(refresh.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
  })

  test('rejected refresh reports once, balances loading, emits no success, and resolves', async () => {
    const events = []
    const wikiStore = {}
    const loadingStart = jest.fn(() => events.push('loading:start'))
    const loadingStop = jest.fn(() => events.push('loading:stop'))
    const showNotification = jest.fn((store, notification) => events.push(`notification:${notification.style}`))
    const context = {
      $t: key => key,
      providers: [],
      loadController: null,
      loading: false,
      errorMessage: '',
      refreshing: false,
      isUnmounted: false
    }

    context.loadProviders = () =>
      executeMethodBody(loadProviders, context, {
        notifyError: true,
        AbortController,
        createAbortableFetch: jest.fn(),
        loadingStart,
        wikiStore,
        fetchAnalyticsProviders: jest.fn().mockRejectedValue(new Error('refresh failed')),
        showNotification,
        getErrorMessage: err => err.message,
        loadingStop
      })

    const handlerPromise = executeMethodBody(refresh, context, { showNotification, wikiStore })

    await expect(handlerPromise).resolves.toBeUndefined()
    expect(events).toEqual(['loading:start', 'notification:red', 'loading:stop'])
    expect(loadingStart).toHaveBeenCalledWith(wikiStore, 'admin-analytics-refresh')
    expect(loadingStop).toHaveBeenCalledWith(wikiStore, 'admin-analytics-refresh')
    expect(showNotification).toHaveBeenCalledTimes(1)
    expect(showNotification).toHaveBeenCalledWith(wikiStore, {
      message: 'refresh failed',
      style: 'red',
      icon: 'alert'
    })
  })

  test('save preserves the action guard, REST payload, silent reload success gate, error facade, and balanced busy state', () => {
    expect(save).not.toBeNull()

    expect(save).toMatch(
      /if\s*\(\s*!this\.canSave\s*\)\s*return[\s\S]*?const\s+controller\s*=\s*new\s+AbortController\s*\(\s*\)[\s\S]*?this\.saveController\s*=\s*controller[\s\S]*?this\.saving\s*=\s*true[\s\S]*?loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-analytics-saveproviders['"]\s*\)/
    )
    expect(save).toMatch(
      /saveAnalyticsProviders\s*\(\s*createAbortableFetch\s*\(\s*controller\.signal\s*\)\s*,[\s\S]*?['"]Analytics providers save response is invalid['"]\s*\)/
    )
    expect(save).toMatch(
      /this\.providers\.map\s*\(\s*provider\s*=>\s*\(\s*\{\s*isEnabled:\s*provider\.isEnabled\s*,\s*key:\s*provider\.key\s*,\s*config:\s*provider\.config\.map\s*\(\s*cfg\s*=>\s*\(\s*\{\s*\.\.\.cfg\s*,\s*value:\s*JSON\.stringify\s*\(\s*\{\s*v:\s*cfg\.value\.value\s*\}\s*\)\s*\}\s*\)\s*\)\s*\}\s*\)\s*\)/
    )
    expect(save).toMatch(
      /if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s*\}\s*await\s+this\.loadProviders\s*\(\s*\{\s*notifyError:\s*false\s*\}\s*\)\s*if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s*\}[\s\S]*?showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*this\.\$t\s*\(\s*['"]admin:analytics\.saveSuccess['"]\s*\)\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/
    )
    expect(save).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*!controller\.signal\.aborted\s*\)\s*\{\s*pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)\s*\}\s*\}/
    )
    expect(save).toMatch(
      /finally\s*\{\s*if\s*\(\s*this\.saveController\s*===\s*controller\s*\)\s*\{\s*this\.saveController\s*=\s*null\s*if\s*\(\s*!this\.isUnmounted\s*\)\s*\{\s*this\.saving\s*=\s*false\s*\}\s*\}[\s\S]*?loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-analytics-saveproviders['"]\s*\)/
    )
    expect(save).not.toMatch(/this\.\$apollo\.mutate|providersSaveMutation|analytics-mutation-save-providers\.gql/)
    expect(save).not.toMatch(directRootUiCommit)

    expect(save.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bsaveAnalyticsProviders\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('teardown marks the component stale and cancels both in-flight lifecycle owners', async () => {
    expect(beforeUnmount).not.toBeNull()
    expect(beforeUnmount).toMatch(/this\.isUnmounted\s*=\s*true[\s\S]*?this\.loadController\?\.abort\s*\(\s*\)[\s\S]*?this\.saveController\?\.abort\s*\(\s*\)/)

    const loadController = { abort: jest.fn() }
    const saveController = { abort: jest.fn() }
    const context = {
      isUnmounted: false,
      loadController,
      saveController
    }

    await executeMethodBody(beforeUnmount, context, {})

    expect(context.isUnmounted).toBe(true)
    expect(loadController.abort).toHaveBeenCalledTimes(1)
    expect(saveController.abort).toHaveBeenCalledTimes(1)
  })
})
