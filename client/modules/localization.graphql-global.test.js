const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '../..')

describe('localization GraphQL client dependency', () => {
  const localizationSource = fs.readFileSync(path.join(repoRoot, 'client/modules/localization.js'), 'utf8')
  const clientAppSource = fs.readFileSync(path.join(repoRoot, 'client/client-app.js'), 'utf8')

  test('localization receives the Apollo client explicitly instead of using the global graphQL binding', () => {
    expect(localizationSource).toMatch(/init\s*\(\s*apolloClient\s*\)\s*\{/)
    expect(localizationSource).toContain('apolloClient.query({')
    expect(localizationSource).not.toMatch(/\/\*\s*global[^*]*graphQL/)
    expect(localizationSource).not.toMatch(/[^.]\bgraphQL\.query\s*\(/)
  })

  test('client-app passes the existing window GraphQL client to localization init', () => {
    expect(clientAppSource).toContain('const i18n = localization.init(window.graphQL)')
  })
})
