const fs = require('fs')
const path = require('path')

function readScript (relativePath) {
  const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

describe('store module registration root global guard', () => {
  const cases = [
    {
      label: 'admin shell',
      path: 'client/components/admin.vue',
      storeImport: /import\s+store\s+from\s+['"]\.\.\/store['"]/,
      registerCall: /\bstore\.registerModule\(\s*['"]admin['"]\s*,\s*adminStore\s*\)/
    },
    {
      label: 'editor shell',
      path: 'client/components/editor.vue',
      storeImport: /import\s+store\s+from\s+['"]\.\.\/store['"]/,
      registerCall: /\bstore\.registerModule\(\s*['"]editor['"]\s*,\s*editorStore\s*\)/
    },
    {
      label: 'admin general editor settings',
      path: 'client/components/admin/admin-general.vue',
      storeImport: /import\s+store\s+from\s+['"]\.\.\/\.\.\/store['"]/,
      registerCall: /\bstore\.registerModule\(\s*['"]editor['"]\s*,\s*editorStore\s*\)/
    },
    {
      label: 'admin security editor settings',
      path: 'client/components/admin/admin-security.vue',
      storeImport: /import\s+store\s+from\s+['"]\.\.\/\.\.\/store['"]/,
      registerCall: /\bstore\.registerModule\(\s*['"]editor['"]\s*,\s*editorStore\s*\)/
    }
  ]

  test.each(cases)('$label registers Vuex modules through the store singleton', ({ path: relativePath, storeImport, registerCall }) => {
    const script = readScript(relativePath)

    expect(script).not.toBeNull()
    expect(script).toMatch(storeImport)
    expect(script).toMatch(registerCall)
    expect(script).not.toContain('WIKI.$store')
    expect(script).not.toMatch(/\/\*\s*global\s+WIKI\s*\*\//)
  })
})
