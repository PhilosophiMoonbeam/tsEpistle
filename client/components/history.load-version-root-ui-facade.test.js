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
  const restoreConfirm = extractMethod('restoreConfirm')

  test('imports the root UI loading and notification helpers for version and restore flows', () => {
    expect(source).toContain("import { loadingStart, loadingStop, setLoading, showNotification } from '../helpers/root-ui-store'")
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

  test('restoreConfirm routes restore loading and notifications through facades without changing behavior', () => {
    expect(restoreConfirm).toContain('this.restoreLoading = true')
    expect(restoreConfirm).toContain("loadingStart(this.$store, 'history-restore')")
    expect(restoreConfirm).toContain('const resp = await this.$apollo.mutate({')
    expect(restoreConfirm).toContain('restore (pageId: $pageId, versionId: $versionId)')
    expect(restoreConfirm).toContain('versionId: this.restoreTarget.versionId')
    expect(restoreConfirm).toContain('pageId: this.pageId')
    expect(restoreConfirm).toContain("_.get(resp, 'data.pages.restore.responseResult.succeeded', false) === true")
    expect(restoreConfirm).toMatch(/showNotification\(this\.\$store, \{\s*style: 'success',\s*message: this\.\$t\('history:restore\.success'\),\s*icon: 'check'\s*\}\)/)
    expect(restoreConfirm).toContain('this.isRestoreConfirmDialogShown = false')
    expect(restoreConfirm).toMatch(/setTimeout\(\(\) => \{\s*window\.location\.assign\(`\/\$\{this\.locale\}\/\$\{this\.path\}`\)\s*\}, 1000\)/)
    expect(restoreConfirm).toMatch(/showNotification\(this\.\$store, \{\s*style: 'red',\s*message: err\.message,\s*icon: 'alert'\s*\}\)/)
    expect(restoreConfirm).toContain("loadingStop(this.$store, 'history-restore')")
    expect(restoreConfirm).toContain('this.restoreLoading = false')

    expect(restoreConfirm).not.toContain("this.$store.commit(`loadingStart`, 'history-restore')")
    expect(restoreConfirm).not.toContain("this.$store.commit('showNotification'")
    expect(restoreConfirm).not.toContain("this.$store.commit(`loadingStop`, 'history-restore')")
    expect(restoreConfirm.match(/\bshowNotification\s*\(/g) || []).toHaveLength(2)
  })

  test('keeps page state commits and history template out of this slice', () => {
    expect(source).toContain("this.$store.commit('page/SET_ID', this.id)")
    expect(source).toContain("this.$store.commit('page/SET_MODE', 'history')")
    expect(source).toContain("v-btn(color='orange darken-2', dark, @click='restoreConfirm', :loading='restoreLoading')")
  })
})
