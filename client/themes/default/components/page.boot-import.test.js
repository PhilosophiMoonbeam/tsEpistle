import fs from 'node:fs'
import path from 'node:path'

const read = (relativePath) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
const extractScript = (source) => {
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

describe('default page boot import guard', () => {
  const script = extractScript(read('client/themes/default/components/page.vue'))

  test('default page notifies page-ready through imported boot instead of window global', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/import\s+boot\s+from\s+['"]\.\.\/\.\.\/\.\.\/modules\/boot\.ts['"]/)
    expect(script).toMatch(/\bboot\.notify\s*\(\s*['"]page-ready['"]\s*\)/)
    expect(script).not.toMatch(/window\.boot\.notify\s*\(/)
  })
})
