import fs from 'node:fs'
import path from 'node:path'

describe('social-sharing showNotification facade migration guard', () => {
  const socialSharingPath = path.join(process.cwd(), 'client/components/common/social-sharing.vue')
  const source = fs.readFileSync(socialSharingPath, 'utf8')

  test('uses an explicit non-submit copy button and typed notifications around programmatic ClipboardJS', () => {
    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(source).toContain("import { defineComponent } from 'vue'")
    expect(source).toContain("import ClipboardJS from 'clipboard'")
    expect(source).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(source).toMatch(/export\s+default\s+defineComponent\s*\(\s*\{/)

    expect(source).toMatch(/v-list-item\s*\(\s*tag=['"]button['"]\s*,\s*type=['"]button['"]\s*,\s*role=['"]button['"]\s*,\s*@click=['"]copyUrl['"]\s*\)/)

    const copyUrl = source.slice(source.indexOf('copyUrl (): void'), source.indexOf('openSocialPop (url: string)'))
    expect(copyUrl).toContain('ClipboardJS.copy(this.url)')
    expect(copyUrl).toMatch(
      /wikiStore\.showNotification\s*\(\s*\{\s*style:\s*['"]success['"]\s*,\s*message:\s*`URL copied successfully`\s*,\s*icon:\s*['"]content-copy['"]\s*\}\s*\)/
    )
    expect(copyUrl).toMatch(
      /catch\s*\{\s*wikiStore\.showNotification\s*\(\s*\{\s*style:\s*['"]red['"]\s*,\s*message:\s*`Failed to copy to clipboard`\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)/
    )

    expect(source).not.toMatch(/this\.\$store\.commit\(\s*['"]showNotification['"]\s*,/)
    expect(source).not.toMatch(/new\s+ClipboardJS\s*\(/)
  })
})
