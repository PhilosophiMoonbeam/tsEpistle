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
  const match = rest.slice(1).match(/\n {4}(?:async )?[a-zA-Z0-9_]+\s*\(/)
  return match ? rest.slice(0, match.index + 1) : rest
}

describe('admin-auth strategies REST facade', () => {
  const loadStrategies = extractMethod('loadStrategies')
  const loadActiveStrategies = extractMethod('loadActiveStrategies')
  const refresh = extractMethod('refresh')
  const save = extractMethod('save')

  test('imports REST auth helpers and removes Apollo query surface', () => {
    expect(script).toContain('fetchAdminAuthStrategies')
    expect(script).toContain('fetchAdminAuthActiveStrategies')
    expect(script).toContain('updateAdminAuthStrategies')
    expect(script).not.toContain('graphql-tag')
    expect(script).not.toContain('apollo: {')
    expect(script).not.toContain('authentication {')
    expect(script).not.toContain('this.$apollo.queries')
  })

  test('loads strategy definitions and active strategies through REST helpers', () => {
    expect(loadStrategies).toContain("this.$store.commit('loadingStart', 'admin-auth-strategies-refresh')")
    expect(loadStrategies).toContain("fetchAdminAuthStrategies(window.fetch.bind(window), 'Authentication strategies response is invalid')")
    expect(loadStrategies).toContain("this.$store.commit('loadingStop', 'admin-auth-strategies-refresh')")
    expect(loadStrategies).toContain("this.$store.commit('showNotification'")

    expect(loadActiveStrategies).toContain("this.$store.commit('loadingStart', 'admin-auth-activestrategies-refresh')")
    expect(loadActiveStrategies).toContain("fetchAdminAuthActiveStrategies(window.fetch.bind(window), 'Active authentication strategies response is invalid')")
    expect(loadActiveStrategies).toContain("this.$store.commit('loadingStop', 'admin-auth-activestrategies-refresh')")
    expect(loadActiveStrategies).toContain("this.$store.commit('showNotification'")
  })

  test('refresh reloads REST data and host before notifying success', () => {
    expect(refresh).toContain('await this.loadStrategies()')
    expect(refresh).toContain('await this.loadActiveStrategies()')
    expect(refresh).toContain('await this.loadHost()')
    expect(refresh).toContain("message: this.$t('admin:auth.refreshSuccess')")
  })

  test('created hook starts REST strategy loads', () => {
    expect(script).toContain('this.loadStrategies().catch(() => {})')
    expect(script).toContain('this.loadActiveStrategies().catch(() => {})')
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
