import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { document, resetBody } from '../../test/browser-dom.mts'
import type { VNode } from 'vue'

resetBody()
// Vue runtime-dom must load after the shared browser harness installs its document.
const Vue = await import('vue')
const componentPath = join(process.cwd(), 'client/components/common/admin-hero.vue')
const source = readFileSync(componentPath, 'utf8')
const { descriptor, errors } = parse(source, { filename: componentPath })
if (errors.length || !descriptor.template || !descriptor.scriptSetup) {
  throw new Error(`Could not parse admin-hero.vue: ${errors.join(', ')}`)
}
const componentId = 'admin-hero-contract-test'
const script = compileScript(descriptor, { id: componentId, genDefaultAs: '__sfc__' })
const template = compileTemplate({
  source: descriptor.template.content,
  filename: componentPath,
  id: componentId,
  preprocessLang: descriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] }
})
if (template.errors.length) throw new Error(`Could not compile admin-hero.vue: ${template.errors.join(', ')}`)
const transpiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${script.content}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`)
const { default: AdminHero } = await import('data:text/javascript;base64,' + Buffer.from(transpiled).toString('base64'))

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  resetBody()
})

const mountHero = (initialProps: { title: string; description?: string; eyebrow?: string; headingId?: string; icon?: string }, slots: Record<string, () => VNode> = {}) => {
  const props = Vue.reactive({ ...initialProps })
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp({ setup: () => () => Vue.h(AdminHero, props, slots) })
  // Only adapt the icon dependency; the actual compiled hero chooses the branch and hides decoration.
  app.component('v-icon', Vue.defineComponent({ setup: (_, { slots }) => () => Vue.h('span', { class: 'hero-test-icon' }, slots.default?.()) }))
  app.mount(host)
  cleanups.push(() => { app.unmount(); host.remove() })
  return { host, props }
}

describe('AdminHero public contract', () => {
  test('renders caller status and an accessible action that remains actionable', () => {
    const reload = vi.fn()
    const { host } = mountHero({ title: 'API access' }, {
      status: () => Vue.h('span', { role: 'status' }, 'API-key access enabled'),
      actions: () => Vue.h('button', { type: 'button', onClick: reload }, 'Reload workspace')
    })

    expect(host.querySelector('[role="status"]')?.textContent).toBe('API-key access enabled')
    const button = host.querySelector<HTMLButtonElement>('button')!
    expect(button.textContent).toBe('Reload workspace')
    button.click()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  test('renders a focusable semantic heading, literal caller text, and decorative icon branches', async () => {
    const title = '<img data-injected="title" src="x" onerror="alert(1)">'
    const description = '<a data-injected="description" href="javascript:alert(1)">Unsafe link</a>'
    const eyebrow = '<script data-injected="eyebrow">alert(1)</script>'
    const { host, props } = mountHero({ title, description, eyebrow, headingId: 'workspace-heading', icon: 'mdi-api' })

    const heading = host.querySelector<HTMLHeadingElement>('h1')!
    expect(heading.textContent).toBe(title)
    expect(heading.id).toBe('workspace-heading')
    expect(heading.getAttribute('tabindex')).toBe('-1')
    heading.focus()
    expect(document.activeElement).toBe(heading)
    expect(host.querySelector('.admin-hero__description')?.textContent).toBe(description)
    expect(host.querySelector('.admin-hero__eyebrow')?.textContent).toBe(eyebrow)
    expect(host.querySelector('[data-injected]')).toBeNull()
    const mark = host.querySelector('.admin-hero__mark')!
    expect(mark.getAttribute('aria-hidden')).toBe('true')
    expect(mark.querySelector('.hero-test-icon')?.textContent?.trim()).toBe('mdi-api')
    expect(mark.querySelector('img')).toBeNull()

    props.icon = '/admin-icon.svg'
    await Vue.nextTick()
    const image = mark.querySelector('img')!
    expect(image.getAttribute('src')).toBe('/admin-icon.svg')
    expect(image.getAttribute('alt')).toBe('')
    expect(mark.getAttribute('aria-hidden')).toBe('true')
    expect(mark.querySelector('.hero-test-icon')).toBeNull()
  })
})
