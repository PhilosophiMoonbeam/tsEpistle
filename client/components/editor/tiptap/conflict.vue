<template lang="pug">
  v-dialog(
    v-model='isShown'
    max-width='700'
    aria-labelledby='editor-conflict-title'
    persistent
    )
    v-card
      .dialog-header.is-short.is-indigo
        v-icon.mr-2(color='white') mdi-alert
        span#editor-conflict-title {{$t('editor:conflict.title')}}
      v-card-text.pt-4(:aria-busy='loadState === `loading`')
        .d-flex.align-center.py-4(
          v-if='loadState === `loading`'
          role='status'
          aria-live='polite'
          )
          v-progress-circular.mr-3(indeterminate, color='indigo', size='24', aria-hidden='true')
          span.text-body-medium Loading latest version…
        v-alert(
          v-else-if='loadState === `error`'
          ref='loadErrorAlert'
          type='error'
          variant='tonal'
          role='alert'
          tabindex='-1'
          )
          .text-body-medium {{loadError}}
          v-btn.mt-3(
            variant='outlined'
            color='error'
            size='small'
            :disabled='loadState === `loading`'
            :loading='loadState === `loading`'
            @click='loadLatestVersion'
            ) Retry
        template(v-else-if='loadState === `success`')
          i18next.text-body-medium(tag='div', path='editor:conflict.infoGeneric')
            strong(place='authorName') {{latest.authorName}}
            span(place='date', :title='$helpers.formatMoment(latest.updatedAt, `LLL`)') {{ $helpers.formatMoment(latest.updatedAt, 'from') }}.
          v-btn.mt-2(variant="outlined", color='indigo', size="small", :href='`/` + latest.locale + `/` + latest.path', target='_blank', rel='noopener', :disabled='!hasLatestVersion')
            v-icon(start) mdi-open-in-new
            span {{$t('editor:conflict.viewLatestVersion')}}
          .text-body-medium.mt-5: strong {{$t('editor:conflict.whatToDo')}}
          .text-body-medium.mt-1 #[v-icon(color='indigo') mdi-alpha-l-box] {{$t('editor:conflict.whatToDoLocal')}}
          .text-body-medium.mt-1 #[v-icon(color='indigo') mdi-alpha-r-box] {{$t('editor:conflict.whatToDoRemote')}}
      v-card-chin
        v-spacer
        v-btn(variant="text", @click='close') {{$t('common:actions.cancel')}}
        template(v-if='loadState === `success` && hasLatestVersion')
          v-btn.px-4(color='indigo', @click='useLocal', :title='$t(`editor:conflict.useLocalHint`)')
            v-icon(start) mdi-alpha-l-box
            span {{$t('editor:conflict.useLocal')}}
          v-dialog(
            v-model='isRemoteConfirmDiagShown'
            width='500'
            aria-labelledby='editor-conflict-overwrite-title'
            )
            template(v-slot:activator='{ props }')
              v-btn.ml-3(color='indigo', v-bind='props', :title='$t(`editor:conflict.useRemoteHint`)')
                v-icon(start) mdi-alpha-r-box
                span {{$t('editor:conflict.useRemote')}}
            v-card
              .dialog-header.is-short.is-indigo
                v-icon.mr-3(color='white') mdi-alpha-r-box
                span#editor-conflict-overwrite-title {{$t('editor:conflict.overwrite.title')}}
              v-card-text.pa-4
                i18next.text-body-medium(tag='div', path='editor:conflict.overwrite.description')
                  strong(place='refEditsLost') {{$t('editor:conflict.overwrite.editsLost')}}
              v-card-chin
                v-spacer
                v-btn(variant="outlined", color='indigo', @click='isRemoteConfirmDiagShown = false')
                  v-icon(start) mdi-close
                  span {{$t('common:actions.cancel')}}
                v-btn(@click='useRemote', color='indigo')
                  v-icon(start) mdi-check
                  span {{$t('common:actions.confirm')}}
</template>

<script lang='ts'>
import { defineComponent, markRaw } from 'vue'
import { wikiStore } from '@/store/index.ts'

import { emitEditorConflictReset, emitEditorConflictResolved } from '../../../helpers/editor-conflict-events'
import { fetchPageConflictLatest, type PageConflictLatest } from '../../../helpers/pages-api'

export default defineComponent({
  emits: ['update:modelValue'],
  props: {
    modelValue: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      latest: {
        updatedAt: '',
        authorName: '',
        content: '',
        locale: '',
        path: '',
        title: '',
        description: ''
      } as PageConflictLatest,
      isRemoteConfirmDiagShown: false,
      hasLatestVersion: false,
      requestController: null as AbortController | null,
      loadState: 'loading' as 'loading' | 'error' | 'success',
      loadError: '',
      requestGeneration: 0
    }
  },
  computed: {
    isShown: {
      get() { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    }
  },
  methods: {
    close () {
      this.isShown = false
    },
    useLocal () {
      if (!this.hasLatestVersion) return
      wikiStore.editor.checkoutDateActive = this.latest.updatedAt
      emitEditorConflictReset()
      this.close()
    },
    useRemote () {
      if (!this.hasLatestVersion) return
      wikiStore.editor.checkoutDateActive = this.latest.updatedAt
      wikiStore.editor.content = this.latest.content
      emitEditorConflictResolved()
      this.close()
    },
    focusLoadError () {
      const alert = this.$refs.loadErrorAlert as HTMLElement | { $el?: HTMLElement } | undefined
      const element = alert instanceof HTMLElement ? alert : alert?.$el
      element?.focus()
    },
    async loadLatestVersion () {
      if (this.loadState === 'loading' && this.requestController) return
      this.requestController?.abort()
      const requestGeneration = ++this.requestGeneration
      const requestController = markRaw(new AbortController())
      this.requestController = requestController
      this.loadState = 'loading'
      this.loadError = ''
      this.hasLatestVersion = false
      let resp: PageConflictLatest | null = null
      try {
        resp = await fetchPageConflictLatest(
          (url, init) => window.fetch(url, { ...init, signal: requestController.signal }),
          wikiStore.page.id
        )
      } catch {
        if (requestController.signal.aborted) return
      }

      if (requestController.signal.aborted) return
      if (requestGeneration !== this.requestGeneration) return
      this.requestController = null
      if (!resp) {
        this.loadError = 'Failed to fetch latest version.'
        this.loadState = 'error'
        await this.$nextTick()
        if (requestGeneration === this.requestGeneration && this.loadState === 'error') {
          this.focusLoadError()
        }
        return
      }
      this.latest = resp
      this.hasLatestVersion = true
      this.loadState = 'success'
    }
  },
  async mounted () {
    await this.loadLatestVersion()
  },
  beforeUnmount () {
    this.requestGeneration += 1
    this.requestController?.abort()
    this.requestController = null
  }
})
</script>
