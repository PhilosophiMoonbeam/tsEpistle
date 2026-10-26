import fs from 'node:fs'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { apiKeyState } from '../../../shared/api-admin.ts'
import { apiAccessContract } from '../../../shared/api-access.ts'
import { browserWindow, document, resetBody } from '../../test/browser-dom.mts'
import { translateEnglish as t } from '../../test/english-translate.mts'

// Browser globals must exist before Vue and Vuetify capture platform capabilities.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const components = await import('vuetify/components')
const directives = await import('vuetify/directives')
const apps = []
const settle = async () => { for (let n = 0; n < 12; n++) { await Promise.resolve(); await Vue.nextTick() } }
const deferred = () => Promise.withResolvers()
const group = { id: 3, name: 'Readers', permissions: ['read:pages'], pageRuleCount: 0, pageRules: [] }
const service = { id: 7, name: 'Indexer', keyShort: '...[redacted]', grant: { groupId: 3 }, canRevoke: true, isRevoked: false, expiration: '2099-01-01', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
const personal = { id: 8, name: 'Desktop', access: 'read-only', expiresAt: '2099-01-01', createdAt: '2026-01-01', isRevoked: false, owner: { id: 4, name: 'Reader', email: 'reader@example.invalid', isActive: true } }
const snapshot = { enabled: true, createFullAccess: true, assignableGroups: [group], keys: [service], canManagePersonalMcpKeys: true, personalMcpKeys: [personal] }

function component(name, dependencies) {
  const filename = `client/components/admin/${name}.vue`
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  const template = compileTemplate({ source: descriptor.template.content, filename, id: name, compilerOptions: { mode: 'function' } })
  if (template.errors.length) throw template.errors[0]
  const render = new Function('Vue', template.code)(Vue)
  if (descriptor.script) {
    const script = descriptor.script.content.replace(/^import .*$/gm, '').replace('export default', 'return')
    return { ...new Function(...Object.keys(dependencies), new Bun.Transpiler({ loader: 'ts' }).transformSync(script))(...Object.values(dependencies)), render }
  }
  const metadata = compileScript(descriptor, { id: name })
  const source = descriptor.scriptSetup.content
  const parts = []
  let end = 0
  for (const statement of metadata.scriptSetupAst) {
    if (statement.type !== 'ImportDeclaration') continue
    parts.push(source.slice(end, statement.start))
    end = statement.end
  }
  parts.push(source.slice(end))
  const bindings = Object.keys(metadata.bindings).filter(key => metadata.bindings[key] !== 'props' && !metadata.imports?.[key])
  const evaluate = new Function('dependencies', `const { ${[...Object.keys(metadata.imports), 'defineProps', 'defineEmits'].join(', ')} } = dependencies;\n${new Bun.Transpiler({ loader: 'ts' }).transformSync(parts.join(''))}\nreturn { ${bindings.join(', ')} }`)
  return { props: ['loading', 'error', 'enabled'], setup: props => evaluate({ ...Vue, ...dependencies, defineProps: () => props, defineEmits: () => () => {} }), render }
}

function mount({ bootstrap = snapshot, load, create, revoke, revokePersonal, confirm, toggle, hash = '', userId = 1 } = {}) {
  const store = Vue.reactive({ user: { id: userId }, startLoading: vi.fn(), stopLoading: vi.fn(), showNotification: vi.fn(), showError: vi.fn() })
  const config = { agentCsrfToken: 'csrf-account-one' }
  const transport = {
    fetchAdminApiBootstrap: vi.fn(load || (async () => structuredClone(bootstrap))),
    fetchApiConnections: vi.fn(async () => ({ groups: [group] })),
    createAdminApiKey: vi.fn(create || (async () => ({ key: 'one-time-fixture-key', message: 'Created' }))),
    revokeAdminApiKey: vi.fn(revoke || (async () => ({ message: 'Revoked' }))),
    revokeAdminPersonalMcpKey: vi.fn(revokePersonal || (async (_fetch, _account, _csrf, id) => ({ id, isRevoked: true }))),
    setAdminApiState: vi.fn(toggle || (async () => ({ message: 'Changed' }))),
    requestConfirmation: vi.fn(confirm || (async () => true))
  }
  const dependencies = { ...transport, wikiStore: store, siteConfig: config, window: browserWindow, markRaw: Vue.markRaw, apiKeyState, getErrorMessage: error => error.message }
  const CreateApiKey = component('admin-api-create', dependencies)
  const AdminApiConnect = component('admin-api-connect', { apiAccessContract, useTranslate: () => t })
  const workspace = component('admin-api', { ...dependencies, CreateApiKey, AdminApiConnect })
  const route = Vue.reactive({ hash, query: {} })
  const host = document.createElement('div')
  document.body.append(host)
  const errors = []
  const app = Vue.createApp(workspace)
  app.use(createVuetify({ components, directives, defaults: { VDialog: { transition: false }, VTooltip: { disabled: true }, VSelect: { menuProps: { transition: false } } } }))
  app.component('AdminHero', { setup: (_props, { slots }) => () => Vue.h('header', [slots.default?.(), slots.status?.(), slots.actions?.()]) })
  app.config.globalProperties.$t = t
  app.config.globalProperties.$route = route
  app.config.globalProperties.$router = { push: vi.fn(async location => { route.hash = location.hash }) }
  app.config.errorHandler = error => errors.push(error)
  app.mount(host)
  apps.push(app)
  return { app, host, store, config, transport, errors, route }
}
const button = (root, label) => {
  const found = [...root.querySelectorAll('button, a[href]')].find(node => node.textContent.trim() === label)
  if (!found) throw new Error(`Missing control: ${label}`)
  return found
}
const field = (root, label) => {
  const labels = [...root.querySelectorAll('label')].filter(node => node.htmlFor && node.textContent.trim() === label)
  const found = [...root.querySelectorAll('input, textarea')].find(input => input.id && labels.some(node => node.htmlFor === input.id))
  if (!found) throw new Error(`Missing field: ${label}`)
  return found
}
const fill = async (input, value) => { input.value = value; input.dispatchEvent(new browserWindow.Event('input', { bubbles: true })); await settle() }
async function select(root, label, title) {
  const control = field(root, label)
  control.focus()
  control.dispatchEvent(new browserWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await settle()
  expect(control.getAttribute('aria-expanded')).toBe('true')
  const popup = document.getElementById(control.getAttribute('aria-controls'))
  const option = [...(popup?.querySelectorAll('[role="option"]') || [])].find(node => node.textContent.trim() === title)
  if (!option) throw new Error(`Missing option: ${title}`)
  option.click()
  await settle()
}
const dialog = title => {
  const available = label => {
    for (let node = label; node; node = node.parentElement) {
      if (node.inert || node.hidden || node.style.display === 'none') return false
    }
    return true
  }
  const active = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find(node => {
    const labels = (node.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)).filter(Boolean)
    return labels.length && labels.every(available) && (!title || labels.map(label => label.textContent.trim()).join(' ') === title)
  })
  if (!active) throw new Error(`No active dialog${title ? `: ${title}` : ''}`)
  return active
}
async function startCreate(mounted, name = 'Indexer') {
  button(mounted.host, t('admin:api.createKey')).click()
  await settle()
  await fill(field(dialog(), t('admin:apiCreate.integrationName')), name)
  button(dialog(), t('admin:apiCreate.continue')).click()
  await settle()
}
async function reviewGroup() {
  await select(dialog(), t('admin:apiCreate.permissionGroup'), group.name)
  button(dialog(), t('admin:apiCreate.continue')).click()
  await settle()
}
async function issue() {
  button(dialog(), t('admin:apiCreate.issueKey')).click()
  await settle()
}
afterEach(() => { for (const app of apps.splice(0)) app.unmount(); resetBody(); vi.restoreAllMocks() })

describe('mounted service API-key workspace', () => {
  it('issues group-bounded REST/GraphQL credentials and preserves the one-time secret when refresh fails', async () => {
    const mounted = mount()
    await settle()
    await startCreate(mounted, 'x')
    expect(field(dialog(), t('admin:apiCreate.integrationName')).value).toBe('x')
    expect(mounted.transport.createAdminApiKey).not.toHaveBeenCalled()
    await fill(field(dialog(), t('admin:apiCreate.integrationName')), 'Indexer')
    button(dialog(), t('admin:apiCreate.continue')).click()
    await settle()
    expect(dialog().querySelector('input[type="checkbox"]')).toBeNull()
    await reviewGroup()
    mounted.transport.fetchAdminApiBootstrap.mockRejectedValueOnce(new Error('Inventory unavailable'))
    await issue()
    expect(mounted.transport.createAdminApiKey).toHaveBeenCalledWith(expect.any(Function), { name: 'Indexer', expiration: '90d', fullAccess: false, group: 3 })
    const secretDialog = dialog(t('admin:apiCreate.saveNewKey'))
    expect(field(secretDialog, t('admin:apiCreate.generatedApiKey')).value).toBe('one-time-fixture-key')
    button(secretDialog, t('admin:apiCreate.iveSavedKey')).click()
    await settle()
    expect([...document.querySelectorAll('textarea')].map(node => node.value)).not.toContain('one-time-fixture-key')
    expect(mounted.errors).toEqual([])
  })

  it('requires an explicit available replacement grant without an MCP configuration dependency', async () => {
    const mounted = mount({ bootstrap: { ...snapshot, keys: [{ ...service, grant: { groupId: 99 } }] } })
    await settle()
    button(mounted.host, t('admin:api.createReplacement')).click()
    await settle()
    button(dialog(), t('admin:apiCreate.continue')).click()
    await settle()
    expect([...dialog().querySelectorAll('input[type="radio"]')].some(input => input.checked)).toBe(false)
    button(dialog(), t('admin:apiCreate.continue')).click()
    await settle()
    expect(mounted.transport.createAdminApiKey).not.toHaveBeenCalled()
    dialog().querySelector('input[type="radio"][value="group"]').click()
    await settle()
    await reviewGroup()
    await issue()
    expect(mounted.transport.createAdminApiKey).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ group: 3, fullAccess: false }))
    expect(mounted.errors).toEqual([])
  })

  it('keeps a failed issuance draft available and discards a late secret after an account switch', async () => {
    const pending = deferred()
    const mounted = mount()
    await settle()
    await startCreate(mounted)
    await reviewGroup()
    mounted.transport.createAdminApiKey.mockRejectedValueOnce(new Error('Creation rejected'))
    await issue()
    expect(dialog().textContent).toContain('Creation rejected')
    expect(dialog().textContent).toContain('Indexer')
    mounted.transport.createAdminApiKey.mockImplementationOnce(() => pending.promise)
    await issue()
    mounted.store.user.id = 2
    await settle()
    pending.resolve({ key: 'previous-account-secret', message: 'Created' })
    await settle()
    expect([...document.querySelectorAll('textarea')].map(node => node.value)).not.toContain('previous-account-secret')
    expect(mounted.errors).toEqual([])
  })

  it('offers only REST and GraphQL connection modes', async () => {
    const mounted = mount({ hash: '#connect' })
    await settle()
    const panel = mounted.host.querySelector('#api-panel-connect')
    expect([...panel.querySelectorAll('input[type="radio"]')].map(input => input.value)).toEqual(['rest', 'graphql'])
    expect(panel.querySelector('pre').textContent).toContain('/api/v1/pages?limit=10')
    panel.querySelector('input[value="graphql"]').click()
    await settle()
    expect(panel.querySelector('pre').textContent).toContain('/graphql')
    expect(mounted.errors).toEqual([])
  })

  it('serializes global toggles and waits for the refreshed inventory before reporting success', async () => {
    const mutation = deferred(), refresh = deferred()
    const mounted = mount({ bootstrap: { ...snapshot, enabled: false }, toggle: () => mutation.promise })
    await settle()
    mounted.transport.fetchAdminApiBootstrap.mockImplementationOnce(() => refresh.promise)
    button(mounted.host, t('admin:api.enableApiKeyAccess')).click()
    await settle()
    expect(button(mounted.host, t('admin:api.enableApiKeyAccess')).disabled).toBe(true)
    expect(mounted.transport.setAdminApiState).toHaveBeenCalledWith(expect.any(Function), true)
    mutation.resolve({ message: 'Changed' })
    await settle()
    expect(mounted.store.showNotification).not.toHaveBeenCalled()
    refresh.resolve(snapshot)
    await settle()
    expect(mounted.store.showNotification).toHaveBeenCalledWith(expect.objectContaining({ style: 'success' }))
    expect(button(mounted.host, t('admin:api.disableApiKeyAccess')).disabled).toBe(false)
    expect(mounted.errors).toEqual([])
  })

  it('confirms service revocation and reconciles it before notifying, while exposing mutation failures', async () => {
    const mutation = deferred(), refresh = deferred()
    const mounted = mount({ revoke: () => mutation.promise })
    await settle()
    button(mounted.host.querySelector('#api-panel-credentials'), t('admin:api.revokeKey')).click()
    await settle()
    mounted.transport.fetchAdminApiBootstrap.mockImplementationOnce(() => refresh.promise)
    button(dialog(), t('admin:api.revokeKey')).click()
    await settle()
    expect(mounted.transport.revokeAdminApiKey).toHaveBeenCalledWith(expect.any(Function), service.id)
    expect(mounted.transport.revokeAdminPersonalMcpKey).not.toHaveBeenCalled()
    mutation.resolve({ message: 'Revoked' })
    await settle()
    expect(mounted.store.showNotification).not.toHaveBeenCalled()
    refresh.resolve({ ...snapshot, keys: [{ ...service, isRevoked: true }] })
    await settle()
    expect(mounted.store.showNotification).toHaveBeenCalledWith(expect.objectContaining({ style: 'success' }))
    const failure = new Error('Toggle rejected')
    mounted.transport.setAdminApiState.mockRejectedValueOnce(failure)
    button(mounted.host, t('admin:api.disableApiKeyAccess')).click()
    await settle()
    button(dialog(t('admin:api.disableApiKeyAccess2')), t('admin:api.disableAccess')).click()
    await settle()
    expect(mounted.store.showError).toHaveBeenCalledWith(failure)
    expect(button(mounted.host, t('admin:api.disableApiKeyAccess')).disabled).toBe(false)
    expect(mounted.errors).toEqual([])
  })
})

