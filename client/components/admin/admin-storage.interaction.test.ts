import fs from 'node:fs'
import path from 'node:path'
import { compileScript, parse } from '@vue/compiler-sfc'
import i18next from 'i18next'
import { afterEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import { browserWindow, document, resetBody, setLocation } from '../../test/browser-dom.mts'
import { translate as unavailableTranslation } from '../../modules/localization.ts'
import type { StorageOperationView, StorageWorkspace } from '../../../shared/storage-workspace.ts'

resetBody()
// These imports intentionally follow browser DOM setup: Vue/Vuetify capture
// platform globals during module loading, which is part of this mounted test.
const Vue = await import('vue')
const { createRouter, createMemoryHistory, RouterView } = await import('vue-router')
const { createVuetify } = await import('vuetify')
const components = await import('vuetify/components')
const directives = await import('vuetify/directives')

// Exercise the actual private setup, template, receipt child and HTTP helpers.
// Only styles and the unrelated admin hero chrome are omitted in this DOM test.
Bun.plugin({
  name: 'storage-workspace-interaction-sfc',
  setup(builder) {
    builder.onResolve({ filter: /^@\/components\/common\/async-state\.vue$/ }, () => ({
      path: path.join(process.cwd(), 'client/components/common/async-state.vue')
    }))
    builder.onLoad({ filter: /\/(admin-storage|storage-operation-receipt|async-state)\.vue$/ }, async ({ path: filename }) => {
      const parsed = parse(await Bun.file(filename).text(), { filename })
      if (parsed.errors.length) throw parsed.errors[0]
      const compiled = compileScript(parsed.descriptor, {
        id: `storage-interaction-${path.basename(filename, '.vue')}`,
        genDefaultAs: '__component',
        inlineTemplate: true
      })
      return { loader: 'ts', contents: `${compiled.content}\nexport default __component;` }
    })
    builder.onLoad({ filter: /\/storage-workspace\.scss$/ }, () => ({ loader: 'js', contents: 'export {}' }))
  }
})
// Static SFC imports run before the test loader is registered, so this test
// intentionally exercises the module-loading boundary after registration.
const StorageWorkspaceComponent = (await import('./admin-storage.vue')).default

const french = i18next.createInstance()
const english = JSON.parse(fs.readFileSync('server/locales/en.json', 'utf8'))
await french.init({
  lng: 'fr',
  fallbackLng: 'en',
  defaultNS: 'common',
  ns: ['common', 'admin'],
  initAsync: false,
  resources: {
    en: english,
    fr: {
      admin: {
        storage: {
          applySavedSettings: 'Appliquer les réglages enregistrés',
          applySavedStorageSettings: 'Appliquer les réglages de stockage enregistrés',
          stopPreviousTargetsInitialize: 'Arrêter les anciennes destinations et initialiser les destinations enregistrées.',
          applyStorageSettings: 'APPLIQUER LES RÉGLAGES DE STOCKAGE',
          cancelOperation: 'ANNULER L’OPÉRATION',
          priorWorkerStopped: 'LE PROCESSUS PRÉCÉDENT EST ARRÊTÉ',
          type: 'Saisissez {{confirmation}}',
          administrativeReason: 'Motif administratif',
          recordIntentSoAnother: 'Indiquez votre intention pour le prochain administrateur.',
          queueOperation: 'Planifier l’opération',
          cancelBeforeExecution: 'Annuler avant exécution',
          resolveUncertainOperation: 'Résoudre l’opération incertaine',
          cancelOperation2: 'Annuler l’opération',
          resolveOperation: 'Résoudre l’opération',
          resolvingRecordDoesNot: 'Cette décision ne restaure aucun contenu et ne relance pas le processus.'
        },
        storageOperationReceipt: {
          cancelBeforeExecution: 'Annuler avant exécution',
          reviewRecoveryDecision: 'Examiner la décision de récupération',
          cancellation: 'Annulation',
          recoveryDecision: 'Décision de récupération'
        }
      }
    }
  }
})
const frenchTranslation = (key: string, options: Record<string, unknown> = {}) => {
  const [ns, ...segments] = key.split(':')
  return french.t(segments.join(':'), { ns, ...options })
}

type Action = 'activate' | 'cancel' | 'resolve'
type Localization = 'French' | 'unavailable'
const timestamp = '2026-09-15T12:00:00.000Z'
const operationId = '00000000-0000-4000-8000-000000000091'
const fingerprint = 'storage-review-fixture'
const contracts = {
  activate: { token: 'APPLY STORAGE SETTINGS', translationKey: 'admin:storage.applyStorageSettings', endpoint: '/_api/storage/operations' },
  cancel: { token: 'CANCEL OPERATION', translationKey: 'admin:storage.cancelOperation', endpoint: `/_api/storage/operations/${operationId}/cancel` },
  resolve: { token: 'PRIOR WORKER STOPPED', translationKey: 'admin:storage.priorWorkerStopped', endpoint: `/_api/storage/operations/${operationId}/resolve` }
} as const
const operation = (state: StorageOperationView['state']): StorageOperationView => ({
  id: operationId,
  jobId: '00000000-0000-4000-8000-000000000092',
  targetKey: null,
  handler: 'activate',
  title: 'Apply saved storage settings',
  effect: 'Initialiser les destinations enregistrées sans restaurer la base de données.',
  state,
  actorId: 7,
  reason: 'Previously reviewed activation',
  configurationRevision: 'saved-revision',
  createdAt: timestamp,
  startedAt: state === 'queued' ? null : timestamp,
  completedAt: null,
  result: null,
  resolution: null,
  canCancel: state === 'queued',
  canResolve: state === 'interrupted'
})
const workspace = (operations: StorageOperationView[]): StorageWorkspace => ({
  fingerprint,
  revision: 'saved-revision',
  observedAt: timestamp,
  offline: false,
  history: [],
  operations,
  targets: [{
    key: 'disk', title: 'Local export', description: 'Saved local destination', isAvailable: true,
    isEnabled: true, mode: 'push', modes: ['push'], defaultMode: 'push', schedule: false,
    internalSchedule: false, syncInterval: 'P0D', config: { path: '/fixture-only/export' },
    secrets: {}, fields: [], actions: [], issues: []
  }],
  runtime: [{ key: 'disk', state: 'pending', active: false, matchesSaved: false, lastAttempt: null, lastOutcome: 'pending' }]
})

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  resetBody()
})
const settle = async (ready: () => boolean, description: string) => {
  for (let turn = 0; turn < 100; turn++) {
    await Vue.nextTick()
    if (ready()) return
    await new Promise<void>(resolve => browserWindow.requestAnimationFrame(() => resolve()))
  }
  throw new Error(`Storage interaction did not settle: ${description}`)
}
const button = (root: ParentNode, text: string): HTMLButtonElement => {
  const result = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent?.trim() === text)
  if (!result) throw new Error(`Storage action is missing: ${text}`)
  return result
}
const input = async (control: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  control.value = value
  control.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
  await Vue.nextTick()
}

