<template lang='pug'>
  .editor-okf-panel
    v-progress-linear(v-if='okfLoading', indeterminate, color='primary', aria-label='Loading Knowledge / OKF data')
    v-alert.mb-4(v-if='okfError', type='error', variant='tonal', role='alert')
      .d-flex.align-center
        span {{ okfError }}
        v-spacer
        v-chip(size='small', color='error', variant='outlined') Load error

    v-alert.mb-4(v-if='!hasMetadata', type='warning', variant='tonal', role='status')
      .d-flex.align-center.flex-wrap.ga-2
        span {{ isInvalid ? 'The Knowledge / OKF authority record is invalid.' : 'No Knowledge / OKF authority metadata is available.' }}
        v-btn.ml-auto(size='small', color='primary', variant='outlined', @click='resetInvalid') Reset to stable reference

    v-card.mb-4(variant='outlined')
      v-card-title.text-body-large Authority
      v-card-text
        v-row(density='compact')
          v-col(cols='12', sm='6', md='3')
            .text-label-small.text-medium-emphasis State
            v-chip.mt-1(:color='authorityStateColor', size='small', label) {{ authorityState }}
          v-col(cols='12', sm='6', md='3')
            .text-label-small.text-medium-emphasis Source revision
            .text-body-medium.mt-1 {{ sourceRevision || '—' }}
          v-col(cols='12', sm='6', md='3')
            .text-label-small.text-medium-emphasis Projection
            v-chip.mt-1(:color='projectionStateColor', size='small', label) {{ projectionState }}
          v-col(cols='12', sm='6', md='3')
            .text-label-small.text-medium-emphasis Completeness
            v-chip.mt-1(v-if='projection', :color='projectionComplete ? `success` : `warning`', size='small', label) {{ projection.state }}
            span(v-else) —
        v-divider.my-3
        v-row(density='compact')
          v-col(cols='12', sm='6')
            .text-label-small.text-medium-emphasis Trust tier
            .text-body-medium.mt-1 {{ trust?.trustTier || '—' }}
          v-col(cols='12', sm='6')
            .text-label-small.text-medium-emphasis Verification
            .text-body-medium.mt-1 {{ trust?.verification || '—' }}
          v-col(cols='12', sm='6')
            .text-label-small.text-medium-emphasis Authority status
            v-chip.mt-1(:color='trust?.status === `stable` ? `success` : trust?.status === `deprecated` ? `error` : `warning`', size='small', label) {{ trust?.status || '—' }}
          v-col(cols='12', sm='6')
            .text-label-small.text-medium-emphasis Stale
            v-chip.mt-1(:color='trust?.stale ? `warning` : `success`', size='small', label) {{ trust ? (trust.stale ? 'stale' : 'current') : '—' }}
          v-col(cols='12', sm='6')
            .text-label-small.text-medium-emphasis Generated
            .text-body-small.mt-1 {{ trust?.generatedAt || '—' }}
          v-col(cols='12', sm='6')
            .text-label-small.text-medium-emphasis Verified
            .text-body-small.mt-1 {{ trust?.verifiedAt || '—' }}

    v-card.mb-4(variant='outlined')
      v-card-title.text-body-large Editable metadata
      v-card-text
        v-row
          v-col(cols='12', md='6')
            v-text-field(v-model='metadataType', label='Type', variant='outlined', :disabled='!hasMetadata', required)
          v-col(cols='12', md='6')
            v-select(v-model='metadataStatus', label='Status', variant='outlined', :items='statusItems', :disabled='!hasMetadata')
          v-col(cols='12', md='6')
            v-text-field(v-model='metadataResource', label='Resource', variant='outlined', :disabled='!hasMetadata', hint='Canonical resource identifier', persistent-hint)
          v-col(cols='12', md='6')
            v-text-field(v-model='metadataStaleAfter', label='Stale after', variant='outlined', :disabled='!hasMetadata', hint='ISO-8601 timestamp', persistent-hint)
        .d-flex.align-center.mt-2.mb-2
          .text-title-small Sources
          v-spacer
          v-btn(size='small', variant='tonal', color='primary', :disabled='!hasMetadata', @click='addSource')
            v-icon(start) mdi-plus
            span Add source
        .text-body-small.text-medium-emphasis.mb-2(v-if='sources.length === 0') No sources recorded.
        v-row(v-for='(source, index) of sources', :key='`source-${index}`', density='compact', align='center')
          v-col(cols='12', md='4')
            v-text-field(:model-value='source.resource', label='Source resource', variant='outlined', density='compact', :disabled='!hasMetadata', @update:model-value='updateSource(index, { resource: $event })')
          v-col(cols='12', sm='6', md='3')
            v-text-field(:model-value='source.id', label='Source ID', variant='outlined', density='compact', :disabled='!hasMetadata', @update:model-value='updateSource(index, { id: $event })')
          v-col(cols='12', sm='6', md='4')
            v-text-field(:model-value='source.title', label='Source title', variant='outlined', density='compact', :disabled='!hasMetadata', @update:model-value='updateSource(index, { title: $event })')
          v-col(cols='12', md='1').d-flex.justify-end
            v-btn(icon='mdi-delete-outline', variant='text', color='error', size='small', :disabled='!hasMetadata', :aria-label='`Remove source ${index + 1}`', @click='removeSource(index)')

        .text-title-small.mt-4.mb-2 Extension JSON
        .text-body-small.text-medium-emphasis.mb-2 Non-core metadata keys are edited as a JSON object.
        v-textarea(v-model='extensionText', label='Extensions', variant='outlined', rows='7', auto-grow, spellcheck='false', :disabled='!hasMetadata', @update:model-value='extensionEditing = true')
        v-alert.mb-2(v-if='extensionError', type='error', variant='tonal', density='compact', role='alert') {{ extensionError }}
        v-btn(color='primary', variant='tonal', :disabled='!hasMetadata', @click='applyExtensions') Apply extensions

    v-card.mb-4(variant='outlined')
      v-card-title.text-body-large Knowledge projection
      v-card-text
        v-alert.mb-3(v-if='!projection', type='info', variant='tonal') Projection is pending and no current value is available.
        template(v-if='projection')
          v-row(density='compact')
            v-col(cols='12', md='4')
              .text-label-small.text-medium-emphasis Concept type
              .text-body-medium.mt-1 {{ projection.conceptType || '—' }}
            v-col(cols='12', md='8')
              .text-label-small.text-medium-emphasis Summary
              .text-body-medium.mt-1 {{ projection.summary || '—' }}
          v-row.mt-1(density='compact')
            v-col(cols='12', md='6')
              .text-label-small.text-medium-emphasis Tags
              .text-body-medium.mt-1 {{ projection.tags.join(', ') || '—' }}
            v-col(cols='12', md='6')
              .text-label-small.text-medium-emphasis Missing fields
              .text-body-medium.mt-1 {{ projection.missingFields.join(', ') || 'None' }}
          v-row.mt-1(density='compact')
            v-col(cols='12', md='4')
              .text-label-small.text-medium-emphasis Entities
              v-list(v-if='projection.entities.length', density='compact', lines='one')
                v-list-item(v-for='entity of projection.entities', :key='`${entity.name}-${entity.type}`', :title='`${entity.name} (${entity.type})`')
              .text-body-small(v-else) —
            v-col(cols='12', md='4')
              .text-label-small.text-medium-emphasis Relationships
              v-list(v-if='projection.relationships.length', density='compact', lines='one')
                v-list-item(v-for='relationship of projection.relationships', :key='`${relationship.subject}-${relationship.predicate}-${relationship.object}`', :title='`${relationship.subject} — ${relationship.predicate} — ${relationship.object}`')
              .text-body-small(v-else) —
            v-col(cols='12', md='4')
              .text-label-small.text-medium-emphasis Open questions
              v-list(v-if='projection.openQuestions.length', density='compact', lines='one')
                v-list-item(v-for='question of projection.openQuestions', :key='question', :title='question')
              .text-body-small(v-else) —

    v-card(variant='outlined')
      v-card-title.text-body-large Provenance
      v-card-text
        v-row(density='compact')
          v-col(cols='12', md='4')
            .text-label-small.text-medium-emphasis Deterministic version
            .text-body-medium.mt-1 {{ projection?.provenance.deterministicVersion || '—' }}
          v-col(cols='12', md='8')
            .text-label-small.text-medium-emphasis Projection revision
            .text-body-medium.mt-1 {{ projection?.sourceRevision || '—' }}
        v-list(v-if='projection?.provenance.fields?.length', density='compact', lines='three')
          v-list-subheader Evidence
          v-list-item(v-for='field of projection.provenance.fields', :key='`${field.field}-${field.source}`')
            v-list-item-title {{ field.field }} · {{ field.source }}
            v-list-item-subtitle {{ field.evidence }}
        .text-body-small.text-medium-emphasis(v-else) No field-level evidence recorded.
        v-divider.my-3
        .text-title-small.mb-2 Utility profile
        v-row(v-if='utility', density='compact')
          v-col(cols='12', md='4')
            .text-label-small.text-medium-emphasis Profile version
            .text-body-small.mt-1 {{ utility.profileVersionId }}
          v-col(cols='12', md='4')
            .text-label-small.text-medium-emphasis Model
            .text-body-small.mt-1 {{ utility.model }}
          v-col(cols='12', md='4')
            .text-label-small.text-medium-emphasis Generated at
            .text-body-small.mt-1 {{ utility.generatedAt }}
          v-col(cols='12', md='6')
            .text-label-small.text-medium-emphasis Input SHA-256
            code.d-block.text-body-small.mt-1 {{ utility.inputSha256 }}
          v-col(cols='12', md='6')
            .text-label-small.text-medium-emphasis Output SHA-256
            code.d-block.text-body-small.mt-1 {{ utility.outputSha256 }}
        .text-body-small.text-medium-emphasis(v-else) No utility projection was used.
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { wikiStore } from '@/store/index.ts'
import type { KnowledgeProjectionView, OkfMetadata, OkfSource, OkfTrustSummary } from '../../helpers/pages-api'

