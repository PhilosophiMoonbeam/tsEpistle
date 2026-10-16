import fs from 'node:fs'
import path from 'node:path'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, expect, it, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, resetBody } from '../../test/browser-dom.mts'
import type { App, RenderFunction } from 'vue'
import { IssuePersonalMcpKeyInputSchema } from '../../../shared/personal-mcp.ts'

// Vue/Vuetify capture DOM capabilities at module evaluation; browser-dom must install the test window first.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const components = await import('vuetify/components')
const directives = await import('vuetify/directives')
const filename = path.join(process.cwd(), 'client/components/profile/profile-mcp-keys.vue')
const descriptor = parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor
const metadata = compileScript(descriptor, { id: 'profile-mcp' })
const script = descriptor.scriptSetup!.content
const parts: string[] = []
let end = 0
for (const statement of metadata.scriptSetupAst!) {
  if (statement.type !== 'ImportDeclaration') continue
  parts.push(script.slice(end, statement.start!))
  end = statement.end!
}
parts.push(script.slice(end))
const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(parts.join(''))
const bindings = Object.keys(metadata.bindings!).filter(name => metadata.bindings![name] !== 'props' && !metadata.imports?.[name])
const dependencies = [...Object.keys(metadata.imports!), 'defineProps']
const evaluate = new Function(`{ ${dependencies.join(', ')} }`, `${source}\nreturn { ${bindings.join(', ')} }`)
const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'profile-mcp', compilerOptions: { mode: 'function' } })
if (template.errors.length) throw template.errors[0]
const render = new Function('Vue', template.code)(Vue) as RenderFunction
const apps: App[] = []
const key = { id: 7, name: 'Desktop', access: 'read-only' as const, createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', isRevoked: false }
const settle = async () => { for (let n = 0; n < 6; n++) { await Promise.resolve(); await Vue.nextTick() } }

function mount(issue: () => Promise<{ key: string; item: typeof key }>) {
  const host = document.createElement('div')
  document.body.append(host)
  const props = Vue.reactive({ ownerId: 1, csrfToken: 'csrf-session-one' })
  const store = Vue.reactive({ user: { id: 1 } })
  const errors: unknown[] = []
  const load = vi.fn(async () => ({ enabled: true, canIssue: true, endpoint: 'https://wiki.example/mcp', keys: [] as typeof key[] }))
  const create = vi.fn(issue)
  const component = Vue.defineComponent({
    props: ['ownerId', 'csrfToken'],
    setup(componentProps) {
      return evaluate({ ...Vue, IssuePersonalMcpKeyInputSchema, defineProps: () => componentProps, wikiStore: store, fetchProfileMcpKeys: load,
        issueProfileMcpKey: create, revokeProfileMcpKey: vi.fn(), requestConfirmation: vi.fn(async () => false),
        getErrorMessage: (value: unknown) => value instanceof Error ? value.message : 'Request failed' })
    },
    render
  })
  const app = Vue.createApp({ render: () => Vue.h(component, { ...props }) })
  app.use(createVuetify({ components, directives }))
  app.config.errorHandler = error => errors.push(error)
  app.mount(host)
  apps.push(app)
  return { host, props, store, errors, create, load }
}
const button = (host: HTMLElement, label: string) => {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)
  if (!found) throw new Error(`Missing control: ${label}`)
  return found
}
async function startIssue(host: HTMLElement) {
  const input = host.querySelector<HTMLInputElement>('form input[type="text"]')!
  input.value = 'Desktop'
  input.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
  await settle()
  button(host, 'Create MCP key').click()
  await settle()
}

afterEach(() => { for (const app of apps.splice(0)) app.unmount(); resetBody(); vi.restoreAllMocks() })

it('discards a late key-creation secret when the signed-in account changes', async () => {
  const pending = Promise.withResolvers<{ key: string; item: typeof key }>()
  const mounted = mount(() => pending.promise)
  await settle()
  await startIssue(mounted.host)
  expect(mounted.create).toHaveBeenCalledOnce()
  mounted.store.user.id = 2
  mounted.props.ownerId = 2
  mounted.props.csrfToken = 'csrf-session-two'
  await settle()
  pending.resolve({ key: 'private-owner-one-key', item: key })
  await settle()
  expect(mounted.host.textContent).not.toContain('Save your new key now')
  expect([...mounted.host.querySelectorAll('input')].map(input => input.value)).not.toContain('private-owner-one-key')
  expect(mounted.host.querySelector('.profile-mcp__keys')?.textContent ?? '').not.toContain('Desktop')
  expect(mounted.errors).toEqual([])
})

it('keeps a newly issued secret masked and forgets it after acknowledgement without creating another key', async () => {
  const mounted = mount(async () => ({ key: 'one-time-private-key', item: key }))
  await settle()
  await startIssue(mounted.host)
  const secret = [...mounted.host.querySelectorAll<HTMLInputElement>('input')].find(input => input.value === 'one-time-private-key')!
  expect(secret.type).toBe('password')
  button(mounted.host, 'Done').click()
  await settle()
  expect([...mounted.host.querySelectorAll('input')].map(input => input.value)).not.toContain('one-time-private-key')
  expect(mounted.host.querySelector('.profile-mcp__keys')?.textContent).toContain('Desktop')
  button(mounted.host, 'Reload access keys').click()
  await settle()
  expect(mounted.create).toHaveBeenCalledOnce()
  expect([...mounted.host.querySelectorAll('input')].map(input => input.value)).not.toContain('one-time-private-key')
  expect(mounted.errors).toEqual([])
})

it('blocks another issuance after an uncertain response until a successful inventory reconciliation', async () => {
  const mounted = mount(async () => { throw new Error('Connection lost after submission') })
  await settle()
  await startIssue(mounted.host)
  expect(mounted.create).toHaveBeenCalledOnce()
  expect(button(mounted.host, 'Create MCP key').disabled).toBe(true)
  button(mounted.host, 'Create MCP key').click()
  await settle()
  expect(mounted.create).toHaveBeenCalledOnce()
  mounted.load.mockRejectedValueOnce(new Error('Still offline'))
  button(mounted.host, 'Reload access keys').click()
  await settle()
  expect(mounted.host.querySelector('form')).toBeNull()
  mounted.load.mockResolvedValueOnce({ enabled: true, canIssue: true, endpoint: 'https://wiki.example/mcp', keys: [key] })
  button(mounted.host, 'Reload access keys').click()
  await settle()
  expect(mounted.host.querySelector('.profile-mcp__keys')?.textContent).toContain('Desktop')
  expect(button(mounted.host, 'Create MCP key').disabled).toBe(false)
  expect(mounted.create).toHaveBeenCalledOnce()
  expect(mounted.errors).toEqual([])
})
