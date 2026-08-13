const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(path.join(__dirname, 'history.vue'), 'utf8')

describe('history REST migration guard', () => {
  test('loads versions and restores through page REST helpers', () => {
    expect(source).toContain("import { fetchPageHistory, fetchPageVersion, restorePageVersion } from '../helpers/pages-api'")
    expect(source).toContain('const page = await fetchPageVersion(window.fetch.bind(window), this.pageId, versionId)')
    expect(source).toContain('await restorePageVersion(window.fetch.bind(window), this.pageId, this.restoreTarget.versionId)')
    expect(source).toContain("return { content: '' }")
    expect(source).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('preserves loading, cache, restore feedback, and trail pagination', () => {
    expect(source).toContain("loadingStart(this.$store, 'history-version-' + versionId)")
    expect(source).toContain('this.cache.push(page)')
    expect(source).toContain("showNotification(this.$store, {\n          style: 'success'")
    expect(source).toContain('this.isRestoreConfirmDialogShown = false')
    expect(source).toContain('return await fetchPageHistory(')
    expect(source).toContain("setLoading(this.$store, 'history-trail-refresh', false)")
  })
})
