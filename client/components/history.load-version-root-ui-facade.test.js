const fs = require('fs')
const path = require('path')

const sourcePath = path.join(__dirname, 'history.vue')
const source = fs.readFileSync(sourcePath, 'utf8')

const extractMethod = (name) => {
  const marker = `    async ${name} (`
  const start = source.indexOf(marker)
  expect(start).toBeGreaterThan(-1)

  const rest = source.slice(start)
  const match = rest.match(/\n {4}(?:async )?[a-zA-Z0-9_]+\s*\(/)
  expect(match).not.toBeNull()

  return rest.slice(0, match.index)
}

describe('history loadVersion root UI facade migration guard', () => {
  const loadVersion = extractMethod('loadVersion')

  test('imports the root UI loading helpers for loadVersion and trail watcher', () => {
    expect(source).toContain("import { loadingStart, loadingStop, setLoading } from '../helpers/root-ui-store'")
  })

  test('loadVersion routes version loading through the facade', () => {
    expect(loadVersion).toContain("loadingStart(this.$store, 'history-version-' + versionId)")
    expect(loadVersion).toContain("loadingStop(this.$store, 'history-version-' + versionId)")

    expect(loadVersion).not.toContain("this.$store.commit(`loadingStart`, 'history-version-' + versionId)")
    expect(loadVersion).not.toContain("this.$store.commit(`loadingStop`, 'history-version-' + versionId)")
  })

  test('loadVersion preserves the version query, variables, cache, and fallback behavior', () => {
    expect(loadVersion).toContain('const resp = await this.$apollo.query({')
    expect(loadVersion).toContain('version (pageId: $pageId, versionId: $versionId)')
    expect(loadVersion).toContain('versionId,')
    expect(loadVersion).toContain('pageId: this.pageId')
    expect(loadVersion).toContain("const page = _.get(resp, 'data.pages.version', null)")
    expect(loadVersion).toContain('this.cache.push(page)')
    expect(loadVersion).toContain('return page')
    expect(loadVersion).toContain("return { content: '' }")
  })

  test('trail watcher routes history trail loading through the facade', () => {
    expect(source).toContain('watchLoading (isLoading) {\n        setLoading(this.$store, \'history-trail-refresh\', isLoading)\n      }')
    expect(source).not.toContain('this.$store.commit(`loading' + '$' + "{isLoading ? 'Start' : 'Stop'}`, 'history-trail-refresh')")
  })

  test('keeps restore flow, page state commits, and history template out of this slice', () => {
    expect(source).toContain("this.$store.commit('page/SET_ID', this.id)")
    expect(source).toContain("this.$store.commit('page/SET_MODE', 'history')")
    expect(source).toContain("this.$store.commit(`loadingStart`, 'history-restore')")
    expect(source).toContain("this.$store.commit('showNotification', {")
    expect(source).toContain("this.$store.commit(`loadingStop`, 'history-restore')")
    expect(source).toContain("v-btn(color='orange darken-2', dark, @click='restoreConfirm', :loading='restoreLoading')")
  })
})
