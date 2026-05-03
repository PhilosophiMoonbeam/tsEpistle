const fs = require('fs')
const path = require('path')

const read = (relativePath) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')

describe('client setup boot global compatibility guard', () => {
  const source = read('client/client-setup.js')

  test('client setup keeps public window.boot alias but uses imported boot internally', () => {
    expect(source).toMatch(/import\s+boot\s+from\s+['"]\.\/modules\/boot['"]/)
    expect(source).toContain('window.boot = boot')
    expect(source).toMatch(/\bboot\.onDOMReady\s*\(\s*bootstrap\s*\)/)
    expect(source).not.toMatch(/window\.boot\.onDOMReady\s*\(/)
  })
})
