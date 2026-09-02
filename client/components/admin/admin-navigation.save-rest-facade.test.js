import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const sourcePath = path.join(__dirname, 'admin-navigation.vue')
const source = fs.readFileSync(sourcePath, 'utf8')

const extractMethod = name => {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const declaration = new RegExp(`^([ \\t]+)(?:async\\s+)?${escapedName}\\s*\\([^\\n]*\\)\\s*(?::\\s*[^\\n{]+)?\\{`, 'm')
  const methodMatch = source.match(declaration)
  expect(methodMatch).not.toBeNull()

  const indentation = methodMatch[1]
  const start = methodMatch.index
  const rest = source.slice(start)
  const nextMethod = rest.match(new RegExp(`\\n${indentation}(?:async\\s+)?[a-zA-Z_$][\\w$]*\\s*\\([^\\n]*\\)\\s*(?::\\s*[^\\n{]+)?\\{`))
  if (nextMethod) {
    return rest.slice(0, nextMethod.index)
  }

  const methodsEnd = rest.match(new RegExp(`\\n${indentation}}\\n[ \\t]*},`))
  expect(methodsEnd).not.toBeNull()

  return rest.slice(0, methodsEnd.index + `\n${indentation}}`.length)
}

describe('admin-navigation save REST facade', () => {
  const save = extractMethod('save')
  const loadNavigation = extractMethod('loadNavigation')
  const copyFromLocale = extractMethod('copyFromLocale')
  test('imports navigation REST helpers and the typed wiki store without Apollo query surface', () => {
    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(source).toMatch(
      /import\s+\{\s*fetchNavigation,\s*saveNavigation,\s*type\s+NavigationConfig,\s*type\s+NavigationItem,\s*type\s+NavigationTreeRow\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/navigation-api['"]/
    )
    expect(source).toContain("import { getErrorMessage } from '../../helpers/root-ui-store'")
    expect(source).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(source).toContain("import { markRaw } from 'vue'")
    expect(source).not.toContain("import gql from 'graphql-tag'")
    expect(source).not.toContain('apollo: {')
    expect(source).not.toContain('this.$apollo')
    expect(source).not.toContain('navigation {')
    expect(source).not.toContain('config {')
  })

  test('save uses a locked raw REST baseline while preserving loading, success notification, and error facade', () => {
    expect(save).toContain("wikiStore.startLoading('admin-navigation-save')")
    expect(save).toContain('const normalizedTrees = normalizeNavigationTrees(this.trees)')
    expect(save).toContain('const savedTrees = _.cloneDeep(normalizedTrees)')
    expect(save).toContain('const savedConfig = _.cloneDeep(this.config)')
    expect(save).toContain('await saveNavigation(window.fetch.bind(window), savedTrees, savedConfig.mode, savedConfig.expandParent)')
    expect(save).toContain('this.persistedConfig = markRaw(savedConfig)')
    expect(save).toContain('this.persistedTrees = markRaw(savedTrees)')
    expect(save.indexOf('const savedTrees')).toBeLessThan(save.indexOf('await saveNavigation'))
    expect(save.indexOf('const savedConfig')).toBeLessThan(save.indexOf('await saveNavigation'))
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
  test('keeps Home structural and out of the persisted editable tree', () => {
    expect(source.match(/^[ \t]*v-list-item\.navigation-tree__home(?:\([^)]*\))?[ \t]*$/gm)).toHaveLength(1)
    const homeSection = source.slice(source.indexOf('.navigation-tree__home'), source.indexOf('draggable(v-model'))
    expect(homeSection).toMatch(/Home|common:header\.home/)
    expect(homeSection).not.toContain('selectItem(')
    expect(homeSection).not.toContain('deleteItem(')
    expect(source).not.toContain('admin:navigation.navType.home')
    expect(source).toContain("targetType: 'page'")
  })

  test('normalizes Home out of load, copy, current-tree, and save submissions', () => {
    const copy = copyFromLocale
    const currentTreeStart = source.indexOf('    currentTree:')
    const currentTreeEnd = source.indexOf('\n  },\n  watch:', currentTreeStart)
    const currentTree = source.slice(currentTreeStart, currentTreeEnd)
    const normalizationStart = source.indexOf('const isHomeLink')
    const normalizationEnd = source.indexOf('\n\nexport default', normalizationStart)
    const normalization = source.slice(normalizationStart, normalizationEnd)
    expect(normalization).toContain("item.targetType === 'home'")
    expect(normalization).toContain('items.filter(item => !isHomeLink(item))')
    expect(normalization).toContain('items: normalizeNavigationItems(tree.items)')
    expect(loadNavigation).toMatch(/(?:normalizeNavigationTrees|normalizeNavigationItems)[\s\S]*navigation\.tree/)
    expect(save).toContain('const normalizedTrees = normalizeNavigationTrees(this.trees)')
    expect(copy).toMatch(/(?:normalizeNavigationItems|normalizeNavigationTrees|filter)[\s\S]*(?:source|items)/)
    expect(currentTree).toMatch(/(?:normalizeNavigationItems|filter)/)
  })
})
