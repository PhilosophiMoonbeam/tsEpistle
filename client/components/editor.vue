<template lang="pug">
  v-app.editor
    nav-header(dense, reserve-actions)
      template(v-slot:mobileBrand)
        v-text-field.editor-title-input.editor-title-input-mobile(
          variant="solo"
          flat
          v-model='currentPageTitle'
          hide-details
          density="compact"
          :aria-label='$t(`editor:props.title`)'
        )
      template(v-slot:mid)
        v-text-field.editor-title-input(
          variant="solo"
          flat
          v-model='currentPageTitle'
          hide-details
          density="compact"
          :aria-label='$t(`editor:props.title`)'
        )
          template(v-if='pageVisibility.chipKey', v-slot:append-inner)
            v-chip.editor-visibility-chip(
              size='small'
              variant='tonal'
              :prepend-icon='pageVisibility.icon'
              :aria-label='$t(`editor:props.visibilityChipAction`, { state: $t(pageVisibility.chipKey ?? ``) })'
              @click.stop='openPropsModal'
            )
              | {{ $t(pageVisibility.chipKey ?? '') }}
              v-tooltip(activator='parent', location='bottom') {{ $t(pageVisibility.summaryKey, pageVisibility.values) }}
      template(v-slot:actions)
        span.editor-save-status.text-body-small(
          role='status'
          aria-live='polite'
          :class='{ "is-visually-hidden": !$vuetify.display.mdAndUp, "is-error": saveFeedback === `failed` }'
        )
          v-icon.editor-save-status-icon(v-if='saveStatusIcon && saveStatusText', size='16', :icon='saveStatusIcon')
          span {{ saveStatusText }}
        v-btn.editor-conflict-action.mr-3(
          color='warning'
          variant="tonal"
          size="small"
          v-if='isConflict'
          @click='openConflict'
          :icon='$vuetify.display.smAndDown'
          :aria-label='$t(`editor:conflict.resolveAction`)'
        )
          .text-label-small.mr-3(v-if='$vuetify.display.mdAndUp') {{ $t('editor:conflict.label') }}
          status-indicator(intermediary, pulse)
        v-btn.editor-save-action(
          :variant='mode === `create` || isDirty ? `flat` : `text`'
          color='primary'
          @click='save()'
          :loading='isSaving'
          :disabled='isSaving || collaborationDiscarded || serverSaveDisabled || offlineMutationBlocked'
          :class='{ "is-icon": $vuetify.display.mdAndDown }'
          :aria-label='saveActionLabel'
          )
          v-icon(:start='$vuetify.display.lgAndUp') mdi-check
          span.text-medium-emphasis(v-if='$vuetify.display.lgAndUp && mode !== `create` && !isDirty') {{ $t('editor:save.saved') }}
          span(v-else-if='$vuetify.display.lgAndUp') {{ mode === 'create' ? $t('common:actions.create') : $t('common:actions.save') }}
          v-tooltip(v-if='$vuetify.display.mdAndDown', activator='parent', location='bottom') {{ $t(`editor:editor.ctrlS`, { saveActionLabel, interpolation: { escapeValue: false } }) }}
        v-btn.editor-save-close-action(
          v-if='$vuetify.display.mdAndUp'
          variant='tonal'
          color='primary'
          :class='{ "is-icon": $vuetify.display.mdAndDown }'
          :aria-label='$t(`editor:save.saveAndClose`)'
          @click='saveAndClose'
          :disabled='isSaving || collaborationDiscarded || serverSaveDisabled || offlineMutationBlocked'
        )
          v-icon(:start='$vuetify.display.lgAndUp') mdi-content-save-move-outline
          span(v-if='$vuetify.display.lgAndUp') {{ $t('editor:save.saveAndClose') }}
          v-tooltip(v-if='$vuetify.display.mdAndDown', activator='parent', location='bottom') {{ $t('editor:save.saveAndClose') }}
        v-btn.editor-page-action(
          v-if='$vuetify.display.mdAndUp'
          variant="tonal"
          color='primary'
          @click='openPropsModal'
          :class='{ "is-icon": $vuetify.display.mdAndDown, "mx-0": !welcomeMode, "ml-0": welcomeMode }'
          :aria-label='$t(`common:actions.page`)'
          )
          v-icon(:start='$vuetify.display.lgAndUp') mdi-tag-text-outline
          span(v-if='$vuetify.display.lgAndUp') {{ $t('common:actions.page') }}
          v-tooltip(v-if='$vuetify.display.mdAndDown', activator='parent', location='bottom') {{ $t('common:actions.page') }}
        v-btn.editor-close-action(
          v-if='!welcomeMode && $vuetify.display.mdAndUp'
          variant="text"
          color='error'
          :class='{ "is-icon": $vuetify.display.mdAndDown }'
          :aria-label='$t(`common:actions.close`)'
          @click='exit'
          )
          v-icon(:start='$vuetify.display.lgAndUp') mdi-close
          span(v-if='$vuetify.display.lgAndUp') {{ $t('common:actions.close') }}
          v-tooltip(v-if='$vuetify.display.mdAndDown', activator='parent', location='bottom') {{ $t('common:actions.close') }}
        v-divider.editor-actions-divider.ml-3(v-if='$vuetify.display.mdAndUp', vertical)
    v-main
      .editor-main-surface
        .editor-notices(v-if='bootstrapNotice || serverSaveDisabled || hasOfflineDraftNotice')
          v-alert.editor-bootstrap-notice.editor-notice(
            v-if='bootstrapNotice'
            type='warning'
            variant='tonal'
            density='compact'
            role='alert'
          )
            .text-body-medium {{ bootstrapNotice }}
          v-alert.editor-draft-notice.editor-notice(
            v-if='serverSaveDisabled || hasOfflineDraftNotice'
            :type='offlineNoticeType'
            variant='tonal'
            density='compact'
            role='region'
            :aria-label='$t(`editor:offline.noticeLabel`)'
          )
            .editor-notice-message(role='status')
              .text-body-medium.editor-offline-save-notice(v-if='serverSaveDisabled')
                strong {{ offlineSaveNotice }}
              .text-body-medium(v-if='offlineDraftError') {{ offlineDraftError }}
              .text-body-medium(v-else-if='offlineDraftStatusText') {{ offlineDraftStatusText }}
            .editor-notice-actions.editor-draft-recovery-actions(v-if='offlineDraftStatus === `locked` || !offlineDraftCoordinator')
              v-btn(
                size='small'
                variant='tonal'
                color='primary'
                prepend-icon='mdi-refresh'
                @click='reloadEditor'
              ) {{ $t('editor:offline.reloadEditor') }}
            .editor-draft-review-actions(v-if='offlineDraftRows.length > 0')
              .text-body-small.editor-notice-lead {{ offlineDraftRows.length > 1 ? $t('editor:offline.draftsChoose', { count: offlineDraftRows.length }) : $t('editor:offline.draftFound') }}
              ul.editor-recovery-list(:aria-label='$t(`editor:offline.draftListLabel`)')
                li.editor-recovery-row(v-for='row of offlineDraftRows', :key='row.key')
                  .editor-recovery-row-text
                    .text-body-medium.editor-recovery-row-title {{ row.title }}
                    .text-body-small.editor-recovery-row-meta
                      span
                        | {{ row.relativeTime }}
                        v-tooltip(activator='parent', location='bottom') {{ row.exactTime }}
                      span(aria-hidden='true') ·
                      span {{ row.delta }}
                  .editor-notice-actions(v-if='pendingDraftDiscard !== row.key')
                    v-btn(
                      size='small'
                      variant='flat'
                      color='primary'
                      :loading='offlineDraftBusy && busyRecoveryRow === row.key'
                      :disabled='offlineDraftBusy'
                      @click='restoreOfflineDraftRow(row)'
                    ) {{ $t('editor:offline.restoreDraftAt', { time: row.shortTime }) }}
                    v-btn(
                      size='small'
                      variant='text'
                      color='error'
                      :disabled='offlineDraftBusy'
                      :aria-label='$t(`editor:offline.discardDraftAt`, { time: row.shortTime })'
                      @click='pendingDraftDiscard = row.key'
                    ) {{ $t('editor:offline.discard') }}
                  .editor-notice-actions.editor-recovery-confirm(v-else, role='group', :aria-label='$t(`editor:offline.confirmDiscardDraft`)')
                    span.text-body-small {{ $t('editor:offline.confirmDiscardDraft') }}
                    v-btn(
                      size='small'
                      variant='flat'
                      color='error'
                      :loading='offlineDraftBusy && busyRecoveryRow === row.key'
                      :disabled='offlineDraftBusy'
                      @click='discardOfflineDraftRow(row)'
                    ) {{ $t('editor:offline.discardDraftAt', { time: row.shortTime }) }}
                    v-btn(
                      size='small'
                      variant='text'
                      :disabled='offlineDraftBusy'
                      @click='pendingDraftDiscard = null'
                    ) {{ $t('common:actions.cancel') }}
              details.editor-notice-details
                summary.text-body-small {{ $t('editor:offline.whatIsThis') }}
                .text-body-small {{ $t('editor:offline.draftExplanation') }}
            .editor-draft-submission-actions(v-if='offlineSubmissionCandidates.length > 0')
              .text-body-small.editor-notice-lead {{ offlineSubmissionCandidates.length > 1 ? $t('editor:offline.submissionsChoose', { count: offlineSubmissionCandidates.length }) : $t('editor:offline.submissionFound') }}
              ul.editor-recovery-list(:aria-label='$t(`editor:offline.submissionListLabel`)')
                li.editor-recovery-row(v-for='(candidate, index) of offlineSubmissionCandidates', :key='candidate.submission.recordId')
                  .editor-recovery-row-text
                    .text-body-medium.editor-recovery-row-title {{ $t('editor:offline.submissionLabel', { number: index + 1 }) }}
                    .text-body-small.editor-recovery-row-meta {{ $t('editor:offline.submissionHidden') }}
                  .editor-notice-actions(v-if='pendingSubmissionDelete !== candidate.submission.recordId')
                    v-btn(
                      size='small'
                      variant='tonal'
                      color='primary'
                      :disabled='offlineDraftBusy'
                      :aria-label='$t(`editor:offline.reviewSubmissionNumber`, { number: index + 1 })'
                      @click='inspectOfflineSubmission(candidate.submission.recordId)'
                    ) {{ $t('editor:offline.reviewSubmission') }}
                    v-btn(
                      size='small'
                      variant='text'
                      color='error'
                      :disabled='offlineDraftBusy'
                      :aria-label='$t(`editor:offline.deleteReceiptNumber`, { number: index + 1 })'
                      @click='pendingSubmissionDelete = candidate.submission.recordId'
                    ) {{ $t('editor:offline.deleteReceipt') }}
                  .editor-notice-actions.editor-recovery-confirm(v-else, role='group', :aria-label='$t(`editor:offline.confirmDeleteReceipt`)')
                    span.text-body-small {{ $t('editor:offline.confirmDeleteReceipt') }}
                    v-btn(
                      size='small'
                      variant='flat'
                      color='error'
                      :disabled='offlineDraftBusy'
                      @click='confirmDeleteOfflineSubmission(candidate.submission.recordId)'
                    ) {{ $t('editor:offline.deleteReceipt') }}
                    v-btn(
                      size='small'
                      variant='text'
                      :disabled='offlineDraftBusy'
                      @click='pendingSubmissionDelete = null'
                    ) {{ $t('common:actions.cancel') }}
              details.editor-notice-details
                summary.text-body-small {{ $t('editor:offline.whatIsThis') }}
                .text-body-small {{ $t('editor:offline.submissionExplanation') }}
            .editor-draft-reconcile-actions(v-if='offlineReconcilePrompt')
              .text-body-small.editor-notice-lead {{ offlineReconcilePrompt.kind === 'update' ? $t('editor:offline.reconcileUpdate') : $t('editor:offline.reconcileCreate') }}
              .editor-notice-actions
                v-btn(
                  size='small'
                  variant='tonal'
                  color='primary'
                  :disabled='offlineDraftBusy'
                  @click='resolveOfflineSubmission(`discard`)'
                ) {{ offlineReconcilePrompt.kind === 'update' ? $t('editor:offline.keepServerResult') : $t('editor:offline.deleteReceipt') }}
                v-btn(
                  size='small'
                  variant='outlined'
                  color='primary'
                  :disabled='offlineDraftBusy'
                  @click='resolveOfflineSubmission(`continue`)'
                ) {{ $t('editor:offline.keepAsNewDraft') }}
        component.editor-active-editor(
          :is='currentEditor'
          v-if='currentEditor'
          :key='editorInstanceKey'
          :save='save'
          :wiki-link-options='currentEditor === `editorMarkdown` || currentEditor === `editorVisualMarkdown` ? wikiLinkOptions : undefined'
          @collaboration-state='handleCollaborationState'
          @editor-adapter='handleEditorAdapter'
          @editor-adapter-clear='handleEditorAdapterClear'
        )
      editor-modal-properties(v-if='dialogProps', v-model='dialogProps')
      editor-modal-editorselect(v-if='dialogEditorSelector', v-model='dialogEditorSelector')
      editor-modal-unsaved(
        v-if='dialogUnsaved'
        v-model='dialogUnsaved'
        :busy='isSaving'
        :discarding='discardPending'
        :error='discardError'
        @discard='discardAndExit'
        @save='saveUnsavedAndClose'
      )
      component(v-if='activeModal', :is='activeModal')

    v-bottom-navigation.editor-mobile-actions(
      v-if='$vuetify.display.smAndDown'
      tag='nav'
      :aria-label='$t(`editor:actions.mobileLabel`)'
      grow
      :elevation='0'
    )
      v-btn.editor-mobile-save(
        :class='{ "is-clean": mode !== `create` && !isDirty }'
        color='primary'
        @click.exact='saveFromMobile'
        :loading='isSaving'
        :disabled='isSaving || collaborationDiscarded || serverSaveDisabled || offlineMutationBlocked'
        :aria-disabled='mode !== `create` && !isDirty ? `true` : undefined'
        :aria-label='saveActionLabel'
      )
        v-icon {{ mode !== 'create' && !isDirty ? 'mdi-check-circle-outline' : 'mdi-check' }}
        span {{ mobileSaveLabel }}
      v-btn(color='primary', @click='openPropsModal', :aria-label='$t(`common:actions.page`)')
        v-icon mdi-tag-text-outline
        span {{ $t('common:actions.page') }}
      v-menu(location='top end', min-width='240')
        template(v-slot:activator='{ props }')
          v-btn(
            v-bind='props'
            :color='isConflict ? `warning` : undefined'
            :aria-label='$t(`editor:actions.more`)'
          )
            v-icon {{ isConflict ? 'mdi-alert-outline' : 'mdi-dots-horizontal' }}
            span {{ $t('editor:actions.moreShort') }}
        v-list.editor-mobile-menu(nav)
          v-list-item(v-if='isConflict', @click='openConflict')
            template(v-slot:prepend)
              v-icon(color='warning') mdi-alert-outline
            v-list-item-title {{ $t('editor:conflict.resolveAction') }}
          v-list-item(:disabled='isSaving || collaborationDiscarded || serverSaveDisabled || offlineMutationBlocked', @click='saveAndClose')
            template(v-slot:prepend)
              v-icon(color='primary') mdi-content-save-move-outline
            v-list-item-title {{ $t('editor:save.saveAndClose') }}
          v-list-item(v-if='!welcomeMode', @click='exit')
            template(v-slot:prepend)
              v-icon(color='error') mdi-close
            v-list-item-title {{ $t('common:actions.close') }}
