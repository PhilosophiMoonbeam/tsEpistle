const fs = require('fs')
const path = require('path')

const componentPath = path.join(__dirname, 'admin-locale.vue')

describe('admin locale i18n instance usage', () => {
  test('uses the injected component i18n instance instead of WIKI root i18n', () => {
    const content = fs.readFileSync(componentPath, 'utf8')

    expect(content).toContain('this.$i18n.i18next.changeLanguage(this.selectedLocale)')
    expect(content).toContain('this.$moment.locale(this.selectedLocale)')
    expect(content).toContain('this.$vuetify.rtl = curLocale && curLocale.isRTL')
    expect(content).not.toContain('WIKI.$i18n')
    expect(content).not.toContain('/* global WIKI */')
  })
})
