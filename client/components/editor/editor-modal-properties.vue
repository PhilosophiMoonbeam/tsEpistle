<template lang='pug'>
  v-dialog(
    v-model='isShown'
    persistent
    width='1000'
    :fullscreen='$vuetify.display.smAndDown'
    )
    .dialog-header
      v-icon(color='white') mdi-tag-text-outline
      .subtitle-1.white--text.ml-3 {{$t('editor:props.pageProperties')}}
      v-spacer
      v-btn.mx-0(
        outlined
        dark
        @click='close'
        )
        v-icon(left) mdi-check
        span {{ $t('common:actions.ok') }}
    v-card(tile)
      v-tabs(color='white', background-color='blue darken-1', dark, centered, v-model='currentTab')
        v-tab {{$t('editor:props.info')}}
        v-tab {{$t('editor:props.scheduling')}}
        v-tab(:disabled='!hasScriptPermission') {{$t('editor:props.scripts')}}
        //- v-tab(disabled) {{$t('editor:props.social')}}
        v-tab(:disabled='!hasStylePermission') {{$t('editor:props.styles')}}
        v-tab-item(transition='fade-transition', reverse-transition='fade-transition')
          v-card-text.pt-5
            .overline.pb-5 {{$t('editor:props.pageInfo')}}
            v-text-field(
              ref='iptTitle'
              outlined
              :label='$t(`editor:props.title`)'
              counter='255'
              v-model='title'
              )
            v-text-field(
              outlined
              :label='$t(`editor:props.shortDescription`)'
              counter='255'
              v-model='description'
              persistent-hint
              :hint='$t(`editor:props.shortDescriptionHint`)'
              )
          v-divider
          v-card-text.grey.pt-5(:class='$vuetify.theme.current.dark ? `darken-3-d3` : `lighten-5`')
            .overline.pb-5 {{$t('editor:props.path')}}
            v-container.pa-0(fluid, grid-list-lg)
              v-row()
                v-col(cols='12', md='2')
                  v-select(
                    outlined
                    :label='$t(`editor:props.locale`)'
                    suffix='/'
                    :items='namespaces'
                    v-model='locale'
                    hide-details
                  )
                v-col(cols='12', md='10')
                  v-text-field(
                    outlined
                    :label='$t(`editor:props.path`)'
                    append-icon='mdi-folder-search'
                    v-model='path'
                    :hint='$t(`editor:props.pathHint`)'
                    persistent-hint
                    @click:append='showPathSelector'
                    :rules='[rules.required, rules.path]'
                    )
          v-divider
          v-card-text.grey.pt-5(:class='$vuetify.theme.current.dark ? `darken-3-d5` : `lighten-4`')
            .overline.pb-5 {{$t('editor:props.categorization')}}
            v-chip-group.radius-5.mb-5(column, v-if='tags && tags.length > 0')
              v-chip(
                v-for='tag of tags'
                :key='`tag-` + tag'
                close
                label
                color='teal'
                text-color='teal lighten-5'
                @click:close='removeTag(tag)'
                ) {{tag}}
            v-combobox(
              :label='$t(`editor:props.tags`)'
              outlined
              v-model='newTag'
              :hint='$t(`editor:props.tagsHint`)'
              :items='newTagSuggestions'
              :loading='tagSearchLoading'
              persistent-hint
              hide-no-data
              v-model:search-input='newTagSearch'
              )
        v-tab-item(transition='fade-transition', reverse-transition='fade-transition')
          v-card-text
            .overline {{$t('editor:props.publishState')}}
            v-switch(
              :label='$t(`editor:props.publishToggle`)'
              v-model='isPublished'
              color='primary'
              :hint='$t(`editor:props.publishToggleHint`)'
              persistent-hint
              inset
              )
          v-divider
          v-card-text.grey.pt-5(:class='$vuetify.theme.current.dark ? `darken-3-d3` : `lighten-5`')
            v-container.pa-0(fluid, grid-list-lg)
              v-row
                v-col(cols='6')
                  v-dialog(
                    ref='menuPublishStart'
                    :close-on-content-click='false'
                    v-model='isPublishStartShown'
                    v-model:return-value='publishStartDate'
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
                        outlined
                        clearable
                        :hint='$t(`editor:props.publishStartHint`)'
                        persistent-hint
                        :disabled='!isPublished'
                        )
                    v-date-picker(
                      v-model='publishStartDate'
                      :min='(new Date()).toISOString().substring(0, 10)'
                      color='primary'
                      reactive
                      scrollable
                      landscape
                      )
                      v-spacer
                      v-btn(
                        text
                        color='primary'
                        @click='isPublishStartShown = false'
                        ) {{$t('common:actions.cancel')}}
                      v-btn(
                        text
                        color='primary'
                        @click='$refs.menuPublishStart.save(publishStartDate)'
                        ) {{$t('common:actions.ok')}}
                v-col(cols='6')
                  v-dialog(
                    ref='menuPublishEnd'
                    :close-on-content-click='false'
                    v-model='isPublishEndShown'
                    v-model:return-value='publishEndDate'
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
                        outlined
                        clearable
                        :hint='$t(`editor:props.publishEndHint`)'
                        persistent-hint
                        :disabled='!isPublished'
                        )
                    v-date-picker(
                      v-model='publishEndDate'
                      :min='(new Date()).toISOString().substring(0, 10)'
                      color='primary'
                      reactive
                      scrollable
                      landscape
                      )
                      v-spacer
                      v-btn(
                        text
                        color='primary'
                        @click='isPublishEndShown = false'
                        ) {{$t('common:actions.cancel')}}
                      v-btn(
                        text
                        color='primary'
                        @click='$refs.menuPublishEnd.save(publishEndDate)'
                        ) {{$t('common:actions.ok')}}

        v-tab-item(:transition='false', :reverse-transition='false')
          .editor-props-codeeditor-title
            .overline {{$t('editor:props.html')}}
          .editor-props-codeeditor
            div(ref='codejs')
          .editor-props-codeeditor-hint
            .caption {{$t('editor:props.htmlHint')}}

        //- v-tab-item(transition='fade-transition', reverse-transition='fade-transition')
        //-   v-card-text
        //-     .overline {{$t('editor:props.socialFeatures')}}
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

        v-tab-item(:transition='false', :reverse-transition='false')
          .editor-props-codeeditor-title
            .overline {{$t('editor:props.css')}}
          .editor-props-codeeditor
            div(ref='codecss')
          .editor-props-codeeditor-hint
            .caption {{$t('editor:props.cssHint')}}

    page-selector(:mode='pageSelectorMode', v-model='pageSelectorShown', :path='path', :locale='locale', :open-handler='setPath')
</template>

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
      pageSelectorShown: false,
      namespaces: siteLangs.length ? siteLangs.map(ns => ns.code) : [siteConfig.lang],
      newTag: '',
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
        wikiStore.page.tags = value
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
    newTagSearch (newValue: string) {
      if (this.tagSearchTimer !== null) window.clearTimeout(this.tagSearchTimer)
      if (!this.modelValue || _.isEmpty(newValue)) {
        this.newTagSuggestions = []
        return
      }
      this.tagSearchTimer = window.setTimeout(() => this.loadTagSuggestions(newValue), 500)
    },
    newTag (newValue: string) {
      const tagClean = _.trim(newValue || '').toLowerCase()
      if (tagClean && tagClean.length > 0) {
        if (!_.includes(this.tags, tagClean)) {
          this.tags = [...this.tags, tagClean]
        }
        this.$nextTick(() => {
          this.newTag = ''
        })
      }
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
    removeTag (tag: string) {
      this.tags = _.without(this.tags, tag)
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
