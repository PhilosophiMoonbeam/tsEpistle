import fs from 'node:fs'
import path from 'node:path'

describe('search results agent launch path', () => {
  const componentPath = path.join(process.cwd(), 'client/components/common/search-results.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const template = source.match(/<template[^>]*>\s*([\s\S]*?)\s*<\/template>/)?.[1] ?? ''

  test('submits Ask handoffs through the mounted internal API', () => {
    expect(template).toMatch(/action=['"]\/_api\/agents\/launch['"]/)
    expect(template).not.toMatch(/action=['"]\/api\/agents\/launch['"]/)
  })
})
