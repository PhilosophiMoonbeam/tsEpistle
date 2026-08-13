import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'client/components/history.vue'), 'utf8')

describe('history REST migration guard', () => {
  test('loads versions and restores through page REST helpers', () => {
    expect(source).toContain("<script lang='ts'>")
    expect(source).toContain("import { fetchPageHistory, fetchPageVersion, restorePageVersion, type PageHistoryTrailItem, type PageVersion } from '../helpers/pages-api'")
    expect(source).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(source).toContain('const page = await fetchPageVersion(window.fetch.bind(window), this.pageId, versionId)')
    expect(source).toContain('await restorePageVersion(window.fetch.bind(window), this.pageId, this.restoreTarget.versionId)')
    expect(source).toContain("return { versionId, content: '', title: '', description: '', path: this.path }")
    expect(source).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('preserves loading, cache, restore feedback, and trail pagination', () => {
    expect(source).toContain("loadingStart(wikiStore, 'history-version-' + versionId)")
    expect(source).toContain('this.cache.push(page)')
    expect(source).toContain("showNotification(wikiStore, {\n          style: 'success'")
    expect(source).toContain('this.isRestoreConfirmDialogShown = false')
    expect(source).toContain('return await fetchPageHistory(')
    expect(source).toContain("setLoading(wikiStore, 'history-trail-refresh', false)")
  })
})
