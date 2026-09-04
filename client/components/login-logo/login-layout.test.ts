import fs from 'node:fs'
import path from 'node:path'

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import * as Vue from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from '../../../server/test/bun-test.mts'
import { isLogoEffectDescriptor, type LogoEffectDescriptor } from './particle-logo.ts'

const loginPath = path.join(process.cwd(), 'client/components/login.vue')
const loginSource = fs.readFileSync(loginPath, 'utf8')
const parsed = parse(loginSource, { filename: loginPath })
if (parsed.errors.length > 0) throw new Error(`Could not parse login.vue: ${parsed.errors.join(', ')}`)
if (!parsed.descriptor.script || !parsed.descriptor.template) throw new Error('login.vue script or template was not found')

const readComponentSource = (relativePath: string) => {
  const componentPath = path.join(process.cwd(), relativePath)
  const source = fs.readFileSync(componentPath, 'utf8')
  const component = parse(source, { filename: componentPath })
  if (component.errors.length > 0) {
    throw new Error(`Could not parse ${relativePath}: ${component.errors.join(', ')}`)
  }
  if (!component.descriptor.script || !component.descriptor.template) {
    throw new Error(`${relativePath} script or template was not found`)
  }
  return {
    script: component.descriptor.script.content,
    source,
    template: component.descriptor.template.content
  }
}

const particleLogoComponent = readComponentSource('client/components/login-logo/LoginParticleLogo.vue')
const particleSceneComponent = readComponentSource('client/components/login-logo/LogoParticleScene.vue')
const pointerControllerPath = path.join(process.cwd(), 'client/components/login-logo/useLogoPointer.ts')
const pointerControllerSource = fs.readFileSync(pointerControllerPath, 'utf8')

const componentId = 'login-layout-behavior-test'
const compiledScript = compileScript(parsed.descriptor, { id: componentId, genDefaultAs: '__login__' })
const compiledTemplate = compileTemplate({
  source: parsed.descriptor.template.content,
  filename: loginPath,
  id: componentId,
  preprocessLang: parsed.descriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  transformAssetUrls: false,
  compilerOptions: {
    mode: 'function',
    bindingMetadata: compiledScript.bindings,
    expressionPlugins: ['typescript']
  }
})
if (compiledTemplate.errors.length > 0) {
  throw new Error(`Could not compile login.vue template: ${compiledTemplate.errors.join(', ')}`)
}
const renderLogin = new Function('Vue', compiledTemplate.code)(Vue) as Vue.RenderFunction

const managedEffect: LogoEffectDescriptor = {
  logoUrl: '/_site-logo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/logo.png',
  particleUrl: '/_site-logo/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/particle.bin',
  staticUrl: '/_site-logo/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc/effect.png',
  width: 800,
  height: 400,
  aspect: 2,
  count: 4000,
  medianStroke: 10,
  auraColor: '#336699'
}

const passthrough = (tag: string) =>
  Vue.defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => Vue.h(tag, attrs, slots.default?.())
    }
  })

const VAvatarStub = Vue.defineComponent({
  name: 'VAvatarStub',
  inheritAttrs: false,
  setup(_props, { slots }) {
    return () => slots.default?.()
  }
})

const conditionalPassthrough = (tag: string) =>
  Vue.defineComponent({
    inheritAttrs: false,
    props: { modelValue: { type: Boolean, default: false } },
    setup(props, { attrs, slots }) {
      return () => (props.modelValue ? Vue.h(tag, attrs, slots.default?.()) : null)
    }
  })

const LoginParticleLogoStub = Vue.defineComponent({
  name: 'LoginParticleLogo',
  props: { effect: { type: [Object, null] as Vue.PropType<LogoEffectDescriptor | null>, required: true } },
  setup(props) {
    return () =>
      props.effect
        ? Vue.h(
            'div',
            {
              class: 'login-particle-logo',
              'aria-hidden': 'true',
              'data-static-url': props.effect.staticUrl
            },
            [
              Vue.h('div', { class: 'login-particle-logo__stage' }, [
                Vue.h('canvas', { class: 'login-logo-particle-scene', 'aria-hidden': 'true' }),
                Vue.h('img', {
                  class: 'login-particle-logo__image',
                  src: props.effect.staticUrl,
                  alt: '',
                  'aria-hidden': 'true',
                  draggable: 'false'
                })
              ])
            ]
          )
        : null
  }
})

