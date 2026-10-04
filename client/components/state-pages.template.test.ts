import { describe, expect, it } from '../../server/test/bun-test.mts'
import { keyTranslator, renderTemplate } from '../test/render-template.mts'

// 404 and 403 state pages share the new-page action group: equal buttons,
// direction-aware back arrows, a route into search, and no stray Log in.

const vuetify = (isRtl = false) => ({ locale: { isRtl } })

const actionButtons = (document: Document) =>
  [...document.querySelectorAll('.newpage-actions > [data-stub="v-btn"]')]

describe('not found page', () => {
  it('offers search, home and back as one equal action group', async () => {
    const { document, html } = await renderTemplate('client/components/not-found.vue', { $t: keyTranslator, $vuetify: vuetify(), requestedPath: '/en/missing-guide' })
    const buttons = actionButtons(document)
    expect(buttons.map(button => button.textContent?.trim())).toEqual(['notfound.search', 'notfound.gohome', 'notfound.goback'])
    expect(buttons[0]?.getAttribute('variant')).toBe('flat')
    expect(new Set(buttons.map(button => button.getAttribute('size')))).toEqual(new Set(['large']))
    expect(buttons[1]?.getAttribute('href')).toBe('/')
    expect(buttons[2]?.getAttribute('prepend-icon')).toBe('mdi-arrow-left')
    expect(document.querySelector('.newpage-path bdi')?.textContent).toBe('/en/missing-guide')
    expect(html).toContain('data-stub="nav-header"')
    expect(html).toContain('data-stub="search-results"')
    expect(html).not.toContain('animated')
  })

  it('offers Create this page first only when the server allows it', async () => {
    const { document } = await renderTemplate('client/components/not-found.vue', {
      $t: keyTranslator,
      $vuetify: vuetify(),
      requestedPath: '/h/en/missing-guide',
      editorHref: '/e/en/missing-guide'
    })
    const buttons = actionButtons(document)
    expect(buttons.map(button => button.textContent?.trim())).toEqual(['notfound.create', 'notfound.search', 'notfound.gohome', 'notfound.goback'])
    expect(buttons[0]?.getAttribute('href')).toBe('/e/en/missing-guide')
    expect(buttons[0]?.getAttribute('variant')).toBe('flat')
    expect(buttons[1]?.getAttribute('variant')).toBe('outlined')
    expect(new Set(buttons.map(button => button.getAttribute('size')))).toEqual(new Set(['large']))
  })

  it('mirrors the back arrow in right-to-left locales', async () => {
    const { document } = await renderTemplate('client/components/not-found.vue', { $t: keyTranslator, $vuetify: vuetify(true), requestedPath: '' })
    expect(actionButtons(document)[2]?.getAttribute('prepend-icon')).toBe('mdi-arrow-right')
    expect(document.querySelector('.newpage-path')).toBeNull()
  })
})

describe('unauthorized page', () => {
  const render = (showLogin: boolean, isRtl = false) =>
    renderTemplate('client/components/unauthorized.vue', { $t: keyTranslator, $vuetify: vuetify(isRtl), action: 'view', showLogin, loginHref: '/login' })

  it('offers sign in first to anonymous visitors', async () => {
    const { document } = await render(true)
    const buttons = actionButtons(document)
    expect(buttons.map(button => button.textContent?.trim())).toEqual(['unauthorized.login', 'unauthorized.goback', 'unauthorized.gohome'])
    expect(buttons[0]?.getAttribute('href')).toBe('/login')
    expect(new Set(buttons.map(button => button.getAttribute('size')))).toEqual(new Set(['large']))
    expect(document.querySelector('h1')?.textContent).toBe('unauthorized.title')
    expect(document.body.textContent).toContain('unauthorized.action.view')
  })

  it('hides sign in for signed-in people and makes Back the primary action', async () => {
    const { document } = await render(false, true)
    const buttons = actionButtons(document)
    expect(buttons.map(button => button.textContent?.trim())).toEqual(['unauthorized.goback', 'unauthorized.gohome'])
    expect(buttons[0]?.getAttribute('variant')).toBe('flat')
    expect(buttons[0]?.getAttribute('prepend-icon')).toBe('mdi-arrow-right')
  })
})
