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

describe('page-delete root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/common/page-delete.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const deletePage = script && extractMethod(script, 'deletePage')

  test('imports the root UI facade helpers used by deletePage', () => {
    expect(script).toMatch(/import\s+\{\s*loadingStart\s*,\s*loadingStop\s*,\s*pushGraphError\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
  })

  test('deletePage routes loading and GraphQL errors through the facade', () => {
    expect(deletePage).not.toBeNull()
    expect(deletePage).toMatch(/loadingStart\s*\(\s*this\.\$store\s*,\s*['"]page-delete['"]\s*\)/)
    expect(deletePage).toMatch(/pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)/)
    expect(deletePage).toMatch(/loadingStop\s*\(\s*this\.\$store\s*,\s*['"]page-delete['"]\s*\)/)
    expect(deletePage).not.toMatch(/this\.\$store\.commit\([\s\S]{0,200}(?:['"]page-delete['"]|['"]pushGraphError['"])/)
  })

  test('deletePage preserves mutation, redirect, and local loading behavior', () => {
    expect(deletePage).toContain('this.loading = true')
    expect(deletePage).toContain('this.$nextTick(async () => {')
    expect(deletePage).toContain('const resp = await this.$apollo.mutate({')
    expect(deletePage).toContain('mutation: deletePageMutation')
    expect(deletePage).toContain('id: this.pageId')
    expect(deletePage).toContain("_.get(resp, 'data.pages.delete.responseResult.succeeded', false)")
    expect(deletePage).toContain('this.isShown = false')
    expect(deletePage).toContain("document.body.classList.add('page-deleted')")
    expect(deletePage).toContain("window.location.assign('/')")
    expect(deletePage).toContain('this.loading = false')
  })

  test('keeps the dialog template and page state getters out of this slice', () => {
    expect(source).toContain("v-btn.px-4(color='red darken-2', @click='deletePage', :loading='loading').white--text")
    expect(script).toContain("pageTitle: get('page/title')")
    expect(script).toContain("pagePath: get('page/path')")
    expect(script).toContain("pageLocale: get('page/locale')")
    expect(script).toContain("pageId: get('page/id')")
  })
})
