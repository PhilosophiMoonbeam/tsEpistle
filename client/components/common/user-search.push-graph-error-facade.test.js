const fs = require('fs')
const path = require('path')

describe('user-search pushGraphError facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/common/user-search.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('user-search.vue imports and uses root-ui-store pushGraphError after stale request and item reset guards', () => {
    expect(script).not.toBeNull()

    expect(script).toMatch(/import\s+\{[^}]*\bpushGraphError\b[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)

    expect(script).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*requestId\s*!==\s*this\.searchRequestId\s*\|\|\s*query\s*!==\s*this\.search\s*\)\s*\{\s*return\s+\[\]\s*\}\s*this\.items\s*=\s*\[\]\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*return\s+\[\]\s*\}/)
    expect(script).toMatch(/finally\s*\{\s*if\s*\(\s*requestId\s*===\s*this\.searchRequestId\s*\)\s*\{\s*this\.searchLoading\s*=\s*false\s*\}\s*\}/)

    expect(script).not.toMatch(/this\.\$store\.commit\(\s*['"]pushGraphError['"]\s*,/)

    const pushGraphErrorCalls = script.match(/\bpushGraphError\s*\(/g) || []
    expect(pushGraphErrorCalls).toHaveLength(1)
  })
})
