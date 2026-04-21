const { getPageDownloadPath } = require('./page-actions')

describe('client/helpers/page-actions', () => {
  it('builds a live page download path', () => {
    expect(getPageDownloadPath('en', 'docs/getting-started')).toBe('/d/en/docs/getting-started')
  })

  it('builds a versioned page download path', () => {
    expect(getPageDownloadPath('fr', 'guides/intro', 42)).toBe('/d/fr/guides/intro?v=42')
  })
})
