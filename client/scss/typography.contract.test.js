import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')
const normalizeValue = value => value.replace(/\s+/g, ' ').trim()

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const findBlockEnd = (source, open) => {
  let depth = 1
  let quote = null

  for (let cursor = open + 1; cursor < source.length; cursor++) {
    const character = source[cursor]
    if (quote) {
      if (character === '\\') cursor++
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '/' && source[cursor + 1] === '*') {
      const commentEnd = source.indexOf('*/', cursor + 2)
      if (commentEnd === -1) return -1
      cursor = commentEnd + 1
      continue
    }
    if (character === '{') depth++
    if (character === '}' && --depth === 0) return cursor
  }

  return -1
}

const extractBlocks = (source, marker) => {
  const blocks = []
  const exactRule = new RegExp(`^[\\t ]*${escapeRegExp(marker)}[\\t ]*\\{`, 'gm')
  let match

  while ((match = exactRule.exec(source)) !== null) {
    const open = match.index + match[0].lastIndexOf('{')
    const close = findBlockEnd(source, open)
    if (close === -1) throw new Error(`Unclosed ${marker} block`)
    blocks.push(source.slice(open + 1, close))
    exactRule.lastIndex = close + 1
  }

  return blocks
}

const declarations = block =>
  Object.fromEntries([...block.matchAll(/^\s*([\w-]+)\s*:\s*([^;]+);/gm)].map(([, property, value]) => [property, normalizeValue(value)]))

const collectSourceFiles = directory =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) return collectSourceFiles(absolutePath)
    if (!/\.(?:js|ts|vue|scss)$/.test(entry.name) || entry.name.includes('.test.')) return []
    return [absolutePath]
  })

const LATIN_EXT =
  'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF'
const LATIN =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'

const expectedFaces = [
  { file: 'RobotoFlex-v30-latin-ext.woff2', family: "'Roboto Flex'", style: 'normal', weight: '100 1000', stretch: 'normal', range: LATIN_EXT },
  { file: 'RobotoFlex-v30-latin.woff2', family: "'Roboto Flex'", style: 'normal', weight: '100 1000', stretch: 'normal', range: LATIN },
  { file: 'Newsreader-v26-latin-ext-normal.woff2', family: "'Newsreader'", style: 'normal', weight: '200 800', range: LATIN_EXT },
  { file: 'Newsreader-v26-latin-normal.woff2', family: "'Newsreader'", style: 'normal', weight: '200 800', range: LATIN },
  { file: 'Newsreader-v26-latin-ext-italic.woff2', family: "'Newsreader'", style: 'italic', weight: '200 800', range: LATIN_EXT },
  { file: 'Newsreader-v26-latin-italic.woff2', family: "'Newsreader'", style: 'italic', weight: '200 800', range: LATIN }
]

const expectedFontFiles = [...expectedFaces.map(face => face.file), 'RobotoMono-Regular.woff2'].sort()
const expectedLicenses = ['Newsreader-OFL.txt', 'RobotoFlex-OFL.txt', 'RobotoMono-OFL.txt']

