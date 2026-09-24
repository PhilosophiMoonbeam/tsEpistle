import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from '../../../../server/test/bun-test.mts'

// Structure contract for the page footer. Vuetify's stock `.v-footer` rule
// ships `flex: 1 1 auto`, which makes the footer a growing flex child of
// `.v-application__wrap` (min-height 100dvh): on short pages it stretches to
// fill the entire viewport remainder (giant footer). The theme must keep it a
// thin, bottom-pinned bar instead.

const source = fs.readFileSync(path.join(import.meta.dir, 'nav-footer.vue'), 'utf8')

describe('nav-footer.vue thin-footer structure contract', () => {
  it('never grows: footer opts out of the Vuetify flex grow', () => {
    expect(source.includes('flex: none;')).toBe(true)
  })

  it('pins the thin footer to the bottom of the shell on short pages', () => {
    expect(source.includes('margin-top: auto;')).toBe(true)
  })

  it('keeps the footer content-driven (height auto, thin min-height)', () => {
    expect(/\.nav-footer\s*\{[\s\S]*?height: auto;/.test(source)).toBe(true)
    expect(source.includes('min-height: var(--wiki-footer-height);')).toBe(true)
  })
})