const components: Record<string, Vue.Component> = {
  LoginParticleLogo: LoginParticleLogoStub,
  Loader: Vue.defineComponent({ setup: () => () => null }),
  Notify: Vue.defineComponent({ setup: () => () => null }),
  PasswordStrength: Vue.defineComponent({ setup: () => () => null }),
  VAlert: Vue.defineComponent({ setup: () => () => null }),
  VApp: passthrough('div'),
  VAvatar: VAvatarStub,
  VBtn: passthrough('button'),
  VCard: passthrough('section'),
  VDialog: conditionalPassthrough('div'),
  VDivider: passthrough('hr'),
  VIcon: passthrough('span'),
  VList: passthrough('div'),
  VListItem: passthrough('div'),
  VTextField: Vue.defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs }) {
      return () => Vue.h('input', attrs)
    }
  })
}

const compiledLoginComponent = `${compiledScript.content}
export default __login__
`
const loginBundle = await Bun.build({
  entrypoints: ['virtual:login.vue'],
  external: [
    'vue',
    'js-cookie',
    '@/store/index.ts',
    '../helpers/auth-api',
    '../helpers/root-ui-store',
    '../helpers/tfa-qr',
    './login-logo/LoginParticleLogo.vue',
    './login-logo/particle-logo'
  ],
  format: 'cjs',
  plugins: [
    {
      name: 'login-layout-test-sfc',
      setup(build) {
        build.onResolve({ filter: /^virtual:login\.vue$/ }, args => ({
          namespace: 'login-layout-test-sfc',
          path: args.path
        }))
        build.onLoad({ filter: /.*/, namespace: 'login-layout-test-sfc' }, () => ({
          contents: compiledLoginComponent,
          loader: 'ts',
          resolveDir: path.dirname(loginPath)
        }))
      }
    }
  ],
  target: 'bun'
})
if (!loginBundle.success || loginBundle.outputs.length !== 1) {
  throw new Error(`Could not bundle login.vue: ${loginBundle.logs.map(log => log.message).join(', ')}`)
}
const loginBundleCode = await loginBundle.outputs[0].text()
const loginModuleStart = loginBundleCode.indexOf('(function(')
if (loginModuleStart < 0) throw new Error('Compiled login.vue did not produce a CommonJS module')
interface CompiledLoginModule {
  exports: { default?: Vue.Component }
}
const loginModuleFactory = new Function(`return ${loginBundleCode.slice(loginModuleStart)}`)() as (
  exports: CompiledLoginModule['exports'],
  require: (specifier: string) => unknown,
  module: CompiledLoginModule,
  filename: string,
  dirname: string
) => void
const compiledLoginModule: CompiledLoginModule = { exports: {} }
loginModuleFactory(
  compiledLoginModule.exports,
  specifier => {
    if (specifier === 'vue') return Vue
    if (specifier === 'js-cookie') {
      return { __esModule: true, default: { get: () => undefined, remove: () => undefined, set: () => undefined } }
    }
    if (specifier === '@/store/index.ts') {
      return { wikiStore: { showNotification: () => undefined, startLoading: () => undefined, stopLoading: () => undefined } }
    }
    if (specifier === '../helpers/auth-api') {
      return {
        fetchAuthStrategies: async () => [],
        submitAuthRequest: async () => ({}),
        submitStatusRequest: async () => undefined
      }
    }
    if (specifier === '../helpers/root-ui-store') return { getErrorMessage: () => '' }
    if (specifier === '../helpers/tfa-qr') return { sanitizeTfaQrImage: () => '' }
    if (specifier === './login-logo/LoginParticleLogo.vue') {
      return { __esModule: true, default: LoginParticleLogoStub }
    }
    if (specifier === './login-logo/particle-logo') return { isLogoEffectDescriptor }
    throw new Error(`Unexpected import in login.vue: ${specifier}`)
  },
  compiledLoginModule,
  loginPath,
  path.dirname(loginPath)
)
const Login = compiledLoginModule.exports.default
if (!Login) throw new Error('login.vue did not export a component')
Object.assign(Login, { render: renderLogin })

