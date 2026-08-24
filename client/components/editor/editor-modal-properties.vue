<template lang='pug'>
  v-dialog(
    v-model='isShown'
    persistent
    width='1000'
    :fullscreen='$vuetify.display.smAndDown'
    )
    .dialog-header
      v-icon(color='white') mdi-tag-text-outline
      .text-body-large.text-white.ml-3 {{$t('editor:props.pageProperties')}}
      v-spacer
      v-btn.mx-0(
        variant="outlined"
        @click='close'
        )
        v-icon(start) mdi-check
        span {{ $t('common:actions.ok') }}
    v-card(rounded='0')
      v-tabs.text-white(bg-color='blue-darken-1', color='white', align-tabs="center", show-arrows, v-model='currentTab')
        v-tab(:value='0') {{$t('editor:props.info')}}
        v-tab(:value='1') {{$t('editor:props.scheduling')}}
        v-tab(:value='2', :disabled='!hasScriptPermission') {{$t('editor:props.scripts')}}
        //- v-tab(:value='3', disabled) {{$t('editor:props.social')}}
        v-tab(:value='3', :disabled='!hasStylePermission') {{$t('editor:props.styles')}}
      v-tabs-window(v-model='currentTab')
        v-tabs-window-item(:value='0', transition='fade-transition', reverse-transition='fade-transition')
          v-card-text.pt-5
            .text-label-small.pb-5 {{$t('editor:props.pageInfo')}}
            v-text-field(
              ref='iptTitle'
              variant="outlined"
              :label='$t(`editor:props.title`)'
              counter='255'
              v-model='title'
              )
            v-text-field(
              variant="outlined"
              :label='$t(`editor:props.shortDescription`)'
              counter='255'
              v-model='description'
              persistent-hint
              :hint='$t(`editor:props.shortDescriptionHint`)'
              )
            v-switch(
              label='Private page'
              v-model='privatePage'
              color='deep-orange'
              hint='Private pages are visible only to you. Publishing makes this page available through normal page permissions.'
              persistent-hint
              inset
            )
          v-divider
          v-card-text.pt-5(:class='$vuetify.theme.current.dark ? `bg-grey-darken-3-d3` : `bg-grey-lighten-5`')
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
                  v-text-field(
                    variant="outlined"
                    :label='$t(`editor:props.path`)'
                    append-icon='mdi-folder-search'
                    v-model='path'
                    :hint='$t(`editor:props.pathHint`)'
                    persistent-hint
                    @click:append='showPathSelector'
                    :rules='[rules.required, rules.path]'
                    )
          v-divider
          v-card-text.pt-5(:class='$vuetify.theme.current.dark ? `bg-grey-darken-3-d5` : `bg-grey-lighten-4`')
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
          v-card-text.pt-5(:class='$vuetify.theme.current.dark ? `bg-grey-darken-3-d3` : `bg-grey-lighten-5`')
            v-container.pa-0(fluid)
              v-row
                v-col(cols='12', md='6')
                  v-dialog(
                    v-model='isPublishStartShown'
                    width='460px'
                    :disabled='!isPublished'
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
                      :min='(new Date()).toISOString().substring(0, 10)'
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
                      :min='(new Date()).toISOString().substring(0, 10)'
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

        v-tabs-window-item(:value='2', :transition='false', :reverse-transition='false')
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

        v-tabs-window-item(:value='3', :transition='false', :reverse-transition='false')
          .editor-props-codeeditor-title
            .text-label-small {{$t('editor:props.css')}}
          .editor-props-codeeditor
            div(ref='codecss')
          .editor-props-codeeditor-hint
            .text-body-small {{$t('editor:props.cssHint')}}

    page-selector(:mode='pageSelectorMode', v-model='pageSelectorShown', :path='path', :locale='locale', :open-handler='setPath')</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'
import { searchPageTags } from '../../helpers/pages-api'

import { css } from '@codemirror/lang-css'
import { javascript } from '@codemirror/lang-javascript'
import { TextEditor, type TextEditorHandle } from './common/text-editor'

/* global siteLangs, siteConfig */

const filenamePattern = /^(?![\#\/\.\$\^\=\*\;\:\&\?\(\)\[\]\{\}\"\'\>\<\,\@\!\%\`\~\s])(?!.*[\#\/\.\$\^\=\*\;\:\&\?\(\)\[\]\{\}\"\'\>\<\,\@\!\%\`\~\s]$)[^\#\.\$\^\=\*\;\:\&\?\(\)\[\]\{\}\"\'\>\<\,\@\!\%\`\~\s]*$/

type DatePickerValue = Date | string | null

function parseDatePickerValue (value: string): Date | null {
  if (!value) return null
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function formatDatePickerValue (value: DatePickerValue): string {
  if (!value) return ''
  const parsed = value instanceof Date ? value : parseDatePickerValue(value)
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : ''
}

export default defineComponent({
  emits: ['update:modelValue'],
  props: {
    modelValue: {
      type: Boolean,
      default: false
    }
  },
  data () {
    return {
      isPublishStartShown: false,
      isPublishEndShown: false,
      publishStartDraft: null as DatePickerValue,
      publishEndDraft: null as DatePickerValue,
      pageSelectorShown: false,
      namespaces: siteLangs.length ? siteLangs.map(ns => ns.code) : [siteConfig.lang],
      newTagSuggestions: [] as string[],
      newTagSearch: '',
      tagSearchTimer: null as number | null,
      tagSearchLoading: false,
      currentTab: 0,
      cm: null as TextEditorHandle | null,
      rules: {
        required: (value: string) => !!value || 'This field is required.',
        path: (value: string) => {
          return filenamePattern.test(value) || 'Invalid path. Please ensure it does not contain special characters, or begin/end in a slash or hashtag string.'
        }
      }
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
        return wikiStore.page.title
      },
      set(value: string) {
        wikiStore.page.title = value
      }
    },
    description: {
      get() {
        return wikiStore.page.description
      },
      set(value: string) {
        wikiStore.page.description = value
      }
    },
    locale: {
      get() {
        return wikiStore.page.locale
      },
      set(value: string) {
        wikiStore.page.locale = value
      }
    },
    tags: {
      get() {
        return wikiStore.page.tags
      },
      set(value: string[]) {
        wikiStore.page.tags = _.uniq(value.map(tag => _.trim(tag).toLowerCase()).filter(Boolean))
      }
    },
    path: {
      get() {
        return wikiStore.page.path
      },
      set(value: string) {
        wikiStore.page.path = value
      }
    },
    isPublished: {
      get() {
        return wikiStore.page.isPublished
      },
      set(value: boolean) {
        wikiStore.page.isPublished = value
      }
    },
    privatePage: {
      get() {
        return wikiStore.page.visibility === 'private'
      },
      set(value: boolean) {
        if (
          !value &&
          this.mode !== 'create' &&
          wikiStore.page.visibility === 'private' &&
          !window.confirm('Publish this private page? It will become available through normal page permissions.')
        ) {
          return
        }
        wikiStore.page.visibility = value ? 'private' : 'public'
      }
    },
    publishStartDate: {
      get() {
        return wikiStore.page.publishStartDate
      },
      set(value: string) {
        wikiStore.page.publishStartDate = value
      }
    },
    publishEndDate: {
      get() {
        return wikiStore.page.publishEndDate
      },
      set(value: string) {
        wikiStore.page.publishEndDate = value
      }
    },
    scriptJs: {
      get() {
        return wikiStore.page.scriptJs
      },
      set(value: string) {
        wikiStore.page.scriptJs = value
      }
    },
    scriptCss: {
      get() {
        return wikiStore.page.scriptCss
      },
      set(value: string) {
        wikiStore.page.scriptCss = value
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
    }
  },
  watch: {
    modelValue (newValue: boolean) {
      if (newValue) {
        _.delay(() => {
          ;(this.$refs.iptTitle as { focus: () => void }).focus()
        }, 500)
      }
    },
    isPublishStartShown (newValue: boolean) {
      if (newValue) {
        this.publishStartDraft = parseDatePickerValue(this.publishStartDate)
      }
    },
    isPublishEndShown (newValue: boolean) {
      if (newValue) {
        this.publishEndDraft = parseDatePickerValue(this.publishEndDate)
      }
    },
    newTagSearch (newValue: string) {
      if (this.tagSearchTimer !== null) window.clearTimeout(this.tagSearchTimer)
      if (!this.modelValue || _.isEmpty(newValue)) {
        this.newTagSuggestions = []
        return
      }
      this.tagSearchTimer = window.setTimeout(() => this.loadTagSuggestions(newValue), 500)
    },
    currentTab (newValue: number) {
      if (this.cm) {
        this.cm.destroy()
      }
      if (newValue === 2) {
        this.$nextTick(() => {
          setTimeout(() => {
            this.loadEditor(this.$refs.codejs as HTMLElement, 'js')
          }, 100)
        })
      } else if (newValue === 3) {
        this.$nextTick(() => {
          setTimeout(() => {
            this.loadEditor(this.$refs.codecss as HTMLElement, 'css')
          }, 100)
        })
      }
    }
  },
  beforeUnmount() {
    if (this.tagSearchTimer !== null) window.clearTimeout(this.tagSearchTimer)
    this.cm?.destroy()
  },
  methods: {
    applyPublishStartDate() {
      this.publishStartDate = formatDatePickerValue(this.publishStartDraft)
      this.isPublishStartShown = false
    },
    applyPublishEndDate() {
      this.publishEndDate = formatDatePickerValue(this.publishEndDraft)
      this.isPublishEndShown = false
    },
    close() {
      this.isShown = false
    },
    showPathSelector() {
      this.pageSelectorShown = true
    },
    setPath({ path, locale }: { path: string, locale: string }) {
      this.locale = locale
      this.path = path
    },
    async loadTagSuggestions(query: string) {
      this.tagSearchLoading = true
      try {
        this.newTagSuggestions = await searchPageTags(window.fetch.bind(window), query)
      } catch (err) {
        console.warn(err)
        this.newTagSuggestions = []
      } finally {
        this.tagSearchLoading = false
      }
    },
    loadEditor(ref: HTMLElement, mode: 'js' | 'css') {
      const cm = new TextEditor({
        parent: ref,
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
      this.cm = cm
      ref.style.height = '500px'
      this.$nextTick(() => {
        cm.requestMeasure()
        cm.focus()
      })
    }
  }

})
</script>

<style lang='scss'>

.editor-props-codeeditor {
  background-color: mc('grey', '900');
  min-height: 500px;

  > textarea {
    visibility: hidden;
  }

  &-title {
    background-color: mc('grey', '900');
    border-bottom: 1px solid lighten(mc('grey', '900'), 10%);
    color: #FFF;
    padding: 10px;
  }

  &-hint {
    background-color: mc('grey', '900');
    border-top: 1px solid lighten(mc('grey', '900'), 5%);
    color: mc('grey', '500');
    padding: 5px 10px;
  }
}

</style>
