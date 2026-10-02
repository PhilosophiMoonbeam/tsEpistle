import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import * as cheerio from 'cheerio'
import pug from 'pug'
import { describe, expect, test } from '../../../server/test/bun-test.mts'

// Template-level contracts for the authoring toolbars. Behaviour (roving focus,
// active-state mapping, shortcuts) is covered in common/formatting-tools.test.ts.
const templateOf = (relativePath: string) => {
  const filename = join(process.cwd(), relativePath)
  const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename })
  expect(errors).toEqual([])
  return cheerio.load(pug.render(descriptor.template?.content ?? ''))
}

const AUTHORING_FILES = [
  'client/components/editor.vue',
  'client/components/editor/editor-markdown.vue',
  'client/components/editor/tiptap/editor.vue',
  'client/components/editor/editor-code.vue',
  'client/components/editor/editor-asciidoc.vue',
  'client/components/editor/editor-modal-media.vue',
  'client/components/editor/editor-modal-blocks.vue',
  'client/components/editor/editor-modal-conflict.vue',
  'client/components/editor/editor-modal-drawio.vue',
  'client/components/editor/editor-modal-properties.vue',
  'client/components/editor/markdown/help.vue'
]

describe('authoring toolbars', () => {
  test('Markdown and visual toolbars expose one roving toolbar each with neutral, labelled tools', () => {
    for (const file of ['client/components/editor/editor-markdown.vue', 'client/components/editor/tiptap/editor.vue']) {
      const $ = templateOf(file)
      const toolbars = $('[role="toolbar"]')
      expect(toolbars.length).toBeGreaterThan(0)
      toolbars.each((_index, toolbar) => {
        expect($(toolbar).attr('v-roving-toolbar')).toContain('onEscape')
        expect($(toolbar).attr(':aria-label') ?? $(toolbar).attr('aria-label')).toBeTruthy()
      })
      const tools = $('.editor-tool')
      expect(tools.length).toBeGreaterThan(3)
      tools.each((_index, tool) => {
        const element = $(tool)
        expect(element.attr('data-purpose')).toBeUndefined()
        expect(element.hasClass('wiki-purpose-control')).toBe(false)
        expect(element.attr('title')).toBeUndefined()
        expect(element.attr(':disabled')).toBeUndefined()
      })
    }
  })

  test('authoring surfaces drop staggered entrance animations, grey palette classes and the QR icon', () => {
    for (const file of AUTHORING_FILES) {
      const $ = templateOf(file)
      const markup = $.html()
      expect({ file, animated: $('.animated, [class*="wait-p"]').length }).toEqual({ file, animated: 0 })
      expect({ file, grey: /\btext-grey|grey-darken|grey-lighten/.test(markup) }).toEqual({ file, grey: false })
      expect({ file, qr: markup.includes('mdi-qrcode') }).toEqual({ file, qr: false })
    }
  })

  test('Page Properties keeps actions in the footer and one Visibility group', () => {
    const $ = templateOf('client/components/editor/editor-modal-properties.vue')
    const header = $('.dialog-header')
    expect(header.find('v-btn').length).toBe(0)
    const footer = $('v-card-actions.editor-properties-actions')
    expect(footer.text()).toContain("common:actions.cancel")
    expect(footer.text()).toContain("common:actions.apply")
    expect($('.editor-properties-visibility v-switch').length).toBe(2)
    expect($('v-switch[v-model="isPublished"]').length).toBe(1)
    expect($('v-tab[v-if="hasScriptPermission"]').length).toBe(1)
    expect($('v-tab[v-if="hasStylePermission"]').length).toBe(1)
    expect($('v-tab[\\:disabled]').length).toBe(0)
  })
})
