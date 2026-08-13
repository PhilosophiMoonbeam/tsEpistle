import fs from 'node:fs'
import path from 'node:path'

const sourcePath = path.join(process.cwd(), 'client/components/admin/admin-utilities-content.vue')

const extractScript = (source) => {
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const extractMethod = (script, methodName) => {
  const start = script.indexOf(`async ${methodName} ()`)
  if (start === -1) {
    return ''
  }
  const next = script.indexOf('\n    async ', start + 1)
  return next === -1 ? script.slice(start) : script.slice(start, next)
}

describe('admin utilities content REST facades', () => {
  let source
  let script

  beforeEach(() => {
    source = fs.readFileSync(sourcePath, 'utf8')
    script = extractScript(source)
  })

  test('imports REST content helpers and no obsolete content mutation documents', () => {
    expect(source).toMatch(/<script\s+lang=["']ts["']>/)
    expect(script).toContain("import { defineComponent } from 'vue'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toMatch(/import\s+\{\s*fetchPageList\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/pages-api['"]/)
    expect(script).toMatch(/import\s+\{\s*migratePagesToLocale,\s*purgePageHistory,\s*rebuildPageTree,\s*renderPage\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/system-api['"]/)
    expect(script).not.toMatch(/utilities-mutation-content-(?:rebuildtree|migratelocale)\.gql/)
    expect(script).not.toMatch(/utilityContent(?:RebuildTree|MigrateLocale)Mutation/)
  })

  test('rebuildTree uses REST helper while preserving loading, notification, and error facades', () => {
    const rebuildTree = extractMethod(script, 'rebuildTree')

    expect(rebuildTree).toMatch(/this\.loading\s*=\s*true/)
    expect(rebuildTree).toMatch(/wikiStore\.startLoading\s*\(\s*['"]admin-utilities-content-rebuildtree['"]\s*\)/)
    expect(rebuildTree).toMatch(/await\s+rebuildPageTree\s*\(\s*window\.fetch\.bind\(window\)\s*\)/)
    expect(rebuildTree).toMatch(/wikiStore\.showNotification\s*\(\s*\{\s*message:\s*['"]Page Tree rebuilt successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(rebuildTree).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*wikiStore\.showError\s*\(\s*err\s*\)/)
    expect(rebuildTree).toMatch(/wikiStore\.stopLoading\s*\(\s*['"]admin-utilities-content-rebuildtree['"]\s*\)/)
    expect(rebuildTree).toMatch(/this\.loading\s*=\s*false/)
    expect(rebuildTree).not.toMatch(/this\.\$apollo\.mutate|utilityContentRebuildTreeMutation|\$store\.commit/)
  })

  test('rerenderPages fetches the page list through REST and renders each page through REST helper and facades', () => {
    const rerenderPages = extractMethod(script, 'rerenderPages')

    expect(rerenderPages).toMatch(/this\.loading\s*=\s*true/)
    expect(rerenderPages).toMatch(/this\.isRerendering\s*=\s*true/)
    expect(rerenderPages).toMatch(/wikiStore\.startLoading\s*\(\s*['"]admin-utilities-content-rerender['"]\s*\)/)
    expect(rerenderPages).toMatch(/await\s+fetchPageList\s*\(\s*window\.fetch\.bind\(window\)\s*\)/)
    expect(rerenderPages).toMatch(/await\s+renderPage\s*\(\s*window\.fetch\.bind\(window\)\s*,\s*page\.id\s*\)/)
    expect(rerenderPages).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*failed\+\+/)
    expect(rerenderPages).toMatch(/wikiStore\.showNotification\s*\(\s*\{/)
    expect(rerenderPages).toMatch(/wikiStore\.showError\s*\(\s*err\s*\)/)
    expect(rerenderPages).toMatch(/wikiStore\.stopLoading\s*\(\s*['"]admin-utilities-content-rerender['"]\s*\)/)
    expect(rerenderPages).toMatch(/this\.isRerendering\s*=\s*false/)
    expect(rerenderPages).toMatch(/this\.loading\s*=\s*false/)
    expect(rerenderPages).not.toMatch(/this\.\$apollo|graphql-tag|gql`|pages\s*\{\s*list|pages\s*\{\s*render|\$store\.commit/)
  })

  test('purgeHistory uses REST helper while preserving loading, notification, and error facades', () => {
    const purgeHistory = extractMethod(script, 'purgeHistory')

    expect(purgeHistory).toMatch(/this\.loading\s*=\s*true/)
    expect(purgeHistory).toMatch(/wikiStore\.startLoading\s*\(\s*['"]admin-utilities-content-purgehistory['"]\s*\)/)
    expect(purgeHistory).toMatch(/await\s+purgePageHistory\s*\(\s*window\.fetch\.bind\(window\)\s*,\s*this\.purgeHistorySelection\s*\)/)
    expect(purgeHistory).toMatch(/wikiStore\.showNotification\s*\(\s*\{/)
    expect(purgeHistory).toMatch(/message:\s*`Purged history successfully\.`/)
    expect(purgeHistory).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*wikiStore\.showError\s*\(\s*err\s*\)/)
    expect(purgeHistory).toMatch(/wikiStore\.stopLoading\s*\(\s*['"]admin-utilities-content-purgehistory['"]\s*\)/)
    expect(purgeHistory).toMatch(/this\.loading\s*=\s*false/)
    expect(purgeHistory).not.toMatch(/this\.\$apollo\.mutate|pages\.purgeHistory|\$store\.commit/)
  })

  test('migrateToLocale uses REST helper while preserving loading, notification, and error facades', () => {
    const migrateToLocale = extractMethod(script, 'migrateToLocale')

    expect(migrateToLocale).toMatch(/this\.loading\s*=\s*true/)
    expect(migrateToLocale).toMatch(/wikiStore\.startLoading\s*\(\s*['"]admin-utilities-content-migratelocale['"]\s*\)/)
    expect(migrateToLocale).toMatch(/await\s+migratePagesToLocale\s*\(\s*window\.fetch\.bind\(window\)\s*,\s*this\.sourceLocale\s*,\s*this\.targetLocale\s*\)/)
    expect(migrateToLocale).toMatch(/message:\s*`Migrated \$\{resp\.count\} page\(s\) to target locale successfully\.`/)
    expect(migrateToLocale).toMatch(/wikiStore\.showNotification\s*\(\s*\{/)
    expect(migrateToLocale).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*wikiStore\.showError\s*\(\s*err\s*\)/)
    expect(migrateToLocale).toMatch(/wikiStore\.stopLoading\s*\(\s*['"]admin-utilities-content-migratelocale['"]\s*\)/)
    expect(migrateToLocale).toMatch(/this\.loading\s*=\s*false/)
    expect(migrateToLocale).not.toMatch(/this\.\$apollo\.mutate|utilityContentMigrateLocaleMutation|\$store\.commit/)
  })
})
