import fs from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import * as ts from 'typescript'
import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { WEBHOOK_EVENTS, isWebhookEventName } from '../../../shared/webhook-events.ts'
import * as webhooksApi from '../../helpers/webhooks-api.ts'
const componentPath = 'client/components/admin/admin-webhooks.vue'
const parsed = parse(fs.readFileSync(componentPath, 'utf8'), { filename: componentPath })
if (parsed.errors.length || !parsed.descriptor.script || parsed.descriptor.scriptSetup) {
  throw new Error(`Could not read the ordinary script from ${componentPath}.`)
}
const executable = ts.transpileModule(parsed.descriptor.script.content, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText
const hook = { id: 'one', name: 'Knowledge sync', url: 'https://example.test/hook', events: ['page.updated'], isEnabled: true }
function harness({ fetchImpl = () => {}, transport = {} } = {}) {
  const update = vi.fn(async () => {})
  const sendTest = vi.fn(async () => 'test-one')
  const fetchHooks = vi.fn(async () => [hook])
  const dependencies = {
    './admin-webhook-guide.vue': { default: {} },
    '../../../shared/webhook-events.ts': { WEBHOOK_EVENTS, isWebhookEventName },
    '@/store/index.ts': { wikiStore: { showError() {}, showNotification() {} } },
    '../../helpers/webhooks-api': {
      ...webhooksApi,
      updateWebhook: update,
      sendWebhookTest: sendTest,
      fetchWebhooks: fetchHooks,
      fetchWebhookDeliveries: vi.fn(async () => []),
      ...transport
    }
  }
  const requireDependency = name => {
    if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected component dependency: ${name}`)
    return dependencies[name]
  }
  const options = new Function('require', 'exports', 'window', executable + ';return exports.default')(
    requireDependency,
    {},
    { location: { hash: '', href: 'https://example.test/a/webhooks' }, history: { replaceState() {} }, fetch: fetchImpl }
  )
  const instance = { ...options.data(), $nextTick: vi.fn(), $refs: {} }
  for (const [key, fn] of Object.entries(options.methods)) instance[key] = fn.bind(instance)
  for (const [key, fn] of Object.entries(options.computed)) Object.defineProperty(instance, key, { get: fn.bind(instance) })
  instance.hooks = [hook]
  instance.selectHookNow(hook)
  return { instance, options, update, sendTest, fetchHooks }
}
describe('webhook administration workflow', () => {
  it('protects changes when switching endpoints or leaving the route', async () => {
    const { instance, options } = harness()
    expect(instance.dirty).toBe(false)
    instance.draft.name = 'Changed'
    instance.newHook()
    expect(instance.draft.id).toBe('one')
    instance.finishChange(false)
    expect(instance.draft.name).toBe('Changed')
    const leaving = options.beforeRouteLeave.call(instance)
    instance.finishChange(false)
    expect(await leaving).toBe(false)
    instance.resetDraft()
    expect(instance.dirty).toBe(false)
    expect(instance.draft.name).toBe(hook.name)
  })
  it('preserves a failed save and the saved endpoint baseline', async () => {
    const { instance, update, fetchHooks } = harness()
    instance.draft.name = 'Changed'
    update.mockRejectedValueOnce(new Error('Connection failed'))
    await instance.save()
    expect(instance.dirty).toBe(true)
    expect(instance.operationError).toBe('Connection failed')
    expect(instance.savedHook.name).toBe(hook.name)
    expect(fetchHooks).not.toHaveBeenCalled()
    expect(instance.webhookBusy).toBe(false)
  })
  it('saves endpoint edits through the webhook API and clears unsaved changes', async () => {
    const saved = {
      ...hook,
      name: 'Documentation sync',
      url: 'https://receiver.example.test/wiki',
      events: ['page.updated', 'page.deleted'],
      isEnabled: false
    }
    const fetchImpl = vi.fn(async (path, init = {}) => {
      if (path === '/_api/webhooks/one' && init.method === 'PUT') return new Response(null, { status: 204 })
      if (path === '/_api/webhooks' && !init.method) return Response.json([saved])
      throw new Error(`Unexpected request: ${init.method || 'GET'} ${path}`)
    })
    const { instance, options } = harness({
      fetchImpl,
      transport: { updateWebhook: webhooksApi.updateWebhook, fetchWebhooks: webhooksApi.fetchWebhooks }
    })
    instance.draft.name = saved.name
    instance.draft.url = saved.url
    instance.draft.isEnabled = saved.isEnabled
    instance.eventsText = saved.events.join('\n')
    await instance.save()
    expect(fetchImpl).toHaveBeenCalledWith(
      '/_api/webhooks/one',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          name: 'Documentation sync',
          url: 'https://receiver.example.test/wiki',
          events: ['page.updated', 'page.deleted'],
          isEnabled: false
        })
      })
    )
    expect(instance.savedHook).toMatchObject(saved)
    expect(instance.dirty).toBe(false)
    expect(instance.operationError).toBe('')
    expect(instance.webhookBusy).toBe(false)
    expect(await options.beforeRouteLeave.call(instance)).toBe(true)
  })
  it('protects a revealed secret even after a clean save', async () => {
    const { instance, options } = harness()
    instance.revealedSecret = 'one-time-fixture'
    const leaving = options.beforeRouteLeave.call(instance)
    instance.finishChange(false)
    expect(await leaving).toBe(false)
    expect(instance.revealedSecret).toBe('one-time-fixture')
  })
  it('gates test sends on saved, enabled settings and then exposes queue identity', async () => {
    const { instance, sendTest } = harness()
    instance.draft.name = 'Unsaved'
    await instance.sendTest()
    expect(sendTest).not.toHaveBeenCalled()
    instance.resetDraft()
    await instance.sendTest()
    expect(sendTest).toHaveBeenCalledTimes(1)
    expect(instance.testMessage).toContain('test-one')
    expect(instance.webhookBusy).toBe(false)

    const disabled = harness()
    const disabledHook = { ...hook, isEnabled: false }
    disabled.instance.hooks = [disabledHook]
    disabled.instance.selectHookNow(disabledHook)
    expect(disabled.instance.dirty).toBe(false)
    await disabled.instance.sendTest()
    expect(disabled.sendTest).not.toHaveBeenCalled()
    expect(disabled.instance.testMessage).toBe('')
  })
  it('supports actual hyphenated events and does not silently drop custom subscriptions', () => {
    const { instance } = harness()
    instance.eventsText = 'custom.event\npage.updated'
    instance.toggleEvent('page.visibility-changed')
    expect(instance.subscribedEvents).toEqual(['custom.event', 'page.updated', 'page.visibility-changed'])
    expect(instance.isWebhookValid).toBe(true)
    instance.eventsText = 'page.*'
    expect(instance.isWebhookValid).toBe(false)
  })
})
