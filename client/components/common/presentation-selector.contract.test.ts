import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, test } from '../../../server/test/bun-test.mts'

const componentPath = join(process.cwd(), 'client/components/common/presentation-selector.vue')
const componentSource = readFileSync(componentPath, 'utf8')
const component = parse(componentSource, { filename: componentPath })
const template = component.descriptor.template?.content ?? ''
const script = component.descriptor.scriptSetup?.content ?? ''
const style = component.descriptor.styles.map(block => block.content).join('\n')

const appearancePath = join(process.cwd(), 'client/components/common/appearance-selector.vue')
const appearanceSource = readFileSync(appearancePath, 'utf8')
const appearance = parse(appearanceSource, { filename: appearancePath })
const appearanceScript = appearance.descriptor.scriptSetup?.content ?? ''

const navPath = join(process.cwd(), 'client/components/common/nav-header.vue')
const navSource = readFileSync(navPath, 'utf8')
const nav = parse(navSource, { filename: navPath })
const navTemplate = nav.descriptor.template?.content ?? ''
const navScript = nav.descriptor.script?.content ?? ''
const navStyle = nav.descriptor.styles.map(block => block.content).join('\n')

describe('authenticated presentation preferences contract', () => {
  test('parses every owned component and places both selectors in the account preferences region', () => {
    expect(component.errors).toEqual([])
    expect(appearance.errors).toEqual([])
    expect(nav.errors).toEqual([])
    const accountMenuDeclaration = navTemplate.split('\n').find(line => line.includes("v-menu(v-if='isAuthenticated'")) ?? ''
    expect(accountMenuDeclaration).toContain(":close-on-content-click='false'")

    expect(navTemplate).toContain("section.account-menu__preferences(role='region' aria-labelledby='account-preferences-title')")
    expect(navTemplate).toContain('h2#account-preferences-title.account-menu__preferences-title Presentation preferences')
    expect(navScript).toContain("AppearanceSelector: defineAsyncComponent(() => import('./appearance-selector.vue'))")
    expect(navScript).toContain("PresentationSelector: defineAsyncComponent(() => import('./presentation-selector.vue'))")

    const profileIndex = navTemplate.indexOf("href='/p'")
    const appearanceIndex = navTemplate.indexOf('appearance-selector', profileIndex)
    const presentationIndex = navTemplate.indexOf('presentation-selector', appearanceIndex)
    const logoutIndex = navTemplate.indexOf("v-list-item(role='button', link, @click='logout')", presentationIndex)
    expect(navTemplate).not.toContain("v-list-item(href='/p')")
    expect(navTemplate).toMatch(/:aria-label='`Open profile for \$\{name\}`'/)
    expect(profileIndex).toBeGreaterThan(-1)
    expect(appearanceIndex).toBeGreaterThan(profileIndex)
    expect(presentationIndex).toBeGreaterThan(appearanceIndex)
    expect(logoutIndex).toBeGreaterThan(presentationIndex)
  })

  test('offers full-card fixed typeface previews without reading-gutter choices', () => {
    expect(script).toContain("{ value: 'newsreader', label: 'Newsreader'")
    expect(script).toContain("{ value: 'roboto-flex', label: 'Roboto Flex'")
    expect(template).toMatch(/:class='`presentation-selector__card--\$\{option\.value\}`'/)
    expect(style).toContain(`.presentation-selector__card--newsreader {
  font-family: var(--wiki-font-newsreader);
}`)
    expect(style).toContain(`.presentation-selector__card--roboto-flex {
  font-family: var(--wiki-font-roboto-flex);
}`)
    expect(style).not.toContain('font-family: var(--wiki-font-reader)')
    expect(style).not.toContain('font-family: var(--wiki-font-body)')
    expect(template).not.toMatch(/reading gutter|wiki-reading-gutter/i)
    expect(script).not.toMatch(/gutter|UserReadingGutter/i)
    expect(style).not.toContain('presentation-selector__gutters')
  })

  test('strictly saves known font-family choices and restores the previous choice on failure', () => {
    expect(script).toContain("const PREFERENCE_LOADING_KEY = 'profile-preferences-save'")
    expect(script).toContain('async function selectFontFamily (next: UserFontFamily)')
    expect(script).toContain('const option = fontOptions.find(candidate => candidate.value === next)')
    expect(script).toContain('if (!option) return')
    expect(script).toContain('{ fontFamily: next },')
    expect(script).not.toContain('savePreference')
    expect(script).toContain('wikiStore.user.fontFamily = next')
    expect(script).toContain('wikiStore.user.fontFamily = previousFontFamily')
    expect(script).toContain("Cookies.set('jwt', token")
    expect(script).toContain('wikiStore.refreshAuth()')
    expect(script).toContain('wikiStore.showError(error)')
    expect(script).toContain('wikiStore.startLoading(PREFERENCE_LOADING_KEY)')
    expect(script).toContain('wikiStore.stopLoading(PREFERENCE_LOADING_KEY)')
    expect(script).not.toContain('readingGutter')

    expect(appearanceScript).toContain('updateProfilePreferences(')
    expect(appearanceScript).toContain('{ appearance: next }')
    expect(appearanceScript).toContain("wikiStore.startLoading('profile-preferences-save')")
    expect(appearanceScript).toContain("wikiStore.stopLoading('profile-preferences-save')")
    expect(appearanceScript).not.toContain('updateProfileAppearance')
    expect(appearanceScript).not.toContain('profile-appearance-save')
  })

  test('uses one accessible native Typeface radio group with polite save announcements', () => {
    expect(template.match(/fieldset\.presentation-selector__group/g)?.length).toBe(1)
    expect(template).toContain('legend.presentation-selector__legend Typeface')
    expect(template).not.toContain('Reading gutter')
    expect(template.match(/type='radio'/g)?.length).toBe(1)
    expect(template).toContain("name='wiki-font-family'")
    expect(template).toContain(":aria-describedby='fontDescriptionId'")
    expect(template).toContain(":checked='selectedFontFamily === option.value'")
    expect(template).toContain(":for='fontOptionId(option.value)'")
    expect(template).not.toContain('gutterOptionId')
    expect(template).toContain("role='status' aria-live='polite' aria-atomic='true'")
    expect(template).toContain("aria-label='Saving typeface preference'")
    expect(template).toContain(":aria-busy='saving ? `true` : `false`'")
    expect(style).toContain('.presentation-selector__radio:checked + .presentation-selector__card')
    expect(style).toContain('.presentation-selector__radio:focus-visible + .presentation-selector__card')
    expect(template).not.toContain('presentation-selector__selected')
    expect(template).not.toContain('Selected')
    expect(style).not.toContain('.presentation-selector__selected')
  })

  test('keeps the account menu wide, bounded, and scrollable on small screens', () => {
    expect(navTemplate).toContain('v-list.nav-header-menu.account-menu')
    expect(navStyle).toContain('.nav-header-menu.account-menu')
    expect(navStyle).toContain('width: min(calc(100vw - (var(--wiki-space-4) * 2)), 34rem)')
    expect(navStyle).toContain('max-height: min(82dvh, 44rem)')
    expect(navStyle).toContain('overflow-y: auto')
    expect(style).toContain('@media (max-width: 399.98px)')
  })
})
