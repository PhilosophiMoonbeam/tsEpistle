const fs = require('fs')
const path = require('path')

describe('client-app showNotification facade migration guard', () => {
  const clientAppPath = path.join(process.cwd(), 'client/client-app.js')
  const source = fs.readFileSync(clientAppPath, 'utf8')

  test('client-app imports and uses root-ui-store showNotification instead of committing directly', () => {
    expect(source).toMatch(/import\s+\{[^}]*\bshowNotification\b[^}]*\}\s+from\s+['"]\.\/helpers\/root-ui-store['"]/)
    expect(source).toMatch(/\bshowNotification\s*\(\s*store\s*,/)
    expect(source).not.toMatch(/store\.commit\(\s*['"]showNotification['"]/)
  })
})