</template>

<script lang='ts'>
import { defineComponent, markRaw, shallowRef, type PropType } from 'vue'
import moment from 'moment-timezone'
import { useHotkey } from 'vuetify'
import { createAsyncComponent } from './common/async-component-state.vue'
import * as _ from 'lodash-es'
import { buildOkfMetadataPayload, changePageVisibility, checkPageConflict, createPage, discardCollaborationDraft, fetchPage, updatePage, type PageDetails, type PageWriteInput } from '../helpers/pages-api'
import { openOfflineStorage, type OfflineStorage } from '../helpers/offline-storage.ts'
import { wikiStore } from '@/store/index.ts'
import { translate } from '../modules/localization.ts'
import { notifyReloadSafetyChanged, pwaState, setReloadSafetyProvider } from '../helpers/pwa.ts'
import { Base64 } from 'js-base64'
import StatusIndicator from '@/components/common/status-indicator.vue'
import { emitEditorSaveConflict, onEditorConflictReset, offEditorConflictReset } from '../helpers/editor-conflict-events'
import { getErrorMessage } from '../helpers/root-ui-store'
import { decodeBase64Json } from '../helpers/base64'
import { getEditorComponentName } from '../helpers/editor-key.ts'
import { normalizeAvailableEditors, type PageEditorKey } from '../../shared/page-editors.ts'
import {
  OfflineEditorDraftCoordinator,
  createOfflineDraftIdentity,
  type OfflineDraftRecovery,
  type OfflineDraftSubmissionRecovery,
  type OfflineEditorDraftIdentity,
  type OfflineEditorDraftValues,
  type PreparedOfflineSubmission
} from '../helpers/offline-editor-drafts.ts'
import { OFFLINE_SESSION_INVALIDATED_EVENT, requestOfflineIdentityBoundary } from '../helpers/offline-session.ts'
import { bindEditorFlushSignals, type EditorAdapter, type EditorAdapterCapture, type EditorAdapterSafety } from './editor/common/editor-adapter'
import { describePageVisibility, type PageVisibilitySummary } from './editor/common/page-visibility'
import type { OfflineDraftPayloadV1, OfflineDraftState } from '../../shared/offline.ts'
import { OfflineSnapshotSelectorSchema, type OfflineSnapshotSelector } from '../../shared/offline.ts'
import {
  PageBrandingAssignmentSchema,
  PageBrandingViewSchema,
  type PageBrandingAssignment,
  type PageBrandingView
} from '../../shared/page-branding.ts'
import { normalizePageFeatures, type PageFeatures } from '../../shared/page-features.ts'
import type { WikiLinkOptions } from '../../shared/wikilinks.ts'


const OFFLINE_CREATE_IDENTITY_KEY = 'tsepistle-offline-create-identity'

type EditorSaveFeedback = 'idle' | 'saving' | 'saved' | 'failed'

type OfflineDraftRow = {
  readonly key: string
  readonly recordId: string | undefined
  readonly title: string
  readonly shortTime: string
  readonly relativeTime: string
  readonly exactTime: string
  readonly delta: string
}

const SAVE_SHORTCUT_LABEL = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '') ? '⌘S' : 'Ctrl+S'

const countWords = (text: string): number => text.trim() ? text.trim().split(/\s+/u).length : 0

const readOfflineCreateIdentity = (): string | null => {
  try {
    const value = window.sessionStorage.getItem(OFFLINE_CREATE_IDENTITY_KEY)
    return value && value.trim().length > 0 && value.length <= 256 ? value : null
  } catch {
    return null
  }
}

const writeOfflineCreateIdentity = (identity: string): void => {
  try {
    window.sessionStorage.setItem(OFFLINE_CREATE_IDENTITY_KEY, identity)
  } catch {
    // Verified encrypted route scanning remains the fallback when storage is unavailable.
  }
}

const clearOfflineCreateIdentity = (): void => {
  try {
    window.sessionStorage.removeItem(OFFLINE_CREATE_IDENTITY_KEY)
  } catch {
    // Session storage is optional.
  }
}

const EDITOR_PAGE_CANVAS_SCOPE = '.editor-page-canvas'

function scopeEditorPageCss (css: string): string {
  const parserStyle = document.createElement('style')
  parserStyle.media = 'not all'
  parserStyle.textContent = css
  document.head.appendChild(parserStyle)

  try {
    const parsedRules = Array.from(parserStyle.sheet?.cssRules ?? [])
    const importRules = parsedRules.filter(rule => rule.type === CSSRule.IMPORT_RULE)
    if (importRules.length > 0) {
      console.warn('Page CSS @import rules are unsupported in the editor preview and were omitted.')
    }
    const scopedRules = parsedRules
      .filter(rule => rule.type !== CSSRule.IMPORT_RULE)
      .map(rule => rule.cssText)
    return `@scope (${EDITOR_PAGE_CANVAS_SCOPE}) {\n${scopedRules.join('\n')}\n}`
  } finally {
    parserStyle.remove()
  }
}

function removeEditorPageCss () {
  document.querySelector('#editor-script-css')?.remove()
}
function normalizeEditorBrandingAssignment (value: unknown): PageBrandingAssignment | null {
  if (value === null || value === undefined) return null
  const result = PageBrandingAssignmentSchema.safeParse(value)
  return result.success ? result.data : null
}

function normalizeEditorBrandingView (value: unknown, assignment: PageBrandingAssignment | null): PageBrandingView | null {
  if (assignment === null || value === null || value === undefined) return null
  const result = PageBrandingViewSchema.safeParse(value)
  return result.success && result.data.assetId === assignment.assetId ? result.data : null
}
function normalizeEditorPageFeatures (value: string): PageFeatures {
  if (value.length === 0) return normalizePageFeatures(undefined)
  try {
    return normalizePageFeatures(decodeBase64Json<unknown>(value))
  } catch {
    return normalizePageFeatures(null)
  }
}

type EditorSaveCapture = {
  readonly pageInput: PageWriteInput
  readonly editVersion: number
  readonly identity: OfflineEditorDraftIdentity
  readonly content: string
  readonly title: string
  readonly description: string
  readonly locale: string
  readonly path: string
  readonly tags: string[]
  readonly isPublished: boolean
  readonly isSearchable: boolean
  readonly visibility: 'public' | 'private'
  readonly publishStartDate: string
  readonly publishEndDate: string
  readonly scriptCss: string
  readonly scriptJs: string
  readonly brandingAssignment: PageBrandingAssignment | null
  readonly brandingView: PageBrandingView | null
  readonly pageFeatures: PageFeatures
  readonly okf: typeof wikiStore.page.okf
}
type EditorEditableState = {
  readonly content: unknown
  readonly description: unknown
  readonly isPublished: unknown
  readonly isSearchable: unknown
  readonly visibility: unknown
  readonly locale: unknown
  readonly path: unknown
  readonly publishEndDate: unknown
  readonly publishStartDate: unknown
  readonly tags: unknown
  readonly title: unknown
  readonly scriptCss: unknown
  readonly scriptJs: unknown
  readonly brandingAssignment: unknown
  readonly pageFeatures: PageFeatures
  readonly okf: unknown
}

type EditableStateValue = {
  readonly content?: unknown
  readonly description?: unknown
  readonly isPublished?: unknown
  readonly isSearchable?: unknown
  readonly visibility?: unknown
  readonly locale?: unknown
  readonly path?: unknown
  readonly publishEndDate?: unknown
  readonly publishStartDate?: unknown
  readonly tags?: unknown
  readonly title?: unknown
  readonly scriptCss?: unknown
  readonly scriptJs?: unknown
  readonly brandingAssignment?: unknown
  readonly pageFeatures?: unknown
  readonly okf?: unknown
}


const freezePageInput = (input: PageWriteInput): PageWriteInput => {
  Object.freeze(input.tags)
  if (input.okfMetadata !== undefined) Object.freeze(input.okfMetadata)
  if (input.pageFeatures !== undefined) Object.freeze(input.pageFeatures)
  if (input.branding !== undefined && input.branding !== null) Object.freeze(input.branding)
  return Object.freeze(input) as PageWriteInput
}



