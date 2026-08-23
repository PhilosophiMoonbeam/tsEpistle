<template lang="pug">
  v-dialog(
    v-model='isShown'
    max-width='700'
    )
    v-card
      .dialog-header.is-short.is-indigo
        v-icon.mr-2(color='white') mdi-alert
        span {{$t('editor:conflict.title')}}
      v-card-text.pt-4
        i18next.text-body-medium(tag='div', path='editor:conflict.infoGeneric')
          strong(place='authorName') {{latest.authorName}}
          span(place='date', :title='$helpers.formatMoment(latest.updatedAt, `LLL`)') {{ $helpers.formatMoment(latest.updatedAt, 'from') }}.
        v-btn.mt-2(variant="outlined", color='indigo', size="small", :href='`/` + latest.locale + `/` + latest.path', target='_blank')
          v-icon(start) mdi-open-in-new
          span {{$t('editor:conflict.viewLatestVersion')}}
        .text-body-medium.mt-5: strong {{$t('editor:conflict.whatToDo')}}
        .text-body-medium.mt-1 #[v-icon(color='indigo') mdi-alpha-l-box] {{$t('editor:conflict.whatToDoLocal')}}
        .text-body-medium.mt-1 #[v-icon(color='indigo') mdi-alpha-r-box] {{$t('editor:conflict.whatToDoRemote')}}
      div.v-card-chin
        v-spacer
        v-btn(variant="text", @click='close') {{$t('common:actions.cancel')}}
        v-btn.px-4(color='indigo', @click='useLocal', :title='$t(`editor:conflict.useLocalHint`)')
          v-icon(start) mdi-alpha-l-box
          span {{$t('editor:conflict.useLocal')}}
        v-dialog(
          v-model='isRemoteConfirmDiagShown'
          width='500'
          )
          template(v-slot:activator='{ props }')
            v-btn.ml-3(color='indigo', v-bind='props', :title='$t(`editor:conflict.useRemoteHint`)')
              v-icon(start) mdi-alpha-r-box
              span {{$t('editor:conflict.useRemote')}}
          v-card
            .dialog-header.is-short.is-indigo
              v-icon.mr-3(color='white') mdi-alpha-r-box
              span {{$t('editor:conflict.overwrite.title')}}
            v-card-text.pa-4
              i18next.text-body-medium(tag='div', path='editor:conflict.overwrite.description')
                strong(place='refEditsLost') {{$t('editor:conflict.overwrite.editsLost')}}
            div.v-card-chin
              v-spacer
              v-btn(variant="outlined", color='indigo', @click='isRemoteConfirmDiagShown = false')
                v-icon(start) mdi-close
                span {{$t('common:actions.cancel')}}
              v-btn(@click='useRemote', color='indigo')
                v-icon(start) mdi-check
                span {{$t('common:actions.confirm')}}
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { wikiStore } from '@/store/index.ts'
import { showNotification } from '../../../helpers/root-ui-store'
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
      isRemoteConfirmDiagShown: false
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
      wikiStore.editor.checkoutDateActive = this.latest.updatedAt
      emitEditorConflictReset()
      this.close()
    },
    useRemote () {
      wikiStore.editor.checkoutDateActive = this.latest.updatedAt
      wikiStore.editor.content = this.latest.content
      emitEditorConflictResolved()
      this.close()
    }
  },
  async mounted () {
    let resp: PageConflictLatest | null = null
    try {
      resp = await fetchPageConflictLatest(window.fetch.bind(window), wikiStore.page.id)
    } catch {
      // The warning below is the user-facing error state.
    }

    if (!resp) {
      return showNotification(wikiStore, {
        message: 'Failed to fetch latest version.',
        style: 'warning',
        icon: 'warning'
      })
    }
    this.latest = resp
  }
})
</script>
