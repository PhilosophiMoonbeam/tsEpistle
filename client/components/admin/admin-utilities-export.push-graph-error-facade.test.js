const fs = require('fs')
const path = require('path')

describe('admin utilities export REST facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-utilities-export.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('admin-utilities-export.vue uses system REST helpers instead of inline Apollo export mutation', () => {
    expect(script).not.toBeNull()
    expect(script).toContain("import { fetchSystemExportStatus, startSystemExport } from '../../helpers/system-api'")
    expect(script).toContain("import { pushGraphError } from '../../helpers/root-ui-store'")
    expect(script).not.toMatch(/graphql-tag|gql`|this\.\$apollo\.mutate|system\s*\{\s*export/)
  })

  test('startExport routes REST initiation failures through root-ui-store pushGraphError and preserves progress polling', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/async\s+startExport\s*\(\s*\)\s*\{[\s\S]*?await\s+startSystemExport\s*\(\s*window\.fetch\.bind\(window\)\s*,\s*this\.entities\s*,\s*this\.filePath\s*,\s*['"]Export failed['"]\s*\)[\s\S]*?this\.checkProgress\s*\(\s*\)/)
    expect(script).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*this\.errorMessage\s*=\s*err\.message\s*this\.isFailed\s*=\s*true\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*this\.isLoading\s*=\s*false\s*\}/)
    expect(script).not.toMatch(/this\.\$store\.commit\(\s*['"]pushGraphError['"]\s*,/)

    const pushGraphErrorCalls = script.match(/pushGraphError\s*\(/g) || []
    expect(pushGraphErrorCalls).toHaveLength(1)
  })

  test('checkProgress keeps its local export failure UI state handling unchanged', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/async\s+checkProgress\s*\(\s*\)\s*\{[\s\S]*?catch\s*\(\s*err\s*\)\s*\{\s*this\.errorMessage\s*=\s*err\.message\s*this\.isLoading\s*=\s*false\s*this\.isFailed\s*=\s*true\s*\}\s*\},\s*async\s+startExport/)
  })
})
