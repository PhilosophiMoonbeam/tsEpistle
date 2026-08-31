<template lang="pug">
  v-app.editor
    nav-header(dense)
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
          @click.exact='save'
          @click.ctrl.exact='saveAndClose'
          :class='{ "is-icon": $vuetify.display.mdAndDown }'
          :aria-label='mode === `create` ? $t(`common:actions.create`) : (isDirty ? $t(`common:actions.save`) : $t(`editor:save.saved`))'
          )
          v-icon(:start='$vuetify.display.lgAndUp') mdi-check
          span.text-medium-emphasis(v-if='$vuetify.display.lgAndUp && mode !== `create` && !isDirty') {{ $t('editor:save.saved') }}
          span(v-else-if='$vuetify.display.lgAndUp') {{ mode === 'create' ? $t('common:actions.create') : $t('common:actions.save') }}
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
      component(:is='currentEditor', :save='save')
      editor-modal-properties(v-model='dialogProps')
      editor-modal-editorselect(v-model='dialogEditorSelector')
      editor-modal-unsaved(v-model='dialogUnsaved', @discard='exitGo')
      component(:is='activeModal')

    v-bottom-navigation.editor-mobile-actions(
      v-if='$vuetify.display.smAndDown'
      grow
      :elevation='0'
    )
      v-btn(
        color='primary'
        @click.exact='save'
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
          v-list-item(@click='saveAndClose')
            template(v-slot:prepend)
              v-icon(color='primary') mdi-content-save-move-outline
            v-list-item-title Save and close
          v-list-item(v-if='!welcomeMode', @click='exit')
            template(v-slot:prepend)
              v-icon(color='error') mdi-close
            v-list-item-title {{ $t('common:actions.close') }}
    loader(v-model='dialogProgress', :title='$t(`editor:save.processing`)', :subtitle='$t(`editor:save.pleaseWait`)')
    notify</template>

<script lang='ts'>
import { defineAsyncComponent, defineComponent, type PropType } from 'vue'
import _ from 'lodash'
import { buildOkfMetadataPayload, changePageVisibility, checkPageConflict, createPage, fetchPage, updatePage, validateOkfMetadataPayload, type OkfMetadataPayloadValidation } from '../helpers/pages-api'
import { wikiStore } from '@/store/index.ts'
import { AtomSpinner } from 'epic-spinners'
import { Base64 } from 'js-base64'
import StatusIndicator from '@/components/common/status-indicator.vue'
import { emitEditorSaveConflict, onEditorConflictReset, offEditorConflictReset } from '../helpers/editor-conflict-events'
import { getErrorMessage } from '../helpers/root-ui-store'
import { decodeBase64Json } from '../helpers/base64'
import { getEditorComponentName } from '../helpers/editor-key.ts'
import { normalizeAvailableEditors } from '../../shared/page-editors.ts'


export default defineComponent({
  i18nOptions: { namespaces: 'editor' },
  components: {
    AtomSpinner,
    StatusIndicator,
    editorApi: defineAsyncComponent(() => import('./editor/editor-api.vue')),
    editorCode: defineAsyncComponent(() => import('./editor/editor-code.vue')),
    editorCkeditor: defineAsyncComponent(() => import('./editor/editor-ckeditor.vue')),
    editorVisualMarkdown: defineAsyncComponent(() => import('./editor/editor-visual-markdown.vue')),
    editorAsciidoc: defineAsyncComponent(() => import('./editor/editor-asciidoc.vue')),
    editorMarkdown: defineAsyncComponent(() => import('./editor/editor-markdown.vue')),
    editorRedirect: defineAsyncComponent(() => import('./editor/editor-redirect.vue')),
    editorModalEditorselect: defineAsyncComponent(() => import('./editor/editor-modal-editorselect.vue')),
    editorModalProperties: defineAsyncComponent(() => import('./editor/editor-modal-properties.vue')),
    editorModalUnsaved: defineAsyncComponent(() => import('./editor/editor-modal-unsaved.vue')),
    editorModalMedia: defineAsyncComponent(() => import('./editor/editor-modal-media.vue')),
    editorModalBlocks: defineAsyncComponent(() => import('./editor/editor-modal-blocks.vue')),
    editorModalConflict: defineAsyncComponent(() => import('./editor/editor-modal-conflict.vue')),
    editorModalDrawio: defineAsyncComponent(() => import('./editor/editor-modal-drawio.vue'))
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
      default: new Date().toISOString()
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
  data() {
    return {
      isSaving: false,
      isConflict: false,
      conflictTimer: null as number | null,
      dialogProps: false,
      dialogProgress: false,
      dialogEditorSelector: false,
      dialogUnsaved: false,
      exitConfirmed: false,
      initContentParsed: '',
      savedState: {
        description: '',
        isPublished: false,
        visibility: 'public' as 'public' | 'private',
        publishEndDate: '',
        publishStartDate: '',
        tags: [] as string[],
        title: '',
        css: '',
        js: '',
        okfMetadata: { valid: true, payload: undefined } as OkfMetadataPayloadValidation
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
      return _.some([
        this.initContentParsed !== wikiStore.editor.content,
        this.locale !== wikiStore.page.locale,
        this.path !== wikiStore.page.path,
        this.savedState.title !== wikiStore.page.title,
        this.savedState.description !== wikiStore.page.description,
        !_.isEqual(this.savedState.tags, wikiStore.page.tags),
        this.savedState.isPublished !== wikiStore.page.isPublished,
        this.savedState.visibility !== wikiStore.page.visibility,
        this.savedState.publishStartDate !== wikiStore.page.publishStartDate,
        this.savedState.publishEndDate !== wikiStore.page.publishEndDate,
        this.savedState.css !== wikiStore.page.scriptCss,
        this.savedState.js !== wikiStore.page.scriptJs,
        !_.isEqual(this.savedState.okfMetadata, validateOkfMetadataPayload(wikiStore.page.okf.authority.metadata))
      ], Boolean)
    }
  },
  watch: {
    currentEditor(newValue: string) {
      if (newValue !== '' && this.mode === 'create') {
        _.delay(() => {
          this.dialogProps = true
        }, 500)
      }
    },
    currentStyling(newValue: string) {
      this.injectCustomCss(newValue)
    }
  },
  created() {
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

    this.setCurrentSavedState()

    this.checkoutDateActive = this.checkoutDate

    if (this.effectivePermissions) {
      wikiStore.page.effectivePermissions = decodeBase64Json(this.effectivePermissions)
    }
  },
  mounted() {
    wikiStore.editor.mode = this.initMode || 'create'

    this.initContentParsed = this.initContent ? Base64.decode(this.initContent) : ''
    wikiStore.editor.content = this.initContentParsed
    if (this.mode === 'create' && !this.initEditor) {
      const availableEditors = normalizeAvailableEditors(siteConfig.availableEditors)
      if (availableEditors.length === 1) {
        this.currentEditor = getEditorComponentName(availableEditors[0])
      } else {
        _.delay(() => {
          this.dialogEditorSelector = true
        }, 500)
      }
    } else {
      this.currentEditor = getEditorComponentName(this.initEditor || 'markdown')
    }

    window.onbeforeunload = () => {
      if (!this.exitConfirmed && this.initContentParsed !== wikiStore.editor.content) {
        return this.$t('editor:unsavedWarning')
      } else {
        return undefined
      }
    }
    if (this.mode !== 'create' && this.pageId > 0) {
      void this.hydratePage()
    }

    onEditorConflictReset(this.handleEditorConflictReset)
    this.conflictTimer = window.setInterval(this.refreshConflict, 5000)

  },
  beforeUnmount() {
    offEditorConflictReset(this.handleEditorConflictReset)
    if (this.conflictTimer !== null) window.clearInterval(this.conflictTimer)
  },
  methods: {
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
      if (this.mode === 'create' || this.isSaving || !this.isDirty) return
      try {
        this.isConflict = await checkPageConflict(window.fetch.bind(window), this.pageId, this.checkoutDateActive)
      } catch (err) {
        console.warn(err)
      }
    },
    openConflict() {
      emitEditorSaveConflict()
    },
    async save({ rethrow = false, overwrite = false }: { rethrow?: boolean, overwrite?: boolean } = {}) {
      if (this.isSaving) return
      this.showProgressDialog()
      this.isSaving = true

      const saveTimeoutHandle = window.setTimeout(() => {
        throw new Error('Save operation timed out.')
      }, 30000)

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

          if (await checkPageConflict(window.fetch.bind(window), this.pageId, this.checkoutDateActive)) {
            emitEditorSaveConflict()
            throw new Error(this.$t('editor:conflict.warning'))
          }

          const page = await updatePage(
            window.fetch.bind(window),
            wikiStore.page.id,
            pageInput,
            wikiStore.page.sourceRevision
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
            this.locale !== wikiStore.page.locale ||
            this.path !== wikiStore.page.path ||
            this.savedState.visibility !== wikiStore.page.visibility
          ) {
            _.delay(() => {
              const scope = wikiStore.page.visibility === 'private' ? '/_private' : ''
              window.location.replace(`/e${scope}/${wikiStore.page.locale}/${wikiStore.page.path}`)
            }, 1000)
          }
        }

        this.initContentParsed = wikiStore.editor.content
        this.setCurrentSavedState()
      } catch (err) {
        wikiStore.showNotification({
          message: getErrorMessage(err),
          style: 'error',
          icon: 'warning'
        })
        if (rethrow === true) {
          clearTimeout(saveTimeoutHandle)
          this.isSaving = false
          this.hideProgressDialog()
          throw err
        }
      }
      clearTimeout(saveTimeoutHandle)
      this.isSaving = false
      this.hideProgressDialog()
    },
    async saveAndClose() {
      try {
        if (wikiStore.editor.mode === 'create') {
          await this.save()
        } else {
          await this.save({ rethrow: true })
          await this.exit()
        }
      } catch (err) {
        // Error is already handled
      }
    },
    async exit() {
      if (this.isDirty) {
        this.dialogUnsaved = true
      } else {
        this.exitGo()
      }
    },
    exitGo() {
      wikiStore.startLoading('editor-close')
      this.currentEditor = ''
      this.exitConfirmed = true
      _.delay(() => {
        if (wikiStore.editor.mode === 'create') {
          window.location.assign(`/`)
        } else {
          const scope = wikiStore.page.visibility === 'private' ? '/_private' : ''
          window.location.assign(`${scope}/${wikiStore.page.locale}/${wikiStore.page.path}`)
        }
      }, 500)
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
        description: wikiStore.page.description,
        isPublished: wikiStore.page.isPublished,
        visibility: wikiStore.page.visibility,
        publishEndDate: wikiStore.page.publishEndDate || '',
        publishStartDate: wikiStore.page.publishStartDate || '',
        tags: [...wikiStore.page.tags],
        title: wikiStore.page.title,
        css: wikiStore.page.scriptCss,
        js: wikiStore.page.scriptJs,
        okfMetadata: _.cloneDeep(validateOkfMetadataPayload(wikiStore.page.okf.authority.metadata))
      }
    },
    injectCustomCss: _.debounce((css: string) => {
      const oldStyl = document.querySelector('#editor-script-css')
      if (oldStyl) {
        document.head.removeChild(oldStyl)
      }
      if (!_.isEmpty(css)) {
        const styl = document.createElement('style')
        styl.type = 'text/css'
        styl.id = 'editor-script-css'
        document.head.appendChild(styl)
        styl.appendChild(document.createTextNode(css))
      }
    }, 1000)
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
