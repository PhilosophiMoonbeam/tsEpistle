import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const sourcePath = path.join(__dirname, 'admin-navigation.vue')
const source = fs.readFileSync(sourcePath, 'utf8')

const extractMethod = (name) => {
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

  test('loadNavigation routes REST loading, state update, notification, and errors through the wiki store', () => {
    expect(loadNavigation).toContain("wikiStore.startLoading('admin-navigation-refresh')")
    expect(loadNavigation).toContain("const navigation = await fetchNavigation(window.fetch.bind(window), 'Navigation response is invalid')")
    expect(loadNavigation).toContain('this.config = _.cloneDeep(navigation.config)')
    expect(loadNavigation).toContain('this.trees = _.cloneDeep(navigation.tree)')
    expect(loadNavigation).toContain('this.current = createEmptyNavigationItem()')
    expect(loadNavigation).toContain('if (notify)')
    expect(loadNavigation).toContain('wikiStore.showNotification({')
    expect(loadNavigation).toContain("message: 'Navigation has been refreshed.'")
    expect(loadNavigation).toContain("style: 'success'")
    expect(loadNavigation).toContain("icon: 'cached'")
    expect(loadNavigation).toContain('wikiStore.showError(err)')
    expect(loadNavigation).toContain("wikiStore.stopLoading('admin-navigation-refresh')")
    expect(loadNavigation).not.toContain('$store.commit')
  })

  test('refresh delegates to REST load with notification', () => {
    expect(refresh).toContain('await this.loadNavigation(true)')
    expect(refresh).not.toContain('this.$apollo.queries.trees.refetch')
  })

  test('keeps broader navigation save and template out of this slice', () => {
    expect(source).toContain("wikiStore.startLoading('admin-navigation-save')")
    expect(source).toContain('wikiStore.showError(err)')
    expect(source).toContain("wikiStore.stopLoading('admin-navigation-save')")
    expect(source).toContain("v-btn.animated.fadeInDown(color='success', depressed, @click='save', large)")
  })
})
