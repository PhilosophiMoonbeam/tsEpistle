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
          aria-label='Page title'
        )
      template(v-slot:mid)
        v-text-field.editor-title-input(
          variant="solo"
          flat
          v-model='currentPageTitle'
          hide-details
          density="compact"
        )
      template(v-slot:actions)
        v-btn.mr-3.animated.fadeIn(
          color='amber'
          variant="outlined"
          size="small"
          v-if='isConflict'
          @click='openConflict'
          :icon='$vuetify.display.smAndDown'
          aria-label='Resolve editing conflict'
        )
          .text-label-small.text-amber.mr-3(v-if='$vuetify.display.mdAndUp') Conflict
          status-indicator(intermediary, pulse)
        v-btn.animated.fadeInDown(
          variant="text"
          color='green'
          @click.exact='save'
          @click.ctrl.exact='saveAndClose'
          :class='{ "is-icon": $vuetify.display.mdAndDown }'
          :aria-label='mode === `create` ? $t(`common:actions.create`) : (isDirty ? $t(`common:actions.save`) : $t(`editor:save.saved`))'
          )
          v-icon(color='green', :start='$vuetify.display.lgAndUp') mdi-check
          span.text-grey(v-if='$vuetify.display.lgAndUp && mode !== `create` && !isDirty') {{ $t('editor:save.saved') }}
          span.text-white(v-else-if='$vuetify.display.lgAndUp') {{ mode === 'create' ? $t('common:actions.create') : $t('common:actions.save') }}
        v-btn.animated.fadeInDown.wait-p1s(
          v-if='$vuetify.display.mdAndUp'
          variant="text"
          color='blue'
          @click='openPropsModal'
          :class='{ "is-icon": $vuetify.display.mdAndDown, "mx-0": !welcomeMode, "ml-0": welcomeMode }'
          :aria-label='$t(`common:actions.page`)'
          )
          v-icon(color='blue', :start='$vuetify.display.lgAndUp') mdi-tag-text-outline
          span.text-white(v-if='$vuetify.display.lgAndUp') {{ $t('common:actions.page') }}
        v-btn.animated.fadeInDown.wait-p2s(
          v-if='!welcomeMode && $vuetify.display.mdAndUp'
          variant="text"
          color='red'
          :class='{ "is-icon": $vuetify.display.mdAndDown }'
          :aria-label='$t(`common:actions.close`)'
          @click='exit'
          )
          v-icon(color='red', :start='$vuetify.display.lgAndUp') mdi-close
          span.text-white(v-if='$vuetify.display.lgAndUp') {{ $t('common:actions.close') }}
        v-menu(v-if='$vuetify.display.smAndDown', location="bottom left", min-width='240')
          template(v-slot:activator='{ props }')
            v-btn.editor-actions-menu(
              icon
              v-bind='props'
              aria-label='Editor actions'
            )
              v-icon(color='grey') mdi-dots-vertical
          v-list(nav)
            v-list-item(@click='openPropsModal')
              template(v-slot:prepend)
                v-icon.mr-3(color='blue') mdi-tag-text-outline
              v-list-item-title Page settings
            v-list-item(@click='saveAndClose')
              template(v-slot:prepend)
                v-icon.mr-3(color='green') mdi-content-save-move
              v-list-item-title Save and close
            v-list-item(v-if='!welcomeMode', @click='exit')
              template(v-slot:prepend)
                v-icon.mr-3(color='red') mdi-close
              v-list-item-title Close editor
        v-divider.ml-3(v-if='$vuetify.display.mdAndUp', vertical)
    v-main
      component(:is='currentEditor', :save='save')
      editor-modal-properties(v-model='dialogProps')
      editor-modal-editorselect(v-model='dialogEditorSelector')
      editor-modal-unsaved(v-model='dialogUnsaved', @discard='exitGo')
      component(:is='activeModal')

    loader(v-model='dialogProgress', :title='$t(`editor:save.processing`)', :subtitle='$t(`editor:save.pleaseWait`)')
    notify</template>

<script lang='ts'>
import { defineAsyncComponent, defineComponent, type PropType } from 'vue'
import _ from 'lodash'
import { changePageVisibility, checkPageConflict, createPage, updatePage } from '../helpers/pages-api'
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
        js: ''
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
        this.savedState.tags !== wikiStore.page.tags,
        this.savedState.isPublished !== wikiStore.page.isPublished,
        this.savedState.visibility !== wikiStore.page.visibility,
        this.savedState.publishStartDate !== wikiStore.page.publishStartDate,
        this.savedState.publishEndDate !== wikiStore.page.publishEndDate,
        this.savedState.css !== wikiStore.page.scriptCss,
        this.savedState.js !== wikiStore.page.scriptJs
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
        if (wikiStore.editor.mode === 'create') {
          // --------------------------------------------
          // -> CREATE PAGE
          // --------------------------------------------

          const page = await createPage(window.fetch.bind(window), this.getPageInput())
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
            this.getPageInput(),
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
        title: wikiStore.page.title
      }
    },
    setCurrentSavedState () {
      this.savedState = {
        description: wikiStore.page.description,
        isPublished: wikiStore.page.isPublished,
        visibility: wikiStore.page.visibility,
        publishEndDate: wikiStore.page.publishEndDate || '',
        publishStartDate: wikiStore.page.publishStartDate || '',
        tags: wikiStore.page.tags,
        title: wikiStore.page.title,
        css: wikiStore.page.scriptCss,
        js: wikiStore.page.scriptJs
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
    background: #11151b !important;

    .v-application__wrap {
      min-width: 0;
      background: #11151b;
    }

    &-title-input {
      max-width: 42rem;

      .v-field {
        border: 1px solid rgba(255, 255, 255, .11);
        border-radius: 10px;
        background: rgba(255, 255, 255, .045) !important;
        box-shadow: none;
      }

      .v-field--focused {
        border-color: rgba(var(--v-theme-primary), .48);
        box-shadow: 0 0 0 3px rgba(var(--v-theme-primary), .08);
      }

      input {
        color: rgba(255, 255, 255, .9);
        font-weight: 620;
        text-align: center;
      }
    }

    &-title-input-mobile {
      width: 100%;
      min-width: 0;

      .v-field {
        padding-inline: 2px;
      }

      input {
        font-size: .875rem;
        text-align: start;
      }
    }
  }

  .atom-spinner.is-inline {
    display: inline-block;
  }

</style>
