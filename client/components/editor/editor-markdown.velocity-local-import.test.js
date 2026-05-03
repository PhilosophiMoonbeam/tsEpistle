const fs = require('fs')
const path = require('path')

const readScript = (relativePath) => {
  const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  return match ? match[1] : source
}

describe('editor markdown Velocity local import migration guard', () => {
  test('client app no longer registers Velocity on Vue prototype', () => {
    const app = fs.readFileSync(path.join(process.cwd(), 'client/client-app.js'), 'utf8')

    expect(app).not.toContain("import Velocity from 'velocity-animate'")
    expect(app).not.toContain('Vue.prototype.Velocity')
  })

  test('editor-markdown imports Velocity directly and preserves scroll-sync calls', () => {
    const script = readScript('client/components/editor/editor-markdown.vue')

    expect(script).toContain("import Velocity from 'velocity-animate'")
    expect(script).not.toContain('this.Velocity(')
    expect(script).toMatch(/Velocity\s*\(\s*this\.\$refs\.editorPreview\s*,\s*['"]stop['"]\s*,\s*true\s*\)/)
    expect(script).toMatch(/Velocity\s*\(\s*this\.\$refs\.editorPreview\.firstChild\s*,\s*['"]scroll['"]\s*,\s*\{\s*offset:\s*['"]-50['"]\s*,\s*duration:\s*1000\s*,\s*container:\s*this\.\$refs\.editorPreviewContainer\s*\}\s*\)/)
    expect(script).toMatch(/Velocity\s*\(\s*destElm\s*,\s*['"]scroll['"]\s*,\s*\{\s*offset:\s*['"]-100['"]\s*,\s*duration:\s*1000\s*,\s*container:\s*this\.\$refs\.editorPreviewContainer\s*\}\s*\)/)
  })
})
