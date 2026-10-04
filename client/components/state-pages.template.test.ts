import { describe, expect, it } from '../../server/test/bun-test.mts'
import { keyTranslator, renderTemplate } from '../test/render-template.mts'

const vuetify = (isRtl = false) => ({ locale: { isRtl } })
const action = (document: Document, key: string) =>
  [...document.querySelectorAll('[data-stub="v-btn"]')].find(button => button.textContent?.trim() === key)

describe('not found page recovery', () => {
  it('retains missing-path context, search and a home destination without granting creation', async () => {
    const { document } = await renderTemplate('client/components/not-found.vue', {
      $t: keyTranslator, $vuetify: vuetify(), requestedPath: '/en/missing-guide', editorHref: ''
    })
    expect(action(document, 'notfound.create')).toBeUndefined()
    expect(action(document, 'notfound.search')).toBeDefined()
    expect(action(document, 'notfound.gohome')?.getAttribute('href')).toBe('/')
    expect(document.querySelector('bdi')?.textContent).toBe('/en/missing-guide')
  })

  it('retains the server-authorized creation destination', async () => {
    const { document } = await renderTemplate('client/components/not-found.vue', {
      $t: keyTranslator, $vuetify: vuetify(), requestedPath: '/en/missing-guide', editorHref: '/e/en/missing-guide'
    })
    expect(action(document, 'notfound.create')?.getAttribute('href')).toBe('/e/en/missing-guide')
  })

  it('mirrors recovery direction in right-to-left locales', async () => {
    const { document } = await renderTemplate('client/components/not-found.vue', {
      $t: keyTranslator, $vuetify: vuetify(true), requestedPath: '', editorHref: ''
    })
    expect(action(document, 'notfound.goback')?.getAttribute('prepend-icon')).toBe('mdi-arrow-right')
    expect(document.querySelector('bdi')).toBeNull()
  })
})

describe('unauthorized page recovery', () => {
  const render = (showLogin: boolean, isRtl = false) =>
    renderTemplate('client/components/unauthorized.vue', { $t: keyTranslator, $vuetify: vuetify(isRtl), action: 'view', showLogin, loginHref: '/login' })

  it('offers the sign-in destination to anonymous visitors', async () => {
    const { document } = await render(true)
    expect(action(document, 'unauthorized.login')?.getAttribute('href')).toBe('/login')
    expect(action(document, 'unauthorized.gohome')?.getAttribute('href')).toBe('/')
    expect(document.body.textContent).toContain('unauthorized.action.view')
  })

  it('does not offer sign in to signed-in people', async () => {
    const { document } = await render(false, true)
    expect(action(document, 'unauthorized.login')).toBeUndefined()
    expect(action(document, 'unauthorized.goback')?.getAttribute('prepend-icon')).toBe('mdi-arrow-right')
    expect(action(document, 'unauthorized.gohome')?.getAttribute('href')).toBe('/')
  })
})