const renderLoginDom = async (effect: LogoEffectDescriptor | null): Promise<JSDOM> => {
  const component = Vue.defineComponent({
    name: 'LoginLayoutBehaviorHarness',
    components,
    data: () => ({
      errorShown: false,
      fieldErrors: { username: '', password: '', newPassword: '', newPasswordVerify: '' },
      filteredStrategies: [
        {
          key: 'local',
          displayName: 'Local',
          order: 0,
          selfRegistration: true,
          strategy: { useForm: true, usernameType: 'email', color: '', icon: '' }
        }
      ],
      hideNewPassword: true,
      hideNewPasswordVerify: true,
      hidePassword: true,
      isLoading: false,
      isTFASetupShown: false,
      isTFAShown: false,
      isUsernameEmail: true,
      loaderColor: 'grey-darken-4',
      loaderTitle: 'Working...',
      loginStyle: {},
      logoEffect: effect,
      logoUrl: managedEffect.logoUrl,
      newPassword: '',
      newPasswordVerify: '',
      password: '',
      screen: 'login',
      securityCode: '',
      securityCodeError: '',
      selectedStrategy: {
        key: 'local',
        displayName: 'Local',
        order: 0,
        selfRegistration: true,
        strategy: { useForm: true, usernameType: 'email', color: '', icon: '' }
      },
      selectedStrategyKey: 'local',
      selectedStrategyKeys: ['local'],
      siteTitle: 'Example knowledge base',
      successMessage: '',
      tfaQRImage: '',
      tfaSecret: '',
      username: ''
    }),
    render: renderLogin
  })
  const app = Vue.createSSRApp(component)
  app.config.globalProperties.$t = (key: string): string => key
  const html = await renderToString(app)
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'http://localhost/login' })
}

