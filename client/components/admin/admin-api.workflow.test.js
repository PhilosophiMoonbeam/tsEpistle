import fs from 'node:fs'
import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'

const script = fs.readFileSync('client/components/admin/admin-api-create.vue', 'utf8').match(/<script lang='ts'>([\s\S]*?)<\/script>/)[1]
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, '').replace('export default', 'return'))
const eligibleGroup = {
  id: 3,
  name: 'Readers',
  permissions: ['read:pages'],
  pageRuleCount: 0,
  pageRules: []
}

function harness({ assignableGroups = [eligibleGroup], createFullAccess = false, connections = { mcpEnabled: true, mcpConfigurationError: false, mcpResource: 'mcp://configured' } } = {}) {
  const create = vi.fn(async () => ({ key: 'one-time-fixture-key' }))
  const refreshApiKeys = vi.fn(async () => true)
  const wikiStore = {
    startLoading: vi.fn(),
    stopLoading: vi.fn(),
    showNotification: vi.fn(),
    showError: vi.fn()
  }
  const options = new Function('createAdminApiKey', 'getErrorMessage', 'wikiStore', 'window', executable)(
    create,
    error => error.message,
    wikiStore,
    { fetch() {} }
  )
  const instance = {
    ...options.data(),
    assignableGroups,
    createFullAccess,
    connections,
    refreshApiKeys,
    $refs: { createForm: { validate: vi.fn(async () => ({ valid: true })) } },
    $nextTick: vi.fn(),
    $emit: vi.fn(),
    $t: key => key
  }
  for (const [key, fn] of Object.entries(options.methods)) instance[key] = fn.bind(instance)
  for (const [key, fn] of Object.entries(options.computed)) {
    if (typeof fn === 'function') Object.defineProperty(instance, key, { get: fn.bind(instance) })
  }
  return { instance, create, refreshApiKeys, wikiStore }
}

describe('guided API-key issuance', () => {
  it('keeps invalid identity and unavailable groups from reaching issuance', async () => {
    const { instance, create } = harness()
    instance.name = 'x'
    instance.nextStep()
    expect(instance.step).toBe(1)

    instance.name = 'Indexer'
    instance.nextStep()
    expect(instance.step).toBe(2)
    expect(instance.selectableGroups).toEqual([eligibleGroup])

    instance.group = 2
    instance.nextStep()
    expect(instance.step).toBe(2)
    expect(create).not.toHaveBeenCalled()

    instance.group = eligibleGroup.id
    instance.nextStep()
    expect(instance.step).toBe(3)

    instance.group = 2
    await instance.generate()
    expect(create).not.toHaveBeenCalled()
    expect(instance.step).toBe(2)
  })

  it('preserves the one-time credential when an inventory refresh rejects', async () => {
    const { instance, create, refreshApiKeys } = harness({ createFullAccess: true, assignableGroups: [] })
    Object.assign(instance, { name: 'Indexer', step: 3, scope: 'full', mcpAccess: false })
    refreshApiKeys.mockRejectedValueOnce(new Error('Inventory unavailable'))

    await instance.generate()

    expect(create).toHaveBeenCalledWith(expect.any(Function), {
      name: 'Indexer',
      expiration: '90d',
      fullAccess: true,
      group: null,
      mcpAccess: false
    })
    expect(instance.key).toBe('one-time-fixture-key')
    expect(instance.isCopyKeyDialogShown).toBe(true)
    expect(instance.flowProtected).toBe(true)
    expect(refreshApiKeys).toHaveBeenCalledWith(false)

    instance.finishCopyKey()
    expect(instance.key).toBe('')
    expect(instance.flowProtected).toBe(false)
  })

  it('retains a failed issuance draft and surfaces the error', async () => {
    const { instance, create, refreshApiKeys, wikiStore } = harness({ createFullAccess: true, assignableGroups: [] })
    Object.assign(instance, { name: 'Indexer', step: 3, scope: 'full' })
    const failure = new Error('Creation rejected')
    create.mockRejectedValueOnce(failure)

    await instance.generate()

    expect(instance.name).toBe('Indexer')
    expect(instance.step).toBe(3)
    expect(instance.formError).toBe('Creation rejected')
    expect(instance.isCopyKeyDialogShown).toBe(false)
    expect(instance.key).toBe('')
    expect(instance.loading).toBe(false)
    expect(refreshApiKeys).not.toHaveBeenCalled()
    expect(wikiStore.showError).toHaveBeenCalledWith(failure)
  })

  it('requires a deliberate decision when a replacement needs unavailable MCP configuration', () => {
    const { instance, create } = harness({ createFullAccess: true, assignableGroups: [], connections: null })
    Object.assign(instance, { name: 'Agent replacement', step: 2, scope: 'full', mcpAccess: true })

    instance.nextStep()
    expect(instance.step).toBe(2)
    expect(instance.formError).toContain('MCP configuration is unavailable')
    expect(create).not.toHaveBeenCalled()

    instance.mcpAccess = false
    instance.nextStep()
    expect(instance.step).toBe(3)
  })
})
