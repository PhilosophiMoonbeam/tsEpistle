const fs = require('fs')
const path = require('path')

const sourcePath = path.join(__dirname, 'admin-auth.vue')
const source = fs.readFileSync(sourcePath, 'utf8')
const script = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)[1]

const extractMethod = (name) => {
  const marker = `    async ${name}()`
  const start = script.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  const rest = script.slice(start)
  const match = rest.match(/\n {4}(?:async )?[a-zA-Z0-9_]+\s*\(/)
  return match ? rest.slice(0, match.index) : rest
}

describe('admin-auth strategies REST facade', () => {
  const save = extractMethod('save')

  test('imports REST auth strategy helper while retaining query Apollo surface', () => {
    expect(script).toContain("import { updateAdminAuthStrategies } from '../../helpers/auth-api'")
    expect(script).toContain('apollo: {')
    expect(script).toContain('authentication {')
    expect(script).toContain('strategies {')
    expect(script).toContain('activeStrategies {')
  })

  test('save uses REST helper and preserves payload mapping and UI behavior', () => {
    expect(save).toContain("this.$store.commit(`loadingStart`, 'admin-auth-savestrategies')")
    expect(save).toContain('await updateAdminAuthStrategies(window.fetch.bind(window), this.activeStrategies.map((str, idx) => ({')
    expect(save).toContain('strategyKey: str.strategy.key')
    expect(save).toContain('order: idx')
    expect(save).toContain('config: str.config.map(cfg => ({ ...cfg, value: JSON.stringify({ v: cfg.value.value }) }))')
    expect(save).toContain('domainWhitelist: str.domainWhitelist')
    expect(save).toContain('autoEnrollGroups: str.autoEnrollGroups')
    expect(save).toContain("this.$store.commit('showNotification', {")
    expect(save).toContain("message: this.$t('admin:auth.saveSuccess')")
    expect(save).toContain("this.$store.commit('pushGraphError', err)")
    expect(save).toContain("this.$store.commit(`loadingStop`, 'admin-auth-savestrategies')")

    expect(save).not.toContain('this.$apollo.mutate')
    expect(save).not.toContain('updateStrategies')
    expect(save).not.toContain('responseResult')
  })
})
