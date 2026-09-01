import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, test } from '../../../server/test/bun-test.mts'

const componentPath = join(process.cwd(), 'client/components/profile/profile.vue')
const source = readFileSync(componentPath, 'utf8')
const { descriptor, errors } = parse(source, { filename: componentPath })
const template = descriptor.template?.content ?? ''
const styles = descriptor.styles.map(style => style.content).join('\n')
const providerStart = template.indexOf('v-toolbar.profile-auth-provider(')
const providerEnd = template.indexOf('//- v-divider.mt-3', providerStart)
const providerTemplate = template.slice(providerStart, providerEnd)

describe('profile authentication provider card contract', () => {
  test('uses one theme-tokenized provider surface without appearance-specific color branches', () => {
    expect(errors).toEqual([])
    expect(template.match(/v-toolbar\.profile-auth-provider\(/g) ?? []).toHaveLength(1)
    expect(providerTemplate).not.toMatch(/\$vuetify\.theme\.current\.dark|purple|grey-(?:lighten|darken)/i)

    for (const token of [
      '--wiki-ambient-accent',
      '--wiki-surface-border',
      '--wiki-control-radius',
      '--wiki-surface-raised',
      '--v-theme-on-surface',
      '--wiki-shadow-xs',
      '--wiki-shadow-inset'
    ]) {
      expect(styles).toContain(`var(${token})`)
    }
    expect(styles).toMatch(/background:\s*\n\s*linear-gradient\([^;]+transparent[^;]+\),\s*\n\s*color-mix\([^;]+transparent\);/)
    expect(styles).not.toMatch(/#[\da-f]{3,8}|(?:purple|grey)-(?:lighten|darken)/i)
  })

  test('keeps the shield centered within a balanced logical inset', () => {
    expect(providerTemplate).toContain('.profile-auth-provider__mark')
    expect(providerTemplate).toContain("v-icon(aria-hidden='true') mdi-shield-lock")
    expect(styles).toMatch(/\.v-toolbar__content\s*\{[^}]*gap:\s*var\(--wiki-space-3\);[^}]*padding-inline:\s*var\(--wiki-space-3\);/s)
    expect(styles).toMatch(/&__mark\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;/s)
    expect(styles).toMatch(/width:\s*calc\(var\(--wiki-control-height\) - var\(--wiki-space-2\)\);/)
    expect(styles).toMatch(/height:\s*calc\(var\(--wiki-control-height\) - var\(--wiki-space-2\)\);/)
  })

  test('preserves local-password behavior and accessible password controls', () => {
    expect(template).toContain("v-list-subheader.pl-0: span.text-label-large {{$t('profile:auth.provider')}}")
    expect(template).toContain("template(v-if='user.providerKey === `local`')")
    expect(template).toContain("form#change-password-form(@submit.prevent='changePassword')")
    expect(template).toContain("type='submit', form='change-password-form'")

    for (const field of ['Current', 'New', 'Verify']) {
      expect(template).toContain(`:aria-label='hide${field}Pass ? "Show password" : "Hide password"'`)
    }
  })
})
