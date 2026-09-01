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
    expect(template).not.toContain(":href='`#${tocItem.anchor}`'")
    expect(template).toMatch(/\.page-toc-empty\(v-else\)/)
    expect(template).not.toMatch(/page-return-top--docked|:style='upBtnPosition'|location='bottom start'/)
    expect(template).toContain("@navigate='sidebarNavigationStarted'")
    expect(script).toMatch(
      /tocLinkClicked\s*\(event: MouseEvent, anchor: string\)\s*\{[\s\S]*?event\.metaKey[\s\S]*?event\.ctrlKey[\s\S]*?event\.shiftKey[\s\S]*?event\.altKey[\s\S]*?event\.preventDefault\(\)[\s\S]*?this\.scrollToPageAnchor\(anchor\)/
    )
    expect(script).toMatch(/sidebarNavigationStarted\s*\(\)\s*\{\s*if \(this\.\$vuetify\.display\.width < 1280\) this\.navShown = false/)
    expect(style).toMatch(/--page-toc-empty-height:\s*calc\(var\(--wiki-grid-size\) \* 2\)/)
    expect(style).toMatch(/\.page-col-sd--with-toc\s*\{[^}]*margin-block-start:\s*calc\(var\(--page-toc-desktop-lift\) \* -1\)/s)
    expect(style).toMatch(/--page-shortcut-target:\s*calc\(var\(--wiki-control-height\) - var\(--wiki-space-1\)\)/)
    expect(style).toMatch(
      /\.page-return-top\s*\{[^}]*right:\s*calc\(env\(safe-area-inset-right\) \+ var\(--wiki-space-5\)\) !important;[^}]*left:\s*auto !important;/s
    )
    expect(style).toMatch(
      /\.page-edit-fab\s*\{[^}]*inset-inline-end:\s*calc\(var\(--wiki-space-5\) \+ var\(--wiki-control-height\) \+ var\(--wiki-space-3\)\);/s
    )
  })
})
