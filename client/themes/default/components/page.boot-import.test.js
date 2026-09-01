import fs from 'node:fs'
import path from 'node:path'

const read = relativePath => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
const extractBlock = (source, tag) => {
  const match = source.match(new RegExp(`<${tag}(?:\\s+[^>]*)?>\\s*([\\s\\S]*?)\\s*</${tag}>`))
  return match && match[1]
}
const extractScript = source => extractBlock(source, 'script')

describe('default page focused contracts', () => {
  const script = extractScript(read('client/themes/default/components/page.vue'))
  const template = extractBlock(read('client/themes/default/components/page.vue'), 'template')
  const style = extractBlock(read('client/themes/default/components/page.vue'), 'style')

  test('default page notifies page-ready through imported boot instead of window global', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/import\s+boot\s+from\s+['"]\.\.\/\.\.\/\.\.\/modules\/boot\.ts['"]/)
    expect(script).toMatch(/\bboot\.notify\s*\(\s*['"]page-ready['"]\s*\)/)
    expect(script).not.toMatch(/window\.boot\.notify\s*\(/)
  })

  test('keeps reader geometry compact, useful, and clear of mobile navigation', () => {
    expect(template).not.toBeNull()
    expect(style).not.toBeNull()
    expect(template).toMatch(/v-card\.page-toc-card\.mb-4\(v-if='tocPosition !== `off`', tag='nav', :aria-label=/)
    expect(template).toContain(":href='tocItem.anchor'")
    expect(template).toContain("@click='tocLinkClicked($event, tocItem.anchor)'")
    expect(template).not.toMatch(/:href='`#\$\{tocItem\.anchor\}`'/)
    expect(template).toMatch(/\.page-toc-empty\(v-else\)/)
    expect(template).not.toMatch(/page-return-top--docked|:style='upBtnPosition'|location='bottom start'/)
    expect(template).toContain("@navigate='sidebarNavigationStarted'")
    expect(script).toMatch(
      /tocLinkClicked\s*\(event: MouseEvent, anchor: string\)\s*\{[\s\S]*?event\.metaKey[\s\S]*?event\.ctrlKey[\s\S]*?event\.shiftKey[\s\S]*?event\.altKey[\s\S]*?event\.preventDefault\(\)[\s\S]*?this\.scrollToPageAnchor\(anchor\)/
    )
    expect(script).toMatch(/sidebarNavigationStarted\s*\(\)\s*\{\s*if \(this\.\$vuetify\.display\.width < 1280\) this\.navShown = false/)
    expect(style).toMatch(/--page-toc-empty-height:\s*calc\(var\(--wiki-grid-size\) \* 2\)/)
    expect(template).toMatch(
      /v-navigation-drawer\([\s\S]*?:width='\$vuetify\.display\.width >= 1280 \? 281\.6 : 256'[\s\S]*?:temporary='\$vuetify\.display\.width < 1280'/
    )
    expect(template).toContain('page-col-sd--with-toc')
    expect(template).toContain('page-col-sd--toc-off')
    expect(template).toContain('page-col-content--with-toc')
    expect(template).toContain('page-col-content--toc-off')
    expect(style).toMatch(
      /\.page-col-sd--with-toc\s*\{[^}]*flex:\s*0 0 calc\(3\.3 \* \(100% \+ var\(--v-col-gap-x\)\) \/ 12 - var\(--v-col-gap-x\)\);[^}]*max-width:\s*calc\(3\.3 \* \(100% \+ var\(--v-col-gap-x\)\) \/ 12 - var\(--v-col-gap-x\)\);/s
    )
    expect(style).toMatch(
      /\.page-col-content--with-toc\s*\{[^}]*flex:\s*0 0 calc\(8\.7 \* \(100% \+ var\(--v-col-gap-x\)\) \/ 12 - var\(--v-col-gap-x\)\);[^}]*max-width:\s*calc\(8\.7 \* \(100% \+ var\(--v-col-gap-x\)\) \/ 12 - var\(--v-col-gap-x\)\);/s
    )
    expect(style).toMatch(
      /\.page-col-sd--with-toc\s*\{[^}]*flex-basis:\s*calc\(2\.2 \* \(100% \+ var\(--v-col-gap-x\)\) \/ 12 - var\(--v-col-gap-x\)\);[^}]*max-width:\s*calc\(2\.2 \* \(100% \+ var\(--v-col-gap-x\)\) \/ 12 - var\(--v-col-gap-x\)\);/s
    )
    expect(style).toMatch(
      /\.page-col-content--with-toc\s*\{[^}]*flex-basis:\s*calc\(9\.8 \* \(100% \+ var\(--v-col-gap-x\)\) \/ 12 - var\(--v-col-gap-x\)\);[^}]*max-width:\s*calc\(9\.8 \* \(100% \+ var\(--v-col-gap-x\)\) \/ 12 - var\(--v-col-gap-x\)\);/s
    )
    expect(style).toMatch(/\.page-col-sd--toc-off,\s*\.page-col-content--toc-off\s*\{[^}]*flex:\s*0 0 100%;[^}]*max-width:\s*100%;/s)
    expect(template).toMatch(
      /v-col\.page-col-content\.is-page-header\([\s\S]*?cols='12'[\s\S]*?"has-edit-shortcuts":\s*editShortcutsObj\.editMenuBar\s*&&\s*\(editShortcutsObj\.editMenuBtn\s*\|\|\s*editShortcutsObj\.editMenuExternalBtn\)/
    )
    expect(template).toMatch(
      /\.page-edit-shortcuts\([\s\S]*?v-if='editShortcutsObj\.editMenuBar && \(editShortcutsObj\.editMenuBtn \|\| editShortcutsObj\.editMenuExternalBtn\)'/
    )
    expect(template).not.toContain(":offset-xl='tocPosition === `left` ? 2 : 0'")
    expect(template).not.toContain(":offset-lg='tocPosition === `left` ? 3 : 0'")
    expect(template).toContain('`page-header--toc-${tocPosition}`')
    expect(style).toMatch(/\.page-header-headings\s*\{[^}]*width:\s*100%;[^}]*margin-inline:\s*0;[^}]*text-align:\s*start;/)
    expect(style).toMatch(/\.page-title-row\s*\{[^}]*justify-content:\s*flex-start;/s)
    expect(style).toMatch(/\.page-description\s*\{[^}]*margin:\s*var\(--wiki-space-1\) 0 0;/s)
    expect(style).toMatch(
      /@media\s*\(min-width:\s*600px\)\s*\{[\s\S]*?\.is-page-header\.has-edit-shortcuts\s*\{[^}]*--page-header-action-reserve:\s*clamp\([\s\S]*?grid-template-columns:[\s\S]*?minmax\(0, 1fr\)[\s\S]*?minmax\(0, var\(--page-header-action-reserve\)\);[\s\S]*?\.has-edit-shortcuts \.page-header-headings\s*\{[^}]*grid-column:\s*1;[\s\S]*?\.has-edit-shortcuts \.page-edit-shortcuts\s*\{[^}]*width:\s*min\(100%, var\(--page-header-action-reserve\)\);[^}]*max-width:\s*var\(--page-header-action-reserve\);[^}]*grid-column:\s*2;[^}]*justify-self:\s*end;[^}]*overflow:\s*hidden;[\s\S]*?\.v-btn\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*0 1 auto;[^}]*overflow:\s*hidden;[\s\S]*?\.v-btn \.text-none\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s
    )
    expect(style).toMatch(/\.page-edit-shortcuts\s*\{[^}]*justify-content:\s*flex-end;[\s\S]*?\.v-btn\s*\{[^}]*min-height:\s*calc\(var\(--wiki-control-height\) \* \.85\);/)
    expect(style).toMatch(
      /@media\s*\(min-width:\s*1280px\)\s*\{[\s\S]*?--page-header-toc-column:\s*calc\(3\.3 \* \(100% \+ var\(--v-col-gap-x\)\) \/ 12 - var\(--v-col-gap-x\)\);[\s\S]*?\.is-page-header\s*\{[^}]*min-height:\s*inherit;[^}]*gap:\s*var\(--v-col-gap-x\);[^}]*align-content:\s*center;[\s\S]*?\.page-header--toc-left\s*\{[\s\S]*?var\(--page-header-toc-column\)[\s\S]*?minmax\(0, 1fr\);[\s\S]*?\.page-header-headings\s*\{[^}]*grid-column:\s*2;[\s\S]*?\.page-header--toc-left\.has-edit-shortcuts\s*\{[\s\S]*?\.page-edit-shortcuts\s*\{[^}]*grid-column:\s*3;/s
    )
    expect(style).toMatch(
      /@media\s*\(min-width:\s*1920px\)\s*\{[\s\S]*?--page-header-toc-column:\s*calc\(2\.2 \* \(100% \+ var\(--v-col-gap-x\)\) \/ 12 - var\(--v-col-gap-x\)\);/
    )
    expect(style).toMatch(/--page-toc-desktop-lift:\s*calc\(var\(--page-toc-empty-height\) \/ 2 \+ var\(--wiki-space-12\)\)/)
    expect(style).toMatch(/@media\s*\(max-width:\s*1279px\)\s*\{[\s\S]*?\.page-col-sd\s*\{[\s\S]*?margin-block-start:\s*0;/s)
    expect(style).toMatch(/\.v-main \.contents[\s\S]*?h1\s*\{[^}]*color:\s*var\(--wiki-accent-warm\);/s)
    expect(style).not.toContain(':has(')
    expect(style).toMatch(/\.page-col-sd--with-toc\s*\{[^}]*margin-block-start:\s*calc\(var\(--page-toc-desktop-lift\) \* -1\)/s)
  })
})
