<template lang='pug'>
  v-card.editor-modal-blocks.animated.fadeInLeft(flat, tile, role='dialog', aria-modal='true', aria-labelledby='content-extension-title')
    v-toolbar(color='grey darken-4', dark, flat)
      v-icon.mr-3(color='teal lighten-2') mdi-qrcode
      v-toolbar-title#content-extension-title Insert content extension
      v-spacer
      v-btn(icon, aria-label='Close content extension dialog', @click='close')
        v-icon mdi-close
    v-container.py-6(fluid)
      v-row(justify='center')
        v-col(cols='12', md='8', lg='6', xl='5')
          v-skeleton-loader(v-if='isLoading', type='heading, paragraph, paragraph, actions')
          template(v-else-if='loadError')
            v-alert.mb-4(type='error', variant='tonal') {{loadError}}
            v-btn(color='teal', dark, @click='loadExtensions') Retry
          template(v-else-if='!qrStatus || !canInsertQr')
            v-alert(type='warning', variant='tonal')
              .font-weight-medium QR code is unavailable
              .mt-1 {{availabilityDiagnostic}}
          v-card.radius-7(v-else, light, flat)
            v-card-title.d-flex.align-center
              span {{qrStatus.title}}
              v-spacer
              v-chip(color='teal', variant='outlined', size='small') Version {{qrStatus.version}}
            v-card-subtitle {{qrStatus.description}}
            v-card-text
              v-alert.mb-5(type='info', variant='tonal', density='compact')
                | The QR code is generated locally when the page renders. No preview or data is sent to another service.
              v-form(@submit.prevent='insertExtension')
                v-textarea(
                  ref='valueInput'
                  v-model='value'
                  label='Value'
                  hint='Enter the text or URL to encode.'
                  persistent-hint
                  rows='4'
                  auto-grow
                  counter='2048'
                  required
                  :error-messages='fieldError(`value`)'
                  @blur='touched.value = true'
                )
                v-text-field.mt-5(
                  v-model='label'
                  label='Accessible label (optional)'
                  hint='Describe the QR code purpose for screen reader users.'
                  persistent-hint
                  counter='200'
                  :error-messages='fieldError(`label`)'
                  @blur='touched.label = true'
                )
                v-row.mt-2
                  v-col(cols='12', sm='6')
                    v-text-field(
                      v-model.number='size'
                      type='number'
                      min='128'
                      max='1024'
                      step='1'
                      label='Size (pixels)'
                      hint='128–1024'
                      persistent-hint
                      :error-messages='fieldError(`size`)'
                      @blur='touched.size = true'
                    )
                  v-col(cols='12', sm='6')
                    v-select(
                      v-model='errorCorrection'
                      :items='correctionLevels'
                      label='Error correction'
                      hint='Higher levels tolerate more damage.'
                      persistent-hint
                    )
                v-alert.mt-4(v-if='submitError', type='error', variant='tonal', density='compact') {{submitError}}
                .d-flex.flex-wrap.justify-end.mt-6
                  v-btn.mr-3(text, @click='close') Cancel
                  v-btn(
                    color='teal'
                    dark
                    type='submit'
                    :disabled='!isFormValid || !canInsertQr'
                  )
                    v-icon(left) mdi-plus
                    | Insert QR code
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { wikiStore } from '@/store/index.ts'
import { emitEditorInsert } from '../../helpers/editor-insert-events'
import { fetchContentExtensions, type ContentExtensionStatus } from '../../helpers/content-extensions-api'
import {
  parseContentExtensionEnvelope,
  serializeContentExtensionFence
} from '../../../shared/content-extensions.ts'

type QrField = 'value' | 'label' | 'size'
type ErrorCorrection = 'L' | 'M' | 'Q' | 'H'

