import fs from 'node:fs'
import path from 'node:path'
import postcss from 'postcss'

const root = process.cwd()
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')
const normalizeValue = value => value.replace(/\s+/g, ' ').trim()
const declarations = block => Object.fromEntries(
  block.nodes.filter(node => node.type === 'decl').map(node => [node.prop, normalizeValue(node.value)])
)

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
  { file: 'Newsreader-v26-latin-italic.woff2', family: "'Newsreader'", style: 'italic', weight: '200 800', range: LATIN },
  { file: 'NotoSansEgyptianHieroglyphs-v30-egyptian-hieroglyphs.woff2', family: "'Noto Sans Egyptian Hieroglyphs'", style: 'normal', weight: '400', range: 'U+13000-13455, U+13460-143FA' }
]

const expectedLicenses = ['Newsreader-OFL.txt', 'RobotoFlex-OFL.txt', 'RobotoMono-OFL.txt', 'NotoSansEgyptianHieroglyphs-OFL.txt']

describe('self-hosted typography contracts', () => {
  const fontSource = read('client/scss/fonts/default.scss')
  const fontFaces = []
  postcss.parse(fontSource).walkAtRules('font-face', rule => fontFaces.push(declarations(rule)))


  test('declares the required local variable faces and real Newsreader italics', () => {
    for (const expected of expectedFaces) {
      const face = fontFaces.find(candidate =>
        candidate['font-family'] === expected.family &&
        candidate['font-style'] === expected.style &&
        candidate['unicode-range'] === expected.range
      )
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

  test('bundles every declared WOFF2 asset with the required OFL notices', () => {
    for (const face of fontFaces) {
      const reference = face.src.match(/^url\(['"]([^'"]+)['"]\) format\(['"]woff2['"]\)$/)
      expect(reference).not.toBeNull()
      const asset = fs.readFileSync(path.resolve(root, 'client/scss/fonts', reference[1]))
      expect(asset.subarray(0, 4).toString('ascii')).toBe('wOF2')
      expect(asset.length).toBeGreaterThanOrEqual(48)
      expect(asset.readUInt32BE(8)).toBe(asset.length)
    }

    for (const license of expectedLicenses) {
      const notice = read(`client/fonts/default/${license}`)
      expect(notice).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/i)
      const family = { 'Newsreader-OFL.txt': 'Newsreader', 'RobotoFlex-OFL.txt': 'Roboto Flex', 'RobotoMono-OFL.txt': 'Roboto Mono', 'NotoSansEgyptianHieroglyphs-OFL.txt': 'Noto' }[license]
      expect(notice).toMatch(new RegExp(`^Copyright \\d{4} The ${family} Project Authors \\(https?://[^)]+\\)`, 'm'))
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

})