export default defineComponent({
  i18nOptions: { namespaces: 'editor' },
  components: {
    StatusIndicator,
    editorCode: createAsyncComponent(() => import('./editor/editor-code.vue')),
    editorCkeditor: createAsyncComponent(() => import('./editor/editor-ckeditor.vue')),
    editorVisualMarkdown: createAsyncComponent(() => import('./editor/editor-visual-markdown.vue')),
    editorAsciidoc: createAsyncComponent(() => import('./editor/editor-asciidoc.vue')),
    editorMarkdown: createAsyncComponent(() => import('./editor/editor-markdown.vue')),
    editorModalEditorselect: createAsyncComponent(() => import('./editor/editor-modal-editorselect.vue')),
    editorModalProperties: createAsyncComponent(() => import('./editor/editor-modal-properties.vue')),
    editorModalUnsaved: createAsyncComponent(() => import('./editor/editor-modal-unsaved.vue')),
    editorModalMedia: createAsyncComponent(() => import('./editor/editor-modal-media.vue')),
    editorModalBlocks: createAsyncComponent(() => import('./editor/editor-modal-blocks.vue')),
    editorModalConflict: createAsyncComponent(() => import('./editor/editor-modal-conflict.vue')),
    editorModalDrawio: createAsyncComponent(() => import('./editor/editor-modal-drawio.vue'))
  },
  props: {
    locale: {
      type: String,
      default: 'en'
    },
    path: {
      type: String,
      default: 'home'
    },
    title: {
      type: String,
      default: () => translate('editor:editor.untitledPage')
    },
    description: {
      type: String,
      default: ''
    },
    tags: {
      type: Array as PropType<string[]>,
      default: () => ([])
    },
    isPublished: {
      type: Boolean,
      default: true
    },
    isSearchable: {
      type: Boolean,
      default: true
    },
    visibility: {
      type: String as PropType<'public' | 'private'>,
      default: 'public'
    },
    ownerId: {
      type: Number,
      default: null
    },
    scriptCss: {
      type: String,
      default: ''
    },
    publishStartDate: {
      type: String,
      default: ''
    },
    publishEndDate: {
      type: String,
      default: ''
    },
    scriptJs: {
      type: String,
      default: ''
    },
    initEditor: {
      type: String,
      default: null
    },
    initMode: {
      type: String,
      default: 'create'
    },
    initContent: {
      type: String,
      default: null
    },
    pageId: {
      type: Number,
      default: 0
    },
    checkoutDate: {
      type: String,
      default: () => new Date().toISOString()
    },
    sourceRevision: {
      type: String,
      default: ''
    },
    bootstrapNotice: {
      type: String,
      default: ''
    },
    effectivePermissions: {
      type: String,
      default: ''
    },
    brandingAssignment: {
      type: Object as PropType<PageBrandingAssignment | null>,
      default: null
    },
    brandingView: {
      type: Object as PropType<PageBrandingView | null>,
      default: null
    },
    wikiLinksEnabled: {
      type: Boolean,
      default: false
    },
    absoluteLinks: {
      type: Boolean,
      default: false
    },
    localeNamespaced: {
      type: Boolean,
      default: false
    },
    pageFeatures: {
      type: String,
      default: ''
    }
  },
  setup () {
    let saveHandler: (() => void) | null = null
    useHotkey('cmd+s', event => {
      event.preventDefault()
      saveHandler?.()
    })
    return {
      offlineStorage: shallowRef<OfflineStorage | null>(null),
      offlineStoragePromise: shallowRef<Promise<OfflineStorage> | null>(null),
      setSaveHotkeyHandler (handler: (() => void) | null) {
        saveHandler = handler
      }
    }
  },
  provide () {
    return {
      okfLoadRetry: {
        isAvailable: () => this.canRetryOkfAuthorityLoad,
        run: () => this.retryOkfAuthorityLoad()
      }
    }
  },
  data() {
    return {
      isSaving: false,
      editorAdapter: null as EditorAdapter | null,
      editorAdapterUnsubscribe: null as (() => void) | null,
      editorFlushUnsubscribe: null as (() => void) | null,
      editorAdapterSafety: {
        ready: false,
        editVersion: 0,
        nonPersisted: true,
        mergeDirty: false,
        collaborationBacklog: Number.MAX_SAFE_INTEGER,
        revision: 'uninitialized'
      } as EditorAdapterSafety,
      submissionCaptureValues: null as OfflineEditorDraftValues | null,
      submissionCaptureIdentity: null as OfflineEditorDraftIdentity | null,
      safetyRevision: 0,
      lifecycleGeneration: 0,
      editorInstanceKey: 0,
      discardPending: false,
      discardError: '',
      collaborationActive: false,
      collaborationGeneration: null as number | null,
      collaborationDiscarded: false,
      isConflict: false,
      conflictTimer: null as number | null,
      conflictCheckPending: false,
      customCssTimer: null as number | null,
      modalTimer: null as number | null,
      navigationTimer: null as number | null,
      dialogUnsaved: false,
      exitConfirmed: false,
      dialogProps: false,
      saveFeedback: 'idle' as EditorSaveFeedback,
      lastSavedAt: null as number | null,
      lastSaveKind: 'server' as 'server' | 'device',
      pendingDraftDiscard: null as string | null,
      pendingSubmissionDelete: null as string | null,
      busyRecoveryRow: null as string | null,
      dialogEditorSelector: false,
      offlineDraftCoordinator: null as OfflineEditorDraftCoordinator | null,
      offlineMetadataOperation: 0,
      offlineCreateIdentity: null as string | null,
      offlineDraftStatus: null as OfflineDraftState | null,
      offlineDraftCandidate: null as OfflineDraftPayloadV1 | null,
      offlineDraftCandidates: [] as OfflineDraftRecovery[],
      offlineSubmissionCandidates: [] as OfflineDraftSubmissionRecovery[],
      offlineReconcilePrompt: null as { recordId: string; kind: 'update' | 'create'; revision: string | null } | null,
      offlineDraftError: '',
      offlineDraftBusy: false,
      savedState: {
        content: '',
        description: '',
        isPublished: false,
        isSearchable: true,
        visibility: 'public' as 'public' | 'private',
        locale: 'en',
        path: '',
        publishEndDate: '',
        publishStartDate: '',
        tags: [] as string[],
        title: '',
        scriptCss: '',
        scriptJs: '',
        brandingAssignment: null as PageBrandingAssignment | null,
        brandingView: null as PageBrandingView | null,
        pageFeatures: normalizePageFeatures(undefined),
        okf: _.cloneDeep(wikiStore.page.okf)
      }
    }
  },
  computed: {
    currentEditor: {
      get(): string { return wikiStore.editor.editor },
      set(value: string) { wikiStore.editor.editor = value }
    },
    activeModal: {
      get(): string { return wikiStore.editor.activeModal },
      set(value: string) { wikiStore.editor.activeModal = value }
    },
    mode(): string { return wikiStore.editor.mode },
    canRetryOkfAuthorityLoad(): boolean {
      return this.mode !== 'create' && wikiStore.page.id > 0 && Boolean(wikiStore.page.okfError) && !wikiStore.page.okfLoading
    },
    welcomeMode() { return this.mode === `create` && this.path === `home` },
    currentPageTitle: {
      get(): string { return wikiStore.page.title },
      set(value: string) { wikiStore.page.title = value }
    },
    checkoutDateActive: {
      get(): string { return wikiStore.editor.checkoutDateActive },
      set(value: string) { wikiStore.editor.checkoutDateActive = value }
    },
    wikiLinkOptions(): WikiLinkOptions {
      return {
        enabled: this.wikiLinksEnabled,
        context: {
          locale: wikiStore.page.locale,
          pagePath: wikiStore.page.path,
          namespaced: this.localeNamespaced,
          absoluteLinks: this.absoluteLinks
        }
      }
    },
    currentStyling(): string { return wikiStore.page.scriptCss },
    isAuthenticated(): boolean { return wikiStore.user.authenticated },
    accountId(): number { return wikiStore.user.id },
    offlineConnectionState(): string { return pwaState.connectionState },
    authRefreshPending(): boolean {
      return wikiStore.authRefreshPending || !wikiStore.authRefreshSettled
    },
    warmAuthenticatedActor(): boolean {
      return this.isAuthenticated && Number.isSafeInteger(this.accountId) && this.accountId > 0
    },
    offlineDraftMutationBlocked(): boolean {
      return this.offlineDraftStatus === 'locked' || this.offlineDraftStatus === 'unavailable' || !this.offlineDraftCoordinator
    },
    offlineMutationBlocked(): boolean {
      return (
        this.offlineDraftMutationBlocked ||
        ((this.authRefreshPending || !wikiStore.offlineIdentityReady) && !this.warmAuthenticatedActor) ||
        this.offlineSubmissionCandidates.length > 0 ||
        this.offlineDraftStatus === 'publishing' ||
        this.offlineDraftStatus === 'outcome-unknown'
      )
    },
    offlineSaveNotice(): string {
      if (this.offlineDraftCoordinator?.hasCommittedCurrentValues === true) {
        return this.$t('editor:offline.serverUnavailableSaved')
      }
      if (this.offlineDraftError) {
        return this.$t('editor:offline.serverUnavailableUnconfirmed')
      }
      return this.$t('editor:offline.serverUnavailablePending')
    },
    serverSaveDisabled(): boolean {
      return wikiStore.user.authenticated && (pwaState.connectionState === 'offline' || pwaState.connectionState === 'server-unavailable')
    },
    offlineDraftStatusText(): string {
      if (this.offlineDraftError) return ''
      if (this.offlineDraftStatus === 'local') return this.$t('editor:offline.statusLocal')
      if (this.offlineDraftStatus === 'needs-review') return this.$t('editor:offline.statusNeedsReview')
      if (this.offlineDraftStatus === 'publishing') return this.$t('editor:offline.statusPublishing')
      if (this.offlineDraftStatus === 'conflict') return this.$t('editor:offline.statusConflict')
      if (this.offlineDraftStatus === 'locked') return this.$t('editor:offline.statusLocked')
      if (this.offlineDraftStatus === 'unavailable') return this.$t('editor:offline.statusUnavailable')
      if (!this.offlineDraftCoordinator) return this.$t('editor:offline.statusNoRecovery')
      if (this.offlineDraftStatus === 'outcome-unknown') return this.$t('editor:offline.statusOutcomeUnknown')
      return ''
    },
    hasOfflineDraftNotice(): boolean {
      return Boolean(
        this.offlineDraftError ||
        this.offlineDraftCandidate ||
        this.offlineDraftCandidates.length > 0 ||
        this.offlineSubmissionCandidates.length > 0 ||
        this.offlineReconcilePrompt ||
        this.offlineDraftStatusText
      )
    },
    offlineNoticeType(): 'warning' | 'info' {
      return this.serverSaveDisabled || this.offlineDraftStatus === 'locked' || this.offlineDraftStatus === 'unavailable' || Boolean(this.offlineDraftError)
        ? 'warning'
        : 'info'
    },
    offlineDraftRows(): OfflineDraftRow[] {
      // Local drafts are the author's own decrypted working copies; retained
      // submissions are deliberately excluded so their plaintext stays hidden.
      const candidates: Array<{ key: string; recordId: string | undefined; payload: OfflineDraftPayloadV1 }> = this.offlineDraftCandidate
        ? [{ key: 'current', recordId: undefined, payload: this.offlineDraftCandidate }]
        : this.offlineDraftCandidates.map(candidate => ({ key: candidate.recordId, recordId: candidate.recordId, payload: candidate.payload }))
      const current = wikiStore.editor.content
      return candidates.map(({ key, recordId, payload }) => {
        const savedAt = moment(payload.updatedAt)
        const valid = savedAt.isValid()
        const sameDay = valid && savedAt.isSame(moment(), 'day')
        const charDelta = payload.content.length - current.length
        const wordDelta = countWords(payload.content) - countWords(current)
        const delta = charDelta === 0
          ? this.$t('editor:offline.deltaSame')
          : this.$t(charDelta > 0 ? 'editor:offline.deltaMore' : 'editor:offline.deltaLess', {
            chars: Math.abs(charDelta),
            words: Math.abs(wordDelta)
          })
        return {
          key,
          recordId,
          title: payload.title.trim() || `/${payload.locale}/${payload.path}`,
          shortTime: valid ? savedAt.format(sameDay ? 'LT' : 'lll') : '',
          relativeTime: valid ? savedAt.fromNow() : this.$t('editor:offline.unknownTime'),
          exactTime: valid ? savedAt.format('LLLL') : this.$t('editor:offline.unknownTime'),
          delta
        }
      })
    },
    pageVisibility(): PageVisibilitySummary {
      const page = wikiStore.page
      return describePageVisibility(
        { visibility: page.visibility, isPublished: page.isPublished, publishStartDate: page.publishStartDate, publishEndDate: page.publishEndDate },
        new Date(),
        document.documentElement.lang || undefined
      )
    },
    saveStatusText(): string {
      if (this.saveFeedback === 'saving') return this.$t('editor:save.saving')
      if (this.saveFeedback === 'failed') return this.$t('editor:save.notSaved')
      const time = this.lastSavedAt === null ? '' : moment(this.lastSavedAt).format('LT')
      if (this.lastSaveKind === 'device' && time) return this.$t('editor:save.savedOfflineAt', { time })
      if (this.isDirty) return this.mode === 'create' ? '' : this.$t('editor:save.unsavedChanges')
      return time ? this.$t('editor:save.savedAt', { time }) : ''
    },
    saveStatusIcon(): string {
      if (this.saveFeedback === 'saving') return 'mdi-progress-upload'
      if (this.saveFeedback === 'failed') return 'mdi-alert-circle-outline'
      if (this.lastSaveKind === 'device' && this.lastSavedAt !== null) return 'mdi-cloud-off-outline'
      if (this.isDirty) return 'mdi-circle-medium'
      return 'mdi-check'
    },
    saveActionLabel(): string {
      if (this.mode === 'create') return this.$t('common:actions.create')
      if (this.isSaving) return this.$t('editor:save.saving')
      return this.isDirty ? `${this.$t('common:actions.save')} (${SAVE_SHORTCUT_LABEL})` : this.$t('editor:save.saved')
    },
    mobileSaveLabel(): string {
      if (this.mode === 'create') return this.$t('common:actions.create')
      if (this.isDirty) return this.$t('common:actions.save')
      const time = this.lastSavedAt === null ? '' : moment(this.lastSavedAt).format('LT')
      return time ? this.$t('editor:save.savedAt', { time }) : this.$t('editor:save.saved')
    },
    offlineDraftSource(): readonly string[] {
      return [
        wikiStore.editor.content,
        wikiStore.page.title,
        wikiStore.page.description,
        wikiStore.page.locale,
        wikiStore.page.path,
        JSON.stringify(wikiStore.page.pageFeatures),
        wikiStore.editor.editorKey
      ]
    },
    isDirty () {
      return !this.sameEditableState(this.savedState, this.currentEditableState(), true)
    },
    reloadSafetyInputs(): readonly unknown[] {
      return [
        this.isDirty,
        wikiStore.editor.content,
        wikiStore.page.title,
        wikiStore.page.description,
        wikiStore.page.locale,
        wikiStore.page.path,
        wikiStore.page.tags,
        wikiStore.page.isPublished,
        wikiStore.page.isSearchable,
        wikiStore.page.visibility,
        wikiStore.page.publishStartDate,
        wikiStore.page.publishEndDate,
        wikiStore.page.scriptCss,
        wikiStore.page.scriptJs,
        wikiStore.page.brandingAssignment,
        wikiStore.page.brandingView,
        wikiStore.page.okf,
        wikiStore.page.id,
        wikiStore.page.sourceRevision,
        wikiStore.page.pageFeatures,
        this.checkoutDateActive,
        this.currentEditor,
        this.activeModal,
        this.isConflict,
        this.isSaving,
        this.offlineDraftBusy,
        this.offlineDraftStatus,
        this.offlineDraftError,
        this.discardError,
        this.collaborationActive,
        this.collaborationGeneration,
        this.collaborationDiscarded,
        this.offlineSubmissionCandidates,
        this.offlineDraftCandidates
      ]
    },
  },
  watch: {
    currentEditor(newValue: string) {
      if (newValue !== '' && this.mode === 'create') {
        if (this.modalTimer !== null) window.clearTimeout(this.modalTimer)
        this.modalTimer = window.setTimeout(() => {
          this.dialogProps = true
          this.modalTimer = null
        }, 500)
      }
    },
    currentStyling(newValue: string) {
      this.injectCustomCss(newValue)
    },
    reloadSafetyInputs: {
      deep: true,
      handler() {
        this.notifySafetyChanged()
      }
    },
    offlineDraftSource() {
      if (this.isDirty) this.offlineDraftCoordinator?.scheduleCapture(this.editorAdapterSafety.editVersion)
    },
    offlineConnectionState(newValue: string, oldValue: string) {
      if (newValue === 'online' && oldValue !== 'online') void this.offlineDraftCoordinator?.markReconnected()
    },
    isAuthenticated(newValue: boolean) {
      if (newValue) void this.initializeOfflineDrafts()
      else this.offlineDraftCoordinator?.lock()
    },
    accountId(newValue: number, oldValue: number) {
      if (newValue !== oldValue) void this.initializeOfflineDrafts()
    }
  },
  created() {
    if (this.initMode === 'create') {
      this.offlineCreateIdentity = readOfflineCreateIdentity() ?? createOfflineDraftIdentity()
      writeOfflineCreateIdentity(this.offlineCreateIdentity)
    }
    this.setSaveHotkeyHandler(() => {
      if (this.offlineDraftMutationBlocked) {
        this.notifyOfflineMutationBlocked()
        return
      }
      void this.save()
    })
    wikiStore.page.id = this.pageId
    wikiStore.page.description = this.description
    wikiStore.page.isPublished = this.isPublished
    wikiStore.page.isSearchable = this.isSearchable
    wikiStore.page.visibility = this.visibility
    wikiStore.page.ownerId = this.ownerId
    wikiStore.page.publishStartDate = this.publishStartDate
    wikiStore.page.publishEndDate = this.publishEndDate
    wikiStore.page.locale = this.locale
    wikiStore.page.path = this.path
    wikiStore.page.tags = this.tags
    wikiStore.page.title = this.title
    wikiStore.page.scriptCss = this.scriptCss
    wikiStore.page.scriptJs = this.scriptJs
    const brandingAssignment = normalizeEditorBrandingAssignment(this.brandingAssignment)
    wikiStore.page.brandingAssignment = brandingAssignment
    wikiStore.page.brandingView = normalizeEditorBrandingView(this.brandingView, brandingAssignment)
    wikiStore.page.sourceRevision = this.sourceRevision

    wikiStore.page.mode = 'edit'

    this.checkoutDateActive = this.checkoutDate

    wikiStore.page.pageFeatures = normalizeEditorPageFeatures(this.pageFeatures)
    if (this.effectivePermissions) {
      wikiStore.page.effectivePermissions = decodeBase64Json(this.effectivePermissions)
    }
  },
  mounted() {
    wikiStore.editor.mode = this.initMode || 'create'

    wikiStore.editor.content = this.initContent ? Base64.decode(this.initContent) : ''
    this.setCurrentSavedState()
    if (this.mode === 'create' && !this.initEditor) {
      const availableEditors = normalizeAvailableEditors(siteConfig.availableEditors)
      if (availableEditors.length === 1) {
        this.currentEditor = getEditorComponentName(availableEditors[0])
      } else {
        if (this.modalTimer !== null) window.clearTimeout(this.modalTimer)
        this.modalTimer = window.setTimeout(() => {
          this.dialogEditorSelector = true
          this.modalTimer = null
        }, 500)
      }
    } else {
      this.currentEditor = getEditorComponentName(this.initEditor || 'markdown')
    }
    this.setupOfflineDraftCoordinator()
    setReloadSafetyProvider(() => {
      const snapshot = this.offlineDraftCoordinator?.reloadSafetySnapshot
      return snapshot ?? {
        safe: false,
        revision: `editor:${this.safetyRevision}`,
        actorEpoch: wikiStore.offlineIdentityEpoch
      }
    })
    this.notifySafetyChanged()
    void this.initializeOfflineDrafts()

    window.addEventListener(OFFLINE_SESSION_INVALIDATED_EVENT, this.handleOfflineSessionInvalidated)
    window.addEventListener('beforeunload', this.handleBeforeUnload)
    if (this.mode !== 'create' && this.pageId > 0) {
      void this.hydratePage()
    }

    onEditorConflictReset(this.handleEditorConflictReset)
    this.conflictTimer = window.setInterval(this.refreshConflict, 5000)
    this.injectCustomCss(this.currentStyling)
  },

  beforeUnmount() {
    this.lifecycleGeneration += 1
    this.offlineMetadataOperation += 1
    this.offlineStorage?.close()
    this.offlineStorage = null
    this.setSaveHotkeyHandler(null)
    offEditorConflictReset(this.handleEditorConflictReset)
    if (this.conflictTimer !== null) window.clearInterval(this.conflictTimer)
    if (this.customCssTimer !== null) window.clearTimeout(this.customCssTimer)
    if (this.modalTimer !== null) window.clearTimeout(this.modalTimer)
    if (this.navigationTimer !== null) window.clearTimeout(this.navigationTimer)
    window.removeEventListener(OFFLINE_SESSION_INVALIDATED_EVENT, this.handleOfflineSessionInvalidated)
    window.removeEventListener('beforeunload', this.handleBeforeUnload)
    this.editorFlushUnsubscribe?.()
    this.editorFlushUnsubscribe = null
    this.editorAdapterUnsubscribe?.()
    this.editorAdapterUnsubscribe = null
    setReloadSafetyProvider(null)
    this.offlineDraftCoordinator?.destroy()
    this.offlineDraftCoordinator = null
    removeEditorPageCss()
  },
  methods: {
    currentEditableState(): EditableStateValue {
      return {
        content: wikiStore.editor.content,
        description: wikiStore.page.description,
        isPublished: wikiStore.page.isPublished,
        isSearchable: wikiStore.page.isSearchable,
        visibility: wikiStore.page.visibility,
        locale: wikiStore.page.locale,
        path: wikiStore.page.path,
        publishEndDate: wikiStore.page.publishEndDate,
        publishStartDate: wikiStore.page.publishStartDate,
        tags: wikiStore.page.tags,
        title: wikiStore.page.title,
        scriptCss: wikiStore.page.scriptCss,
        scriptJs: wikiStore.page.scriptJs,
        brandingAssignment: wikiStore.page.brandingAssignment,
        pageFeatures: wikiStore.page.pageFeatures,
        okf: wikiStore.page.okf
      }
    },
    normalizeEditableDate(value: unknown): string {
      if (value === null || value === undefined || value === '') return ''
      return typeof value === 'string' ? value : `__invalid_date:${typeof value}`
    },
    canonicalEditableState(value: EditableStateValue, includeContent = true): EditorEditableState {
      let okfMetadata: unknown = null
      try {
        const authority = value.okf !== null && typeof value.okf === 'object' ? Reflect.get(value.okf, 'authority') : null
        const metadata = authority !== null && typeof authority === 'object' ? Reflect.get(authority, 'metadata') : null
        try {
          okfMetadata = buildOkfMetadataPayload(metadata) ?? null
        } catch {
          okfMetadata = { invalid: true, value: _.cloneDeep(metadata) }
        }
      } catch {
        okfMetadata = { invalid: true }
      }
      return {
        content: includeContent ? value.content : undefined,
        description: value.description,
        isPublished: value.isPublished,
        isSearchable: value.isSearchable,
        visibility: value.visibility,
        locale: value.locale,
        path: value.path,
        publishEndDate: this.normalizeEditableDate(value.publishEndDate),
        publishStartDate: this.normalizeEditableDate(value.publishStartDate),
        tags: value.tags,
        title: value.title,
        scriptCss: value.scriptCss,
        scriptJs: value.scriptJs,
        brandingAssignment: value.brandingAssignment,
        pageFeatures: normalizePageFeatures(value.pageFeatures),
        okf: okfMetadata
      }
    },
    sameEditableState(left: EditableStateValue, right: EditableStateValue, includeContent = true): boolean {
      try {
        return _.isEqual(
          this.canonicalEditableState(left, includeContent),
          this.canonicalEditableState(right, includeContent)
        )
      } catch {
        return false
      }
    },
    isMetadataDirty(): boolean {
      return !this.sameEditableState(this.savedState, this.currentEditableState(), false)
    },
    notifySafetyChanged() {
      this.safetyRevision += 1
      notifyReloadSafetyChanged()
    },
    async getOfflineStorageForMetadata(expectedLifecycleGeneration: number): Promise<OfflineStorage | null> {
      if (this.lifecycleGeneration !== expectedLifecycleGeneration) return null
      const existing = this.offlineStorage
      if (existing && !existing.isClosed) return existing
      const pending = this.offlineStoragePromise
      if (pending) {
        const storage = await pending
        if (this.lifecycleGeneration !== expectedLifecycleGeneration || storage.isClosed) return null
        return storage
      }
      const opening = openOfflineStorage()
      this.offlineStoragePromise = opening
      try {
        const storage = await opening
        if (this.lifecycleGeneration !== expectedLifecycleGeneration) {
          storage.close()
          return null
        }
        this.offlineStorage = storage
        return storage
      } finally {
        if (this.offlineStoragePromise === opening) this.offlineStoragePromise = null
      }
    },
    async offlineAdmissionSelector(capture: EditorSaveCapture, pageId: number): Promise<OfflineSnapshotSelector | null> {
      if (capture.visibility !== 'public' || capture.isPublished !== true || typeof capture.content !== 'string') return null
      if (typeof siteConfig === 'undefined') return null
      if (typeof capture.pageInput.editor !== 'string' || !normalizeAvailableEditors(siteConfig.availableEditors).includes(capture.pageInput.editor as PageEditorKey)) return null
      const protectionResponse = await window.fetch(`/_api/pages/${pageId}/protection`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      })
      if (!protectionResponse.ok) return null
      const protection: unknown = await protectionResponse.json()
      if (!protection || typeof protection !== 'object' || Reflect.get(protection, 'protected') !== false) return null
      const parsedSelector = OfflineSnapshotSelectorSchema.safeParse({
        siteId: typeof window.location.origin === 'string' ? window.location.origin : '',
        pageId,
        locale: capture.locale
      })
      return parsedSelector.success ? Object.freeze(parsedSelector.data) : null
    },
    isCurrentOfflineMetadataOperation(
      operation: number,
      capture: EditorSaveCapture,
      pageId: number,
      expectedAuthenticated: boolean,
      expectedAccountId: number,
      expectedOfflineIdentityEpoch: number,
      expectedLifecycleGeneration: number
    ): boolean {
      if (
        this.offlineMetadataOperation !== operation ||
        !this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, expectedLifecycleGeneration)
      )
        return false
      try {
        const currentIdentity = this.getOfflineDraftIdentity()
        const pageIdentityMatches = capture.identity.pageId === null
          ? wikiStore.page.id === pageId
          : capture.identity.pageId === pageId && currentIdentity.pageId === pageId
        return (
          pageIdentityMatches &&
          currentIdentity.editorKey === capture.identity.editorKey &&
          currentIdentity.locale === capture.identity.locale &&
          currentIdentity.path === capture.identity.path &&
          (this.currentEditor === getEditorComponentName(capture.identity.editorKey) || wikiStore.editor.editorKey === capture.identity.editorKey)
        )
      } catch {
        return false
      }
    },
    async recordSuccessfulOfflinePageEdit(
      capture: EditorSaveCapture,
      pageId: number,
      editedAt: string | undefined,
      expectedAuthenticated: boolean,
      expectedAccountId: number,
      expectedOfflineIdentityEpoch: number,
      expectedLifecycleGeneration: number
    ): Promise<void> {
      const operation = ++this.offlineMetadataOperation
      const isCurrent = (): boolean =>
        this.isCurrentOfflineMetadataOperation(
          operation,
          capture,
          pageId,
          expectedAuthenticated,
          expectedAccountId,
          expectedOfflineIdentityEpoch,
          expectedLifecycleGeneration
        )
      if (!isCurrent()) return
      try {
        const selector = await this.offlineAdmissionSelector(capture, pageId)
        if (!selector || !isCurrent()) return
        const storage = await this.getOfflineStorageForMetadata(expectedLifecycleGeneration)
        if (!storage || !isCurrent()) return
        const policy = await storage.readOfflinePolicy()
        if (!isCurrent() || policy.state.automaticSavingEnabled !== true) return
        const pagePolicy = policy.pages.find(page => page.siteId === selector.siteId && page.pageId === selector.pageId && page.locale === selector.locale)
        if (pagePolicy?.excluded || pagePolicy?.availability === 'ineligible') return
        await storage.recordSuccessfulPageEdit(selector, {
          expectedSessionGeneration: policy.sessionGeneration,
          expectedPolicyRevision: policy.state.policyRevision,
          ...(typeof editedAt === 'string' && editedAt.trim() ? { editedAt } : {})
        })
      } catch (error) {
        if (!isCurrent()) return
        const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined
        if (code === 'generation-fenced' || code === 'policy-revision-fenced') return
        const detail = getErrorMessage(error)
        wikiStore.showNotification({
          message: detail ? this.$t('editor:editor.offlinePageMetadataCould', { detail, interpolation: { escapeValue: false } }) : this.$t('editor:editor.offlinePageMetadataCould2'),
          style: 'warning',
          icon: 'warning'
        })
      }
    },
    offlineMutationBlockMessage(): string {
      if (this.offlineDraftStatus === 'locked') {
        return this.offlineDraftError || this.$t('editor:editor.offlineDraftRecoveryLocked')
      }
      if (this.offlineDraftStatus === 'unavailable') {
        return this.$t('editor:editor.publishingUnavailableBecausePage')
      }
      if (!this.offlineDraftCoordinator) return this.$t('editor:editor.offlineDraftRecoveryUnavailable')
      return this.$t('editor:editor.offlineEditorRecoveryNot')
    },
    notifyOfflineMutationBlocked(): string {
      const message = this.offlineMutationBlockMessage()
      if (!this.offlineDraftError) this.offlineDraftError = message
      wikiStore.showNotification({
        message,
        style: 'warning',
        icon: 'warning'
      })
      return message
    },
    reloadEditor() {
      if (typeof window.location.reload === 'function') window.location.reload()
    },
    isCurrentActorSession(expectedAuthenticated: boolean, expectedAccountId: number, expectedOfflineIdentityEpoch: number, expectedLifecycleGeneration?: number): boolean {
      return (
        this.isAuthenticated === expectedAuthenticated &&
        this.accountId === expectedAccountId &&
        wikiStore.offlineIdentityEpoch === expectedOfflineIdentityEpoch &&
        (expectedLifecycleGeneration === undefined || this.lifecycleGeneration === expectedLifecycleGeneration)
      )
    },
    assertCurrentActorSession(expectedAuthenticated: boolean, expectedAccountId: number, expectedOfflineIdentityEpoch: number, expectedLifecycleGeneration?: number): void {
      if (!this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, expectedLifecycleGeneration)) {
        throw new Error(this.$t('editor:editor.accountSessionChangedWhile'))
      }
    },
    getReloadSafetyFacts() {
      const adapter = this.editorAdapterSafety
      return {
        dirtyMetadata: this.isMetadataDirty(),
        mergeState: !adapter.ready || adapter.nonPersisted || adapter.mergeDirty || this.activeModal !== '' || this.dialogUnsaved || this.dialogProps || this.dialogEditorSelector,
        collaborationBacklog: Math.max(adapter.collaborationBacklog, this.collaborationActive ? 1 : 0),
        routeIdentity: JSON.stringify({
          mode: this.mode,
          pageId: wikiStore.page.id,
          locale: wikiStore.page.locale,
          path: wikiStore.page.path,
          sourceRevision: wikiStore.page.sourceRevision,
          checkoutDate: this.checkoutDateActive,
          accountId: this.accountId,
          authenticated: this.isAuthenticated,
          adapterRevision: adapter.revision,
          editVersion: adapter.editVersion,
          offlineIdentityEpoch: wikiStore.offlineIdentityEpoch,
          nonPersisted: adapter.nonPersisted,
          mergeDirty: adapter.mergeDirty,
          collaborationGeneration: this.collaborationGeneration,
          collaborationDiscarded: this.collaborationDiscarded,
          submissionCandidates: this.offlineSubmissionCandidates.map(candidate => candidate.submission.recordId),
          draftCandidates: this.offlineDraftCandidates.map(candidate => candidate.recordId),
          offlineDraftStatus: this.offlineDraftStatus,
          offlineDraftError: this.offlineDraftError,
          isSaving: this.isSaving,
          dialogUnsaved: this.dialogUnsaved,
          dialogProps: this.dialogProps,
          dialogEditorSelector: this.dialogEditorSelector,
          offlineDraftBusy: this.offlineDraftBusy,
          safetyRevision: this.safetyRevision
        })
      }
    },
    handleEditorAdapter(adapter: EditorAdapter) {
      this.editorFlushUnsubscribe?.()
      this.editorFlushUnsubscribe = bindEditorFlushSignals(adapter)
      this.editorAdapterUnsubscribe?.()
      this.editorAdapter = adapter
      this.editorAdapterSafety = adapter.snapshot()
      this.editorAdapterUnsubscribe = adapter.onState(safety => {
        this.editorAdapterSafety = safety
        this.notifySafetyChanged()
      })
    },
    handleEditorAdapterClear(adapter?: EditorAdapter) {
      if (adapter && adapter !== this.editorAdapter) return
      this.editorFlushUnsubscribe?.()
      this.editorFlushUnsubscribe = null
      this.editorAdapterUnsubscribe?.()
      this.editorAdapterUnsubscribe = null
      this.editorAdapter = null
      this.editorAdapterSafety = {
        ready: false,
        editVersion: 0,
        nonPersisted: true,
        mergeDirty: false,
        collaborationBacklog: Number.MAX_SAFE_INTEGER,
        revision: 'uninitialized'
      }
      this.notifySafetyChanged()
    },
    captureEditorState(): EditorAdapterCapture {
      const adapter = this.editorAdapter
      if (adapter && !this.editorAdapterSafety.ready) throw new Error(this.$t('editor:editor.editorStillInitializingRetry'))
      const captured = adapter?.capture() ?? {
        text: wikiStore.editor.content,
        editVersion: this.editorAdapterSafety.editVersion
      }
      wikiStore.editor.content = captured.text
      this.editorAdapterSafety = adapter?.snapshot() ?? this.editorAdapterSafety
      return Object.freeze({ text: captured.text, editVersion: captured.editVersion })
    },
    setupOfflineDraftCoordinator() {
      if (this.offlineDraftCoordinator) return
      if (this.mode === 'create' && !this.offlineCreateIdentity) {
        this.offlineCreateIdentity = readOfflineCreateIdentity() ?? createOfflineDraftIdentity()
        writeOfflineCreateIdentity(this.offlineCreateIdentity)
      }
      const coordinator = markRaw(new OfflineEditorDraftCoordinator({
        fetchImpl: window.fetch.bind(window),
        isAuthenticated: () => wikiStore.user.authenticated,
        accountId: () => wikiStore.user.id,
        getActorEpoch: () => wikiStore.offlineIdentityEpoch,
        isOfflineBoundaryReady: () =>
          (wikiStore.authRefreshPending || !wikiStore.authRefreshSettled)
            ? this.warmAuthenticatedActor && wikiStore.offlineIdentityReady
            : (wikiStore.authRefreshOutcome === 'authenticated' || wikiStore.authRefreshOutcome === 'unavailable') &&
              wikiStore.offlineIdentityReady,
        getIdentity: () => this.submissionCaptureIdentity ?? this.getOfflineDraftIdentity(),
        getValues: () => this.submissionCaptureValues ?? ({
          title: wikiStore.page.title,
          description: wikiStore.page.description,
          content: wikiStore.editor.content
        }),
        detachedApply: payload => this.applyOfflineDraft(payload),
        detachedReplace: payload => this.applyOfflineDraft(payload),
        detachedClear: () => {
          if (this.offlineDraftCoordinator === coordinator && this.mode === 'create') this.editorAdapter?.clear()
        },
        isDirty: () => this.isDirty,
        getReloadSafetyFacts: () => this.getReloadSafetyFacts(),
        isOnline: () => pwaState.connectionState === 'online',
        onChange: view => {
          if (this.offlineDraftCoordinator !== coordinator) return
          this.offlineDraftStatus = view.state
          this.offlineDraftCandidate = view.candidate?.payload ?? null
          this.offlineDraftCandidates = [...view.candidates]
          this.offlineSubmissionCandidates = [...view.submissionCandidates]
          this.offlineDraftError = view.error ?? ''
          if (view.committed && coordinator.hasCommittedCurrentValues) {
            this.editorAdapter?.markPersisted?.(this.editorAdapterSafety.editVersion)
          }
          this.notifySafetyChanged()
        },
        onSafetyChange: () => {
          if (this.offlineDraftCoordinator !== coordinator) return
          this.notifySafetyChanged()
        }
      }))
      this.offlineDraftCoordinator = coordinator
    },
    getOfflineDraftIdentity() {
      const pageId = this.mode === 'update' && wikiStore.page.id > 0 ? wikiStore.page.id : null
      if (pageId === null && !this.offlineCreateIdentity) {
        this.offlineCreateIdentity = readOfflineCreateIdentity() ?? createOfflineDraftIdentity()
        writeOfflineCreateIdentity(this.offlineCreateIdentity)
      }
      const editorName = wikiStore.editor.editorKey || this.currentEditor
      const editorKey = ({
        editorMarkdown: 'markdown',
        editorVisualMarkdown: 'visual-markdown',
        editorCkeditor: 'ckeditor',
        editorAsciidoc: 'asciidoc',
        editorCode: 'code'
      } as Record<string, PageEditorKey>)[editorName] ?? editorName
      const normalizedEditorKey: PageEditorKey = ['markdown', 'visual-markdown', 'ckeditor', 'asciidoc', 'code'].includes(editorKey)
        ? editorKey as PageEditorKey
        : 'markdown'
      return {
        editorKey: normalizedEditorKey,
        pageId,
        createIdentity: pageId === null ? this.offlineCreateIdentity : null,
        locale: wikiStore.page.locale || this.locale || 'en',
        path: wikiStore.page.path || this.path || 'home',
        baseSourceRevision: pageId === null ? null : (wikiStore.page.sourceRevision || null),
        baseUpdatedAt: pageId === null ? null : (this.checkoutDateActive || null)
      }
    },
    applyOfflineDraft(payload: OfflineDraftPayloadV1) {
      if (!this.offlineDraftCoordinator || this.offlineDraftStatus === 'locked' || !this.isAuthenticated) return
      this.editorAdapter?.replaceText(payload.content, { detached: true })
      wikiStore.page.title = payload.title
      wikiStore.page.description = payload.description
      wikiStore.editor.content = payload.content
      this.notifySafetyChanged()
    },
    async initializeOfflineDrafts() {
      let coordinator = this.offlineDraftCoordinator
      const lifecycleGeneration = this.lifecycleGeneration
      if (!coordinator) {
        if (!this.isAuthenticated || this.authRefreshPending || !wikiStore.authRefreshSettled || !wikiStore.offlineIdentityReady) return
        this.setupOfflineDraftCoordinator()
        coordinator = this.offlineDraftCoordinator
      }
      if (!coordinator || !coordinator.isAuthenticatedUser()) return
      const expectedAuthenticated = this.isAuthenticated
      const expectedAccountId = this.accountId
      const expectedOfflineIdentityEpoch = wikiStore.offlineIdentityEpoch
      await coordinator.initialize()
      if (
        this.lifecycleGeneration === lifecycleGeneration &&
        this.offlineDraftCoordinator === coordinator &&
        this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration)
      )
        this.notifySafetyChanged()
    },
    async restoreOfflineDraft(recordId?: string) {
      if (this.offlineDraftBusy || !this.offlineDraftCoordinator) return
      this.offlineDraftBusy = true
      try {
        await this.offlineDraftCoordinator.applyDetachedCandidate(recordId)
      } finally {
        this.offlineDraftBusy = false
        this.notifySafetyChanged()
      }
    },
    reloadServerEditorAfterDiscard(coordinator: Pick<OfflineEditorDraftCoordinator, 'destroy'>) {
      if (this.mode !== 'update' || this.offlineDraftCoordinator !== coordinator) return
      // Fence pending captures; the authorized bootstrap owns the complete server baseline.
      coordinator.destroy()
      this.offlineDraftCoordinator = null
      this.exitConfirmed = true
      window.location.reload()
    },
    async discardOfflineDraft(recordId?: string) {
      if (this.offlineDraftBusy || !this.offlineDraftCoordinator) return
      const coordinator = this.offlineDraftCoordinator
      const lifecycleGeneration = this.lifecycleGeneration
      this.offlineDraftBusy = true
      try {
        if (await coordinator.clearDetachedCandidate(recordId)) {
          if (this.lifecycleGeneration !== lifecycleGeneration || this.offlineDraftCoordinator !== coordinator) return
          this.reloadServerEditorAfterDiscard(coordinator)
        }
      } finally {
        if (this.lifecycleGeneration === lifecycleGeneration && this.offlineDraftCoordinator === coordinator) {
          this.offlineDraftBusy = false
          this.notifySafetyChanged()
        }
      }
    },
    async restoreOfflineDraftRow(row: OfflineDraftRow) {
      this.busyRecoveryRow = row.key
      try {
        await this.restoreOfflineDraft(row.recordId)
      } finally {
        this.busyRecoveryRow = null
      }
    },
    async discardOfflineDraftRow(row: OfflineDraftRow) {
      this.busyRecoveryRow = row.key
      try {
        await this.discardOfflineDraft(row.recordId)
      } finally {
        this.busyRecoveryRow = null
        if (this.pendingDraftDiscard === row.key) this.pendingDraftDiscard = null
      }
    },
    async confirmDeleteOfflineSubmission(recordId: string) {
      try {
        await this.deleteOfflineSubmission(recordId)
      } finally {
        if (this.pendingSubmissionDelete === recordId) this.pendingSubmissionDelete = null
      }
    },
    async inspectOfflineSubmission(recordId: string) {
      if (this.offlineDraftBusy) return
      const coordinator = this.offlineDraftCoordinator
      const lifecycleGeneration = this.lifecycleGeneration
      const candidate = this.offlineSubmissionCandidates.find(item => item.submission.recordId === recordId)
      if (!candidate) return
      this.offlineDraftBusy = true
      try {
        if (candidate.payload.pageId === null) {
          this.offlineReconcilePrompt = { recordId, kind: 'create', revision: null }
          return
        }
        const page = await fetchPage(window.fetch.bind(window), candidate.payload.pageId, this.$t('editor:editor.authoritativePageCouldNot'))
        if (
          this.lifecycleGeneration !== lifecycleGeneration ||
          this.offlineDraftCoordinator !== coordinator ||
          !this.offlineSubmissionCandidates.some(item => item.submission.recordId === recordId)
        )
          return
        this.offlineReconcilePrompt = { recordId, kind: 'update', revision: page.sourceRevision }
      } catch (error) {
        if (this.lifecycleGeneration === lifecycleGeneration && this.offlineDraftCoordinator === coordinator) {
          wikiStore.showNotification({ message: getErrorMessage(error), style: 'error', icon: 'warning' })
        }
      } finally {
        if (this.lifecycleGeneration === lifecycleGeneration) this.offlineDraftBusy = false
      }
    },
    async deleteOfflineSubmission(recordId: string) {
      if (this.offlineDraftBusy || !this.offlineDraftCoordinator) return
      const coordinator = this.offlineDraftCoordinator
      const lifecycleGeneration = this.lifecycleGeneration
      this.offlineDraftBusy = true
      try {
        if (await coordinator.clearDetachedCandidate(recordId)) {
          if (this.lifecycleGeneration !== lifecycleGeneration || this.offlineDraftCoordinator !== coordinator) return
          if (this.offlineReconcilePrompt?.recordId === recordId) this.offlineReconcilePrompt = null
          if (this.mode === 'create' && this.offlineSubmissionCandidates.length <= 1) clearOfflineCreateIdentity()
          this.reloadServerEditorAfterDiscard(coordinator)
        }
      } finally {
        if (this.lifecycleGeneration === lifecycleGeneration && this.offlineDraftCoordinator === coordinator) {
          this.offlineDraftBusy = false
          this.notifySafetyChanged()
        }
      }
    },
    async resolveOfflineSubmission(resolution: 'discard' | 'continue') {
      const prompt = this.offlineReconcilePrompt
      if (!prompt || this.offlineDraftBusy || !this.offlineDraftCoordinator) return
      const candidate = this.offlineSubmissionCandidates.find(item => item.submission.recordId === prompt.recordId)
      if (!candidate) return
      const coordinator = this.offlineDraftCoordinator
      const lifecycleGeneration = this.lifecycleGeneration
      this.offlineDraftBusy = true
      try {
        const resolved = resolution === 'discard'
          ? await coordinator.clearDetachedCandidate(prompt.recordId)
          : await coordinator.replaceDetachedCandidate(candidate.payload, prompt.recordId)
        if (this.lifecycleGeneration !== lifecycleGeneration || this.offlineDraftCoordinator !== coordinator) return
        if (resolved) {
          this.offlineReconcilePrompt = null
          if (resolution === 'discard' && prompt.kind === 'create') clearOfflineCreateIdentity()
          if (resolution === 'discard') this.reloadServerEditorAfterDiscard(coordinator)
        }
      } finally {
        if (this.lifecycleGeneration === lifecycleGeneration && this.offlineDraftCoordinator === coordinator) {
          this.offlineDraftBusy = false
          this.notifySafetyChanged()
        }
      }
    },
    handleOfflineSessionInvalidated() {
      this.lifecycleGeneration += 1
      this.offlineMetadataOperation += 1
      if (this.navigationTimer !== null) window.clearTimeout(this.navigationTimer)
      if (this.customCssTimer !== null) window.clearTimeout(this.customCssTimer)
      if (this.modalTimer !== null) window.clearTimeout(this.modalTimer)
      this.navigationTimer = null
      this.customCssTimer = null
      this.modalTimer = null

      const adapter = this.editorAdapter
      const coordinator = this.offlineDraftCoordinator
      if (coordinator) {
        try {
          coordinator.lock()
        } catch {
          adapter?.clear()
        } finally {
          coordinator.destroy()
          this.offlineDraftCoordinator = null
        }
      } else {
        adapter?.clear()
      }
      if (adapter) {
        this.handleEditorAdapterClear(adapter)
        adapter.destroy()
      }
      this.editorInstanceKey += 1

      const emptyOkf: typeof wikiStore.page.okf = {
        authority: { state: 'invalid', metadata: null, trust: null },
        projection: { state: 'pending', value: null }
      }
      wikiStore.editor.content = ''
      wikiStore.editor.id = 0
      wikiStore.editor.mode = 'create'
      wikiStore.editor.activeModal = ''
      wikiStore.editor.activeModalData = null
      wikiStore.editor.checkoutDateActive = ''
      wikiStore.page.id = 0
      wikiStore.page.description = ''
      wikiStore.page.isPublished = false
      wikiStore.page.isSearchable = true
      wikiStore.page.visibility = 'public'
      wikiStore.page.locale = 'en'
      wikiStore.page.path = ''
      wikiStore.page.publishEndDate = ''
      wikiStore.page.publishStartDate = ''
      wikiStore.page.tags = []
      wikiStore.page.title = ''
      wikiStore.page.scriptCss = ''
      wikiStore.page.scriptJs = ''
      wikiStore.page.sourceRevision = ''
      wikiStore.page.brandingAssignment = null
      wikiStore.page.pageFeatures = normalizePageFeatures(undefined)
      wikiStore.page.brandingView = null
      this.offlineDraftStatus = 'locked'
      this.offlineDraftError = this.$t('editor:editor.offlineEditorSessionWas')
      wikiStore.page.okfLoading = false
      this.savedState = {
        content: '',
        description: '',
        isPublished: false,
        isSearchable: true,
        visibility: 'public',
        locale: 'en',
        path: '',
        publishEndDate: '',
        publishStartDate: '',
        tags: [],
        title: '',
        scriptCss: '',
        scriptJs: '',
        brandingAssignment: null,
        brandingView: null,
        pageFeatures: normalizePageFeatures(undefined),
        okf: _.cloneDeep(emptyOkf)
      }
      this.submissionCaptureValues = null
      this.submissionCaptureIdentity = null
      this.offlineCreateIdentity = null
      clearOfflineCreateIdentity()
      this.offlineDraftCandidate = null
      this.offlineDraftCandidates = []
      this.offlineSubmissionCandidates = []
      this.offlineReconcilePrompt = null
      this.offlineDraftStatus = 'locked'
      this.offlineDraftError = this.$t('editor:editor.offlineEditorSessionWas2')
      this.offlineDraftBusy = false
      this.dialogUnsaved = false
      this.discardError = ''
      this.saveFeedback = 'idle'
      this.pendingDraftDiscard = null
      this.pendingSubmissionDelete = null
      this.busyRecoveryRow = null
      this.dialogProps = false
      this.dialogEditorSelector = false
      this.activeModal = ''
      this.isConflict = false
      this.collaborationActive = false
      this.collaborationGeneration = null
      this.collaborationDiscarded = false
      this.isSaving = false
      this.conflictCheckPending = false
      this.discardPending = false
      removeEditorPageCss()
      this.notifySafetyChanged()
    },
    handleCollaborationState(state: { active: boolean, discarded: boolean, generation: number | null }) {
      if (this.collaborationDiscarded) return
      this.collaborationActive = state.active
      this.collaborationDiscarded = state.discarded
      this.collaborationGeneration = state.generation
      this.notifySafetyChanged()
    },
    handleBeforeUnload(event: BeforeUnloadEvent) {
      const snapshot = this.offlineDraftCoordinator?.reloadSafetySnapshot
      const safe = snapshot?.safe === true && !this.isSaving && !this.editorAdapterSafety.nonPersisted
      if (!this.exitConfirmed && !safe) {
        event.preventDefault()
        event.returnValue = true
      }
    },
    openPropsModal() {
      this.dialogProps = true
    },
    beginSaveFeedback() {
      this.saveFeedback = 'saving'
    },
    endSaveFeedback(outcome: 'saved' | 'device' | 'failed' | 'idle') {
      if (outcome === 'saved' || outcome === 'device') {
        this.lastSavedAt = Date.now()
        this.lastSaveKind = outcome === 'device' ? 'device' : 'server'
        this.saveFeedback = 'saved'
        return
      }
      this.saveFeedback = outcome
    },
    saveFromMobile() {
      if (this.mode !== 'create' && !this.isDirty) {
        wikiStore.showNotification({ message: this.$t('editor:save.noChanges'), style: 'info', icon: 'check' })
        return
      }
      void this.save()
    },
    handleEditorConflictReset() {
      this.isConflict = false
    },
    async retryOkfAuthorityLoad () {
      if (!this.canRetryOkfAuthorityLoad) return
      await this.hydratePage()
    },
    applyHydratedBranding (page: PageDetails, expectedAssignment?: PageBrandingAssignment | null) {
      if (expectedAssignment !== undefined && !_.isEqual(expectedAssignment, wikiStore.page.brandingAssignment)) return
      if (Object.hasOwn(page, 'brandingAssignment')) {
        const assignment = normalizeEditorBrandingAssignment(page.brandingAssignment)
        wikiStore.page.brandingAssignment = assignment
      }
      if (Object.hasOwn(page, 'branding')) {
        wikiStore.page.brandingView = normalizeEditorBrandingView(page.branding, wikiStore.page.brandingAssignment)
      }
    },
    applyHydratedPageFeatures (page: PageDetails, expectedFeatures?: PageFeatures): boolean {
      if (expectedFeatures !== undefined && !_.isEqual(expectedFeatures, wikiStore.page.pageFeatures)) return false
      wikiStore.page.pageFeatures = normalizePageFeatures(page.pageFeatures)
      return true
    },
    async hydratePage() {
      if (this.mode === 'create' || wikiStore.page.id <= 0 || wikiStore.page.okfLoading) return
      const lifecycleGeneration = this.lifecycleGeneration
      const expectedPageId = wikiStore.page.id
      const coordinator = this.offlineDraftCoordinator
      const expectedAccountId = this.accountId
      const expectedAuthenticated = this.isAuthenticated
      const expectedOfflineIdentityEpoch = wikiStore.offlineIdentityEpoch
      const expectedBrandingAssignment = _.cloneDeep(wikiStore.page.brandingAssignment)
      const expectedPageFeatures = _.cloneDeep(wikiStore.page.pageFeatures)
      wikiStore.page.okfLoading = true
      wikiStore.page.okfError = null
      try {
        if (!this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration)) return
        const page = await fetchPage(window.fetch.bind(window), expectedPageId, this.$t('common:error.unexpected'))
        if (
          this.lifecycleGeneration !== lifecycleGeneration ||
          this.offlineDraftCoordinator !== coordinator ||
          wikiStore.page.id !== expectedPageId ||
          !this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration) ||
          this.mode === 'create' ||
          this.isDirty
        )
          return
        const pageFeaturesWereCurrent = this.applyHydratedPageFeatures(page, expectedPageFeatures)
        this.applyHydratedBranding(page, expectedBrandingAssignment)
        wikiStore.page.okf = page.okf
        wikiStore.page.sourceRevision = page.sourceRevision
        wikiStore.page.isSearchable = page.isSearchable !== false
        this.setCurrentSavedState()
        if (!pageFeaturesWereCurrent) this.savedState.pageFeatures = normalizePageFeatures(page.pageFeatures)
      } catch (err) {
        if (
          this.lifecycleGeneration === lifecycleGeneration &&
          this.offlineDraftCoordinator === coordinator &&
          wikiStore.page.id === expectedPageId &&
          this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration)
        )
          wikiStore.page.okfError = getErrorMessage(err)
      } finally {
        if (this.lifecycleGeneration === lifecycleGeneration && wikiStore.page.id === expectedPageId && this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration)) wikiStore.page.okfLoading = false
      }
    },
    async refreshOkfAfterSave(capture: EditorSaveCapture): Promise<PageDetails | undefined> {
      const lifecycleGeneration = this.lifecycleGeneration
      const expectedPageId = wikiStore.page.id
      const coordinator = this.offlineDraftCoordinator
      const expectedAccountId = this.accountId
      const expectedAuthenticated = this.isAuthenticated
      const expectedOfflineIdentityEpoch = wikiStore.offlineIdentityEpoch
      const metadataSnapshot = this.canonicalEditableState(capture).okf
      wikiStore.page.okfLoading = true
      wikiStore.page.okfError = null
      try {
        if (!this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration)) return
        const page = await fetchPage(window.fetch.bind(window), expectedPageId, this.$t('common:error.unexpected'))
        if (
          this.lifecycleGeneration !== lifecycleGeneration ||
          this.offlineDraftCoordinator !== coordinator ||
          wikiStore.page.id !== expectedPageId ||
          !this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration)
        )
          return
        this.applyHydratedBranding(page, capture.brandingAssignment)
        this.applyHydratedPageFeatures(page, capture.pageFeatures)
        if (_.isEqual(metadataSnapshot, this.canonicalEditableState(this.currentEditableState()).okf)) {
          wikiStore.page.okf = page.okf
        }
        if (wikiStore.page.isSearchable === capture.isSearchable) wikiStore.page.isSearchable = page.isSearchable !== false
        wikiStore.page.sourceRevision = page.sourceRevision
        return page
      } catch (err) {
        if (
          this.lifecycleGeneration === lifecycleGeneration &&
          this.offlineDraftCoordinator === coordinator &&
          wikiStore.page.id === expectedPageId &&
          this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration)
        )
          wikiStore.page.okfError = getErrorMessage(err)
        throw err
      } finally {
        if (this.lifecycleGeneration === lifecycleGeneration && wikiStore.page.id === expectedPageId && this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration)) wikiStore.page.okfLoading = false
      }
    },
    async refreshConflict() {
      if (this.mode === 'create' || this.isSaving || !this.isDirty || this.conflictCheckPending) return
      const lifecycleGeneration = this.lifecycleGeneration
      const expectedPageId = wikiStore.page.id
      const expectedAccountId = this.accountId
      const expectedAuthenticated = this.isAuthenticated
      const expectedOfflineIdentityEpoch = wikiStore.offlineIdentityEpoch
      const coordinator = this.offlineDraftCoordinator
      const checkoutDate = this.checkoutDateActive
      this.conflictCheckPending = true
      try {
        if (!this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration)) return
        const conflict = await checkPageConflict(window.fetch.bind(window), expectedPageId, checkoutDate)
        if (
          this.lifecycleGeneration === lifecycleGeneration &&
          this.offlineDraftCoordinator === coordinator &&
          wikiStore.page.id === expectedPageId &&
          this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration) &&
          !this.isSaving
        )
          this.isConflict = conflict
      } catch (err) {
        if (this.lifecycleGeneration === lifecycleGeneration && this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration)) console.warn(err)
      } finally {
        if (this.lifecycleGeneration === lifecycleGeneration && this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration)) this.conflictCheckPending = false
      }
    },
    openConflict() {
      emitEditorSaveConflict()
    },
    async save({ rethrow = false, overwrite = false }: { rethrow?: boolean, overwrite?: boolean } = {}): Promise<boolean> {
      // Saving no longer blocks the editor with an overlay, so a second Save,
      // Ctrl+S or Save and close must not start a parallel write.
      if (this.isSaving) return false
      ++this.offlineMetadataOperation
      if (this.discardPending) return false
      if (this.collaborationDiscarded) {
        const error = new Error('This collaboration draft was discarded. Reload the page before saving.')
        wikiStore.showNotification({
          message: error.message,
          style: 'error',
          icon: 'warning'
        })
        if (rethrow) throw error
        return false
      }
      if (this.offlineDraftMutationBlocked) {
        const error = new Error(this.notifyOfflineMutationBlocked())
        if (rethrow) throw error
        return false
      }
      if (this.mode !== 'create' && !this.isDirty) return true

      let capture: EditorSaveCapture
      try {
        capture = this.captureSaveSnapshot()
      } catch (error) {
        wikiStore.showNotification({
          message: getErrorMessage(error),
          style: 'error',
          icon: 'warning'
        })
        if (rethrow) throw error
        return false
      }
      const saveMode: 'create' | 'update' = this.mode === 'create' ? 'create' : 'update'
      const capturedAuthenticated = this.isAuthenticated
      const capturedAccountId = this.accountId
      const capturedOfflineIdentityEpoch = wikiStore.offlineIdentityEpoch
      const capturedLifecycleGeneration = this.lifecycleGeneration
      const collaborationGenerationAtSave = this.collaborationActive ? this.collaborationGeneration ?? undefined : undefined
      const coordinator = this.offlineDraftCoordinator

      this.isSaving = true
      this.notifySafetyChanged()
      this.beginSaveFeedback()
      let prepared: PreparedOfflineSubmission | null = null
      let completionAttempted = false
      let postWriteError: string | null = null
      let receiptPreparationWarning: string | null = null
      let authoritativePageId: number | null = null
      let authoritativeUpdatedAt: string | undefined
      let persistedVisibility = saveMode === 'create' ? capture.visibility : this.savedState.visibility
      let hydratedPage: PageDetails | undefined
      const routeChanged = saveMode === 'update' && (
        capture.locale !== this.savedState.locale ||
        capture.path !== this.savedState.path ||
        capture.visibility !== this.savedState.visibility
      )

      try {
        if (this.serverSaveDisabled && coordinator?.isAuthenticatedUser() === true) {
          this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
          if (!(await coordinator.captureThrough(capture.editVersion))) {
            throw new Error(this.$t('editor:editor.changesCouldNotSaved'))
          }
          this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
          if (coordinator.hasCommittedCurrentValues) {
            this.editorAdapter?.markPersisted?.(capture.editVersion)
          }
          wikiStore.showNotification({
            message: this.$t('editor:editor.savedDeviceReconnectReview'),
            style: 'success',
            icon: 'check'
          })
          this.endSaveFeedback('device')
          return true
        }

        this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
        const authOutcome = await wikiStore.waitForAuthRefresh()
        this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
        if (capturedAuthenticated !== this.isAuthenticated || capturedAccountId !== this.accountId) {
          throw new Error(this.$t('editor:editor.accountSessionChangedWhile'))
        }

        const verifiedForNetwork = !capturedAuthenticated || (
          authOutcome === 'authenticated' &&
          wikiStore.authRefreshSettled &&
          !wikiStore.authRefreshPending &&
          wikiStore.offlineIdentityReady
        )
        if (!verifiedForNetwork) {
          throw new Error(this.$t('editor:editor.accountSessionCouldNot'))
        }
        if (saveMode !== (this.mode === 'create' ? 'create' : 'update')) {
          throw new Error(this.$t('editor:editor.editorChangedPagesWhile'))
        }
        if (capturedAuthenticated && this.serverSaveDisabled) {
          throw new Error(this.$t('editor:editor.serverPublishingUnavailableWhile'))
        }

        if (saveMode === 'update') {
          const expectedSourceRevision = capture.identity.baseSourceRevision
          if (!expectedSourceRevision) throw new Error(this.$t('editor:editor.pageRevisionUnavailableReload'))
          if (!overwrite) {
            this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
            const conflict = await checkPageConflict(
              window.fetch.bind(window),
              capture.identity.pageId ?? wikiStore.page.id,
              capture.identity.baseUpdatedAt ?? ''
            )
            this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
            if (conflict) {
              const conflictError = new Error(this.$t('editor:conflict.warning'))
              Object.defineProperty(conflictError, 'status', {
                configurable: true,
                enumerable: true,
                value: 409,
                writable: false
              })
              throw conflictError
            }
          }
        }

        if (coordinator?.isAuthenticatedUser() === true) {
          const receiptRequired =
            coordinator.hasCommittedCurrentValues ||
            coordinator.hasUnresolvedSubmission ||
            this.offlineDraftCandidate !== null ||
            this.offlineDraftCandidates.length > 0 ||
            this.offlineSubmissionCandidates.length > 0 ||
            this.offlineDraftStatus === 'needs-review' ||
            this.offlineDraftStatus === 'outcome-unknown' ||
            this.offlineDraftStatus === 'publishing' ||
            this.offlineDraftStatus === 'conflict'
          this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
          this.submissionCaptureValues = Object.freeze({
            title: capture.title,
            description: capture.description,
            content: capture.content
          })
          this.submissionCaptureIdentity = capture.identity
          let receiptPreparationError: unknown = null
          try {
            prepared = await coordinator.prepareSubmission({ editVersion: capture.editVersion })
            this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
          } catch (error) {
            this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
            receiptPreparationError = error
          } finally {
            this.submissionCaptureValues = null
            this.submissionCaptureIdentity = null
          }
          if (!prepared) {
            if (
              !receiptRequired &&
              authOutcome === 'authenticated' &&
              this.offlineConnectionState === 'online' &&
              this.serverSaveDisabled !== true
            ) {
              receiptPreparationWarning = this.$t('editor:editor.localRecoveryReceiptCould')
            } else if (receiptPreparationError instanceof Error) {
              throw receiptPreparationError
            } else {
              throw new Error(this.$t('editor:editor.pageWasNotSubmitted'))
            }
          }
        }
        if (capturedAuthenticated && this.serverSaveDisabled) {
          throw new Error(this.$t('editor:editor.serverPublishingUnavailableWhile'))
        }
        if (saveMode === 'create') {
          this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
          const page = await createPage(window.fetch.bind(window), capture.pageInput)
          this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
          authoritativePageId = page.id
          authoritativeUpdatedAt = page.updatedAt
          this.checkoutDateActive = page.updatedAt || capture.identity.baseUpdatedAt || this.checkoutDateActive
          this.isConflict = false
          wikiStore.editor.id = page.id
          wikiStore.page.id = page.id
          wikiStore.page.sourceRevision = page.sourceRevision
          wikiStore.editor.mode = 'update'
        } else {
          this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
          const page = await updatePage(
            window.fetch.bind(window),
            capture.identity.pageId ?? wikiStore.page.id,
            capture.pageInput,
            capture.identity.baseSourceRevision!,
            collaborationGenerationAtSave
          )
          this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
          authoritativePageId = capture.identity.pageId ?? wikiStore.page.id
          authoritativeUpdatedAt = page.updatedAt
          wikiStore.page.sourceRevision = page.sourceRevision
          if (capture.visibility !== this.savedState.visibility) {
            try {
              this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
              const visibilityPage = await changePageVisibility(
                window.fetch.bind(window),
                capture.identity.pageId ?? wikiStore.page.id,
                capture.visibility,
                wikiStore.page.sourceRevision,
                capture.visibility === 'public'
              )
              this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
              wikiStore.page.sourceRevision = visibilityPage.sourceRevision
              persistedVisibility = capture.visibility
            } catch (error) {
              this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
              postWriteError = getErrorMessage(error)
            }
          }
          try {
            hydratedPage = await this.refreshOkfAfterSave(capture)
            this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
          } catch (error) {
            this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
            postWriteError = postWriteError ?? getErrorMessage(error)
          }
          this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
          this.checkoutDateActive = page.updatedAt || capture.identity.baseUpdatedAt || this.checkoutDateActive
          this.isConflict = false
        }

        if (prepared && coordinator) {
          this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
          completionAttempted = true
          const completion = postWriteError
            ? await coordinator.completeSubmission(prepared, { kind: 'post-write', reason: postWriteError })
            : await coordinator.completeSubmission(prepared, {
                kind: 'success',
                identity: this.getOfflineDraftIdentity(),
                baseSourceRevision: wikiStore.page.sourceRevision || null,
                baseUpdatedAt: this.checkoutDateActive || null
              })
          this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
          if (!completion) {
            throw new Error(this.$t('editor:editor.pageWasSavedBut'))
          }
        }
        if (authoritativePageId !== null && postWriteError === null) {
          await this.recordSuccessfulOfflinePageEdit(
            capture,
            authoritativePageId,
            authoritativeUpdatedAt,
            capturedAuthenticated,
            capturedAccountId,
            capturedOfflineIdentityEpoch,
            capturedLifecycleGeneration
          )
        }

        this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
        const currentSnapshot = this.isCurrentSaveSnapshot(capture)
        this.markSaveSnapshotPersisted(capture)
        this.setSavedStateFromCapture(capture, persistedVisibility, hydratedPage)

        const saveMessage = postWriteError
          ? this.$t('editor:editor.pageSavedBut', { postWriteError, interpolation: { escapeValue: false } })
          : (saveMode === 'create' ? this.$t('editor:save.createSuccess') : this.$t('editor:save.updateSuccess'))
        wikiStore.showNotification({
          message: receiptPreparationWarning ? `${saveMessage}; ${receiptPreparationWarning}` : saveMessage,
          style: postWriteError || receiptPreparationWarning ? 'warning' : 'success',
          icon: postWriteError || receiptPreparationWarning ? 'warning' : 'check'
        })
        this.endSaveFeedback('saved')

        const canNavigateAfterSave = (): boolean => {
          const safety = coordinator?.reloadSafetySnapshot
          return (
            this.isCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration) &&
            !receiptPreparationWarning &&
            !postWriteError &&
            !this.isDirty &&
            currentSnapshot &&
            this.activeModal === '' &&
            !this.offlineDraftBusy &&
            !this.editorAdapterSafety.mergeDirty &&
            this.editorAdapterSafety.collaborationBacklog === 0 &&
            this.editorAdapterSafety.nonPersisted === false &&
            coordinator?.hasInFlightWork !== true &&
            coordinator?.hasUnresolvedSubmission !== true &&
            safety?.safe !== false
          )
        }
        if (saveMode === 'create') {
          if (canNavigateAfterSave()) {
            this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
            this.exitConfirmed = true
            const scope = capture.visibility === 'private' ? '/_private' : ''
            window.location.assign(`${scope}/${capture.locale}/${capture.path}`)
          }
        } else if (routeChanged && postWriteError === null) {
          if (this.navigationTimer !== null) window.clearTimeout(this.navigationTimer)
          this.navigationTimer = window.setTimeout(() => {
            if (canNavigateAfterSave()) {
              this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
              const scope = capture.visibility === 'private' ? '/_private' : ''
              window.location.replace(`/e${scope}/${capture.locale}/${capture.path}`)
            }
            this.navigationTimer = null
          }, 1000)
        }
        return postWriteError === null
      } catch (error) {
        if (!this.isCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)) {
          const staleError = new Error(this.$t('editor:editor.accountSessionChangedWhile'))
          if (rethrow) throw staleError
          return false
        }
        let message = getErrorMessage(error)
        const rawStatus = error && typeof error === 'object' ? Number(Reflect.get(error, 'status')) : NaN
        const status = Number.isSafeInteger(rawStatus) && rawStatus > 0 ? rawStatus : undefined
        if (status === 401 && !(prepared && coordinator)) {
          await requestOfflineIdentityBoundary({
            accountId: capturedAccountId,
            reason: 'unauthorized'
          })
          if (!this.isCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)) return false
        }
        if (prepared && coordinator && !completionAttempted) {
          completionAttempted = true
          const outcome = status === 409 || status === 401 || status === 403 || status === 404
            ? { kind: 'rejected' as const, status, reason: message }
            : { kind: 'unknown' as const, status, reason: message }
          try {
            await coordinator.completeSubmission(prepared, outcome)
          } catch {
            // Keep the immutable receipt when outcome reconciliation itself fails.
          }
          if (!this.isCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)) return false
        }
        if (status === 403 || status === 404) {
          const unavailableMessage = this.$t('editor:editor.publishingUnavailableBecausePage')
          let attemptedUnavailableCapture = false
          let capturedUnavailableDraft = false
          if (!prepared && coordinator?.isAuthenticatedUser() === true) {
            attemptedUnavailableCapture = true
            try {
              capturedUnavailableDraft = await coordinator.captureNow({
                force: true,
                state: 'unavailable',
                editVersion: capture.editVersion
              })
            } catch {
              capturedUnavailableDraft = false
            }
          }
          this.offlineDraftStatus = 'unavailable'
          message = capturedUnavailableDraft
            ? unavailableMessage
            : attemptedUnavailableCapture
              ? this.$t('editor:editor.publishingUnavailableBecausePage2')
              : unavailableMessage
        }
        if (status === 409) {
          this.isConflict = true
          emitEditorSaveConflict()
        }
        if (collaborationGenerationAtSave !== undefined && message === 'This collaboration draft was discarded. Reload the page before saving.') {
          this.handleCollaborationState({ active: false, discarded: true, generation: null })
        }
        wikiStore.showNotification({
          message,
          style: status === 409 ? 'warning' : 'error',
          icon: 'warning'
        })
        this.endSaveFeedback('failed')
        if (rethrow) throw error
        return false
      } finally {
        this.isSaving = false
        if (this.saveFeedback === 'saving') this.endSaveFeedback('idle')
        this.notifySafetyChanged()
      }
    },
    async saveAndClose(): Promise<boolean> {
      if (this.discardPending) return false
      if (this.isSaving) return false
      const capturedAuthenticated = this.isAuthenticated
      const capturedAccountId = this.accountId
      const capturedOfflineIdentityEpoch = wikiStore.offlineIdentityEpoch
      const capturedLifecycleGeneration = this.lifecycleGeneration
      const wasCreate = wikiStore.editor.mode === 'create'
      try {
        if (!(await this.save({ rethrow: true }))) return false
        if (!this.isCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)) return false
        if (!wasCreate) {
          await this.exit()
          if (!this.isCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)) return false
        }
        return true
      } catch (err) {
        // Error is already handled
        return false
      }
    },
    async saveUnsavedAndClose() {
      const dialogWasUnsaved = this.dialogUnsaved
      this.dialogUnsaved = false
      let saved = false
      try {
        saved = await this.saveAndClose()
      } finally {
        this.dialogUnsaved = saved && !this.isDirty ? false : dialogWasUnsaved
      }
    },
    async exit() {
      if (this.discardPending) return
      try {
        if (this.editorAdapterSafety.ready) this.captureEditorState()
      } catch (error) {
        this.dialogUnsaved = true
        this.discardError = getErrorMessage(error)
        return
      }
      if (this.isDirty) {
        this.discardError = ''
        this.dialogUnsaved = true
      } else {
        this.discardError = ''
        this.exitGo()
      }
    },
    async discardAndExit() {
      if (this.discardPending) return
      const capturedAuthenticated = this.isAuthenticated
      const capturedAccountId = this.accountId
      const capturedOfflineIdentityEpoch = wikiStore.offlineIdentityEpoch
      const capturedLifecycleGeneration = this.lifecycleGeneration
      const coordinator = this.offlineDraftCoordinator
      const discardCollaboration = wikiStore.editor.mode === 'update' && wikiStore.editor.editorKey === 'markdown' && this.collaborationActive
      const collaborationPageId = wikiStore.page.id
      const collaborationCheckoutDate = this.checkoutDateActive
      const collaborationSourceRevision = wikiStore.page.sourceRevision
      this.discardPending = true
      this.discardError = ''
      this.notifySafetyChanged()
      try {
        this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
        if (discardCollaboration) {
          await discardCollaborationDraft(
            window.fetch.bind(window),
            collaborationPageId,
            collaborationCheckoutDate,
            collaborationSourceRevision
          )
          this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
        }
        if (coordinator?.isAuthenticatedUser() === true) {
          if (!(await coordinator.discardCurrentDraft())) {
            throw new Error(this.offlineDraftError || this.$t('editor:editor.localDraftCouldNot'))
          }
          this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
        }
        this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
        this.restoreCurrentSavedState()
        this.dialogUnsaved = false
        this.discardError = ''
        this.exitGo()
      } catch (error) {
        if (this.isCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)) {
          this.dialogUnsaved = true
          this.discardError = getErrorMessage(error)
          wikiStore.showNotification({
            message: this.discardError,
            style: 'error',
            icon: 'warning'
          })
        }
      } finally {
        this.discardPending = false
        this.notifySafetyChanged()
      }
    },
    exitGo() {
      if (this.navigationTimer !== null) window.clearTimeout(this.navigationTimer)
      this.navigationTimer = null
      this.exitConfirmed = true
      if (wikiStore.editor.mode === 'create') {
        window.location.assign('/')
      } else {
        const scope = this.savedState.visibility === 'private' ? '/_private' : ''
        window.location.assign(`${scope}/${this.savedState.locale}/${this.savedState.path}`)
      }
    },
    captureSaveSnapshot(): EditorSaveCapture {
      const editorCapture = this.captureEditorState()
      const pageInput = this.getPageInput(editorCapture.text)
      const identity = Object.freeze({ ...this.getOfflineDraftIdentity() })
      return Object.freeze({
        pageInput,
        editVersion: editorCapture.editVersion,
        identity,
        content: pageInput.content,
        title: pageInput.title,
        description: pageInput.description,
        locale: pageInput.locale,
        path: pageInput.path,
        tags: [...pageInput.tags],
        isPublished: pageInput.isPublished,
        isSearchable: pageInput.isSearchable ?? true,
        visibility: pageInput.visibility,
        publishStartDate: pageInput.publishStartDate,
        publishEndDate: pageInput.publishEndDate,
        scriptCss: pageInput.scriptCss,
        scriptJs: pageInput.scriptJs,
        brandingAssignment: _.cloneDeep(wikiStore.page.brandingAssignment),
        brandingView: _.cloneDeep(wikiStore.page.brandingView),
        pageFeatures: normalizePageFeatures(pageInput.pageFeatures),
        okf: _.cloneDeep(wikiStore.page.okf)
      })
    },
    isCurrentSaveSnapshot(capture: EditorSaveCapture): boolean {
      try {
        const adapterCapture = this.editorAdapter?.capture()
        if (
          adapterCapture &&
          (adapterCapture.editVersion !== capture.editVersion || adapterCapture.text !== capture.content)
        )
          return false
        if (!adapterCapture && wikiStore.editor.content !== capture.content) return false
        return _.isEqual(this.getPageInput(adapterCapture?.text ?? capture.content), capture.pageInput)
      } catch {
        return false
      }
    },
    markSaveSnapshotPersisted(capture: EditorSaveCapture): void {
      const current = this.editorAdapter?.capture()
      if (current?.text === capture.content && current.editVersion === capture.editVersion) this.editorAdapter?.markPersisted?.(capture.editVersion)
    },
    getPageInput(content = wikiStore.editor.content): PageWriteInput {
      const okfMetadata = buildOkfMetadataPayload(wikiStore.page.okf.authority.metadata)
      const rawBrandingAssignment = wikiStore.page.brandingAssignment
      let brandingAssignment: PageBrandingAssignment | null = null
      if (rawBrandingAssignment !== null) {
        const brandingResult = PageBrandingAssignmentSchema.safeParse(rawBrandingAssignment)
        if (!brandingResult.success) throw new Error(this.$t('editor:editor.pageBrandingAssignmentInvalid'))
        brandingAssignment = _.cloneDeep(brandingResult.data)
      }
      const brandingChanged = !_.isEqual(this.savedState.brandingAssignment, brandingAssignment)
      const brandingInput =
        this.mode === 'create'
          ? (brandingAssignment === null ? {} : { branding: brandingAssignment })
          : (brandingChanged ? { branding: brandingAssignment } : {})
      const pageInput: PageWriteInput = {
        content,
        description: wikiStore.page.description,
        editor: wikiStore.editor.editorKey,
        locale: wikiStore.page.locale,
        visibility: wikiStore.page.visibility,
        isPublished: wikiStore.page.isPublished,
        isSearchable: wikiStore.page.isSearchable,
        path: wikiStore.page.path,
        publishEndDate: wikiStore.page.publishEndDate || '',
        publishStartDate: wikiStore.page.publishStartDate || '',
        scriptCss: wikiStore.page.scriptCss,
        scriptJs: wikiStore.page.scriptJs,
        tags: [...wikiStore.page.tags],
        title: wikiStore.page.title,
        pageFeatures: normalizePageFeatures(wikiStore.page.pageFeatures),
        ...brandingInput,
        ...(okfMetadata === undefined ? {} : { okfMetadata: _.cloneDeep(okfMetadata) })
      }
      return freezePageInput(pageInput)
    },
    setSavedStateFromCapture(capture: EditorSaveCapture, visibility: 'public' | 'private', page?: PageDetails) {
      const brandingAssignment = page && Object.hasOwn(page, 'brandingAssignment')
        ? normalizeEditorBrandingAssignment(page.brandingAssignment)
        : _.cloneDeep(capture.brandingAssignment)
      this.savedState = {
        content: capture.content,
        description: capture.description,
        isPublished: capture.isPublished,
        isSearchable: page ? page.isSearchable !== false : capture.isSearchable,
        visibility,
        locale: capture.locale,
        path: capture.path,
        publishEndDate: capture.publishEndDate,
        publishStartDate: capture.publishStartDate,
        tags: [...capture.tags],
        title: capture.title,
        scriptCss: capture.scriptCss,
        scriptJs: capture.scriptJs,
        brandingAssignment,
        brandingView: page && Object.hasOwn(page, 'branding')
          ? normalizeEditorBrandingView(page.branding, brandingAssignment)
          : _.cloneDeep(capture.brandingView),
        pageFeatures: page ? normalizePageFeatures(page.pageFeatures) : normalizePageFeatures(capture.pageFeatures),
        okf: _.cloneDeep(page ? page.okf : capture.okf)
      }
    },
    setCurrentSavedState () {
      this.savedState = {
        content: wikiStore.editor.content,
        description: wikiStore.page.description,
        isPublished: wikiStore.page.isPublished,
        isSearchable: wikiStore.page.isSearchable,
        visibility: wikiStore.page.visibility,
        locale: wikiStore.page.locale,
        path: wikiStore.page.path,
        publishEndDate: wikiStore.page.publishEndDate || '',
        publishStartDate: wikiStore.page.publishStartDate || '',
        tags: [...wikiStore.page.tags],
        title: wikiStore.page.title,
        scriptCss: wikiStore.page.scriptCss,
        scriptJs: wikiStore.page.scriptJs,
        brandingAssignment: _.cloneDeep(wikiStore.page.brandingAssignment),
        brandingView: _.cloneDeep(wikiStore.page.brandingView),
        pageFeatures: normalizePageFeatures(wikiStore.page.pageFeatures),
        okf: _.cloneDeep(wikiStore.page.okf)
      }
    },
    restoreCurrentSavedState () {
      wikiStore.editor.content = this.savedState.content
      wikiStore.page.description = this.savedState.description
      wikiStore.page.isPublished = this.savedState.isPublished
      wikiStore.page.isSearchable = this.savedState.isSearchable
      wikiStore.page.visibility = this.savedState.visibility
      wikiStore.page.locale = this.savedState.locale
      wikiStore.page.path = this.savedState.path
      wikiStore.page.publishEndDate = this.savedState.publishEndDate
      wikiStore.page.publishStartDate = this.savedState.publishStartDate
      wikiStore.page.tags = [...this.savedState.tags]
      wikiStore.page.title = this.savedState.title
      wikiStore.page.scriptCss = this.savedState.scriptCss
      wikiStore.page.scriptJs = this.savedState.scriptJs
      wikiStore.page.brandingAssignment = _.cloneDeep(this.savedState.brandingAssignment)
      wikiStore.page.brandingView = _.cloneDeep(this.savedState.brandingView)
      wikiStore.page.pageFeatures = _.cloneDeep(this.savedState.pageFeatures)
      wikiStore.page.okf = _.cloneDeep(this.savedState.okf)
    },
    injectCustomCss(css: string) {
      if (this.customCssTimer !== null) {
        window.clearTimeout(this.customCssTimer)
        this.customCssTimer = null
      }
      if (_.isEmpty(css)) {
        removeEditorPageCss()
        return
      }

      this.customCssTimer = window.setTimeout(() => {
        let styl = document.querySelector<HTMLStyleElement>('#editor-script-css')
        if (!styl) {
          styl = document.createElement('style')
          styl.id = 'editor-script-css'
          document.head.appendChild(styl)
        }
        styl.textContent = scopeEditorPageCss(css)
        this.customCssTimer = null
      }, 1000)
    }
  }
})
</script>

