<template lang='pug'>
  v-dialog(
    v-model='isShown'
    max-width='550'
    persistent
    overlay-color='blue-grey darken-4'
    overlay-opacity='.7'
    )
    v-card
      .dialog-header.is-short.is-dark
        v-icon.mr-2(color='white') mdi-lightning-bolt
        span {{$t('common:page.convert')}}
      v-card-text.pt-5
        i18next.body-2(path='common:page.convertTitle', tag='div')
          span.blue-grey--text.text--darken-2(place='title') {{pageTitle}}
        v-select.mt-5(
          :items=`[
            { value: 'markdown', text: 'Markdown' },
            { value: 'ckeditor', text: 'Visual Editor' },
            { value: 'code', text: 'Raw HTML' }
          ]`
          outlined
          dense
          hide-details
          v-model='newEditor'
        )
        .caption.mt-5 {{$t('common:page.convertSubtitle')}}
      div.v-card-chin
        v-spacer
        v-btn(text, @click='discard', :disabled='loading') {{$t('common:actions.cancel')}}
        v-btn.px-4(color='grey darken-3', @click='convertPage', :loading='loading').white--text {{$t('common:actions.convert')}}
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { wikiStore } from '@/store/index.ts'
import { convertPage } from '../../helpers/pages-api'

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
      loading: false,
      newEditor: ''
    }
  },
  computed: {
    isShown: {
      get(): boolean { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    },
    pageTitle(): string { return wikiStore.page.title },
    pagePath(): string { return wikiStore.page.path },
    pageLocale(): string { return wikiStore.page.locale },
    pageId(): number { return wikiStore.page.id },
    pageEditor(): string { return wikiStore.page.editor }
  },
  mounted () {
    this.newEditor = this.pageEditor
  },
  methods: {
    discard(): void {
      this.isShown = false
    },
    async convertPage(): Promise<void> {
      this.loading = true
      wikiStore.startLoading('page-convert')
      this.$nextTick(async () => {
        try {
          await convertPage(window.fetch.bind(window), this.pageId, this.newEditor)
          this.isShown = false
          window.location.assign(`/e/${this.pageLocale}/${this.pagePath}`)
        } catch (err) {
          wikiStore.showError(err)
        }
        wikiStore.stopLoading('page-convert')
        this.loading = false
      })
    }
  }
})
</script>

<style lang='scss'>

</style>
