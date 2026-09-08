<template lang='pug'>
  v-dialog(
    v-model='isShown'
    persistent
    scrollable
    width='1000'
    :fullscreen='$vuetify.display.smAndDown'
    :aria-labelledby='brandingPickerShown ? `editor-media-title` : `editor-properties-title`'
    )
    editor-modal-media(
      v-if='brandingPickerShown'
      purpose='page-branding'
      embedded
      @branding-selected='applyBrandingSelection'
      @branding-cancelled='closeBrandingPicker'
    )
    .dialog-header(v-show='!brandingPickerShown')
      v-icon(color='primary') mdi-tag-text-outline
      .text-body-large.ml-3#editor-properties-title {{$t('editor:props.pageProperties')}}
      v-spacer
      v-btn.mx-0.mr-2(
        variant='text'
        @click='cancel'
        )
        span {{ $t('common:actions.cancel') }}
      v-btn.mx-0(
        variant="outlined"
        @click='close'
        )
        v-icon(start) mdi-check
        span {{ $t('common:actions.ok') }}
    v-card.editor-properties-card(v-show='!brandingPickerShown', rounded='0')
      v-tabs(v-model='currentTab', color='primary', align-tabs="center", show-arrows)
        v-tab(:value='0') {{$t('editor:props.info')}}
        v-tab(:value='1') {{$t('editor:props.scheduling')}}
        v-tab(:value='2', :disabled='!hasScriptPermission') {{$t('editor:props.scripts')}}
        //- v-tab(:value='3', disabled) {{$t('editor:props.social')}}
        v-tab(:value='3', :disabled='!hasStylePermission') {{$t('editor:props.styles')}}
        v-tab(:value='4', :disabled='mode === `create`') {{$t('editor:props.translations')}}
        v-tab(:value='5') Knowledge / OKF
      v-tabs-window.editor-properties-tabs-window(v-model='currentTab')
        v-tabs-window-item(:value='0', transition='fade-transition', reverse-transition='fade-transition')
          v-card-text.pt-5
            .text-label-small.pb-5 {{$t('editor:props.pageInfo')}}
            v-text-field(
              ref='iptTitle'
              variant="outlined"
              :label='$t(`editor:props.title`)'
              counter='255'
              maxlength='255'
              v-model='title'
              )
            v-text-field(
              variant="outlined"
              :label='$t(`editor:props.shortDescription`)'
              counter='255'
              v-model='description'
              maxlength='255'
              persistent-hint
              :hint='$t(`editor:props.shortDescriptionHint`)'
              )
            section.editor-properties-branding(aria-labelledby='editor-properties-branding-title')
              .editor-properties-branding-heading
                .text-label-small#editor-properties-branding-title Page identity
                v-spacer
                .text-label-small.text-medium-emphasis Optional
              .editor-properties-branding-preview
                .editor-properties-branding-preview-copy
                  .text-label-small Header preview
                  .text-title-small {{ title || 'Untitled page' }}
                  .text-body-small(v-if='description') {{ description }}
                  .text-body-small.text-medium-emphasis(v-else) No short description
                page-branding-mark(:branding='draft.brandingView')
              .editor-properties-branding-actions
                v-btn(
                  ref='brandingActionButton'
                  variant='tonal'
                  color='primary'
                  @click='openBrandingPicker'
                )
                  v-icon(start) mdi-image-multiple-outline
                  span {{ draft.brandingAssignment ? 'Replace' : 'Select' }}
                v-btn(
                  v-if='draft.brandingAssignment'
                  variant='text'
                  color='error'
                  @click='removeBranding'
                )
                  v-icon(start) mdi-image-remove-outline
                  span Remove
              .editor-properties-branding-status(
                aria-live='polite'
                :role='brandingError ? `alert` : `status`'
              )
                span(v-if='brandingError') {{ brandingError }}
                span(v-else-if='draft.brandingAssignment && !draft.brandingView') Assigned image is unavailable. You can replace or remove it.
                span(v-else-if='draft.brandingAssignment') Page identity image selected.
                span(v-else) No page identity image selected.
            v-switch(
              ref='privatePageSwitch'
              label='Private page'
              v-model='privatePage'
              color='deep-orange'
              hint='Private pages are visible only to you. Publishing makes this page available through normal page permissions.'
              persistent-hint
              inset
            )
          v-divider
          v-card-text.editor-properties-subsection.pt-5
            .text-label-small.pb-5 {{$t('editor:props.path')}}
            v-container.pa-0(fluid)
              v-row
                v-col(cols='12', md='2')
                  v-select(
                    variant="outlined"
                    :label='$t(`editor:props.locale`)'
                    suffix='/'
                    :items='namespaces'
                    v-model='locale'
                    hide-details
                  )
                v-col(cols='12', md='10')
                  v-form(ref='propsForm', @submit.prevent='close')
                    v-text-field(
                      ref='iptPath'
                      variant="outlined"
                      :label='$t(`editor:props.path`)'
                      append-icon='mdi-folder-search'
                      v-model='path'
                      :hint='$t(`editor:props.pathHint`)'
                      persistent-hint
                      @click:append='showPathSelector'
                      :rules='pathRules'
                    )
          v-divider
          v-card-text.editor-properties-subsection.pt-5
            .text-label-small.pb-5 {{$t('editor:props.categorization')}}
            v-combobox(
              :label='$t(`editor:props.tags`)'
              variant="outlined"
              v-model='tags'
              v-model:search='newTagSearch'
              :hint='$t(`editor:props.tagsHint`)'
              :items='newTagSuggestions'
              :loading='tagSearchLoading'
              multiple
              chips
              closable-chips
              hide-selected
              persistent-hint
              hide-no-data
              )
        v-tabs-window-item(:value='1', transition='fade-transition', reverse-transition='fade-transition')
          v-card-text
            .text-label-small {{$t('editor:props.publishState')}}
            v-switch(
              :label='$t(`editor:props.publishToggle`)'
              v-model='isPublished'
              color='primary'
              :hint='$t(`editor:props.publishToggleHint`)'
              persistent-hint
              inset
              )
          v-divider
          v-card-text.editor-properties-subsection.pt-5
            v-container.pa-0(fluid)
              v-row
                v-col(cols='12', md='6')
                  v-dialog(
                    v-model='isPublishStartShown'
                    width='460px'
                    :disabled='!isPublished'
                    :aria-label='$t(`editor:props.publishStart`)'
                    )
                    template(v-slot:activator='{ props }')
                      v-text-field(
                        v-bind='props'
                        :label='$t(`editor:props.publishStart`)'
                        v-model='publishStartDate'
                        prepend-icon='mdi-calendar-check'
                        readonly
                        variant="outlined"
                        clearable
                        :hint='$t(`editor:props.publishStartHint`)'
                        persistent-hint
                        :disabled='!isPublished'
                        )
                    v-date-picker(
                      v-model='publishStartDraft'
                      :min='publishMinDate'
                      color='primary'
                      :landscape='$vuetify.display.mdAndUp'
                      )
                      template(v-slot:actions)
                        v-spacer
                        v-btn(
                          variant='text'
                          color='primary'
                          @click='isPublishStartShown = false'
                          ) {{$t('common:actions.cancel')}}
                        v-btn(
                          variant='text'
                          color='primary'
                          @click='applyPublishStartDate'
                          ) {{$t('common:actions.ok')}}
                v-col(cols='12', md='6')
                  v-dialog(
                    v-model='isPublishEndShown'
                    width='460px'
                    :disabled='!isPublished'
                    :aria-label='$t(`editor:props.publishEnd`)'
                    )
                    template(v-slot:activator='{ props }')
                      v-text-field(
                        v-bind='props'
                        :label='$t(`editor:props.publishEnd`)'
                        v-model='publishEndDate'
                        prepend-icon='mdi-calendar-remove'
                        readonly
                        variant="outlined"
                        clearable
                        :hint='$t(`editor:props.publishEndHint`)'
                        persistent-hint
                        :disabled='!isPublished'
                        )
                    v-date-picker(
                      v-model='publishEndDraft'
                      :min='publishMinDate'
                      color='primary'
                      :landscape='$vuetify.display.mdAndUp'
                      )
                      template(v-slot:actions)
                        v-spacer
                        v-btn(
                          variant='text'
                          color='primary'
                          @click='isPublishEndShown = false'
                          ) {{$t('common:actions.cancel')}}
                        v-btn(
                          variant='text'
                          color='primary'
                          @click='applyPublishEndDate'
                          ) {{$t('common:actions.ok')}}

        v-tabs-window-item.editor-properties-code-tab(:value='2', :transition='false', :reverse-transition='false')
          .editor-props-codeeditor-title
            .text-label-small {{$t('editor:props.html')}}
          .editor-props-codeeditor
            div(ref='codejs')
          .editor-props-codeeditor-hint
            .text-body-small {{$t('editor:props.htmlHint')}}

        //- v-tabs-window-item(:value='3', transition='fade-transition', reverse-transition='fade-transition')
        //-   v-card-text
        //-     .text-label-small {{$t('editor:props.socialFeatures')}}
        //-     v-switch(
        //-       :label='$t(`editor:props.allowComments`)'
        //-       v-model='isPublished'
        //-       color='primary'
        //-       :hint='$t(`editor:props.allowCommentsHint`)'
        //-       persistent-hint
        //-       inset
        //-       )
        //-     v-switch(
        //-       :label='$t(`editor:props.allowRatings`)'
        //-       v-model='isPublished'
        //-       color='primary'
        //-       :hint='$t(`editor:props.allowRatingsHint`)'
        //-       persistent-hint
        //-       disabled
        //-       inset
        //-       )
        //-     v-switch(
        //-       :label='$t(`editor:props.displayAuthor`)'
        //-       v-model='isPublished'
        //-       color='primary'
        //-       :hint='$t(`editor:props.displayAuthorHint`)'
        //-       persistent-hint
        //-       inset
        //-       )
        //-     v-switch(
        //-       :label='$t(`editor:props.displaySharingBar`)'
        //-       v-model='isPublished'
        //-       color='primary'
        //-       :hint='$t(`editor:props.displaySharingBarHint`)'
        //-       persistent-hint
        //-       inset
        //-       )

        v-tabs-window-item.editor-properties-code-tab(:value='3', :transition='false', :reverse-transition='false')
          .editor-props-codeeditor-title
            .text-label-small {{$t('editor:props.css')}}
          .editor-props-codeeditor
            div(ref='codecss')
          .editor-props-codeeditor-hint
            .text-body-small {{$t('editor:props.cssHint')}}

        v-tabs-window-item(:value='4', transition='fade-transition', reverse-transition='fade-transition')
          v-card-text
            .d-flex.align-center.mb-4
              div
                .text-label-small {{$t('editor:props.translations')}}
                .text-body-small.text-grey {{$t('editor:props.translationsHint')}}
              v-spacer
              v-btn(
                color='primary'
                variant='tonal'
                :loading='translationsLoading'
                @click='translationSelectorShown = true'
                )
                v-icon(start) mdi-translate
                span {{$t('editor:props.linkTranslation')}}
            v-progress-linear(v-if='translationsLoading', indeterminate, color='primary')
            v-list(v-else-if='!translationError && relatedTranslations.length > 0', lines='two')
              template(v-for='translation of relatedTranslations', :key='translation.id')
                v-list-item
                  template(v-slot:prepend)
                    v-chip.mr-3(label, color='primary', size='small') {{translation.locale.toUpperCase()}}
                  v-list-item-title {{translation.title}}
                  v-list-item-subtitle /{{translation.locale}}/{{translation.path}}
                  template(v-slot:append)
                    v-btn(
                      icon='mdi-link-off'
                      variant='text'
                      color='error'
                      :aria-label='$t(`editor:props.unlinkTranslation`, { title: translation.title })'
                      @click='unlinkTranslation(translation)'
                      )
                v-divider
            v-alert(v-else-if='translationError', type='error', variant='tonal')
              .d-flex.align-center
                span {{translationError}}
                v-spacer
                v-btn(variant='text', size='small', @click='loadTranslations') Retry
        v-tabs-window-item(:value='5', transition='fade-transition', reverse-transition='fade-transition')
          editor-okf-panel


    v-dialog(
      v-model='privatePageConfirm'
      max-width='480'
      role='alertdialog'
      aria-labelledby='editor-properties-private-title'
      aria-describedby='editor-properties-private-description'
      @after-leave='restorePrivatePageFocus'
    )
      v-card
        v-card-title#editor-properties-private-title Publish private page?
        v-card-text#editor-properties-private-description Publish this private page? It will become available through normal page permissions.
        v-card-actions
          v-spacer
          v-btn(variant='text', @click='privatePageConfirm = false') {{$t('common:actions.cancel')}}
          v-btn(color='primary', @click='confirmPublish') {{$t('common:actions.ok')}}
    page-selector(:mode='pageSelectorMode', v-model='pageSelectorShown', :path='path', :locale='locale', :open-handler='setPath')
    page-selector(
      mode='select'
      must-exist
      allow-locale-change
      v-model='translationSelectorShown'
      :path='path'
      :locale='locale'
      :open-handler='linkTranslation'
      )

