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
  const watchStart = script && script.search(/\bwatch\s*:/)
  const watchBlock = watchStart !== -1 ? extractBlock(script, watchStart) : null
  const loadProviders = script && extractMethod(script, 'loadProviders')
  const refresh = script && extractMethod(script, 'refresh')
  const save = script && extractMethod(script, 'save')
  const directRootUiCommit =
    /\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-comments.vue imports the root UI facades and keeps comment provider selection watchers intact', () => {
    expect(script).not.toBeNull()
    expect(watchBlock).not.toBeNull()

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
    expect(watchBlock).toMatch(
      /selectedProvider\s*\(\s*newValue\s*:\s*string\s*\)\s*\{\s*this\.provider\s*=\s*_\.find\s*\(\s*this\.providers\s*,\s*\[\s*['"]key['"]\s*,\s*newValue\s*\]\s*\)\s*\|\|\s*\{\s*\}\s*\}/
    )
    expect(watchBlock).toMatch(
      /providers\s*\(\s*\)\s*\{\s*const\s+selected\s*=\s*_\.find\s*\(\s*this\.providers\s*,\s*provider\s*=>\s*provider\.isEnabled\s*&&\s*provider\.isAvailable\s*\)\s*\|\|\s*_\.find\s*\(\s*this\.providers\s*,\s*['"]isAvailable['"]\s*\)\s*this\.selectedProvider\s*=\s*selected\?\.key\s*\|\|\s*['"]{2}\s*\}/
    )
  })

  test('loadProviders uses loading and notification facades without changing fetch, notifyError, rethrow, or cleanup behavior', () => {
    expect(loadProviders).not.toBeNull()

    expect(loadProviders).toMatch(
      /async\s+loadProviders\s*\(\s*\{\s*notifyError\s*=\s*true\s*\}\s*:\s*\{\s*notifyError\?\s*:\s*boolean\s*\}\s*=\s*\{\s*\}\s*\)\s*\{\s*this\.loading\s*=\s*true\s*this\.errorMessage\s*=\s*['"]{2}\s*this\.refreshing\s*=\s*notifyError\s*loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-comments-refresh['"]\s*\)/
    )
    expect(loadProviders).toMatch(
      /try\s*\{\s*this\.providers\s*=\s*await\s+fetchCommentProviders\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Comment providers response is invalid['"]\s*\)\s*\}\s*catch\s*\(\s*err\s*\)\s*\{\s*this\.errorMessage\s*=\s*getErrorMessage\s*\(\s*err\s*\)\s*\|\|\s*this\.\$t\s*\(\s*['"]common:error\.unexpected['"]\s*\)\s*if\s*\(\s*notifyError\s*\)\s*\{\s*showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*this\.errorMessage\s*,\s*style:\s*['"]red['"]\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)\s*\}\s*throw\s+err\s*\}\s*finally\s*\{\s*this\.loading\s*=\s*false\s*this\.refreshing\s*=\s*false\s*loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-comments-refresh['"]\s*\)\s*\}/
    )
    expect(loadProviders).not.toMatch(directRootUiCommit)

    expect(loadProviders.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadProviders.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadProviders.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('refresh waits for provider reload, settles failures, and only shows success after a successful reload', () => {
    expect(refresh).not.toBeNull()

    expect(refresh).toMatch(
      /async\s+refresh\s*\(\s*\)\s*\{\s*if\s*\(\s*this\.refreshing\s*\|\|\s*this\.saving\s*\)\s*return\s*try\s*\{\s*await\s+this\.loadProviders\s*\(\s*\)\s*\}\s*catch\s*\{\s*return\s*\}\s*showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*['"]Comment providers refreshed\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)\s*\}/
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

  test('save uses REST helper while preserving payload, silent reload, success/error facades, and trailing loading stop', () => {
    expect(save).not.toBeNull()

    expect(save).toMatch(
      /async\s+save\s*\(\s*\)\s*\{\s*if\s*\(\s*!this\.canSave\s*\)\s*return\s*this\.saving\s*=\s*true\s*loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-comments-saveproviders['"]\s*\)[\s\S]*?try\s*\{[\s\S]*?await\s+saveCommentProviders\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,[\s\S]*?await\s+this\.loadProviders\s*\(\s*\{\s*notifyError:\s*false\s*\}\s*\)\s*showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*this\.\$t\s*\(\s*['"]admin:comments\.configSaveSuccess['"]\s*\)\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)[\s\S]*?\}\s*catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)\s*\}\s*finally\s*\{\s*this\.saving\s*=\s*false\s*loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-comments-saveproviders['"]\s*\)\s*\}\s*\}/
    )
    expect(save).toMatch(
      /this\.providers\.map\s*\(\s*tgt\s*=>\s*\(\s*\{\s*isEnabled:\s*tgt\.key\s*===\s*this\.selectedProvider\s*,\s*key:\s*tgt\.key\s*,\s*config:\s*tgt\.config\.map\s*\(\s*cfg\s*=>\s*\(\s*\{\s*\.\.\.cfg\s*,\s*value:\s*JSON\.stringify\s*\(\s*\{\s*v:\s*cfg\.value\.value\s*\}\s*\)\s*\}\s*\)\s*\)\s*\}\s*\)\s*\)/
    )
    expect(save).toMatch(/['"]Comment providers save response is invalid['"]/)
    expect(save).not.toMatch(/this\.\$apollo\.mutate|updateProviders\.responseResult|graphql-tag|\bgql\b/)
    expect(save).not.toMatch(directRootUiCommit)

    expect(save.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bsaveCommentProviders\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })
})
