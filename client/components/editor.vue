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
          :disabled='collaborationDiscarded'
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
          @click='saveAndClose'
          :disabled='collaborationDiscarded'
        )
          v-icon(start) mdi-content-save-move-outline
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
      component(:is='currentEditor', :save='save', @collaboration-state='handleCollaborationState')
      editor-modal-properties(v-if='dialogProps', v-model='dialogProps')
      editor-modal-editorselect(v-if='dialogEditorSelector', v-model='dialogEditorSelector')
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
        :disabled='collaborationDiscarded'
        :aria-label='mode === `create` ? $t(`common:actions.create`) : (isDirty ? $t(`common:actions.save`) : $t(`editor:save.saved`))'
      )
        v-icon mdi-check
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
          v-list-item(:disabled='collaborationDiscarded', @click='saveAndClose')
            template(v-slot:prepend)
              v-icon(color='primary') mdi-content-save-move-outline
            v-list-item-title Save and close
          v-list-item(v-if='!welcomeMode', @click='exit')
            template(v-slot:prepend)
              v-icon(color='error') mdi-close
            v-list-item-title {{ $t('common:actions.close') }}
    loader(v-model='dialogProgress', :title='$t(`editor:save.processing`)', :subtitle='$t(`editor:save.pleaseWait`)')
    notify
</template>

