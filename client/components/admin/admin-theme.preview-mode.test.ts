/// <reference types="bun" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, test } from '../../../server/test/bun-test.mts'

const componentPath = join(process.cwd(), 'client/components/admin/admin-theme.vue')
const componentSource = readFileSync(componentPath, 'utf8')
const component = parse(componentSource, { filename: componentPath })
const template = component.descriptor.template?.content ?? ''
const script = component.descriptor.scriptSetup?.content ?? ''
const effectiveThemeWatcher = script.match(
  /watch\(\(\) => theme\.current\.value\.dark, isDark => \{[\s\S]*?\n\}\)/
)?.[0] ?? ''

describe('Admin theme Live preview mode contract', () => {
  test('keeps manual preview selection writable and binds the provider to it', () => {
    expect(component.errors).toEqual([])
    expect(template).toContain("v-btn-toggle(\n                v-model='previewMode'")
    expect(template).toContain("v-btn(value='light', aria-label='Edit light palette')")
    expect(template).toContain("v-btn(value='dark', aria-label='Edit dark palette')")
    expect(template).toContain("v-theme-provider(:theme='previewMode', with-background)")
    expect(script).toContain(
      "const previewMode = ref<PaletteMode>(theme.current.value?.dark ? 'dark' : 'light')"
    )
  })

  test('maps each effective shared theme change to previewMode only', () => {
    expect(effectiveThemeWatcher).toBe(
      "watch(() => theme.current.value.dark, isDark => {\n  previewMode.value = isDark ? 'dark' : 'light'\n})"
    )
    expect(effectiveThemeWatcher).not.toMatch(/theme\.change|config|activePalette|colors|applyWikiThemeColors/)

    const assignment = effectiveThemeWatcher.match(/previewMode\.value = ([^\n]+)/)?.[1]
    if (!assignment) throw new Error('Effective theme watcher assignment was not found')
    const resolvePreviewMode = new Function('isDark', `return ${assignment}`) as (isDark: boolean) => 'light' | 'dark'
    expect(resolvePreviewMode(false)).toBe('light')
    expect(resolvePreviewMode(true)).toBe('dark')
  })

  test('has no reverse preview watcher or palette synchronization dependency', () => {
    expect(script).not.toMatch(/watch\(\s*(?:\(\) =>\s*)?previewMode/)
    expect(script).toContain(
      'watch([() => config.activePaletteId, () => activePalette.value.colors], syncActivePalette, { deep: true })'
    )
    expect(effectiveThemeWatcher).not.toContain('syncActivePalette')
  })
})
