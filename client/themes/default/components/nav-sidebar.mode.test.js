import fs from 'node:fs'
import { describe, expect, it, vi } from '../../../../server/test/bun-test.mts'

const source = fs.readFileSync(new URL('./nav-sidebar.vue', import.meta.url), 'utf8')
const script = source.match(/<script lang='ts'>([\s\S]*?)<\/script>/)[1]
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  script.replace(/^import .*$/gm, '')
).replace('export default defineComponent(', 'return defineComponent(')
const storage = preference => {
  const values = new Map(preference === null ? [] : [['navPref', preference]])
  return {
    getItem: vi.fn(key => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value))
  }
}
const mountSidebar = ({ localStorage = storage(null), items = [], navMode = 'MIXED', expandParentByDefault = false } = {}) => {
  const component = new Function('defineComponent', 'AsyncState', 'window', executable)(
    options => options, {}, { localStorage }
  )
  const sidebar = { ...component.data(), items, navMode, expandParentByDefault, $t: key => key }
  for (const [name, method] of Object.entries(component.methods)) sidebar[name] = method.bind(sidebar)
  Object.defineProperty(sidebar, 'customItems', { get: () => component.computed.customItems.call(sidebar) })
  sidebar.fetchBrowseItems = vi.fn()
  sidebar.loadFromCurrentPath = vi.fn()
  component.mounted.call(sidebar)
  return sidebar
}
const home = { k: 'link', y: 'home', t: '/', l: 'Home', c: 'mdi-home' }
const guide = { k: 'link', y: 'page', t: '/en/guide', l: 'Guide', c: 'mdi-book' }

describe('Custom Navigation preserves its two views', () => {
  for (const [label, items] of [['empty or permission-filtered', []], ['home only', [home]], ['populated', [home, guide]]]) {
    for (const preference of ['custom', 'browse', null, 'invalid']) {
      it(`respects ${preference ?? 'unset'} preference with a ${label} menu`, () => {
        const localStorage = storage(preference)
        const sidebar = mountSidebar({ items, localStorage })
        const expected = preference === 'browse' || preference === 'custom'
          ? preference : items.includes(guide) ? 'custom' : 'browse'
        expect(sidebar.currentMode).toBe(expected)
        expect(sidebar.fetchBrowseItems).toHaveBeenCalledTimes(expected === 'browse' ? 1 : 0)
        expect(localStorage.setItem).not.toHaveBeenCalled()
      })
    }
    it(`switches in both directions and remembers the choice with a ${label} menu`, () => {
      const localStorage = storage('custom')
      const sidebar = mountSidebar({ items, localStorage })
      sidebar.switchMode('browse')
      expect(sidebar.currentMode).toBe('browse')
      expect(sidebar.fetchBrowseItems).toHaveBeenCalledTimes(1)
      expect(mountSidebar({ items, localStorage }).currentMode).toBe('browse')
      sidebar.loadedCache = [0]
      sidebar.switchMode('custom')
      expect(sidebar.currentMode).toBe('custom')
      expect(mountSidebar({ items, localStorage }).currentMode).toBe('custom')
      sidebar.switchMode('browse')
      expect(sidebar.fetchBrowseItems).toHaveBeenCalledTimes(1)
    })
  }

  for (const [navMode, expected] of [['STATIC', 'custom'], ['TREE', 'browse']]) {
    it(`${navMode} uses its configured view regardless of the saved preference`, () => {
      const localStorage = storage(expected === 'custom' ? 'browse' : 'custom')
      const sidebar = mountSidebar({ navMode, localStorage })
      expect(sidebar.currentMode).toBe(expected)
      expect(localStorage.getItem).not.toHaveBeenCalled()
      expect(sidebar.fetchBrowseItems).toHaveBeenCalledTimes(expected === 'browse' ? 1 : 0)
    })
  }

  it('loads the current page directory when expanding parents is enabled', () => {
    const sidebar = mountSidebar({ expandParentByDefault: true, items: [guide] })
    sidebar.switchMode('browse')
    expect(sidebar.loadFromCurrentPath).toHaveBeenCalledTimes(1)
    expect(sidebar.fetchBrowseItems).not.toHaveBeenCalled()
  })

  it('keeps both views usable when storage reads and writes fail', () => {
    const unavailable = () => { throw new Error('Storage unavailable') }
    const sidebar = mountSidebar({ localStorage: { getItem: unavailable, setItem: unavailable } })
    expect(sidebar.currentMode).toBe('browse')
    sidebar.loadedCache = [0]
    sidebar.switchMode('browse')
    expect(sidebar.currentMode).toBe('browse')
    expect(sidebar.fetchBrowseItems).toHaveBeenCalledTimes(1)
    sidebar.switchMode('custom')
    expect(sidebar.currentMode).toBe('custom')
  })
})
