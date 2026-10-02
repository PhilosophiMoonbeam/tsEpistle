import fs from 'node:fs'
import path from 'node:path'

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import { JSDOM } from 'jsdom'
import { resetBody } from '../../test/browser-dom.mts'
import * as Vue from 'vue'
import { describe, expect, it } from '../../../server/test/bun-test.mts'
import { isLogoEffectDescriptor, type LogoEffectDescriptor } from './particle-logo.ts'

resetBody()

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
const loaderPath = path.join(process.cwd(), 'client/components/common/loader.vue')
const loaderSource = fs.readFileSync(loaderPath, 'utf8')

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
  pipelineVersion: 7,
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
let animationInstanceSequence = 0
let mountedAnimationCount = 0
let unmountedAnimationCount = 0

const resetAnimationLifecycle = (): void => {
  animationInstanceSequence = 0
  mountedAnimationCount = 0
  unmountedAnimationCount = 0
}

const LoginSuccessAnimationStub = Vue.defineComponent({
  name: 'LoginSuccessAnimation',
  setup: () => {
    const instanceId = String(++animationInstanceSequence)
    Vue.onMounted(() => {
      mountedAnimationCount += 1
    })
    Vue.onUnmounted(() => {
      unmountedAnimationCount += 1
    })
    return () =>
      Vue.h('svg', {
        class: 'login-success-animation',
        width: '72',
        height: '72',
        role: 'presentation',
        'aria-hidden': 'true',
        focusable: 'false',
        'data-instance-id': instanceId
      })
  }
})

const LoginLoaderStub = Vue.defineComponent({
  name: 'LoginLoaderStub',
  inheritAttrs: false,
  props: {
    modelValue: { type: Boolean, default: false },
    title: { type: String, default: '' }
  },
  setup(props, { slots }) {
    return () => {
      if (!props.modelValue) return null
      return Vue.h('div', { class: 'loader-dialog' }, [Vue.h('span', { class: 'loader-dialog-title' }, props.title), ...(slots.illustration?.() ?? [])])
    }
  }
})

// The shared auth shell is rendered for real: the login layout contract is its DOM.
const authShellPath = path.join(process.cwd(), 'client/components/common/auth-shell.vue')
const authShellParsed = parse(fs.readFileSync(authShellPath, 'utf8'), { filename: authShellPath })
if (authShellParsed.errors.length > 0 || !authShellParsed.descriptor.script || !authShellParsed.descriptor.template) {
  throw new Error('auth-shell.vue script or template was not found')
}
const authShellScript = compileScript(authShellParsed.descriptor, { id: 'login-layout-auth-shell', genDefaultAs: '__authShell__' })
const authShellTemplate = compileTemplate({
  source: authShellParsed.descriptor.template.content,
  filename: authShellPath,
  id: 'login-layout-auth-shell',
  preprocessLang: authShellParsed.descriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  transformAssetUrls: false,
  compilerOptions: { bindingMetadata: authShellScript.bindings, expressionPlugins: ['typescript'] }
})
if (authShellTemplate.errors.length > 0) throw new Error(`Could not compile auth-shell.vue: ${authShellTemplate.errors.join(', ')}`)
const authShellModule = await import(
  'data:text/javascript;base64,' +
    Buffer.from(
      new Bun.Transpiler({ loader: 'ts' }).transformSync(
        `${authShellScript.content}\n${authShellTemplate.code}\n__authShell__.render = render\nexport default __authShell__`
      )
    ).toString('base64')
)
const AuthShell = authShellModule.default as Vue.Component

