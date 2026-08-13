const fs = require('fs')
const path = require('path')

describe('client-app Apollo removal guard', () => {
  const clientAppPath = path.join(process.cwd(), 'client/client-app.js')
  const source = fs.readFileSync(clientAppPath, 'utf8')

  test('client-app bootstraps Vue without installing Apollo', () => {
    expect(source).toContain('const i18n = localization.init()')
    expect(source).toContain('window.WIKI = new Vue({')
    expect(source).not.toMatch(/ApolloClient|VueApollo|graphQLClient|window\.graphQL|apollo-link|\bapolloProvider\b/)
  })
})
