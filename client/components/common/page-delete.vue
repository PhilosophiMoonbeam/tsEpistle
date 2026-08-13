<template lang='pug'>
  v-dialog(
    v-model='isShown'
    max-width='550'
    persistent
    overlay-color='red darken-4'
    overlay-opacity='.7'
    )
    v-card
      .dialog-header.is-short.is-red
        v-icon.mr-2(color='white') mdi-file-document-box-remove-outline
        span {{$t('common:page.delete')}}
      v-card-text.pt-5
        i18next.body-1(path='common:page.deleteTitle', tag='div')
          span.red--text.text--darken-2(place='title') {{pageTitle}}
        .caption {{$t('common:page.deleteSubtitle')}}
        v-chip.mt-3.ml-0.mr-1(label, color='red lighten-4', small)
          .caption.red--text.text--darken-2 {{pageLocale.toUpperCase()}}
        v-chip.mt-3.mx-0(label, color='red lighten-5', small)
          span.red--text.text--darken-2 /{{pagePath}}
      div.v-card-chin
        v-spacer
        v-btn(text, @click='discard', :disabled='loading') {{$t('common:actions.cancel')}}
        v-btn.px-4(color='red darken-2', @click='deletePage', :loading='loading').white--text {{$t('common:actions.delete')}}
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'

import { deletePage as deletePageById } from '../../helpers/pages-api'

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
      loading: false
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
    pageId(): number { return wikiStore.page.id }
  },
  watch: {
    isShown(newValue: boolean) {
      if (newValue) {
        document.body.classList.add('page-deleted-pending')
      }
    }
  },
  methods: {
    discard(): void {
      document.body.classList.remove('page-deleted-pending')
      this.isShown = false
    },
    async deletePage(): Promise<void> {
      this.loading = true
      wikiStore.startLoading('page-delete')
      this.$nextTick(async () => {
        try {
          await deletePageById(
            window.fetch.bind(window),
            this.pageId,
            this.$t('common:error.unexpected')
          )
          this.isShown = false
          _.delay(() => {
            document.body.classList.add('page-deleted')
            _.delay(() => {
              window.location.assign('/')
            }, 1200)
          }, 400)
        } catch (err) {
          wikiStore.showError(err)
        }
        wikiStore.stopLoading('page-delete')
        this.loading = false
      })
    }
  }
})
</script>

<style lang='scss'>
  body.page-deleted-pending {
    perspective: 50vw;
    height: 100vh;
    overflow: hidden;

    .application {
      background-color: mc('grey', '900');
    }
    .application--wrap {
      transform-style: preserve-3d;
      transform: translateZ(-5vw) rotateX(2deg);
      border-radius: 7px;
      overflow: hidden;
    }
  }
  body.page-deleted {
    perspective: 50vw;

    .application--wrap {
      transform-style: preserve-3d;
      transform: translateZ(-1000vw) rotateX(60deg);
      opacity: 0;
    }
  }
</style>
