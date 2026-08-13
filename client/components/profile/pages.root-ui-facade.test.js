const fs = require('fs')
const path = require('path')

describe('profile pages REST migration guard', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'client/components/profile/pages.vue'), 'utf8')

  test('loads authored and created pages through the REST helper', () => {
    expect(source).toContain("import { fetchPages } from '../../helpers/pages-api'")
    expect(source).toContain('const userId = this.$store.get(\'user/id\')')
    expect(source).toMatch(/fetchPages\(window\.fetch\.bind\(window\),\s*\{\s*creatorId: userId,\s*authorId: userId\s*\}\)/)
    expect(source).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('preserves refresh feedback and loading state', () => {
    expect(source).toContain('await this.loadPages()')
    expect(source).toContain("message: this.$t('profile:pages.refreshSuccess')")
    expect(source).toContain("setLoading(this.$store, 'profile-pages-refresh', true)")
    expect(source).toContain("setLoading(this.$store, 'profile-pages-refresh', false)")
  })
})
