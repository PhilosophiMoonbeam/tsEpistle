<template lang='pug'>
  .editor-okf-panel(:aria-busy='okfLoading')
    nav.editor-okf-navigation(:aria-label='$t(`editor:props.knowledge`)')
      a(href='#editor-okf-authority', @click.prevent='navigateKnowledge("editor-okf-authority")') {{ $t(`editor:editorOkfPanel.authority`) }}
      a(href='#editor-okf-metadata', @click.prevent='navigateKnowledge("editor-okf-metadata")') {{ $t(`editor:editorOkfPanel.editableMetadata`) }}
      a(href='#editor-okf-projection', @click.prevent='navigateKnowledge("editor-okf-projection")') {{ $t(`editor:editorOkfPanel.knowledgeProjection`) }}
      a(href='#editor-okf-provenance', @click.prevent='navigateKnowledge("editor-okf-provenance")') {{ $t(`editor:editorOkfPanel.provenance`) }}
    v-progress-linear(v-if='okfLoading', indeterminate, color='primary', :aria-label='$t(`editor:editorOkfPanel.loadingKnowledgeOkfData`)')
    v-alert.mb-4(v-if='okfError', type='error', variant='tonal', role='alert')
      .d-flex.align-center.flex-wrap.ga-2
        span {{ okfError }}
        v-spacer
        v-chip(size='small', color='error', variant='outlined') {{ $t(`editor:editorOkfPanel.loadError`) }}
        v-btn(
          v-if='canRetry'
          ref='retryButton'
          size='small'
          color='error'
          variant='tonal'
          :disabled='retryPending || okfLoading'
          :loading='retryPending || okfLoading'
          @click='retryLoad'
        ) {{ $t(`editor:editorOkfPanel.retry`) }}

    v-alert.mb-4(v-if='!okfLoading && !okfError && !hasMetadata', type='warning', variant='tonal', role='status')
      .d-flex.align-center.flex-wrap.ga-2
        span {{ isInvalid ? $t(`editor:editorOkfPanel.knowledgeOkfAuthorityRecord`) : $t(`editor:editorOkfPanel.noKnowledgeOkfAuthority`) }}
        v-btn.ml-auto(size='small', color='primary', variant='outlined', @click='resetInvalid') {{ $t(`editor:editorOkfPanel.resetStableReference`) }}

    v-card.mb-4#editor-okf-authority(variant='outlined', tabindex='-1')
      v-card-title.text-body-large(ref='authorityHeading', tabindex='-1') {{ $t(`editor:editorOkfPanel.authority`) }}
      v-card-text
        v-row(density='compact')
          v-col(cols='12', sm='6', md='3')
            .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.state`) }}
            v-chip.mt-1(:color='authorityStateColor', size='small', label) {{ authorityState }}
          v-col(cols='12', sm='6', md='3')
            .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.sourceRevision`) }}
            .text-body-medium.mt-1 {{ sourceRevision || '—' }}
          v-col(cols='12', sm='6', md='3')
            .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.projection`) }}
            v-chip.mt-1(:color='projectionStateColor', size='small', label) {{ projectionState }}
          v-col(cols='12', sm='6', md='3')
            .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.completeness`) }}
            v-chip.mt-1(v-if='projection', :color='projectionComplete ? `success` : `warning`', size='small', label) {{ projection.state }}
            span(v-else) —
        v-divider.my-3
        v-row(density='compact')
          v-col(cols='12', sm='6')
            .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.trustTier`) }}
            .text-body-medium.mt-1 {{ trust?.trustTier || '—' }}
          v-col(cols='12', sm='6')
            .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.verification`) }}
            .text-body-medium.mt-1 {{ trust?.verification || '—' }}
          v-col(cols='12', sm='6')
            .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.authorityStatus`) }}
            v-chip.mt-1(:color='trust?.status === `stable` ? `success` : trust?.status === `deprecated` ? `error` : `warning`', size='small', label) {{ trust?.status || '—' }}
          v-col(cols='12', sm='6')
            .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.stale`) }}
            v-chip.mt-1(:color='trust?.stale ? `warning` : `success`', size='small', label) {{ trust ? (trust.stale ? 'stale' : 'current') : '—' }}
          v-col(cols='12', sm='6')
            .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.generated`) }}
            .text-body-small.mt-1 {{ trust?.generatedAt || '—' }}
          v-col(cols='12', sm='6')
            .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.verified`) }}
            .text-body-small.mt-1 {{ trust?.verifiedAt || '—' }}

    v-card.mb-4#editor-okf-metadata(variant='outlined', tabindex='-1')
      v-card-title.text-body-large {{ $t(`editor:editorOkfPanel.editableMetadata`) }}
      v-card-text
        v-row
          v-col(cols='12', md='6')
            v-text-field(v-model='metadataType', :label='$t(`editor:editorOkfPanel.type`)', variant='outlined', :disabled='!hasMetadata', required)
          v-col(cols='12', md='6')
            v-select(v-model='metadataStatus', :label='$t(`editor:editorOkfPanel.status`)', variant='outlined', :items='statusItems', :disabled='!hasMetadata')
          v-col(cols='12', md='6')
            v-text-field(v-model='metadataResource', :label='$t(`editor:editorOkfPanel.resource`)', variant='outlined', :disabled='!hasMetadata', :hint='$t(`editor:editorOkfPanel.canonicalResourceIdentifier`)', persistent-hint)
          v-col(cols='12', md='6')
            v-text-field(v-model='metadataStaleAfter', :label='$t(`editor:editorOkfPanel.staleAfter`)', variant='outlined', :disabled='!hasMetadata', :hint='$t(`editor:editorOkfPanel.iso8601Timestamp`)', persistent-hint)
        .d-flex.align-center.mt-2.mb-2
          .text-title-small {{ $t(`editor:editorOkfPanel.sources`) }}
          v-spacer
          v-btn(
            ref='addSourceButton'
            size='small'
            variant='tonal'
            color='primary'
            :disabled='!hasMetadata'
            @click='addSource'
          )
            v-icon(start) mdi-plus
            span {{ $t(`editor:editorOkfPanel.addSource`) }}
        .text-body-small.text-medium-emphasis.mb-2(v-if='sources.length === 0') {{ $t(`editor:editorOkfPanel.noSourcesRecorded`) }}
        v-row.editor-okf-source.align-center(
          v-for='(source, index) of sources'
          :key='sourceKeys[index]'
          density='compact'
          role='group'
          :aria-label='$t(`editor:editorOkfPanel.source`, { value: index + 1, interpolation: { escapeValue: false } })'
        )
          v-col(cols='12')
            .text-label-large {{ $t(`editor:editorOkfPanel.source`, { value: index + 1, interpolation: { escapeValue: false } }) }}
          v-col(cols='12')
            v-text-field(:model-value='source.resource', :label='$t(`editor:editorOkfPanel.sourceResource`)', variant='outlined', density='compact', :disabled='!hasMetadata', @update:model-value='updateSource(index, { resource: $event })')
          v-col(cols='12', sm='6')
            v-text-field(:model-value='source.id', :label='$t(`editor:editorOkfPanel.sourceId`)', variant='outlined', density='compact', :disabled='!hasMetadata', @update:model-value='updateSource(index, { id: $event })')
          v-col(cols='12', sm='6')
            v-text-field(:model-value='source.title', :label='$t(`editor:editorOkfPanel.sourceTitle`)', variant='outlined', density='compact', :disabled='!hasMetadata', @update:model-value='updateSource(index, { title: $event })')
          v-col(cols='12').d-flex.justify-end
            v-btn(
              icon='mdi-delete-outline'
              variant='text'
              color='error'
              size='small'
              :disabled='!hasMetadata'
              :aria-label='$t(`editor:editorOkfPanel.removeSource`, { value: index + 1, interpolation: { escapeValue: false } })'
              @click='removeSource(index)'
            )

        .text-title-small.mt-4.mb-2 {{ $t(`editor:editorOkfPanel.extensionJson`) }}
        .text-body-small.text-medium-emphasis.mb-2 {{ $t(`editor:editorOkfPanel.nonCoreMetadataKeys`) }}
        v-textarea(v-model='extensionText', :label='$t(`editor:editorOkfPanel.extensions`)', variant='outlined', rows='7', auto-grow, spellcheck='false', :disabled='!hasMetadata', @update:model-value='extensionEditing = true')
        v-alert.mb-2(v-if='extensionError', type='error', variant='tonal', density='compact', role='alert') {{ extensionError }}
        v-btn(color='primary', variant='tonal', :disabled='!hasMetadata', @click='applyExtensions') {{ $t(`editor:editorOkfPanel.applyExtensions`) }}

    v-card.mb-4#editor-okf-projection(variant='outlined', tabindex='-1')
      v-card-title.text-body-large {{ $t(`editor:editorOkfPanel.knowledgeProjection`) }}
      v-card-text
        v-alert.mb-3(v-if='!projection', type='info', variant='tonal') {{ $t(`editor:editorOkfPanel.projectionPendingNoCurrent`) }}
        template(v-if='projection')
          v-row(density='compact')
            v-col(cols='12', md='4')
              .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.conceptType`) }}
              .text-body-medium.mt-1 {{ projection.conceptType || '—' }}
            v-col(cols='12', md='8')
              .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.summary`) }}
              .text-body-medium.mt-1 {{ projection.summary || '—' }}
          v-row.mt-1(density='compact')
            v-col(cols='12', md='6')
              .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.tags`) }}
              .text-body-medium.mt-1 {{ projection.tags.join(', ') || '—' }}
            v-col(cols='12', md='6')
              .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.missingFields`) }}
              .text-body-medium.mt-1 {{ projection.missingFields.join(', ') || $t(`editor:editorOkfPanel.none`) }}
          v-row.mt-1(density='compact')
            v-col(cols='12', md='4')
              .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.entities`) }}
              v-list(v-if='projection.entities.length', density='compact', lines='one')
                v-list-item(v-for='entity of projection.entities', :key='`${entity.name}-${entity.type}`', :title='`${entity.name} (${entity.type})`')
              .text-body-small(v-else) —
            v-col(cols='12', md='4')
              .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.relationships`) }}
              v-list(v-if='projection.relationships.length', density='compact', lines='one')
                v-list-item(v-for='relationship of projection.relationships', :key='`${relationship.subject}-${relationship.predicate}-${relationship.object}`', :title='`${relationship.subject} — ${relationship.predicate} — ${relationship.object}`')
              .text-body-small(v-else) —
            v-col(cols='12', md='4')
              .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.openQuestions`) }}
              v-list(v-if='projection.openQuestions.length', density='compact', lines='one')
                v-list-item(v-for='question of projection.openQuestions', :key='question', :title='question')
              .text-body-small(v-else) —

    v-card#editor-okf-provenance(variant='outlined', tabindex='-1')
      v-card-title.text-body-large {{ $t(`editor:editorOkfPanel.provenance`) }}
      v-card-text
        v-row(density='compact')
          v-col(cols='12', md='4')
            .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.deterministicVersion`) }}
            .text-body-medium.mt-1 {{ projection?.provenance.deterministicVersion || '—' }}
          v-col(cols='12', md='8')
            .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.projectionRevision`) }}
            .text-body-medium.mt-1 {{ projection?.sourceRevision || '—' }}
        v-list(v-if='projection?.provenance.fields?.length', density='compact', lines='three')
          v-list-subheader {{ $t(`editor:editorOkfPanel.evidence`) }}
          v-list-item(v-for='field of projection.provenance.fields', :key='`${field.field}-${field.source}`')
            v-list-item-title {{ field.field }} · {{ field.source }}
            v-list-item-subtitle {{ field.evidence }}
        .text-body-small.text-medium-emphasis(v-else) {{ $t(`editor:editorOkfPanel.noFieldLevelEvidence`) }}
        v-divider.my-3
        .text-title-small.mb-2 {{ $t(`editor:editorOkfPanel.utilityProfile`) }}
        v-row(v-if='utility', density='compact')
          v-col(cols='12', md='4')
            .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.profileVersion`) }}
            .text-body-small.mt-1 {{ utility.profileVersionId }}
          v-col(cols='12', md='4')
            .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.model`) }}
            .text-body-small.mt-1 {{ utility.model }}
          v-col(cols='12', md='4')
            .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.generated2`) }}
            .text-body-small.mt-1 {{ utility.generatedAt }}
          v-col(cols='12', md='6')
            .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.inputSha256`) }}
            code.d-block.text-body-small.mt-1 {{ utility.inputSha256 }}
          v-col(cols='12', md='6')
            .text-label-small.text-medium-emphasis {{ $t(`editor:editorOkfPanel.outputSha256`) }}
            code.d-block.text-body-small.mt-1 {{ utility.outputSha256 }}
        .text-body-small.text-medium-emphasis(v-else) {{ $t(`editor:editorOkfPanel.noUtilityProjectionWas`) }}
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
type OkfLoadRetry = {
  isAvailable: () => boolean
  run: () => Promise<void>
}

export function parseExtensionJson (text: string): ExtensionParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { value: null, error: 'editor:editorOkfPanel.extensionsMustContainValid' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, error: 'editor:editorOkfPanel.extensionsMustJsonObject' }
  }
  const inspect = (value: unknown, root = false): boolean => {
    if (Array.isArray(value)) return value.every(entry => inspect(entry))
    if (!value || typeof value !== 'object') return true
    return Object.entries(value).every(([key, entry]) => !DANGEROUS_KEYS.has(key) && (!root || !CORE_METADATA_KEYS.has(key)) && inspect(entry))
  }
  if (!inspect(parsed, true)) return { value: null, error: 'editor:editorOkfPanel.extensionsMayOnlyContain' }
  return { value: parsed as Record<string, unknown>, error: null }
}

export default defineComponent({
  name: 'EditorOkfPanel',
  inject: {
    okfLoadRetry: {
      from: 'okfLoadRetry',
      default: null as OkfLoadRetry | null
    }
  },
  data () {
    return {
      extensionText: '{}',
      extensionError: '',
      retryPending: false,
      extensionEditing: false,
      statusItems: ['draft', 'stable', 'deprecated'],
      okfStore: wikiStore,
      sourceKeys: [] as number[],
      nextSourceKey: 0
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
    canRetry () {
      const retry = this.okfLoadRetry as OkfLoadRetry | null | undefined
      return Boolean(this.okfError && retry?.isAvailable())
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
    },
    sources: {
      immediate: true,
      handler (value: OkfSource[]) {
        while (this.sourceKeys.length < value.length) {
          this.sourceKeys.push(this.nextSourceKey++)
        }
        if (this.sourceKeys.length > value.length) {
          this.sourceKeys.splice(value.length)
        }
      }
    }
  },
  methods: {
    navigateKnowledge (id: string) {
      const section = this.$el.querySelector(`#${id}`) as HTMLElement | null
      section?.scrollIntoView({ block: 'start' })
      section?.focus({ preventScroll: true })
    },
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
    focusControl (control: unknown) {
      const element = control instanceof HTMLElement
        ? control
        : (control as { $el?: unknown } | undefined)?.$el
      if (element instanceof HTMLElement) element.focus({ preventScroll: true })
    },
    async retryLoad () {
      const retry = this.okfLoadRetry as OkfLoadRetry | null | undefined
      if (!retry?.isAvailable() || this.retryPending) return
      this.retryPending = true
      try {
        await retry.run()
      } finally {
        this.retryPending = false
        await this.$nextTick()
        this.focusControl(this.okfError ? this.$refs.retryButton : this.$refs.authorityHeading)
      }
    },
    addSource () {
      if (!this.hasMetadata) return
      this.sourceKeys.push(this.nextSourceKey++)
      this.updateMetadata({ sources: [...this.sources, { resource: '' }] })
    },
    updateSource (index: number, patch: Partial<OkfSource>) {
      if (!this.hasMetadata || !this.sources[index]) return
      const sources = this.sources.map((source, sourceIndex) => sourceIndex === index ? { ...source, ...patch } : { ...source })
      this.updateMetadata({ sources })
    },
    removeSource (index: number) {
      if (!this.hasMetadata) return
      this.sourceKeys.splice(index, 1)
      this.updateMetadata({ sources: this.sources.filter((_source, sourceIndex) => sourceIndex !== index) })
      this.$nextTick(() => this.focusControl(this.$refs.addSourceButton))
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
      this.extensionError = result.error ? this.$t(result.error) : ''
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
  min-width: 0;
  overflow-wrap: anywhere;

  .editor-okf-navigation {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wiki-space-2);
    margin-bottom: var(--wiki-space-4);
    a {
      display: inline-flex;
      align-items: center;
      min-height: 44px;
      padding: .5rem .75rem;
      border: 1px solid var(--wiki-surface-border);
      border-radius: var(--wiki-control-radius);
      color: var(--wiki-primary-ink);
      text-decoration: none;
      &:focus-visible {
        outline: 2px solid var(--wiki-primary-ink);
        outline-offset: 2px;
      }
    }
  }
  .v-card {
    border-color: var(--wiki-surface-border);
    border-radius: var(--wiki-panel-radius);
    background: var(--wiki-surface-raised);
    scroll-margin-top: var(--wiki-space-4);
  }
  .editor-okf-source {
    margin-block: var(--wiki-space-3);
    padding: var(--wiki-space-3);
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-control-radius);
    background: var(--wiki-surface-sunken);
  }
  :deep(.v-list-item-title),
  :deep(.v-list-item-subtitle) {
    overflow: visible;
    white-space: normal;
    overflow-wrap: anywhere;
    -webkit-line-clamp: unset;
  }
  .v-list {
    max-height: 24rem;
    overflow-y: auto;
  }
  .v-btn {
    min-height: 44px;
  }

  .v-card-title {
    color: rgb(var(--v-theme-on-surface));
  }

  .text-medium-emphasis {
    color: var(--wiki-text-muted);
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
