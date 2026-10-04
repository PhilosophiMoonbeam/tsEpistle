<template lang='pug'>
  v-app.notfound-app
    nav-header
    v-main
      main.notfound(aria-labelledby='notfound-title')
        .notfound-content
          .newpage-mark(aria-hidden='true')
            img(src='/_assets/svg/icon-delete-file.svg', alt='')
          header.newpage-copy
            h1#notfound-title.text-headline-medium.ma-0 {{$t('notfound.title')}}
            p.text-body-large.mt-3 {{$t('notfound.subtitle')}}
          .newpage-path(v-if='requestedPath')
            v-icon(size='small', aria-hidden='true') mdi-map-marker-question-outline
            code
              bdi(dir='ltr') {{ requestedPath }}
          .newpage-actions(role='group', :aria-label='$t(`notfound.actions`)')
            v-btn.newpage-action.newpage-action--create(
              v-if='editorHref'
              :href='editorHref'
              size='large'
              color='primary'
              variant='flat'
              prepend-icon='mdi-plus'
            ) {{$t('notfound.create')}}
            v-btn.newpage-action(
              :class='editorHref ? `newpage-action--back` : `newpage-action--create`'
              size='large'
              color='primary'
              :variant='editorHref ? `outlined` : `flat`'
              prepend-icon='mdi-magnify'
              @click='searchWiki'
            ) {{$t('notfound.search')}}
            v-btn.newpage-action.newpage-action--back(
              href='/'
              size='large'
              color='primary'
              variant='outlined'
              prepend-icon='mdi-home-outline'
            ) {{$t('notfound.gohome')}}
            v-btn.newpage-action.newpage-action--back(
              size='large'
              color='primary'
              variant='outlined'
              :prepend-icon='$vuetify.locale.isRtl ? "mdi-arrow-right" : "mdi-arrow-left"'
              @click='goBack'
            ) {{$t('notfound.goback')}}
    search-results
</template>

<script setup lang='ts'>
import { computed, nextTick } from 'vue'
import { emitSearchFocus } from '../helpers/search-navigation-events'
import { goBackOrHome, safeEditorHref, searchQueryFromPath } from '../helpers/state-page-actions'
import { wikiStore } from '../store/index.ts'

const { createHref = '' } = defineProps<{
  /** Set by the server only when the signed-in user may create a page at this path. */
  createHref?: string
}>()

const requestedPath = typeof window === 'undefined' ? '' : safeDecode(window.location.pathname)
const editorHref = computed(() => safeEditorHref(createHref))

function safeDecode (value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function knownLocales (): string[] {
  const codes = Array.isArray(window.siteLangs) ? window.siteLangs.map(lang => lang.code) : []
  const current = window.siteConfig?.lang
  return typeof current === 'string' && current ? [...codes, current] : codes
}

// Seed the header search with words from the missing path, then focus it.
const searchWiki = async (): Promise<void> => {
  wikiStore.site.search = searchQueryFromPath(requestedPath, knownLocales())
  await nextTick()
  emitSearchFocus()
}

const goBack = (): void => goBackOrHome('/')
</script>