<style lang='scss'>
.editor {
  min-height: 100vh;
  min-height: 100dvh;
  background: rgb(var(--v-theme-background)) !important;

  .v-application__wrap {
    min-width: 0;
    background:
      radial-gradient(circle at 50% 0, color-mix(in srgb, var(--wiki-accent-spectral) 7%, transparent), transparent 34rem),
      rgb(var(--v-theme-background));
  }

  .nav-header {
    border-bottom: 1px solid var(--wiki-surface-border) !important;
    background: var(--wiki-surface-raised) !important;
    box-shadow: var(--wiki-shadow-xs) !important;
  }

  .nav-header-slot-actions {
    display: flex;
    align-items: center;
    gap: var(--wiki-space-1);
  }

  .v-main {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex: 1 1 auto;

    > :first-child {
      min-width: 0;
      flex: 1 1 auto;
    }
  }
  .editor-main-surface {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .editor-active-editor {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    width: 100%;
  }

  .editor-notices {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: var(--wiki-space-2);
    max-height: 40dvh;
    overflow-y: auto;
    padding: var(--wiki-space-3) clamp(var(--wiki-space-4), 4vw, var(--wiki-space-8)) var(--wiki-space-2);
  }

  .editor-notice {
    flex: none;

    .v-alert__content {
      display: flex;
      flex-direction: column;
      gap: var(--wiki-space-2);
      min-width: 0;
    }
  }

  .editor-notice-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--wiki-space-2);
  }

  .editor-notice-lead {
    margin-block-end: var(--wiki-space-1);
  }

  .editor-recovery-list {
    display: flex;
    flex-direction: column;
    gap: var(--wiki-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .editor-recovery-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--wiki-space-2) var(--wiki-space-4);
    padding: var(--wiki-space-2) var(--wiki-space-3);
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-control-radius);
    background: var(--wiki-surface-raised);
  }

  .editor-recovery-row-text {
    min-width: 0;
    flex: 1 1 12rem;
  }

  .editor-recovery-row-title {
    overflow: hidden;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .editor-recovery-row-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wiki-space-1);
    color: var(--wiki-text-muted);
  }

  .editor-notice-details {
    color: var(--wiki-text-muted);

    summary {
      width: fit-content;
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: .15em;
    }

    > div {
      margin-block-start: var(--wiki-space-1);
    }
  }

  &-title-input {
    width: min(100%, 42rem);

    .v-field {
      border: 1px solid var(--wiki-surface-border);
      border-radius: var(--wiki-control-radius);
      background: var(--wiki-surface-sunken) !important;
      box-shadow: var(--wiki-shadow-inset);
      transition:
        border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
        background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
        box-shadow var(--wiki-motion-fast) var(--wiki-motion-ease);
    }

    .v-field:hover {
      border-color: var(--wiki-surface-border-strong);
      background: var(--wiki-surface-raised) !important;
    }

    .v-field--focused {
      border-color: color-mix(in srgb, var(--wiki-focus-color) 58%, transparent);
      background: var(--wiki-surface-raised) !important;
      box-shadow: var(--wiki-focus-ring), var(--wiki-shadow-inset);
    }

    input {
      color: rgb(var(--v-theme-on-surface));
      font-weight: 650;
      letter-spacing: -.01em;
      text-align: center;
    }
  }

  &-title-input-mobile {
    width: 100%;
    min-width: 0;

    .v-field {
      padding-inline: var(--wiki-space-1);
    }

    input {
      font-size: .875rem;
      text-align: start;
    }
  }
}

