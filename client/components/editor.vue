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
      template(v-slot:actions)
        v-btn.editor-conflict-action.mr-3.animated.fadeIn(
          color='warning'
          variant="tonal"
          size="small"
          v-if='isConflict'
          @click='openConflict'
          :icon='$vuetify.display.smAndDown'
          aria-label='Resolve editing conflict'
        )
          .text-label-small.mr-3(v-if='$vuetify.display.mdAndUp') Conflict
          status-indicator(intermediary, pulse)
        v-btn.editor-save-action.animated.fadeInDown(
          :variant='mode === `create` || isDirty ? `flat` : `text`'
          color='primary'
          @click='save'
          :disabled='collaborationDiscarded || serverSaveDisabled || offlineMutationBlocked'
          :class='{ "is-icon": $vuetify.display.mdAndDown }'
          :aria-label='mode === `create` ? $t(`common:actions.create`) : (isDirty ? $t(`common:actions.save`) : $t(`editor:save.saved`))'
          )
          v-icon(:start='$vuetify.display.lgAndUp') mdi-check
          span.text-medium-emphasis(v-if='$vuetify.display.lgAndUp && mode !== `create` && !isDirty') {{ $t('editor:save.saved') }}
          span(v-else-if='$vuetify.display.lgAndUp') {{ mode === 'create' ? $t('common:actions.create') : $t('common:actions.save') }}
        v-btn.editor-save-close-action.animated.fadeInDown.wait-p1s(
          v-if='$vuetify.display.mdAndUp'
          variant='tonal'
          color='primary'
          aria-label='Save and close'
          prepend-icon='mdi-content-save-move-outline'
          @click='saveAndClose'
          :disabled='collaborationDiscarded || serverSaveDisabled || offlineMutationBlocked'
        )
          span Save and close
        v-btn.editor-page-action.animated.fadeInDown.wait-p1s(
          v-if='$vuetify.display.mdAndUp'
          variant="tonal"
          color='primary'
          @click='openPropsModal'
          :class='{ "is-icon": $vuetify.display.mdAndDown, "mx-0": !welcomeMode, "ml-0": welcomeMode }'
          :aria-label='$t(`common:actions.page`)'
          )
          v-icon(:start='$vuetify.display.lgAndUp') mdi-tag-text-outline
          span(v-if='$vuetify.display.lgAndUp') {{ $t('common:actions.page') }}
        v-btn.editor-close-action.animated.fadeInDown.wait-p2s(
          v-if='!welcomeMode && $vuetify.display.mdAndUp'
          variant="text"
          color='error'
          :class='{ "is-icon": $vuetify.display.mdAndDown }'
          :aria-label='$t(`common:actions.close`)'
          @click='exit'
          )
          v-icon(:start='$vuetify.display.lgAndUp') mdi-close
          span(v-if='$vuetify.display.lgAndUp') {{ $t('common:actions.close') }}
        v-divider.editor-actions-divider.ml-3(v-if='$vuetify.display.mdAndUp', vertical)
    v-main
      .editor-main-surface
        v-alert.editor-bootstrap-notice(
          v-if='bootstrapNotice'
          type='warning'
          variant='tonal'
          role='alert'
          aria-live='polite'
        )
          .text-body-medium {{ bootstrapNotice }}
        v-alert.editor-offline-save-notice(
          v-if='serverSaveDisabled'
          type='warning'
          variant='tonal'
          role='status'
          aria-live='polite'
        )
          strong {{ offlineSaveNotice }}
        v-alert.editor-draft-notice(
          v-if='offlineDraftError || offlineDraftCandidate || offlineDraftCandidates.length > 0 || offlineSubmissionCandidates.length > 0 || offlineDraftStatusText'
          :type='offlineDraftStatus === `locked` || offlineDraftStatus === `unavailable` ? `warning` : `info`'
          variant='tonal'
          role='status'
          aria-live='polite'
        )
          .text-body-medium(v-if='offlineDraftError') {{ offlineDraftError }}
          .text-body-medium(v-else) {{ offlineDraftStatusText }}
          .editor-draft-recovery-actions(v-if='offlineDraftStatus === `locked` || !offlineDraftCoordinator')
            v-btn(
              size='small'
              variant='tonal'
              color='primary'
              @click='reloadEditor'
            ) Reload editor
          .editor-draft-review-actions(v-if='offlineDraftCandidate')
            v-btn(
              size='small'
              variant='flat'
              color='primary'
              :disabled='offlineDraftBusy'
              @click='restoreOfflineDraft()'
            ) Restore local draft
            v-btn(
              size='small'
              variant='text'
              color='error'
              :disabled='offlineDraftBusy'
              @click='discardOfflineDraft()'
            ) Discard local draft
          .editor-draft-review-actions(v-else-if='offlineDraftCandidates.length > 0')
            .text-body-small Multiple local drafts need an explicit choice.
            template(v-for='candidate of offlineDraftCandidates', :key='candidate.recordId')
              v-btn(
                size='small'
                variant='tonal'
                color='primary'
                :disabled='offlineDraftBusy'
                @click='restoreOfflineDraft(candidate.recordId)'
              ) Restore a local draft
              v-btn(
                size='small'
                variant='text'
                color='error'
                :disabled='offlineDraftBusy'
                @click='discardOfflineDraft(candidate.recordId)'
              ) Discard a local draft
          .editor-draft-submission-actions(v-if='offlineSubmissionCandidates.length > 0')
            .text-body-small A previous page submission needs explicit resolution. Its contents are hidden until you choose how to proceed.
            .text-body-small(v-if='offlineSubmissionCandidates.length > 1') Multiple retained submissions need separate choices.
            template(v-for='candidate of offlineSubmissionCandidates', :key='candidate.submission.recordId')
              v-btn(
                size='small'
                variant='tonal'
                color='primary'
                :disabled='offlineDraftBusy'
                @click='inspectOfflineSubmission(candidate.submission.recordId)'
              ) Review submission outcome
              v-btn(
                size='small'
                variant='text'
                color='error'
                :disabled='offlineDraftBusy'
                @click='deleteOfflineSubmission(candidate.submission.recordId)'
              ) Delete receipt
          .editor-draft-reconcile-actions(v-if='offlineReconcilePrompt')
            .text-body-small(v-if='offlineReconcilePrompt.kind === `update`') The current authoritative page was fetched. Choose whether the server result stands or the retained text becomes a new review draft.
            .text-body-small(v-else) A create request cannot be replayed. Choose whether to delete its receipt or continue the captured text as a new review draft.
            v-btn(
              size='small'
              variant='tonal'
              color='primary'
              :disabled='offlineDraftBusy'
              @click='resolveOfflineSubmission(`discard`)'
            ) Keep server result
            v-btn(
              size='small'
              variant='outlined'
              color='primary'
              :disabled='offlineDraftBusy'
              @click='resolveOfflineSubmission(`continue`)'
            ) Keep as new draft
      component(
        :is='currentEditor'
        v-if='currentEditor'
        :key='editorInstanceKey'
        :save='save'
        @collaboration-state='handleCollaborationState'
        @editor-adapter='handleEditorAdapter'
        @editor-adapter-clear='handleEditorAdapterClear'
      )
      editor-modal-properties(v-if='dialogProps', v-model='dialogProps')
      editor-modal-unsaved(
        v-if='dialogUnsaved'
        v-model='dialogUnsaved'
        :busy='isSaving'
        :discarding='discardPending'
        @discard='discardAndExit'
        @save='saveUnsavedAndClose'
      )
      component(v-if='activeModal', :is='activeModal')

    v-bottom-navigation.editor-mobile-actions(
      v-if='$vuetify.display.smAndDown'
      tag='nav'
      aria-label='Editor actions'
      grow
      :elevation='0'
    )
      v-btn(
        color='primary'
        @click.exact='save'
        :disabled='collaborationDiscarded || serverSaveDisabled || offlineMutationBlocked'
        :aria-label='mode === `create` ? $t(`common:actions.create`) : (isDirty ? $t(`common:actions.save`) : $t(`editor:save.saved`))'
      )
        span {{ mode === 'create' ? $t('common:actions.create') : (isDirty ? $t('common:actions.save') : $t('editor:save.saved')) }}
      v-btn(color='primary', @click='openPropsModal', :aria-label='$t(`common:actions.page`)')
        v-icon mdi-tag-text-outline
        span {{ $t('common:actions.page') }}
      v-menu(location='top end', min-width='240')
        template(v-slot:activator='{ props }')
          v-btn(
            v-bind='props'
            :color='isConflict ? `warning` : undefined'
            aria-label='More editor actions'
          )
            v-icon {{ isConflict ? 'mdi-alert-outline' : 'mdi-dots-horizontal' }}
            span More
        v-list.editor-mobile-menu(nav)
          v-list-item(v-if='isConflict', @click='openConflict')
            template(v-slot:prepend)
              v-icon(color='warning') mdi-alert-outline
            v-list-item-title Conflict
          v-list-item(:disabled='collaborationDiscarded || serverSaveDisabled || offlineMutationBlocked', @click='saveAndClose')
            template(v-slot:prepend)
              v-icon(color='primary') mdi-content-save-move-outline
            v-list-item-title Save and close
          v-list-item(v-if='!welcomeMode', @click='exit')
            template(v-slot:prepend)
              v-icon(color='error') mdi-close
            v-list-item-title {{ $t('common:actions.close') }}
    loader(v-model='dialogProgress', :title='$t(`editor:save.processing`)', :subtitle='$t(`editor:save.pleaseWait`)')
      template(v-slot:illustration)
        login-success-animation
