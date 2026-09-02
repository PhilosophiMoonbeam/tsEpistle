import fs from 'node:fs'
import path from 'node:path'

describe('admin utilities export REST facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-utilities-export.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('admin-utilities-export.vue uses system REST helpers instead of inline Apollo export mutation or root-store state', () => {
    expect(script).not.toBeNull()
    expect(source).toMatch(/<script\s+lang=["']ts["']>/)
    expect(script).toContain("import { defineComponent, markRaw } from 'vue'")
    expect(script).toContain("import { fetchSystemExportStatus, startSystemExport } from '../../helpers/system-api'")
    expect(script).not.toMatch(/\bwikiStore\b|root-ui-store/)
    expect(script).not.toMatch(/graphql-tag|gql`|this\.\$apollo\.mutate|system\s*\{\s*export/)
  })

  test('keeps export entities raw and the progress dialog controlled by operation state', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/const\s+ENTITY_CHOICES\s*=\s*markRaw<readonly\s+ExportEntityChoice\[\]>\s*\(\s*\[/)
    expect(script).toMatch(/entityChoices:\s*ENTITY_CHOICES/)
    expect(source).toMatch(/v-dialog\(\s*:model-value=['"]isLoading['"][\s\S]*?aria-labelledby=['"]export-progress-title['"]/)
    expect(source).not.toMatch(/v-dialog\(\s*v-model=['"]isLoading['"]/)
  })

  test('confirmed exports validate before initiating REST work and preserve generation-bound progress polling', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(
      /requestExport\s*\(\s*\)\s*\{\s*if\s*\(\s*this\.isExportValid\s*&&\s*!this\.isLoading\s*\)\s*\{\s*this\.isConfirming\s*=\s*true\s*\}\s*\}/
    )
    expect(script).toMatch(
      /async\s+confirmExport\s*\(\s*\)\s*\{\s*if\s*\(\s*!this\.isExportValid\s*\|\|\s*this\.isLoading\s*\)\s*\{\s*return\s*\}\s*this\.isConfirming\s*=\s*false\s*await\s+this\.startExport\s*\(\s*\)\s*\}/
    )
    expect(script).toMatch(
      /async\s+startExport\s*\(\s*\)\s*\{[\s\S]*?const\s+generation\s*=\s*this\.requestGeneration[\s\S]*?await\s+startSystemExport\s*\(\s*window\.fetch\.bind\(window\)\s*,\s*this\.entities\s*,\s*this\.filePath\s*,\s*['"]Export failed['"]\s*\)[\s\S]*?void\s+this\.checkProgress\s*\(\s*generation\s*\)/
    )
    expect(script).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*this\.isDisposed\s*\|\|\s*generation\s*!==\s*this\.requestGeneration\s*\)\s*\{\s*return\s*\}\s*this\.errorMessage\s*=\s*getErrorMessage\s*\(\s*err\s*\)\s*this\.isFailed\s*=\s*true\s*this\.isLoading\s*=\s*false\s*\}/
    )
    expect(script).not.toMatch(/this\.\$store\.commit\(\s*['"]pushGraphError['"]\s*,/)
  })

  test('checkProgress keeps local export failure UI handling for current mounted requests', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(
      /async\s+checkProgress\s*\(\s*this\s*:\s*ExportVm\s*,\s*generation\s*=\s*this\.requestGeneration\s*\)\s*\{[\s\S]*?catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*this\.isDisposed\s*\|\|\s*generation\s*!==\s*this\.requestGeneration\s*\)\s*\{\s*return\s*\}\s*this\.errorMessage\s*=\s*getErrorMessage\s*\(\s*err\s*\)\s*this\.isLoading\s*=\s*false\s*this\.isFailed\s*=\s*true\s*\}\s*\},\s*async\s+startExport/
    )
  })
})
