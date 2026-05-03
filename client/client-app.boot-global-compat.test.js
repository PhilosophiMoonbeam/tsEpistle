const fs = require('fs')
const path = require('path')

const read = (relativePath) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')

describe('client app boot global compatibility guard', () => {
  const source = read('client/client-app.js')

  test('client app keeps public window.boot alias but uses imported boot internally', () => {
    expect(source).toMatch(/import\s+boot\s+from\s+['"]\.\/modules\/boot['"]/)
    expect(source).toContain('window.boot = boot')
    expect(source).toMatch(/\bboot\.notify\s*\(\s*['"]vue['"]\s*\)/)
    expect(source).toMatch(/\bboot\.onDOMReady\s*\(\s*bootstrap\s*\)/)
    expect(source).not.toMatch(/window\.boot\.notify\s*\(/)
    expect(source).not.toMatch(/window\.boot\.onDOMReady\s*\(/)
  })
})
