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

describe('admin-navigation save REST facade', () => {
  const save = extractMethod('save')

  test('imports navigation REST helpers and root UI facades without Apollo query surface', () => {
    expect(source).toContain("import { fetchNavigation, saveNavigation } from '../../helpers/navigation-api'")
    expect(source).toContain("import { loadingStart, loadingStop, showNotification, pushGraphError } from '../../helpers/root-ui-store'")
    expect(source).not.toContain("import gql from 'graphql-tag'")
    expect(source).not.toContain('apollo: {')
    expect(source).not.toContain('this.$apollo')
    expect(source).not.toContain('navigation {')
    expect(source).not.toContain('config {')
    expect(source).not.toContain('tree {')
  })

  test('save uses REST helper while preserving loading, success notification, and error facade', () => {
    expect(save).toContain("loadingStart(this.$store, 'admin-navigation-save')")
    expect(save).toContain('await saveNavigation(window.fetch.bind(window), this.trees, this.config.mode)')
    expect(save).toContain('showNotification(this.$store, {')
    expect(save).toContain("message: this.$t('navigation.saveSuccess')")
    expect(save).toContain("style: 'success'")
    expect(save).toContain("icon: 'check'")
    expect(save).toContain('pushGraphError(this.$store, err)')
    expect(save).toContain("loadingStop(this.$store, 'admin-navigation-save')")

    expect(save).not.toContain('this.$apollo.mutate')
    expect(save).not.toContain('updateTree')
    expect(save).not.toContain('updateConfig')
    expect(save).not.toContain('$store.commit')
  })
})
