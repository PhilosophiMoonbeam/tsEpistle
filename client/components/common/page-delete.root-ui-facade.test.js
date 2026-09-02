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

describe('page-delete root UI facade contract', () => {
  const componentPath = path.join(process.cwd(), 'client/components/common/page-delete.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const deletePage = script && extractMethod(script, 'deletePage')
  const beforeUnmount = script && extractMethod(script, 'beforeUnmount')
  const discard = script && extractMethod(script, 'discard')

  test('uses the typed component, store singleton, and REST facade', () => {
    expect(source).toContain("<script lang='ts'>")
    expect(script).toMatch(/import\s*\{\s*defineComponent\s*\}\s*from\s*['"]vue['"]/)
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toContain("import { deletePage as deletePageById } from '../../helpers/pages-api'")
    expect(script).not.toMatch(/common-pages-mutation-delete\.gql|deletePageMutation|\$apollo/)
  })

  test('guards reentry and sends the current page deletion payload with an abortable fetch', () => {
    expect(deletePage).not.toBeNull()
    expect(deletePage).toMatch(/if\s*\(\s*this\.loading\s*\)\s*\{\s*return\s*\}/)
    expect(deletePage).toMatch(
      /const\s+requestId\s*=\s*\+\+this\.deleteRequestId[\s\S]*?const\s+controller\s*=\s*new\s+AbortController\s*\(\s*\)[\s\S]*?this\.deleteAbortController\s*=\s*controller[\s\S]*?this\.loading\s*=\s*true/
    )
    expect(deletePage).toMatch(
      /await\s+deletePageById\s*\(\s*\(\s*url\s*,\s*init\s*\)\s*=>\s*window\.fetch\s*\(\s*url\s*,\s*\{\s*\.\.\.init\s*,\s*signal:\s*controller\.signal\s*\}\s*\)\s*,\s*this\.pageId\s*,\s*this\.pageSourceRevision\s*,\s*this\.\$t\s*\(\s*['"]common:error\.unexpected['"]\s*\)\s*\)/
    )
  })

  test('balances global loading and limits errors and local completion to the current live request', () => {
    expect(deletePage).toMatch(/wikiStore\.startLoading\s*\(\s*['"]page-delete['"]\s*\)/)
    expect(deletePage).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*requestId\s*===\s*this\.deleteRequestId\s*&&\s*!controller\.signal\.aborted\s*\)\s*\{\s*wikiStore\.showError\s*\(\s*err\s*\)/
    )
    expect(deletePage).toMatch(
      /finally\s*\{\s*wikiStore\.stopLoading\s*\(\s*['"]page-delete['"]\s*\)[\s\S]*?if\s*\(\s*this\.deleteAbortController\s*===\s*controller\s*\)\s*\{\s*this\.deleteAbortController\s*=\s*null[\s\S]*?if\s*\(\s*requestId\s*===\s*this\.deleteRequestId\s*\)\s*\{\s*this\.loading\s*=\s*false/
    )
    expect(deletePage.match(/wikiStore\.startLoading\s*\(/g)).toHaveLength(1)
    expect(deletePage.match(/wikiStore\.stopLoading\s*\(/g)).toHaveLength(1)
  })

  test('only a successful current request closes the dialog and owns the redirect sequence', () => {
    expect(deletePage).toContain('await this.$nextTick()')
    expect(deletePage).toMatch(
      /await\s+deletePageById\s*\([\s\S]*?if\s*\(\s*requestId\s*!==\s*this\.deleteRequestId\s*\)\s*\{\s*return\s*\}[\s\S]*?this\.retainPendingClass\s*=\s*true[\s\S]*?this\.isShown\s*=\s*false/
    )
    expect(deletePage).toMatch(
      /this\.deleteTransitionTimer\s*=\s*window\.setTimeout\s*\(\s*\(\s*\)\s*=>\s*\{[\s\S]*?requestId\s*!==\s*this\.deleteRequestId[\s\S]*?document\.body\.classList\.add\s*\(\s*['"]page-deleted['"]\s*\)[\s\S]*?this\.redirectTimer\s*=\s*window\.setTimeout\s*\([\s\S]*?requestId\s*===\s*this\.deleteRequestId[\s\S]*?window\.location\.assign\s*\(\s*['"]\/['"]\s*\)[\s\S]*?1200\s*\)[\s\S]*?400\s*\)/
    )
  })

  test('aborts and invalidates pending deletion work on unmount', () => {
    expect(beforeUnmount).not.toBeNull()
    expect(beforeUnmount).toMatch(
      /this\.deleteRequestId\s*\+=\s*1[\s\S]*?this\.deleteAbortController\?\.abort\s*\(\s*\)[\s\S]*?this\.deleteAbortController\s*=\s*null/
    )
    expect(beforeUnmount).toContain('window.clearTimeout(this.deleteTransitionTimer)')
    expect(beforeUnmount).toContain('window.clearTimeout(this.redirectTimer)')
    expect(beforeUnmount).toContain("document.body.classList.remove('page-deleted-pending', 'page-deleted')")
    expect(deletePage).toMatch(/this\.deleteTransitionTimer\s*=\s*undefined[\s\S]*?requestId\s*!==\s*this\.deleteRequestId/)
    expect(deletePage).toMatch(/this\.redirectTimer\s*=\s*undefined[\s\S]*?requestId\s*===\s*this\.deleteRequestId/)
  })

  test('keeps cancel disabled during deletion and exposes typed page state', () => {
    expect(discard).not.toBeNull()
    expect(discard).toContain("document.body.classList.remove('page-deleted-pending')")
    expect(discard).toContain('this.isShown = false')
    expect(source).toContain("v-btn(variant=\"text\", @click='discard', :disabled='loading')")
    expect(source).toContain("v-btn.px-4(color=\"red-darken-2\", @click='deletePage', :loading='loading', :disabled='loading').text-white")
    expect(script).toContain('pageTitle(): string { return wikiStore.page.title }')
    expect(script).toContain('pagePath(): string { return wikiStore.page.path }')
    expect(script).toContain('pageLocale(): string { return wikiStore.page.locale }')
    expect(script).toContain('pageId(): number { return wikiStore.page.id }')
    expect(script).toContain('pageSourceRevision(): string { return wikiStore.page.sourceRevision }')
  })
})
