const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '../..')

describe('localization REST dependency', () => {
  const localizationSource = fs.readFileSync(path.join(repoRoot, 'client/modules/localization.js'), 'utf8')
  const clientAppSource = fs.readFileSync(path.join(repoRoot, 'client/client-app.js'), 'utf8')

  test('localization loads namespace strings through the REST API', () => {
    expect(localizationSource).toMatch(/window\.fetch\(`\/_api\/locales\/\$\{encodeURIComponent\(langParams\[0\]\)\}\/strings\?namespace=\$\{encodeURIComponent\(langParams\[1\]\)\}`/)
    expect(localizationSource).toContain("credentials: 'same-origin'")
    expect(localizationSource).toContain("headers: { Accept: 'application/json' }")
    expect(localizationSource).not.toMatch(/ApolloClient|apolloClient|graphql-tag|\$apollo/)
  })

  test('client-app initializes localization without an Apollo client', () => {
    expect(clientAppSource).toContain('const i18n = localization.init()')
    expect(clientAppSource).not.toMatch(/ApolloClient|VueApollo|graphQLClient|window\.graphQL|apollo-link/)
  })
})
