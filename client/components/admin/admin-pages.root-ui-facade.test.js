import fs from 'node:fs'
import path from 'node:path'

describe('admin-pages root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-pages.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('admin-pages.vue uses the REST page list helper and wiki store UI facades', () => {
    expect(script).not.toBeNull()
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { fetchPageList, type PageListRow } from '../../helpers/pages-api'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")

    expect(script).toMatch(/\bwikiStore\.showNotification\s*\(\s*\{\s*message:\s*['"]Page list has been refreshed\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)/)
    expect(script).not.toMatch(/\$store\.commit\(\s*(?:`showNotification`|['"]showNotification['"])\s*,/)

    expect(script).toMatch(/async\s+loadPages\s*\(\s*\)\s*:\s*Promise<boolean>\s*\{\s*this\.errorMessage\s*=\s*['"]{2}\s*this\.loading\s*=\s*true\s*wikiStore\.startLoading\s*\(\s*['"]admin-pages-refresh['"]\s*\)\s*try\s*\{\s*this\.pages\s*=\s*await\s+fetchPageList\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*\)\s*return\s+true\s*\}\s*catch\s*\(\s*err\s*\)\s*\{\s*this\.errorMessage\s*=\s*getErrorMessage\s*\(\s*err\s*\)\s*wikiStore\.showError\s*\(\s*err\s*\)\s*return\s+false\s*\}\s*finally\s*\{\s*this\.loading\s*=\s*false\s*wikiStore\.stopLoading\s*\(\s*['"]admin-pages-refresh['"]\s*\)\s*\}\s*\}/)
    expect(script).toMatch(/async\s+refresh\s*\(\s*\)\s*\{\s*const\s+isLoaded\s*=\s*await\s+this\.loadPages\s*\(\s*\)\s*if\s*\(\s*isLoaded\s*\)\s*\{\s*wikiStore\.showNotification/)
    expect(script).toMatch(/mounted\s*\(\s*\)\s*\{\s*this\.loadPages\s*\(\s*\)\s*\}/)
    expect(script).not.toMatch(/\$store\.commit\(\s*(?:`loading\$\{isLoading\s*\?\s*['"]Start['"]\s*:\s*['"]Stop['"]\}`|`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"])\s*,/)
    expect(script).not.toMatch(/pages-query-list\.gql|apollo\s*:|this\.\$apollo|pagesQuery/)

    expect(script.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(script.match(/\bstartLoading\s*\(/g) || []).toHaveLength(1)
    expect(script.match(/\bstopLoading\s*\(/g) || []).toHaveLength(1)
    expect(script.match(/\bshowError\s*\(/g) || []).toHaveLength(1)
  })
})
