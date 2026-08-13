import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const storePath = join(process.cwd(), 'client/store/index.ts')
const source = readFileSync(storePath, 'utf8')
describe('store showError root-ui decoupling guard', () => {
  test('showError updates notification state through the Pinia store without WIKI root store dependency', () => {
    expect(source).not.toMatch(/\/\*\s*global\s+WIKI\s*\*\//)
    expect(source).not.toMatch(/\bWIKI\.\$store\.commit\s*\(/)
    expect(source).not.toMatch(/showError\s*\([^)]*\)\s*\{[\s\S]*?\bcommit\s*\(/)

    expect(source).toMatch(/showNotification\s*\(\s*options:\s*Partial<Notification>\s*\)\s*\{\s*this\.notification\s*=\s*\{[\s\S]*?message:\s*['"]['"][\s\S]*?style:\s*['"]primary['"][\s\S]*?icon:\s*['"]cached['"][\s\S]*?isActive:\s*true[\s\S]*?\.\.\.options[\s\S]*?\}\s*\}/)
    expect(source).toMatch(/showError\s*\(\s*error:\s*unknown\s*\)\s*\{[\s\S]*?Reflect\.get\s*\(\s*error\s*,\s*['"]graphQLErrors['"]\s*\)[\s\S]*?Reflect\.get\s*\(\s*firstError\s*,\s*['"]message['"]\s*\)[\s\S]*?Reflect\.get\s*\(\s*error\s*,\s*['"]message['"]\s*\)[\s\S]*?typeof graphMessage === ['"]string['"][\s\S]*?message = graphMessage[\s\S]*?typeof errorMessage === ['"]string['"][\s\S]*?message = errorMessage[\s\S]*?this\.showNotification\s*\(\s*\{\s*style:\s*['"]red['"]\s*,\s*message\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)\s*\}/)
  })
})
