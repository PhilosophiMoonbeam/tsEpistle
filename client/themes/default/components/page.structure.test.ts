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
