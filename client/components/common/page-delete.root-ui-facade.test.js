import fs from 'node:fs'
import path from 'node:path'

const extractScript = source => {
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
  const beforeUnmount = script && extractMethod(script, 'beforeUnmount')
  const discard = script && extractMethod(script, 'discard')

  test('imports the typed component and store singleton used by deletePage', () => {
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { defineComponent } from 'vue'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toContain("import { deletePage as deletePageById } from '../../helpers/pages-api'")
    expect(script).not.toContain('common-pages-mutation-delete.gql')
    expect(script).not.toContain('deletePageMutation')
  })

  test('deletePage routes loading and current-request errors through the store singleton', () => {
    expect(deletePage).not.toBeNull()
    expect(deletePage).toMatch(/wikiStore\.startLoading\s*\(\s*['"]page-delete['"]\s*\)/)
    expect(deletePage).toMatch(/if\s*\(\s*requestId\s*===\s*this\.deleteRequestId\s*\)\s*\{\s*wikiStore\.showError\s*\(\s*err\s*\)/)
    expect(deletePage).toMatch(/wikiStore\.stopLoading\s*\(\s*['"]page-delete['"]\s*\)/)
    expect(deletePage).not.toMatch(/this\.\$store\.commit\([\s\S]{0,200}(?:['"]page-delete['"]|['"]pushGraphError['"])/)
  })

  test('deletePage preserves guarded REST deletion and redirect behavior', () => {
    expect(deletePage).toMatch(/if\s*\(\s*this\.loading\s*\)\s*\{\s*return\s*\}/)
    expect(deletePage).toContain('const requestId = ++this.deleteRequestId')
    expect(deletePage).toContain('this.loading = true')
    expect(deletePage).toContain('await this.$nextTick()')
    expect(deletePage).toContain('await deletePageById(')
    expect(deletePage).toContain('window.fetch.bind(window)')
    expect(deletePage).toContain('this.pageId')
    expect(deletePage).toContain('this.pageSourceRevision')
    expect(deletePage).toContain("this.$t('common:error.unexpected')")
    expect(deletePage).not.toContain('this.$apollo.mutate')
    expect(deletePage).not.toContain('data.pages.delete.responseResult')
    expect(deletePage).toMatch(/if\s*\(\s*requestId\s*!==\s*this\.deleteRequestId\s*\)\s*\{\s*return\s*\}[\s\S]*this\.retainPendingClass\s*=\s*true/)
    expect(deletePage).toContain('this.isShown = false')
    expect(deletePage).toContain("document.body.classList.add('page-deleted')")
    expect(deletePage).toMatch(/window\.setTimeout\([\s\S]*window\.location\.assign\(\s*['"]\/['"]\s*\)[\s\S]*1200[\s\S]*400/)
    expect(deletePage).toMatch(/if\s*\(\s*requestId\s*===\s*this\.deleteRequestId\s*\)\s*\{\s*this\.loading\s*=\s*false/)
  })

  test('invalidates pending work and clears timers and body classes on unmount', () => {
    expect(beforeUnmount).not.toBeNull()
    expect(beforeUnmount).toContain('this.deleteRequestId += 1')
    expect(beforeUnmount).toContain('window.clearTimeout(this.deleteTransitionTimer)')
    expect(beforeUnmount).toContain('window.clearTimeout(this.redirectTimer)')
    expect(discard).not.toBeNull()
    expect(discard).toContain("document.body.classList.remove('page-deleted-pending')")
    expect(discard).toContain('this.isShown = false')
    expect(beforeUnmount).toContain("document.body.classList.remove('page-deleted-pending', 'page-deleted')")
    expect(deletePage).toMatch(/this\.deleteTransitionTimer\s*=\s*undefined[\s\S]*requestId\s*!==\s*this\.deleteRequestId/)
    expect(deletePage).toMatch(/this\.redirectTimer\s*=\s*undefined[\s\S]*requestId\s*===\s*this\.deleteRequestId/)
  })

  test('keeps the dialog contract and typed page state getters out of this slice', () => {
    expect(source).toContain("v-btn(variant=\"text\", @click='discard', :disabled='loading')")
    expect(source).toContain("v-btn.px-4(color=\"red-darken-2\", @click='deletePage', :loading='loading', :disabled='loading').text-white")
    expect(script).toContain('pageTitle(): string { return wikiStore.page.title }')
    expect(script).toContain('pagePath(): string { return wikiStore.page.path }')
    expect(script).toContain('pageLocale(): string { return wikiStore.page.locale }')
    expect(script).toContain('pageId(): number { return wikiStore.page.id }')
    expect(script).toContain('pageSourceRevision(): string { return wikiStore.page.sourceRevision }')
  })
})
