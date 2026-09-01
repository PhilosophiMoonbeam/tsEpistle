import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, test } from '../../../server/test/bun-test.mts'

const componentPath = join(process.cwd(), 'client/components/common/admin-hero.vue')
const source = readFileSync(componentPath, 'utf8')
const { descriptor, errors } = parse(source, { filename: componentPath })
const template = descriptor.template?.content ?? ''
const script = descriptor.scriptSetup?.content ?? ''

describe('AdminHero public contract', () => {
  test('declares the required title and optional mapped header props', () => {
    expect(errors).toEqual([])
    expect(script).toMatch(/\btitle:\s*string/)
    expect(script).toMatch(/\bdescription\?:\s*string/)
    expect(script).toMatch(/\bicon\?:\s*string/)
    expect(script).toMatch(/\beyebrow\?:\s*string/)
    expect(script).toMatch(/\bheadingId\?:\s*string/)
    expect(script).toContain('defineProps<AdminHeroProps>()')
  })

  test('exposes and renders the status, actions, and extra slots', () => {
    for (const slot of ['status', 'actions', 'extra']) {
      expect(script).toMatch(new RegExp(`\\b${slot}\\?\\s*:\\s*\\(\\) => unknown`))
      expect(template).toContain(`slot(name='${slot}')`)
    }
  })

  test('renders a focusable semantic heading and decorative icons without HTML injection', () => {
    expect(template).toContain("h1.admin-hero__title.text-headline-medium(:id='headingId' tabindex='-1') {{ title }}")
    expect(template).toContain("v-icon(v-if='usesMdiIcon') {{ icon }}")
    expect(template).toContain("img(v-else :src='icon' alt='' draggable='false')")
    expect(template).not.toMatch(/v-html|innerHTML/)
  })

  test('is globally registered and keeps route heading focus artifact-free', () => {
    const appSource = readFileSync(join(process.cwd(), 'client/client-app.ts'), 'utf8')
    const adminShellSource = readFileSync(join(process.cwd(), 'client/components/admin.vue'), 'utf8')

    expect(appSource).toContain("asyncComponent('AdminHero', () => import('./components/common/admin-hero.vue'))")
    expect(adminShellSource).toContain('heading.focus({ preventScroll: true })')
    expect(adminShellSource).toMatch(/h1\[tabindex='-1'\]:focus\s*\{\s*outline:\s*none;\s*box-shadow:\s*none;/)
  })
})
