import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from '../../../../server/test/bun-test.mts'

// Structure contract for the reader-header action row. The markup is shared by
// the light and dark Vuetify themes, so this contract pins both at once: the
// breadcrumb path lives in the Save Offline / Focus action row (not in a
// standalone toolbar), the homepage stays excluded, and the responsive/print
// accommodations are wired to the new element instead of the removed bar.

const source = fs.readFileSync(path.join(import.meta.dir, 'page.vue'), 'utf8')

const template = source.slice(
  source.indexOf('<template'),
  source.indexOf('</template')
)
const style = source.slice(source.lastIndexOf('<style'))

describe('page.vue breadcrumb-path structure contract', () => {
  it('no longer renders a standalone breadcrumb toolbar', () => {
    expect(source.includes('page-breadcrumb-bar')).toBe(false)
  })

  it('keeps the path inside the reader-header action row', () => {
    expect(template.includes("nav.page-header-path(")).toBe(true)
    const pairIdx = template.indexOf('.page-header-control-pair(')
    const pathIdx = template.indexOf('nav.page-header-path(')
    const offlineIdx = template.indexOf('.page-header-offline(')
    expect(pairIdx).toBeGreaterThanOrEqual(0)
    expect(pathIdx).toBeGreaterThan(pairIdx)
    expect(offlineIdx).toBeGreaterThan(pathIdx)
  })

  it('keeps the homepage excluded and print view hidden', () => {
    expect(template.includes("v-if='!printView && path !== `home`'")).toBe(true)
    expect(style.includes('.page-header-path')).toBe(true)
  })

  it('wires the inline breadcrumb variant and responsive rules', () => {
    expect(template.includes('breadcrumbs-nav--inline')).toBe(true)
    expect(style.includes('.breadcrumbs-nav--inline')).toBe(true)
    expect(style.includes('.page-header-path {')).toBe(true)
  })
})

describe('page.vue code copy attractor contract', () => {
  const script = source.slice(source.indexOf('<script'), source.indexOf('</script>'))
  const stylesheet = fs.readFileSync(
    path.join(import.meta.dir, '..', 'scss', 'app.scss'),
    'utf8'
  )

  it('fires the inline-code sweep only on the click-to-copy interaction', () => {
    // No ambient timer and no hover trigger for inline chips.
    expect(script.includes('scheduleInlineShimmer')).toBe(false)
    expect(script.includes('handleInlineCodeFirstHover')).toBe(false)
    expect(script.includes('inlineShimmerStates')).toBe(false)
    // The click handler acknowledges the copy with the sweep.
    expect(script.includes('triggerInlineShimmerSweep(codeEl)')).toBe(true)
    // The chip sweep and the whole-block copy flash both run at twice the
    // code-block button shimmer's rate (.95s vs 1.9s).
    expect(stylesheet.includes('animation: wiki-inline-code-shimmer-sweep .95s ease-in-out 1 both')).toBe(true)
    expect(stylesheet.includes('animation: wiki-code-block-copy-sweep .95s ease-in-out 1 both')).toBe(true)
    expect(stylesheet.match(/wiki-code-copy-shimmer-sweep 1\.9s/g)?.length).toBeGreaterThan(0)
    // The block flash is clipped to the block bounds.
    expect(stylesheet.includes('animation: wiki-code-block-copy-sweep 1.9s')).toBe(false)
    // The block sweep rides background-position on a stationary band (no
    // transform), so it never grows the pre's scrollable overflow or flashes
    // a horizontal scrollbar, and starts at the block's edge without lag.
    expect(stylesheet.includes('background-size: 300% 100%')).toBe(true)
    // The sweep travels exactly edge-to-edge: with 300% background-size and
    // 40%/60% stops, positions 90% -> 10% touch the block's start and far
    // edges with the band's leading/trailing edges — no dead travel.
    // The band rides above the toolbar button (z-index 4) so the final
    // stretch of the sweep is not hidden underneath the Copy button.
    expect(stylesheet.includes('z-index: 5;')).toBe(true)
    expect(stylesheet.includes('from { background-position: 90% 0; }')).toBe(true)
    expect(stylesheet.includes('to { background-position: 10% 0; }')).toBe(true)
  })

  it('keeps the code-block copy button shimmer scheduler intact', () => {
    expect(script.includes('function scheduleCopyShimmer')).toBe(true)
    expect(script.includes('function handleCopyToolbarFirstHover')).toBe(true)
    expect(script.includes('copyShimmerAmbientDelay')).toBe(true)
  })

  it('flashes the whole code block when its Copy button is clicked', () => {
    expect(script.includes('function flashCodeBlockCopy')).toBe(true)
    expect(script.includes("linkCopy.addEventListener('click'")).toBe(true)
    expect(script.includes("'wiki-code-copy-flash-run'")).toBe(true)
    expect(script.includes(".querySelector<HTMLElement>('pre')")).toBe(true)
    expect(script.includes('.codeblock-framed')).toBe(true)
    expect(stylesheet.includes('wiki-code-block-copy-sweep')).toBe(true)
    expect(stylesheet.includes('.code-toolbar > pre.wiki-code-copy-flash-run::after')).toBe(true)
    expect(stylesheet.includes('.codeblock-framed.wiki-code-copy-flash-run::after')).toBe(true)
  })
})
