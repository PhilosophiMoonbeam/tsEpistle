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
  const refresh = script && extractMethod(script, 'refresh')
  const save = script && extractMethod(script, 'save')
  const directRootUiCommit =
    /\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-analytics.vue keeps its REST/error facades, AsyncState rendering, action busy state, and provider selection', () => {
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
    expect(source).toMatch(/async-state\(v-else-if=['"]errorMessage['"],?\s+state=['"]error['"]/)
    expect(source).toMatch(/:loading=['"]refreshing['"][\s\S]*?:disabled=['"]refreshing \|\| saving['"]/)
    expect(source).toMatch(/:loading=['"]saving['"][\s\S]*?:disabled=['"]!canSave['"]/)
    expect(script).toMatch(/canSave\s*\(\s*\)\s*:\s*boolean\s*\{[\s\S]*?!this\.loading\s*&&\s*!this\.refreshing\s*&&\s*!this\.saving/)
    expect(computedBlock).toMatch(
      /provider\s*\(\s*\)\s*:\s*Partial<AnalyticsProvider>\s*\{\s*return\s+_\.find\s*\(\s*this\.providers\s*,\s*\[\s*['"]key['"]\s*,\s*this\.selectedProvider\s*\]\s*\)\s*\|\|\s*\{\s*\}\s*\}/
    )
    expect(loadProviders).toMatch(
      /const\s+selected\s*=\s*_\.find\s*\(\s*this\.providers\s*,\s*provider\s*=>\s*provider\.isAvailable\s*&&\s*provider\.isEnabled\s*\)\s*\|\|[\s\S]*?_\.find\s*\(\s*this\.providers\s*,\s*['"]isAvailable['"]\s*\)[\s\S]*?this\.selectedProvider\s*=\s*selected\?\.key\s*\|\|\s*['"]['"]/
    )
  })

  test('loadProviders owns truthful load/refresh/error state while preserving fetch, notification, rethrow, and cleanup', () => {
    expect(loadProviders).not.toBeNull()

    expect(loadProviders).toMatch(
      /this\.loading\s*=\s*true[\s\S]*?this\.errorMessage\s*=\s*['"]['"][\s\S]*?this\.refreshing\s*=\s*notifyError[\s\S]*?loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-analytics-refresh['"]\s*\)[\s\S]*?this\.providers\s*=\s*await\s+fetchAnalyticsProviders\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Analytics providers response is invalid['"]\s*\)[\s\S]*?return\s+true/
    )
    expect(loadProviders).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{[\s\S]*?this\.errorMessage\s*=\s*getErrorMessage\s*\(\s*err\s*\)\s*\|\|\s*this\.\$t\s*\(\s*['"]common:error\.unexpected['"]\s*\)[\s\S]*?if\s*\(\s*notifyError\s*\)\s*\{[\s\S]*?showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*this\.errorMessage\s*,\s*style:\s*['"]red['"]\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)[\s\S]*?\}[\s\S]*?throw\s+err/
    )
    expect(loadProviders).toMatch(
      /finally\s*\{[\s\S]*?this\.loading\s*=\s*false[\s\S]*?this\.refreshing\s*=\s*false[\s\S]*?loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-analytics-refresh['"]\s*\)\s*\}/
    )
    expect(loadProviders).not.toMatch(directRootUiCommit)

    expect(loadProviders.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadProviders.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadProviders.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('refresh rejects overlapping actions, settles failures, and reports success only after reload', () => {
    expect(refresh).not.toBeNull()

    expect(refresh).toMatch(/if\s*\(\s*this\.refreshing\s*\|\|\s*this\.saving\s*\)\s*return/)
    expect(refresh).toMatch(/try\s*\{\s*await\s+this\.loadProviders\s*\(\s*\)\s*\}\s*catch\s*\{\s*return\s*\}/)
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

  test('save preserves the action guard, REST payload, silent reload success gate, error facade, and balanced busy state', () => {
    expect(save).not.toBeNull()

    expect(save).toMatch(
      /if\s*\(\s*!this\.canSave\s*\)\s*return[\s\S]*?this\.saving\s*=\s*true[\s\S]*?loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-analytics-saveproviders['"]\s*\)/
    )
    expect(save).toMatch(
      /await\s+saveAnalyticsProviders\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,[\s\S]*?await\s+this\.loadProviders\s*\(\s*\{\s*notifyError:\s*false\s*\}\s*\)[\s\S]*?showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*this\.\$t\s*\(\s*['"]admin:analytics\.saveSuccess['"]\s*\)\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/
    )
    expect(save).toMatch(
      /this\.providers\.map\s*\(\s*str\s*=>\s*_\.pick\s*\(\s*str\s*,\s*\[\s*['"]isEnabled['"]\s*,\s*['"]key['"]\s*,\s*['"]config['"]\s*\]\s*\)\s*\)\.map\s*\(\s*str\s*=>\s*\(\s*\{\s*\.\.\.str\s*,\s*config:\s*str\.config\.map\s*\(\s*cfg\s*=>\s*\(\s*\{\s*\.\.\.cfg\s*,\s*value:\s*JSON\.stringify\s*\(\s*\{\s*v:\s*cfg\.value\.value\s*\}\s*\)\s*\}\s*\)\s*\)\s*\}\s*\)\s*\)/
    )
    expect(save).toMatch(/['"]Analytics providers save response is invalid['"]/)
    expect(save).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)\s*\}/)
    expect(save).toMatch(
      /finally\s*\{[\s\S]*?this\.saving\s*=\s*false[\s\S]*?loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-analytics-saveproviders['"]\s*\)\s*\}/
    )
    expect(save).not.toMatch(/this\.\$apollo\.mutate|providersSaveMutation|analytics-mutation-save-providers\.gql/)
    expect(save).not.toMatch(directRootUiCommit)

    expect(save.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bsaveAnalyticsProviders\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })
})
