import fs from 'node:fs'
import { buildRenderingPlan, formatTitle, rendererTitle, renderingIssues, renderingSettings } from '../../../shared/rendering-policy.ts'
const source = fs.readFileSync('client/components/admin/admin-rendering.vue', 'utf8')
const script = source.match(/<script lang="ts">([\s\S]*?)<\/script>/)[1]
const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .+$/gm, '').replace('export default', 'const component ='))
const dependencies = {
  AsyncState: {},
  buildRenderingPlan,
  formatTitle,
  rendererTitle,
  renderingIssues,
  renderingSettings,
  getErrorMessage: error => error.message,
  buildStoredOutputPreview: () => ''
}
const module = {
  key: 'markdownCore',
  title: 'Markdown',
  isEnabled: true,
  input: 'markdown',
  output: 'html',
  dependsOn: null,
  step: null,
  order: 0,
  description: '',
  icon: '',
  props: { option: { type: 'boolean' } },
  config: { option: false }
}
const snapshot = { modules: [module], fingerprint: 'first', usage: [] }
function arrange(overrides = {}) {
  const transport = {
    fetchRenderingWorkspace: vi.fn().mockResolvedValue(structuredClone(snapshot)),
    saveRenderingWorkspace: vi.fn(),
    fetchRenderingOutput: vi.fn(),
    fetchPageList: vi.fn(),
    renderPage: vi.fn(),
    fetchRenderPageStatus: vi.fn(),
    ...overrides
  }
  const all = { ...dependencies, ...transport }
  const component = new Function(...Object.keys(all), compiled + ';return component')(...Object.values(all))
  const state = { ...component.data(), $route: { query: {}, hash: '' }, $router: { replace: vi.fn() } }
  for (const [key, method] of Object.entries(component.methods)) state[key] = method.bind(state)
  for (const [key, getter] of Object.entries(component.computed)) Object.defineProperty(state, key, { get: () => getter.call(state) })
  return { state, component, transport }
}
describe('rendering workspace draft and asynchronous lifecycle', () => {
  it('keeps saved configuration separate from edits across module selection and resets it deliberately', async () => {
    const { state } = arrange()
    await state.reload()
    state.current.config.option = true
    expect(state.saved.modules[0].config.option).toBe(false)
    expect(state.dirty).toBe(true)
    state.select('markdownCore')
    expect(state.current.config.option).toBe(true)
    state.resetModule()
    expect(state.dirty).toBe(false)
  })
  it('retains a failed save draft and does not replace the saved baseline', async () => {
    const { state, transport } = arrange()
    await state.reload()
    state.current.config.option = true
    state.acknowledged = true
    transport.saveRenderingWorkspace.mockRejectedValue(new Error('Reload changed settings'))
    await state.save()
    expect(state.saveError).toBe('Reload changed settings')
    expect(state.dirty).toBe(true)
    expect(state.saved.fingerprint).toBe('first')
    expect(state.saving).toBe(false)
  })
  it('ignores a late load after unmount', async () => {
    let resolve
    const { state, component } = arrange({ fetchRenderingWorkspace: () => new Promise(done => (resolve = done)) })
    const pending = state.reload()
    component.beforeUnmount.call(state)
    resolve(snapshot)
    await pending
    expect(state.saved).toBeNull()
    expect(state.loadError).toBe('')
  })
  it('ignores stored output arriving after selection is cleared', async () => {
    let resolve
    const { state } = arrange({ fetchRenderingOutput: () => new Promise(done => (resolve = done)) })
    state.pageId = 7
    const pending = state.inspectOutput()
    state.pageId = null
    await state.inspectOutput()
    resolve({ page: { id: 7 }, html: 'late' })
    await pending
    expect(state.output).toBeNull()
    expect(state.outputLoading).toBe(false)
  })
  it('cannot re-render while a settings draft is unsaved', async () => {
    const { state, transport } = arrange()
    await state.reload()
    state.current.config.option = true
    state.output = { page: { id: 7 } }
    await state.rerender()
    expect(transport.renderPage).not.toHaveBeenCalled()
  })

  it('keeps worker completion distinct from an output inspection failure', async () => {
    const { state, transport } = arrange()
    await state.reload()
    state.pageId = 7
    state.output = { page: { id: 7 } }
    transport.renderPage.mockResolvedValue({
      message: 'Page render accepted.',
      effectId: 'effect-7',
      pageId: 7,
      sourceRevision: '3',
      statusUrl: '/_api/system/content/render-page/status/effect-7'
    })
    transport.fetchRenderPageStatus.mockResolvedValue({
      effectId: 'effect-7',
      pageId: 7,
      sourceRevision: '3',
      status: 'succeeded',
      result: {},
      postcondition: {}
    })
    transport.fetchRenderingOutput.mockRejectedValue(new Error('Inspection temporarily unavailable'))
    await state.rerender()
    expect(state.renderFailed).toBe(false)
    expect(state.renderNotice).toContain('The render completed.')
    expect(state.renderNoticeFor).toBe(7)
    expect(state.outputError).toBe('Inspection temporarily unavailable')
    expect(state.output).toBeNull()
    expect(state.rendering).toBe(false)
  })
  it('retains an accepted receipt as unknown on status loss without resubmitting', async () => {
    const { state, transport } = arrange()
    await state.reload()
    state.pageId = 7
    state.output = { page: { id: 7 } }
    const receipt = {
      message: 'Page render accepted.',
      effectId: 'effect-7',
      pageId: 7,
      sourceRevision: '3',
      statusUrl: '/_api/system/content/render-page/status/effect-7'
    }
    transport.renderPage.mockResolvedValue(receipt)
    transport.fetchRenderPageStatus.mockRejectedValue(new Error('offline'))
    await state.rerender()
    expect(transport.renderPage).toHaveBeenCalledTimes(1)
    expect(state.renderReceipt).toEqual(receipt)
    expect(state.renderPending).toBe(true)
    expect(state.renderNotice).toContain('status is unknown')
    expect(state.output).toEqual({ page: { id: 7 } })
  })
})