const CORE_METADATA_KEYS = new Set([
  'type', 'title', 'description', 'resource', 'tags', 'status', 'generated', 'verified', 'stale_after', 'sources',
  'restored_from', 'x-wiki'
])
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

type ExtensionParseResult = { value: Record<string, unknown>; error: null } | { value: null; error: string }

export function parseExtensionJson (text: string): ExtensionParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { value: null, error: 'Extensions must contain valid JSON.' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, error: 'Extensions must be a JSON object.' }
  }
  const inspect = (value: unknown, root = false): boolean => {
    if (Array.isArray(value)) return value.every(entry => inspect(entry))
    if (!value || typeof value !== 'object') return true
    return Object.entries(value).every(([key, entry]) => !DANGEROUS_KEYS.has(key) && (!root || !CORE_METADATA_KEYS.has(key)) && inspect(entry))
  }
  if (!inspect(parsed, true)) return { value: null, error: 'Extensions may only contain non-core metadata keys.' }
  return { value: parsed as Record<string, unknown>, error: null }
}

export default defineComponent({
  name: 'EditorOkfPanel',
  data () {
    return {
      extensionText: '{}',
      extensionError: '',
      extensionEditing: false,
      statusItems: ['draft', 'stable', 'deprecated'],
      okfStore: wikiStore
    }
  },
  computed: {
    okf () {
      return this.okfStore.page.okf
    },
    okfLoading () {
      return this.okfStore.page.okfLoading
    },
    okfError () {
      return this.okfStore.page.okfError
    },
    authority () {
      return this.okf.authority
    },
    authorityState () {
      return this.authority.state
    },
    authorityStateColor () {
      return this.authority.state === 'valid' ? 'success' : this.authority.state === 'missing' ? 'warning' : 'error'
    },
    sourceRevision () {
      return this.okfStore.page.sourceRevision
    },
    projection () {
      return this.okf.projection.value as KnowledgeProjectionView | null
    },
    projectionState () {
      return this.okf.projection.state
    },
    projectionStateColor () {
      return this.okf.projection.state === 'current' ? 'success' : 'warning'
    },
    projectionComplete () {
      return this.projection?.state === 'complete'
    },
    trust () {
      return this.authority.trust as OkfTrustSummary | null
    },
    utility () {
      return this.projection?.provenance.utility ?? null
    },
    authorityMetadata () {
      return this.authority.metadata as OkfMetadata | null
    },
    hasMetadata () {
      return this.authorityMetadata !== null
    },
    isInvalid () {
      return this.authority.state === 'invalid'
    },
    metadataType: {
      get (): string { return this.authorityMetadata?.type ?? '' },
      set (value: string) { this.updateMetadata({ type: value }) }
    },
    metadataStatus: {
      get (): string { return this.authorityMetadata?.status ?? '' },
      set (value: 'draft' | 'stable' | 'deprecated') { this.updateMetadata({ status: value }) }
    },
    metadataResource: {
      get (): string { return this.authorityMetadata?.resource ?? '' },
      set (value: string) { this.updateOptionalMetadata('resource', value) }
    },
    metadataStaleAfter: {
      get (): string { return this.authorityMetadata?.stale_after ?? '' },
      set (value: string) { this.updateOptionalMetadata('stale_after', value) }
    },
    sources (): OkfSource[] {
      return this.authorityMetadata?.sources ?? []
    },
    extensionValues (): Record<string, unknown> {
      const metadata = this.authorityMetadata
      if (!metadata) return {}
      return Object.fromEntries(Object.entries(metadata).filter(([key]) => !CORE_METADATA_KEYS.has(key)))
    },
    extensionSnapshot (): string {
      return JSON.stringify(this.extensionValues, null, 2)
    }
  },
  watch: {
    extensionSnapshot: {
      immediate: true,
      handler (value: string) {
        if (!this.extensionEditing) this.extensionText = value
      }
    }
  },
  methods: {
    replaceMetadata (metadata: OkfMetadata) {
      const current = this.okfStore.page.okf
      this.okfStore.page.okf = {
        ...current,
        authority: {
          ...current.authority,
          metadata
        }
      }
    },
    updateMetadata (patch: Partial<OkfMetadata>) {
      const metadata = this.authorityMetadata
      if (!metadata) return
      this.replaceMetadata({ ...metadata, ...patch })
    },
    updateOptionalMetadata (field: 'resource' | 'stale_after', value: string) {
      const metadata = this.authorityMetadata
      if (!metadata) return
      const nextMetadata = { ...metadata }
      if (value === '') delete nextMetadata[field]
      else nextMetadata[field] = value
      this.replaceMetadata(nextMetadata)
    },
    addSource () {
      if (!this.hasMetadata) return
      this.updateMetadata({ sources: [...this.sources, { resource: '' }] })
    },
    updateSource (index: number, patch: Partial<OkfSource>) {
      if (!this.hasMetadata || !this.sources[index]) return
      const sources = this.sources.map((source, sourceIndex) => sourceIndex === index ? { ...source, ...patch } : { ...source })
      this.updateMetadata({ sources })
    },
    removeSource (index: number) {
      if (!this.hasMetadata) return
      this.updateMetadata({ sources: this.sources.filter((_source, sourceIndex) => sourceIndex !== index) })
    },
    resetInvalid () {
      if (this.hasMetadata) return
      const current = this.okfStore.page.okf
      this.okfStore.page.okf = {
        ...current,
        authority: {
          ...current.authority,
          state: 'valid',
          metadata: { type: 'Reference', status: 'stable' }
        }
      }
      this.extensionError = ''
      this.extensionEditing = false
    },
    applyExtensions () {
      const result = parseExtensionJson(this.extensionText)
      this.extensionError = result.error ?? ''
      if (!result.value || !this.authorityMetadata) return
      const metadata: Record<string, unknown> = { ...this.authorityMetadata }
      for (const key of Object.keys(this.extensionValues)) delete metadata[key]
      this.replaceMetadata({ ...metadata, ...result.value } as OkfMetadata)
      this.extensionEditing = false
    }
  }
})
</script>

<style lang='scss' scoped>
.editor-okf-panel {
  min-height: 0;
  padding: 20px;

  .v-card-title {
    color: rgb(var(--v-theme-on-surface));
  }

  .text-medium-emphasis {
    color: rgba(var(--v-theme-on-surface), .68);
  }

  code {
    overflow-wrap: anywhere;
    white-space: normal;
  }
}

@media (max-width: 600px) {
  .editor-okf-panel {
    padding: 12px;
  }
}
</style>
