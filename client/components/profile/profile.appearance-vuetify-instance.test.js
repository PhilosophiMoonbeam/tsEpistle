import fs from 'node:fs'
import path from 'node:path'

const componentPath = path.join(process.cwd(), 'client/components/profile/profile.vue')

describe('profile appearance vuetify instance usage', () => {
  test('uses the injected component vuetify instance instead of WIKI root vuetify', () => {
    const content = fs.readFileSync(componentPath, 'utf8')

    expect(content).toContain("const themeName = newValue === ''")
    expect(content).toContain("? siteConfig.darkMode ? 'dark' : 'light'")
    expect(content).toContain("'user.appearance': function (newValue: string, _oldValue: string)")
    expect(content).toContain("newValue === 'dark' ? 'dark' : 'light'")
    expect(content).toContain('void this.$vuetify.theme.change(themeName)')
    expect(content).toContain('/* global siteConfig */')
    expect(content).not.toContain('WIKI.$vuetify')
    expect(content).not.toContain('/* global WIKI, siteConfig */')
  })
})
