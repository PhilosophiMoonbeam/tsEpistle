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

  test('keeps private source and download actions in the explicit owner scope', () => {
    expect(getPageDownloadPath('en', 'same/path', 0, 'private')).toBe('/d/_private/en/same/path')
    expect(getPageSourcePath('en', 'same/path', 9, 'private')).toBe('/s/_private/en/same/path?v=9')
  })
})
