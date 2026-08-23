<template lang='pug'>
  v-dialog(v-model='isShown', persistent, max-width='700', no-click-animation)
    v-btn(icon, fixed, location="bottom right", color="grey-darken-3", @click='goBack', style='width: 50px;'): v-icon mdi-undo-variant
    v-card.radius-7(color="blue-darken-3")
      v-card-text.text-center.py-4
        .text-body-large.text-white {{$t('editor:select.title')}}
        v-container(fluid)
          v-row.justify-center
            v-col(cols='4')
              v-card.radius-7.animated.fadeInUp.wait-p1s(
                hover
                ripple
                )
                v-card-text.text-center(@click='selectEditor("markdown")')
                  img(src='/_assets/svg/editor-icon-markdown.svg', alt='Markdown', style='width: 36px;')
                  .text-body-medium.text-primary.mt-2 Markdown
                  .text-body-small.text-grey Plain Text Formatting
            v-col(cols='4')
              v-card.radius-7.animated.fadeInUp.wait-p2s(
                hover
                ripple
                )
                v-card-text.text-center(@click='selectEditor("visual-markdown")')
                  img(src='/_assets/svg/editor-icon-markdown.svg', alt='Visual Markdown', style='width: 36px;')
                  .text-body-medium.mt-2.text-primary Visual Markdown
                  .text-body-small.text-grey Rich-text, Markdown output
            v-col(cols='4')
              v-card.radius-7.animated.fadeInUp.wait-p2s(
                hover
                ripple
                )
                v-card-text.text-center(@click='selectEditor("ckeditor")')
                  img(src='/_assets/svg/editor-icon-html.svg', alt='Visual Editor', style='width: 36px;')
                  .text-body-medium.mt-2.text-primary Visual Editor
                  .text-body-small.text-grey Rich-text, HTML output
            v-col(cols='4')
              v-card.radius-7.animated.fadeInUp.wait-p3s(
                hover
                ripple
                )
                v-card-text.text-center(@click='selectEditor("asciidoc")')
                  img(src='/_assets/svg/editor-icon-asciidoc.svg', alt='AsciiDoc', style='width: 36px;')
                  .text-body-medium.text-primary.mt-2 AsciiDoc
                  .text-body-small.text-grey Plain Text Formatting
            v-col(cols='4')
              v-card.radius-7.animated.fadeInUp.wait-p4s(
                hover
                ripple
                )
                v-card-text.text-center(@click='selectEditor("code")')
                  img(src='/_assets/svg/editor-icon-code.svg', alt='Code', style='width: 36px;')
                  .text-body-medium.text-primary.mt-2 Code
                  .text-body-small.text-grey Raw HTML
            v-col(cols='4')
              v-card.radius-7.animated.fadeInUp.wait-p5s(
                hover
                ripple
                )
                v-card-text.text-center(@click='fromTemplate')
                  img(src='/_assets/svg/icon-cube.svg', alt='From Template', style='width: 42px; opacity: .5;')
                  .text-body-medium.mt-1.text-teal From Template
                  .text-body-small.text-grey Use an existing page...

    page-selector(mode='select', v-model='templateDialogIsShown', :open-handler='fromTemplateHandle', :path='path', :locale='locale', must-exist)</template>

<script lang='ts'>
import { wikiStore } from '@/store/index.ts'
import { getEditorComponentName } from '../../helpers/editor-key.ts'

type EditorName = 'markdown' | 'visual-markdown' | 'ckeditor' | 'asciidoc' | 'code'

export default {
  emits: ['update:modelValue'],
  props: {
    modelValue: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      templateDialogIsShown: false
    }
  },
  computed: {
    isShown: {
      get() { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    },
    currentEditor: {
      get() {
        return wikiStore.editor.editor
      },
      set(value: string) {
        wikiStore.editor.editor = value
      }
    },
    locale() {
      return wikiStore.page.locale
    },
    path() {
      return wikiStore.page.path
    }
  },
  methods: {
    selectEditor (name: EditorName) {
      this.currentEditor = getEditorComponentName(name)
      this.isShown = false
    },
    goBack () {
      window.history.go(-1)
    },
    fromTemplate () {
      this.templateDialogIsShown = true
    },
    fromTemplateHandle ({ id }: { id: number }) {
      this.templateDialogIsShown = false
      this.isShown = false
      this.$nextTick(() => {
        window.location.assign(`/e/${this.locale}/${this.path}?from=${id}`)
      })
    }
  }
}
</script>

<style lang='scss'>

</style>
