import fs from 'node:fs'
import path from 'node:path'
import { resolveUserReadingGutter } from '../../../../shared/user-presentation.ts'

const read = relativePath => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
const extractBlock = (source, tag) => {
  const match = source.match(new RegExp(`<${tag}(?:\\s+[^>]*)?>\\s*([\\s\\S]*?)\\s*</${tag}>`))
  return match && match[1]
}
const extractScript = source => extractBlock(source, 'script')
const normalizeCssSelector = selector =>
  selector
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const findCssBlockEnd = (source, open) => {
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

const extractCssRules = source => {
  const rules = []

  const visit = (start, end) => {
    let statementStart = start
    let cursor = start
    let quote = null

    while (cursor < end) {
      const character = source[cursor]
      if (quote) {
        if (character === '\\') cursor++
        else if (character === quote) quote = null
        cursor++
        continue
      }
      if (character === '"' || character === "'") {
        quote = character
        cursor++
        continue
      }
      if (character === '/' && source[cursor + 1] === '*') {
        const commentEnd = source.indexOf('*/', cursor + 2)
        if (commentEnd === -1 || commentEnd >= end) break
        cursor = commentEnd + 2
        continue
      }
      if (character === ';') {
        statementStart = cursor + 1
        cursor++
        continue
      }
      if (character !== '{') {
        cursor++
        continue
      }

      const close = findCssBlockEnd(source, cursor)
      if (close === -1 || close > end) break
      const selector = normalizeCssSelector(source.slice(statementStart, cursor))
      if (selector) rules.push({ selector, block: source.slice(cursor + 1, close) })
      visit(cursor + 1, close)
      cursor = close + 1
      statementStart = cursor
    }
  }

  visit(0, source.length)
  return rules
}

const selectorMatches = (actual, expected) => {
  if (typeof expected === 'string') return actual === normalizeCssSelector(expected)
  const flags = expected.flags.replace(/[gmy]/g, '')
  return new RegExp(`^(?:${expected.source})$`, flags).test(actual)
}

const extractCssRule = (source, selector) => {
  if (source == null) return null
  return extractCssRules(source).find(rule => selectorMatches(rule.selector, selector))?.block ?? null
}

const extractDeclarations = block => {
  const result = {}
  let statementStart = 0
  let cursor = 0
  let quote = null

  while (cursor < block.length) {
    const character = block[cursor]
    if (quote) {
      if (character === '\\') cursor++
      else if (character === quote) quote = null
      cursor++
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      cursor++
      continue
    }
    if (character === '/' && block[cursor + 1] === '*') {
      const commentEnd = block.indexOf('*/', cursor + 2)
      if (commentEnd === -1) break
      cursor = commentEnd + 2
      continue
    }
    if (character === '{') {
      const close = findCssBlockEnd(block, cursor)
      if (close === -1) break
      cursor = close + 1
      statementStart = cursor
      continue
    }
    if (character !== ';') {
      cursor++
      continue
    }

    const statement = block.slice(statementStart, cursor + 1)
    const declaration = statement.match(/^\s*([\w-]+)\s*:\s*([\s\S]*?)\s*;\s*$/)
    if (declaration) result[declaration[1]] = declaration[2].replace(/\s+/g, ' ').trim()
    cursor++
    statementStart = cursor
  }

  return result
}

const expectDeclarations = (block, expected) => {
  expect(block).not.toBeNull()
  const actual = extractDeclarations(block)
  for (const [property, value] of Object.entries(expected)) {
    expect(actual[property]).toBeDefined()
    expect(actual[property]).toMatch(new RegExp(`^(?:${value})$`))
  }
}

describe('default page focused contracts', () => {
  const script = extractScript(read('client/themes/default/components/page.vue'))
  const template = extractBlock(read('client/themes/default/components/page.vue'), 'template')
  const style = extractBlock(read('client/themes/default/components/page.vue'), 'style')
  const gutterColumn = read('client/components/common/page-gutter-column.vue')
  const adminTheme = read('client/components/admin/admin-theme.vue')

  test('default page notifies page-ready through imported boot instead of window global', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/import\s+boot\s+from\s+['"]\.\.\/\.\.\/\.\.\/modules\/boot\.ts['"]/)
    expect(script).toMatch(/\bboot\.notify\s*\(\s*['"]page-ready['"]\s*\)/)
    expect(script).not.toMatch(/window\.boot\.notify\s*\(/)
  })

  test('keeps authenticated gutters concrete while guests follow reactive site settings', () => {
    expect(script).toMatch(
      /resolveUserReadingGutter\(\s*wikiStore\.user\.authenticated \? wikiStore\.user\.readingGutter : undefined,\s*wikiStore\.site\.gutterStyle,\s*wikiStore\.site\.gutterCustomCss\s*\)/
    )
    expect(script).not.toMatch(/gutterStyle:\s*siteConfig\.gutterStyle|gutterCustomCss:\s*siteConfig\.gutterCustomCss/)
    expect(script).toMatch(
      /gutterOrnamentStyle\s*\(\): string \| undefined\s*\{[\s\S]*?this\.gutterStyle === 'custom'[\s\S]*?normalizePageGutterCustomCss\(wikiStore\.site\.gutterCustomCss\)[\s\S]*?: undefined/
    )

    const presentation = {
      user: { authenticated: true, readingGutter: 'laurel' },
      site: { gutterStyle: 'laurel', gutterCustomCss: '' }
    }
    const effectiveGutter = () =>
      resolveUserReadingGutter(
        presentation.user.authenticated ? presentation.user.readingGutter : undefined,
        presentation.site.gutterStyle,
        presentation.site.gutterCustomCss
      )

    expect(effectiveGutter()).toBe('laurel')
    presentation.site.gutterStyle = 'aurora'
    expect(effectiveGutter()).toBe('laurel')
    presentation.user.readingGutter = 'orbits'
    expect(effectiveGutter()).toBe('orbits')
    presentation.user.authenticated = false
    expect(effectiveGutter()).toBe('aurora')
    presentation.user.authenticated = true
    presentation.user.readingGutter = 'custom'
    presentation.site.gutterStyle = 'columns'
    presentation.site.gutterCustomCss = '.page { display: none; }'
    expect(effectiveGutter()).toBe('columns')

    expect(template).not.toContain('page-gutter-ornament--start')
    expect(template).toContain('page-gutter-ornament--right')
    expect(adminTheme).not.toContain('gutter-style-option__art--start')
    expect(adminTheme).toContain('gutter-style-option__art--right')
    expect(adminTheme).toContain("{ value: 'custom', title: 'Custom study'")
    expect(adminTheme).toMatch(
      /siteConfig\.gutterStyle = payload\.gutterStyle[\s\S]*?siteConfig\.gutterCustomCss = payload\.gutterCustomCss[\s\S]*?wikiStore\.site\.gutterStyle = payload\.gutterStyle[\s\S]*?wikiStore\.site\.gutterCustomCss = payload\.gutterCustomCss/
    )
  })

  test('keeps reader geometry compact, useful, and clear of mobile navigation', () => {
    expect(template).not.toBeNull()
    expect(style).not.toBeNull()
    const pageRoot = extractCssRule(style, '.wiki-page')
    const pageHeader = extractCssRule(style, '.page-header-section')
    const pageBody = extractCssRule(style, '.page-body')
    const pageSidebar = extractCssRule(style, '.page-col-sd')
    const desktopRules = extractCssRules(style).filter(({ selector }) => selector === '@media (min-width: 1280px)')
    const desktopHeader = desktopRules.find(({ block }) => block.includes('.page-header-section'))?.block ?? null
    const desktopBody = desktopRules.find(({ block }) => block.includes('.page-col-sd--with-toc'))?.block ?? null
    const readerSurface = extractCssRule(style, '.page-col-content > .contents')
    const readerCopy = extractCssRule(readerSurface, '> div:not(.page-gutter-ornament)')
    const readerGutter = extractCssRule(style, '.page-gutter-ornament')
    const thirdLevelTocTitle = extractCssRule(style, '.page-toc-item-title--third-level')

    expectDeclarations(pageRoot, {
      '--page-reader-shell-max': '132rem',
      '--page-metadata-rail-width': 'clamp\\(18rem,\\s*22\\.5vw,\\s*21rem\\)',
      '--page-reader-column-gap': 'var\\(--wiki-space-6\\)',
      '--page-reader-copy-max': '101\\.2ch'
    })
    expectDeclarations(pageHeader, {
      width: 'min\\(100%,\\s*var\\(--page-reader-shell-max\\)\\)'
    })
    expectDeclarations(pageBody, {
      width: 'min\\(100%,\\s*var\\(--page-reader-shell-max\\)\\)'
    })
    expect(template).toContain(':class=\'{ "font-weight-bold": tocItem.depth === 0, "page-toc-item-title--third-level": tocItem.depth === 2 }\'')
    expect(template).not.toContain('font-italic')
    expect(template).not.toContain('"font-weight-medium": tocItem.depth === 0')
    expectDeclarations(thirdLevelTocTitle, {
      'font-size': 'calc\\(\\.8125rem - 1pt\\)'
    })
    expect(template).toMatch(/v-card\.page-toc-card\.mb-4\(v-if='tocPosition !== `off`', tag='nav', :aria-label=/)
    expect(template).toContain(":href='tocItem.anchor'")
    expect(template).toContain("@click='tocLinkClicked($event, tocItem.anchor)'")
    expectDeclarations(readerCopy, {
      width: 'min\\(100%,\\s*var\\(--page-reader-copy-max\\)\\)'
    })
    expectDeclarations(readerSurface, {
      '--page-reader-surface-padding': 'clamp\\(var\\(--wiki-space-6\\),\\s*3vw,\\s*var\\(--wiki-space-12\\)\\)',
      padding: 'var\\(--page-reader-surface-padding\\)'
    })
    expectDeclarations(readerCopy, {
      margin: '0 auto 0 0'
    })
    expect(template).not.toContain('page-gutter-ornament--start')
    expect(template).toContain('page-gutter-ornament--right')
    expect(adminTheme).not.toContain('gutter-style-option__art--start')
    expect(adminTheme).toContain('gutter-style-option__art--right')
    expect(adminTheme).toContain('open space to the right of article text')
    const shortcutCardIndex = template.indexOf('v-card.page-shortcuts-card.mb-4')
    const tocCardIndex = template.indexOf('v-card.page-toc-card.mb-4')
    expect(shortcutCardIndex).toBeGreaterThan(-1)
    expect(tocCardIndex).toBeGreaterThan(-1)
    expect(shortcutCardIndex).toBeLessThan(tocCardIndex)
    expectDeclarations(pageSidebar, {
      position: 'sticky',
      'max-height': 'calc\\(100dvh - var\\(--v-layout-top,\\s*var\\(--wiki-grid-size\\)\\) - var\\(--wiki-space-12\\)\\)',
      'overflow-y': 'auto',
      'overscroll-behavior': 'contain'
    })
    expectDeclarations(readerGutter, {
      width:
        'max\\(\\s*calc\\(var\\(--wiki-grid-size\\) \\* 1\\.125\\),\\s*calc\\(\\s*100% - var\\(--page-reader-copy-max\\) - var\\(--page-reader-surface-padding\\) -\\s*var\\(--wiki-space-4\\) - var\\(--wiki-space-1\\)\\s*\\)\\s*\\)',
      height: 'min\\(\\s*calc\\(100% - var\\(--wiki-space-8\\)\\),\\s*max\\(calc\\(var\\(--wiki-grid-size\\) \\* 7\\),\\s*95%\\)\\s*\\)'
    })
    expect(gutterColumn).toContain("path.wiki-gutter-column__base-neck(d='M61 480 H129 L131 493 H59 Z')")
    expect(gutterColumn).toContain("path.wiki-gutter-column__base-neck(d='M61 480 L59 493 M129 480 L131 493')")
    expect(template).not.toMatch(/:href='`#\$\{tocItem\.anchor\}`'/)
    expect(template).toMatch(/\.page-toc-empty\(v-else\)/)
    expect(template).not.toMatch(/page-return-top--docked|:style='upBtnPosition'|location='bottom start'/)
    expect(template).toContain("@navigate='sidebarNavigationStarted'")
    expect(script).toMatch(
      /tocLinkClicked\s*\(event: MouseEvent, anchor: string\)\s*\{[\s\S]*?event\.metaKey[\s\S]*?event\.ctrlKey[\s\S]*?event\.shiftKey[\s\S]*?event\.altKey[\s\S]*?event\.preventDefault\(\)[\s\S]*?this\.scrollToPageAnchor\(anchor\)/
    )
    expect(script).toMatch(/sidebarNavigationStarted\s*\(\)\s*\{\s*if \(this\.\$vuetify\.display\.width < 1280\) this\.navShown = false/)
    expect(style).toMatch(/--page-toc-empty-height:\s*calc\(var\(--wiki-grid-size\) \* 2\)/)
    const navigationDrawer = template.match(/v-navigation-drawer\(([\s\S]*?)\n {6}\)/)?.[1] ?? ''
    expect(navigationDrawer).not.toBe('')
    expect(navigationDrawer).toContain(":mobile-breakpoint='1280'")
    expect(navigationDrawer).toContain(":width='$vuetify.display.width >= 1280 ? 281.6 : 256'")
    expect(navigationDrawer).toContain("v-model='navShown'")
    expect(navigationDrawer).toContain("@update:model-value='navigationVisibilityChanged'")
    expect(navigationDrawer).not.toMatch(/(?:^|\s):?temporary=/)
    expect(navigationDrawer).not.toMatch(/(?:^|\s):?location=/)
    expect(template).toContain('page-col-sd--with-toc')
    expect(template).toContain('page-col-sd--toc-off')
    expect(template).toContain('page-col-content--with-toc')
    expect(template).toContain('page-col-content--toc-off')
    expectDeclarations(extractCssRule(desktopBody, '.page-col-sd--with-toc'), {
      flex: '0 0 var\\(--page-metadata-rail-width\\)',
      'max-width': 'var\\(--page-metadata-rail-width\\)'
    })
    expectDeclarations(extractCssRule(desktopBody, '.page-col-content--with-toc'), {
      flex: '0 0 calc\\(100% - var\\(--page-metadata-rail-width\\) - var\\(--v-col-gap-x\\)\\)',
      'max-width': 'calc\\(100% - var\\(--page-metadata-rail-width\\) - var\\(--v-col-gap-x\\)\\)'
    })
    expectDeclarations(extractCssRule(style, '.page-col-content:not(.is-page-header)'), {
      'padding-inline': 'var\\(--wiki-space-4\\) 0'
    })
    expectDeclarations(extractCssRule(style, '.page-col-content--toc-right:not(.is-page-header)'), {
      'padding-inline': '0 var\\(--wiki-space-4\\)'
    })
    expect(style).toMatch(/\.page-col-sd--toc-off,\s*\.page-col-content--toc-off\s*\{[^}]*flex:\s*0 0 100%;[^}]*max-width:\s*100%;/s)
    expect(template).toMatch(
      /v-col\.page-col-content\.is-page-header\([\s\S]*?cols='12'[\s\S]*?"has-edit-shortcuts":\s*editShortcutsObj\.editMenuBar\s*&&\s*\(editShortcutsObj\.editMenuBtn\s*\|\|\s*editShortcutsObj\.editMenuExternalBtn\)/
    )
    expect(template).toMatch(
      /\.page-edit-shortcuts\([\s\S]*?v-if='editShortcutsObj\.editMenuBar && \(editShortcutsObj\.editMenuBtn \|\| editShortcutsObj\.editMenuExternalBtn\)'/
    )
    expect(template).not.toContain(":offset-xl='tocPosition === `left` ? 2 : 0'")
    expect(template).not.toContain(":offset-lg='tocPosition === `left` ? 3 : 0'")
    expect(template).not.toMatch(/\b(?:lg|order-lg)=/)
    expect(template).toContain(`\`page-header--toc-\${tocPosition}\``)
    expect(style).toMatch(/\.page-header-headings\s*\{[^}]*width:\s*100%;[^}]*margin-inline:\s*0;[^}]*text-align:\s*start;/)
    expect(style).toMatch(/\.page-title-row\s*\{[^}]*justify-content:\s*flex-start;/s)
    expect(style).toMatch(/\.page-description\s*\{[^}]*margin:\s*var\(--wiki-space-1\) 0 0;/s)
    expect(style).toMatch(
      /@media\s*\(min-width:\s*600px\)\s*\{[\s\S]*?\.is-page-header\.has-edit-shortcuts\s*\{[^}]*--page-header-action-reserve:\s*clamp\([\s\S]*?grid-template-columns:[\s\S]*?minmax\(0, 1fr\)[\s\S]*?minmax\(0, var\(--page-header-action-reserve\)\);[\s\S]*?\.has-edit-shortcuts \.page-header-headings\s*\{[^}]*grid-column:\s*1;[\s\S]*?\.has-edit-shortcuts \.page-edit-shortcuts\s*\{[^}]*width:\s*min\(100%, var\(--page-header-action-reserve\)\);[^}]*max-width:\s*var\(--page-header-action-reserve\);[^}]*grid-column:\s*2;[^}]*justify-self:\s*end;[\s\S]*?\.v-btn\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*0 1 auto;[^}]*overflow:\s*hidden;[\s\S]*?\.v-btn \.text-none\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s
    )
    expectDeclarations(extractCssRule(style, '.page-edit-shortcuts'), {
      'align-self': 'end',
      overflow: 'visible'
    })
    expect(style).toMatch(
      /\.page-edit-shortcuts\s*\{[^}]*justify-content:\s*flex-end;[\s\S]*?\.v-btn\s*\{[^}]*min-height:\s*calc\(var\(--wiki-control-height\) \* \.85\);/
    )
    const desktopHeaderSection = extractCssRule(desktopHeader, '.page-header-section')
    expectDeclarations(extractCssRule(desktopHeaderSection, '> .is-page-header'), {
      'min-height': 'inherit',
      gap: 'var\\(--page-reader-column-gap\\)',
      'align-content': 'center'
    })
    const desktopLeftHeader = extractCssRule(desktopHeaderSection, '> .page-header--toc-left')
    expectDeclarations(desktopLeftHeader, {
      'grid-template-columns': 'var\\(--page-metadata-rail-width\\) minmax\\(0,\\s*1fr\\)'
    })
    expectDeclarations(extractCssRule(desktopLeftHeader, '.page-header-headings'), {
      'grid-column': '2',
      'padding-inline-start': 'var\\(--wiki-space-4\\)'
    })
    const desktopLeftHeaderWithActions = extractCssRule(desktopHeaderSection, '> .page-header--toc-left.has-edit-shortcuts')
    expectDeclarations(desktopLeftHeaderWithActions, {
      'grid-template-columns': 'var\\(--page-metadata-rail-width\\) minmax\\(0,\\s*1fr\\) minmax\\(0,\\s*var\\(--page-header-action-reserve\\)\\)'
    })
    expectDeclarations(extractCssRule(desktopLeftHeaderWithActions, '.page-edit-shortcuts'), {
      'grid-column': '3'
    })
    expect(style).toMatch(/--page-toc-desktop-lift:\s*calc\(var\(--page-toc-empty-height\) \+ var\(--wiki-space-6\)\)/)
    expect(style).toMatch(/@media\s*\(max-width:\s*1279px\)\s*\{[\s\S]*?\.page-col-sd\s*\{[\s\S]*?margin-block-start:\s*0;/s)
    expect(style).toMatch(/\.v-main \.contents[\s\S]*?h1\s*\{[^}]*color:\s*var\(--wiki-accent-ink\);/s)
    expect(style).not.toContain(':has(')
    expect(style).toMatch(/\.page-col-sd--with-toc\s*\{[^}]*margin-block-start:\s*calc\(var\(--page-toc-desktop-lift\) \* -1\)/s)
  })

  test('keeps editorial type scoped, responsive, printable, and technically legible', () => {
    const pageRoot = extractCssRule(style, '.wiki-page')
    const heroSystem = extractCssRule(style, '.page-title, .page-description')
    const title = extractCssRule(style, '.page-title')
    const description = extractCssRule(style, '.page-description')
    const contents = extractCssRule(style, '.wiki-page .v-main .contents')

    expectDeclarations(pageRoot, {
      'font-family': 'var\\(--wiki-font-body\\)'
    })
    expectDeclarations(heroSystem, {
      'font-family': 'var\\(--wiki-font-body\\)',
      'font-optical-sizing': 'auto'
    })
    expect(heroSystem).not.toMatch(/font-synthesis|wiki-font-reader/)
    expectDeclarations(title, {
      'font-size': 'clamp\\(2\\.125rem,\\s*1\\.6rem \\+ 1\\.8vw,\\s*3\\.25rem\\)',
      'font-weight': '700',
      'line-height': '1\\.02'
    })
    expectDeclarations(description, {
      'font-size': '1\\.0625rem',
      'line-height': '1\\.5'
    })
    expectDeclarations(contents, {
      'font-family': 'var\\(--wiki-font-reader\\)',
      'font-size': '1\\.0625rem',
      'line-height': '1\\.68',
      'font-optical-sizing': 'auto',
      'font-synthesis': 'none'
    })

    const headingScale = [
      ['h1', '2\\.375rem', '700', '1\\.1'],
      ['h2', '1\\.8125rem', '650', '1\\.14'],
      ['h3', '1\\.375rem', '650', '1\\.2'],
      ['h4', '1\\.125rem', '600', '1\\.25'],
      ['h5', '1\\.0625rem', '600', '1\\.3'],
      ['h6', '1rem', '650', '1\\.35']
    ]
    for (const [selector, fontSize, fontWeight, lineHeight] of headingScale) {
      expectDeclarations(extractCssRule(contents, selector), {
        'font-size': fontSize,
        'font-weight': fontWeight,
        'line-height': lineHeight
      })
    }

    expectDeclarations(extractCssRule(contents, ':where(em, i, cite)'), {
      'font-family': 'inherit',
      'font-style': 'italic'
    })
    expectDeclarations(extractCssRule(contents, 'strong, b'), {
      'font-weight': '650'
    })
    expectDeclarations(extractCssRule(contents, /:where\(\s*button,[\s\S]*?\.content-extension-media__fallback\s*\)/), {
      'font-family': 'var\\(--wiki-font-body\\)'
    })
    expectDeclarations(extractCssRule(contents, ':where(code, kbd, samp, pre), .content-extension-qr__value'), {
      'font-family': 'var\\(--wiki-font-mono\\)'
    })
    expectDeclarations(extractCssRule(contents, 'td.content'), {
      'font-family': 'var\\(--wiki-font-reader\\)'
    })
    const iconFamilyRules = extractCssRules(contents).filter(({ selector, block }) => {
      const targetsIconFont = /(?:^|[,(]\s*)\.(?:v-icon|icon)(?=\s*[,)]|$)/.test(selector)
      return targetsIconFont && Object.hasOwn(extractDeclarations(block), 'font-family')
    })
    expect(iconFamilyRules).toEqual([])

    const mobile = extractCssRule(style, '@media (max-width: 599px)')
    const mobileHeader = extractCssRule(mobile, '.page-header-section')
    const mobileContents = extractCssRule(mobile, '.wiki-page .v-main .contents')
    expectDeclarations(extractCssRule(mobileHeader, '.page-title'), {
      'font-size': 'clamp\\(1\\.875rem,\\s*1\\.55rem \\+ 2vw,\\s*2\\.25rem\\)',
      'line-height': '1\\.05'
    })
    expectDeclarations(extractCssRule(mobileHeader, '.page-description'), {
      'font-size': '1rem',
      'line-height': '1\\.5'
    })
    expectDeclarations(mobileContents, {
      'font-size': '1rem',
      'line-height': '1\\.65'
    })
    expectDeclarations(extractCssRule(mobileContents, 'h1'), { 'font-size': '1\\.75rem' })
    expectDeclarations(extractCssRule(mobileContents, 'h2'), { 'font-size': '1\\.5rem' })
    expectDeclarations(extractCssRule(mobileContents, 'h3'), { 'font-size': '1\\.25rem' })

    const print = extractCssRule(style, '@media print')
    const printHiddenRail = extractCssRules(print).find(({ selector }) => selector.split(',').some(part => part.trim() === '.page-col-sd'))?.block ?? null
    expectDeclarations(printHiddenRail, {
      display: 'none !important'
    })
    expectDeclarations(extractCssRule(print, '.page-body, .page-col-content > .contents'), {
      width: '100%',
      padding: '0 !important'
    })
    expectDeclarations(extractCssRule(print, '.page-col-content'), {
      'max-width': '100% !important',
      'flex-basis': '100% !important'
    })
    const printContents = extractCssRule(print, '.wiki-page .v-main .contents')
    expectDeclarations(printContents, {
      'font-family': 'var\\(--wiki-font-reader\\)',
      'font-size': '11pt',
      'line-height': '1\\.5'
    })
    expectDeclarations(extractCssRule(print, '.page-header-section .page-title'), {
      'font-size': '28pt',
      'line-height': '1\\.05'
    })
    expectDeclarations(extractCssRule(print, '.page-header-section .page-description'), {
      'font-size': '12pt',
      'line-height': '1\\.4'
    })

    expect(template).toMatch(/\.page-title-row[\s\S]*?h1\.page-title[\s\S]*?\.page-visibility[\s\S]*?\.page-description[\s\S]*?\.page-edit-shortcuts/)
    expect(style).not.toMatch(
      /(?:page-visibility|page-edit-shortcuts|button|input|select|textarea|table|code|pre)[^{]*\{[^}]*font-family:\s*var\(--wiki-font-reader\)/s
    )
  })
})
