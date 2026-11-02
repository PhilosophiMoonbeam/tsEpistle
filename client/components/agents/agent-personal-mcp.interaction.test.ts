import fs from 'node:fs'
import path from 'node:path'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, resetBody } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
import { AgentApiError } from '../../helpers/agents-api.ts'
import { externalMcpOAuthErrorKey, type ExternalMcpServerView, type ExternalMcpDiscovery } from '../../helpers/agent-control-api.ts'
import { ExternalMcpServerInputSchema } from '../../../shared/agents/external-mcp.ts'
import { createExternalMcpOAuthDraft, externalMcpOAuthInput } from '../../helpers/external-mcp-oauth-form.ts'
import { useTranslate } from '../../helpers/use-translate.ts'
import type { App, RenderFunction } from 'vue'

// Vue/Vuetify must evaluate after browser-dom installs the test document.
const Vue = await import('vue')
const { createVuetify, useDisplay } = await import('vuetify')
const components = await import('vuetify/components')
const directives = await import('vuetify/directives')
const filename = path.join(process.cwd(), 'client/components/agents/agent-personal-mcp.vue')
const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
const metadata = compileScript(descriptor, { id: 'personal-mcp-behavior' })
const script = descriptor.scriptSetup!.content
const parts: string[] = []
let end = 0
for (const statement of metadata.scriptSetupAst!) {
  if (statement.type !== 'ImportDeclaration') continue
  parts.push(script.slice(end, statement.start!))
  end = statement.end!
}
parts.push(script.slice(end))
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(parts.join(''))
const bindings = Object.keys(metadata.bindings!).filter(
  name => metadata.bindings![name] !== 'props' && metadata.bindings![name] !== 'props-aliased' && !metadata.imports?.[name]
)
const dependencies = [...Object.keys(metadata.imports!), 'defineProps', 'defineModel', 'defineEmits', 'window']
const evaluate = new Function(`{ ${dependencies.join(', ')} }`, `${executable}\nreturn { ${bindings.join(', ')} }`)
const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'personal-mcp-behavior', compilerOptions: { mode: 'function' } })
if (template.errors.length) throw template.errors[0]
const render = new Function('Vue', template.code)(Vue) as RenderFunction
const mounted: Array<{ app: App; host: HTMLElement }> = []
const settle = async () => {
  for (let pass = 0; pass < 6; pass++) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}
const sharedServer: ExternalMcpServerView = {
  id: '8b519375-2991-45ad-a196-b063ac2732cf',
  displayName: 'Shared research catalog',
  endpointUrl: 'https://research.example.test/mcp',
  destinationHost: 'research.example.test',
  namespace: 'research',
  scope: 'admin',
  ownerId: null,
  status: 'enabled',
  revision: 1,
  authMode: 'none',
  secretConfigured: false,
  groupIds: [4],
  trust: 'untrusted',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z'
}
const disabled = () => new AgentApiError(403, 'Disabled', 'EXTERNAL_MCP_DISABLED')
function mount(permissions: string[] = [], identity = { id: 7, authenticated: true }) {
  const store = Vue.reactive({ user: { ...identity, permissions } })
  const props = Vue.reactive({ ownerId: 7, csrfToken: 'csrf-session-seven', networkBlocked: false, connectionRetrying: false })
  const model = Vue.ref(true)
  const personal = vi.fn(async (): Promise<ExternalMcpServerView[]> => [])
  const available = vi.fn(async (): Promise<ExternalMcpServerView[]> => [sharedServer])
  const create = vi.fn(async () => ({ ...sharedServer, scope: 'personal' as const, ownerId: 7 }))
  const update = vi.fn(async () => ({ ...sharedServer, scope: 'personal' as const, ownerId: 7 }))
  const remove = vi.fn(async () => undefined)
  const discover = vi.fn(async (): Promise<ExternalMcpDiscovery> => {
    throw new Error('Unexpected catalog discovery')
  })
  const assign = vi.fn((_url: string) => undefined)
  const host = document.createElement('div')
  document.body.append(host)
  // OAuth has its own integration suite. None of these fixtures use OAuth; do not reproduce its behavior here.
  const UnusedOAuth = Vue.defineComponent({ render: () => null })
  const component = Vue.defineComponent({
    props: ['ownerId', 'csrfToken', 'networkBlocked', 'connectionRetrying'],
    components: { AgentMcpOauthConnection: UnusedOAuth, AgentMcpOauthSettings: UnusedOAuth },
    setup(componentProps) {
      return evaluate({
        ...Vue,
        useDisplay,
        useTranslate,
        wikiStore: store,
        AgentApiError,
        ExternalMcpServerInputSchema,
        createExternalMcpOAuthDraft,
        externalMcpOAuthInput,
        externalMcpOAuthErrorKey,
        AgentMcpOauthConnection: UnusedOAuth,
        AgentMcpOauthSettings: UnusedOAuth,
        listPersonalExternalMcp: personal,
        listAvailableExternalMcp: available,
        createPersonalExternalMcp: create,
        updatePersonalExternalMcp: update,
        deletePersonalExternalMcp: remove,
        discoverExternalMcp: discover,
        defineProps: () => componentProps,
        defineModel: () => model,
        defineEmits: () => () => undefined,
        // A navigation boundary, not a replacement dialog: do not navigate the shared JSDOM window.
        window: { fetch: browserWindow.fetch, location: { assign } }
      })
    },
    render
  })
  const app = Vue.createApp({ render: () => Vue.h(component, { ...props }) })
  app.use(createVuetify({ components, directives }))
  app.config.globalProperties.$t = translateEnglish
  // Configure service outcomes before mounting starts the immediate open watcher.
  mounted.push({ app, host })
  return { store, props, model, personal, available, create, update, remove, discover, assign, start: () => app.mount(host) }
}
const button = (root: ParentNode, label: string): HTMLButtonElement => {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)
  if (!found) throw new Error(`Missing control: ${label}`)
  return found
}
const mainDialog = (): HTMLElement => {
  const found = document.body.querySelector<HTMLElement>('.personal-mcp')
  if (!found) throw new Error('My tools dialog did not render')
  return found
}
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount()
    host.remove()
  }
  resetBody()
})

