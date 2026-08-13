import fs from 'node:fs'
import path from 'node:path'

describe('admin logging console showNotification facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-logging-console.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('admin-logging-console.vue reports SSE failures through the root UI facade', () => {
    expect(script).not.toBeNull()
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toContain("this.liveSource = new EventSource('/_api/logging/live')")
    expect(script).toMatch(/this\.liveSource\.onerror\s*=\s*\(\)\s*=>\s*\{[\s\S]*wikiStore\.showNotification\s*\(\s*\{[\s\S]*message:\s*['"]Live console connection failed\.['"]/)
    expect(script).not.toMatch(/\$apollo|graphql-tag|self\.\$store/)
  })
})
