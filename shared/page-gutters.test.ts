import { describe, expect, it } from '../server/test/bun-test.mts'
import {
  DEFAULT_PAGE_GUTTER_STYLE,
  isPageGutterCustomCss,
  isPageGutterStyle,
  normalizePageGutterCustomCss,
  normalizePageGutterStyle
} from './page-gutters.ts'

describe('page gutter themes', () => {
  it('accepts every supported ornament and rejects unknown values', () => {
    for (const style of ['columns', 'orbits', 'laurel', 'aurora', 'none', 'custom']) {
      expect(isPageGutterStyle(style)).toBe(true)
    }
    expect(isPageGutterStyle('marble')).toBe(false)
  })

  it('uses the classical column treatment for absent legacy configuration', () => {
    expect(normalizePageGutterStyle(undefined)).toBe(DEFAULT_PAGE_GUTTER_STYLE)
    expect(normalizePageGutterStyle('unknown')).toBe(DEFAULT_PAGE_GUTTER_STYLE)
  })

  it('allows declaration-only custom CSS and keeps it scoped to the gutter element', () => {
    const declarations = '  background: radial-gradient(circle, #fff, transparent); opacity: .5;  '
    expect(isPageGutterCustomCss(declarations)).toBe(true)
    expect(normalizePageGutterCustomCss(declarations)).toBe('background: radial-gradient(circle, #fff, transparent); opacity: .5;')
  })

  it('rejects selectors, at-rules, and oversized custom CSS', () => {
    expect(isPageGutterCustomCss('.contents { display: none; }')).toBe(false)
    expect(isPageGutterCustomCss('@import url(example.css);')).toBe(false)
    expect(isPageGutterCustomCss('x'.repeat(4001))).toBe(false)
    expect(normalizePageGutterCustomCss('.contents { display: none; }')).toBe('')
  })
})