describe('personal MCP availability diagnoses', () => {
  for (const source of ['both', 'personal', 'available'] as const) {
    it(`unifies authoritative ${source} disablement without fake empty inventory or duplicated warnings`, async () => {
      const view = mount()
      if (source !== 'available') view.personal.mockRejectedValueOnce(disabled())
      if (source !== 'personal') view.available.mockRejectedValueOnce(disabled())
      view.start()
      await settle()
      const dialog = mainDialog()
      expect(dialog.querySelectorAll('[role="status"]')).toHaveLength(1)
      expect(dialog.querySelector('[role="status"]')?.textContent).toContain(translateEnglish('profile:personalMcp.administratorDisabled'))
      expect(dialog.querySelector('[role="alert"]')).toBeNull()
      expect(dialog.querySelector('.personal-mcp__catalog')).toBeNull()
      expect(dialog.querySelector('form')).toBeNull()
      expect(dialog.querySelector('details')).toBeNull()
      expect(dialog.textContent).not.toContain('No enabled external servers are available.')
      expect(dialog.querySelector('a[href="/a/agents#external-mcp"]')).toBeNull()
      button(dialog, translateEnglish('profile:personalMcp.close')).click()
      await settle()
      expect(view.model.value).toBe(false)
      expect(view.create).toHaveBeenCalledTimes(0)
      expect(view.update).toHaveBeenCalledTimes(0)
      expect(view.remove).toHaveBeenCalledTimes(0)
      expect(view.discover).toHaveBeenCalledTimes(0)
    })
  }

  for (const scenario of [
    { name: 'expired session', error: new AgentApiError(401, 'Unauthorized'), key: 'sessionUnavailable' },
    { name: 'network failure', error: new TypeError('Connection reset'), key: 'connectionUnavailable' },
    { name: 'server failure', error: new AgentApiError(503, 'Unavailable'), key: 'serverUnavailable' }
  ]) {
    it(`keeps ${scenario.name} distinct from administrator disablement and successful empty inventory`, async () => {
      const view = mount()
      view.personal.mockRejectedValueOnce(scenario.error)
      view.available.mockRejectedValueOnce(scenario.error)
      view.start()
      await settle()
      const dialog = mainDialog()
      expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(translateEnglish(`profile:personalMcp.${scenario.key}`))
      expect(dialog.textContent).not.toContain(translateEnglish('profile:personalMcp.administratorDisabled'))
      expect(dialog.textContent).not.toContain('No enabled external servers are available.')
      expect(dialog.querySelector('form')).toBeNull()
      expect(button(dialog, 'Reload servers').disabled).toBe(false)
    })
  }

  it('retains granted shared tools when personal management is group-denied', async () => {
    const view = mount()
    view.personal.mockRejectedValueOnce(new AgentApiError(403, 'Denied', 'EXTERNAL_MCP_ACCESS_DENIED'))
    view.start()
    await settle()
    const dialog = mainDialog()
    expect(dialog.textContent).toContain(translateEnglish('profile:personalMcp.personalDeniedSharedAvailable'))
    expect(dialog.textContent).not.toContain(translateEnglish('profile:personalMcp.administratorDisabled'))
    expect(dialog.querySelector('.personal-mcp__catalog')?.textContent).toContain('Shared research catalog')
    expect(button(dialog, 'Discover tools').disabled).toBe(false)
    expect(dialog.querySelector('form')).toBeNull()
    expect(dialog.querySelector('details')).not.toBeNull()
    expect(view.discover).toHaveBeenCalledTimes(0)
  })

  it('does not misreport a failed shared inventory as empty when personal management succeeds', async () => {
    const view = mount()
    view.available.mockRejectedValueOnce(new TypeError('Shared inventory unreachable'))
    view.start()
    await settle()
    const dialog = mainDialog()
    expect(dialog.querySelector('form')).not.toBeNull()
    expect(dialog.querySelector('.personal-mcp__catalog')).toBeNull()
    expect(dialog.textContent).toContain(translateEnglish('profile:personalMcp.connectionUnavailable'))
    expect(dialog.textContent).not.toContain('No enabled external servers are available.')
    expect(dialog.textContent).not.toContain(translateEnglish('profile:personalMcp.administratorDisabled'))
  })
})

