const fs = require('fs')
const path = require('path')

const readScript = (relativePath) => {
  const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  expect(match).not.toBeNull()
  return match[1]
}

describe('editor conflict showNotification facade migration guard', () => {
  test('ckeditor conflict fetch failure notification uses root-ui-store facade and preserves conflict behavior', () => {
    const script = readScript('client/components/editor/ckeditor/conflict.vue')

    expect(script).toMatch(/import\s+\{[^}]*\bshowNotification\b[^}]*\}\s+from\s+['"]\.\.\/\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toMatch(/async\s+mounted\s*\(\s*\)\s*\{[\s\S]*this\.\$apollo\.query\s*\(\s*\{[\s\S]*conflictLatest\s*\(\s*id:\s*\$id\s*\)\s*\{[\s\S]*authorName[\s\S]*locale[\s\S]*path[\s\S]*content[\s\S]*updatedAt[\s\S]*\}/)
    expect(script).toMatch(/fetchPolicy:\s*['"]network-only['"]/)
    expect(script).toMatch(/variables:\s*\{\s*id:\s*this\.\$store\.get\s*\(\s*['"]page\/id['"]\s*\)\s*\}/)
    expect(script).toMatch(/resp\s*=\s*_\.get\s*\(\s*resp\s*,\s*['"]data\.pages\.conflictLatest['"]\s*,\s*false\s*\)/)
    expect(script).toMatch(/if\s*\(\s*!resp\s*\)\s*\{\s*return\s+showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]Failed to fetch latest version\.['"]\s*,\s*style:\s*['"]warning['"]\s*,\s*icon:\s*['"]warning['"]\s*\}\s*\)/)
    expect(script).toMatch(/this\.latest\s*=\s*resp/)
    expect(script).not.toMatch(/this\.\$store\.commit\s*\(\s*['"]showNotification['"]\s*,/)

    expect(script).toMatch(/useLocal\s*\(\s*\)\s*\{[\s\S]*this\.\$store\.set\s*\(\s*['"]editor\/checkoutDateActive['"]\s*,\s*this\.latest\.updatedAt\s*\)[\s\S]*this\.\$root\.\$emit\s*\(\s*['"]resetEditorConflict['"]\s*\)[\s\S]*this\.close\s*\(\s*\)/)
    expect(script).toMatch(/useRemote\s*\(\s*\)\s*\{[\s\S]*this\.\$store\.set\s*\(\s*['"]editor\/checkoutDateActive['"]\s*,\s*this\.latest\.updatedAt\s*\)[\s\S]*this\.\$store\.set\s*\(\s*['"]editor\/content['"]\s*,\s*this\.latest\.content\s*\)[\s\S]*this\.\$root\.\$emit\s*\(\s*['"]overwriteEditorContent['"]\s*\)[\s\S]*this\.\$root\.\$emit\s*\(\s*['"]resetEditorConflict['"]\s*\)[\s\S]*this\.close\s*\(\s*\)/)
  })

  test('editor modal conflict fetch failure notification uses root-ui-store facade and preserves merge behavior', () => {
    const script = readScript('client/components/editor/editor-modal-conflict.vue')

    expect(script).toMatch(/import\s+\{[^}]*\bshowNotification\b[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toMatch(/let\s+textMode\s*=\s*['"]text\/html['"]/)
    expect(script).toMatch(/case\s+['"]markdown['"]:\s*textMode\s*=\s*['"]text\/markdown['"]/)
    expect(script).toMatch(/async\s+mounted\s*\(\s*\)\s*\{[\s\S]*this\.\$apollo\.query\s*\(\s*\{[\s\S]*conflictLatest\s*\(\s*id:\s*\$id\s*\)\s*\{[\s\S]*id[\s\S]*authorId[\s\S]*authorName[\s\S]*content[\s\S]*createdAt[\s\S]*description[\s\S]*isPublished[\s\S]*locale[\s\S]*path[\s\S]*tags[\s\S]*title[\s\S]*updatedAt[\s\S]*\}/)
    expect(script).toMatch(/fetchPolicy:\s*['"]network-only['"]/)
    expect(script).toMatch(/variables:\s*\{\s*id:\s*this\.\$store\.get\s*\(\s*['"]page\/id['"]\s*\)\s*\}/)
    expect(script).toMatch(/resp\s*=\s*_\.get\s*\(\s*resp\s*,\s*['"]data\.pages\.conflictLatest['"]\s*,\s*false\s*\)/)
    expect(script).toMatch(/if\s*\(\s*!resp\s*\)\s*\{\s*return\s+showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]Failed to fetch latest version\.['"]\s*,\s*style:\s*['"]warning['"]\s*,\s*icon:\s*['"]warning['"]\s*\}\s*\)/)
    expect(script).toMatch(/this\.latest\s*=\s*resp/)
    expect(script).not.toMatch(/this\.\$store\.commit\s*\(\s*['"]showNotification['"]\s*,/)

    expect(script).toMatch(/useLocal\s*\(\s*\)\s*\{[\s\S]*this\.\$store\.set\s*\(\s*['"]editor\/content['"]\s*,\s*this\.cm\.edit\.getValue\s*\(\s*\)\s*\)[\s\S]*this\.overwriteAndClose\s*\(\s*\)/)
    expect(script).toMatch(/useRemote\s*\(\s*\)\s*\{[\s\S]*this\.\$store\.set\s*\(\s*['"]editor\/content['"]\s*,\s*this\.latest\.content\s*\)[\s\S]*this\.overwriteAndClose\s*\(\s*\)/)
    expect(script).toMatch(/overwriteAndClose\s*\(\s*\)\s*\{[\s\S]*this\.checkoutDateActive\s*=\s*this\.latest\.updatedAt[\s\S]*this\.\$root\.\$emit\s*\(\s*['"]overwriteEditorContent['"]\s*\)[\s\S]*this\.\$root\.\$emit\s*\(\s*['"]resetEditorConflict['"]\s*\)[\s\S]*this\.close\s*\(\s*\)/)
    expect(script).toMatch(/CodeMirror\.MergeView\s*\(\s*this\.\$refs\.cm\s*,\s*\{[\s\S]*value:\s*this\.\$store\.get\s*\(\s*['"]editor\/content['"]\s*\)[\s\S]*orig:\s*resp\.content[\s\S]*mode:\s*textMode[\s\S]*lineNumbers:\s*true[\s\S]*lineWrapping:\s*true[\s\S]*highlightDifferences:\s*true[\s\S]*styleActiveLine:\s*true[\s\S]*collapseIdentical:\s*true[\s\S]*direction:\s*siteConfig\.rtl\s*\?\s*['"]rtl['"]\s*:\s*['"]ltr['"][\s\S]*\}\s*\)/)
    expect(script).toMatch(/this\.cm\.rightOriginal\s*\(\s*\)\.setSize\s*\(/)
    expect(script).toMatch(/this\.cm\.editor\s*\(\s*\)\.setSize\s*\(/)
    expect(script).toMatch(/this\.cm\.wrap\.style\.height\s*=/)
  })
})