.editor-save-action,
.editor-save-close-action,
.editor-page-action,
.editor-close-action,
.editor-conflict-action {
  min-height: var(--wiki-control-height);
  border-radius: var(--wiki-control-radius);
  font-weight: 650;
  text-transform: none;
}

.editor-save-status {
  display: inline-flex;
  align-items: center;
  gap: var(--wiki-space-1);
  margin-inline-end: var(--wiki-space-2);
  color: var(--wiki-text-muted);
  white-space: nowrap;

  &.is-error {
    color: rgb(var(--v-theme-error));
  }

  &.is-visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}

.editor-actions-divider {
  border-color: var(--wiki-surface-border) !important;
}

.editor-mobile-actions {
  padding-bottom: env(safe-area-inset-bottom);
  border-top: 1px solid var(--wiki-surface-border) !important;
  background: var(--wiki-surface-raised) !important;
  box-shadow: 0 calc(var(--wiki-space-2) * -1) var(--wiki-space-8) var(--wiki-shadow-color) !important;

  .v-btn {
    min-width: 0;
    border-radius: 0;
    color: rgb(var(--v-theme-on-surface));

    &:first-child {
      color: var(--wiki-primary-ink);
    }

    &.editor-mobile-save.is-clean {
      color: var(--wiki-text-muted);
    }
  }

  .v-btn__content {
    gap: var(--wiki-space-1);
    font-size: var(--wiki-label-size);
    font-weight: var(--wiki-label-weight);
  }
}

