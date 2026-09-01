import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const sourcePath = path.join(__dirname, 'admin-navigation.vue')
const source = fs.readFileSync(sourcePath, 'utf8')

const extractMethod = name => {
  const marker = new RegExp(`    async ${name}\\s*\\([^)]*\\)`)
  const found = source.match(marker)
  expect(found).not.toBeNull()
  const start = found.index

  const rest = source.slice(start)
  const match = rest.match(/\n {4}(?:async )?[a-zA-Z0-9_]+\s*\(/)
  if (match) {
    return rest.slice(0, match.index)
  }

  const methodsEnd = rest.indexOf('\n    }\n  },')
  expect(methodsEnd).toBeGreaterThan(-1)

  return rest.slice(0, methodsEnd + '\n    }'.length)
}

describe('admin-navigation root UI facade for read-only option loaders and refresh notification', () => {
  const loadAllLocales = extractMethod('loadAllLocales')
  const loadGroups = extractMethod('loadGroups')
  const loadNavigation = extractMethod('loadNavigation')
  const refresh = extractMethod('refresh')
  const save = extractMethod('save')

  test('imports the typed wiki store and error helper used by loaders and refresh', () => {
    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(source).toContain("import { getErrorMessage } from '../../helpers/root-ui-store'")
    expect(source).toContain("import { wikiStore } from '@/store/index.ts'")
  })

  test('loadAllLocales routes loading and error notification through the wiki store', () => {
    expect(loadAllLocales).toContain("wikiStore.startLoading('admin-navigation-locales')")
    expect(loadAllLocales).toContain('wikiStore.showNotification({')
    expect(loadAllLocales).toContain('message: getErrorMessage(err)')
    expect(loadAllLocales).toContain("wikiStore.stopLoading('admin-navigation-locales')")

    expect(loadAllLocales).not.toContain("this.$store.commit('loadingStart', 'admin-navigation-locales')")
    expect(loadAllLocales).not.toContain("this.$store.commit('showNotification'")
    expect(loadAllLocales).not.toContain("this.$store.commit('loadingStop', 'admin-navigation-locales')")
  })

  test('loadGroups routes loading and error notification through the wiki store', () => {
    expect(loadGroups).toContain("wikiStore.startLoading('admin-navigation-groups')")
    expect(loadGroups).toContain('wikiStore.showNotification({')
    expect(loadGroups).toContain('message: getErrorMessage(err)')
    expect(loadGroups).toContain("wikiStore.stopLoading('admin-navigation-groups')")

    expect(loadGroups).not.toContain("this.$store.commit('loadingStart', 'admin-navigation-groups')")
    expect(loadGroups).not.toContain("this.$store.commit('showNotification'")
    expect(loadGroups).not.toContain("this.$store.commit('loadingStop', 'admin-navigation-groups')")
  })

  test('preserves loader fetch behavior and error notification payloads', () => {
    expect(loadAllLocales).toContain("this.allLocales = await fetchLocales(window.fetch.bind(window), 'Locales response is invalid')")
    expect(loadGroups).toContain("this.groups = await fetchGroupOptions(window.fetch.bind(window), 'Groups response is invalid')")

    for (const method of [loadAllLocales, loadGroups]) {
      expect(method).toContain("style: 'red'")
      expect(method).toContain('message: getErrorMessage(err)')
      expect(method).toContain("icon: 'alert'")
    }
  })

  test('loadNavigation routes REST loading, state snapshots, notification, and errors through the wiki store', () => {
    expect(loadNavigation).toContain('this.initialLoading = true')
    expect(loadNavigation).toContain("wikiStore.startLoading('admin-navigation-refresh')")
    expect(loadNavigation).toContain("const navigation = await fetchNavigation(window.fetch.bind(window), 'Navigation response is invalid')")
    expect(loadNavigation).toContain('this.config = _.cloneDeep(navigation.config)')
    expect(loadNavigation).toContain('const normalizedTrees = normalizeNavigationTrees(navigation.tree)')
    expect(loadNavigation).toContain('this.trees = _.cloneDeep(normalizedTrees)')
    expect(loadNavigation).toContain('this.persistedConfig = _.cloneDeep(this.config)')
    expect(loadNavigation).toContain('this.persistedTrees = _.cloneDeep(normalizedTrees)')
    expect(loadNavigation).not.toContain('this.trees = _.cloneDeep(navigation.tree)')
    expect(loadNavigation).toContain('this.current = createEmptyNavigationItem()')
    expect(loadNavigation).toContain('this.loaded = true')
    expect(loadNavigation).toContain('if (notify)')
    expect(loadNavigation).toContain('wikiStore.showNotification({')
    expect(loadNavigation).toContain("message: 'Navigation has been refreshed.'")
    expect(loadNavigation).toContain("style: 'success'")
    expect(loadNavigation).toContain("icon: 'cached'")
    expect(loadNavigation).toContain('wikiStore.showError(err)')
    expect(loadNavigation).toMatch(/finally\s*\{[\s\S]*this\.initialLoading\s*=\s*false[\s\S]*wikiStore\.stopLoading\('admin-navigation-refresh'\)/)
    expect(loadNavigation).not.toContain('$store.commit')
  })

  test('refresh confirms before discarding dirty state and delegates to REST load with notification', () => {
    expect(refresh).toMatch(/if\s*\(\s*this\.dirty\s*&&\s*!window\.confirm\(['"]Discard unsaved navigation changes and refresh\?['"]\)\s*\)\s*return/)
    expect(refresh).toContain('await this.loadNavigation(true)')
    expect(refresh).not.toContain('this.$apollo.queries.trees.refetch')
  })

  test('save and Apply controls honor snapshot dirtiness, mutation locking, and busy state', () => {
    expect(source).toMatch(
      /dirty\s*\(\s*\)\s*:\s*boolean\s*\{[\s\S]*?this\.persistedConfig\s*!==\s*null[\s\S]*?JSON\.stringify\(this\.config\)\s*!==\s*JSON\.stringify\(this\.persistedConfig\)[\s\S]*?JSON\.stringify\(this\.trees\)\s*!==\s*JSON\.stringify\(this\.persistedTrees\)/
    )
    expect(save).toMatch(/if\s*\(\s*!this\.loaded\s*\|\|\s*this\.initialLoading\s*\|\|\s*this\.saving\s*\|\|\s*!this\.dirty\s*\)\s*return/)
    expect(save).toMatch(
      /this\.saving\s*=\s*true[\s\S]*wikiStore\.startLoading\('admin-navigation-save'\)[\s\S]*const\s+normalizedTrees\s*=\s*normalizeNavigationTrees\(this\.trees\)[\s\S]*const\s+savedTrees\s*=\s*_\.cloneDeep\(normalizedTrees\)[\s\S]*const\s+savedConfig\s*=\s*_\.cloneDeep\(this\.config\)[\s\S]*this\.trees\s*=\s*normalizedTrees[\s\S]*await\s+saveNavigation\(window\.fetch\.bind\(window\),\s*savedTrees,\s*savedConfig\.mode,\s*savedConfig\.expandParent\)/
    )
    expect(save).toMatch(/this\.persistedConfig\s*=\s*savedConfig[\s\S]*this\.persistedTrees\s*=\s*savedTrees[\s\S]*wikiStore\.showNotification\(/)
    expect(save.indexOf('const savedTrees')).toBeLessThan(save.indexOf('await saveNavigation'))
    expect(save.indexOf('const savedConfig')).toBeLessThan(save.indexOf('await saveNavigation'))
    expect(save).not.toMatch(/saveNavigation\(window\.fetch\.bind\(window\),\s*this\.trees,/)
    expect(save).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*wikiStore\.showError\(err\)\s*\}/)
    expect(save).toMatch(/finally\s*\{\s*this\.saving\s*=\s*false\s*wikiStore\.stopLoading\('admin-navigation-save'\)\s*\}/)

    expect(source).toContain("v-chip(v-if='dirty', color='warning', variant='tonal', size='small') Unsaved changes")
    expect(source.match(/:disabled='!loaded \|\| initialLoading \|\| saving \|\| !dirty'/g)).toHaveLength(2)
    expect(source.match(/@click='save'/g)).toHaveLength(2)
  })
})