const components: Record<string, Vue.Component> = {
  AuthShell,
  LoginParticleLogo: LoginParticleLogoStub,
  LoginSuccessAnimation: LoginSuccessAnimationStub,
  Loader: LoginLoaderStub,
  Notify: Vue.defineComponent({ setup: () => () => null }),
  PasswordStrength: Vue.defineComponent({ setup: () => () => null }),
  PasswordVisibilityToggle: Vue.defineComponent({
    props: { visible: { type: Boolean, default: false }, field: { type: String, default: '' } },
    setup: props => () => Vue.h('button', { type: 'button', 'aria-pressed': String(props.visible) }, props.field)
  }),
  VAlert: Vue.defineComponent({ setup: () => () => null }),
  VApp: passthrough('div'),
  VAvatar: VAvatarStub,
  VBtn: passthrough('button'),
  VCard: passthrough('section'),
  VDialog: conditionalPassthrough('div'),
  VDivider: passthrough('hr'),
  VIcon: passthrough('span'),
  VList: passthrough('div'),
  VListItem: Vue.defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => Vue.h('div', attrs, [...(slots.prepend?.() ?? []), ...(slots.default?.() ?? [])])
    }
  }),
  VTextField: Vue.defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs }) {
      return () => Vue.h('input', attrs)
    }
  })
}

type TestHostNode = {
  kind: 'element' | 'text' | 'comment'
  type: string
  props: Record<string, unknown>
  style: { display: string }
  children: TestHostNode[]
  parent: TestHostNode | null
  text: string
}

const createTestHostNode = (kind: TestHostNode['kind'], type = ''): TestHostNode => ({
  kind,
  type,
  props: {},
  style: { display: '' },
  children: [],
  parent: null,
  text: ''
})

const testRenderer = Vue.createRenderer<TestHostNode, TestHostNode>({
  patchProp(element, key, _previousValue, nextValue) {
    if (nextValue === null || nextValue === undefined) delete element.props[key]
    else element.props[key] = nextValue
  },
  insert(element, parent, anchor = null) {
    if (element.parent) {
      const previousIndex = element.parent.children.indexOf(element)
      if (previousIndex >= 0) element.parent.children.splice(previousIndex, 1)
    }
    element.parent = parent
    const anchorIndex = anchor ? parent.children.indexOf(anchor) : -1
    if (anchorIndex < 0) parent.children.push(element)
    else parent.children.splice(anchorIndex, 0, element)
  },
  remove(element) {
    if (!element.parent) return
    const index = element.parent.children.indexOf(element)
    if (index >= 0) element.parent.children.splice(index, 1)
    element.parent = null
  },
  createElement(type) {
    return createTestHostNode('element', type)
  },
  createText(text) {
    const node = createTestHostNode('text')
    node.text = text
    return node
  },
  createComment(text) {
    const node = createTestHostNode('comment')
    node.text = text
    return node
  },
  setText(node, text) {
    node.text = text
  },
  setElementText(element, text) {
    for (const child of element.children) child.parent = null
    const textNode = createTestHostNode('text')
    textNode.text = text
    textNode.parent = element
    element.children = [textNode]
  },
  parentNode(node) {
    return node.parent
  },
  nextSibling(node) {
    if (!node.parent) return null
    return node.parent.children[node.parent.children.indexOf(node) + 1] ?? null
  },
  querySelector() {
    return null
  },
  setScopeId() {},
  cloneNode(node) {
    const clone = createTestHostNode(node.kind, node.type)
    clone.props = { ...node.props }
    clone.style = { ...node.style }
    clone.text = node.text
    return clone
  },
  insertStaticContent(text, parent, anchor) {
    const node = createTestHostNode('text')
    node.text = text
    node.parent = parent
    const anchorIndex = anchor ? parent.children.indexOf(anchor) : -1
    if (anchorIndex < 0) parent.children.push(node)
    else parent.children.splice(anchorIndex, 0, node)
    return [node, node]
  }
})