const mountStorage = async (localization: Localization, action: Action, existingState?: StorageOperationView['state']) => {
  setLocation('/a/storage')
  const snapshot = workspace(existingState ? [operation(existingState)] : action === 'activate' ? [] : [operation(action === 'cancel' ? 'queued' : 'interrupted')])
  const originalConfiguration = structuredClone(snapshot.targets)
  const writes: Array<{ pathname: string; method: string; credentials?: RequestCredentials; body: Record<string, unknown> }> = []
  const previousFetch = Object.getOwnPropertyDescriptor(browserWindow, 'fetch')
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  Object.defineProperty(browserWindow, 'fetch', {
    configurable: true,
    writable: true,
    value: async (url: string, init: RequestInit) => {
      const pathname = new URL(url, browserWindow.location.href).pathname
      if (init.method === 'GET' && pathname === '/_api/storage/workspace') return response(snapshot)
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      writes.push({ pathname, method: init.method!, credentials: init.credentials, body })
      // Independently enforced server contract: invalid tokens never receive a receipt.
      // No maintained configuration or external provider is reached by this fixture.
      if (init.method !== 'POST' || pathname !== contracts[action].endpoint) throw new Error(`Unexpected storage mutation: ${init.method} ${pathname}`)
      if (body.confirmation !== contracts[action].token) return response({ error: 'Enter the exact action confirmation.' }, 400)
      if (action === 'activate') {
        snapshot.operations = [{ ...operation('queued'), reason: String(body.reason) }]
        return response({ id: operationId, jobId: snapshot.operations[0]!.jobId })
      }
      const recorded = snapshot.operations[0]!
      if (action === 'cancel' ? !recorded.canCancel : !recorded.canResolve) return response({ error: 'The worker state does not permit this decision.' }, 409)
      snapshot.operations = [{
        ...recorded, state: action === 'cancel' ? 'cancelled' : 'resolved', completedAt: timestamp,
        resolution: { actorId: 7, reason: String(body.reason), createdAt: timestamp }, canCancel: false, canResolve: false
      }]
      return response({ id: operationId, state: snapshot.operations[0]!.state })
    }
  })
  const t = localization === 'French' ? frenchTranslation : unavailableTranslation
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/a/storage', component: StorageWorkspaceComponent }] })
  const app = Vue.createApp({ render: () => Vue.h(RouterView) })
  app.use(router)
  app.use(createVuetify({ components, directives }))
  app.config.globalProperties.$t = t
  app.component('admin-hero', Vue.defineComponent({
    setup: (_props, { slots }) => () => Vue.h('header', [slots.default?.(), slots.actions?.()])
  }))
  const host = document.createElement('div')
  document.body.append(host)
  let mounted = false
  cleanups.push(() => {
    if (mounted) app.unmount()
    host.remove()
    if (previousFetch) Object.defineProperty(browserWindow, 'fetch', previousFetch)
    else Reflect.deleteProperty(browserWindow, 'fetch')
  })
  await router.push({ path: '/a/storage', query: action === 'activate' ? {} : { section: 'operations', operation: operationId } })
  await router.isReady()
  mounted = true
  app.mount(host)
  await settle(() => Boolean(host.querySelector('.storage-tabs')), 'initial workspace read')
  return { host, router, t, writes, snapshot, originalConfiguration }
}

