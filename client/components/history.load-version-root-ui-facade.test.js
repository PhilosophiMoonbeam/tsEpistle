import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'client/components/history.vue'), 'utf8')

describe('history REST migration guard', () => {
  test('routes requests through abort-aware page REST helpers', () => {
    expect(source).toContain("<script lang='ts'>")
    expect(source).toContain(
      "import { fetchPageHistory, fetchPageVersion, restorePageVersion, type PageHistoryTrailItem, type PageVersion } from '../helpers/pages-api'"
    )
    expect(source).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(source).toMatch(
      /fetchWithAbort\s*\(url:\s*string,\s*init:\s*RequestInit\):\s*Promise<Response>\s*\{[\s\S]*?window\.fetch\s*\(\s*url,\s*\{[\s\S]*?signal:\s*this\.requestsAbortController\.signal/
    )
    expect(source).toContain('const page = await fetchPageVersion(this.fetchWithAbort, this.pageId, versionId)')
    expect(source).toContain('await restorePageVersion(this.fetchWithAbort, this.pageId, this.restoreTarget.versionId, this.sourceRevision)')
    expect(source).toMatch(/const result = await fetchPageHistory\s*\(\s*this\.fetchWithAbort,\s*this\.pageId,\s*offsetPage,/)
    expect(source).toContain('return this.requestsAbortController.signal.aborted ? null : result')
    expect(source).toContain('return { ...emptyPageVersion(versionId), path: this.path, locale: this.locale }')
    expect(source).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('preserves latest-request cleanup, loading, cache, errors, and restore feedback', () => {
    const watcherCleanups = source.match(/onCleanup\s*\(\s*\(\)\s*=>\s*\{\s*cancelled = true\s*\}\s*\)/g) || []

    expect(watcherCleanups).toHaveLength(2)
    expect(source).toContain('if (!cancelled && this.diffSource === newValue) {')
    expect(source).toContain('if (!cancelled && this.diffTarget === newValue) {')
    expect(source).toMatch(/beforeUnmount\s*\(\)\s*\{\s*this\.requestsAbortController\.abort\s*\(\s*\)/)
    expect(source).toContain('window.clearTimeout(this.restoreRedirectTimer)')
    expect(source).toContain("loadingStart(wikiStore, 'history-version-' + versionId)")
    expect(source).toContain("loadingStop(wikiStore, 'history-version-' + versionId)")
    expect(source).toContain('this.cache.push(page)')
    expect(source).toMatch(
      /if\s*\(\s*!this\.requestsAbortController\.signal\.aborted\s*\)\s*\{\s*showNotification\s*\(\s*wikiStore,\s*\{\s*style:\s*'red',\s*message:\s*getErrorMessage\(err\)/
    )
    expect(source).toMatch(/showNotification\s*\(\s*wikiStore,\s*\{\s*style:\s*'success'/)
    expect(source).toContain('this.isRestoreConfirmDialogShown = false')
    expect(source).toContain("loadingStop(wikiStore, 'history-restore')")
    expect(source).toContain("setLoading(wikiStore, 'history-trail-refresh', true)")
    expect(source).toContain("setLoading(wikiStore, 'history-trail-refresh', false)")
    expect(source).toContain('this.trailError = getErrorMessage(error)')
  })
})