describe('disabled MCP navigation authority and draft decisions', () => {
  for (const identity of [
    { name: 'current system administrator', id: 7, authenticated: true, permissions: ['manage:system'], settings: true },
    { name: 'unrelated administrative permission', id: 7, authenticated: true, permissions: ['manage:users'], settings: false },
    { name: 'stale system administrator identity', id: 8, authenticated: true, permissions: ['manage:system'], settings: false },
    { name: 'signed-out system administrator', id: 7, authenticated: false, permissions: ['manage:system'], settings: false }
  ]) {
    it(`offers ${identity.settings ? 'workspace settings' : 'Close only'} to ${identity.name}`, async () => {
      const view = mount(identity.permissions, identity)
      view.personal.mockRejectedValueOnce(disabled())
      view.available.mockRejectedValueOnce(disabled())
      view.start()
      await settle()
      const status = mainDialog().querySelector<HTMLElement>('[role="status"]')!
      const link = status.querySelector<HTMLAnchorElement>('a')
      if (identity.settings) {
        expect(link?.getAttribute('href')).toBe('/a/agents#external-mcp')
        link!.click()
        await settle()
        expect(view.assign.mock.calls).toEqual([['/a/agents#external-mcp']])
      } else {
        expect(link).toBeNull()
        button(status, translateEnglish('profile:personalMcp.close')).click()
        await settle()
        expect(view.model.value).toBe(false)
        expect(view.assign).toHaveBeenCalledTimes(0)
      }
      expect(view.create).toHaveBeenCalledTimes(0)
      expect(view.update).toHaveBeenCalledTimes(0)
      expect(view.remove).toHaveBeenCalledTimes(0)
      expect(view.discover).toHaveBeenCalledTimes(0)
    })
  }

  for (const administrator of [false, true]) {
    it(`preserves unsaved decisions before disabled-state ${administrator ? 'settings navigation' : 'Close'}`, async () => {
      const view = mount(administrator ? ['manage:system'] : [])
      view.start()
      await settle()
      const name = mainDialog().querySelector<HTMLInputElement>('.v-text-field input')!
      name.value = 'Unsubmitted endpoint configuration'
      name.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
      await settle()
      view.personal.mockRejectedValueOnce(disabled())
      view.available.mockRejectedValueOnce(disabled())
      button(mainDialog(), 'Reload servers').click()
      await settle()
      const leave = () => {
        const status = mainDialog().querySelector<HTMLElement>('[role="status"]')!
        if (administrator) status.querySelector<HTMLAnchorElement>('a')!.click()
        else button(status, translateEnglish('profile:personalMcp.close')).click()
      }
      leave()
      await settle()
      expect(document.body.querySelector('#personal-mcp-discard-title')).not.toBeNull()
      expect(view.model.value).toBe(true)
      expect(view.assign).toHaveBeenCalledTimes(0)
      button(document.body, 'Keep editing').click()
      await settle()
      expect(view.model.value).toBe(true)
      expect(view.assign).toHaveBeenCalledTimes(0)
      leave()
      await settle()
      button(document.body, 'Discard').click()
      await settle()
      if (administrator) expect(view.assign.mock.calls).toEqual([['/a/agents#external-mcp']])
      else expect(view.model.value).toBe(false)
      expect(view.create).toHaveBeenCalledTimes(0)
      expect(view.update).toHaveBeenCalledTimes(0)
    })
  }
})
