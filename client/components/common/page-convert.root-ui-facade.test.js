const fs = require('fs')
const path = require('path')

const extractScript = (source) => {
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
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

describe('page-convert root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/common/page-convert.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const convertPage = script && extractMethod(script, 'convertPage')

  test('imports the root UI facade helpers used by convertPage', () => {
    expect(script).toMatch(/import\s+\{\s*loadingStart\s*,\s*loadingStop\s*,\s*pushGraphError\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
  })

  test('convertPage routes loading and GraphQL errors through the facade', () => {
    expect(convertPage).not.toBeNull()
    expect(convertPage).toMatch(/loadingStart\s*\(\s*this\.\$store\s*,\s*['"]page-convert['"]\s*\)/)
    expect(convertPage).toMatch(/pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)/)
    expect(convertPage).toMatch(/loadingStop\s*\(\s*this\.\$store\s*,\s*['"]page-convert['"]\s*\)/)
    expect(convertPage).not.toMatch(/this\.\$store\.commit\([\s\S]{0,200}(?:['"]page-convert['"]|['"]pushGraphError['"])/)
  })

  test('convertPage preserves mutation, redirect, and local loading behavior', () => {
    expect(convertPage).toContain('this.loading = true')
    expect(convertPage).toContain('this.$nextTick(async () => {')
    expect(convertPage).toContain('const resp = await this.$apollo.mutate({')
    expect(convertPage).toContain('pages {')
    expect(convertPage).toContain('convert(')
    expect(convertPage).toContain('id: this.pageId')
    expect(convertPage).toContain('editor: this.newEditor')
    expect(convertPage).toContain("_.get(resp, 'data.pages.convert.responseResult.succeeded', false)")
    expect(convertPage).toContain('this.isShown = false')
    expect(convertPage).toContain('window.location.assign(`/e/' + '$' + '{this.pageLocale}/' + '$' + '{this.pagePath}`)')
    expect(convertPage).toContain('this.loading = false')
  })

  test('keeps the dialog template and page state getters out of this slice', () => {
    expect(source).toContain("v-btn.px-4(color='grey darken-3', @click='convertPage', :loading='loading').white--text")
    expect(script).toContain("pageTitle: get('page/title')")
    expect(script).toContain("pagePath: get('page/path')")
    expect(script).toContain("pageLocale: get('page/locale')")
    expect(script).toContain("pageId: get('page/id')")
    expect(script).toContain("pageEditor: get('page/editor')")
  })
})
