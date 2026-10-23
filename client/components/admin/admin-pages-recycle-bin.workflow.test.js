import fs from 'node:fs'
import { setImmediate as yieldEventLoop } from 'node:timers/promises'
import { parse } from '@vue/compiler-sfc'
import { defineComponent } from 'vue'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import * as recovery from '../../../shared/deleted-page-recovery.ts'
import { waitForPageRender } from '../../helpers/pages-api.ts'
import { pageHref } from '../../helpers/admin-pages.ts'
import { translateEnglish } from '../../test/english-translate.mts'
import { renderTemplate } from '../../test/render-template.mts'

const filename = 'client/components/admin/admin-pages-recycle-bin.vue'
const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  descriptor.script.content.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?$/gm, '').replace('export default', 'return')
)
const options = new Function(
  'translate', 'defineComponent', 'pageHref', 'waitForPageRender',
  'DELETED_PAGE_RECOVERY_PAGE_SIZE', 'DeletedPageRecoveryInspectSchema', 'DeletedPageRecoveryListSchema', 'DeletedPageRecoveryResultSchema', executable
)(translateEnglish, defineComponent, pageHref, waitForPageRender,
  recovery.DELETED_PAGE_RECOVERY_PAGE_SIZE, recovery.DeletedPageRecoveryInspectSchema, recovery.DeletedPageRecoveryListSchema, recovery.DeletedPageRecoveryResultSchema)
const target = { id: 153, sourceRevision: '5', locale: 'en', path: 'restored/visual', visibility: 'private' }
const receipt = { pageId: target.id, sourceRevision: target.sourceRevision, localeCode: target.locale, path: target.path, quarantined: false }
const deleted = { pageId: 153, deletionVersionId: 700, visibility: 'private', restoreMode: 'preserve', ownerResolutionRequired: false }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const list = () => json({ items: [], hasMore: false, nextBeforeVersionId: null })
const originalWindow = globalThis.window
const instances = []
const harness = fetch => {
  globalThis.window = { fetch }
  const instance = { ...options.data(), $t: translateEnglish, inspected: deleted, restorePath: target.path, restoreLocale: target.locale }
  for (const [name, method] of Object.entries(options.methods)) instance[name] = method.bind(instance)
  for (const [name, getter] of Object.entries(options.computed)) Object.defineProperty(instance, name, { get: getter.bind(instance) })
  instances.push(instance)
  return instance
}
const viewLinks = async instance => (await renderTemplate(filename, instance)).document.querySelectorAll('a[href="/_private/en/restored/visual"]')
afterEach(() => {
  for (const instance of instances.splice(0)) options.beforeUnmount.call(instance)
  globalThis.window = originalWindow
})

describe('deleted page recovery render readiness', () => {
  it('keeps the committed private draft unavailable to View until its exact restored revision is ready', async () => {
    let resolvePreview
    const preview = new Promise(resolve => { resolvePreview = resolve })
    const fetch = vi.fn(async url => {
      if (url.endsWith('/restore')) return json(receipt, 201)
      if (url.includes('/deleted?')) return list()
      if (url === '/_api/pages/preview?id=153') return preview
      throw new Error(`Unexpected recovery request: ${url}`)
    })
    const instance = harness(fetch)
    const restoring = instance.restoreSelected()
    await yieldEventLoop()
    expect(instance.restoredPage).toEqual(target)
    expect(instance.renderLoading).toBe(true)
    expect(instance.renderReady).toBe(false)
    expect(await viewLinks(instance)).toHaveLength(0)

    resolvePreview(json(target))
    await restoring
    expect(instance.renderReady).toBe(true)
    expect(instance.renderLoading).toBe(false)
    expect(await viewLinks(instance)).toHaveLength(1)
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
  })

  it('retains the committed restore on a mismatched preview and retries only its exact readiness', async () => {
    let previewCount = 0
    const fetch = vi.fn(async url => {
      if (url.endsWith('/restore')) return json(receipt, 201)
      if (url.includes('/deleted?')) return list()
      if (url === '/_api/pages/preview?id=153') return json(previewCount++ === 0 ? { ...target, sourceRevision: '6' } : target)
      throw new Error(`Unexpected recovery request: ${url}`)
    })
    const instance = harness(fetch)
    await instance.restoreSelected()
    expect(instance.restoredPage).toEqual(target)
    expect(instance.notice).toContain('#153')
    expect(instance.renderError).not.toBe('')
    expect(instance.errorMessage).toBe('')
    expect(await viewLinks(instance)).toHaveLength(0)
    await instance.loadFirstPage()
    expect(instance.restoredPage).toEqual(target)
    await instance.checkRestoredRender()
    expect(instance.renderReady).toBe(true)
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
    expect(await viewLinks(instance)).toHaveLength(1)
  })

  it('waits through native pending responses without restoring again', async () => {
    let previews = 0
    const fetch = vi.fn(async url => {
      if (url.endsWith('/restore')) return json(receipt, 201)
      if (url.includes('/deleted?')) return list()
      if (url === '/_api/pages/preview?id=153') return ++previews === 1
        ? json({ error: 'Current source render pending', code: 'PAGE_RENDER_PENDING' }, 503)
        : json(target)
      throw new Error(`Unexpected recovery request: ${url}`)
    })
    const instance = harness(fetch)
    await instance.restoreSelected()
    expect(previews).toBe(2)
    expect(instance.renderReady).toBe(true)
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
  })

  it('cancels a pending probe on unmount without publishing a late ready link', async () => {
    let resolvePreview
    let previewSignal
    const fetch = vi.fn(async (url, init) => {
      if (url.endsWith('/restore')) return json(receipt, 201)
      if (url.includes('/deleted?')) return list()
      if (url === '/_api/pages/preview?id=153') {
        previewSignal = init.signal
        return new Promise(resolve => { resolvePreview = resolve })
      }
      throw new Error(`Unexpected recovery request: ${url}`)
    })
    const instance = harness(fetch)
    const restoring = instance.restoreSelected()
    await yieldEventLoop()
    options.beforeUnmount.call(instance)
    expect(previewSignal.aborted).toBe(true)
    resolvePreview(json(target))
    await restoring
    expect(instance.renderReady).toBe(false)
  })
})
