import fs from 'node:fs'
import path from 'node:path'

describe('admin-pages-visualize loading facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-pages-visualize.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = source.match(/<script(?:\s+lang=["']ts["'])?>([\s\S]*?)<\/script>/)[1]
  const loadPagesStart = script.indexOf('async loadPages (): Promise<void> {')
  const loadPagesEnd = script.indexOf('    goToPage', loadPagesStart)
  const loadPagesBody = script.slice(loadPagesStart, loadPagesEnd)

  test('admin-pages-visualize.vue uses the typed wiki store facade for page visualization refresh loading', () => {
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")

    expect(loadPagesBody).toContain("wikiStore.startLoading('admin-pages-refresh')")
    expect(loadPagesBody).toContain("wikiStore.stopLoading('admin-pages-refresh')")

    expect(source).not.toMatch(/this\.\$store\.commit\(\s*(?:`loading|['"]loading(?:Start|Stop)['"])/)

    const startLoadingCalls = source.match(/\bwikiStore\.startLoading\s*\(/g) || []
    const stopLoadingCalls = source.match(/\bwikiStore\.stopLoading\s*\(/g) || []
    expect(startLoadingCalls).toHaveLength(1)
    expect(stopLoadingCalls).toHaveLength(1)
  })
})
