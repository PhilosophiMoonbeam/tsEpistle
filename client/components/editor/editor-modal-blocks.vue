<template lang='pug'>
v-card.editor-modal-blocks.animated.fadeInLeft(flat, tile, role='dialog', aria-modal='true', aria-labelledby='content-extension-title')
  v-toolbar(color='grey darken-4', dark, flat)
    v-icon.mr-3(color='teal lighten-2') {{activeStatus?.icon || 'mdi-shape-outline'}}
    v-toolbar-title#content-extension-title Insert content extension
    v-spacer
    v-btn(icon, aria-label='Close content extension dialog', @click='close')
      v-icon mdi-close
  v-container.py-6(fluid)
    v-row(justify='center')
      v-col(cols='12', md='9', lg='7', xl='6')
        v-skeleton-loader(v-if='isLoading', type='heading, paragraph, paragraph, actions')
        template(v-else-if='loadError')
          v-alert.mb-4(type='error', variant='tonal') {{loadError}}
          v-btn(color='teal', dark, @click='loadExtensions') Retry
        template(v-else)
          v-select.mb-5(
            v-model='selectedKey'
            :items='extensionOptions'
            label='Extension type'
            item-title='title'
            item-value='value'
            hide-details
          )
          v-alert(v-if='!activeStatus || !canInsertActive', type='warning', variant='tonal')
            .font-weight-medium {{activeStatus?.title || 'Content extension'}} is unavailable
            .mt-1 {{availabilityDiagnostic}}
          v-card.radius-7(v-else, light, flat)
            v-card-title.d-flex.align-center
              span {{activeStatus.title}}
              v-spacer
              v-chip(color='teal', variant='outlined', size='small') Version {{activeStatus.version}}
            v-card-subtitle {{activeStatus.description}}
            v-card-text
              v-form(@submit.prevent='insertExtension')
                template(v-if='selectedKey === `qr`')
                  v-alert.mb-5(type='info', variant='tonal', density='compact')
                    | The QR code is generated locally when the page renders. No preview or data is sent to another service.
                  v-textarea(
                    v-model='qr.value'
                    label='Value'
                    hint='Enter the text or URL to encode.'
                    persistent-hint
                    rows='4'
                    auto-grow
                    counter='2048'
                    required
                  )
                  v-text-field.mt-5(
                    v-model='qr.label'
                    label='Accessible label (optional)'
                    hint='Describe the QR code purpose for screen reader users.'
                    persistent-hint
                    counter='200'
                  )
                  v-row.mt-2
                    v-col(cols='12', sm='6')
                      v-text-field(
                        v-model.number='qr.size'
                        type='number'
                        min='128'
                        max='1024'
                        step='1'
                        label='Size (pixels)'
                        hint='128–1024'
                        persistent-hint
                      )
                    v-col(cols='12', sm='6')
                      v-select(
                        v-model='qr.errorCorrection'
                        :items='correctionLevels'
                        label='Error correction'
                        hint='Higher levels tolerate more damage.'
                        persistent-hint
                      )
                template(v-else-if='selectedKey === `gallery`')
                  v-alert.mb-5(type='info', variant='tonal', density='compact')
                    | Gallery images must be same-origin asset paths. Each image requires alternative text and remains available as a normal link without JavaScript.
                  v-card.mb-4(v-for='(image, index) in gallery.images', :key='index', variant='outlined')
                    v-card-title.d-flex.align-center.text-subtitle-1
                      span Image {{index + 1}}
                      v-spacer
                      v-btn(
                        icon
                        size='small'
                        :disabled='gallery.images.length === 1'
                        :aria-label='`Remove image ${index + 1}`'
                        @click='removeGalleryImage(index)'
                      )
                        v-icon mdi-delete-outline
                    v-card-text
                      v-text-field(
                        v-model='image.src'
                        label='Asset path'
                        placeholder='/uploads/example.jpg'
                        hint='A safe same-origin path beginning with /.'
                        persistent-hint
                        required
                      )
                      v-text-field.mt-4(
                        v-model='image.alt'
                        label='Alternative text'
                        counter='200'
                        required
                      )
                      v-text-field.mt-4(
                        v-model='image.caption'
                        label='Caption (optional)'
                        counter='300'
                      )
                  v-btn.mb-5(variant='outlined', :disabled='gallery.images.length >= 50', @click='addGalleryImage')
                    v-icon(left) mdi-plus
                    | Add image
                  v-row
                    v-col(cols='12', sm='4')
                      v-select(v-model='gallery.columns', :items='galleryColumns', label='Maximum columns')
                    v-col(cols='12', sm='4')
                      v-select(v-model='gallery.fit', :items='galleryFits', label='Thumbnail fit')
                    v-col(cols='12', sm='4')
                      v-select(v-model='gallery.aspectRatio', :items='galleryAspectRatios', label='Tile shape')
                template(v-else-if='selectedKey === `index`')
                  v-alert.mb-5(type='info', variant='tonal', density='compact')
                    | Results load for each reader and are filtered through current page ownership and page-rule permissions. Broad indexes fail closed instead of running an unbounded query.
                  v-text-field(
                    v-model='index.path'
                    label='Parent path'
                    hint='No leading or trailing slash. Leave empty for the locale root.'
                    persistent-hint
                  )
                  v-text-field.mt-4(
                    v-model='index.locale'
                    label='Locale'
                    counter='20'
                    required
                  )
                  v-row.mt-2
                    v-col(cols='12', sm='4')
                      v-text-field(
                        v-model.number='index.depth'
                        type='number'
                        min='0'
                        max='5'
                        step='1'
                        label='Nested depth'
                      )
                    v-col(cols='12', sm='4')
                      v-select(v-model='index.columns', :items='indexColumns', label='Maximum columns')
                    v-col(cols='12', sm='4')
                      v-text-field(
                        v-model.number='index.limit'
                        type='number'
                        min='1'
                        max='200'
                        step='1'
                        label='Maximum pages'
                      )
                  v-row
                    v-col(cols='12', sm='6')
                      v-select(v-model='index.order', :items='indexOrders', label='Order by')
                    v-col.d-flex.align-center(cols='12', sm='6')
                      v-switch(v-model='index.showIcons', label='Show page icons', hide-details)
                  v-text-field.mt-2(
                    v-model='index.emptyLabel'
                    label='Empty-state label (optional)'
                    counter='200'
                  )
                v-alert.mt-4(v-if='submitError', type='error', variant='tonal', density='compact') {{submitError}}
                .d-flex.flex-wrap.justify-end.mt-6
                  v-btn.mr-3(text, @click='close') Cancel
                  v-btn(color='teal', dark, type='submit', :disabled='!canSubmit || !canInsertActive')
                    v-icon(left) mdi-plus
                    | Insert {{activeStatus.title}}
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { wikiStore } from '@/store/index.ts'
import { emitEditorInsert } from '../../helpers/editor-insert-events'
import { fetchContentExtensions, type ContentExtensionStatus } from '../../helpers/content-extensions-api'
import {
  parseContentExtensionEnvelope,
  serializeContentExtensionFence,
  type ContentExtensionKey
} from '../../../shared/content-extensions.ts'

