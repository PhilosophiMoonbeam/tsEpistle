import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, test } from '../../../server/test/bun-test.mts'

const shellPath = join(process.cwd(), 'client/components/editor.vue')
const propertiesPath = join(process.cwd(), 'client/components/editor/editor-modal-properties.vue')
const unsavedPath = join(process.cwd(), 'client/components/editor/editor-modal-unsaved.vue')

const shellSource = readFileSync(shellPath, 'utf8')
const propertiesSource = readFileSync(propertiesPath, 'utf8')
const unsavedSource = readFileSync(unsavedPath, 'utf8')

const shellSfc = parse(shellSource, { filename: shellPath })
const propertiesSfc = parse(propertiesSource, { filename: propertiesPath })
const unsavedSfc = parse(unsavedSource, { filename: unsavedPath })

const shellTemplate = shellSfc.descriptor.template?.content ?? ''
const shellScript = shellSfc.descriptor.script?.content ?? ''
const propertiesTemplate = propertiesSfc.descriptor.template?.content ?? ''
const propertiesScript = propertiesSfc.descriptor.script?.content ?? ''
const unsavedTemplate = unsavedSfc.descriptor.template?.content ?? ''
const unsavedScript = unsavedSfc.descriptor.script?.content ?? ''
const shellRegistrations = shellScript.match(/components:\s*\{([\s\S]*?)\n\s*\},\n\s*props:/)?.[1] ?? ''
const desktopSaveClose = shellTemplate.match(/v-btn\.editor-save-close-action[\s\S]*?\n\s{8}\)/)?.[0] ?? ''
const propertiesComputed = propertiesScript.match(/computed:\s*\{([\s\S]*?)\n\s*\},\n\s*watch:/)?.[1] ?? ''

