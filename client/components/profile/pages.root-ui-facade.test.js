import fs from 'node:fs'
import path from 'node:path'

describe('profile pages REST migration guard', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'client/components/profile/pages.vue'), 'utf8')

  test('loads authored and created pages through the REST helper', () => {
    expect(source).toContain("<script lang='ts'>")
    expect(source).toContain("import { fetchPages, type PageListRow } from '../../helpers/pages-api'")
    expect(source).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(source).toContain('const userId = wikiStore.user.id')
    expect(source).toMatch(/fetchPages\(window\.fetch\.bind\(window\),\s*\{\s*creatorId: userId,\s*authorId: userId\s*\}\)/)
    expect(source).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('preserves refresh feedback and loading state', () => {
    expect(source).toContain('await this.loadPages()')
    expect(source).toContain("message: this.$t('profile:pages.refreshSuccess')")
    expect(source).toContain("setLoading(wikiStore, 'profile-pages-refresh', true)")
    expect(source).toContain("setLoading(wikiStore, 'profile-pages-refresh', false)")
  })
})
