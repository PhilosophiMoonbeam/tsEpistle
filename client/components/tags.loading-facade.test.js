import fs from 'node:fs'
import path from 'node:path'

describe('tags REST migration guard', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'client/components/tags.vue'), 'utf8')

  test('loads tags and filtered pages through REST helpers', () => {
    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(source).toMatch(/import\s+\{\s*fetchPages,\s*fetchPageTags,\s*type\s+PageListRow,\s*type\s+PageTagRow\s*\}\s+from\s+['"]\.\.\/helpers\/pages-api['"]/)
    expect(source).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(source).toContain('this.tags = await fetchPageTags(window.fetch.bind(window))')
    expect(source).toMatch(/fetchPages\(window\.fetch\.bind\(window\),\s*\{[\s\S]*locale: this\.locale === 'any' \? undefined : this\.locale,[\s\S]*tags: this\.selection/)
    expect(source).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('preserves independent tag and page loading state', () => {
    expect(source).toContain("setLoading(wikiStore, 'tags-refresh', true)")
    expect(source).toContain("setLoading(wikiStore, 'tags-refresh', false)")
    expect(source).toContain("setLoading(wikiStore, 'pages-refresh', true)")
    expect(source).toContain("setLoading(wikiStore, 'pages-refresh', false)")
    expect(source).toContain('this.isLoading = false')
  })
})