describe('canonical storage confirmations in the mounted localized workspace', () => {
  for (const localization of ['French', 'unavailable'] as const) {
    for (const action of ['activate', 'cancel', 'resolve'] as const) {
      it(`${localization} localization displays and authorizes ${action} with its server token and reaches the receipt`, async () => {
        const { host, router, t, writes, snapshot, originalConfiguration } = await mountStorage(localization, action)
        const entryKey = action === 'activate' ? 'admin:storage.applySavedSettings' : action === 'cancel'
          ? 'admin:storageOperationReceipt.cancelBeforeExecution' : 'admin:storageOperationReceipt.reviewRecoveryDecision'
        const entry = button(host, t(entryKey))
        expect(entry.disabled).toBe(false)
        entry.click()
        await settle(() => Boolean(document.querySelector('.v-overlay--active .storage-dialog')), 'review dialog')
        const dialog = document.querySelector<HTMLElement>('.v-overlay--active .storage-dialog')!
        const token = contracts[action].token
        const instruction = localization === 'French' ? `Saisissez ${token}` : `Type ${token}`
        expect(dialog.textContent).toContain(instruction)
        const reason = dialog.querySelector<HTMLTextAreaElement>('textarea')!
        const confirmation = dialog.querySelector<HTMLInputElement>('input')!
        expect(reason).not.toBeNull()
        expect(confirmation).not.toBeNull()
        expect(dialog.textContent).toContain(t('admin:storage.administrativeReason'))
        if (action === 'activate') expect(dialog.textContent).toContain(t('admin:storage.stopPreviousTargetsInitialize'))
        if (action === 'resolve') expect(dialog.textContent).toContain(t('admin:storage.resolvingRecordDoesNot'))
        const submitKey = action === 'cancel' ? 'admin:storage.cancelOperation2' : action === 'resolve' ? 'admin:storage.resolveOperation' : 'admin:storage.queueOperation'
        const submit = button(dialog, t(submitKey))
        const administrativeReason = 'Verified destinations and prior worker state'
        await input(confirmation, token)
        expect(submit.disabled).toBe(true)
        await input(reason, `  ${administrativeReason}  `)
        expect(submit.disabled).toBe(false)
        // A translated phrase (or fallback title-cased label) is not authorization.
        await input(confirmation, t(contracts[action].translationKey))
        expect(submit.disabled).toBe(true)
        submit.click()
        await Vue.nextTick()
        expect(writes).toHaveLength(0)
        await input(confirmation, `${token} `)
        expect(submit.disabled).toBe(true)
        await input(confirmation, token)
        expect(submit.disabled).toBe(false)
        submit.click()
        await settle(() => {
          const receipt = host.querySelector('.storage-receipt')
          return !document.querySelector('.v-overlay--active .storage-dialog') && Boolean(receipt?.textContent?.includes(action === 'activate' ? 'Queued' : action === 'cancel' ? 'Cancelled' : 'Recovery acknowledged'))
        }, 'recorded operation or decision receipt')
        expect(writes).toEqual([{
          pathname: contracts[action].endpoint, method: 'POST', credentials: 'same-origin',
          body: {
            ...(action === 'activate' ? { targetKey: null, handler: 'activate' } : {}),
            fingerprint, reason: administrativeReason, confirmation: token
          }
        }])
        expect(router.currentRoute.value.query).toMatchObject({ section: 'operations', operation: operationId })
        const receipt = host.querySelector('.storage-receipt')!
        expect(receipt.textContent).toContain('Apply saved storage settings')
        if (action === 'activate') expect(receipt.textContent).toContain(administrativeReason)
        else {
          expect(receipt.querySelector('.storage-resolution')?.textContent).toContain(administrativeReason)
          expect(receipt.querySelector('.storage-resolution h4')?.textContent).toBe(t(action === 'cancel' ? 'admin:storageOperationReceipt.cancellation' : 'admin:storageOperationReceipt.recoveryDecision'))
          expect(receipt.querySelector('.storage-receipt-actions button')).toBeNull()
        }
        expect(snapshot.targets).toEqual(originalConfiguration)
        expect(snapshot.revision).toBe('saved-revision')
        expect(snapshot.history).toEqual([])
      })
    }
  }

  it('does not offer cancellation or stopped-worker recovery while the worker is running', async () => {
    const { host, t, writes } = await mountStorage('French', 'resolve', 'running')
    const actions = host.querySelector('.storage-receipt-actions')!
    expect(actions).not.toBeNull()
    expect(actions.textContent).not.toContain(t('admin:storageOperationReceipt.cancelBeforeExecution'))
    expect(actions.textContent).not.toContain(t('admin:storageOperationReceipt.reviewRecoveryDecision'))
    expect(actions.querySelector('button')).toBeNull()
    expect(writes).toHaveLength(0)
  })
})
