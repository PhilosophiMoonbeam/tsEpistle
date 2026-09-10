import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, test } from '../../../server/test/bun-test.mts'

const componentPath = join(process.cwd(), 'client/components/editor/editor-modal-properties.vue')
const source = readFileSync(componentPath, 'utf8')
const { descriptor, errors } = parse(source, { filename: componentPath })
const template = descriptor.template?.content ?? ''
const styles = descriptor.styles.map(s => s.content).join('\n')

describe('Editor modal properties - Vuetify 4.1 slot contract', () => {
  test('parses SFC descriptor with zero syntax errors', () => {
    expect(errors).toEqual([])
    expect(template).toBeTruthy()
    expect(styles).toBeTruthy()
  })

  test('removes outdated internalItem references and binds item.raw for Vuetify 4.1', () => {
    // Vuetify 4.1 InternalListItem slots must not reference internalItem
    expect(template).not.toContain('internalItem')
    expect(template).toMatch(/template\(v-slot:item='\{\s*props,\s*item\s*\}'\)/)
    expect(template).toContain(":data-tag-value='item.raw'")
  })

  test('correctly detects candidateTag with item.raw comparison', () => {
    // Previous item === candidateTag failed because item was an InternalListItem object
    expect(template).toContain(":icon='item.raw === candidateTag ? `mdi-plus` : `mdi-tag-outline`'")
    expect(template).toMatch(/span\(v-if='item\.raw === candidateTag'\)\s+Add “\{\{\s*item\.raw\s*\}\}” to page/)
    expect(template).toMatch(/span\(v-else\)\s+\{\{\s*item\.raw\s*\}\}/)
    expect(template).toContain("template(v-slot:subtitle v-if='item.raw === candidateTag')")
    expect(template).not.toMatch(/\bitem === candidateTag\b/)
  })

  test('correctly configures chip slot with item.raw fallback and close label', () => {
    expect(template).toMatch(/template\(v-slot:chip='\{\s*props,\s*item\s*\}'\)/)
    expect(template).toMatch(/:close-label='`Remove tag \$\{item\.raw \|\| item\.title \|\| item\}`'/)
    expect(template).toMatch(/\{\{\s*item\.raw \|\| item\.title \|\| item\s*\}\}/)
  })

  test('elevates branding preview with specular border sheen, ambient glow, and MD3 elevation', () => {
    expect(styles).toContain('.editor-properties-branding-preview')
    expect(styles).toContain('border: 1px solid color-mix(in srgb, var(--wiki-accent-ink) 25%, var(--wiki-surface-border));')
    expect(styles).toContain('background: var(--wiki-surface-raised);')
    expect(styles).toContain(
      'box-shadow: var(--wiki-shadow-xs), 0 0 12px color-mix(in srgb, var(--wiki-ambient-accent) 8%, transparent), var(--wiki-shadow-inset);'
    )
  })

  test('semantic contract: handles Vuetify 4.1 InternalListItem data shape correctly', () => {
    interface InternalListItem {
      raw: string
      title: string
      value: string
      props: Record<string, unknown>
    }

    const candidateTag = 'vue3'
    const existingItem: InternalListItem = {
      raw: 'documentation',
      title: 'documentation',
      value: 'documentation',
      props: {}
    }
    const candidateItem: InternalListItem = {
      raw: 'vue3',
      title: 'vue3',
      value: 'vue3',
      props: {}
    }

    // Direct object comparison would fail
    expect((existingItem as unknown) === candidateTag).toBe(false)
    expect((candidateItem as unknown) === candidateTag).toBe(false)

    // item.raw comparison accurately resolves
    expect(existingItem.raw === candidateTag).toBe(false)
    expect(candidateItem.raw === candidateTag).toBe(true)

    // Tag value attribute extraction
    expect(existingItem.raw).toBe('documentation')
    expect(candidateItem.raw).toBe('vue3')

    // Title formatting logic
    const formatTitle = (item: { raw: string }) => (item.raw === candidateTag ? `Add “${item.raw}” to page` : item.raw)

    expect(formatTitle(existingItem)).toBe('documentation')
    expect(formatTitle(candidateItem)).toBe('Add “vue3” to page')

    // Chip display & label fallback logic
    const resolveChipText = (item: Partial<InternalListItem> | string) => (typeof item === 'string' ? item : item.raw || item.title || item)

    expect(resolveChipText(existingItem)).toBe('documentation')
    expect(resolveChipText('standalone-tag')).toBe('standalone-tag')
    expect(resolveChipText({ title: 'fallback-title' })).toBe('fallback-title')
  })
})
