import fs from 'node:fs'
import path from 'node:path'

const extractScript = (source) => {
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
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

  test('imports the typed component and store singleton used by deletePage', () => {
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { defineComponent } from 'vue'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toContain("import { deletePage as deletePageById } from '../../helpers/pages-api'")
    expect(script).not.toContain('common-pages-mutation-delete.gql')
    expect(script).not.toContain('deletePageMutation')
  })

  test('deletePage routes loading and errors through the store singleton', () => {
    expect(deletePage).not.toBeNull()
    expect(deletePage).toMatch(/wikiStore\.startLoading\s*\(\s*['"]page-delete['"]\s*\)/)
    expect(deletePage).toMatch(/wikiStore\.showError\s*\(\s*err\s*\)/)
    expect(deletePage).toMatch(/wikiStore\.stopLoading\s*\(\s*['"]page-delete['"]\s*\)/)
    expect(deletePage).not.toMatch(/this\.\$store\.commit\([\s\S]{0,200}(?:['"]page-delete['"]|['"]pushGraphError['"])/)
  })

  test('deletePage preserves REST delete, redirect, and local loading behavior', () => {
    expect(deletePage).toContain('this.loading = true')
    expect(deletePage).toContain('this.$nextTick(async () => {')
    expect(deletePage).toContain('await deletePageById(')
    expect(deletePage).toContain('window.fetch.bind(window)')
    expect(deletePage).toContain('this.pageId')
    expect(deletePage).toContain("this.$t('common:error.unexpected')")
    expect(deletePage).not.toContain('this.$apollo.mutate')
    expect(deletePage).not.toContain('data.pages.delete.responseResult')
    expect(deletePage).toContain('this.isShown = false')
    expect(deletePage).toContain("document.body.classList.add('page-deleted')")
    expect(deletePage).toContain("window.location.assign('/')")
    expect(deletePage).toContain('this.loading = false')
  })

  test('keeps the dialog template and typed page state getters out of this slice', () => {
    expect(source).toContain("v-btn.px-4(color='red darken-2', @click='deletePage', :loading='loading').white--text")
    expect(script).toContain('pageTitle(): string { return wikiStore.page.title }')
    expect(script).toContain('pagePath(): string { return wikiStore.page.path }')
    expect(script).toContain('pageLocale(): string { return wikiStore.page.locale }')
    expect(script).toContain('pageId(): number { return wikiStore.page.id }')
  })
})
