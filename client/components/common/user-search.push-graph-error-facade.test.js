import fs from 'node:fs'
import path from 'node:path'

describe('user-search pushGraphError facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/common/user-search.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]
  const cancelSearch = script.slice(script.indexOf('cancelSearch(): void'), script.indexOf('queueSearch(): void'))
  const queueSearch = script.slice(script.indexOf('queueSearch(): void'), script.indexOf('async loadUsers('))
  const loadUsers = script.slice(script.indexOf('async loadUsers('), script.indexOf('retrySearch(): void'))

  test('reports only current-request failures through the root UI facade', () => {
    expect(script).not.toBeNull()
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { defineComponent, useId } from 'vue'")
    expect(script).toContain("import { searchUsers, type UserSearchRow } from '../../helpers/users-api'")
    expect(script).toContain("import { getErrorMessage } from '../../helpers/root-ui-store'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")

    expect(loadUsers).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*requestId\s*!==\s*this\.searchRequestId\s*\|\|\s*query\s*!==\s*this\.search\s*\)\s*\{\s*return\s+\[\]/
    )
    expect(loadUsers).toMatch(
      /this\.items\s*=\s*\[\]\s*this\.searchError\s*=\s*getErrorMessage\s*\(\s*err\s*\)\s*\|\|\s*this\.\$t\s*\(\s*['"]common:error\.generic['"]\s*\)\s*wikiStore\.showError\s*\(\s*err\s*\)/
    )
    expect(loadUsers).toMatch(/if\s*\(\s*this\.searchAbortController\s*===\s*controller\s*\)\s*\{\s*this\.searchAbortController\s*=\s*null\s*\}/)
    expect(loadUsers).toMatch(/if\s*\(\s*requestId\s*===\s*this\.searchRequestId\s*\)\s*\{\s*this\.searchLoading\s*=\s*false\s*\}/)
    expect(script).not.toMatch(/this\.\$store\.commit\(\s*['"]pushGraphError['"]\s*,/)

    const showErrorCalls = script.match(/\bshowError\s*\(/g) || []
    expect(showErrorCalls).toHaveLength(1)
  })

  test('keeps each debounced search abortable and applies only the latest result', () => {
    expect(script).toContain('searchAbortController: null as AbortController | null')
    expect(queueSearch).toContain('this.searchRequestId += 1')
    expect(queueSearch).toContain('this.searchAbortController?.abort()')
    expect(queueSearch).toContain('this.searchAbortController = null')
    expect(queueSearch).toMatch(/if\s*\(\s*query\.trim\(\)\.length\s*<\s*2\s*\)[\s\S]*this\.searchLoading\s*=\s*false[\s\S]*return/)
    expect(queueSearch).toContain('const requestId = this.searchRequestId')
    expect(queueSearch).toMatch(/window\.setTimeout\(\(\)\s*=>\s*\{[\s\S]*void this\.loadUsers\(query,\s*requestId\)[\s\S]*\},\s*300\)/)
    expect(loadUsers).toContain('const controller = new AbortController()')
    expect(loadUsers).toContain('(url, init) => window.fetch(url, { ...init, signal: controller.signal })')
    expect(loadUsers).toMatch(
      /if\s*\(\s*requestId\s*!==\s*this\.searchRequestId\s*\|\|\s*query\s*!==\s*this\.search\s*\)\s*\{\s*return\s+\[\][\s\S]*\}\s*this\.items\s*=\s*items/
    )
  })

  test('cancels pending search and focus work on close or unmount and preserves retry', () => {
    expect(cancelSearch).toContain('window.clearTimeout(this.searchTimer)')
    expect(cancelSearch).toContain('window.clearTimeout(this.focusTimer)')
    expect(cancelSearch).toContain('this.searchRequestId += 1')
    expect(cancelSearch).toContain('this.searchAbortController?.abort()')
    expect(cancelSearch).toContain('this.searchLoading = false')
    expect(script).toMatch(/else\s+if\s*\(\s*!newValue\s*&&\s*oldValue\s*\)\s*\{\s*this\.cancelSearch\(\)/)
    expect(script).toMatch(/beforeUnmount\s*\(\s*\)\s*\{\s*this\.cancelSearch\(\)/)
    expect(script).toContain('if (!this.modelValue) return')
    expect(source).toContain("@retry='retrySearch'")
    expect(script).toMatch(/retrySearch\s*\(\s*\)\s*:\s*void\s*\{\s*this\.queueSearch\s*\(\s*\)\s*\}/)
  })
})
