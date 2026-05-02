const fs = require('fs')
const path = require('path')

const storePath = path.join(process.cwd(), 'client/store/index.js')
const source = fs.readFileSync(storePath, 'utf8')
describe('store pushGraphError root-ui decoupling guard', () => {
  test('pushGraphError updates notification state directly without WIKI root store dependency', () => {
    expect(source).not.toMatch(/\/\*\s*global\s+WIKI\s*\*\//)
    expect(source).not.toMatch(/\bWIKI\.\$store\.commit\s*\(/)
    expect(source).not.toMatch(/pushGraphError\s*\(\s*st\s*,\s*err\s*\)\s*\{[\s\S]*?\bcommit\s*\(/)

    expect(source).toMatch(/pushGraphError\s*\(\s*st\s*,\s*err\s*\)\s*\{\s*st\.notification\s*=\s*_\.defaults\s*\(\s*\{[\s\S]*?style:\s*['"]red['"][\s\S]*?message:\s*_\.get\s*\(\s*err\s*,\s*['"]graphQLErrors\[0\]\.message['"]\s*,\s*err\.message\s*\)[\s\S]*?icon:\s*['"]alert['"][\s\S]*?\}\s*,\s*\{[\s\S]*?message:\s*['"]['"][\s\S]*?style:\s*['"]primary['"][\s\S]*?icon:\s*['"]cached['"][\s\S]*?isActive:\s*true[\s\S]*?\}\s*\)\s*\}/)
  })
})
