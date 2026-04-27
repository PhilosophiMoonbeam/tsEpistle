const fs = require('fs')
const path = require('path')

const extractTemplate = (source) => {
  const match = source.match(/<template[^>]*>\s*([\s\S]*?)\s*<\/template>/)
  return match && match[1]
}

const extractScript = (source) => {
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const stripPugLineComments = (template) => template
  .split('\n')
  .filter(line => !/^\s*\/\/-/.test(line))
  .join('\n')

const extractMethod = (script, name) => {
  const methodStart = script.search(new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?${name}\\s*\\(`))

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

  let bodyDepth = 0

  for (let idx = bodyStart; idx < script.length; idx++) {
    if (script[idx] === '{') {
      bodyDepth++
    } else if (script[idx] === '}') {
      bodyDepth--

      if (bodyDepth === 0) {
        return script.slice(methodStart, idx + 1)
      }
    }
  }

  return null
}

describe('nav-header assets dead method cleanup guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/common/nav-header.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const template = extractTemplate(source)
  const activeTemplate = template && stripPugLineComments(template)
  const script = extractScript(source)
  const pageMoveRename = script && extractMethod(script, 'pageMoveRename')

  test('assets click handler is not active in the rendered Pug template', () => {
    expect(activeTemplate).not.toMatch(/@click\s*=\s*['"]assets['"]/)
  })

  test('assets dead method and its placeholder notification are removed', () => {
    expect(script).not.toMatch(/(?:^|\n)\s*assets\s*\(/)
    expect(script).not.toMatch(/Coming soon\.\.\./)
    expect(script).not.toMatch(/this\.\$store\.commit\s*\(\s*['"]showNotification['"]\s*,\s*\{[\s\S]*icon:\s*['"]ferry['"]/)
  })

  test('pageMoveRename direct root UI commits remain intentionally out of scope', () => {
    expect(pageMoveRename).not.toBeNull()
    expect(pageMoveRename).toMatch(/this\.\$store\.commit\s*\(\s*`loadingStart`\s*,\s*['"]page-move['"]\s*\)/)
    expect(pageMoveRename).toMatch(/this\.\$store\.commit\s*\(\s*['"]pushGraphError['"]\s*,\s*err\s*\)/)
    expect(pageMoveRename).toMatch(/this\.\$store\.commit\s*\(\s*`loadingStop`\s*,\s*['"]page-move['"]\s*\)/)
  })
})