const findTestHostNode = (root: TestHostNode, predicate: (node: TestHostNode) => boolean): TestHostNode | null => {
  if (predicate(root)) return root
  for (const child of root.children) {
    const match = findTestHostNode(child, predicate)
    if (match) return match
  }
  return null
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
    '../helpers/password-policy.ts',
    '../../shared/security-policy.ts',
    '../helpers/auth-api',
    '../helpers/root-ui-store',
    '../helpers/tfa-qr',
    './login-logo/LoginParticleLogo.vue',
    './login-success-animation.vue',
    './common/auth-shell.vue',
    './common/password-strength.vue',
    './common/password-visibility-toggle.vue',
    './login-logo/particle-logo'
  ],
  format: 'cjs',
  plugins: [
    {
      name: 'login-layout-test-sfc',
      setup(build) {
        build.onResolve({ filter: /^virtual:login\.vue$/ }, () => ({
          namespace: 'login-layout-test-sfc',
          path: loginPath
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
if (!loginBundle.success) {
  throw new Error(`Could not bundle login.vue: ${loginBundle.logs.map(log => log.message).join(', ')}`)
}
const loginBundleOutput = loginBundle.outputs.find(output => output.kind === 'entry-point')
if (!loginBundleOutput) throw new Error('Compiled login.vue did not produce an entry-point module')
const loginBundleCode = await loginBundleOutput.text()
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
    if (specifier === '../helpers/password-policy.ts') return { passwordPolicyMixin: {} }
    if (specifier === '../../shared/security-policy.ts') return { newPasswordIssue: () => null }
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
    if (specifier === './login-success-animation.vue') {
      return { __esModule: true, default: LoginSuccessAnimationStub }
    }
    if (specifier === './login-logo/particle-logo') return { isLogoEffectDescriptor }
    if (specifier === './common/auth-shell.vue') return { __esModule: true, default: AuthShell }
    if (specifier === './common/password-strength.vue') return { __esModule: true, default: components.PasswordStrength }
    if (specifier === './common/password-visibility-toggle.vue') return { __esModule: true, default: components.PasswordVisibilityToggle }
  },
  compiledLoginModule,
  loginPath,
  path.dirname(loginPath)
)
const Login = compiledLoginModule.exports.default
if (!Login) throw new Error('login.vue did not export a component')
Object.assign(Login, { render: renderLogin })

const parsedLoader = parse(loaderSource, { filename: loaderPath })
if (parsedLoader.errors.length > 0 || !parsedLoader.descriptor.script || !parsedLoader.descriptor.template) {
  throw new Error('Loader script or template was not found')
}
const loaderId = 'loader-illustration-behavior-test'
const loaderScript = compileScript(parsedLoader.descriptor, { id: loaderId, genDefaultAs: '__loader__' })
const loaderTemplate = compileTemplate({
  source: parsedLoader.descriptor.template.content,
  filename: loaderPath,
  id: loaderId,
  preprocessLang: parsedLoader.descriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  transformAssetUrls: false,
  compilerOptions: { mode: 'function', bindingMetadata: loaderScript.bindings, expressionPlugins: ['typescript'] }
})
if (loaderTemplate.errors.length > 0) throw new Error(`Could not compile Loader template: ${loaderTemplate.errors.join(', ')}`)
const loaderBundle = await Bun.build({
  entrypoints: ['virtual:loader.vue'],
  external: ['vue', 'epic-spinners'],
  format: 'cjs',
  plugins: [{
    name: 'loader-illustration-test-sfc',
    setup(build) {
      build.onResolve({ filter: /^virtual:loader\.vue$/ }, () => ({ namespace: 'loader-test-sfc', path: loaderPath }))
      build.onLoad({ filter: /.*/, namespace: 'loader-test-sfc' }, () => ({
        contents: `${loaderScript.content}\nexport default __loader__\n`,
        loader: 'ts',
        resolveDir: path.dirname(loaderPath)
      }))
    }
  }],
  target: 'bun'
})
if (!loaderBundle.success) throw new Error(`Could not bundle Loader: ${loaderBundle.logs.map(log => log.message).join(', ')}`)
const loaderOutput = loaderBundle.outputs.find(output => output.kind === 'entry-point')
if (!loaderOutput) throw new Error('Loader bundle entry point was not found')
const loaderCode = await loaderOutput.text()
const loaderModuleStart = loaderCode.indexOf('(function(')
if (loaderModuleStart < 0) throw new Error('Compiled Loader did not produce a CommonJS module')
const loaderFactory = new Function(`return ${loaderCode.slice(loaderModuleStart)}`)() as typeof loginModuleFactory
const loaderModule: CompiledLoginModule = { exports: {} }
loaderFactory(loaderModule.exports, specifier => {
  if (specifier === 'vue') return Vue
  if (specifier === 'epic-spinners') return {
    AtomSpinner: Vue.defineComponent({ setup: () => () => Vue.h('div', { 'data-loader-spinner': '' }) })
  }
  throw new Error(`Unexpected Loader import: ${specifier}`)
}, loaderModule, loaderPath, path.dirname(loaderPath))
const Loader = loaderModule.exports.default
if (!Loader) throw new Error('Loader did not export a component')
Object.assign(Loader, {
  render: new Function('Vue', loaderTemplate.code)(Vue) as Vue.RenderFunction
})

const createLoginHarness = (
  effect: LogoEffectDescriptor | null,
  initialLoading = false,
  initialLoaderTitle = 'Working...',
  strategies?: Array<{
    key: string
    displayName: string
    order: number
    selfRegistration: boolean
    strategy: { useForm: boolean; usernameType: string; color: string; icon: string; logo?: string }
  }>
) =>
  Vue.defineComponent({
    name: 'LoginLayoutBehaviorHarness',
    components,
    data: () => ({
      errorShown: false,
      fieldErrors: { username: '', password: '', newPassword: '', newPasswordVerify: '' },
      filteredStrategies: strategies ?? [
        {
          key: 'local',
          displayName: 'Local',
          order: 0,
          selfRegistration: true,
          strategy: { useForm: true, usernameType: 'email', color: '', icon: '' }
        }
      ],
      showNewPassword: false,
      showNewPasswordVerify: false,
      showPassword: false,
      showRegisterLink: true,
      eyebrow: 'auth:signIn',
      isLoading: initialLoading,
      isTFASetupShown: false,
      isTFAShown: false,
      isUsernameEmail: true,
      loaderColor: 'surface',
      loaderTitle: initialLoaderTitle,
      backgroundUrl: '',
      logoEffect: effect,
      logoImageFailed: false,
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
    methods: {
      cancelContinuation: () => undefined,
      forgotPassword: () => undefined
    },
    render: renderLogin
  })

const renderLoginDom = async (effect: LogoEffectDescriptor | null, strategies?: Parameters<typeof createLoginHarness>[3]): Promise<JSDOM> => {
  const app = Vue.createSSRApp(createLoginHarness(effect, false, 'Working...', strategies))
  app.config.globalProperties.$t = (key: string): string => key
  const html = await renderToString(app)
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'http://localhost/login' })
}

type LoginLifecycleHarness = {
  isLoading: boolean
  loaderTitle: string
}

const mountLoginLifecycle = async () => {
  resetAnimationLifecycle()
  const host = createTestHostNode('element', 'root')
  const app = testRenderer.createApp(createLoginHarness(null))
  app.config.globalProperties.$t = (key: string): string => key
  const vm = app.mount(host) as unknown as LoginLifecycleHarness
  await Vue.nextTick()
  return { app, host, vm }
}

const resolveConfiguredLogoEffect = (logoUrl: string, logoEffect: LogoEffectDescriptor): LogoEffectDescriptor | null => {
  const previousSiteConfig = Object.getOwnPropertyDescriptor(globalThis, 'siteConfig')
  Object.defineProperty(globalThis, 'siteConfig', {
    configurable: true,
    value: { title: 'Example knowledge base', logoUrl, logoEffect }
  })
  try {
    const options = Login as unknown as { computed: { logoEffect: () => LogoEffectDescriptor | null } }
    return options.computed.logoEffect.call({})
  } finally {
    if (previousSiteConfig) Object.defineProperty(globalThis, 'siteConfig', previousSiteConfig)
    else Reflect.deleteProperty(globalThis, 'siteConfig')
  }
}

describe('login personalized static-logo integration', () => {
  it('renders provider logos supplied by the authentication API and falls back to an icon', async () => {
    const dom = await renderLoginDom(null, [
      {
        key: 'dropbox',
        displayName: 'Dropbox',
        order: 0,
        selfRegistration: false,
        strategy: { useForm: false, usernameType: 'email', color: 'blue', icon: '', logo: 'https://static.requarks.io/logo/dropbox.svg' }
      },
      {
        key: 'local',
        displayName: 'Backend',
        order: 1,
        selfRegistration: false,
        strategy: { useForm: true, usernameType: 'email', color: 'primary', icon: '', logo: '/_assets/svg/icon-tsepistle.svg' }
      },
      {
        key: 'custom',
        displayName: 'Custom',
        order: 2,
        selfRegistration: false,
        strategy: { useForm: false, usernameType: 'email', color: 'primary', icon: 'mdi-login' }
      }
    ])
    const providerList = dom.window.document.querySelector('.login-list')
    expect(Array.from(providerList?.querySelectorAll('img') ?? []).map(image => image.getAttribute('src'))).toEqual([
      'https://static.requarks.io/logo/dropbox.svg',
      '/_assets/svg/icon-tsepistle.svg'
    ])
    expect(providerList?.textContent).toContain('mdi-login')
  })

  it('renders the decorative field as the direct sibling immediately after the unchanged login card', async () => {
    const dom = await renderLoginDom(managedEffect)
    const document = dom.window.document
    const login = document.querySelector<HTMLElement>('.login')
    const card = document.querySelector<HTMLElement>('main.auth-shell__card')
    const field = document.querySelector<HTMLElement>('.login-particle-logo')
    if (!login || !card || !field) throw new Error('Managed login composition was not rendered')

    expect(document.querySelectorAll('.login-particle-logo')).toHaveLength(1)
    expect(login.firstElementChild).toBe(card)
    expect(card.nextElementSibling).toBe(field)
    expect(field.parentElement).toBe(login)
    expect(field.closest('main, form, [role="dialog"], .login-dialog-card')).toBeNull()
    expect(card.contains(field)).toBe(false)
    expect(document.querySelector('.auth-shell__brand')?.contains(field)).toBe(false)
    expect(document.querySelector('.login-form')?.contains(field)).toBe(false)
    expect(document.querySelector('[role="dialog"]')?.contains(field) ?? false).toBe(false)

    const ordinaryLogo = card.querySelector<HTMLImageElement>('.auth-shell__brand .auth-shell__logo img')
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
    const logoFrame = card.querySelector<HTMLElement>('.auth-shell__brand .auth-shell__logo')
    expect(logoFrame).not.toBeNull()
    expect(logoFrame?.querySelector('img')).toBe(ordinaryLogo)

    dom.window.close()
  })

  it('accepts only a valid descriptor bound to the current site logo', () => {
    const staleEffect: LogoEffectDescriptor = {
      ...managedEffect,
      logoUrl: '/_site-logo/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/logo.png'
    }
    expect(isLogoEffectDescriptor(staleEffect)).toBe(true)

    expect(resolveConfiguredLogoEffect(managedEffect.logoUrl, staleEffect)).toBeNull()
    expect(resolveConfiguredLogoEffect(managedEffect.logoUrl, { ...managedEffect, pipelineVersion: 6 })).not.toBeNull()
    expect(resolveConfiguredLogoEffect(managedEffect.logoUrl, managedEffect)).toBe(managedEffect)
    for (const invalidEffect of [
      { ...managedEffect, pipelineVersion: 8 },
      { ...managedEffect, count: 0 },
      { ...managedEffect, aspect: 1 },
      { ...managedEffect, particleUrl: '//example.test/particle.bin' }
    ]) {
      expect(resolveConfiguredLogoEffect(managedEffect.logoUrl, invalidEffect)).toBeNull()
    }
  })

  it('keeps the ordinary brand and authentication form when there is no managed effect', async () => {
    const dom = await renderLoginDom(null)
    const document = dom.window.document
    const card = document.querySelector<HTMLElement>('main.auth-shell__card')
    if (!card) throw new Error('Login card was not rendered')

    expect(document.querySelector('.login-particle-logo')).toBeNull()
    expect(card.querySelector<HTMLImageElement>('.auth-shell__brand .auth-shell__logo img')?.getAttribute('src')).toBe(managedEffect.logoUrl)
    expect(card.querySelector('#login-site-title')?.textContent).toBe('Example knowledge base')
    expect(card.querySelector('form.login-form input[name="username"]')).not.toBeNull()
    expect(card.querySelector('form.login-form input[name="password"]')).not.toBeNull()
    expect(card.querySelector('form.login-form button[type="submit"]')).not.toBeNull()

    dom.window.close()
  })
})
describe('login success illustration contract', () => {
  it('provides an optional Loader illustration slot without replacing fallback indicators', async () => {
    for (const mode of ['loading', 'icon'] as const) {
      for (const customIllustration of [false, true]) {
        const app = testRenderer.createApp({
          render: () => Vue.h(Loader, { modelValue: true, mode }, customIllustration
            ? { illustration: () => Vue.h('svg', { 'data-custom-illustration': '' }) }
            : undefined)
        })
        app.component('VDialog', conditionalPassthrough('div'))
        app.component('VCard', passthrough('section'))
        app.component('VCardText', passthrough('div'))
        app.component('VBtn', passthrough('button'))
        app.config.globalProperties.$t = (key: string): string => key
        const host = createTestHostNode('element', 'root')
        app.mount(host)
        try {
          await Vue.nextTick()
          const illustration = findTestHostNode(host, node => Object.hasOwn(node.props, 'data-custom-illustration'))
          const spinner = findTestHostNode(host, node => Object.hasOwn(node.props, 'data-loader-spinner'))
          const icon = findTestHostNode(host, node => node.kind === 'element' && node.type === 'img')
          if (customIllustration) expect(illustration).not.toBeNull()
          else expect(illustration).toBeNull()
          if (!customIllustration && mode === 'loading') expect(spinner).not.toBeNull()
          else expect(spinner).toBeNull()
          if (!customIllustration && mode === 'icon') expect(icon).not.toBeNull()
          else expect(icon).toBeNull()
        } finally {
          app.unmount()
        }
      }
    }
  })

  it('mounts one inline book on the first loading render and keeps it through the success title transition', async () => {
    const lifecycle = await mountLoginLifecycle()
    expect(findTestHostNode(lifecycle.host, node => node.props.class === 'login-success-animation')).toBeNull()
    expect(mountedAnimationCount).toBe(0)

    lifecycle.vm.loaderTitle = 'Signing in'
    lifecycle.vm.isLoading = true
    await Vue.nextTick()

    const firstBook = findTestHostNode(lifecycle.host, node => node.props.class === 'login-success-animation')
    const loadingTitle = findTestHostNode(lifecycle.host, node => node.props.class === 'loader-dialog-title')
    if (!firstBook || !loadingTitle) throw new Error('Login loading illustration was not rendered')
    expect(loadingTitle.children[0]?.text).toBe('Signing in')
    expect(mountedAnimationCount).toBe(1)
    expect(unmountedAnimationCount).toBe(0)

    lifecycle.vm.loaderTitle = 'Sign in successful'
    await Vue.nextTick()

    const successBook = findTestHostNode(lifecycle.host, node => node.props.class === 'login-success-animation')
    const successTitle = findTestHostNode(lifecycle.host, node => node.props.class === 'loader-dialog-title')
    expect(successBook).toBe(firstBook)
    expect(successBook?.props['data-instance-id']).toBe(firstBook.props['data-instance-id'])
    expect(successTitle?.children[0]?.text).toBe('Sign in successful')
    expect(mountedAnimationCount).toBe(1)
    expect(unmountedAnimationCount).toBe(0)

    lifecycle.vm.isLoading = false
    await Vue.nextTick()
    expect(findTestHostNode(lifecycle.host, node => node.props.class === 'login-success-animation')).toBeNull()
    expect(unmountedAnimationCount).toBe(1)
    lifecycle.app.unmount()
  })
})

describe('login particle decoration accessibility and privacy hardening', () => {
  it('keeps production decoration hidden from accessibility and keyboard interaction', () => {
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

describe('login account recovery and wayfinding', () => {
  type CancelState = Record<string, unknown> & { $refs: Record<string, unknown>; $nextTick: (callback: () => void) => void }
  const loginOptions = Login as unknown as {
    methods: { cancelContinuation: (this: CancelState) => void; clearError: (this: CancelState) => void }
  }
  const isRedirectedToLogin = (compiledLoginModule.exports as { isRedirectedToLogin?: (cookie: string | undefined, search: string) => boolean }).isRedirectedToLogin

  it('ends a pending two-factor step without keeping the continuation token, code, setup secret or password', () => {
    const focused: string[] = []
    const state: CancelState = {
      isLoading: false,
      focusTimer: null,
      isTFAShown: false,
      isTFASetupShown: true,
      continuationToken: 'continuation-secret',
      securityCode: '123456',
      securityCodeError: 'Invalid code',
      tfaQRImage: '<svg></svg>',
      tfaSecret: 'JBSWY3DPEHPK3PXP',
      tfaCopyStatus: 'Copied',
      password: 'correct horse battery',
      newPassword: 'draft',
      newPasswordVerify: 'draft',
      errorShown: true,
      errorMessage: 'Old',
      fieldErrors: {},
      screen: 'changePwd',
      selectedStrategy: { strategy: { useForm: true } },
      $refs: { iptPassword: { focus: () => focused.push('password') } },
      $nextTick: callback => callback()
    }
    state.clearError = loginOptions.methods.clearError.bind(state)
    loginOptions.methods.cancelContinuation.call(state)
    expect(state).toMatchObject({
      isTFAShown: false,
      isTFASetupShown: false,
      continuationToken: '',
      securityCode: '',
      securityCodeError: '',
      tfaQRImage: '',
      tfaSecret: '',
      password: '',
      newPassword: '',
      newPasswordVerify: '',
      errorShown: false,
      screen: 'login'
    })
    expect(focused).toEqual(['password'])
  })

  it('keeps a pending step while a verification request is still running', () => {
    const state = { isLoading: true, isTFAShown: true, continuationToken: 'continuation-secret' } as unknown as CancelState
    loginOptions.methods.cancelContinuation.call(state)
    expect(state.isTFAShown).toBe(true)
    expect(state.continuationToken).toBe('continuation-secret')
  })

  it('says "Login required" only when the visitor was redirected from a protected page', () => {
    if (!isRedirectedToLogin) throw new Error('login.vue did not export isRedirectedToLogin')
    expect(isRedirectedToLogin(undefined, '')).toBe(false)
    expect(isRedirectedToLogin('/', '')).toBe(false)
    expect(isRedirectedToLogin('/private/page', '')).toBe(true)
    expect(isRedirectedToLogin(undefined, '?redirect=%2Fdocs')).toBe(true)
    expect(isRedirectedToLogin(undefined, '?all')).toBe(false)
  })

  it('renders the registration link in the shared shell footer as one readable sentence', async () => {
    const dom = await renderLoginDom(null)
    const footer = dom.window.document.querySelector('main.auth-shell__card > footer.auth-shell__footer')
    const link = footer?.querySelector('a')
    expect(link?.getAttribute('href')).toBe('/register')
    expect(link?.textContent).toBe('auth:switchToRegister.link')
    expect(dom.window.document.querySelector('.auth-shell__eyebrow')?.textContent).toBe('auth:signIn')
  })
})
