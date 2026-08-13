const fs = require('fs')
const path = require('path')

describe('tags REST migration guard', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'client/components/tags.vue'), 'utf8')

  test('loads tags and filtered pages through REST helpers', () => {
    expect(source).toContain("import { fetchPages, fetchPageTags } from '../helpers/pages-api'")
    expect(source).toContain('this.tags = await fetchPageTags(window.fetch.bind(window))')
    expect(source).toMatch(/fetchPages\(window\.fetch\.bind\(window\),\s*\{[\s\S]*locale: this\.locale === 'any' \? undefined : this\.locale,[\s\S]*tags: this\.selection/)
    expect(source).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('preserves independent tag and page loading state', () => {
    expect(source).toContain("setLoading(this.$store, 'tags-refresh', true)")
    expect(source).toContain("setLoading(this.$store, 'tags-refresh', false)")
    expect(source).toContain("setLoading(this.$store, 'pages-refresh', true)")
    expect(source).toContain("setLoading(this.$store, 'pages-refresh', false)")
    expect(source).toContain('this.isLoading = false')
  })
})