describe('modern editor shell interaction contract', () => {
  test('owns cmd+s and prevents the browser save action before invoking editor save', () => {
    expect(shellSfc.errors).toEqual([])
    expect(shellScript).toMatch(/import \{ useHotkey \} from 'vuetify'/)
    expect(shellScript).toMatch(/useHotkey\('cmd\+s', event => \{\s*event\.preventDefault\(\)\s*saveHandler\?\.\(\)\s*\}\)/)
    expect(shellScript).toMatch(/created\(\) \{\s*this\.setSaveHotkeyHandler\(\(\) => \{\s*void this\.save\(\)/)
    expect(shellScript).toMatch(/beforeUnmount\(\) \{\s*this\.setSaveHotkeyHandler\(null\)/)
  })

  test('keeps Save and close visibly reachable on desktop and mobile regardless of dirty state', () => {
    expect(desktopSaveClose).toContain("v-if='$vuetify.display.mdAndUp'")
    expect(desktopSaveClose).toContain("aria-label='Save and close'")
    expect(desktopSaveClose).toContain("@click='saveAndClose'")
    expect(desktopSaveClose).not.toMatch(/isDirty|mode ===/)
    expect(shellTemplate).toMatch(/v-btn\.editor-save-close-action[\s\S]*?span Save and close/)
    expect(shellTemplate).toMatch(/v-list-item\(@click='saveAndClose'\)[\s\S]*?v-list-item-title Save and close/)
  })

  test('mounts recoverable heavyweight editor dialogs only while their owning state is active', () => {
    expect(shellTemplate).toContain("editor-modal-properties(v-if='dialogProps', v-model='dialogProps')")
    expect(shellTemplate).toContain("editor-modal-editorselect(v-if='dialogEditorSelector', v-model='dialogEditorSelector')")
    expect(shellTemplate).toMatch(/editor-modal-unsaved\(\s*v-if='dialogUnsaved'[\s\S]*?v-model='dialogUnsaved'/)
    expect(shellTemplate).toContain("component(v-if='activeModal', :is='activeModal')")

    expect(shellScript).toContain("import { createAsyncComponent } from './common/async-component-state.vue'")
    for (const component of ['editorModalProperties', 'editorModalEditorselect', 'editorModalUnsaved']) {
      expect(shellRegistrations).toMatch(new RegExp(`${component}: createAsyncComponent\\(\\(\\) => import\\(`))
    }
    expect(shellRegistrations).not.toContain('defineAsyncComponent')
  })

  test('keeps page-property edits reversible until the user explicitly accepts the draft', () => {
    expect(propertiesSfc.errors).toEqual([])
    expect(propertiesTemplate).toMatch(/v-btn\.mx-0\.mr-2\([\s\S]*?@click='cancel'[\s\S]*?common:actions\.cancel/)
    expect(propertiesScript).toMatch(
      /function createPropertiesDraft \(\): PagePropertiesDraft \{\s*return \{[\s\S]*title: wikiStore\.page\.title[\s\S]*tags: \[\.\.\.wikiStore\.page\.tags\]/
    )

    for (const field of ['title', 'description', 'locale', 'tags', 'path', 'isPublished', 'publishStartDate', 'publishEndDate', 'scriptJs', 'scriptCss']) {
      expect(propertiesComputed).toMatch(new RegExp(`${field}:\\s*\\{\\s*get\\(\\) \\{\\s*return this\\.draft\\.${field}\\s*\\}[\\s\\S]*?set\\(value:`))
    }
    expect(propertiesComputed).toMatch(/privatePage:[\s\S]*this\.draft\.visibility === 'private'[\s\S]*this\.draft\.visibility = value \? 'private' : 'public'/)

    expect(propertiesScript).toMatch(
      /handler \(newValue: boolean\) \{[\s\S]*if \(newValue\) \{\s*this\.beginEditing\(\)[\s\S]*\} else \{\s*this\.rollbackDraft\(\)/
    )
    expect(propertiesScript).toMatch(/cancel \(\) \{\s*this\.rollbackDraft\(\)\s*this\.isShown = false\s*\}/)
    expect(propertiesScript).toMatch(/async close\(\) \{[\s\S]*if \(!result\?\.valid\)[\s\S]*this\.commitDraft\(\)\s*this\.isShown = false/)
    expect(propertiesScript).toMatch(
      /commitDraft \(\) \{[\s\S]*wikiStore\.page\.title = this\.draft\.title[\s\S]*wikiStore\.page\.tags = \[\.\.\.this\.draft\.tags\]/
    )
  })

  test('offers Save and close from the unsaved dialog and closes only after save succeeds', () => {
    expect(unsavedSfc.errors).toEqual([])
    expect(shellTemplate).toMatch(/editor-modal-unsaved\([\s\S]*?:busy='isSaving'[\s\S]*?@discard='exitGo'[\s\S]*?@save='saveUnsavedAndClose'/)
    expect(unsavedTemplate).toMatch(/v-btn\.px-4\([\s\S]*?:loading='busy'[\s\S]*?@click='save'[\s\S]*?\) Save and close/)
    expect(unsavedScript).toMatch(/emits: \['discard', 'save', 'update:modelValue'\]/)
    expect(unsavedScript).toMatch(/save\(\) \{\s*this\.\$emit\('save'\)\s*\}/)
    expect(shellScript).toMatch(/async saveUnsavedAndClose\(\) \{\s*if \(await this\.saveAndClose\(\)\) \{\s*this\.dialogUnsaved = false/)
  })

  test('does not register removed API or redirect editors that could resurrect dead editor paths', () => {
    expect(shellRegistrations).not.toMatch(/\beditor(?:Api|Redirect)\s*:/i)
    expect(shellRegistrations).not.toMatch(/editor-(?:api|redirect)\.vue/i)
    expect(shellScript).toMatch(/normalizeAvailableEditors\(siteConfig\.availableEditors\)/)
    expect(shellScript).toMatch(/this\.currentEditor = getEditorComponentName\(availableEditors\[0\]\)/)
  })
})