const renderConfiguredLoginDom = async (logoUrl: string, logoEffect: LogoEffectDescriptor): Promise<JSDOM> => {
  const previousSiteConfig = Object.getOwnPropertyDescriptor(globalThis, 'siteConfig')
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'siteConfig', {
    configurable: true,
    value: { title: 'Example knowledge base', logoUrl, logoEffect }
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { search: '' } }
  })

  try {
    const app = Vue.createSSRApp(Login)
    for (const [name, component] of Object.entries(components)) app.component(name, component)
    app.config.globalProperties.$t = (key: string): string => key
    const html = await renderToString(app)
    return new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'http://localhost/login' })
  } finally {
    if (previousSiteConfig) Object.defineProperty(globalThis, 'siteConfig', previousSiteConfig)
    else Reflect.deleteProperty(globalThis, 'siteConfig')
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

describe('login personalized static-logo integration', () => {
  it('renders the decorative field as the direct sibling immediately after the unchanged login card', async () => {
    const dom = await renderLoginDom(managedEffect)
    const document = dom.window.document
    const login = document.querySelector<HTMLElement>('.login')
    const card = document.querySelector<HTMLElement>('main.login-sd')
    const field = document.querySelector<HTMLElement>('.login-particle-logo')
    if (!login || !card || !field) throw new Error('Managed login composition was not rendered')

    expect(document.querySelectorAll('.login-particle-logo')).toHaveLength(1)
    expect(login.firstElementChild).toBe(card)
    expect(card.nextElementSibling).toBe(field)
    expect(field.parentElement).toBe(login)
    expect(field.closest('main, form, [role="dialog"], .login-dialog-card')).toBeNull()
    expect(card.contains(field)).toBe(false)
    expect(document.querySelector('.login-brand')?.contains(field)).toBe(false)
    expect(document.querySelector('.login-form')?.contains(field)).toBe(false)
    expect(document.querySelector('[role="dialog"]')?.contains(field) ?? false).toBe(false)
    expect(field.dataset.staticUrl).toBe(managedEffect.staticUrl)

    expect(field.getAttribute('aria-hidden')).toBe('true')
    expect(field.querySelector('[role], [aria-live], title, [title]')).toBeNull()
    expect(field.querySelector('[aria-label], [aria-labelledby], [aria-describedby]')).toBeNull()
    expect(field.querySelector('[tabindex], a[href], button, input, select, textarea, summary, [contenteditable]')).toBeNull()
    expect(field.querySelector('[onkeydown], [onkeyup], [onkeypress]')).toBeNull()
    const decorativeImage = field.querySelector<HTMLImageElement>('img.login-particle-logo__image')
    const decorativeCanvas = field.querySelector<HTMLCanvasElement>('canvas.login-logo-particle-scene')
    expect(decorativeImage?.getAttribute('alt')).toBe('')
    expect(decorativeImage?.getAttribute('aria-hidden')).toBe('true')
    expect(decorativeCanvas?.getAttribute('aria-hidden')).toBe('true')

    const ordinaryLogo = card.querySelector<HTMLImageElement>('.login-brand .login-logo img')
    const title = card.querySelector<HTMLElement>('#login-site-title')
    const username = card.querySelector<HTMLInputElement>('form.login-form input[name="username"]')
    const password = card.querySelector<HTMLInputElement>('form.login-form input[name="password"]')
    const submit = card.querySelector<HTMLButtonElement>('form.login-form button[type="submit"]')
    const ordinarySequence = [ordinaryLogo, title, username, password, submit]
    expect(ordinarySequence.every((element): element is HTMLElement => element !== null)).toBe(true)
    for (let index = 1; index < ordinarySequence.length; index += 1) {
      expect(ordinarySequence[index - 1]!.compareDocumentPosition(ordinarySequence[index]!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    }
    expect(ordinaryLogo?.getAttribute('src')).toBe(managedEffect.logoUrl)
    expect(ordinaryLogo?.getAttribute('alt')).toBe('')
    expect(title?.textContent).toBe('Example knowledge base')
    expect(card.compareDocumentPosition(field) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)

    const plainDom = await renderLoginDom(null)
    expect(card.outerHTML).toBe(plainDom.window.document.querySelector('main.login-sd')?.outerHTML)
    plainDom.window.close()

    dom.window.close()
  })

  it('renders only the structurally valid descriptor bound to the current site logo', async () => {
    const staleEffect: LogoEffectDescriptor = {
      ...managedEffect,
      logoUrl: '/_site-logo/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/logo.png'
    }
    expect(isLogoEffectDescriptor(staleEffect)).toBe(true)

    const staleDom = await renderConfiguredLoginDom(managedEffect.logoUrl, staleEffect)
    expect(staleDom.window.document.querySelector('.login-particle-logo')).toBeNull()
    expect(staleDom.window.document.querySelector<HTMLImageElement>('.login-brand .login-logo img')?.getAttribute('src')).toBe(managedEffect.logoUrl)
    staleDom.window.close()

    const currentDom = await renderConfiguredLoginDom(managedEffect.logoUrl, managedEffect)
    expect(currentDom.window.document.querySelector<HTMLElement>('.login-particle-logo')?.dataset.staticUrl).toBe(managedEffect.staticUrl)
    currentDom.window.close()
  })

  it('keeps the ordinary brand and authentication form when there is no managed effect', async () => {
    const dom = await renderLoginDom(null)
    const document = dom.window.document
    const card = document.querySelector<HTMLElement>('main.login-sd')
    if (!card) throw new Error('Login card was not rendered')

    expect(document.querySelector('.login-particle-logo')).toBeNull()
    expect(card.querySelector<HTMLImageElement>('.login-brand .login-logo img')?.getAttribute('src')).toBe(managedEffect.logoUrl)
    expect(card.querySelector('#login-site-title')?.textContent).toBe('Example knowledge base')
    expect(card.querySelector('form.login-form input[name="username"]')).not.toBeNull()
    expect(card.querySelector('form.login-form input[name="password"]')).not.toBeNull()
    expect(card.querySelector('form.login-form button[type="submit"]')).not.toBeNull()

    dom.window.close()
  })
})

describe('login particle decoration accessibility and privacy hardening', () => {
  it('keeps production decoration hidden from accessibility and keyboard interaction', () => {
    expect(particleLogoComponent.template).toMatch(/\.login-particle-logo\([\s\S]*?\baria-hidden="true"[\s\S]*?\)/)
    expect(particleLogoComponent.template).toMatch(/img\.login-particle-logo__image\([\s\S]*?\balt=""[\s\S]*?\baria-hidden="true"[\s\S]*?\)/)
    expect(particleSceneComponent.template).toMatch(/<TresCanvas[\s\S]*?\bclass="login-logo-particle-scene"[\s\S]*?\baria-hidden="true"/)

    const decorativeTemplates = `${particleLogoComponent.template}\n${particleSceneComponent.template}`
    expect(decorativeTemplates).not.toMatch(
      /(?:^|[\s(])(?:role|aria-live|aria-atomic|aria-relevant|aria-label|aria-labelledby|aria-describedby|title|tabindex|@key(?:down|up|press))(?=\s|=|\))/im
    )
    expect(decorativeTemplates).not.toMatch(
      /<(?:a|button|input|select|textarea|summary)\b|(?:^|\n)\s*(?:a|button|input|select|textarea|summary|v-btn|v-text-field|v-select|v-checkbox|v-switch)(?:[.#(\s]|$)/im
    )
    const decorativeSources = [particleLogoComponent.source, particleSceneComponent.source, pointerControllerSource].join('\n')
    expect(decorativeSources).not.toMatch(/\b(?:KeyboardEvent|keydown|keyup|keypress|onkeydown|onkeyup|onkeypress)\b/)
    expect(decorativeSources).not.toMatch(
      /['"`](?:role|aria-live|aria-atomic|aria-relevant|aria-label|aria-labelledby|aria-describedby|title|tabindex)['"`]\s*(?:,|\))/
    )
    expect(`${loginSource}\n${particleLogoComponent.script}`).not.toMatch(
      /\b(?:PointerEvent|pointermove|pointerleave|pointerenter|pointerdown|pointerup|clientX|clientY)\b/
    )
  })

  it('permits only an anonymous same-origin particle fetch and forbids pointer telemetry or credential access', () => {
    const enhancementSources = [particleLogoComponent.source, particleSceneComponent.source, pointerControllerSource].join('\n')
    const fetchCalls = enhancementSources.match(/\bfetch\s*\(/g) ?? []
    expect(fetchCalls).toHaveLength(1)
    expect(particleLogoComponent.script).toMatch(/new URL\(\s*effect\.particleUrl\s*,\s*window\.location\.href\s*\)/)
    expect(particleLogoComponent.script).toMatch(/particleUrl\.origin\s*!==\s*window\.location\.origin/)

    const particleRequest = particleLogoComponent.script.match(/\bfetch\(\s*effect\.particleUrl\s*,\s*\{([\s\S]*?)\}\s*\)/)
    expect(particleRequest).not.toBeNull()
    const requestOptions = [...(particleRequest?.[1].matchAll(/^\s*(\w+)\s*:/gm) ?? [])].map(match => match[1]).sort()
    expect(requestOptions).toEqual(['credentials', 'signal'])
    expect(particleRequest?.[1]).toMatch(/\bcredentials\s*:\s*['"]omit['"]/)
    expect(enhancementSources.match(/\bcredentials\s*:/g) ?? []).toHaveLength(1)
    for (const urlKey of ['logoUrl', 'particleUrl', 'staticUrl'] as const) {
      expect(isLogoEffectDescriptor({ ...managedEffect, [urlKey]: `https://example.test/${urlKey}` })).toBe(false)
      expect(isLogoEffectDescriptor({ ...managedEffect, [urlKey]: `//example.test/${urlKey}` })).toBe(false)
    }

    expect(enhancementSources).not.toMatch(/\b(?:username|password|securityCode|authorization|document\.cookie|localStorage|sessionStorage|FormData)\b/i)
    expect(enhancementSources).not.toMatch(
      /\b(?:console\.(?:debug|info|log|warn|error|trace)|navigator\.sendBeacon|sendBeacon|XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection|postMessage|BroadcastChannel)\b/
    )
    expect(enhancementSources).not.toMatch(/\b(?:analytics|telemetry|trackEvent|captureEvent)\b/i)
    expect(enhancementSources).not.toMatch(/\b(?:https?|wss?):\/\/|(?:^|['"`])\s*\/\/[^/'"`\s]|(?:data|javascript):/im)
  })
})
