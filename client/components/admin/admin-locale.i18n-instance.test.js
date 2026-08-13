import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const componentPath = path.join(__dirname, 'admin-locale.vue')

describe('admin locale i18n instance usage', () => {
  test('uses typed injected UI instances instead of WIKI root globals', () => {
    const content = fs.readFileSync(componentPath, 'utf8')

    expect(content).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(content).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(content).toContain('void this.$i18n.changeLanguage(this.selectedLocale)')
    expect(content).toContain('this.$moment.locale(this.selectedLocale)')
    expect(content).toContain('this.$vuetify.locale.rtl[this.selectedLocale] = Boolean(curLocale && curLocale.isRTL)')
    expect(content).not.toContain('this.$i18n.i18next')
    expect(content).not.toContain('WIKI.$i18n')
    expect(content).not.toContain('/* global WIKI */')
  })
})