describe('mounted personal MCP oversight', () => {
  it('preserves a cold personal deep link through account hydration and delayed router resolution without accepting pre-hydration inventory', async () => {
    for (const hash of ['#personal', '']) {
      const initialInventory = deferred(), authenticatedInventory = deferred()
      const mounted = mount({ userId: 0, hash, load: () => initialInventory.promise })
      await settle()
      if (!hash) {
        mounted.route.hash = '#personal'
        await settle()
      }
      expect(mounted.host.querySelector('#api-panel-personal')).toBeNull()
      mounted.transport.fetchAdminApiBootstrap.mockImplementationOnce(() => authenticatedInventory.promise)
      mounted.store.user.id = 1
      await settle()
      expect(mounted.route.hash).toBe('#personal')
      expect(mounted.host.querySelector('#api-panel-personal')).toBeNull()
      authenticatedInventory.resolve(snapshot)
      await settle()
      expect(mounted.host.querySelector('#api-tab-personal').getAttribute('aria-selected')).toBe('true')
      expect(mounted.host.querySelector('#api-panel-personal').style.display).not.toBe('none')
      initialInventory.resolve({ ...snapshot, personalMcpKeys: [{ ...personal, name: 'Pre-hydration inventory' }] })
      await settle()
      expect(mounted.route.hash).toBe('#personal')
      expect(mounted.host.querySelector('#api-panel-personal').textContent).toContain(personal.name)
      expect(mounted.host.textContent).not.toContain('Pre-hydration inventory')
      expect(mounted.errors).toEqual([])
    }
  })

  it('hides the personal workspace for delegated admins', async () => {
    const mounted = mount({ userId: 0, bootstrap: { ...snapshot, canManagePersonalMcpKeys: false, personalMcpKeys: [] }, hash: '#personal' })
    await settle()
    mounted.store.user.id = 38
    await settle()
    expect(mounted.host.querySelector('#api-tab-personal')).toBeNull()
    expect(mounted.host.querySelector('#api-panel-personal')).toBeNull()
    expect(mounted.route.hash).toBe('#credentials')
    expect(mounted.errors).toEqual([])
  })

  it('shows owner lifecycle, access and status with owner search and status filtering, without issuance or secrets', async () => {
    const mounted = mount({ hash: '#personal', bootstrap: { ...snapshot, personalMcpKeys: [personal, { ...personal, id: 9, name: 'Retired', isRevoked: true, owner: null }, { ...personal, id: 10, name: 'Inactive', access: 'read-write', expiresAt: '2020-01-01', owner: { ...personal.owner, isActive: false } }] } })
    await settle()
    const panel = mounted.host.querySelector('#api-panel-personal')
    expect(mounted.host.querySelector('#api-tab-personal').getAttribute('aria-selected')).toBe('true')
    expect(panel.style.display).not.toBe('none')
    expect(panel.querySelector('a[href="/p/profile"]')).not.toBeNull()
    expect(panel.querySelector('textarea, input[type="password"], code')).toBeNull()
    expect(panel.textContent).toContain(personal.owner.email)
    expect(panel.textContent).toContain(t('admin:api.ownerInactive'))
    expect(panel.textContent).toContain(t('admin:api.deletedOwner'))
    expect(panel.textContent).toContain(t('admin:api.personalReadWrite'))
    expect(panel.querySelectorAll('.api-record')).toHaveLength(3)
    expect([...mounted.host.querySelectorAll('header button')].some(node => node.textContent.trim() === t('admin:api.createKey'))).toBe(false)
    await fill(field(panel, t('admin:api.findPersonalMcpKey')), 'reader@example.invalid')
    expect(panel.querySelectorAll('.api-record')).toHaveLength(2)
    await select(panel, t('admin:api.keyStatus'), t('admin:api.expired2'))
    expect(panel.querySelectorAll('.api-record')).toHaveLength(1)
    expect(panel.querySelector('.api-record').textContent).toContain('Inactive')
    expect(mounted.transport.createAdminApiKey).not.toHaveBeenCalled()
    expect(mounted.errors).toEqual([])
  })

  it('revokes orphaned keys only after confirmation using the captured browser account and CSRF', async () => {
    const mounted = mount({ hash: '#personal', bootstrap: { ...snapshot, personalMcpKeys: [{ ...personal, owner: null }] } })
    await settle()
    const panel = mounted.host.querySelector('#api-panel-personal')
    mounted.transport.requestConfirmation.mockResolvedValueOnce(false)
    button(panel, t('admin:api.revokeKey')).click()
    await settle()
    expect(mounted.transport.revokeAdminPersonalMcpKey).not.toHaveBeenCalled()
    button(panel, t('admin:api.revokeKey')).click()
    await settle()
    expect(mounted.transport.revokeAdminPersonalMcpKey).toHaveBeenCalledWith(expect.any(Function), 1, 'csrf-account-one', personal.id)
    expect(mounted.transport.revokeAdminApiKey).not.toHaveBeenCalled()
    expect(panel.querySelector('summary').textContent).toContain(t('admin:api.revoked2'))
    expect([...panel.querySelectorAll('button')].some(node => node.textContent.trim() === t('admin:api.revokeKey'))).toBe(false)
    expect(mounted.errors).toEqual([])
  })

  it('keeps a personal key revocable after the dedicated endpoint rejects', async () => {
    const failure = new Error('Personal revocation rejected')
    const mounted = mount({ hash: '#personal', revokePersonal: async () => { throw failure } })
    await settle()
    const panel = mounted.host.querySelector('#api-panel-personal')
    button(panel, t('admin:api.revokeKey')).click()
    await settle()
    expect(mounted.store.showError).toHaveBeenCalledWith(failure)
    expect(panel.querySelector('summary').textContent).toContain(t('admin:api.active2'))
    expect(button(panel, t('admin:api.revokeKey')).disabled).toBe(false)
    expect(mounted.transport.revokeAdminApiKey).not.toHaveBeenCalled()
    expect(mounted.errors).toEqual([])
  })

  it('ignores confirmation and pending inventory responses from a previous account', async () => {
    const confirmation = deferred(), inventory = deferred()
    const mounted = mount({ hash: '#personal', confirm: () => confirmation.promise })
    await settle()
    button(mounted.host.querySelector('#api-panel-personal'), t('admin:api.revokeKey')).click()
    await settle()
    mounted.transport.fetchAdminApiBootstrap.mockImplementationOnce(() => inventory.promise)
    button(mounted.host, t('admin:shell.reload')).click()
    await settle()
    mounted.transport.fetchAdminApiBootstrap.mockResolvedValueOnce({ ...snapshot, canManagePersonalMcpKeys: false, personalMcpKeys: [] })
    mounted.store.user.id = 2
    await settle()
    confirmation.resolve(true)
    inventory.resolve(snapshot)
    await settle()
    expect(mounted.transport.revokeAdminPersonalMcpKey).not.toHaveBeenCalled()
    expect(mounted.host.querySelector('#api-tab-personal')).toBeNull()
    expect(mounted.host.textContent).not.toContain(personal.owner.email)
    expect(mounted.errors).toEqual([])
  })

  it('does not apply a previous account’s late revocation result to a new inventory', async () => {
    const pending = deferred()
    const mounted = mount({ hash: '#personal', revokePersonal: () => pending.promise })
    await settle()
    button(mounted.host.querySelector('#api-panel-personal'), t('admin:api.revokeKey')).click()
    await settle()
    expect(mounted.transport.revokeAdminPersonalMcpKey).toHaveBeenCalledOnce()
    mounted.store.user.id = 2
    mounted.config.agentCsrfToken = 'csrf-account-two'
    await settle()
    button(mounted.host, t('admin:api.personalMcpKeys')).click()
    await settle()
    pending.resolve({ id: personal.id, isRevoked: true })
    await settle()
    expect(mounted.host.querySelector('#api-panel-personal summary').textContent).toContain(t('admin:api.active2'))
    expect(button(mounted.host.querySelector('#api-panel-personal'), t('admin:api.revokeKey')).disabled).toBe(false)
    expect(mounted.store.showNotification).not.toHaveBeenCalled()
    expect(mounted.errors).toEqual([])
  })
})