<script lang='ts'>
import { defineComponent, type PropType } from 'vue'
import { useHotkey } from 'vuetify'
import _ from 'lodash'
import { buildOkfMetadataPayload, changePageVisibility, checkPageConflict, createPage, discardCollaborationDraft, fetchPage, updatePage } from '../helpers/pages-api'
import { wikiStore } from '@/store/index.ts'
import { Base64 } from 'js-base64'
import StatusIndicator from '@/components/common/status-indicator.vue'
import { emitEditorSaveConflict, onEditorConflictReset, offEditorConflictReset } from '../helpers/editor-conflict-events'
import { getErrorMessage } from '../helpers/root-ui-store'
import { decodeBase64Json } from '../helpers/base64'
import { getEditorComponentName } from '../helpers/editor-key.ts'
import { normalizeAvailableEditors } from '../../shared/page-editors.ts'
import { createAsyncComponent } from './common/async-component-state.vue'

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
    effectivePermissions: {
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
      dialogProps: false,
      dialogProgress: false,
      dialogEditorSelector: false,
      dialogUnsaved: false,
      exitConfirmed: false,
      savedState: {
        content: '',
        description: '',
        isPublished: false,
        visibility: 'public' as 'public' | 'private',
        locale: 'en',
        path: '',
        publishEndDate: '',
        publishStartDate: '',
        tags: [] as string[],
        title: '',
        scriptCss: '',
        scriptJs: '',
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
    isDirty () {
      return (
        this.savedState.content !== wikiStore.editor.content ||
        this.savedState.locale !== wikiStore.page.locale ||
        this.savedState.path !== wikiStore.page.path ||
        this.savedState.title !== wikiStore.page.title ||
        this.savedState.description !== wikiStore.page.description ||
        !_.isEqual(this.savedState.tags, wikiStore.page.tags) ||
        this.savedState.isPublished !== wikiStore.page.isPublished ||
        this.savedState.visibility !== wikiStore.page.visibility ||
        this.savedState.publishStartDate !== wikiStore.page.publishStartDate ||
        this.savedState.publishEndDate !== wikiStore.page.publishEndDate ||
        this.savedState.scriptCss !== wikiStore.page.scriptCss ||
        this.savedState.scriptJs !== wikiStore.page.scriptJs ||
        !_.isEqual(this.savedState.okf, wikiStore.page.okf)
      )
    }
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
    }
  },
  created() {
    this.setSaveHotkeyHandler(() => {
      void this.save()
    })
    wikiStore.page.id = this.pageId
    wikiStore.page.description = this.description
    wikiStore.page.isPublished = this.isPublished
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

    window.addEventListener('beforeunload', this.handleBeforeUnload)
    if (this.mode !== 'create' && this.pageId > 0) {
      void this.hydratePage()
    }

    onEditorConflictReset(this.handleEditorConflictReset)
    this.conflictTimer = window.setInterval(this.refreshConflict, 5000)
    this.injectCustomCss(this.currentStyling)

  },
  beforeUnmount() {
    this.setSaveHotkeyHandler(null)
    offEditorConflictReset(this.handleEditorConflictReset)
    if (this.conflictTimer !== null) window.clearInterval(this.conflictTimer)
    if (this.customCssTimer !== null) window.clearTimeout(this.customCssTimer)
    if (this.modalTimer !== null) window.clearTimeout(this.modalTimer)
    if (this.navigationTimer !== null) window.clearTimeout(this.navigationTimer)
    window.removeEventListener('beforeunload', this.handleBeforeUnload)
    removeEditorPageCss()
  },
  methods: {
    handleCollaborationState(state: { active: boolean, discarded: boolean, generation: number | null }) {
      if (this.collaborationDiscarded) return
      this.collaborationActive = state.active
      this.collaborationDiscarded = state.discarded
      this.collaborationGeneration = state.generation
    },
    handleBeforeUnload(event: BeforeUnloadEvent) {
      if (!this.exitConfirmed && this.isDirty) {
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
    async hydratePage() {
      if (this.mode === 'create' || this.pageId <= 0 || wikiStore.page.okfLoading) return
      wikiStore.page.okfLoading = true
      wikiStore.page.okfError = null
      try {
        const page = await fetchPage(window.fetch.bind(window), this.pageId, this.$t('common:error.unexpected'))
        if (this.isDirty) return
        wikiStore.page.okf = page.okf
        wikiStore.page.sourceRevision = page.sourceRevision
        this.setCurrentSavedState()
      } catch (err) {
        wikiStore.page.okfError = getErrorMessage(err)
      } finally {
        wikiStore.page.okfLoading = false
      }
    },
    async refreshOkfAfterSave() {
      wikiStore.page.okfLoading = true
      wikiStore.page.okfError = null
      try {
        const page = await fetchPage(window.fetch.bind(window), this.pageId, this.$t('common:error.unexpected'))
        wikiStore.page.okf = page.okf
        wikiStore.page.sourceRevision = page.sourceRevision
      } catch (err) {
        wikiStore.page.okfError = getErrorMessage(err)
        throw err
      } finally {
        wikiStore.page.okfLoading = false
      }
    },
    async refreshConflict() {
      if (this.mode === 'create' || this.isSaving || !this.isDirty || this.conflictCheckPending) return
      this.conflictCheckPending = true
      try {
        this.isConflict = await checkPageConflict(window.fetch.bind(window), this.pageId, this.checkoutDateActive)
      } catch (err) {
        console.warn(err)
      } finally {
        this.conflictCheckPending = false
      }
    },
    openConflict() {
      emitEditorSaveConflict()
    },
    async save({ rethrow = false, overwrite = false }: { rethrow?: boolean, overwrite?: boolean } = {}) {
      if (this.collaborationDiscarded) {
        const error = new Error('This collaboration draft was discarded. Reload the page before saving.')
        wikiStore.showNotification({
          message: error.message,
          style: 'error',
          icon: 'warning'
        })
        if (rethrow) throw error
        return
      }
      if (this.mode !== 'create' && !this.isDirty) return
      if (this.isSaving) return
      this.showProgressDialog()
      this.isSaving = true

      try {
        const pageInput = this.getPageInput()
        if (wikiStore.editor.mode === 'create') {
          // --------------------------------------------
          // -> CREATE PAGE
          // --------------------------------------------

          const page = await createPage(window.fetch.bind(window), pageInput)
          this.checkoutDateActive = page.updatedAt || this.checkoutDateActive
          this.isConflict = false
          wikiStore.showNotification({
            message: this.$t('editor:save.createSuccess'),
            style: 'success',
            icon: 'check'
          })
          wikiStore.editor.id = page.id
          wikiStore.editor.mode = 'update'
          this.exitConfirmed = true
          window.location.assign(wikiStore.page.visibility === 'private'
            ? `/_private/${wikiStore.page.locale}/${wikiStore.page.path}`
            : `/${wikiStore.page.locale}/${wikiStore.page.path}`)
        } else {
          // --------------------------------------------
          // -> UPDATE EXISTING PAGE
          // --------------------------------------------

          if (!overwrite && await checkPageConflict(window.fetch.bind(window), this.pageId, this.checkoutDateActive)) {
            emitEditorSaveConflict()
            throw new Error(this.$t('editor:conflict.warning'))
          }

          const page = await updatePage(
            window.fetch.bind(window),
            wikiStore.page.id,
            pageInput,
            wikiStore.page.sourceRevision,
            this.collaborationActive ? this.collaborationGeneration ?? undefined : undefined
          )
          wikiStore.page.sourceRevision = page.sourceRevision
          if (this.savedState.visibility !== wikiStore.page.visibility) {
            const visibilityPage = await changePageVisibility(
              window.fetch.bind(window),
              wikiStore.page.id,
              wikiStore.page.visibility,
              wikiStore.page.sourceRevision,
              wikiStore.page.visibility === 'public'
            )
            wikiStore.page.sourceRevision = visibilityPage.sourceRevision
          }
          await this.refreshOkfAfterSave()
          this.checkoutDateActive = page.updatedAt || this.checkoutDateActive
          this.isConflict = false
          wikiStore.showNotification({
            message: this.$t('editor:save.updateSuccess'),
            style: 'success',
            icon: 'check'
          })
          if (
            this.savedState.locale !== wikiStore.page.locale ||
            this.savedState.path !== wikiStore.page.path ||
            this.savedState.visibility !== wikiStore.page.visibility
          ) {
            if (this.navigationTimer !== null) window.clearTimeout(this.navigationTimer)
            this.navigationTimer = window.setTimeout(() => {
              const scope = wikiStore.page.visibility === 'private' ? '/_private' : ''
              window.location.replace(`/e${scope}/${wikiStore.page.locale}/${wikiStore.page.path}`)
              this.navigationTimer = null
            }, 1000)
          }
        }

        this.setCurrentSavedState()
      } catch (err) {
        const message = getErrorMessage(err)
        if (this.collaborationActive && message === 'This collaboration draft was discarded. Reload the page before saving.') {
          this.handleCollaborationState({ active: false, discarded: true, generation: null })
        }
        wikiStore.showNotification({
          message,
          style: 'error',
          icon: 'warning'
        })
        if (rethrow === true) {
          this.isSaving = false
          this.hideProgressDialog()
          throw err
        }
      }
      this.isSaving = false
      this.hideProgressDialog()
    },
    async saveAndClose(): Promise<boolean> {
      if (this.isSaving) return false
      const wasCreate = wikiStore.editor.mode === 'create'
      try {
        await this.save({ rethrow: true })
        if (!wasCreate) {
          await this.exit()
        }
        return true
      } catch (err) {
        // Error is already handled
        return false
      }
    },
    async saveUnsavedAndClose() {
      if (await this.saveAndClose()) {
        this.dialogUnsaved = false
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
    getPageInput () {
      const okfMetadata = buildOkfMetadataPayload(wikiStore.page.okf.authority.metadata)
      return {
        content: wikiStore.editor.content,
        description: wikiStore.page.description,
        editor: wikiStore.editor.editorKey,
        locale: wikiStore.page.locale,
        visibility: wikiStore.page.visibility,
        isPublished: wikiStore.page.isPublished,
        path: wikiStore.page.path,
        publishEndDate: wikiStore.page.publishEndDate || '',
        publishStartDate: wikiStore.page.publishStartDate || '',
        scriptCss: wikiStore.page.scriptCss,
        scriptJs: wikiStore.page.scriptJs,
        tags: wikiStore.page.tags,
        title: wikiStore.page.title,
        ...(okfMetadata === undefined ? {} : { okfMetadata })
      }
    },
    setCurrentSavedState () {
      this.savedState = {
        content: wikiStore.editor.content,
        description: wikiStore.page.description,
        isPublished: wikiStore.page.isPublished,
        visibility: wikiStore.page.visibility,
        locale: wikiStore.page.locale,
        path: wikiStore.page.path,
        publishEndDate: wikiStore.page.publishEndDate || '',
        publishStartDate: wikiStore.page.publishStartDate || '',
        tags: [...wikiStore.page.tags],
        title: wikiStore.page.title,
        scriptCss: wikiStore.page.scriptCss,
        scriptJs: wikiStore.page.scriptJs,
        okf: _.cloneDeep(wikiStore.page.okf)
      }
    },
    restoreCurrentSavedState () {
      wikiStore.editor.content = this.savedState.content
      wikiStore.page.description = this.savedState.description
      wikiStore.page.isPublished = this.savedState.isPublished
      wikiStore.page.visibility = this.savedState.visibility
      wikiStore.page.locale = this.savedState.locale
      wikiStore.page.path = this.savedState.path
      wikiStore.page.publishEndDate = this.savedState.publishEndDate
      wikiStore.page.publishStartDate = this.savedState.publishStartDate
      wikiStore.page.tags = [...this.savedState.tags]
      wikiStore.page.title = this.savedState.title
      wikiStore.page.scriptCss = this.savedState.scriptCss
      wikiStore.page.scriptJs = this.savedState.scriptJs
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
