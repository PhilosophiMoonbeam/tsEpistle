import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from '../server/test/bun-test.mts'

const appPath = join(process.cwd(), 'client/client-app.ts')
const source = readFileSync(appPath, 'utf8')
const asyncStatePath = join(process.cwd(), 'client/components/common/async-component-state.vue')
const asyncStateSource = readFileSync(asyncStatePath, 'utf8')

const registrationsMatch = source.match(/const registrations = \[\n([\s\S]*?)\n\]/)
const registrationEntries = (registrationsMatch?.[1] ?? '')
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean)

const localeOptions = source.match(/locale:\s*\{([\s\S]*?)\n\s*\},\n\s*defaults:/)?.[1] ?? ''

describe('modern client Vuetify bootstrap contract', () => {
  test('installs Vuetify messages for the configured locale with an English fallback and configured direction', () => {
    expect(source).toContain("import * as vuetifyLocaleMessages from 'vuetify/locale'")
    expect(source).toMatch(/const vuetifyMessageLocale = resolveVuetifyMessageLocale\(siteConfig\.lang\)/)
    expect(source).toMatch(
      /const selectedVuetifyMessages = vuetifyMessageLocale\s*\? \{ en: vuetifyLocaleMessages\.en, \[siteConfig\.lang\]: vuetifyLocaleMessages\[vuetifyMessageLocale\] \}\s*:\s*\{ en: vuetifyLocaleMessages\.en \}/
    )

    expect(localeOptions).toMatch(/fallback:\s*'en'/)
    expect(localeOptions).toMatch(/locale:\s*siteConfig\.lang/)
    expect(localeOptions).toMatch(/messages:\s*selectedVuetifyMessages/)
    expect(localeOptions).toMatch(/rtl:\s*\{ \[siteConfig\.lang\]: siteConfig\.rtl \}/)
  })

  test('normalizes regional locales without dropping supported Vuetify translations', () => {
    expect(source).toMatch(/language\.trim\(\)\.toLowerCase\(\)\.replaceAll\('_', '-'\)\.split\('-'\)/)
    expect(source).toMatch(/if \(baseLanguage === 'sr'\) return languageParts\.includes\('latn'\) \? 'srLatn' : 'srCyrl'/)
    expect(source).toMatch(/if \(baseLanguage === 'zh'\) \{[\s\S]*return usesTraditionalCharacters \? 'zhHant' : 'zhHans'/)
    expect(source).toMatch(/Object\.hasOwn\(vuetifyLocaleMessages, baseLanguage\)[\s\S]*: undefined/)
  })

  test('routes every lazy root registration through the shared recoverable async-component factory', () => {
    expect(source).toContain("import { createAsyncComponent } from './components/common/async-component-state.vue'")
    expect(source).toMatch(/const asyncComponent = \(name: string, loader: AsyncComponentLoader\) => \[name, createAsyncComponent\(loader\)\] as const/)
    expect(registrationsMatch).not.toBeNull()
    expect(registrationEntries.length).toBeGreaterThan(0)
    expect(registrationEntries.every(entry => /^asyncComponent\('[A-Za-z][A-Za-z0-9]*', \(\) => import\('\.\/[^']+\.vue'\)\),?$/.test(entry))).toBe(true)
    expect(source).not.toContain('defineAsyncComponent')
    expect(source).toMatch(/for \(const \[name, component\] of registrations\) app\.component\(name, component\)/)
  })

  test('renders recoverable loading and chunk-error states instead of a blank async surface', () => {
    expect(asyncStateSource).toMatch(/:role="error \? 'alert' : 'status'"/)
    expect(asyncStateSource).toContain("{{ error ? 'This section could not be loaded' : 'Loading this section' }}")
    expect(asyncStateSource).toMatch(/v-btn ref="retryButton"[\s\S]*@click="\$emit\('retry'\)"[\s\S]*Try again/)
    expect(asyncStateSource).toMatch(/v-btn[\s\S]*@click="reloadPage"[\s\S]*Reload page/)
    expect(asyncStateSource).toMatch(/const boundedLoader: AsyncComponentLoader[\s\S]*ASYNC_COMPONENT_TIMEOUT_MS/)
    expect(asyncStateSource).toMatch(
      /return defineAsyncComponent\(\{[\s\S]*loader: boundedLoader,[\s\S]*loadingComponent: LoadingAndErrorState,[\s\S]*suspensible: false,[\s\S]*onError\(error, retry\) \{[\s\S]*loadError\.value = error[\s\S]*retryLoad = retry/
    )
    expect(asyncStateSource).toMatch(/loadError\.value = undefined\s*pendingRetry\(\)/)
  })
})