</template>

<script lang='ts'>
import { defineAsyncComponent, defineComponent, type PropType } from 'vue'
import { useHotkey } from 'vuetify'
import { createAsyncComponent } from './common/async-component-state.vue'
import _ from 'lodash'
import { buildOkfMetadataPayload, changePageVisibility, checkPageConflict, createPage, discardCollaborationDraft, fetchPage, updatePage, type PageDetails, type PageWriteInput } from '../helpers/pages-api'
import { wikiStore } from '@/store/index.ts'
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
import type { OfflineDraftPayloadV1, OfflineDraftState } from '../../shared/offline.ts'
import {
  PageBrandingAssignmentSchema,
  PageBrandingViewSchema,
  type PageBrandingAssignment,
  type PageBrandingView
} from '../../shared/page-branding.ts'


const OFFLINE_CREATE_IDENTITY_KEY = 'tsepistle-offline-create-identity'

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
const LoginSuccessAnimation = defineAsyncComponent(() => import('./login-success-animation.vue'))

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
  readonly okf: unknown
}

const freezePageInput = (input: PageWriteInput): PageWriteInput => {
  Object.freeze(input.tags)
  if (input.okfMetadata !== undefined) Object.freeze(input.okfMetadata)
  if (input.branding !== undefined && input.branding !== null) Object.freeze(input.branding)
  return Object.freeze(input) as PageWriteInput
}


