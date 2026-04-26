const fs = require('fs')
const path = require('path')

describe('admin utilities export pushGraphError facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-utilities-export.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('admin-utilities-export.vue routes only startExport GraphQL failures through root-ui-store pushGraphError', () => {
    expect(script).not.toBeNull()

    expect(script).toMatch(/import\s+\{[^}]*\bpushGraphError\b[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)

    expect(script).toMatch(/async\s+startExport\s*\(\s*\)\s*\{[\s\S]*?catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*this\.isLoading\s*=\s*false\s*\}/)
    expect(script).not.toMatch(/this\.\$store\.commit\(\s*['"]pushGraphError['"]\s*,/)

    const pushGraphErrorCalls = script.match(/\bpushGraphError\s*\(/g) || []
    expect(pushGraphErrorCalls).toHaveLength(1)
  })

  test('checkProgress keeps its local export failure UI state handling unchanged', () => {
    expect(script).not.toBeNull()

    expect(script).toMatch(/async\s+checkProgress\s*\(\s*\)\s*\{[\s\S]*?catch\s*\(\s*err\s*\)\s*\{\s*this\.errorMessage\s*=\s*err\.message\s*this\.isLoading\s*=\s*false\s*this\.isFailed\s*=\s*true\s*\}\s*\},\s*async\s+startExport/)
  })
})
