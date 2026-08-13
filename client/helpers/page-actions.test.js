import { getPageDownloadPath, getPageSourcePath } from './page-actions.ts'

describe('page actions helper', () => {
  test('returns live page download path without version query', () => {
    expect(getPageDownloadPath('en', 'docs/getting-started')).toBe('/d/en/docs/getting-started')
  })

  test('returns versioned page download path with version query', () => {
    expect(getPageDownloadPath('fr', 'guides/intro', 42)).toBe('/d/fr/guides/intro?v=42')
  })

  test('returns versioned page source path with version query', () => {
    expect(getPageSourcePath('fr', 'guides/intro', 42)).toBe('/s/fr/guides/intro?v=42')
  })
})
