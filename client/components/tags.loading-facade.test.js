import fs from 'node:fs'
import path from 'node:path'

describe('tags REST migration guard', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'client/components/tags.vue'), 'utf8')

  test('loads tags and filtered pages as raw REST results', () => {
    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(source).toMatch(
      /import\s+\{\s*fetchPages,\s*fetchPageTags,\s*type\s+PageListRow,\s*type\s+PageTagRow\s*\}\s+from\s+['"]\.\.\/helpers\/pages-api['"]/
    )
    expect(source).toContain("import { markRaw } from 'vue'")
    expect(source).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(source).toContain('this.tags = markRaw(await fetchPageTags(window.fetch.bind(window)))')
    expect(source).toMatch(
      /fetchPages\(window\.fetch\.bind\(window\),\s*\{[\s\S]*locale: this\.locale === 'any' \? undefined : this\.locale,[\s\S]*tags: this\.selection/
    )
    expect(source).toContain('if (sequence === this.pagesLoadSequence) this.pages = markRaw(pages)')
    expect(source).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('groups tags with native keyed accumulation', () => {
    expect(source).toMatch(/tagsGrouped\s*\(\)\s*\{\s*return this\.tags\.reduce<Record<string, PageTagRow\[\]>>\(\(groups, tag\) => \{/)
    expect(source).toContain("const groupName = (tag.title ?? '').charAt(0).toUpperCase()")
    expect(source).toContain(';(groups[groupName] ??= []).push(tag)')
    expect(source).not.toMatch(/\bgroupBy\s*\(/)
  })

  test('hydrates scalar and repeated route query values before enabling route sync', () => {
    expect(source).toMatch(
      /function normalizeQueryValue \(value: unknown\): string \| undefined \{\s*const normalized = Array\.isArray\(value\) \? value\[0\] : value\s*return typeof normalized === 'string' && normalized\.length > 0 \? normalized : undefined\s*\}/
    )
    expect(source).toContain('const lang = normalizeQueryValue(this.$route.query.lang)')
    expect(source).toContain('const sort = normalizeQueryValue(this.$route.query.sort)')
    expect(source).toContain('const direction = normalizeQueryValue(this.$route.query.dir)')
    expect(source).toMatch(/this\.loadTags\(\)\s*this\.loadPages\(\)\s*this\.\$nextTick\(\(\) => \{\s*this\.routeSyncReady = true/)
  })

  test('preserves independent tag and page loading state', () => {
    expect(source).toContain("setLoading(wikiStore, 'tags-refresh', true)")
    expect(source).toContain("setLoading(wikiStore, 'tags-refresh', false)")
    expect(source).toContain("setLoading(wikiStore, 'pages-refresh', true)")
    expect(source).toContain("setLoading(wikiStore, 'pages-refresh', false)")
    expect(source).toContain('this.isLoading = false')
  })

  test('keeps filtering, pagination, and route selection wired to current state', () => {
    expect(source).toContain(":items='pages'")
    expect(source).toContain(":items-per-page='pagination.itemsPerPage'")
    expect(source).toContain(":search='innerSearch'")
    expect(source).toContain("v-model:page='pagination.page'")
    expect(source).toContain(":sort-by='pagination.sortBy'")
    expect(source).toContain('this.pagination.page = 1')
    expect(source).toContain('this.selection = tagSelectionFromPath(this.$route.path)')
    expect(source).toContain('path: pathFromTagSelection(this.selection)')
  })

  test('keeps the tags scroll wrapper within the supported vue-scroll option boundary', () => {
    expect(source).toMatch(/scrollStyle:\s*\{\s*scrollPanel:\s*\{\s*scrollingX:\s*false\s*\}\s*\}/)
    expect(source).not.toMatch(/verticalNativeBarPos|(?:vuescroll|rail|bar)\s*:/)
  })

  test('renders native page links from Vuetify iterator raw values', () => {
    expect(source).toContain("v-for='entry of props.items'")
    expect(source).toContain('{{entry.raw.title}}')
    expect(source).toMatch(/:href\s*=\s*['"]`\/\$\{entry\.raw\.locale\}\/\$\{entry\.raw\.path\}`['"]/)
    expect(source).not.toMatch(/@click\s*=\s*['"]goTo\(entry\.raw\)['"]/)
  })
})
