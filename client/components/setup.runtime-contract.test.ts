import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, test } from '../../server/test/bun-test.mts'

const componentPath = join(process.cwd(), 'client/components/setup.vue')
const source = readFileSync(componentPath, 'utf8')
const { descriptor, errors } = parse(source, { filename: componentPath })
const template = descriptor.template?.content ?? ''
const script = descriptor.script?.content ?? ''

const extractMethod = (value: string, signature: string): string => {
  const start = value.indexOf(signature)
  expect(start).toBeGreaterThanOrEqual(0)
  const bodyStart = value.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < value.length; index++) {
    if (value[index] === '{') depth++
    if (value[index] === '}') depth--
    if (depth === 0) return value.slice(start, index + 1)
  }
  throw new Error(`Method ${signature} is not closed`)
}

const compileInstall = (sameOriginJsonFetch: (...args: unknown[]) => Promise<unknown>, windowStub: unknown) => {
  const installSource = extractMethod(script, 'async install ()')
    .replace(/^async install \(\) \{/, 'async function () {')
    .replace(/ as 'adminEmail' \| 'adminPassword' \| 'adminPasswordConfirm' \| 'siteUrl'/, '')

  return new Function(
    'validateValues',
    'sameOriginJsonFetch',
    'normalizeFinalizeResponse',
    'getErrorMessage',
    'focusComponent',
    'confetti',
    'SUCCESS_REDIRECT_DELAY_MS',
    'window',
    `return (${installSource})`
  )(
    () => undefined,
    sameOriginJsonFetch,
    (payload: unknown) => payload,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
    () => undefined,
    () => undefined,
    1000,
    windowStub
  ) as () => Promise<void>
}

describe('setup runtime contract', () => {
  test('keeps password controls renderable before localization is installed', () => {
    expect(errors).toEqual([])
    expect(template).toContain(":aria-label=\"pwdMode ? 'Show administrator password' : 'Hide administrator password'\"")
    expect(template).toContain(":aria-label=\"pwdConfirmMode ? 'Show password confirmation' : 'Hide password confirmation'\"")
    expect(template).toContain(
      "v-btn(icon type='button' variant='text' size='small' :aria-label=\"pwdMode ? 'Show administrator password' : 'Hide administrator password'\" :disabled='loading' @click='pwdMode = !pwdMode')"
    )
    expect(template).toContain(
      "v-btn(icon type='button' variant='text' size='small' :aria-label=\"pwdConfirmMode ? 'Show password confirmation' : 'Hide password confirmation'\" :disabled='loading' @click='pwdConfirmMode = !pwdConfirmMode')"
    )
    expect(source.match(/\$t\s*\(/g) ?? []).toHaveLength(0)
  })

  test('keeps the Site URL example visible without overlapping its label', () => {
    const siteUrlField = template
      .match(/^[ \t]*v-text-field\(\r?\n(?:[ \t]+[^\r\n]*\r?\n)*[ \t]*\)[ \t]*$/gm)
      ?.find(field => /^[ \t]*label='Site URL'[ \t]*$/m.test(field))

    expect(siteUrlField).toMatch(/^[ \t]*label='Site URL'[ \t]*$/m)
    expect(siteUrlField).toMatch(/^[ \t]*placeholder='https:\/\/wiki\.example\.com'[ \t]*$/m)
    expect(siteUrlField).toMatch(/^[ \t]*persistent-placeholder[ \t]*$/m)
  })

  test('keeps an explicit successful continuation without aborting finalization', () => {
    expect(script).not.toMatch(/\bFINALIZE_TIMEOUT_MS\b|\bfinalizeTimer\b|\bfinalizeController\b/)
    expect(extractMethod(script, 'async install ()')).not.toMatch(/\bAbortController\b|\.abort\(|\bsignal\s*:/)
    expect(template).toContain("form#setup-form.setup-form(@submit.prevent='install', :aria-busy='loading', novalidate)")
    expect(template).toMatch(/type='submit'[\s\S]*?:disabled='loading'[\s\S]*?:loading='loading'/)
    expect(template).toContain("v-dialog(v-model='loading', width='420', persistent, aria-labelledby='setup-progress-title')")
    expect(template).toContain("@click='continueToLogin'")
    expect(script).toMatch(/const\s+SUCCESS_REDIRECT_DELAY_MS\s*=\s*1000\b/)
    expect(script).toMatch(
      /this\.redirectTimer\s*=\s*window\.setTimeout\(\(\)\s*=>\s*\{[\s\S]*?this\.continueToLogin\(\)[\s\S]*?\},\s*SUCCESS_REDIRECT_DELAY_MS\)/
    )
    expect(template).toContain('Continue to sign in')
    expect(script).toMatch(/window\.matchMedia\(['"]\(prefers-reduced-motion: reduce\)['"]\)\.matches/)
    expect(script).toContain('disableForReducedMotion: true')
  })

  test('keeps a slow finalize pending and prevents a duplicate submission', async () => {
    let resolveFinalize!: (response: unknown) => void
    const finalize = new Promise<unknown>(resolve => {
      resolveFinalize = resolve
    })
    const requests: unknown[][] = []
    const timers: Array<{ callback: () => void; delay: number }> = []
    const windowStub = {
      fetch: () => undefined,
      matchMedia: () => ({ matches: true }),
      setTimeout: (callback: () => void, delay: number) => {
        timers.push({ callback, delay })
        return timers.length
      }
    }
    const install = compileInstall((...args: unknown[]) => {
      requests.push(args)
      return finalize
    }, windowStub)
    const viewModel = {
      loading: false,
      success: false,
      error: false,
      errorMessage: '',
      fieldErrors: {
        adminEmail: '',
        adminPassword: '',
        adminPasswordConfirm: '',
        siteUrl: ''
      },
      conf: {
        adminEmail: 'admin@example.com',
        adminPassword: 'correct horse battery staple',
        adminPasswordConfirm: 'correct horse battery staple',
        siteUrl: 'https://wiki.example.com',
        telemetry: true
      },
      isDisposed: false,
      redirectTimer: null,
      $refs: {},
      $nextTick: (callback: () => void) => callback(),
      continueToLogin: () => undefined
    }
    const firstInstall = install.call(viewModel)
    expect(viewModel.loading).toBe(true)
    expect(viewModel.success).toBe(false)
    expect(viewModel.error).toBe(false)
    expect(requests).toHaveLength(1)
    expect(timers).toHaveLength(0)
    expect(requests[0][1]).toBe('/finalize')
    expect(requests[0][2]).not.toHaveProperty('signal')

    await install.call(viewModel)
    expect(requests).toHaveLength(1)
    expect(viewModel.loading).toBe(true)

    resolveFinalize({
      json: async () => ({ ok: true, error: '' })
    })
    await firstInstall

    expect(viewModel.success).toBe(true)
    expect(viewModel.loading).toBe(true)
    expect(timers.map(timer => timer.delay)).toEqual([1000])
  })
})
