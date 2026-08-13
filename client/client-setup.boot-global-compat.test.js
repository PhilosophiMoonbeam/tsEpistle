import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (relativePath) => readFileSync(join(process.cwd(), relativePath), 'utf8')

describe('client setup boot global compatibility guard', () => {
  const source = read('client/client-setup.ts')

  test('client setup keeps public window.boot alias but uses imported boot internally', () => {
    expect(source).toMatch(/import\s+boot\s+from\s+['"]\.\/modules\/boot\.ts['"]/)
    expect(source).toContain('window.boot = boot')
    expect(source).toMatch(/\bboot\.onDOMReady\s*\(\s*\(\s*\)\s*=>\s*\{/)
    expect(source).not.toMatch(/window\.boot\.onDOMReady\s*\(/)
  })
})