export default defineComponent({
  i18nOptions: { namespaces: 'editor' },
  components: {
    StatusIndicator,
    LoginSuccessAnimation,
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
      default: 'Untitled Page'
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
    }
  },
  setup () {
    let saveHandler: (() => void) | null = null
    useHotkey('cmd+s', event => {
      event.preventDefault()
      saveHandler?.()
    })
    return {
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
      dialogProgress: false,
      dialogEditorSelector: false,
      offlineDraftCoordinator: null as OfflineEditorDraftCoordinator | null,
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
      return this.mode !== 'create' && this.pageId > 0 && Boolean(wikiStore.page.okfError) && !wikiStore.page.okfLoading
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
        return 'Server publishing is unavailable while disconnected. Current changes are saved on this device.'
      }
      if (this.offlineDraftError) {
        return 'Server publishing is unavailable while disconnected. Local saving is not currently confirmed.'
      }
      return 'Server publishing is unavailable while disconnected. Local saving will be reported only after this device confirms a commit.'
    },
    serverSaveDisabled(): boolean {
      return wikiStore.user.authenticated && (pwaState.connectionState === 'offline' || pwaState.connectionState === 'server-unavailable')
    },
    offlineDraftStatusText(): string {
      if (this.offlineDraftError) return ''
      if (this.offlineDraftStatus === 'local') return 'Saved on this device. Publishing remains a separate online action.'
      if (this.offlineDraftStatus === 'needs-review') return 'Needs review before publishing.'
      if (this.offlineDraftStatus === 'publishing') return 'Publishing…'
      if (this.offlineDraftStatus === 'conflict') return 'Conflict needs resolution before publishing.'
      if (this.offlineDraftStatus === 'locked') return 'Local draft recovery is locked. Verify this account online, then reload the editor to recover encrypted drafts.'
      if (this.offlineDraftStatus === 'unavailable') return 'The page may have been deleted or access may have been denied. Publishing and replay are blocked; local recovery and deletion remain available.'
      if (!this.offlineDraftCoordinator) return 'Offline draft recovery is unavailable. Reload the editor before saving.'
      if (this.offlineDraftStatus === 'outcome-unknown') return 'Outcome unknown. Review the submission before trying again.'
      return ''
    },
    offlineDraftSource(): readonly string[] {
      return [
        wikiStore.editor.content,
        wikiStore.page.title,
        wikiStore.page.description,
        wikiStore.page.locale,
        wikiStore.page.path,
        wikiStore.editor.editorKey
      ]
    },
    isDirty () {
      return (
        this.savedState.content !== wikiStore.editor.content ||
        this.savedState.locale !== wikiStore.page.locale ||
        this.savedState.path !== wikiStore.page.path ||
        this.savedState.title !== wikiStore.page.title ||
        this.savedState.description !== wikiStore.page.description ||
        !_.isEqual(this.savedState.tags, wikiStore.page.tags) ||
        this.savedState.isPublished !== wikiStore.page.isPublished ||
        this.savedState.isSearchable !== wikiStore.page.isSearchable ||
        this.savedState.visibility !== wikiStore.page.visibility ||
        this.savedState.publishStartDate !== wikiStore.page.publishStartDate ||
        this.savedState.publishEndDate !== wikiStore.page.publishEndDate ||
        this.savedState.scriptCss !== wikiStore.page.scriptCss ||
        this.savedState.scriptJs !== wikiStore.page.scriptJs ||
        !_.isEqual(this.savedState.brandingAssignment, wikiStore.page.brandingAssignment) ||
        !_.isEqual(this.savedState.okf, wikiStore.page.okf)
      )
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
        this.checkoutDateActive,
        this.currentEditor,
        this.activeModal,
        this.isConflict,
        this.isSaving,
        this.offlineDraftBusy,
        this.offlineDraftStatus,
        this.offlineDraftError,
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
    isMetadataDirty(): boolean {
      return (
        this.savedState.locale !== wikiStore.page.locale ||
        this.savedState.path !== wikiStore.page.path ||
        this.savedState.title !== wikiStore.page.title ||
        this.savedState.description !== wikiStore.page.description ||
        !_.isEqual(this.savedState.tags, wikiStore.page.tags) ||
        this.savedState.isPublished !== wikiStore.page.isPublished ||
        this.savedState.isSearchable !== wikiStore.page.isSearchable ||
        this.savedState.visibility !== wikiStore.page.visibility ||
        this.savedState.publishStartDate !== wikiStore.page.publishStartDate ||
        this.savedState.publishEndDate !== wikiStore.page.publishEndDate ||
        this.savedState.scriptCss !== wikiStore.page.scriptCss ||
        this.savedState.scriptJs !== wikiStore.page.scriptJs ||
        !_.isEqual(this.savedState.brandingAssignment, wikiStore.page.brandingAssignment) ||
        !_.isEqual(this.savedState.brandingView, wikiStore.page.brandingView) ||
        !_.isEqual(this.savedState.okf, wikiStore.page.okf)
      )
    },
    notifySafetyChanged() {
      this.safetyRevision += 1
      notifyReloadSafetyChanged()
    },
    offlineMutationBlockMessage(): string {
      if (this.offlineDraftStatus === 'locked') {
        return this.offlineDraftError || 'Offline draft recovery is locked. Verify this account online, then reload the editor before saving.'
      }
      if (this.offlineDraftStatus === 'unavailable') {
        return 'Publishing is unavailable because the page may have been deleted or access may have been denied. Local recovery and deletion remain available.'
      }
      if (!this.offlineDraftCoordinator) return 'Offline draft recovery is unavailable. Reload the editor before saving.'
      return 'Offline editor recovery is not ready. Reload the editor before saving.'
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
        throw new Error('Your account session changed while saving. Retry with the current account.')
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
      if (adapter && !this.editorAdapterSafety.ready) throw new Error('The editor is still initializing. Retry in a moment.')
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
      const coordinator = new OfflineEditorDraftCoordinator({
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
        detachedClear: () => this.editorAdapter?.clear(),
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
        onSafetyChange: () => this.notifySafetyChanged()
      })
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
    async discardOfflineDraft(recordId?: string) {
      if (this.offlineDraftBusy || !this.offlineDraftCoordinator) return
      this.offlineDraftBusy = true
      try {
        await this.offlineDraftCoordinator.clearDetachedCandidate(recordId)
      } finally {
        this.offlineDraftBusy = false
        this.notifySafetyChanged()
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
        const page = await fetchPage(window.fetch.bind(window), candidate.payload.pageId, 'The authoritative page could not be checked.')
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
      this.offlineDraftBusy = true
      try {
        if (await this.offlineDraftCoordinator.clearDetachedCandidate(recordId)) {
          if (this.offlineReconcilePrompt?.recordId === recordId) this.offlineReconcilePrompt = null
          if (this.mode === 'create' && this.offlineSubmissionCandidates.length <= 1) clearOfflineCreateIdentity()
        }
      } finally {
        this.offlineDraftBusy = false
        this.notifySafetyChanged()
      }
    },
    async resolveOfflineSubmission(resolution: 'discard' | 'continue') {
      const prompt = this.offlineReconcilePrompt
      if (!prompt || this.offlineDraftBusy || !this.offlineDraftCoordinator) return
      const candidate = this.offlineSubmissionCandidates.find(item => item.submission.recordId === prompt.recordId)
      if (!candidate) return
      this.offlineDraftBusy = true
      try {
        const resolved = resolution === 'discard'
          ? await this.offlineDraftCoordinator.clearDetachedCandidate(prompt.recordId)
          : await this.offlineDraftCoordinator.replaceDetachedCandidate(candidate.payload, prompt.recordId)
        if (resolved) {
          this.offlineReconcilePrompt = null
          if (resolution === 'discard' && prompt.kind === 'create') clearOfflineCreateIdentity()
        }
      } finally {
        this.offlineDraftBusy = false
        this.notifySafetyChanged()
      }
    },
    handleOfflineSessionInvalidated() {
      this.lifecycleGeneration += 1
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
      wikiStore.page.brandingView = null
      this.offlineDraftStatus = 'locked'
      this.offlineDraftError = 'Your offline editor session was locked. Unsaved plaintext was cleared. Verify this account online, then reload the editor to recover any encrypted draft.'
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
      this.offlineDraftError = 'Your offline editor session was locked. Unsaved plaintext was cleared.'
      this.offlineDraftBusy = false
      this.dialogUnsaved = false
      this.dialogProgress = false
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
    showProgressDialog() {
      this.dialogProgress = true
    },
    hideProgressDialog() {
      this.dialogProgress = false
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
    async hydratePage() {
      if (this.mode === 'create' || this.pageId <= 0 || wikiStore.page.okfLoading) return
      const lifecycleGeneration = this.lifecycleGeneration
      const expectedPageId = this.pageId
      const coordinator = this.offlineDraftCoordinator
      const expectedAccountId = this.accountId
      const expectedAuthenticated = this.isAuthenticated
      const expectedOfflineIdentityEpoch = wikiStore.offlineIdentityEpoch
      const expectedBrandingAssignment = _.cloneDeep(wikiStore.page.brandingAssignment)
      wikiStore.page.okfLoading = true
      wikiStore.page.okfError = null
      try {
        if (!this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration)) return
        const page = await fetchPage(window.fetch.bind(window), expectedPageId, this.$t('common:error.unexpected'))
        if (
          this.lifecycleGeneration !== lifecycleGeneration ||
          this.offlineDraftCoordinator !== coordinator ||
          this.pageId !== expectedPageId ||
          !this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration) ||
          this.mode === 'create' ||
          this.isDirty
        )
          return
        this.applyHydratedBranding(page, expectedBrandingAssignment)
        wikiStore.page.okf = page.okf
        wikiStore.page.sourceRevision = page.sourceRevision
        wikiStore.page.isSearchable = page.isSearchable !== false
        this.setCurrentSavedState()
      } catch (err) {
        if (
          this.lifecycleGeneration === lifecycleGeneration &&
          this.offlineDraftCoordinator === coordinator &&
          this.pageId === expectedPageId &&
          this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration)
        )
          wikiStore.page.okfError = getErrorMessage(err)
      } finally {
        if (this.lifecycleGeneration === lifecycleGeneration && this.pageId === expectedPageId && this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration)) wikiStore.page.okfLoading = false
      }
    },
    async refreshOkfAfterSave(expectedBrandingAssignment: PageBrandingAssignment | null = wikiStore.page.brandingAssignment) {
      const lifecycleGeneration = this.lifecycleGeneration
      const expectedPageId = this.pageId
      const coordinator = this.offlineDraftCoordinator
      const expectedAccountId = this.accountId
      const expectedAuthenticated = this.isAuthenticated
      const expectedOfflineIdentityEpoch = wikiStore.offlineIdentityEpoch
      wikiStore.page.okfLoading = true
      wikiStore.page.okfError = null
      try {
        if (!this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration)) return
        const page = await fetchPage(window.fetch.bind(window), expectedPageId, this.$t('common:error.unexpected'))
        if (
          this.lifecycleGeneration !== lifecycleGeneration ||
          this.offlineDraftCoordinator !== coordinator ||
          this.pageId !== expectedPageId ||
          !this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration)
        )
          return
        this.applyHydratedBranding(page, expectedBrandingAssignment)
        wikiStore.page.okf = page.okf
        wikiStore.page.isSearchable = page.isSearchable !== false
        wikiStore.page.sourceRevision = page.sourceRevision
      } catch (err) {
        if (
          this.lifecycleGeneration === lifecycleGeneration &&
          this.offlineDraftCoordinator === coordinator &&
          this.pageId === expectedPageId &&
          this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration)
        )
          wikiStore.page.okfError = getErrorMessage(err)
        throw err
      } finally {
        if (this.lifecycleGeneration === lifecycleGeneration && this.pageId === expectedPageId && this.isCurrentActorSession(expectedAuthenticated, expectedAccountId, expectedOfflineIdentityEpoch, lifecycleGeneration)) wikiStore.page.okfLoading = false
      }
    },
    async refreshConflict() {
      if (this.mode === 'create' || this.isSaving || !this.isDirty || this.conflictCheckPending) return
      const lifecycleGeneration = this.lifecycleGeneration
      const expectedPageId = this.pageId
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
          this.pageId === expectedPageId &&
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
      this.showProgressDialog()
      let prepared: PreparedOfflineSubmission | null = null
      let completionAttempted = false
      let postWriteError: string | null = null
      let receiptPreparationWarning: string | null = null
      const routeChanged = saveMode === 'update' && (
        capture.locale !== this.savedState.locale ||
        capture.path !== this.savedState.path ||
        capture.visibility !== this.savedState.visibility
      )

      try {
        if (this.serverSaveDisabled && coordinator?.isAuthenticatedUser() === true) {
          this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
          if (!(await coordinator.captureThrough(capture.editVersion))) {
            throw new Error('Your changes could not be saved on this device.')
          }
          this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
          if (coordinator.hasCommittedCurrentValues) {
            this.editorAdapter?.markPersisted?.(capture.editVersion)
          }
          wikiStore.showNotification({
            message: 'Saved on this device. Reconnect to review and publish.',
            style: 'success',
            icon: 'check'
          })
          return true
        }

        this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
        const authOutcome = await wikiStore.waitForAuthRefresh()
        this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
        if (capturedAuthenticated !== this.isAuthenticated || capturedAccountId !== this.accountId) {
          throw new Error('Your account session changed while saving. Retry with the current account.')
        }

        const verifiedForNetwork = !capturedAuthenticated || (
          authOutcome === 'authenticated' &&
          wikiStore.authRefreshSettled &&
          !wikiStore.authRefreshPending &&
          wikiStore.offlineIdentityReady
        )
        if (!verifiedForNetwork) {
          throw new Error('Your account session could not establish a safe local draft boundary. Retry while online.')
        }
        if (saveMode !== (this.mode === 'create' ? 'create' : 'update')) {
          throw new Error('The editor changed pages while saving. Retry the save.')
        }
        if (capturedAuthenticated && this.serverSaveDisabled) {
          throw new Error('Server publishing is unavailable while disconnected.')
        }

        if (saveMode === 'update') {
          const expectedSourceRevision = capture.identity.baseSourceRevision
          if (!expectedSourceRevision) throw new Error('The page revision is unavailable. Reload before saving.')
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
              receiptPreparationWarning = 'Local recovery receipt could not be committed; this online save is not available for offline recovery.'
            } else if (receiptPreparationError instanceof Error) {
              throw receiptPreparationError
            } else {
              throw new Error('The page was not submitted because the encrypted draft receipt could not be committed.')
            }
          }
        }
        if (capturedAuthenticated && this.serverSaveDisabled) {
          throw new Error('Server publishing is unavailable while disconnected.')
        }

        if (saveMode === 'create') {
          this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
          const page = await createPage(window.fetch.bind(window), capture.pageInput)
          this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
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
            } catch (error) {
              this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
              postWriteError = getErrorMessage(error)
            }
          }
          try {
            await this.refreshOkfAfterSave(capture.brandingAssignment)
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
            throw new Error('The page was saved, but local submission finalization needs attention.')
          }
        }

        this.assertCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)
        const currentSnapshot = this.isCurrentSaveSnapshot(capture)
        if (currentSnapshot) {
          this.setCurrentSavedState()
          this.markSaveSnapshotPersisted(capture)
        }

        const saveMessage = receiptPreparationWarning
          ? `${saveMode === 'create' ? this.$t('editor:save.createSuccess') : this.$t('editor:save.updateSuccess')}; ${receiptPreparationWarning}`
          : postWriteError
            ? `Page saved, but ${postWriteError}`
            : (saveMode === 'create' ? this.$t('editor:save.createSuccess') : this.$t('editor:save.updateSuccess'))
        wikiStore.showNotification({
          message: saveMessage,
          style: postWriteError || receiptPreparationWarning ? 'warning' : 'success',
          icon: postWriteError || receiptPreparationWarning ? 'warning' : 'check'
        })

        const canNavigateAfterSave = (): boolean => {
          const safety = coordinator?.reloadSafetySnapshot
          return (
            this.isCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration) &&
            !receiptPreparationWarning &&
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
        } else if (routeChanged) {
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
        return true
      } catch (error) {
        if (!this.isCurrentActorSession(capturedAuthenticated, capturedAccountId, capturedOfflineIdentityEpoch, capturedLifecycleGeneration)) {
          const staleError = new Error('Your account session changed while saving. Retry with the current account.')
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
          const unavailableMessage = 'Publishing is unavailable because the page may have been deleted or access may have been denied. Local recovery and deletion remain available.'
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
              ? 'Publishing is unavailable because the page may have been deleted or access may have been denied, but the local draft could not be retained.'
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
        if (rethrow) throw error
        return false
      } finally {
        this.isSaving = false
        this.hideProgressDialog()
        this.notifySafetyChanged()
      }
    },
    async saveAndClose(): Promise<boolean> {
      if (this.isSaving) return false
      const capturedAuthenticated = this.isAuthenticated
      const capturedAccountId = this.accountId
      const capturedOfflineIdentityEpoch = wikiStore.offlineIdentityEpoch
      const capturedLifecycleGeneration = this.lifecycleGeneration
      const wasCreate = wikiStore.editor.mode === 'create'
      try {
        await this.save({ rethrow: true })
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
      if (this.isDirty) {
        this.dialogUnsaved = true
      } else {
        this.exitGo()
      }
    },
    async discardAndExit() {
      if (this.discardPending) return
      this.discardPending = true
      try {
        if (wikiStore.editor.mode === 'update' && wikiStore.editor.editorKey === 'markdown' && this.collaborationActive) {
          await discardCollaborationDraft(
            window.fetch.bind(window),
            wikiStore.page.id,
            this.checkoutDateActive,
            wikiStore.page.sourceRevision
          )
        }
        if (this.offlineDraftCoordinator?.isAuthenticatedUser() === true) {
          if (!(await this.offlineDraftCoordinator.discardCurrentDraft())) {
            throw new Error('The local draft could not be discarded.')
          }
        }
        this.restoreCurrentSavedState()
        this.dialogUnsaved = false
        this.exitGo()
      } catch (error) {
        this.dialogUnsaved = true
        wikiStore.showNotification({
          message: getErrorMessage(error),
          style: 'error',
          icon: 'warning'
        })
      } finally {
        this.discardPending = false
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
      if (this.isCurrentSaveSnapshot(capture)) this.editorAdapter?.markPersisted?.(capture.editVersion)
    },
    getPageInput(content = wikiStore.editor.content): PageWriteInput {
      const okfMetadata = buildOkfMetadataPayload(wikiStore.page.okf.authority.metadata)
      const rawBrandingAssignment = wikiStore.page.brandingAssignment
      let brandingAssignment: PageBrandingAssignment | null = null
      if (rawBrandingAssignment !== null) {
        const brandingResult = PageBrandingAssignmentSchema.safeParse(rawBrandingAssignment)
        if (!brandingResult.success) throw new Error('Page branding assignment is invalid.')
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
        ...brandingInput,
        ...(okfMetadata === undefined ? {} : { okfMetadata: _.cloneDeep(okfMetadata) })
      }
      return freezePageInput(pageInput)
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

  .editor-bootstrap-notice {
    flex: none;
    margin: var(--wiki-space-4) clamp(var(--wiki-space-4), 4vw, var(--wiki-space-8)) 0;
  }

  .editor-main-surface > :last-child {
    min-width: 0;
    flex: 1 1 auto;
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
      color: var(--wiki-accent-warm);
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

@media (forced-colors: active) {
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