export default defineComponent({
  data() {
    return {
      extensions: [] as ContentExtensionStatus[],
      isLoading: true,
      loadError: '',
      submitError: '',
      value: '',
      label: '',
      size: 256,
      errorCorrection: 'M' as ErrorCorrection,
      correctionLevels: [
        { title: 'Low (L)', value: 'L' },
        { title: 'Medium (M)', value: 'M' },
        { title: 'Quartile (Q)', value: 'Q' },
        { title: 'High (H)', value: 'H' }
      ],
      touched: {
        value: false,
        label: false,
        size: false
      } as Record<QrField, boolean>
    }
  },
  computed: {
    qrStatus(): ContentExtensionStatus | undefined {
      return this.extensions.find(extension => extension.key === 'qr')
    },
    canInsertQr(): boolean {
      return Boolean(this.qrStatus?.isEnabled && this.qrStatus.compatible)
    },
    availabilityDiagnostic(): string {
      if (!this.qrStatus) return 'The server did not advertise the QR extension.'
      if (this.qrStatus.diagnostic) return this.qrStatus.diagnostic
      if (!this.qrStatus.isEnabled) return 'The QR extension is disabled by an administrator.'
      return 'This editor host is not compatible with the installed QR extension.'
    },
    isFormValid(): boolean {
      return this.value.length >= 1 &&
        this.value.length <= 2048 &&
        this.label.length <= 200 &&
        Number.isInteger(this.size) &&
        this.size >= 128 &&
        this.size <= 1024 &&
        ['L', 'M', 'Q', 'H'].includes(this.errorCorrection)
    }
  },
  methods: {
    close () {
      wikiStore.editor.activeModal = ''
    },
    handleEscape (event: KeyboardEvent) {
      if (event.key === 'Escape') this.close()
    },
    fieldError (field: QrField): string[] {
      if (!this.touched[field]) return []
      if (field === 'value' && this.value.length === 0) return ['A value is required.']
      if (field === 'value' && this.value.length > 2048) return ['Value must be 2048 characters or fewer.']
      if (field === 'label' && this.label.length > 200) return ['Label must be 200 characters or fewer.']
      if (field === 'size' && (!Number.isInteger(this.size) || this.size < 128 || this.size > 1024)) {
        return ['Size must be a whole number from 128 to 1024.']
      }
      return []
    },
    async loadExtensions () {
      this.isLoading = true
      this.loadError = ''
      try {
        const status = await fetchContentExtensions(fetch)
        this.extensions = status.extensions
      } catch (err) {
        this.loadError = err instanceof Error ? err.message : 'Content extensions could not be loaded.'
      } finally {
        this.isLoading = false
        await this.$nextTick()
        if (!this.loadError && this.canInsertQr) {
          const valueInput = this.$refs.valueInput as { focus?: () => void } | undefined
          valueInput?.focus?.()
        }
      }
    },
    insertExtension () {
      this.touched.value = true
      this.touched.label = true
      this.touched.size = true
      this.submitError = ''
      if (!this.canInsertQr || !this.isFormValid) return

      try {
        const props: Record<string, unknown> = {
          value: this.value,
          size: this.size,
          errorCorrection: this.errorCorrection
        }
        if (this.label.length > 0) props.label = this.label
        const envelope = parseContentExtensionEnvelope({
          key: 'qr',
          version: 1,
          props
        })
        emitEditorInsert({
          kind: 'EXTENSION',
          text: serializeContentExtensionFence(envelope)
        })
        this.close()
      } catch (err) {
        this.submitError = err instanceof Error ? err.message : 'The QR extension settings are invalid.'
      }
    }
  },
  mounted () {
    document.addEventListener('keydown', this.handleEscape)
    void this.loadExtensions()
  },
  beforeUnmount () {
    document.removeEventListener('keydown', this.handleEscape)
  }
})
</script>

<style lang='scss'>
.editor-modal-blocks {
  position: fixed !important;
  top: 112px;
  left: 64px;
  z-index: 10;
  width: calc(100vw - 64px - 17px);
  height: calc(100vh - 112px - 24px);
  overflow-y: auto;
  background-color: rgba(darken(mc('grey', '900'), 3%), .96) !important;

  @include until($tablet) {
    top: 64px;
    left: 0;
    width: 100vw;
    height: calc(100vh - 64px);
  }
}
</style>
