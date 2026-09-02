import fs from 'node:fs'
import path from 'node:path'

describe('social-sharing showNotification facade migration guard', () => {
  const socialSharingPath = path.join(process.cwd(), 'client/components/common/social-sharing.vue')
  const source = fs.readFileSync(socialSharingPath, 'utf8')

  test('reports only confirmed clipboard and popup outcomes through typed notifications', () => {
    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(source).toContain("import { defineComponent } from 'vue'")
    expect(source).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(source).toMatch(/export\s+default\s+defineComponent\s*\(\s*\{/)
    expect(source).not.toMatch(/ClipboardJS|from ['"]clipboard['"]|new\s+ClipboardJS\s*\(/)

    expect(source).toMatch(/v-list-item\s*\(\s*tag=['"]button['"]\s*,\s*type=['"]button['"]\s*,\s*role=['"]button['"]\s*,\s*@click=['"]copyUrl['"]\s*\)/)

    const fallback = source.slice(source.indexOf('function copyWithLegacyFallback'), source.indexOf('export default defineComponent'))
    expect(fallback).toMatch(/const activeElement = document\.activeElement[\s\S]*document\.createElement\(['"]textarea['"]\)/)
    expect(fallback).toMatch(/document\.body\.append\(input\)[\s\S]*input\.select\(\)[\s\S]*return document\.execCommand\(['"]copy['"]\)/)
    expect(fallback).toMatch(
      /finally \{[\s\S]*input\.remove\(\)[\s\S]*activeElement instanceof HTMLElement[\s\S]*activeElement\.focus\(\{ preventScroll: true \}\)/
    )

    const copyUrl = source.slice(source.indexOf('async copyUrl (): Promise<void>'), source.indexOf('openSocialPop (url: string)'))
    expect(copyUrl).toMatch(
      /let copied = false[\s\S]*navigator\.clipboard\?\.writeText[\s\S]*await navigator\.clipboard\.writeText\(this\.url\)[\s\S]*copied = true[\s\S]*catch \{[\s\S]*copied = false/
    )
    expect(copyUrl).toMatch(
      /if \(!copied\) copied = copyWithLegacyFallback\(this\.url\)[\s\S]*if \(!copied\) throw new Error\(['"]Clipboard copy was rejected['"]\)/
    )
    expect(copyUrl).toMatch(
      /if \(!copied\) throw[\s\S]*wikiStore\.showNotification\s*\(\s*\{\s*style:\s*['"]success['"]\s*,\s*message:\s*`URL copied successfully`\s*,\s*icon:\s*['"]content-copy['"]\s*\}\s*\)/
    )
    expect(copyUrl).toMatch(
      /catch\s*\{\s*wikiStore\.showNotification\s*\(\s*\{\s*style:\s*['"]red['"]\s*,\s*message:\s*`Failed to copy to clipboard`\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)/
    )

    const openSocialPop = source.slice(source.indexOf('openSocialPop (url: string)'))
    expect(openSocialPop).toMatch(/const popupWindow = window\.open\(\s*['"]['"]\s*,\s*['"]_blank['"]/)
    expect(openSocialPop).toMatch(
      /if \(popupWindow\) \{[\s\S]*popupWindow\.opener = null[\s\S]*popupWindow\.location\.replace\(url\)[\s\S]*popupWindow\.focus\(\)/
    )
    expect(openSocialPop).toMatch(
      /else \{[\s\S]*wikiStore\.showNotification\s*\(\s*\{\s*style:\s*['"]red['"]\s*,\s*message:\s*`Allow popups to share this page\.`\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)/
    )
    expect(source).not.toMatch(/this\.\$store\.commit\(\s*['"]showNotification['"]\s*,/)
  })
})
