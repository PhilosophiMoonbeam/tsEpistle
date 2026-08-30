<template lang='pug'>
  v-dialog(
    v-model='isShown'
    max-width='550'
    persistent
    scrim='red-darken-4'
    style='--v-overlay-opacity: .7'
    aria-labelledby='page-delete-dialog-title'
    )
    v-card
      .dialog-header.is-short.is-red
        v-icon.mr-2(color='white') mdi-file-document-box-remove-outline
        span#page-delete-dialog-title {{$t('common:page.delete')}}
      v-card-text.pt-5
        i18next.text-body-large(path='common:page.deleteTitle', tag='div')
          span.text-red-darken-2(place='title') {{pageTitle}}
        .text-body-small {{$t('common:page.deleteSubtitle')}}
        .page-delete__metadata
          v-chip.page-delete__locale(label, color="red-lighten-4", size="small")
            .text-body-small.text-red-darken-2 {{pageLocale.toUpperCase()}}
          v-chip.page-delete__path(label, color="red-lighten-5", size="small", :title='`/${pagePath}`', :aria-label='`/${pagePath}`')
            span.text-red-darken-2 /{{pagePath}}
      v-card-chin
        v-spacer
        v-btn(variant="text", @click='discard', :disabled='loading') {{$t('common:actions.cancel')}}
        v-btn.px-4(color="red-darken-2", @click='deletePage', :loading='loading').text-white {{$t('common:actions.delete')}}
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
    pageId(): number { return wikiStore.page.id },
    pageSourceRevision(): string { return wikiStore.page.sourceRevision }
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
            this.pageSourceRevision,
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
    height: 100dvh;
    overflow: hidden;

    .v-application {
      background-color: rgb(var(--v-theme-background));
    }
    .v-application__wrap {
      transform-style: preserve-3d;
      transform: translateZ(-5vw) rotateX(2deg);
      border-radius: var(--wiki-panel-radius);
      overflow: hidden;
    }
  }
  body.page-deleted {
    perspective: 50vw;

    .v-application__wrap {
      transform-style: preserve-3d;
      transform: translateZ(-1000vw) rotateX(60deg);
      opacity: 0;
    }
  }

  .page-delete__metadata {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    gap: var(--wiki-space-2);
    margin-block-start: var(--wiki-space-3);
  }

  .page-delete__locale,
  .page-delete__path {
    margin: 0;
  }

  .page-delete__path {
    min-width: 0;
    max-width: 100%;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 399.98px) {
    .page-delete__path {
      flex-basis: 100%;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    body.page-deleted-pending {
      perspective: none;

      .v-application__wrap {
        transform: none;
        transition: none;
      }
    }

    body.page-deleted {
      perspective: none;

      .v-application__wrap {
        transform: none;
        transition: none;
        opacity: 0;
      }
    }
  }
</style>
