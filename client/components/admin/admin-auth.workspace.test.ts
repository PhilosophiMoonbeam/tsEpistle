import fs from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import * as ts from 'typescript'
import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { authenticationDraft, authenticationSignature } from '../../helpers/authentication-workspace-api.ts'

const compileComponentOptions = (path: string): string => {
  const parsed = parse(fs.readFileSync(path, 'utf8'), { filename: path })
  if (parsed.errors.length > 0 || !parsed.descriptor.script || parsed.descriptor.scriptSetup)
    throw new Error(`Could not read the ordinary script from ${path}.`)

  const source = ts.createSourceFile(path, parsed.descriptor.script.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const transformed = ts.transform(source, [
    context => root =>
      ts.visitEachChild(
        root,
        node => {
          if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node)) return undefined
          if (ts.isExportAssignment(node)) {
            if (node.isExportEquals) throw new Error(`${path} must use an ES module default export.`)
            return ts.factory.createVariableStatement(
              undefined,
              ts.factory.createVariableDeclarationList(
                [ts.factory.createVariableDeclaration('component', undefined, undefined, node.expression)],
                ts.NodeFlags.Const
              )
            )
          }
          return node
        },
        context
      )
  ])
  try {
    return new Bun.Transpiler({ loader: 'ts' }).transformSync(ts.createPrinter().printFile(transformed.transformed[0]!))
  } finally {
    transformed.dispose()
  }
}

