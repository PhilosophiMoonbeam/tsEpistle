const fs = require('fs')
const path = require('path')

const sourcePath = path.join(process.cwd(), 'client/components/admin/admin-utilities-content.vue')

const extractScript = (source) => {
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
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
    expect(script).toMatch(/import\s+\{\s*loadingStart,\s*loadingStop,\s*showNotification,\s*pushGraphError\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toMatch(/import\s+\{\s*migratePagesToLocale,\s*purgePageHistory,\s*rebuildPageTree\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/system-api['"]/)
    expect(script).not.toMatch(/utilities-mutation-content-(?:rebuildtree|migratelocale)\.gql/)
    expect(script).not.toMatch(/utilityContent(?:RebuildTree|MigrateLocale)Mutation/)
  })

  test('rebuildTree uses REST helper while preserving loading, notification, and error facades', () => {
    const rebuildTree = extractMethod(script, 'rebuildTree')

    expect(rebuildTree).toMatch(/this\.loading\s*=\s*true/)
    expect(rebuildTree).toMatch(/loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-content-rebuildtree['"]\s*\)/)
    expect(rebuildTree).toMatch(/await\s+rebuildPageTree\s*\(\s*window\.fetch\.bind\(window\)\s*\)/)
    expect(rebuildTree).toMatch(/showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]Page Tree rebuilt successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(rebuildTree).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)/)
    expect(rebuildTree).toMatch(/loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-content-rebuildtree['"]\s*\)/)
    expect(rebuildTree).toMatch(/this\.loading\s*=\s*false/)
    expect(rebuildTree).not.toMatch(/this\.\$apollo\.mutate|utilityContentRebuildTreeMutation|\$store\.commit/)
  })

  test('purgeHistory uses REST helper while preserving loading, notification, and error facades', () => {
    const purgeHistory = extractMethod(script, 'purgeHistory')

    expect(purgeHistory).toMatch(/this\.loading\s*=\s*true/)
    expect(purgeHistory).toMatch(/loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-content-purgehistory['"]\s*\)/)
    expect(purgeHistory).toMatch(/await\s+purgePageHistory\s*\(\s*window\.fetch\.bind\(window\)\s*,\s*this\.purgeHistorySelection\s*\)/)
    expect(purgeHistory).toMatch(/showNotification\s*\(\s*this\.\$store\s*,/)
    expect(purgeHistory).toMatch(/message:\s*`Purged history successfully\.`/)
    expect(purgeHistory).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)/)
    expect(purgeHistory).toMatch(/loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-content-purgehistory['"]\s*\)/)
    expect(purgeHistory).toMatch(/this\.loading\s*=\s*false/)
    expect(purgeHistory).not.toMatch(/this\.\$apollo\.mutate|pages\.purgeHistory|\$store\.commit/)
  })

  test('migrateToLocale uses REST helper while preserving loading, notification, and error facades', () => {
    const migrateToLocale = extractMethod(script, 'migrateToLocale')

    expect(migrateToLocale).toMatch(/this\.loading\s*=\s*true/)
    expect(migrateToLocale).toMatch(/loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-content-migratelocale['"]\s*\)/)
    expect(migrateToLocale).toMatch(/await\s+migratePagesToLocale\s*\(\s*window\.fetch\.bind\(window\)\s*,\s*this\.sourceLocale\s*,\s*this\.targetLocale\s*\)/)
    expect(migrateToLocale).toMatch(/message:\s*`Migrated \$\{resp\.count\} page\(s\) to target locale successfully\.`/)
    expect(migrateToLocale).toMatch(/showNotification\s*\(\s*this\.\$store\s*,/)
    expect(migrateToLocale).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)/)
    expect(migrateToLocale).toMatch(/loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-content-migratelocale['"]\s*\)/)
    expect(migrateToLocale).toMatch(/this\.loading\s*=\s*false/)
    expect(migrateToLocale).not.toMatch(/this\.\$apollo\.mutate|utilityContentMigrateLocaleMutation|\$store\.commit/)
  })
})
