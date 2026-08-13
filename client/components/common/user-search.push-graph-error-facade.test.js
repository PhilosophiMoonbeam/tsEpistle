import fs from 'node:fs'
import path from 'node:path'

describe('user-search pushGraphError facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/common/user-search.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('user-search.vue reports current-request failures through the wiki store error facade after resetting items', () => {
    expect(script).not.toBeNull()
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { defineComponent } from 'vue'")
    expect(script).toContain("import { searchUsers, type UserSearchRow } from '../../helpers/users-api'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")

    expect(script).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*requestId\s*!==\s*this\.searchRequestId\s*\|\|\s*query\s*!==\s*this\.search\s*\)\s*\{\s*return\s+\[\]\s*\}\s*this\.items\s*=\s*\[\]\s*wikiStore\.showError\s*\(\s*err\s*\)\s*return\s+\[\]\s*\}/)
    expect(script).toMatch(/finally\s*\{\s*if\s*\(\s*requestId\s*===\s*this\.searchRequestId\s*\)\s*\{\s*this\.searchLoading\s*=\s*false\s*\}\s*\}/)
    expect(script).not.toMatch(/this\.\$store\.commit\(\s*['"]pushGraphError['"]\s*,/)

    const showErrorCalls = script.match(/\bshowError\s*\(/g) || []
    expect(showErrorCalls).toHaveLength(1)
  })
})
