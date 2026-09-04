import fs from 'node:fs'
import path from 'node:path'

function readScript(relativePath) {
  const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

describe('store singleton migration guard', () => {
  const cases = [
    {
      label: 'admin shell',
      path: 'client/components/admin.vue',
      storeUsage: /wikiStore\.page\.mode\s*=\s*['"]admin['"]/
    },
    {
      label: 'editor shell',
      path: 'client/components/editor.vue',
      storeUsage: /wikiStore\.editor\.editor/
    },
    {
      label: 'admin security editor settings',
      path: 'client/components/admin/admin-security.vue',
      storeUsage: /wikiStore\.editor\.activeModal/
    }
  ]

  test.each(cases)('$label uses the typed store singleton without legacy module registration', ({ path: relativePath, storeUsage }) => {
    const script = readScript(relativePath)

    expect(script).not.toBeNull()
    expect(script).toMatch(/import\s+\{\s*wikiStore\s*\}\s+from\s+['"]@\/store\/index\.ts['"]/)
    expect(script).toMatch(storeUsage)
    expect(script).not.toMatch(/\bregisterModule\s*\(/)
    expect(script).not.toMatch(/import\s+store\s+from\s+['"][^'"]*\/store(?:\/index(?:\.ts)?)?['"]/)
    expect(script).not.toContain('WIKI.$store')
    expect(script).not.toMatch(/\/\*\s*global\s+WIKI\s*\*\//)
  })
})
