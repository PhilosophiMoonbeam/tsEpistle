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

describe('admin-comments root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-comments.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]
  const computedStart = script && script.search(/\bcomputed\s*:/)
  const computedBlock = computedStart !== -1 ? extractBlock(script, computedStart) : null
  const loadProviders = script && extractMethod(script, 'loadProviders')
  const refresh = script && extractMethod(script, 'refresh')
  const save = script && extractMethod(script, 'save')
  const directRootUiCommit =
    /\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-comments.vue keeps computed provider selection and accessible radio interactions', () => {
    expect(script).not.toBeNull()
    expect(computedBlock).not.toBeNull()

    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bfetchCommentProviders\b)(?=[^}]*\bsaveCommentProviders\b)(?=[^}]*\btype\s+CommentProvider\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/comments-api['"]/
    )
    expect(script).not.toMatch(/graphql-tag|\bgql\b/)
    expect(source).toMatch(/async-state\s*\(\s*v-if=['"]loading['"][^)]*state=['"]loading['"][^)]*title=['"]Loading comment providers['"][^)]*\)/)
    expect(source).toMatch(/async-state\s*\(\s*v-else-if=['"]errorMessage['"][^)]*state=['"]error['"][^)]*@retry=['"]loadProviders['"][^)]*\)/)
    expect(source).toMatch(
      /async-state\s*\(\s*v-else-if=['"]providers\.length < 1['"][^)]*state=['"]empty['"][^)]*title=['"]No comment providers available['"][^)]*\)/
    )
    expect(computedBlock).toMatch(
      /provider\s*\(\s*\)\s*:\s*Partial<CommentProvider>\s*\{\s*return\s+this\.providers\.find\s*\(\s*provider\s*=>\s*provider\.key\s*===\s*this\.selectedProvider\s*\)\s*\|\|\s*\{\s*\}\s*\}/
    )
    expect(computedBlock).toMatch(
      /canSave\s*\(\s*\)\s*:\s*boolean\s*\{[\s\S]*?!this\.loading[\s\S]*?!this\.refreshing[\s\S]*?!this\.saving[\s\S]*?provider\.key\s*===\s*this\.selectedProvider\)\?\.isAvailable/
    )
    expect(script).not.toMatch(/\bwatch\s*:/)
    expect(source).toMatch(/v-list\.py-0\([^)]*role=['"]radiogroup['"][^)]*aria-label=['"]Comment provider['"]/)
    expect(source).toMatch(
      /v-list-item\([\s\S]*?role=['"]radio['"][\s\S]*?:aria-checked=['"]provider\.key === selectedProvider['"][\s\S]*?:tabindex=['"]provider\.isAvailable \? 0 : -1['"]/
    )
    expect(source).toMatch(/@keydown\.enter\.prevent=['"]selectProvider\(provider\)['"]/)
    expect(source).toMatch(/@keydown\.space\.prevent=['"]selectProvider\(provider\)['"]/)
    expect(script).toMatch(
      /selectProvider\s*\(\s*provider\s*:\s*CommentProvider\s*\)\s*\{\s*if\s*\(\s*provider\.isAvailable\s*\)\s*\{\s*this\.selectedProvider\s*=\s*provider\.key/
    )
  })

  test('loadProviders uses abortable REST fetches and only lets the current generation settle state', () => {
    expect(loadProviders).not.toBeNull()

    expect(loadProviders).toMatch(
      /this\.loadController\?\.abort\s*\(\s*\)[\s\S]*?const\s+controller\s*=\s*new\s+AbortController\s*\(\s*\)[\s\S]*?this\.loadController\s*=\s*controller/
    )
    expect(loadProviders).toMatch(
      /this\.loading\s*=\s*true[\s\S]*?this\.errorMessage\s*=\s*['"]{2}[\s\S]*?this\.refreshing\s*=\s*notifyError[\s\S]*?loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-comments-refresh['"]\s*\)/
    )
    expect(loadProviders).toMatch(
      /const\s+providers\s*=\s*await\s+fetchCommentProviders\s*\(\s*createAbortableFetch\s*\(\s*controller\.signal\s*\)\s*,\s*['"]Comment providers response is invalid['"]\s*\)/
    )
    expect(loadProviders).toMatch(
      /if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s+false\s*\}[\s\S]*?providers\.find\s*\(\s*provider\s*=>\s*provider\.isEnabled\s*&&\s*provider\.isAvailable\s*\)\s*\|\|[\s\S]*?providers\.find\s*\(\s*provider\s*=>\s*provider\.isAvailable\s*\)[\s\S]*?this\.providers\s*=\s*providers[\s\S]*?this\.selectedProvider\s*=\s*selected\?\.key\s*\|\|\s*['"]{2}/
    )
    expect(loadProviders).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s+false\s*\}[\s\S]*?this\.errorMessage\s*=\s*getErrorMessage\s*\(\s*err\s*\)\s*\|\|\s*this\.\$t\s*\(\s*['"]common:error\.unexpected['"]\s*\)[\s\S]*?if\s*\(\s*notifyError\s*\)[\s\S]*?showNotification\s*\([\s\S]*?throw\s+err/
    )
    expect(loadProviders).toMatch(
      /finally\s*\{\s*if\s*\(\s*this\.loadController\s*===\s*controller\s*\)\s*\{[\s\S]*?this\.loadController\s*=\s*null[\s\S]*?if\s*\(\s*!this\.isUnmounted\s*\)\s*\{[\s\S]*?this\.loading\s*=\s*false[\s\S]*?this\.refreshing\s*=\s*false[\s\S]*?\}[\s\S]*?\}[\s\S]*?loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-comments-refresh['"]\s*\)/
    )
    expect(loadProviders).not.toMatch(directRootUiCommit)

    expect(loadProviders.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadProviders.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadProviders.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('refresh waits for the current reload and only announces a committed success', () => {
    expect(refresh).not.toBeNull()

    expect(refresh).toMatch(
      /async\s+refresh\s*\(\s*\)\s*\{\s*if\s*\(\s*this\.refreshing\s*\|\|\s*this\.saving\s*\)\s*return\s*try\s*\{\s*const\s+loaded\s*=\s*await\s+this\.loadProviders\s*\(\s*\)\s*if\s*\(\s*!loaded\s*\)\s*return\s*\}\s*catch\s*\{\s*return\s*\}[\s\S]*?showNotification\s*\(\s*wikiStore\s*,\s*\{[\s\S]*?message:\s*['"]Comment providers refreshed\.['"][\s\S]*?style:\s*['"]success['"][\s\S]*?icon:\s*['"]cached['"]/
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
        fetchCommentProviders: jest.fn().mockRejectedValue(new Error('refresh failed')),
        window: { fetch() {} },
        showNotification,
        getErrorMessage: err => err.message,
        loadingStop
      })

    const handlerPromise = executeMethodBody(refresh, context, { showNotification, wikiStore })

    await expect(handlerPromise).resolves.toBeUndefined()
    expect(events).toEqual(['loading:start', 'notification:red', 'loading:stop'])
    expect(loadingStart).toHaveBeenCalledWith(wikiStore, 'admin-comments-refresh')
    expect(loadingStop).toHaveBeenCalledWith(wikiStore, 'admin-comments-refresh')
    expect(showNotification).toHaveBeenCalledTimes(1)
    expect(showNotification).toHaveBeenCalledWith(wikiStore, {
      message: 'refresh failed',
      style: 'red',
      icon: 'alert'
    })
  })

  test('save preserves the provider payload and suppresses stale or aborted outcomes', () => {
    expect(save).not.toBeNull()

    expect(save).toMatch(
      /async\s+save\s*\(\s*\)\s*\{\s*if\s*\(\s*!this\.canSave\s*\)\s*return\s*const\s+controller\s*=\s*new\s+AbortController\s*\(\s*\)\s*this\.saveController\s*=\s*controller\s*this\.saving\s*=\s*true\s*loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-comments-saveproviders['"]\s*\)/
    )
    expect(save).toMatch(
      /saveCommentProviders\s*\(\s*createAbortableFetch\s*\(\s*controller\.signal\s*\)\s*,[\s\S]*?['"]Comment providers save response is invalid['"]\s*\)/
    )
    expect(save).toMatch(
      /this\.providers\.map\s*\(\s*tgt\s*=>\s*\(\s*\{\s*isEnabled:\s*tgt\.key\s*===\s*this\.selectedProvider\s*,\s*key:\s*tgt\.key\s*,\s*config:\s*tgt\.config\.map\s*\(\s*cfg\s*=>\s*\(\s*\{\s*\.\.\.cfg\s*,\s*value:\s*JSON\.stringify\s*\(\s*\{\s*v:\s*cfg\.value\.value\s*\}\s*\)\s*\}\s*\)\s*\)\s*\}\s*\)\s*\)/
    )
    expect(save).toMatch(
      /if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s*\}\s*await\s+this\.loadProviders\s*\(\s*\{\s*notifyError:\s*false\s*\}\s*\)\s*if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s*\}[\s\S]*?showNotification\s*\(\s*wikiStore/
    )
    expect(save).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*!controller\.signal\.aborted\s*\)\s*\{\s*pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)\s*\}\s*\}/
    )
    expect(save).toMatch(
      /finally\s*\{\s*if\s*\(\s*this\.saveController\s*===\s*controller\s*\)\s*\{\s*this\.saveController\s*=\s*null\s*if\s*\(\s*!this\.isUnmounted\s*\)\s*\{\s*this\.saving\s*=\s*false\s*\}\s*\}[\s\S]*?loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-comments-saveproviders['"]\s*\)/
    )
    expect(save).not.toMatch(/this\.\$apollo\.mutate|updateProviders\.responseResult|graphql-tag|\bgql\b/)
    expect(save).not.toMatch(directRootUiCommit)

    expect(save.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bsaveCommentProviders\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })
})