type ErrorCorrection = 'L' | 'M' | 'Q' | 'H'
type GalleryImageForm = { src: string, alt: string, caption: string }

const defaultIndexPath = (): string => wikiStore.page.path.split('/').slice(0, -1).join('/')

export default defineComponent({
  data() {
    return {
      extensions: [] as ContentExtensionStatus[],
      selectedKey: 'qr' as ContentExtensionKey,
      isLoading: true,
      loadError: '',
      submitError: '',
      qr: {
        value: '',
        label: '',
        size: 256,
        errorCorrection: 'M' as ErrorCorrection
      },
      gallery: {
        images: [{ src: '', alt: '', caption: '' }] as GalleryImageForm[],
        columns: 3 as 1 | 2 | 3 | 4,
        fit: 'cover' as 'cover' | 'contain',
        aspectRatio: 'square' as 'square' | 'natural'
      },
      index: {
        path: defaultIndexPath(),
        locale: wikiStore.page.locale || 'en',
        depth: 0,
        columns: 2 as 1 | 2 | 3,
        showIcons: false,
        order: 'path' as 'path' | 'title' | 'updated',
        limit: 50,
        emptyLabel: ''
      },
      correctionLevels: [
        { title: 'Low (L)', value: 'L' },
        { title: 'Medium (M)', value: 'M' },
        { title: 'Quartile (Q)', value: 'Q' },
        { title: 'High (H)', value: 'H' }
      ],
      galleryColumns: [1, 2, 3, 4],
      galleryFits: [
        { title: 'Crop to fill', value: 'cover' },
        { title: 'Show whole image', value: 'contain' }
      ],
      galleryAspectRatios: [
        { title: 'Square tiles', value: 'square' },
        { title: 'Natural image ratio', value: 'natural' }
      ],
      indexColumns: [1, 2, 3],
      indexOrders: [
        { title: 'Path', value: 'path' },
        { title: 'Title', value: 'title' },
        { title: 'Recently updated', value: 'updated' }
      ]
    }
  },
  computed: {
    extensionOptions(): Array<{ title: string, value: ContentExtensionKey }> {
      return this.extensions.map(extension => ({
        title: `${extension.title}${extension.isEnabled && extension.compatible ? '' : ' (unavailable)'}`,
        value: extension.key
      }))
    },
    activeStatus(): ContentExtensionStatus | undefined {
      return this.extensions.find(extension => extension.key === this.selectedKey)
    },
    canInsertActive(): boolean {
      return Boolean(this.activeStatus?.isEnabled && this.activeStatus.compatible)
    },
    availabilityDiagnostic(): string {
      if (!this.activeStatus) return 'The server did not advertise this extension.'
      if (this.activeStatus.diagnostic) return this.activeStatus.diagnostic
      if (!this.activeStatus.isEnabled) return 'This extension is disabled by an administrator.'
      return 'This editor host is not compatible with the installed extension.'
    },
    canSubmit(): boolean {
      if (this.selectedKey === 'qr') {
        return this.qr.value.length >= 1 && this.qr.value.length <= 2048 && this.qr.label.length <= 200 &&
          Number.isInteger(this.qr.size) && this.qr.size >= 128 && this.qr.size <= 1024
      }
      if (this.selectedKey === 'gallery') {
        return this.gallery.images.length >= 1 && this.gallery.images.length <= 50 && this.gallery.images.every(image =>
          image.src.length >= 1 && image.alt.length >= 1 && image.alt.length <= 200 && image.caption.length <= 300
        )
      }
      return this.index.locale.length >= 2 && this.index.locale.length <= 20 &&
        Number.isInteger(this.index.depth) && this.index.depth >= 0 && this.index.depth <= 5 &&
        Number.isInteger(this.index.limit) && this.index.limit >= 1 && this.index.limit <= 200 &&
        this.index.emptyLabel.length <= 200
    }
  },
  methods: {
    close () {
      wikiStore.editor.activeModal = ''
    },
    handleEscape (event: KeyboardEvent) {
      if (event.key === 'Escape') this.close()
    },
    addGalleryImage () {
      if (this.gallery.images.length < 50) this.gallery.images.push({ src: '', alt: '', caption: '' })
    },
    removeGalleryImage (index: number) {
      if (this.gallery.images.length > 1) this.gallery.images.splice(index, 1)
    },
    async loadExtensions () {
      this.isLoading = true
      this.loadError = ''
      try {
        const status = await fetchContentExtensions(fetch)
        this.extensions = status.extensions
        const available = this.extensions.find(extension => extension.isEnabled && extension.compatible)
        if (available) this.selectedKey = available.key
      } catch (err) {
        this.loadError = err instanceof Error ? err.message : 'Content extensions could not be loaded.'
      } finally {
        this.isLoading = false
      }
    },
    insertExtension () {
      this.submitError = ''
      if (!this.canInsertActive || !this.canSubmit) return
      try {
        let input: Record<string, unknown>
        if (this.selectedKey === 'qr') {
          input = {
            key: 'qr',
            version: 1,
            props: {
              value: this.qr.value,
              ...(this.qr.label.length > 0 ? { label: this.qr.label } : {}),
              size: this.qr.size,
              errorCorrection: this.qr.errorCorrection
            }
          }
        } else if (this.selectedKey === 'gallery') {
          input = {
            key: 'gallery',
            version: 1,
            props: {
              images: this.gallery.images.map(image => ({
                src: image.src,
                alt: image.alt,
                ...(image.caption.length > 0 ? { caption: image.caption } : {})
              })),
              columns: this.gallery.columns,
              fit: this.gallery.fit,
              aspectRatio: this.gallery.aspectRatio
            }
          }
        } else {
          input = {
            key: 'index',
            version: 1,
            props: {
              path: this.index.path,
              locale: this.index.locale,
              depth: this.index.depth,
              columns: this.index.columns,
              showIcons: this.index.showIcons,
              order: this.index.order,
              limit: this.index.limit,
              ...(this.index.emptyLabel.length > 0 ? { emptyLabel: this.index.emptyLabel } : {})
            }
          }
        }
        const envelope = parseContentExtensionEnvelope(input)
        emitEditorInsert({ kind: 'EXTENSION', text: serializeContentExtensionFence(envelope) })
        this.close()
      } catch (err) {
        this.submitError = err instanceof Error ? err.message : 'The extension settings are invalid.'
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

  @media (max-width: 1599.98px) {
    .v-container {
      padding-right: 24px !important;
      padding-left: 24px !important;
    }
  }

  @include until($tablet) {
    top: 64px;
    left: 0;
    width: 100vw;
    height: calc(100vh - 64px);

    .v-container {
      padding-right: 12px !important;
      padding-left: 12px !important;
    }
  }
}
</style>
