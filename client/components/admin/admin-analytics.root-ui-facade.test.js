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
  const watchStart = script && script.search(/\bwatch\s*:/)
  const watchBlock = watchStart !== -1 ? extractBlock(script, watchStart) : null
  const loadProviders = script && extractMethod(script, 'loadProviders')
  const refresh = script && extractMethod(script, 'refresh')
  const save = script && extractMethod(script, 'save')
  const directRootUiCommit =
    /\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-analytics.vue imports the root UI facades and keeps provider selection watchers intact', () => {
    expect(script).not.toBeNull()
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(watchBlock).not.toBeNull()

    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bfetchAnalyticsProviders\b)(?=[^}]*\bsaveAnalyticsProviders\b)(?=[^}]*\btype\s+AnalyticsProvider\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/analytics-api['"]/
    )
    expect(watchBlock).toMatch(
      /selectedProvider\s*\(\s*newValue\s*,\s*oldValue\s*\)\s*\{\s*this\.provider\s*=\s*_\.find\s*\(\s*this\.providers\s*,\s*\[\s*['"]key['"]\s*,\s*newValue\s*\]\s*\)\s*\|\|\s*\{\s*\}\s*\}/
    )
    expect(watchBlock).toMatch(/providers\s*\(\s*newValue\s*,\s*oldValue\s*\)\s*\{\s*this\.selectedProvider\s*=\s*['"]google['"]\s*\}/)
  })

  test('loadProviders uses loading and notification facades without changing fetch, notifyError, rethrow, or cleanup behavior', () => {
    expect(loadProviders).not.toBeNull()

    expect(loadProviders).toMatch(
      /async\s+loadProviders\s*\(\s*\{\s*notifyError\s*=\s*true\s*\}\s*:\s*\{\s*notifyError\?\s*:\s*boolean\s*\}\s*=\s*\{\s*\}\s*\)\s*\{\s*loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-analytics-refresh['"]\s*\)[\s\S]*?try\s*\{[\s\S]*?this\.providers\s*=\s*await\s+fetchAnalyticsProviders\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Analytics providers response is invalid['"]\s*\)[\s\S]*?return\s+true[\s\S]*?\}\s*catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*notifyError\s*\)\s*\{\s*showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*getErrorMessage\s*\(\s*err\s*\)\s*,\s*style:\s*['"]red['"]\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)\s*\}\s*throw\s+err\s*\}\s*finally\s*\{\s*loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-analytics-refresh['"]\s*\)\s*\}/
    )
    expect(loadProviders).not.toMatch(directRootUiCommit)

    expect(loadProviders.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadProviders.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadProviders.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('refresh waits for provider reload, settles failures, and only shows success after a successful reload', () => {
    expect(refresh).not.toBeNull()

    expect(refresh).toMatch(
      /async\s+refresh\s*\(\s*\)\s*\{\s*try\s*\{\s*await\s+this\.loadProviders\s*\(\s*\)\s*\}\s*catch\s*\{\s*return\s*\}\s*showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*this\.\$t\s*\(\s*['"]admin:analytics\.refreshSuccess['"]\s*\)\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)\s*\}/
    )
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
      providers: []
    }

    context.loadProviders = () =>
      executeMethodBody(loadProviders, context, {
        notifyError: true,
        loadingStart,
        wikiStore,
        fetchAnalyticsProviders: jest.fn().mockRejectedValue(new Error('refresh failed')),
        window: { fetch() {} },
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

  test('save uses REST helper while preserving provider payload, silent reload, success/error facades, and save loading key', () => {
    expect(save).not.toBeNull()

    expect(save).toMatch(
      /async\s+save\s*\(\s*\)\s*\{\s*loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-analytics-saveproviders['"]\s*\)[\s\S]*?try\s*\{[\s\S]*?await\s+saveAnalyticsProviders\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,[\s\S]*?await\s+this\.loadProviders\s*\(\s*\{\s*notifyError:\s*false\s*\}\s*\)\s*showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*this\.\$t\s*\(\s*['"]admin:analytics\.saveSuccess['"]\s*\)\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)[\s\S]*?\}\s*catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)\s*\}[\s\S]*?loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-analytics-saveproviders['"]\s*\)\s*\}/
    )
    expect(save).toMatch(
      /this\.providers\.map\s*\(\s*str\s*=>\s*_\.pick\s*\(\s*str\s*,\s*\[\s*['"]isEnabled['"]\s*,\s*['"]key['"]\s*,\s*['"]config['"]\s*\]\s*\)\s*\)\.map\s*\(\s*str\s*=>\s*\(\s*\{\s*\.\.\.str\s*,\s*config:\s*str\.config\.map\s*\(\s*cfg\s*=>\s*\(\s*\{\s*\.\.\.cfg\s*,\s*value:\s*JSON\.stringify\s*\(\s*\{\s*v:\s*cfg\.value\.value\s*\}\s*\)\s*\}\s*\)\s*\)\s*\}\s*\)\s*\)/
    )
    expect(save).toMatch(/['"]Analytics providers save response is invalid['"]/)
    expect(save).not.toMatch(/this\.\$apollo\.mutate|providersSaveMutation|analytics-mutation-save-providers\.gql/)
    expect(save).not.toMatch(directRootUiCommit)

    expect(save.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bsaveAnalyticsProviders\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })
})
