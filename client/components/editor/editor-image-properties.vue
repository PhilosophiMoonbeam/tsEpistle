<template lang="pug">
v-form.overflow-y-auto(@submit.prevent='save')
  v-card-text
    p.text-body-medium.mb-5 Change only the properties you need. Untouched source attributes and unsupported values are preserved.
    v-text-field(v-model='draft.src', label='Image source', :error-messages='errors.src', counter='2048', maxlength='2048', autofocus, required)
    v-textarea.mt-4(v-model='draft.alt', label='Alternative text', hint='Describe the image for readers who cannot see it. Leave empty for a decorative image.', persistent-hint, :error-messages='errors.alt', counter='2000', maxlength='2000', rows='2', auto-grow)
    v-row.mt-2
      v-col(cols='12', sm='6')
        v-text-field(v-model='draft.width', label='Width', hint='Empty, auto, 1–16384 pixels, or up to 100%.', persistent-hint, :error-messages='errors.width')
      v-col(cols='12', sm='6')
        v-text-field(v-model='draft.height', label='Height', hint='Empty, auto, 1–16384 pixels, or up to 100%.', persistent-hint, :error-messages='errors.height')
    v-select.mt-4(v-model='draft.align', label='Alignment', :items='alignments', :error-messages='errors.align')
    fieldset.pa-3.rounded
      legend.px-2 Framing
      v-checkbox(v-for='style in styleOptions', :key='style.value', v-model='draft.styles', :value='style.value', :label='style.title', hide-details, density='compact')
    .mt-5(role='region', aria-label='Local image preview')
      .text-label-large.mb-2 Preview
      .d-flex(:class='previewAlignment')
        v-img(v-if='previewSource', :key='previewSource', :src='previewSource', :alt='draft.alt', :class='previewClasses', :width='previewWidth', :height='previewHeight', max-width='100%', max-height='240', contain, @error='previewFailed = true')
      p.text-body-small.text-medium-emphasis(v-if='!previewSource') {{ previewFailed ? 'The local image could not be loaded. Your changes are still available.' : 'Preview is available for safe local images only. External sources are never loaded here.' }}
    v-alert.mt-5(v-if='conflict', type='warning', variant='tonal', role='alert') The image or document changed while this dialog was open. Your edits have been kept. Cancel and reopen the current image to apply them safely.
    v-alert.mt-5(v-if='saveError', type='error', variant='tonal', role='alert') {{ saveError }}
  v-card-actions
    v-spacer
    v-btn(variant='text', @click='$emit(`close`)') {{ $t('common:actions.cancel') }}
    v-btn(color='primary', variant='flat', type='submit', :disabled='!hasChanges || hasErrors || request.signal.aborted') Apply changes
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import {
  EDITOR_IMAGE_STYLE_CLASSES,
  isLocalEditorImageSource,
  isSafeEditorImageSource,
  isValidEditorImageAlt,
  normalizeEditorImageDimension,
  type EditorImagePropertiesRequest,
  type EditorImagePropertyPatch,
  type EditorImageStyle
} from '../../helpers/editor-image-properties'

export default defineComponent({
  props: {
    request: { type: Object as PropType<EditorImagePropertiesRequest>, required: true }
  },
  emits: ['close'],
  data() {
    return {
      draft: { ...this.request.properties, styles: [...this.request.properties.styles] },
      conflict: false,
      saveError: '',
      previewFailed: false,
      alignments: [
        { title: 'None', value: '' }, { title: 'Left', value: 'left' },
        { title: 'Centered', value: 'center' }, { title: 'Right', value: 'right' },
        { title: 'Above, top right', value: 'abstopright' }
      ],
      styleOptions: [
        { title: 'Border', value: 'border' as EditorImageStyle },
        { title: 'Rounded corners', value: 'rounded' as EditorImageStyle },
        { title: 'Shadow', value: 'shadow' as EditorImageStyle }
      ]
    }
  },
  computed: {
    patch(): EditorImagePropertyPatch {
      const patch: EditorImagePropertyPatch = {}
      const original = this.request.properties
      for (const key of ['src', 'alt', 'width', 'height', 'align'] as const) {
        if (this.draft[key] !== original[key]) Object.assign(patch, { [key]: this.draft[key] })
      }
      if (this.draft.styles.length !== original.styles.length || this.draft.styles.some(style => !original.styles.includes(style))) {
        patch.styles = [...this.draft.styles]
      }
      return patch
    },
    errors(): Record<'src' | 'alt' | 'width' | 'height' | 'align', string[]> {
      const patch = this.patch
      return {
        src: patch.src !== undefined && !isSafeEditorImageSource(patch.src) ? ['Use a safe local path or HTTP(S) URL without credentials, spaces, or control characters (up to 2048 characters).'] : [],
        alt: patch.alt !== undefined && !isValidEditorImageAlt(patch.alt) ? ['Use at most 2000 characters without control characters.'] : [],
        width: patch.width !== undefined && normalizeEditorImageDimension(patch.width) === null ? ['Enter auto, a positive pixel size up to 16384, a percentage up to 100%, or leave empty.'] : [],
        height: patch.height !== undefined && normalizeEditorImageDimension(patch.height) === null ? ['Enter auto, a positive pixel size up to 16384, a percentage up to 100%, or leave empty.'] : [],
        align: patch.align !== undefined && !this.alignments.some(option => option.value === patch.align) ? ['Choose a supported alignment.'] : []
      }
    },
    hasErrors(): boolean { return Object.values(this.errors).some(errors => errors.length > 0) },
    hasChanges(): boolean { return Object.keys(this.patch).length > 0 },
    previewSource(): string {
      return !this.previewFailed && isLocalEditorImageSource(this.draft.src) ? this.draft.src : ''
    },
    previewClasses(): string[] {
      return this.draft.styles.filter(style => Object.hasOwn(EDITOR_IMAGE_STYLE_CLASSES, style)).map(style => EDITOR_IMAGE_STYLE_CLASSES[style])
    },
    previewWidth(): string | number | undefined {
      const value = normalizeEditorImageDimension(this.draft.width)
      return value && value !== 'auto' ? value : undefined
    },
    previewAlignment(): string {
      if (this.draft.align === 'center') return 'justify-center'
      if (this.draft.align === 'right' || this.draft.align === 'abstopright') return 'justify-end'
      return 'justify-start'
    },
    previewHeight(): string | number | undefined {
      const value = normalizeEditorImageDimension(this.draft.height)
      return value && value !== 'auto' ? value : undefined
    }
  },
  watch: {
    'draft.src'() { this.previewFailed = false }
  },
  methods: {
    save() {
      if (!this.hasChanges || this.hasErrors || this.request.signal.aborted) return
      this.saveError = ''
      const patch = { ...this.patch }
      if (patch.width !== undefined) patch.width = normalizeEditorImageDimension(patch.width)!
      if (patch.height !== undefined) patch.height = normalizeEditorImageDimension(patch.height)!
      try {
        if (!this.request.apply(patch)) {
          this.conflict = true
          return
        }
        this.$emit('close')
      } catch {
        this.saveError = 'The image properties could not be applied. Your edits have been kept.'
      }
    }
  }
})
</script>