describe('self-hosted typography contracts', () => {
  const base = read('client/scss/base/base.scss')
  const fontSource = read('client/scss/fonts/default.scss')
  const clientApp = read('client/client-app.ts')
  const wikiStoreSource = read('client/store/index.ts')
  const fontFaces = extractBlocks(fontSource, '@font-face').map(declarations)
  const assetNames = fs.readdirSync(path.join(root, 'client/fonts/default'))

  test('blends display type by default and restores uniform roles for explicit fonts', () => {
    const rootTokens = declarations(extractBlocks(base, ':root')[0])
    const newsreaderTokens = declarations(extractBlocks(base, "html[data-wiki-font='newsreader']")[0])

    expect(rootTokens['--wiki-font-newsreader']).toBe("'Newsreader', ui-serif, Georgia, Cambria, 'Times New Roman', serif")
    expect(rootTokens['--wiki-font-roboto-flex']).toBe("'Roboto Flex', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif")
    expect(rootTokens['--wiki-font-selected']).toBe('var(--wiki-font-roboto-flex)')
    expect(rootTokens['--wiki-font-display']).toBe('var(--wiki-font-newsreader)')
    expect(newsreaderTokens['--wiki-font-display']).toBe('var(--wiki-font-selected)')
    const robotoTokens = declarations(extractBlocks(base, "html[data-wiki-font='roboto-flex']")[0])
    expect(robotoTokens['--wiki-font-display']).toBe('var(--wiki-font-selected)')
    expect(read('client/themes/default/components/page.vue')).toMatch(/\.page-title \{\s*font-family: var\(--wiki-font-display\)/)
    expect(read('client/components/agents/inline-agent-chat.vue')).toMatch(/\.inline-agent__welcome h2 \{[^}]*font-family: var\(--wiki-font-display\)/)

    for (const token of ['--wiki-font-body', '--wiki-font-heading', '--wiki-font-reader']) {
      expect(rootTokens[token]).toBe('var(--wiki-font-selected)')
    }
    expect(rootTokens['--v-font-body']).toBe('var(--wiki-font-body)')
    expect(rootTokens['--v-font-heading']).toBe('var(--wiki-font-heading)')
    expect(newsreaderTokens['--wiki-font-selected']).toBe('var(--wiki-font-newsreader)')
    expect(rootTokens['--wiki-font-mono']).toBe("'Roboto Mono', 'SFMono-Regular', 'Cascadia Code', 'Liberation Mono', monospace")
    expect(base).not.toMatch(/font-feature-settings\s*:/)
  })

  test('hydrates the font claim without gutter state or legacy token refreshes', () => {
    expect(wikiStoreSource).toContain("import { normalizeUserFontFamily } from '../../shared/user-presentation.ts'")
    expect(wikiStoreSource).toMatch(/fontFamily:\s*normalizeUserFontFamily\(undefined\)/)
    expect(wikiStoreSource).toMatch(/this\.user\.fontFamily\s*=\s*normalizeUserFontFamily\(payload\.ff\)/)
    expect(wikiStoreSource).not.toMatch(/readingGutter|readingGutterNeedsMigration/)
    expect(wikiStoreSource).not.toMatch(/gutterStyle|gutterCustomCss/)
    expect(wikiStoreSource).not.toMatch(/payload\.rg|isUserReadingGutter|page-gutters/)
    expect(clientApp).not.toMatch(/refreshLegacyReadingGutterToken|readingGutterNeedsMigration/)
    expect(clientApp).not.toContain("import Cookies from 'js-cookie'")
    expect(clientApp).not.toContain('ProfileAppearanceSchema')
    expect(clientApp).not.toContain('updateProfilePreferences')
    expect(clientApp).toMatch(/import\s+\{\s*createApp,\s*watch\s*\}\s+from\s+'vue'/)
    expect(clientApp).toMatch(
      /watch\(\s*\(\)\s*=>\s*wikiStore\.user\.fontFamily,\s*fontFamily\s*=>\s*\{\s*document\.documentElement\.dataset\.wikiFont\s*=\s*fontFamily\s*\},\s*\{\s*immediate:\s*true\s*\}\s*\)/s
    )
  })

  test('declares the exact local variable faces and real Newsreader italics', () => {
    expect(fontFaces).toHaveLength(expectedFaces.length + 1)

    for (const expected of expectedFaces) {
      const face = fontFaces.find(candidate => candidate.src?.includes(`/${expected.file}`))
      expect(face).toBeDefined()
      expect(face['font-family']).toBe(expected.family)
      expect(face['font-style']).toBe(expected.style)
      expect(face['font-weight']).toBe(expected.weight)
      expect(face['font-display']).toBe('swap')
      expect(face['unicode-range']).toBe(expected.range)
      expect(face.src).toBe(`url('../../fonts/default/${expected.file}') format('woff2')`)
      if (expected.stretch) expect(face['font-stretch']).toBe(expected.stretch)
    }

    const mono = fontFaces.find(face => face['font-family'] === "'Roboto Mono'")
    expect(mono).toBeDefined()
    expect(mono).toMatchObject({
      'font-display': 'swap',
      'font-style': 'normal',
      'font-weight': '400',
      src: "url('../../fonts/default/RobotoMono-Regular.woff2') format('woff2')"
    })
  })

  test('serves only the required WOFF2 files with their OFL notices', () => {
    const fontFiles = assetNames.filter(name => /\.(?:woff2?|ttf|otf)$/i.test(name)).sort()
    expect(fontFiles).toEqual(expectedFontFiles)
    expect(expectedLicenses.every(name => assetNames.includes(name))).toBe(true)

    for (const license of expectedLicenses) {
      expect(read(`client/fonts/default/${license}`)).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/i)
    }
  })

  test('cannot load fonts from remote, data, or machine-local sources', () => {
    expect(fontSource).not.toMatch(/https?:|url\(\s*\/\/|url\(\s*['"]?data:|local\s*\(/i)
    expect(fontSource).not.toMatch(/@import\s+url/i)
    expect(fontSource).not.toMatch(/\.woff(?:['")\s,;]|$)/i)

    for (const face of fontFaces) {
      expect(face.src).toMatch(/^url\(['"]\.\.\/\.\.\/fonts\/default\/[\w.-]+\.woff2['"]\) format\(['"]woff2['"]\)$/)
    }
  })

  test('contains no legacy Inter or static Roboto UI references', () => {
    const sources = collectSourceFiles(path.join(root, 'client'))
      .map(file => fs.readFileSync(file, 'utf8'))
      .join('\n')

    expect(assetNames.join('\n')).not.toMatch(/WikiAgentSans|Inter|Roboto-(?:Regular|Medium|Italic|Bold)/i)
    expect(sources).not.toMatch(/WikiAgentSans|\bInter\b|Roboto-(?:Regular|Medium|Italic|Bold)(?:Italic)?\.(?:woff2?|ttf|otf)/i)
    expect(sources).not.toMatch(/font-family\s*:\s*['"]Roboto['"](?:\s*[,;])/i)
  })
})
