import fs from 'node:fs'
import path from 'node:path'

describe('admin groups page-rule controls', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-groups-edit-rules.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('does not expose unsupported preset or import actions', () => {
    expect(script).not.toBeNull()
    expect(source).toContain("<script lang='ts'>")
    expect(source).toContain("@click='addRule'")
    expect(source).not.toMatch(/Load Preset|Save As Preset|Import Rules|Export Rules|Coming soon/i)
    expect(script).not.toMatch(/comingSoon|showNotification/)
  })
})
