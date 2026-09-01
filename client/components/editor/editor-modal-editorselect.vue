<template lang='pug'>
  v-dialog(v-model='isShown', max-width='760', scrollable, :fullscreen='$vuetify.display.smAndDown', aria-labelledby='editor-select-title', no-click-animation)
    v-card.editor-select.radius-7.d-flex.flex-column
      v-toolbar(color='primary', density='comfortable')
        v-icon.ml-4 mdi-pencil-ruler
        v-toolbar-title#editor-select-title {{ $t('editor:select.title') }}
        v-btn(icon='mdi-arrow-left', variant='text', aria-label='Go back', @click='goBack')
      v-card-text.editor-select__content.pa-5
        .text-body-medium.text-medium-emphasis.mb-4
          | Choose how you want to author this page. Your administrator has made {{ availableEditors.length }} {{ availableEditors.length === 1 ? 'editor' : 'editors' }} available.
        .editor-select__grid
          v-card.editor-select__option(
            v-for='(editor, index) in availableEditors'
            :key='editor.key'
            variant='outlined'
            hover
            role='button'
            tabindex='0'
            :style='{ "--editor-delay": `${index * 55}ms` }'
            @click='selectEditor(editor.key)'
            @keydown.enter.prevent='selectEditor(editor.key)'
            @keydown.space.prevent='selectEditor(editor.key)'
          )
            v-card-text.text-center.pa-5
              .editor-select__icon
                img(:src='editor.image', alt='')
              .text-title-medium.text-primary.mt-3 {{ editor.title }}
              .text-body-small.text-medium-emphasis.mt-1 {{ editor.chooserDescription }}
              v-chip.mt-3(size='x-small', variant='tonal', color='primary') {{ editor.format }}

          v-card.editor-select__option.editor-select__option--template(
            variant='outlined'
            hover
            role='button'
            tabindex='0'
            :style='{ "--editor-delay": `${availableEditors.length * 55}ms` }'
            @click='fromTemplate'
            @keydown.enter.prevent='fromTemplate'
            @keydown.space.prevent='fromTemplate'
          )
            v-card-text.text-center.pa-5
              .editor-select__icon.editor-select__icon--template
                img(src='/_assets/svg/icon-cube.svg', alt='')
              .text-title-medium.text-teal.mt-3 From Template
              .text-body-small.text-medium-emphasis.mt-1 Start with an existing page
              v-chip.mt-3(size='x-small', variant='tonal', color='teal') Reuse

    page-selector(mode='select', v-model='templateDialogIsShown', :open-handler='fromTemplateHandle', :path='path', :locale='locale', must-exist)
</template>

<script lang='ts'>
import { wikiStore } from '@/store/index.ts'
import { getEditorComponentName } from '../../helpers/editor-key.ts'
import { PAGE_EDITOR_DEFINITIONS } from '../../helpers/page-editors.ts'
import { normalizeAvailableEditors, type PageEditorKey } from '../../../shared/page-editors.ts'

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
    availableEditors() {
      const selected = new Set(normalizeAvailableEditors(siteConfig.availableEditors))
      return PAGE_EDITOR_DEFINITIONS.filter(editor => selected.has(editor.key))
    },
    locale() {
      return wikiStore.page.locale
    },
    path() {
      return wikiStore.page.path
    }
  },
  methods: {
    selectEditor (name: PageEditorKey) {
      wikiStore.editor.editor = getEditorComponentName(name)
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

<style lang='scss' scoped>
.editor-select {
  overflow: hidden;
  min-height: 0;

  &__content {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  &__grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  &__option {
    cursor: pointer;
    border-color: rgba(var(--v-border-color), var(--v-border-opacity));
    animation: editor-option-in 280ms both;
    animation-delay: var(--editor-delay);
    transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;

    &:hover,
    &:focus-visible {
      border-color: rgba(var(--v-theme-primary), .6);
      box-shadow: 0 8px 22px rgba(var(--v-theme-on-surface), .1);
      transform: translateY(-2px);
      outline: none;
    }

    &--template {
      background: rgba(var(--v-theme-secondary), .04);
    }
  }

  &__icon {
    display: grid;
    place-items: center;
    width: 58px;
    height: 58px;
    margin: 0 auto;
    border-radius: 16px;
    background: rgba(var(--v-theme-primary), .1);

    img {
      width: 38px;
      height: 38px;
    }

    &--template {
      background: rgba(var(--v-theme-secondary), .1);

      img {
        opacity: .7;
      }
    }
  }
}

@keyframes editor-option-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: $tablet - 0.02px) {
  .editor-select__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 599.98px) {
  .editor-select__grid {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .editor-select__option {
    animation: none;
    transition: none;
  }
}
</style>
