const fs = require('fs')
const path = require('path')

const sourcePath = path.join(__dirname, 'admin-navigation.vue')
const source = fs.readFileSync(sourcePath, 'utf8')

const extractMethod = (name) => {
  const marker = `    async ${name}()`
  const start = source.indexOf(marker)
  expect(start).toBeGreaterThan(-1)

  const rest = source.slice(start)
  const match = rest.match(/\n {4}(?:async )?[a-zA-Z0-9_]+\s*\(/)
  expect(match).not.toBeNull()

  return rest.slice(0, match.index)
}

describe('admin-navigation root UI facade for read-only option loaders', () => {
  const loadAllLocales = extractMethod('loadAllLocales')
  const loadGroups = extractMethod('loadGroups')

  test('imports only the root UI helpers needed by the option loaders', () => {
    expect(source).toContain("import { loadingStart, loadingStop, showNotification } from '../../helpers/root-ui-store'")
  })

  test('loadAllLocales routes loading and error notification through the facade', () => {
    expect(loadAllLocales).toContain("loadingStart(this.$store, 'admin-navigation-locales')")
    expect(loadAllLocales).toContain('showNotification(this.$store, {')
    expect(loadAllLocales).toContain('message: err.message')
    expect(loadAllLocales).toContain("loadingStop(this.$store, 'admin-navigation-locales')")

    expect(loadAllLocales).not.toContain("this.$store.commit('loadingStart', 'admin-navigation-locales')")
    expect(loadAllLocales).not.toContain("this.$store.commit('showNotification'")
    expect(loadAllLocales).not.toContain("this.$store.commit('loadingStop', 'admin-navigation-locales')")
  })

  test('loadGroups routes loading and error notification through the facade', () => {
    expect(loadGroups).toContain("loadingStart(this.$store, 'admin-navigation-groups')")
    expect(loadGroups).toContain('showNotification(this.$store, {')
    expect(loadGroups).toContain('message: err.message')
    expect(loadGroups).toContain("loadingStop(this.$store, 'admin-navigation-groups')")

    expect(loadGroups).not.toContain("this.$store.commit('loadingStart', 'admin-navigation-groups')")
    expect(loadGroups).not.toContain("this.$store.commit('showNotification'")
    expect(loadGroups).not.toContain("this.$store.commit('loadingStop', 'admin-navigation-groups')")
  })

  test('preserves loader fetch behavior and error notification payloads', () => {
    expect(loadAllLocales).toContain("this.allLocales = await fetchLocales(window.fetch.bind(window), 'Locales response is invalid')")
    expect(loadGroups).toContain("this.groups = await fetchGroupOptions(window.fetch.bind(window), 'Groups response is invalid')")

    for (const method of [loadAllLocales, loadGroups]) {
      expect(method).toContain("style: 'red'")
      expect(method).toContain('message: err.message')
      expect(method).toContain("icon: 'alert'")
    }
  })

  test('keeps broader navigation save, refresh, Apollo watchers, and template out of this slice', () => {
    expect(source).toContain("this.$store.commit(`loadingStart`, 'admin-navigation-save')")
    expect(source).toContain("this.$store.commit('pushGraphError', err)")
    expect(source).toContain("this.$store.commit(`loadingStop`, 'admin-navigation-save')")
    expect(source).toContain("this.$store.commit('showNotification', {\n        message: 'Navigation has been refreshed.'")
    expect(source).toContain('this.$store.commit(`loading' + '$' + "{isLoading ? 'Start' : 'Stop'}`, 'admin-navigation-config')")
    expect(source).toContain('this.$store.commit(`loading' + '$' + "{isLoading ? 'Start' : 'Stop'}`, 'admin-navigation-tree')")
    expect(source).toContain("v-btn.animated.fadeInDown(color='success', depressed, @click='save', large)")
  })
})
