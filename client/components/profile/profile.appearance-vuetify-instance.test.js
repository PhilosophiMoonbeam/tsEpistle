const fs = require('fs')
const path = require('path')

const componentPath = path.join(__dirname, 'profile.vue')

describe('profile appearance vuetify instance usage', () => {
  test('uses the injected component vuetify instance instead of WIKI root vuetify', () => {
    const content = fs.readFileSync(componentPath, 'utf8')

    expect(content).toContain('this.$vuetify.theme.dark = siteConfig.darkMode')
    expect(content).toContain("this.$vuetify.theme.dark = (newValue === 'dark')")
    expect(content).toContain('/* global siteConfig */')
    expect(content).not.toContain('WIKI.$vuetify')
    expect(content).not.toContain('/* global WIKI, siteConfig */')
  })
})
