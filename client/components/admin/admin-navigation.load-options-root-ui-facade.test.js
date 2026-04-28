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
  const refresh = extractMethod('refresh')

  test('imports only the root UI helpers needed by the option loaders and refresh notification', () => {
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

  test('refresh routes only its success notification through the facade', () => {
    expect(refresh).toContain('await this.$apollo.queries.trees.refetch()')
    expect(refresh).toContain('this.current = {}')
    expect(refresh).toContain('showNotification(this.$store, {')
    expect(refresh).toContain("message: 'Navigation has been refreshed.'")
    expect(refresh).toContain("style: 'success'")
    expect(refresh).toContain("icon: 'cached'")

    expect(refresh).not.toContain("this.$store.commit('showNotification'")
  })

  test('keeps broader navigation save, Apollo watchers, and template out of this slice', () => {
    expect(source).toContain("this.$store.commit(`loadingStart`, 'admin-navigation-save')")
    expect(source).toContain("this.$store.commit('pushGraphError', err)")
    expect(source).toContain("this.$store.commit(`loadingStop`, 'admin-navigation-save')")
    expect(source).toContain('this.$store.commit(`loading' + '$' + "{isLoading ? 'Start' : 'Stop'}`, 'admin-navigation-config')")
    expect(source).toContain('this.$store.commit(`loading' + '$' + "{isLoading ? 'Start' : 'Stop'}`, 'admin-navigation-tree')")
    expect(source).toContain("v-btn.animated.fadeInDown(color='success', depressed, @click='save', large)")
  })
})
