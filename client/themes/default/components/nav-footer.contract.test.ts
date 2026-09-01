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
    expect(style).toMatch(/\.nav-footer\s*\{[\s\S]*?padding:\s*var\(--wiki-space-1\) var\(--wiki-page-gutter\)/)
    expect(style).not.toMatch(/(?:inline-size|width)\s*:\s*(?:100vw|calc\([^;]*100vw)/)
  })

  test('preserves configured legal copy and its override precedence', () => {
    expect(template).toContain(".footer-attribution__legal(v-if='footerOverride')")
    expect(template).toContain("span(v-html='footerOverrideRender')")
    expect(template).toContain(".footer-attribution__legal(v-else-if='company && company.length > 0 && contentLicense !== ``')")
    expect(template).toContain("$t('common:footer.copyright'")
    expect(template).toContain("$t('common:footer.license'")
    expect(script).toContain('return md.renderInline(this.footerOverride)')
  })

  test('keeps project source attribution accessible without the Wiki.js derivation notice', () => {
    expect(template).toContain('span.footer-attribution__product {{ product.name }} {{ product.version }}')
    expect(template).toContain("a(:href='product.sourceUrl', target='_blank', rel='noopener noreferrer') Source Code")
    expect(template).not.toMatch(/Derived from|Requarks\/wiki|Wiki\.js/)
  })
})
