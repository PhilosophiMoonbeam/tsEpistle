import fs from 'node:fs'
import path from 'node:path'

const componentPath = path.join(process.cwd(), 'client/components/profile/profile.vue')

describe('profile appearance theme integration', () => {
  test('uses the injected Vuetify instance and shared appearance resolution', () => {
    const content = fs.readFileSync(componentPath, 'utf8')

    expect(content).toContain("import { resolveThemeName } from '../../helpers/theme.ts'")
    expect(content).toContain("'user.appearance': function (newValue: string, _oldValue: string)")
    expect(content).toContain('void this.$vuetify.theme.change(resolveThemeName(newValue, siteConfig.darkMode))')
    expect(content).toContain('if (!this.user) return')
    expect(content).toContain("value: 'light'")
    expect(content).toContain("value: 'dark'")
    expect(content).toContain("value: 'system'")
    expect(content).not.toContain('WIKI.$vuetify')
    expect(content).not.toContain('/* global WIKI, siteConfig */')
  })
})
