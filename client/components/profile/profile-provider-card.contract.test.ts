import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, test } from '../../../server/test/bun-test.mts'

const componentPath = join(process.cwd(), 'client/components/profile/profile.vue')
const source = readFileSync(componentPath, 'utf8')
const { descriptor, errors } = parse(source, { filename: componentPath })
const template = descriptor.template?.content ?? ''
const script = descriptor.script?.content ?? ''
const styles = descriptor.styles.map(style => style.content).join('\n')
const providerStart = template.indexOf('v-toolbar.profile-auth-provider(')
const providerEnd = template.indexOf('//- v-divider.mt-3', providerStart)
const providerTemplate = template.slice(providerStart, providerEnd)
const passwordStart = template.indexOf("template(v-if='user.providerKey === `local`')")
const passwordEnd = template.indexOf("v-col(lg='6' cols='12')", passwordStart)
const passwordTemplate = template.slice(passwordStart, passwordEnd)

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

  test('gives every profile edit action a translated, field-specific accessible name', () => {
    for (const field of ['displayName', 'location', 'jobTitle', 'timezone', 'dateFormat', 'appearance']) {
      expect(template).toContain(`:aria-label='$t(\`common:actions.edit\`) + \` \` + $t(\`profile:${field}\`)'`)
    }
    expect(template).not.toMatch(/aria-label=['"]Edit(?:\s|['"])/)
  })

  test('preserves local-password behavior with translated controls and busy-safe re-entry', () => {
    expect(template).toContain("v-list-subheader.pl-0: span.text-label-large {{$t('profile:auth.provider')}}")
    expect(passwordTemplate).toContain("template(v-if='user.providerKey === `local`')")
    expect(passwordTemplate).toContain("form#change-password-form(@submit.prevent='changePassword' :aria-busy='changePassLoading')")
    expect(passwordTemplate).toContain(
      "v-btn.px-4(color=\"primary\", variant=\"flat\", :loading='changePassLoading', :disabled='changePassLoading', type='submit', form='change-password-form')"
    )
    expect(passwordTemplate.match(/:disabled='changePassLoading'/g) ?? []).toHaveLength(7)
    for (const [state, field] of [
      ['hideCurrentPass', 'currentPassword'],
      ['hideNewPass', 'newPassword'],
      ['hideVerifyPass', 'verifyPassword']
    ]) {
      expect(passwordTemplate).toContain(
        `:aria-label='(${state} ? $t(\`common:header.view\`) : $t(\`common:actions.close\`)) + \` \` + $t(\`profile:auth.${field}\`)'`
      )
      expect(passwordTemplate).toContain(`@click='${state} = !${state}'`)
    }
    expect(passwordTemplate).not.toMatch(/Show password|Hide password/i)
    expect(script).toMatch(/async changePassword \(\) \{\s+if \(this\.changePassLoading\) return\s+this\.passwordErrors =/s)
    expect(script).toMatch(
      /this\.changePassLoading = true\s+wikiStore\.startLoading\('profile-changepassword'\)[\s\S]+finally \{\s+wikiStore\.stopLoading\('profile-changepassword'\)\s+this\.changePassLoading = false/s
    )
  })
})