.editor-mobile-menu {
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-md);
}

.atom-spinner.is-inline {
  display: inline-block;
}

.editor-visibility-chip {
  cursor: pointer;
  flex: 0 0 auto;
  margin-inline-start: var(--wiki-space-2);
}

// Formatting tools in the Markdown and visual editors share one neutral look.
// The accent marks only state (pressed/active), hover and focus, so colour
// carries meaning instead of decorating every tool.
.editor-tool-group {
  align-items: center;
  display: flex;
  gap: 3px;
}

.editor-tool.v-btn {
  background: transparent;
  border: 1px solid transparent;
  color: var(--wiki-text-muted);

  &:hover {
    background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 7%, transparent);
    color: rgb(var(--v-theme-on-surface));
  }

  &:focus-visible {
    outline: .125rem solid var(--wiki-focus-color);
    outline-offset: .0625rem;
  }

  &[aria-pressed='true'],
  &.is-active {
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 16%, transparent);
    border-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 45%, transparent);
    color: var(--wiki-accent-ink);
  }

  &[aria-disabled='true'] {
    background: transparent;
    color: var(--wiki-text-subtle);
    cursor: not-allowed;
  }
}

@media (forced-colors: active) {
  .editor-tool.v-btn[aria-pressed='true'],
  .editor-tool.v-btn.is-active {
    border-color: Highlight;
    outline: 1px solid Highlight;
  }

  .editor .nav-header,
  .editor-mobile-actions,
  .editor-mobile-menu {
    border-color: CanvasText !important;
  }
}

@media print {
  .editor-mobile-actions {
    display: none !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  .editor,
  .editor * {
    animation: none !important;
    transition: none !important;
  }
}
</style>
