import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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

  test('imports navigation REST helpers and the typed wiki store without Apollo query surface', () => {
    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(source).toMatch(/import\s+\{\s*fetchNavigation,\s*saveNavigation,\s*type\s+NavigationConfig,\s*type\s+NavigationItem,\s*type\s+NavigationTreeRow\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/navigation-api['"]/)
    expect(source).toContain("import { getErrorMessage } from '../../helpers/root-ui-store'")
    expect(source).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(source).not.toContain("import gql from 'graphql-tag'")
    expect(source).not.toContain('apollo: {')
    expect(source).not.toContain('this.$apollo')
    expect(source).not.toContain('navigation {')
    expect(source).not.toContain('config {')
    expect(source).not.toContain('tree {')
  })

  test('save uses REST helper while preserving loading, success notification, and error facade', () => {
    expect(save).toContain("wikiStore.startLoading('admin-navigation-save')")
    expect(save).toContain('await saveNavigation(window.fetch.bind(window), this.trees, this.config.mode, this.config.expandParent)')
    expect(save).toContain('wikiStore.showNotification({')
    expect(save).toContain("message: this.$t('admin:navigation.saveSuccess')")
    expect(save).toContain("style: 'success'")
    expect(save).toContain("icon: 'check'")
    expect(save).toContain('wikiStore.showError(err)')
    expect(save).toContain("wikiStore.stopLoading('admin-navigation-save')")

    expect(save).not.toContain('this.$apollo.mutate')
    expect(save).not.toContain('updateTree')
    expect(save).not.toContain('updateConfig')
    expect(save).not.toContain('$store.commit')
  })
})
