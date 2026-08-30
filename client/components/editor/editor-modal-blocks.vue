<template lang='pug'>
v-dialog.editor-modal-blocks-dialog(:model-value='true', fullscreen, scrollable, @update:model-value='close'): v-card.editor-modal-blocks.animated.fadeInLeft(flat, rounded='0', role='dialog', aria-modal='true', aria-labelledby='content-extension-title')
  v-toolbar(color="grey-darken-4", flat)
    v-icon.mr-3(color="teal-lighten-2") {{activeStatus?.icon || 'mdi-shape-outline'}}
    v-toolbar-title#content-extension-title Insert content extension
    v-spacer
    v-btn(icon, aria-label='Close content extension dialog', @click='close')
      v-icon mdi-close
  v-container.editor-modal-blocks-body.py-6(fluid)
    v-row.justify-center
      v-col(cols='12', md='9', lg='7', xl='6')
        v-skeleton-loader(v-if='isLoading', type='heading, paragraph, paragraph, actions')
        template(v-else-if='loadError')
          v-alert.mb-4(type='error', variant='tonal') {{loadError}}
          v-btn(color='teal', @click='loadExtensions') Retry
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
          v-card.radius-7(v-else, flat)
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
                    v-card-title.d-flex.align-center.text-body-large
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
                    v-icon(start) mdi-plus
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
                template(v-else-if='selectedKey === `tabs`')
                  v-alert.mb-5(type='info', variant='tonal', density='compact')
                    | Every panel keeps a readable no-script and print fallback. Panel content is preserved as plain text in canonical page source.
                  v-card.mb-4(v-for='(panel, panelIndex) in tabs.panels', :key='panelIndex', variant='outlined')
                    v-card-title.d-flex.align-center.text-body-large
                      span Panel {{panelIndex + 1}}
                      v-spacer
                      v-btn(
                        icon
                        size='small'
                        :disabled='tabs.panels.length <= 2'
                        :aria-label='`Remove panel ${panelIndex + 1}`'
                        @click='removeTabPanel(panelIndex)'
                      )
                        v-icon mdi-delete-outline
                    v-card-text
                      v-text-field(v-model='panel.label', label='Tab label', counter='100', required)
                      v-select.mt-4(
                        v-model='panel.headingLevel'
                        :items='tabHeadingLevels'
                        label='Contents heading level (optional)'
                        hint='Lists this tab label in the page table of contents. Opening that entry reveals this panel.'
                        persistent-hint
                        clearable
                      )
                      v-textarea.mt-4.source-textarea(v-model='panel.content', label='Panel content', rows='4', auto-grow, counter='20000', required)
                  v-btn.mb-5(variant='outlined', :disabled='tabs.panels.length >= 12', @click='addTabPanel')
                    v-icon(start) mdi-plus
                    | Add panel
                  v-select(
                    v-model='tabs.active'
                    :items='tabs.panels.map((panel, panelIndex) => ({ title: panel.label || `Panel ${panelIndex + 1}`, value: panelIndex }))'
                    label='Initially selected panel'
                  )
                template(v-else-if='selectedKey === `spoiler`')
                  v-alert.mb-5(type='info', variant='tonal', density='compact')
                    | Hidden content remains readable without JavaScript and in print. The browser disclosure control is added only after hydration.
                  v-text-field(v-model='spoiler.label', label='Cover label', counter='200')
                  v-text-field.mt-4(v-model='spoiler.hint', label='Cover hint', counter='200')
                  v-textarea.mt-4.source-textarea(v-model='spoiler.content', label='Hidden content', rows='6', auto-grow, counter='20000', required)
                template(v-else-if='selectedKey === `infobox`')
                  v-text-field(v-model='infobox.title', label='Title', counter='200', required)
                  v-text-field.mt-4(
                    v-model='infobox.image'
                    label='Image asset path (optional)'
                    placeholder='/uploads/example.jpg'
                    hint='Same-origin asset paths only.'
                    persistent-hint
                  )
                  v-text-field.mt-4(v-if='infobox.image', v-model='infobox.imageAlt', label='Image alternative text', counter='200', required)
                  v-text-field.mt-4(v-if='infobox.image', v-model='infobox.caption', label='Image caption (optional)', counter='300')
                  v-card.mt-4.mb-4(v-for='(fact, factIndex) in infobox.facts', :key='factIndex', variant='outlined')
                    v-card-title.d-flex.align-center.text-body-large
                      span Fact {{factIndex + 1}}
                      v-spacer
                      v-btn(
                        icon
                        size='small'
                        :disabled='infobox.facts.length === 1'
                        :aria-label='`Remove fact ${factIndex + 1}`'
                        @click='removeInfoboxFact(factIndex)'
                      )
                        v-icon mdi-delete-outline
                    v-card-text
                      v-text-field(v-model='fact.label', label='Label', counter='100', required)
                      v-select.mt-4(v-model='fact.kind', :items='factKinds', label='Value type')
                      v-textarea.mt-4(v-if='fact.kind === `text`', v-model='fact.value', label='Value', rows='2', auto-grow, counter='1000')
                  v-btn.mb-5(variant='outlined', :disabled='infobox.facts.length >= 50', @click='addInfoboxFact')
                    v-icon(start) mdi-plus
                    | Add fact
                template(v-else-if='selectedKey === `pdf`')
                  v-alert.mb-5(type='info', variant='tonal', density='compact')
                    | PDFs must be same-origin assets. Readers retain a normal open/download link when the embedded viewer is unavailable.
                  v-text-field(v-model='pdf.src', label='PDF asset path', placeholder='/uploads/document.pdf', required)
                  v-text-field.mt-4(v-model='pdf.title', label='Accessible title', counter='200')
                  v-row.mt-2
                    v-col(cols='12', sm='6')
                      v-text-field(v-model.number='pdf.page', type='number', min='1', max='100000', label='Opening page')
                    v-col(cols='12', sm='6')
                      v-text-field(v-model.number='pdf.height', type='number', min='320', max='1600', label='Viewer height')
                template(v-else-if='selectedKey === `media`')
                  v-alert.mb-5(type='info', variant='tonal', density='compact')
                    | Audio and video files must be same-origin assets and use native browser controls.
                  v-select(v-model='media.kind', :items='mediaKinds', label='Media type')
                  v-text-field.mt-4(v-model='media.src', label='Media asset path', placeholder='/uploads/media.mp4', required)
                  v-text-field.mt-4(v-model='media.title', label='Accessible title', counter='200')
                  v-text-field.mt-4(
                    v-if='media.kind === `video`'
                    v-model='media.poster'
                    label='Poster asset path (optional)'
                    placeholder='/uploads/poster.jpg'
                  )
                  v-text-field.mt-4(v-model='media.caption', label='Caption (optional)', counter='300')
                template(v-else-if='selectedKey === `youtube`')
                  v-alert.mb-5(type='info', variant='tonal', density='compact')
                    | The privacy-enhanced player is not requested until the reader explicitly loads it. A normal YouTube link remains available.
                  v-text-field(
                    v-model='youtube.url'
                    label='YouTube video URL or ID'
                    hint='Watch, youtu.be, shorts, live, and embed URLs are accepted.'
                    persistent-hint
                    required
                  )
                  v-text-field.mt-4(v-model='youtube.title', label='Accessible title', counter='200')
                  v-row.mt-2
                    v-col(cols='12', sm='6')
                      v-text-field(v-model.number='youtube.start', type='number', min='0', max='86400', label='Start time (seconds)')
                    v-col.d-flex.align-center(cols='12', sm='6')
                      v-switch(v-model='youtube.controls', label='Show player controls', hide-details)
                template(v-else-if='selectedKey === `diagram`')
                  v-alert.mb-5(type='info', variant='tonal', density='compact')
                    | Mermaid renders locally with strict security and no remote network request. Unsupported or unsafe SVG falls back to visible source.
                  v-textarea.source-textarea(v-model='diagram.source', label='Mermaid source', rows='8', counter='50000', required)
                  v-text-field.mt-4(v-model='diagram.caption', label='Caption (optional)', counter='300')
                  v-row.mt-2
                    v-col(cols='12', sm='6')
                      v-select(v-model='diagram.theme', :items='diagramThemes', label='Theme')
                    v-col(cols='12', sm='6')
                      v-select(v-model='diagram.align', :items='diagramAlignments', label='Alignment')
                template(v-else-if='selectedKey === `kroki`')
                  v-alert.mb-5(type='warning', variant='tonal', density='compact')
                    | Diagram source is sent to kroki.io only after the reader explicitly chooses to render it.
                  v-select(v-model='kroki.type', :items='krokiTypes', label='Diagram language')
                  v-textarea.mt-4.source-textarea(v-model='kroki.source', label='Diagram source', rows='8', counter='50000', required)
                  v-text-field.mt-4(v-model='kroki.caption', label='Caption (optional)', counter='300')
                  v-row.mt-2
                    v-col(cols='12', sm='6')
                      v-select(v-model='kroki.format', :items='diagramFormats', label='Output format')
                    v-col(cols='12', sm='6')
                      v-select(v-model='kroki.align', :items='diagramAlignments', label='Alignment')
                template(v-else-if='selectedKey === `plantuml`')
                  v-alert.mb-5(type='warning', variant='tonal', density='compact')
                    | Diagram source is sent to plantuml.com only after the reader explicitly chooses to render it.
                  v-textarea.source-textarea(v-model='plantuml.source', label='PlantUML source', rows='8', counter='50000', required)
                  v-text-field.mt-4(v-model='plantuml.caption', label='Caption (optional)', counter='300')
                  v-row.mt-2
                    v-col(cols='12', sm='6')
                      v-select(v-model='plantuml.format', :items='diagramFormats', label='Output format')
                    v-col(cols='12', sm='6')
                      v-select(v-model='plantuml.align', :items='diagramAlignments', label='Alignment')
                template(v-else-if='selectedKey === `map`')
                  v-alert.mb-5(type='warning', variant='tonal', density='compact')
                    | Map data loads from OpenStreetMap only after the reader explicitly continues. Coordinates are bounded and no arbitrary embed URL is accepted.
                  v-row
                    v-col(cols='12', sm='6')
                      v-text-field(v-model.number='map.latitude', type='number', min='-90', max='90', step='any', label='Latitude', required)
                    v-col(cols='12', sm='6')
                      v-text-field(v-model.number='map.longitude', type='number', min='-180', max='180', step='any', label='Longitude', required)
                  v-row
                    v-col(cols='12', sm='6')
                      v-text-field(v-model.number='map.zoom', type='number', min='1', max='19', label='Zoom')
                    v-col(cols='12', sm='6')
                      v-text-field(v-model.number='map.height', type='number', min='240', max='800', label='Map height')
                  v-text-field(v-model='map.label', label='Location label (optional)', counter='200')
                v-alert.mt-4(v-if='submitError', type='error', variant='tonal', density='compact') {{submitError}}
                .editor-modal-blocks-actions
                  v-btn.mr-3(variant="text", @click='close') Cancel
                  v-btn(color='teal', type='submit', :disabled='!canSubmit || !canInsertActive')
                    v-icon(start) mdi-plus
                    | Insert {{activeStatus.title}}

