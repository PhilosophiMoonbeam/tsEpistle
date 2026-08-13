import fs from 'node:fs'
import path from 'node:path'

describe('admin utilities export REST facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-utilities-export.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('admin-utilities-export.vue uses system REST helpers instead of inline Apollo export mutation', () => {
    expect(script).not.toBeNull()
    expect(source).toMatch(/<script\s+lang=["']ts["']>/)
    expect(script).toContain("import { defineComponent } from 'vue'")
    expect(script).toContain("import { fetchSystemExportStatus, startSystemExport } from '../../helpers/system-api'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).not.toMatch(/graphql-tag|gql`|this\.\$apollo\.mutate|system\s*\{\s*export/)
  })

  test('startExport routes REST initiation failures through root-ui-store pushGraphError and preserves progress polling', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/async\s+startExport\s*\(\s*\)\s*\{[\s\S]*?await\s+startSystemExport\s*\(\s*window\.fetch\.bind\(window\)\s*,\s*this\.entities\s*,\s*this\.filePath\s*,\s*['"]Export failed['"]\s*\)[\s\S]*?this\.checkProgress\s*\(\s*\)/)
    expect(script).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*this\.errorMessage\s*=\s*getErrorMessage\s*\(\s*err\s*\)\s*this\.isFailed\s*=\s*true\s*wikiStore\.showError\s*\(\s*err\s*\)\s*this\.isLoading\s*=\s*false\s*\}/)
    expect(script).not.toMatch(/this\.\$store\.commit\(\s*['"]pushGraphError['"]\s*,/)

    const showErrorCalls = script.match(/wikiStore\.showError\s*\(/g) || []
    expect(showErrorCalls).toHaveLength(1)
  })

  test('checkProgress keeps its local export failure UI state handling unchanged', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/async\s+checkProgress\s*\(\s*\)\s*\{[\s\S]*?catch\s*\(\s*err\s*\)\s*\{\s*this\.errorMessage\s*=\s*getErrorMessage\s*\(\s*err\s*\)\s*this\.isLoading\s*=\s*false\s*this\.isFailed\s*=\s*true\s*\}\s*\},\s*async\s+startExport/)
  })
})
