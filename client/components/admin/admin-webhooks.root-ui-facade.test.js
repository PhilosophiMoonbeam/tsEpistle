const fs = require('fs')
const path = require('path')

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

const extractApolloBlock = (script) => {
  const apolloStart = script.indexOf('apollo:')

  if (apolloStart === -1) {
    return null
  }

  const bodyStart = script.indexOf('{', apolloStart)
  let depth = 0

  for (let idx = bodyStart; idx < script.length; idx++) {
    if (script[idx] === '{') {
      depth++
    } else if (script[idx] === '}') {
      depth--

      if (depth === 0) {
        return script.slice(apolloStart, idx + 1)
      }
    }
  }

  return null
}

describe('admin-webhooks root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-webhooks.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]
  const save = script && extractMethod(script, 'save')
  const apollo = script && extractApolloBlock(script)

  test('admin-webhooks.vue routes active root UI calls through root-ui-store facade', () => {
    expect(script).not.toBeNull()
    expect(save).not.toBeNull()
    expect(apollo).not.toBeNull()

    expect(script).toMatch(/import\s+\{(?=[^}]*\bsetLoading\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toMatch(/import\s+mailConfigQuery\s+from\s+['"]gql\/admin\/mail\/mail-query-config\.gql['"]/)
    expect(script).toMatch(/import\s+mailUpdateConfigMutation\s+from\s+['"]gql\/admin\/mail\/mail-mutation-save-config\.gql['"]/)

    expect(save).toMatch(/mutation:\s*mailUpdateConfigMutation/)
    expect(save).toMatch(/senderName:\s*this\.config\.senderName\s*\|\|\s*['"]['"]/)
    expect(save).toMatch(/dkimPrivateKey:\s*this\.config\.dkimPrivateKey\s*\|\|\s*['"]['"]/)
    expect(save).toMatch(/watchLoading\s*\(\s*isLoading\s*\)\s*\{\s*setLoading\s*\(\s*this\.\$store\s*,\s*['"]admin-mail-update['"]\s*,\s*isLoading\s*\)\s*\}/)
    expect(save).toMatch(/showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*style:\s*['"]success['"]\s*,\s*message:\s*['"]Configuration saved successfully\.['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(save).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*\}/)

    expect(apollo).toMatch(/hooks:\s*\{[\s\S]*?query:\s*mailConfigQuery[\s\S]*?fetchPolicy:\s*['"]network-only['"][\s\S]*?update:\s*\(\s*data\s*\)\s*=>\s*_\.cloneDeep\s*\(\s*data\.mail\.config\s*\)[\s\S]*?watchLoading\s*\(\s*isLoading\s*\)\s*\{\s*setLoading\s*\(\s*this\.\$store\s*,\s*['"]admin-mail-refresh['"]\s*,\s*isLoading\s*\)\s*\}/)

    expect(script).not.toMatch(/\$store\.commit\(\s*(?:`loading\$\{isLoading \? 'Start' : 'Stop'\}`|['"]showNotification['"]|['"]pushGraphError['"])\s*,/)

    const setLoadingCalls = script.match(/\bsetLoading\s*\(/g) || []
    expect(setLoadingCalls).toHaveLength(2)

    const showNotificationCalls = script.match(/\bshowNotification\s*\(/g) || []
    expect(showNotificationCalls).toHaveLength(1)

    const pushGraphErrorCalls = script.match(/\bpushGraphError\s*\(/g) || []
    expect(pushGraphErrorCalls).toHaveLength(1)
  })
})
