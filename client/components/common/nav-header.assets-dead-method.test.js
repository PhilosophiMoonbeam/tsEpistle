import fs from 'node:fs'
import path from 'node:path'

const extractTemplate = source => {
  const match = source.match(/<template[^>]*>\s*([\s\S]*?)\s*<\/template>/)
  return match && match[1]
}

const extractScript = source => {
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const stripPugLineComments = template =>
  template
    .split('\n')
    .filter(line => !/^\s*\/\/-/.test(line))
    .join('\n')

const extractDesktopPageActions = template => {
  const blockStart = template.indexOf("{{$t('common:header.currentPage')}}")
  const blockEnd = template.indexOf('            v-divider(vertical)', blockStart)

  return blockStart === -1 || blockEnd === -1 ? null : template.slice(blockStart, blockEnd)
}

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
  const desktopPageActions = activeTemplate && extractDesktopPageActions(activeTemplate)
  const pageMoveRename = script && extractMethod(script, 'pageMoveRename')

  test('assets click handler is not active in the rendered Pug template', () => {
    expect(activeTemplate).not.toMatch(/@click\s*=\s*['"]assets['"]/)
  })

  test('assets dead method and its placeholder notification are removed', () => {
    expect(script).not.toMatch(/(?:^|\n)\s*assets\s*\(/)
    expect(script).not.toMatch(/Coming soon\.\.\./)
    expect(script).not.toMatch(/this\.\$store\.commit\s*\(\s*['"]showNotification['"]\s*,\s*\{[\s\S]*icon:\s*['"]ferry['"]/)
  })

  test('desktop page actions delegate click, Enter, and Space once to Vuetify link handling', () => {
    const actionMethods = ['pageView', 'pageEdit', 'pageHistory', 'pageSource', 'pageConvert', 'pageDuplicate', 'pageMove', 'pageDelete']
    const itemDeclarations = (desktopPageActions && desktopPageActions.match(/^\s*v-list-item\.pl-4\([^\n]*\)$/gm)) || []

    expect(itemDeclarations).toHaveLength(actionMethods.length)

    actionMethods.forEach(method => {
      const declaration = itemDeclarations.find(item => item.includes(`@click='${method}'`))

      expect(declaration).toBeDefined()
      expect(declaration).toMatch(/(?:\(|,\s*)link(?:,|\))/)
      expect(declaration).toMatch(/role='button'/)
      expect(declaration).toMatch(/tabindex='0'/)
      expect(declaration.match(/@click=/g)).toHaveLength(1)
      expect(declaration).not.toMatch(/@key/)
    })
  })

  test('pageMoveRename routes typed root UI state through wikiStore', () => {
    expect(script).toMatch(/import\s+\{(?=[^}]*\bdefineAsyncComponent\b)(?=[^}]*\bdefineComponent\b)[^}]*\}\s+from\s+['"]vue['"]/)
    expect(script).toMatch(/import\s+\{\s*wikiStore\s*\}\s+from\s+['"]@\/store\/index\.ts['"]/)
    expect(pageMoveRename).not.toBeNull()
    expect(pageMoveRename).toMatch(/async\s+pageMoveRename\s*\(\s*\{\s*path\s*,\s*locale\s*\}\s*:\s*PageLocation\s*\)\s*:\s*Promise<void>/)
    expect(pageMoveRename).toMatch(/wikiStore\.startLoading\s*\(\s*['"]page-move['"]\s*\)/)
    expect(pageMoveRename).toMatch(
      /await\s+movePage\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*wikiStore\.page\.id\s*,\s*locale\s*,\s*path\s*,\s*wikiStore\.page\.sourceRevision\s*\)/
    )
    expect(pageMoveRename).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*wikiStore\.showError\s*\(\s*err\s*\)\s*wikiStore\.stopLoading\s*\(\s*['"]page-move['"]\s*\)\s*\}/
    )
    expect(pageMoveRename).not.toMatch(/this\.\$store\.commit/)
  })
})
