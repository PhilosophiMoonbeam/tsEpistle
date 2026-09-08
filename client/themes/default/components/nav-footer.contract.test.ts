import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, test } from '../../../../server/test/bun-test.mts'

const componentPath = join(process.cwd(), 'client/themes/default/components/nav-footer.vue')
const componentSource = readFileSync(componentPath, 'utf8')
const baseSource = readFileSync(join(process.cwd(), 'client/scss/base/base.scss'), 'utf8')
const { descriptor, errors } = parse(componentSource, { filename: componentPath })
const template = descriptor.template?.content ?? ''
const script = descriptor.script?.content ?? ''
const style = descriptor.styles[0]?.content ?? ''

describe('global footer edge and attribution contract', () => {
  test('does not reserve a permanent root scrollbar gutter or mask overflow', () => {
    expect(baseSource).not.toMatch(/scrollbar-gutter\s*:/)
    expect(baseSource).not.toMatch(/overflow-x\s*:\s*hidden/)
    expect(baseSource).toMatch(/html\s*\{[\s\S]*?overflow-y:\s*auto;/)
    expect(baseSource).toMatch(/body\s*\{[\s\S]*?margin:\s*0;/)
  })

  test('keeps the footer viewport-safe without viewport-width compensation', () => {
    expect(errors).toEqual([])
    expect(style).toContain('safe-area-inset-bottom')
    expect(style).not.toMatch(/(?:inline-size|width)\s*:\s*(?:100vw|calc\([^;]*100vw)/)
    expect(style).toMatch(/height:\s*auto;/)
    expect(style).toMatch(/min-height:\s*var\(--wiki-footer-height\);/)
  })

  test('defines the 24px single-line footer height token', () => {
    expect(baseSource).toMatch(/--wiki-footer-height:\s*1\.5rem;/)
  })

  test('preserves configured legal copy and its override precedence', () => {
    expect(template).toContain(".footer-attribution__legal(v-if='footerOverride')")
    expect(template).toContain("span(v-html='footerOverrideRender')")
    expect(template).toContain(".footer-attribution__legal(v-else-if='company && company.length > 0 && contentLicense !== ``')")
    expect(template).toContain("$t('common:footer.copyright'")
    expect(template).toContain("$t('common:footer.license'")
    expect(script).toContain('return renderFooterMarkdown(this.footerOverride)')
  })

  test('keeps project source attribution accessible without the Wiki.js derivation notice', () => {
    expect(template).toContain('span.footer-attribution__product {{ product.name }} {{ product.version }}')
    expect(template).toContain("a(:href='product.sourceRepository', target='_blank', rel='noopener noreferrer') {{ $t('common:footer.sourceCode') }}")
    expect(template).toMatch(/p\.footer-attribution__meta/)
    expect(template).not.toMatch(/Derived from|Requarks\/wiki|Wiki\.js/)
  })

  test('retains attribution in normal flow when printing', () => {
    expect(style).toMatch(/@media print[\s\S]*?\.nav-footer[\s\S]*?position:\s*static/)
  })
})
