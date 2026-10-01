import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, it } from '../../../server/test/bun-test.mts'
import { siteBannerState, type SiteBannerConfig } from '../../../shared/site-banner.ts'
const source = parse(readFileSync(new URL('./site-banner.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content.replace(/^import .*$/gm, '')
const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source + '\nreturn { isVisible, refreshTime }')
const build = (banner: SiteBannerConfig, preview = false) => {
  let now = Date.parse('2026-09-07T10:00:00Z'), mount = () => {}, unmount = () => {}
  const timers = new Map<number, { fn: () => void; delay: number }>(), listeners = new Map<string, () => void>()
  let nextId = 0
  const view = new Function('defineProps', 'computed', 'ref', 'watch', 'useId', 'onMounted', 'onBeforeUnmount', 'siteBannerState', 'renderSafeMarkdown', 'Date', 'window', 'document', code)(
    () => ({ banner, preview }), (fn: () => unknown) => ({ get value() { return fn() } }), (value: unknown) => ({ value }), () => {}, () => 'notice-title',
    (fn: () => void) => { mount = fn }, (fn: () => void) => { unmount = fn }, siteBannerState, (text: string) => text,
    { now: () => now, parse: Date.parse },
    { setTimeout: (fn: () => void, delay: number) => { timers.set(++nextId, { fn, delay }); return nextId }, clearTimeout: (id: number) => timers.delete(id) },
    { addEventListener: (name: string, fn: () => void) => listeners.set(name, fn), removeEventListener: (name: string, fn: () => void) => { if (listeners.get(name) === fn) listeners.delete(name) } }
  )
  mount()
  return { view, timers, listeners, unmount, advance: (value: string) => { now = Date.parse(value) } }
}
describe('reader announcement lifetime', () => {
  it('expires an already open announcement at its end and removes timer/listeners', () => {
    const h = build({ isEnabled: true, title: 'Notice', content: '', endsAt: '2026-09-07T11:00:00Z' })
    expect(h.view.isVisible.value).toBe(true); expect([...h.timers.values()][0]?.delay).toBe(3600000)
    h.advance('2026-09-07T11:00:00Z'); [...h.timers.values()][0]!.fn(); expect(h.view.isVisible.value).toBe(false)
    h.unmount(); expect(h.listeners.size).toBe(0)
    const open = build({ isEnabled: true, title: 'Notice', content: '', endsAt: '2026-09-07T11:00:00Z' })
    expect(open.view.isVisible.value).toBe(true)
    expect(open.timers.size).toBe(1)
    expect(open.listeners.has('visibilitychange')).toBe(true)
    open.unmount()
    expect(open.timers.size).toBe(0)
    expect(open.listeners.size).toBe(0)
  })
  it('rechecks expired notices when a suspended document becomes visible', () => {
    const h = build({ isEnabled: true, title: 'Notice', content: '', endsAt: '2026-09-07T11:00:00Z' })
    h.advance('2026-09-08T10:00:00Z'); h.listeners.get('visibilitychange')!(); expect(h.view.isVisible.value).toBe(false); h.unmount()
  })
  it('allows explicit administrative preview outside the publication window', () => {
    const banner = { isEnabled: true, title: 'Scheduled notice', content: '', startsAt: '2026-09-08T10:00:00Z' }
    const reader = build(banner), preview = build(banner, true)
    expect(reader.view.isVisible.value).toBe(false); expect(preview.view.isVisible.value).toBe(true); reader.unmount(); preview.unmount()
  })
})
