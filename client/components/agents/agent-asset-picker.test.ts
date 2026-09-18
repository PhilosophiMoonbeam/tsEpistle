import fs from 'node:fs'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'
import { describe, expect, it } from '../../../server/test/bun-test.mts'
import { fetchAssets, fetchAssetFolders } from '../../helpers/assets-api.ts'
import { validateAgentAttachment } from '../../helpers/agent-media.ts'
const source = fs.readFileSync(new URL('./agent-asset-picker.vue', import.meta.url), 'utf8')
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
if (!script) throw new Error('Asset picker script missing')
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, ''))
const evaluate = new Function(
  'dependencies',
  `const { computed, onBeforeUnmount, ref, useTemplateRef, watch, defineProps, defineEmits, fetchAssets, fetchAssetFolders, validateAgentAttachment, window } = dependencies; ${executable}; return { trail, assets, folders, visibleAssets, query, loading, error, openFolder, navigate, select, close, load, unavailable }`
)
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const asset = (id: number, ext = '.png', size = 40) => ({
  id,
  ext,
  filename: `file-${id}${ext}`,
  fileSize: size,
  kind: ext === '.pdf' ? 'binary' : 'image',
  createdAt: '2026-09-18T00:00:00Z'
})
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0))
}
const mount = (fetcher: typeof fetch) => {
  const props = reactive({ imageOnly: false, busy: false, disabled: false, attachmentError: '' })
  const events: [string, unknown][] = []
  const cleanup: (() => void)[] = []
  const scope = effectScope()
  const api = scope.run(() =>
    evaluate({
      computed,
      ref,
      watch,
      useTemplateRef: () => ref(null),
      onBeforeUnmount: (fn: () => void) => cleanup.push(fn),
      defineProps: () => props,
      defineEmits: () => (event: string, value: unknown) => events.push([event, value]),
      fetchAssets,
      fetchAssetFolders,
      validateAgentAttachment,
      window: { fetch: fetcher }
    })
  )
  return {
    api,
    props,
    events,
    unmount: () => {
      cleanup.forEach(fn => {
        fn()
      })
      scope.stop()
    }
  }
}
describe('Agent Wiki asset picker', () => {
  it('browses folders, searches supported files, and disables PDFs for image mode', async () => {
    const paths: string[] = []
    const harness = mount(async (input, init) => {
      paths.push(String(input))
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return response(
        String(input).includes('/folders?')
          ? [{ id: 7, name: 'Design', slug: 'design' }]
          : [asset(1), asset(2, '.pdf'), asset(3, '.svg'), asset(4, '.jpg', 11 * 1024 * 1024)]
      )
    })
    await settle()
    expect(harness.api.visibleAssets.value.map((item: { id: number }) => item.id)).toEqual([1, 2, 4])
    harness.props.imageOnly = true
    expect(harness.api.unavailable(asset(2, '.pdf'))).toContain('Images only')
    expect(harness.api.unavailable(asset(4, '.jpg', 11 * 1024 * 1024))).toContain('10 MB')
    harness.api.select(asset(2, '.pdf'))
    expect(harness.events).toHaveLength(0)
    harness.api.select(asset(1))
    expect(harness.events[0]).toEqual(['select', asset(1)])
    harness.api.query.value = 'FILE-1'
    expect(harness.api.visibleAssets.value).toHaveLength(1)
    harness.api.openFolder({ id: 7, name: 'Design', slug: 'design' })
    await settle()
    expect(paths).toContain('/_api/assets?folderId=7&kind=ALL')
    expect(harness.api.query.value).toBe('')
    harness.api.navigate(-1)
    await settle()
    expect(harness.api.trail.value).toEqual([])
    harness.unmount()
  })
  it('discards stale folder results and aborts pending loads on close', async () => {
    let finish!: (value: Response) => void
    let staleSignal: AbortSignal | null | undefined
    const harness = mount(async (input, init) => {
      if (String(input).includes('/folders?')) return response([])
      if (String(input).includes('folderId=0')) {
        staleSignal = init?.signal
        return new Promise(resolve => {
          finish = resolve
        })
      }
      return response([asset(7)])
    })
    harness.api.openFolder({ id: 7, name: 'Design', slug: 'design' })
    await settle()
    expect(staleSignal?.aborted).toBe(true)
    finish(response([asset(1)]))
    await settle()
    expect(harness.api.assets.value.map((item: { id: number }) => item.id)).toEqual([7])
    harness.api.close()
    expect(harness.events).toContainEqual(['close', undefined])
    harness.unmount()
  })
  it('shows a fixed no-access message without disclosing API error details and supports retry', async () => {
    let allowed = false
    const harness = mount(async () => (allowed ? response([]) : response({ error: 'private folder path or server detail' }, 403)))
    await settle()
    expect(harness.api.error.value).toContain('don’t have access')
    expect(harness.api.error.value).not.toContain('private folder')
    expect(harness.api.assets.value).toEqual([])
    allowed = true
    await harness.api.load()
    expect(harness.api.error.value).toBe('')
    expect(harness.api.loading.value).toBe(false)
    harness.props.disabled = true
    await nextTick()
    expect(harness.events).toContainEqual(['close', undefined])
    harness.unmount()
  })
})