</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { wikiStore } from '@/store/index.ts'
import { emitEditorInsert } from '../../helpers/editor-insert-events'
import { fetchContentExtensions, type ContentExtensionStatus } from '../../helpers/content-extensions-api'
import {
  KROKI_DIAGRAM_TYPES,
  parseContentExtensionEnvelope,
  serializeContentExtensionFence,
  type ContentExtensionKey
} from '../../../shared/content-extensions.ts'

type ErrorCorrection = 'L' | 'M' | 'Q' | 'H'
type GalleryImageForm = { src: string, alt: string, caption: string }
type TabHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6
type TabPanelForm = { label: string, content: string, headingLevel: TabHeadingLevel | null }
type FactKind = 'text' | 'yes' | 'no'
type InfoboxFactForm = { label: string, value: string, kind: FactKind }

const readYoutubeVideoId = (source: string): string | null => {
  const value = source.trim()
  if (/^[A-Za-z0-9_-]{6,64}$/.test(value)) return value
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`)
    const host = url.hostname.toLowerCase().replace(/^(?:www|m)\./, '')
    let id: string | null = null
    if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0] ?? null
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      id = url.pathname === '/watch'
        ? url.searchParams.get('v')
        : /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(url.pathname)?.[1] ?? null
    }
    return id && /^[A-Za-z0-9_-]{6,64}$/.test(id) ? id : null
  } catch {
    return null
  }
}
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
      tabs: {
        panels: [
          { label: 'First tab', content: 'Content of the first tab.', headingLevel: null },
          { label: 'Second tab', content: 'Content of the second tab.', headingLevel: null }
        ] as TabPanelForm[],
        active: 0
      },
      spoiler: {
        label: 'Spoiler',
        hint: 'Show hidden content',
        content: ''
      },
      infobox: {
        title: '',
        image: '',
        imageAlt: '',
        caption: '',
        facts: [{ label: '', value: '', kind: 'text' as FactKind }] as InfoboxFactForm[]
      },
      pdf: {
        src: '',
        title: 'PDF document',
        page: 1,
        height: 720
      },
      media: {
        kind: 'video' as 'audio' | 'video',
        src: '',
        title: 'Video player',
        poster: '',
        caption: ''
      },
      youtube: {
        url: '',
        title: 'YouTube video',
        start: 0,
        controls: true
      },
      diagram: {
        source: 'flowchart LR\n  A[Start] --> B{Ready?}\n  B -->|Yes| C[Ship it]\n  B -->|No| A',
        caption: '',
        theme: 'auto' as 'auto' | 'default' | 'dark' | 'neutral' | 'forest',
        align: 'left' as 'left' | 'center'
      },
      kroki: {
        type: 'graphviz' as typeof KROKI_DIAGRAM_TYPES[number],
        source: 'digraph G {\n  Hello -> World\n}',
        format: 'svg' as 'svg' | 'png',
        caption: '',
        align: 'left' as 'left' | 'center'
      },
      plantuml: {
        source: '@startuml\nAlice -> Bob : hello\nBob --> Alice : hi\n@enduml',
        format: 'svg' as 'svg' | 'png',
        caption: '',
        align: 'left' as 'left' | 'center'
      },
      map: {
        latitude: 45.5019,
        longitude: -73.5674,
        zoom: 13,
        height: 400,
        label: ''
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
      ],
      tabHeadingLevels: [1, 2, 3, 4, 5, 6].map(level => ({ title: `Heading ${level}`, value: level as TabHeadingLevel })),
      factKinds: [
        { title: 'Text', value: 'text' },
        { title: 'Yes', value: 'yes' },
        { title: 'No', value: 'no' }
      ],
      mediaKinds: [
        { title: 'Video', value: 'video' },
        { title: 'Audio', value: 'audio' }
      ],
      diagramThemes: ['auto', 'default', 'dark', 'neutral', 'forest'],
      diagramAlignments: ['left', 'center'],
      diagramFormats: ['svg', 'png'],
      krokiTypes: [...KROKI_DIAGRAM_TYPES]
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
    youtubeVideoId(): string | null {
      return readYoutubeVideoId(this.youtube.url)
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
      if (this.selectedKey === 'index') {
        return this.index.locale.length >= 2 && this.index.locale.length <= 20 &&
          Number.isInteger(this.index.depth) && this.index.depth >= 0 && this.index.depth <= 5 &&
          Number.isInteger(this.index.limit) && this.index.limit >= 1 && this.index.limit <= 200 &&
          this.index.emptyLabel.length <= 200
      }
      if (this.selectedKey === 'tabs') {
        return this.tabs.panels.length >= 2 && this.tabs.panels.length <= 12 &&
          this.tabs.panels.every(panel => panel.label.length >= 1 && panel.label.length <= 100 &&
            panel.content.length >= 1 && panel.content.length <= 20000 &&
            (panel.headingLevel === null || (Number.isInteger(panel.headingLevel) && panel.headingLevel >= 1 && panel.headingLevel <= 6))) &&
          Number.isInteger(this.tabs.active) && this.tabs.active >= 0 && this.tabs.active < this.tabs.panels.length
      }
      if (this.selectedKey === 'spoiler') {
        return this.spoiler.label.length <= 200 && this.spoiler.hint.length <= 200 &&
          this.spoiler.content.length >= 1 && this.spoiler.content.length <= 20000
      }
      if (this.selectedKey === 'infobox') {
        return this.infobox.title.length >= 1 && this.infobox.title.length <= 200 &&
          (!this.infobox.image || (this.infobox.imageAlt.length >= 1 && this.infobox.imageAlt.length <= 200)) &&
          this.infobox.caption.length <= 300 &&
          this.infobox.facts.length >= 1 && this.infobox.facts.length <= 50 &&
          this.infobox.facts.every(fact => fact.label.length >= 1 && fact.label.length <= 100 &&
            (fact.kind !== 'text' || fact.value.length <= 1000))
      }
      if (this.selectedKey === 'pdf') {
        return this.pdf.src.length >= 1 && this.pdf.title.length <= 200 &&
          Number.isInteger(this.pdf.page) && this.pdf.page >= 1 && this.pdf.page <= 100000 &&
          Number.isInteger(this.pdf.height) && this.pdf.height >= 320 && this.pdf.height <= 1600
      }
      if (this.selectedKey === 'media') {
        return this.media.src.length >= 1 && this.media.title.length <= 200 &&
          this.media.caption.length <= 300 && (this.media.kind === 'video' || this.media.poster.length === 0)
      }
      if (this.selectedKey === 'youtube') {
        return this.youtubeVideoId !== null && this.youtube.title.length <= 200 &&
          Number.isInteger(this.youtube.start) && this.youtube.start >= 0 && this.youtube.start <= 86400
      }
      if (this.selectedKey === 'diagram') {
        return this.diagram.source.length >= 1 && this.diagram.source.length <= 50000 && this.diagram.caption.length <= 300
      }
      if (this.selectedKey === 'kroki') {
        return this.kroki.source.length >= 1 && this.kroki.source.length <= 50000 && this.kroki.caption.length <= 300
      }
      if (this.selectedKey === 'plantuml') {
        return this.plantuml.source.length >= 1 && this.plantuml.source.length <= 50000 && this.plantuml.caption.length <= 300
      }
      return Number.isFinite(this.map.latitude) && this.map.latitude >= -90 && this.map.latitude <= 90 &&
        Number.isFinite(this.map.longitude) && this.map.longitude >= -180 && this.map.longitude <= 180 &&
        Number.isInteger(this.map.zoom) && this.map.zoom >= 1 && this.map.zoom <= 19 &&
        Number.isInteger(this.map.height) && this.map.height >= 240 && this.map.height <= 800 &&
        this.map.label.length <= 200
    }
  },
  methods: {
    close () {
      wikiStore.editor.activeModal = ''
    },
    addGalleryImage () {
      if (this.gallery.images.length < 50) this.gallery.images.push({ src: '', alt: '', caption: '' })
    },
    removeGalleryImage (index: number) {
      if (this.gallery.images.length > 1) this.gallery.images.splice(index, 1)
    },
    addTabPanel () {
      if (this.tabs.panels.length < 12) this.tabs.panels.push({ label: `Panel ${this.tabs.panels.length + 1}`, content: '', headingLevel: null })
    },
    removeTabPanel (index: number) {
      if (this.tabs.panels.length <= 2) return
      this.tabs.panels.splice(index, 1)
      if (this.tabs.active >= this.tabs.panels.length) this.tabs.active = this.tabs.panels.length - 1
    },
    addInfoboxFact () {
      if (this.infobox.facts.length < 50) this.infobox.facts.push({ label: '', value: '', kind: 'text' })
    },
    removeInfoboxFact (index: number) {
      if (this.infobox.facts.length > 1) this.infobox.facts.splice(index, 1)
    },
    extensionInput (): Record<string, unknown> {
      if (this.selectedKey === 'qr') {
        return {
          key: 'qr',
          version: 1,
          props: {
            value: this.qr.value,
            ...(this.qr.label.length > 0 ? { label: this.qr.label } : {}),
            size: this.qr.size,
            errorCorrection: this.qr.errorCorrection
          }
        }
      }
      if (this.selectedKey === 'gallery') {
        return {
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
      }
      if (this.selectedKey === 'index') {
        return {
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
      if (this.selectedKey === 'tabs') {
        return {
          key: 'tabs',
          version: 1,
          props: {
            tabs: this.tabs.panels.map(panel => ({
              label: panel.label,
              content: panel.content,
              ...(panel.headingLevel === null ? {} : { headingLevel: panel.headingLevel })
            })),
            active: this.tabs.active
          }
        }
      }
      if (this.selectedKey === 'spoiler') {
        return {
          key: 'spoiler',
          version: 1,
          props: {
            label: this.spoiler.label,
            hint: this.spoiler.hint,
            content: this.spoiler.content
          }
        }
      }
      if (this.selectedKey === 'infobox') {
        return {
          key: 'infobox',
          version: 1,
          props: {
            title: this.infobox.title,
            ...(this.infobox.image.length > 0 ? {
              image: this.infobox.image,
              imageAlt: this.infobox.imageAlt,
              ...(this.infobox.caption.length > 0 ? { caption: this.infobox.caption } : {})
            } : {}),
            facts: this.infobox.facts.map(fact => ({
              label: fact.label,
              value: fact.kind === 'yes' ? true : fact.kind === 'no' ? false : fact.value
            }))
          }
        }
      }
      if (this.selectedKey === 'pdf') {
        return {
          key: 'pdf',
          version: 1,
          props: { src: this.pdf.src, title: this.pdf.title, page: this.pdf.page, height: this.pdf.height }
        }
      }
      if (this.selectedKey === 'media') {
        return {
          key: 'media',
          version: 1,
          props: {
            kind: this.media.kind,
            src: this.media.src,
            title: this.media.title,
            ...(this.media.kind === 'video' && this.media.poster.length > 0 ? { poster: this.media.poster } : {}),
            ...(this.media.caption.length > 0 ? { caption: this.media.caption } : {})
          }
        }
      }
      if (this.selectedKey === 'youtube') {
        return {
          key: 'youtube',
          version: 1,
          props: {
            videoId: this.youtubeVideoId,
            title: this.youtube.title,
            start: this.youtube.start,
            controls: this.youtube.controls
          }
        }
      }
      if (this.selectedKey === 'diagram') {
        return {
          key: 'diagram',
          version: 1,
          props: {
            source: this.diagram.source,
            ...(this.diagram.caption.length > 0 ? { caption: this.diagram.caption } : {}),
            theme: this.diagram.theme,
            align: this.diagram.align
          }
        }
      }
      if (this.selectedKey === 'kroki') {
        return {
          key: 'kroki',
          version: 1,
          props: {
            type: this.kroki.type,
            source: this.kroki.source,
            format: this.kroki.format,
            ...(this.kroki.caption.length > 0 ? { caption: this.kroki.caption } : {}),
            align: this.kroki.align
          }
        }
      }
      if (this.selectedKey === 'plantuml') {
        return {
          key: 'plantuml',
          version: 1,
          props: {
            source: this.plantuml.source,
            format: this.plantuml.format,
            ...(this.plantuml.caption.length > 0 ? { caption: this.plantuml.caption } : {}),
            align: this.plantuml.align
          }
        }
      }
      return {
        key: 'map',
        version: 1,
        props: {
          latitude: this.map.latitude,
          longitude: this.map.longitude,
          zoom: this.map.zoom,
          height: this.map.height,
          ...(this.map.label.length > 0 ? { label: this.map.label } : {})
        }
      }
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
        const input = this.extensionInput()
        const envelope = parseContentExtensionEnvelope(input)
        emitEditorInsert({ kind: 'EXTENSION', text: serializeContentExtensionFence(envelope) })
        this.close()
      } catch (err) {
        this.submitError = err instanceof Error ? err.message : 'The extension settings are invalid.'
      }
    }
  },
  mounted () {
    void this.loadExtensions()
  },
  beforeUnmount () {
    // Extension loading is request-scoped and does not require a global listener.
  }
})
</script>

<style lang='scss'>
.editor-modal-blocks {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100dvh;
  min-height: 0;
  background-color: rgba(darken(mc('grey', '900'), 3%), .96) !important;

  > .v-toolbar {
    flex: 0 0 auto;
  }

  &-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }

  &-actions {
    position: sticky;
    bottom: 0;
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding: 12px 0;
    margin-top: 24px;
    background: rgba(darken(mc('grey', '900'), 3%), .96);
  }

  .source-textarea textarea {
    font-family: 'Roboto Mono', monospace;
    line-height: 1.45;
    min-height: 180px;
    max-height: min(45dvh, 520px);
    overflow-y: auto;
  }

  @media (max-width: 1599.98px) {
    .v-container {
      padding-right: 24px !important;
      padding-left: 24px !important;
    }
  }

  @include until($tablet) {
    .v-container {
      padding-right: 12px !important;
      padding-left: 12px !important;
    }
  }
}
</style>
