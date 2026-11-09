import { compileTemplate, parse } from '@vue/compiler-sfc'
import * as cheerio from 'cheerio'
import pug from 'pug'
import * as ts from 'typescript'
import * as _ from 'lodash-es'
import { afterEach, beforeEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { browserWindow, document, setLocation } from './browser-dom.mts'
import { FeedbackCreateAdmissionSchema, type FeedbackCreateAdmissionInput } from '../../shared/page-feedback.ts'
import { PageBrandingAssignmentSchema } from '../../shared/page-branding.ts'
import { normalizePageFeatures } from '../../shared/page-features.ts'
import { buildOkfMetadataPayload, createPage, type PageWriteInput } from '../helpers/pages-api.ts'
import { getErrorMessage } from '../helpers/root-ui-store.ts'
const previousGlobals = ['siteConfig', 'siteLangs'].flatMap(name => [globalThis, browserWindow].map(target => ({ target, name, descriptor: Object.getOwnPropertyDescriptor(target, name) })))
function installBrowserConfig() {
  for (const target of [globalThis, browserWindow]) {
    Object.defineProperty(target, 'siteConfig', { configurable: true, writable: true, value: { title: 'Editor intent test', lang: 'en', product: { name: 'tsEpistle', version: '0.1.0-test' }, agentCsrfToken: 'editor-intent-test-csrf' } })
    Object.defineProperty(target, 'siteLangs', { configurable: true, writable: true, value: [{ code: 'en', name: 'English' }] })
  }
}
// Match the document bootstrap before the owner-fenced API eagerly loads the root store.
installBrowserConfig()
beforeEach(installBrowserConfig)
// The native runtime DOM must capture the browser harness before Vue/Vuetify evaluation.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const { pinia, wikiStore } = await import('../store/index.ts')
const { governanceApi, captureGovernanceFetch } = await import('../helpers/page-governance-api.ts')
const filename = `${process.cwd()}/client/components/editor.vue`, source = await Bun.file(filename).text(), descriptor = parse(source, { filename }).descriptor
if (!descriptor.script || !descriptor.template) throw new Error('Canonical editor SFC is unavailable')
const syntax = ts.createSourceFile(filename, descriptor.script.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const exported = syntax.statements.find(ts.isExportAssignment)
if (!exported || !ts.isCallExpression(exported.expression) || !ts.isObjectLiteralExpression(exported.expression.arguments[0]!)) throw new Error('Canonical editor options are unavailable')
const options = exported.expression.arguments[0] as ts.ObjectLiteralExpression
const property = (object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike => {
  const value = object.properties.find(entry => entry.name && (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) && entry.name.text === name)
  if (!value) throw new Error(`Canonical editor behavior ${name} is unavailable`)
  return value
}
const objectProperty = (object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralExpression => {
  const value = property(object, name)
  if (!ts.isPropertyAssignment(value) || !ts.isObjectLiteralExpression(value.initializer)) throw new Error(`Canonical editor group ${name} is unavailable`)
  return value.initializer
}
const printer = ts.createPrinter(), print = (node: ts.Node) => printer.printNode(ts.EmitHint.Unspecified, node, syntax)
const methods = objectProperty(options, 'methods'), computed = objectProperty(options, 'computed'), watches = objectProperty(options, 'watch')
const ownerWatch = objectProperty(watches, 'feedbackOwnerKey')
const freeze = syntax.statements.find(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'freezePageInput'))
if (!freeze) throw new Error('Canonical source snapshot freezer is unavailable')
// Exercise the real owner methods and unchanged owner invocation without mounting unrelated collaboration/PWA coordinators.
// No production exports, fake board admission, alternate source editor or source-creation implementation is added.
const selectedScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${print(freeze)}\nconst behavior = { computed: { ${print(property(computed, 'feedbackOwnerKey'))} }, watch: { feedbackOwnerKey: { flush: 'sync', ${print(property(ownerWatch, 'handler'))} } }, methods: { ${['loadFeedbackIntent','cancelFeedbackIntent','getPageInput'].map(name => print(property(methods, name))).join(',')} } };`)
const behavior = new Function('wikiStore','FeedbackCreateAdmissionSchema','governanceApi','getErrorMessage','buildOkfMetadataPayload','PageBrandingAssignmentSchema','normalizePageFeatures','_', `${selectedScript}\nreturn behavior;`)(wikiStore,FeedbackCreateAdmissionSchema,governanceApi,getErrorMessage,buildOkfMetadataPayload,PageBrandingAssignmentSchema,normalizePageFeatures,_)
const markup = cheerio.load(pug.render(descriptor.template.content, { doctype: 'html' }), { xml: true }), invocation = markup('.editor-feedback-intent')
if (invocation.length !== 1) throw new Error('Canonical editor feedback owner invocation is missing or ambiguous')
const compiled = compileTemplate({ source: invocation.toString(), filename, id: 'canonical-feedback-intent', compilerOptions: { mode: 'function' } })
if (compiled.errors.length) throw compiled.errors[0]
const render = new Function('Vue', compiled.code)(Vue)
interface IntentOwner { feedbackRequested: boolean; feedbackIntent: FeedbackCreateAdmissionInput | null; feedbackBoardName: string; feedbackAcknowledged: boolean; loadFeedbackIntent(): Promise<void>; cancelFeedbackIntent(): void; getPageInput(content?: string): PageWriteInput }
const boardId = '11111111-1111-4111-8111-111111111111', previousFetch = browserWindow.fetch
const saved = { user: { ...wikiStore.user }, page: { ...wikiStore.page }, editor: { ...wikiStore.editor }, authRefreshSettled: wikiStore.authRefreshSettled, authRefreshPending: wikiStore.authRefreshPending, authRefreshOutcome: wikiStore.authRefreshOutcome, offlineIdentityEpoch: wikiStore.offlineIdentityEpoch }
const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  browserWindow.fetch = previousFetch
  Object.assign(wikiStore.user,saved.user)
  Object.assign(wikiStore.page,saved.page)
  Object.assign(wikiStore.editor,saved.editor)
  Object.assign(wikiStore, { authRefreshSettled: saved.authRefreshSettled, authRefreshPending: saved.authRefreshPending, authRefreshOutcome: saved.authRefreshOutcome, offlineIdentityEpoch: saved.offlineIdentityEpoch })
  for (const { target, name, descriptor } of previousGlobals) {
    if (descriptor) Object.defineProperty(target, name, descriptor)
    else Reflect.deleteProperty(target, name)
  }
  setLocation('/')
})
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const board = { id: boardId, boardPageId: 7, name: 'Current authorized board', boardRevision: '2', enabled: true, canManage: false, canSubmit: true, categories: [] }
async function settle() { for (let count=0; count<12; count++) { await Promise.resolve(); await Vue.nextTick() } }
async function mount(transport: (url: string, init?: RequestInit) => Promise<Response>) {
  setLocation(`/e/en/ideas/new?feedbackBoard=${boardId}&feedbackBoardRevision=2`)
  Object.assign(wikiStore.user, { id: 5, authVersion: 4, authenticated: true })
  Object.assign(wikiStore, { authRefreshSettled: true, authRefreshPending: false, authRefreshOutcome: 'authenticated' })
  Object.assign(wikiStore.page, { id: 0, locale: 'en', path: 'ideas/new', visibility: 'public', title: 'Full canonical proposal', description: 'Native full editor document', isPublished: false, isSearchable: true, publishStartDate: '', publishEndDate: '', scriptCss: '', scriptJs: '', tags: ['retained'], brandingAssignment: null, pageFeatures: normalizePageFeatures(undefined) })
  Object.assign(wikiStore.editor, { mode: 'create', editorKey: 'markdown', content: '# Complete canonical source\n\nNot a bodyless proposal.' })
  const fetch = vi.fn(transport); browserWindow.fetch = (input, init) => fetch(String(input), init)
  const host = document.createElement('div'); document.body.append(host)
  const component = Vue.defineComponent({ ...behavior, render, data() { return { mode: 'create', editorInstanceKey: 0, isSaving: false, changeReason: '', savedState: { brandingAssignment: null }, feedbackRequested: true, feedbackIntent: null, feedbackIntentOwner: '', feedbackIntentGeneration: 0, feedbackBoardName: '', feedbackAcknowledged: false, feedbackIntentLoading: false, feedbackIntentError: '' } } })
  const app = Vue.createApp(component); app.use(pinia); app.use(createVuetify({ components: vuetifyComponents })); const owner = app.mount(host) as unknown as IntentOwner
  cleanups.push(() => { app.unmount(); host.remove() })
  const load = owner.loadFeedbackIntent(); await settle()
  return { host, owner, fetch, load }
}
describe('mounted canonical editor board intent', () => {
  it('requires current explicit attachment consent and sends the entire canonical source through native Create, not an alternate bodyless source', async () => {
    const view = await mount(async (url, init) => {
      if (url === '/_api/pages') {
        expect(new Headers(init?.headers).get('X-Wiki-Governance-Owner')).toBe('5:4')
        const body = JSON.parse(String(init?.body))
        expect(body.content).toBe('# Complete canonical source\n\nNot a bodyless proposal.')
        expect(body.tags).toEqual(['retained'])
        expect(body.feedbackSubmission).toEqual({ boardId, expectedBoardRevision: '2', acknowledged: true })
        return json({ error: 'Canonical create admission rolled back', code: 'FEEDBACK_STALE' },409)
      }
      return json(board)
    })
    await view.load
    expect(view.host.textContent).toContain('Current authorized board')
    expect(() => view.owner.getPageInput()).toThrow('explicit attachment consent')
    const consent = view.host.querySelector<HTMLInputElement>('input[type=checkbox]')!; consent.focus(); expect(document.activeElement).toBe(consent); consent.click(); await settle()
    const payload = view.owner.getPageInput(); expect(Object.isFrozen(payload.feedbackSubmission)).toBe(true)
    await expect(createPage(captureGovernanceFetch(browserWindow.fetch.bind(browserWindow)),payload)).rejects.toThrow('Canonical create admission rolled back')
    expect(wikiStore.editor.content).toContain('Complete canonical source')
    expect(wikiStore.page.id).toBe(0)
    expect(view.fetch.mock.calls.filter(([,init]) => init?.method === 'POST')).toHaveLength(1)
  })
  it('retires late old-account board admission and never reuses an earlier document acknowledgement', async () => {
    const delayed = Promise.withResolvers<Response>()
    const view = await mount(async () => delayed.promise)
    Object.assign(wikiStore.user,{ id: 6, authVersion: 1 }); await settle()
    delayed.resolve(json(board)); await view.load; await settle()
    expect(view.host.textContent).not.toContain('Current authorized board')
    expect(view.owner.feedbackIntent).toBeNull()
    expect(() => view.owner.getPageInput()).toThrow('current board/document review')
    browserWindow.fetch = async () => json(board)
    await view.owner.loadFeedbackIntent(); await settle()
    view.host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(); await settle()
    expect(view.owner.getPageInput().feedbackSubmission?.boardId).toBe(boardId)
    wikiStore.page.path = 'other/current-document'; await settle()
    expect(view.owner.feedbackAcknowledged).toBe(false)
    expect(view.owner.feedbackIntent).toBeNull()
    expect(() => view.owner.getPageInput()).toThrow('current board/document review')
    expect(wikiStore.editor.content).toContain('Complete canonical source')
  })
  it('allows only a deliberate native creation-without-membership cutover and preserves source when board admission fails', async () => {
    const view = await mount(async () => json({ error: 'Board unavailable', code: 'NOT_FOUND' },404)); await view.load
    expect(() => view.owner.getPageInput()).toThrow('current board/document review')
    view.owner.cancelFeedbackIntent(); await settle()
    expect(browserWindow.location.search).toBe('')
    const input = view.owner.getPageInput()
    expect(input.feedbackSubmission).toBeUndefined()
    expect(input.content).toContain('Complete canonical source')
    expect(input.path).toBe('ideas/new')
    expect(view.fetch.mock.calls.filter(([,init]) => init?.method === 'POST')).toHaveLength(0)
  })
})