</template>

<script lang='ts'>
import { defineComponent, markRaw, type PropType } from 'vue'
import { useDate } from 'vuetify'
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'
import {
  fetchPageLocaleRelations,
  linkPageLocaleRelation,
  searchPageTags,
  unlinkPageLocaleRelation,
  type PageLocaleRelation
} from '../../helpers/pages-api'
import {
  PageBrandingAssignmentSchema,
  PageBrandingViewSchema,
  type PageBrandingAssignment,
  type PageBrandingView
} from '../../../shared/page-branding.ts'
import PageBrandingMark from '../common/page-branding-mark.vue'
import { createAsyncComponent } from '../common/async-component-state.vue'

import { css } from '@codemirror/lang-css'
import { javascript } from '@codemirror/lang-javascript'
import { TextEditor, type TextEditorHandle } from './common/text-editor'
import EditorOkfPanel from './editor-okf-panel.vue'

/* global siteLangs, siteConfig */

const filenamePattern = /^(?![\#\/\.\$\^\=\*\;\:\&\?\(\)\[\]\{\}\"\'\>\<\,\@\!\%\`\~\s])(?!.*[\#\/\.\$\^\=\*\;\:\&\?\(\)\[\]\{\}\"\'\>\<\,\@\!\%\`\~\s]$)[^\#\.\$\^\=\*\;\:\&\?\(\)\[\]\{\}\"\'\>\<\,\@\!\%\`\~\s]*$/

type DatePickerValue = unknown
type OkfState = typeof wikiStore.page.okf

const PATH_RULES = Object.freeze([
  (value: string) => !!value || 'This field is required.',
  (value: string) => filenamePattern.test(value) || 'Invalid path. Please ensure it does not contain special characters, or begin/end in a slash or hashtag string.'
])

type PagePropertiesDraft = {
  title: string
  description: string
  locale: string
  tags: string[]
  path: string
  isPublished: boolean
  visibility: 'public' | 'private'
  publishStartDate: string
  publishEndDate: string
  scriptJs: string
  scriptCss: string
  brandingAssignment: PageBrandingAssignment | null
  brandingView: PageBrandingView | null
}

function createPropertiesDraft (): PagePropertiesDraft {
  return {
    title: wikiStore.page.title,
    description: wikiStore.page.description,
    locale: wikiStore.page.locale,
    tags: [...wikiStore.page.tags],
    path: wikiStore.page.path,
    isPublished: wikiStore.page.isPublished,
    visibility: wikiStore.page.visibility,
    publishStartDate: wikiStore.page.publishStartDate,
    publishEndDate: wikiStore.page.publishEndDate,
    scriptJs: wikiStore.page.scriptJs,
    scriptCss: wikiStore.page.scriptCss,
    brandingAssignment: _.cloneDeep(wikiStore.page.brandingAssignment),
    brandingView: _.cloneDeep(wikiStore.page.brandingView)
  }
}

function focusInput (ref: unknown): void {
  const componentRoot = (ref as { $el?: unknown } | null)?.$el
  const root = ref instanceof HTMLElement ? ref : componentRoot instanceof HTMLElement ? componentRoot : null
  root?.querySelector<HTMLInputElement>('input')?.focus()
}

function normalizeBrandingAssignment (value: unknown): PageBrandingAssignment | null {
  if (value === null || value === undefined) return null
  const result = PageBrandingAssignmentSchema.safeParse(value)
  return result.success ? result.data : null
}

function normalizeBrandingView (value: unknown, assignment: PageBrandingAssignment | null): PageBrandingView | null {
  if (assignment === null || value === null || value === undefined) return null
  const result = PageBrandingViewSchema.safeParse(value)
  return result.success && result.data.assetId === assignment.assetId ? result.data : null
}
export default defineComponent({
  components: {
    EditorOkfPanel,
    PageBrandingMark,
    editorModalMedia: createAsyncComponent(() => import('./editor-modal-media.vue'))
  },
  emits: ['update:modelValue'],
  props: {
    modelValue: {
      type: Boolean,
      default: false
    }
  },
  setup() {
    return {
      dateAdapter: useDate()
    }
  },
  data () {
    return {
      isPublishStartShown: false,
      isPublishEndShown: false,
      publishStartDraft: null as DatePickerValue,
      publishEndDraft: null as DatePickerValue,
      publishMinDate: new Date() as DatePickerValue,
      pageSelectorShown: false,
      translationSelectorShown: false,
      translations: markRaw([] as PageLocaleRelation[]),
      translationsLoading: false,
      translationError: '',
      namespaces: markRaw(siteLangs.length ? siteLangs.map(ns => ns.code) : [siteConfig.lang]),
      newTagSuggestions: [] as string[],
      newTagSearch: '',
      tagSearchTimer: null as number | null,
      tagSearchLoading: false,
      currentTab: 0,
      privatePageConfirm: false,
      cm: null as TextEditorHandle | null,
      editorLoadTimer: null as number | null,
      tagSearchRequest: 0,
      translationsRequest: 0,
      editorDisposed: false,
      pathRules: PATH_RULES,
      draft: createPropertiesDraft(),
      okfSnapshot: null as OkfState | null,
      returnFocus: null as HTMLElement | null,
      brandingPickerShown: false,
      brandingError: '',
      brandingReturnFocus: null as HTMLElement | null
    }
  },
  computed: {
    isShown: {
      get() { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    },
    mode() {
      return wikiStore.editor.mode
    },
    title: {
      get() {
        return this.draft.title
      },
      set(value: string) {
        this.draft.title = value
      }
    },
    description: {
      get() {
        return this.draft.description
      },
      set(value: string) {
        this.draft.description = value
      }
    },
    locale: {
      get() {
        return this.draft.locale
      },
      set(value: string) {
        this.draft.locale = value
      }
    },
    tags: {
      get() {
        return this.draft.tags
      },
      set(value: string[]) {
        this.draft.tags = _.uniq(value.map(tag => _.trim(tag).toLowerCase()).filter(Boolean))
      }
    },
    path: {
      get() {
        return this.draft.path
      },
      set(value: string) {
        this.draft.path = value
      }
    },
    isPublished: {
      get() {
        return this.draft.isPublished
      },
      set(value: boolean) {
        this.draft.isPublished = value
      }
    },
    privatePage: {
      get() {
        return this.draft.visibility === 'private'
      },
      set(value: boolean) {
        if (
          !value &&
          this.mode !== 'create' &&
          this.draft.visibility === 'private'
        ) {
          this.privatePageConfirm = true
          return
        }
        this.draft.visibility = value ? 'private' : 'public'
      }
    },
    publishStartDate: {
      get() {
        return this.draft.publishStartDate
      },
      set(value: string | null) {
        this.draft.publishStartDate = value ?? ''
      }
    },
    publishEndDate: {
      get() {
        return this.draft.publishEndDate
      },
      set(value: string | null) {
        this.draft.publishEndDate = value ?? ''
      }
    },
    scriptJs: {
      get() {
        return this.draft.scriptJs
      },
      set(value: string) {
        this.draft.scriptJs = value
      }
    },
    scriptCss: {
      get() {
        return this.draft.scriptCss
      },
      set(value: string) {
        this.draft.scriptCss = value
      }
    },
    hasScriptPermission() {
      return wikiStore.page.effectivePermissions.pages.script
    },
    hasStylePermission() {
      return wikiStore.page.effectivePermissions.pages.style
    },
    pageSelectorMode () {
      return (this.mode === 'create') ? 'create' : 'move'
    },
    relatedTranslations (): PageLocaleRelation[] {
      return this.translations.filter(translation => translation.id !== wikiStore.page.id)
    }
  },
  watch: {
    '$vuetify.theme.current.dark' (newValue: boolean) {
      this.cm?.setDark(newValue)
    },
    modelValue: {
      immediate: true,
      handler (newValue: boolean) {
        if (newValue) {
          this.beginEditing()
          this.currentTab = 0
          if (this.mode !== 'create') void this.loadTranslations()
          this.$nextTick(() => {
            if (!this.editorDisposed && this.modelValue) {
              focusInput(this.$refs.iptTitle)
            }
          })
        } else {
          this.rollbackDraft()
          this.brandingPickerShown = false
          this.brandingError = ''
          this.brandingReturnFocus = null
          this.isPublishStartShown = false
          this.isPublishEndShown = false
          this.pageSelectorShown = false
          this.translationSelectorShown = false
          this.privatePageConfirm = false
          this.newTagSearch = ''
          this.newTagSuggestions = []
          if (this.tagSearchTimer !== null) {
            window.clearTimeout(this.tagSearchTimer)
            this.tagSearchTimer = null
          }
          if (this.editorLoadTimer !== null) {
            window.clearTimeout(this.editorLoadTimer)
            this.editorLoadTimer = null
          }
          this.tagSearchRequest++
          this.translationsRequest++
          this.tagSearchLoading = false
          this.translationsLoading = false
          this.cm?.destroy()
          this.cm = null
        }
      }
    },
    isPublishStartShown (newValue: boolean) {
      if (newValue) {
        this.publishMinDate = this.dateAdapter.startOfDay(this.dateAdapter.date())
        this.publishStartDraft = this.publishStartDate ? this.dateAdapter.parseISO(this.publishStartDate) : null
      }
    },
    isPublishEndShown (newValue: boolean) {
      if (newValue) {
        this.publishMinDate = this.dateAdapter.startOfDay(this.dateAdapter.date())
        this.publishEndDraft = this.publishEndDate ? this.dateAdapter.parseISO(this.publishEndDate) : null
      }
    },
    newTagSearch (newValue: string) {
      if (this.tagSearchTimer !== null) {
        window.clearTimeout(this.tagSearchTimer)
        this.tagSearchTimer = null
      }
      this.tagSearchRequest++
      if (!this.modelValue || _.isEmpty(newValue)) {
        this.tagSearchLoading = false
        this.newTagSuggestions = []
        return
      }
      this.tagSearchTimer = window.setTimeout(() => {
        this.tagSearchTimer = null
        void this.loadTagSuggestions(newValue)
      }, 500)
    },
    currentTab (newValue: number) {
      if (this.editorLoadTimer !== null) {
        window.clearTimeout(this.editorLoadTimer)
        this.editorLoadTimer = null
      }
      this.cm?.destroy()
      this.cm = null
      if (newValue !== 2 && newValue !== 3) return
      this.$nextTick(() => {
        if (this.editorDisposed || !this.modelValue || this.currentTab !== newValue) return
        this.editorLoadTimer = window.setTimeout(() => {
          this.editorLoadTimer = null
          if (this.editorDisposed || !this.modelValue || this.currentTab !== newValue) return
          const ref = this.$refs[newValue === 2 ? 'codejs' : 'codecss'] as HTMLElement | undefined
          if (ref) this.loadEditor(ref, newValue === 2 ? 'js' : 'css')
        }, 100)
      })
    }
  },
  mounted () {
    this.returnFocus = document.activeElement as HTMLElement | null
  },
  beforeUnmount() {
    const target = this.returnFocus
    queueMicrotask(() => {
      if (target?.isConnected && !target.matches(':disabled') && !target.closest('[inert], [aria-hidden="true"]')) {
        target.focus({ preventScroll: true })
      }
    })
    this.rollbackDraft()
    this.editorDisposed = true
    this.tagSearchRequest++
    this.translationsRequest++
    if (this.tagSearchTimer !== null) window.clearTimeout(this.tagSearchTimer)
    if (this.editorLoadTimer !== null) window.clearTimeout(this.editorLoadTimer)
    this.cm?.destroy()
    this.cm = null
  },
  methods: {
    beginEditing () {
      this.draft = createPropertiesDraft()
      this.okfSnapshot = _.cloneDeep(wikiStore.page.okf)
      this.brandingPickerShown = false
      this.brandingError = ''
      this.brandingReturnFocus = null
    },
    rollbackDraft () {
      if (this.okfSnapshot !== null) {
        wikiStore.page.okf = this.okfSnapshot
        this.okfSnapshot = null
      }
    },
    commitDraft () {
      wikiStore.page.title = this.draft.title
      wikiStore.page.description = this.draft.description
      wikiStore.page.locale = this.draft.locale
      wikiStore.page.tags = [...this.draft.tags]
      wikiStore.page.path = this.draft.path
      wikiStore.page.isPublished = this.draft.isPublished
      wikiStore.page.visibility = this.draft.visibility
      wikiStore.page.publishStartDate = this.draft.publishStartDate
      wikiStore.page.publishEndDate = this.draft.publishEndDate
      wikiStore.page.scriptJs = this.draft.scriptJs
      wikiStore.page.scriptCss = this.draft.scriptCss
      const brandingAssignment = normalizeBrandingAssignment(this.draft.brandingAssignment)
      wikiStore.page.brandingAssignment = brandingAssignment
      wikiStore.page.brandingView = normalizeBrandingView(this.draft.brandingView, brandingAssignment)
      this.okfSnapshot = null
    },
    cancel () {
      if (this.brandingPickerShown) this.closeBrandingPicker()
      this.rollbackDraft()
      this.isShown = false
    },
    openBrandingPicker () {
      this.brandingError = ''
      const button = (this.$refs.brandingActionButton as { $el?: unknown } | undefined)?.$el
      this.brandingReturnFocus = button instanceof HTMLElement ? button : document.activeElement as HTMLElement | null
      wikiStore.editor.media.currentFileId = null
      this.brandingPickerShown = true
    },
    closeBrandingPicker () {
      this.brandingPickerShown = false
      wikiStore.editor.media.currentFileId = null
      this.restoreBrandingFocus()
    },
    restoreBrandingFocus () {
      const target = this.brandingReturnFocus
      this.brandingReturnFocus = null
      this.$nextTick(() => {
        if (target?.isConnected && !target.matches(':disabled') && !target.closest('[inert], [aria-hidden="true"]')) {
          target.focus({ preventScroll: true })
        }
      })
    },
    applyBrandingSelection (payload: { assignment?: unknown, view?: unknown } = {}) {
      const assignment = normalizeBrandingAssignment(payload.assignment)
      const view = normalizeBrandingView(payload.view, assignment)
      if (assignment === null || view === null) {
        this.brandingError = 'Choose a supported image before continuing.'
        return
      }
      this.draft.brandingAssignment = assignment
      this.draft.brandingView = view
      this.brandingError = ''
      this.closeBrandingPicker()
    },
    removeBranding () {
      this.draft.brandingAssignment = null
      this.draft.brandingView = null
      this.brandingError = ''
    },
    async loadTranslations () {
      const request = ++this.translationsRequest
      this.translationsLoading = true
      this.translationError = ''
      try {
        const translations = await fetchPageLocaleRelations(window.fetch.bind(window), wikiStore.page.id)
        if (this.editorDisposed || request !== this.translationsRequest) return
        this.translations = markRaw(translations)
      } catch (err) {
        if (this.editorDisposed || request !== this.translationsRequest) return
        this.translationError = 'Unable to load translations. Try again.'
        wikiStore.showError(err)
      } finally {
        if (!this.editorDisposed && request === this.translationsRequest) {
          this.translationsLoading = false
        }
      }
    },
    async linkTranslation ({ id }: { id: number }) {
      const request = ++this.translationsRequest
      this.translationsLoading = true
      try {
        const translations = await linkPageLocaleRelation(window.fetch.bind(window), wikiStore.page.id, id)
        if (this.editorDisposed || request !== this.translationsRequest) return false
        this.translationError = ''
        this.translations = markRaw(translations)
      } catch (err) {
        if (this.editorDisposed || request !== this.translationsRequest) return false
        wikiStore.showError(err)
        return false
      } finally {
        if (!this.editorDisposed && request === this.translationsRequest) {
          this.translationsLoading = false
        }
      }
    },
    async unlinkTranslation (translation: PageLocaleRelation) {
      const request = ++this.translationsRequest
      this.translationsLoading = true
      try {
        const translations = await unlinkPageLocaleRelation(window.fetch.bind(window), wikiStore.page.id, translation.id)
        if (this.editorDisposed || request !== this.translationsRequest) return
        this.translations = markRaw(translations)
      } catch (err) {
        if (this.editorDisposed || request !== this.translationsRequest) return
        wikiStore.showError(err)
      } finally {
        if (!this.editorDisposed && request === this.translationsRequest) {
          this.translationsLoading = false
        }
      }
    },
    applyPublishStartDate() {
      this.publishStartDate = this.publishStartDraft ? this.dateAdapter.toISO(this.publishStartDraft) : ''
      this.isPublishStartShown = false
    },
    applyPublishEndDate() {
      this.publishEndDate = this.publishEndDraft ? this.dateAdapter.toISO(this.publishEndDraft) : ''
      this.isPublishEndShown = false
    },
    async close() {
      if (this.currentTab !== 0) {
        this.currentTab = 0
        await this.$nextTick()
      }
      const form = this.$refs.propsForm as { validate?: () => Promise<{ valid: boolean }> } | undefined
      const result = await form?.validate?.()
      if (!result?.valid) {
        await this.$nextTick()
        focusInput(this.$refs.iptPath)
        return
      }
      this.commitDraft()
      this.isShown = false
    },
    restorePrivatePageFocus () {
      if (!this.modelValue) return
      this.$nextTick(() => focusInput(this.$refs.privatePageSwitch))
    },
    confirmPublish() {
      this.draft.visibility = 'public'
      this.privatePageConfirm = false
    },
    showPathSelector() {
      this.pageSelectorShown = true
    },
    setPath({ path, locale }: { path: string, locale: string }) {
      this.locale = locale
      this.path = path
    },
    async loadTagSuggestions(query: string) {
      const request = ++this.tagSearchRequest
      this.tagSearchLoading = true
      try {
        const suggestions = await searchPageTags(window.fetch.bind(window), query)
        if (this.editorDisposed || request !== this.tagSearchRequest || !this.modelValue) return
        this.newTagSuggestions = suggestions
      } catch (err) {
        if (this.editorDisposed || request !== this.tagSearchRequest || !this.modelValue) return
        console.warn(err)
        this.newTagSuggestions = []
      } finally {
        if (!this.editorDisposed && request === this.tagSearchRequest) {
          this.tagSearchLoading = false
        }
      }
    },
    loadEditor(ref: HTMLElement, mode: 'js' | 'css') {
      const cm = new TextEditor({
        parent: ref,
        ariaLabel: mode === 'js' ? 'Page JavaScript' : 'Page CSS',
        dark: this.$vuetify.theme.current.dark,
        value: mode === 'js' ? this.scriptJs : this.scriptCss,
        language: mode === 'js' ? javascript() : css(),
        onChange: value => {
          if (mode === 'js') {
            this.scriptJs = value
          } else {
            this.scriptCss = value
          }
        }
      })
      this.cm = markRaw(cm)
      this.$nextTick(() => {
        if (this.editorDisposed || this.cm !== cm) return
        cm.requestMeasure()
        cm.focus()
      })
    }
  }

})
</script>

<style lang='scss'>

.editor-properties-branding {
  border: 1px solid rgba(var(--v-theme-on-surface), .12);
  border-radius: var(--wiki-radius-sm, 10px);
  background: rgba(var(--v-theme-on-surface), .025);
  margin-bottom: 20px;
  padding: 14px;
}

.editor-properties-branding-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.editor-properties-branding-preview {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 72px;
  border: 1px solid rgba(var(--v-theme-on-surface), .1);
  border-radius: var(--wiki-radius-xs, 6px);
  background: rgb(var(--v-theme-surface));
  padding: 10px 12px;
}

.editor-properties-branding-preview-copy {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 3px;
  overflow: hidden;
}

.editor-properties-branding-preview-copy .text-title-small,
.editor-properties-branding-preview-copy .text-body-small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-properties-branding-preview .page-branding-mark {
  inline-size: 48px;
  block-size: 48px;
  flex-basis: 48px;
}

.editor-properties-branding-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.editor-properties-branding-status {
  min-height: 20px;
  color: rgba(var(--v-theme-on-surface), .62);
  font-size: .78rem;
  line-height: 1.35;
  margin-top: 8px;
}

.editor-properties-branding-status[role='alert'] {
  color: rgb(var(--v-theme-error));
}

.editor-properties-card {
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
  display: flex;

  .editor-properties-subsection {
    background: rgba(var(--v-theme-on-surface), .035);
  }

  flex-direction: column;
  max-height: calc(100dvh - 32px);
  min-height: 0;

  .editor-properties-tabs-window {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }
}

.editor-properties-card .editor-properties-code-tab {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.editor-props-codeeditor {
  background: rgb(var(--v-theme-surface-variant));
  flex: 1 1 auto;
  min-height: 120px;
  overflow: hidden;

  > div {
    height: 100%;
    min-height: 0;
  }

  > textarea {
    visibility: hidden;
  }

  &-title {
    background: rgba(var(--v-theme-on-surface), .06);
    border-bottom: 1px solid rgba(var(--v-theme-on-surface), .12);
    color: rgb(var(--v-theme-on-surface));
    flex: 0 0 auto;
    padding: 10px;
  }

  &-hint {
    background: rgba(var(--v-theme-on-surface), .04);
    border-top: 1px solid rgba(var(--v-theme-on-surface), .12);
    color: rgba(var(--v-theme-on-surface), .62);
    flex: 0 0 auto;
    padding: 5px 10px;
  }
}

</style>
