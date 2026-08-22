import fs from 'node:fs'
import path from 'node:path'

const extractScript = (source) => {
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
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

const expectPatternsInOrder = (source, orderedPatterns) => {
  let cursor = 0

  for (const [, pattern] of orderedPatterns) {
    const remainder = source.slice(cursor)
    const match = remainder.match(pattern)

    expect(match).not.toBeNull()

    cursor += match.index + match[0].length
  }
}

describe('admin-storage executeAction root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-storage.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const executeAction = script && extractMethod(script, 'executeAction')

  test('executeAction() uses root-ui-store facades for root UI calls only in this action flow', () => {
    expect(script).not.toBeNull()
    expect(source).toMatch(/<script\s+lang=["']ts["']>/)
    expect(executeAction).not.toBeNull()

    expect(script).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bpushGraphError\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bsetLoading\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bexecuteStorageAction\b)(?=[^}]*\bfetchStorageStatus\b)(?=[^}]*\bfetchStorageTargets\b)(?=[^}]*\bsaveStorageTargets\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/storage-api['"]/)
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).not.toContain('gql/admin/storage/')
    expect(script).not.toContain('apollo:')
    expect(executeAction).toMatch(/\bloadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-storage-executeaction['"]\s*\)/)
    expect(executeAction).toMatch(/\bshowNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*result\.message\s*\|\|\s*['"]Action completed\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(executeAction).toMatch(/\bloadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-storage-executeaction['"]\s*\)/)

    expect(executeAction).not.toMatch(/this\.\$store\.commit\s*\(\s*(?:`loadingStart`|['"]loadingStart['"])\s*,\s*['"]admin-storage-executeaction['"]\s*\)/)
    expect(executeAction).not.toMatch(/this\.\$store\.commit\s*\(\s*(?:`loadingStop`|['"]loadingStop['"])\s*,\s*['"]admin-storage-executeaction['"]\s*\)/)
    expect(executeAction).not.toMatch(/this\.\$store\.commit\s*\(\s*['"]showNotification['"]\s*,/)
    expect(script).not.toContain('storage-mutation-executeaction.gql')
    expect(script).not.toContain('targetExecuteActionMutation')

    const loadingStartCalls = executeAction.match(/\bloadingStart\s*\(/g) || []
    expect(loadingStartCalls).toHaveLength(1)

    const showNotificationCalls = executeAction.match(/\bshowNotification\s*\(/g) || []
    expect(showNotificationCalls).toHaveLength(1)

    const loadingStopCalls = executeAction.match(/\bloadingStop\s*\(/g) || []
    expect(loadingStopCalls).toHaveLength(1)
  })

  test('executeAction() preserves mutation variables, success notification, error handling, and cleanup ordering', () => {
    expect(executeAction).not.toBeNull()

    expectPatternsInOrder(executeAction, [
      ['start loading via facade', /\bloadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-storage-executeaction['"]\s*\)/],
      ['mark action as running', /this\.runningAction\s*=\s*true/],
      ['store running action handler', /this\.runningActionHandler\s*=\s*handler/],
      ['enter try block', /try\s*\{/],
      ['execute storage REST action', /await\s+executeStorageAction\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*,\s*targetKey\s*,\s*handler\s*\)/],
      ['show success notification via facade', /\bshowNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*result\.message\s*\|\|\s*['"]Action completed\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/],
      ['refresh status after action', /await\s+this\.loadStatus\s*\(\s*\)/],
      ['catch mutation errors', /\}\s*catch\s*\(\s*err\s*\)\s*\{/],
      ['surface caught error', /pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)/],
      ['enter cleanup', /\}\s*finally\s*\{/],
      ['clear running action flag', /this\.runningAction\s*=\s*false/],
      ['clear running action handler', /this\.runningActionHandler\s*=\s*['"]['"]/],
      ['stop loading via facade', /\bloadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-storage-executeaction['"]\s*\)/]
    ])
  })

  test('storage targets and status are loaded through REST helpers with preserved config mapping', () => {
    expect(script).not.toBeNull()

    expect(script).toMatch(/async\s+loadTargets\s*\(\)\s*\{[\s\S]*this\.targets\s*=\s*this\.normalizeTargets\s*\(\s*await\s+fetchStorageTargets\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*\)\s*\)[\s\S]*setLoading\s*\(\s*wikiStore\s*,\s*['"]admin-storage-targets-refresh['"]\s*,\s*false\s*\)/)
    expect(script).toMatch(/async\s+loadStatus\s*\(\)\s*\{[\s\S]*this\.status\s*=\s*await\s+fetchStorageStatus\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*\)[\s\S]*setLoading\s*\(\s*wikiStore\s*,\s*['"]admin-storage-status-refresh['"]\s*,\s*false\s*\)/)
    expect(script).toContain('value: JSON.parse(config.value) as StorageConfigValue')
    expect(script).toContain('value: JSON.stringify({ v: config.value.value })')
    expect(script).toMatch(/this\.statusRefreshInterval\s*=\s*setInterval\s*\([\s\S]*this\.loadStatus\s*\(\s*\)[\s\S]*3000\s*\)/)
    expect(script).toMatch(/clearInterval\s*\(\s*this\.statusRefreshInterval\s*\)/)
    expect(script).toMatch(/await\s+saveStorageTargets\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*,\s*this\.storageTargetsPayload\s*\(\s*\)\s*\)/)
  })
})
