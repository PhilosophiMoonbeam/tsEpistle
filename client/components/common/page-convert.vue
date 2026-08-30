<template lang='pug'>
  v-dialog(
    v-model='isShown'
    max-width='550'
    persistent
    scrim='blue-grey-darken-4'
    style='--v-overlay-opacity: .7'
    aria-labelledby='page-convert-dialog-title'
    )
    v-card
      .dialog-header.is-short.is-dark
        v-icon.mr-2(color='white') mdi-lightning-bolt
        span#page-convert-dialog-title {{$t('common:page.convert')}}
      v-card-text.pt-5
        i18next.text-body-medium(path='common:page.convertTitle', tag='div')
          span.text-blue-grey-darken-2(place='title') {{pageTitle}}
        v-select.mt-5(
          :items=`[
            { value: 'markdown', title: 'Markdown' },
            { value: 'visual-markdown', title: 'Visual Markdown' },
            { value: 'ckeditor', title: 'Visual Editor (HTML)' },
            { value: 'code', title: 'Raw HTML' }
          ]`
          variant="outlined"
          density="compact"
          hide-details
          label='New editor'
          v-model='newEditor'
        )
        v-alert.mt-5(
          color='warning'
          variant='tonal'
          density='compact'
        ) {{$t('common:page.convertSubtitle')}}
      v-card-chin
        v-spacer
        v-btn(variant="text", @click='discard', :disabled='loading') {{$t('common:actions.cancel')}}
        v-btn.px-4(
          color="warning"
          variant="flat"
          @click='convertPage'
          :loading='loading'
          :disabled='loading || !canConvert'
        ) {{$t('common:actions.convert')}}
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
    pageEditor(): string { return wikiStore.page.editor },
    pageSourceRevision(): string { return wikiStore.page.sourceRevision },
    canConvert(): boolean { return Boolean(this.newEditor) && this.newEditor !== this.pageEditor }
  },
  watch: {
    isShown(newValue: boolean) {
      if (newValue) this.newEditor = this.pageEditor
    }
  },
  methods: {
    discard(): void {
      this.isShown = false
    },
    async convertPage(): Promise<void> {
      if (!this.canConvert) return

      this.loading = true
      wikiStore.startLoading('page-convert')
      try {
        await this.$nextTick()
        await convertPage(window.fetch.bind(window), this.pageId, this.newEditor, this.pageSourceRevision)
        this.isShown = false
        window.location.assign(`/e/${this.pageLocale}/${this.pagePath}`)
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('page-convert')
        this.loading = false
      }
    }
  }
})
</script>

<style lang='scss'>

</style>