const compiled = compileComponentOptions('client/components/admin/admin-auth.vue')
const provider = {
  key: 'org',
  strategyKey: 'oidc',
  displayName: 'Organization',
  description: 'Saved purpose',
  isEnabled: true,
  selfRegistration: false,
  domainWhitelist: [],
  autoEnrollGroups: [],
  config: { issuer: 'https://identity.example.invalid' },
  secrets: { clientSecret: { action: 'keep' } },
  configuredSecrets: ['clientSecret'],
  accountCount: 2,
  activeAccountCount: 2,
  runtime: { state: 'ready', checkedAt: null, revision: 'v1' }
}
const snapshot = {
  fingerprint: 'review-one',
  host: 'https://wiki.example.invalid',
  providers: [provider],
  definitions: [
    {
      key: 'oidc',
      title: 'OpenID Connect',
      description: 'Identity',
      available: true,
      fields: [
        { key: 'clientSecret', title: 'Client secret', sensitive: true, default: '' },
        { key: 'issuer', title: 'Issuer', sensitive: false, default: '' }
      ]
    }
  ],
  groups: [],
  history: []
}
function arrange(overrides: Record<string, unknown> = {}) {
  const transport = {
    fetchAuthenticationWorkspace: vi.fn().mockResolvedValue(structuredClone(snapshot)),
    saveAuthenticationWorkspace: vi.fn().mockResolvedValue({ sessionsEnded: 0, currentSessionEnded: false, activation: 'applied' }),
    retryAuthenticationInitialization: vi.fn().mockResolvedValue({ sessionsEnded: 0, currentSessionEnded: false, activation: 'applied' }),
    ...overrides
  }
  const window = { confirm: vi.fn().mockReturnValue(true), location: { assign: vi.fn() } },
    bindings = {
      AsyncState: {},
      AuthFields: {},
      authenticationDraft,
      authenticationSignature,
      getErrorMessage: (error: Error) => error.message,
      window,
      ...transport
    }
  const component = new Function(...Object.keys(bindings), compiled + ';return component')(...Object.values(bindings)),
    state = { ...component.data(), $route: { query: {}, hash: '' }, $router: { replace: vi.fn() } }
  for (const [key, method] of Object.entries(component.methods)) state[key] = (method as (...args: unknown[]) => unknown).bind(state)
  for (const [key, getter] of Object.entries(component.computed)) Object.defineProperty(state, key, { get: () => (getter as () => unknown).call(state) })
  return { state, component, transport, window }
}
describe('reviewed authentication workspace', () => {
  it('isolates drafts, normalizes insignificant whitespace and protects navigation', async () => {
    const { state, window } = arrange()
    await state.load()
    state.drafts[0].description = ''
    expect(state.saved.providers[0].description).toBe('Saved purpose')
    expect(state.dirty).toBe(true)
    window.confirm.mockReturnValue(false)
    expect(state.canLeave()).toBe(false)
    state.reset()
    expect(state.dirty).toBe(false)
    state.drafts[0].displayName += ' '
    expect(state.dirty).toBe(false)
  })
  it('reviews a fixed credential snapshot without putting its value in the change description', async () => {
    let release: (value: unknown) => void = () => {}
    const { state, transport, component } = arrange({
      saveAuthenticationWorkspace: vi.fn(
        () =>
          new Promise(resolve => {
            release = resolve
          })
      )
    })
    await state.load()
    state.drafts[0].secrets.clientSecret = { action: 'replace', value: 'private-value' }
    state.review()
    expect(JSON.stringify(state.reviewedChanges)).not.toContain('private-value')
    expect(state.reviewedSessions).toBe(2)
    state.reason = 'Replace the provider credential'
    const pending = state.confirm()
    state.drafts[0].secrets.clientSecret.value = 'changed-behind-review'
    expect(transport.saveAuthenticationWorkspace.mock.calls[0]?.[0][0].secrets.clientSecret.value).toBe('private-value')
    expect(component.beforeRouteUpdate.call(state, { path: '/auth' }, { path: '/auth' })).toBe(false)
    release({ sessionsEnded: 2, currentSessionEnded: false, activation: 'applied' })
    await pending
    expect(state.reviewed).toEqual([])
    expect(state.dirty).toBe(false)
  })
  it('retains drafts and reasons after conflict and requires explicit discard before reloading', async () => {
    const { state, transport, window } = arrange()
    await state.load()
    state.drafts[0].description = 'Draft'
    state.review()
    state.reason = 'Reviewed change'
    transport.saveAuthenticationWorkspace.mockRejectedValue(Object.assign(new Error('Changed'), { status: 409 }))
    await state.confirm()
    await state.confirm()
    expect(transport.saveAuthenticationWorkspace).toHaveBeenCalledOnce()
    expect(state.drafts[0].description).toBe('Draft')
    expect(state.reason).toBe('Reviewed change')
    window.confirm.mockReturnValue(false)
    await state.reloadReview()
    expect(state.reviewing).toBe(true)
    window.confirm.mockReturnValue(true)
    await state.reloadReview()
    expect(state.dirty).toBe(false)
  })
  it('does not repeat a save with an uncertain outcome', async () => {
    const { state, transport } = arrange()
    await state.load()
    state.drafts[0].description = 'Draft'
    state.review()
    state.reason = 'Reviewed change'
    transport.saveAuthenticationWorkspace.mockRejectedValue(new Error('Connection lost'))
    await state.confirm()
    await state.confirm()
    expect(state.saveError).toContain('outcome is unconfirmed')
    expect(transport.saveAuthenticationWorkspace).toHaveBeenCalledOnce()
  })
  it('keeps committed creation and cleared credential inputs coherent if the follow-up read fails', async () => {
    const { state, transport } = arrange()
    await state.load()
    state.addProvider(snapshot.definitions[0])
    expect(state.selected.isEnabled).toBe(false)
    state.selected.description = 'New purpose'
    state.selected.secrets.clientSecret = { action: 'replace', value: 'new-private-value' }
    state.review()
    state.reason = 'Create a provider'
    transport.fetchAuthenticationWorkspace.mockRejectedValue(new Error('Read unavailable'))
    await state.confirm()
    expect(state.notice).toContain('Sign-in policy saved.')
    expect(state.saved.providers).toHaveLength(2)
    expect(state.dirty).toBe(false)
    expect(state.stale).toBe(true)
    expect(state.locked).toBe(true)
    expect(JSON.stringify(state.drafts)).not.toContain('new-private-value')
  })
  it('suppresses stale reads and preserves the latest workspace', async () => {
    let release: (value: unknown) => void = () => {}
    const { state } = arrange({
      fetchAuthenticationWorkspace: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              release = resolve
            })
        )
        .mockResolvedValueOnce({ ...snapshot, fingerprint: 'latest' })
    })
    const pending = state.load()
    await state.load()
    release(snapshot)
    await pending
    expect(state.saved.fingerprint).toBe('latest')
  })
  it('locks initialization while a policy draft exists and distinguishes activation attention', async () => {
    const { state, transport } = arrange()
    await state.load()
    state.drafts[0].description = 'Draft'
    await state.initialize()
    expect(transport.retryAuthenticationInitialization).not.toHaveBeenCalled()
    state.reset()
    transport.retryAuthenticationInitialization.mockResolvedValue({ activation: 'needs-attention' })
    await state.initialize()
    expect(state.attention).toBe(true)
    expect(state.notice).toContain('needs attention')
  })
  it('honors session invalidation, protects provider removal and restores route sections', async () => {
    const { state, component, transport, window } = arrange()
    await state.load()
    state.selectProvider('org')
    state.removeProvider()
    expect(state.drafts).toHaveLength(1)
    state.drafts[0].isEnabled = false
    state.review()
    state.reason = 'Disable the provider'
    transport.saveAuthenticationWorkspace.mockResolvedValue({ sessionsEnded: 2, currentSessionEnded: true, activation: 'applied' })
    await state.confirm()
    expect(window.location.assign).toHaveBeenCalledWith('/login')
    expect(state.canLeave()).toBe(true)
    component.watch['$route.hash'].handler.call(state, '#provider=org&tab=enrollment')
    expect(state.providerSection).toBe('enrollment')
    component.watch['$route.hash'].handler.call(state, '#section=order')
    expect(state.section).toBe('order')
    expect(state.selectedKey).toBe('')
  })
})
