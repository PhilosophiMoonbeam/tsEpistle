<template lang='pug'>
  v-app.tags
    nav-header(mobile-actions)
      template(v-slot:actions)
        v-btn.tags-filter-toggle(
          v-if='$vuetify.display.smAndDown'
          icon
          data-search-modal-action
          @click='tagDrawerShown = !tagDrawerShown'
          :aria-expanded='tagDrawerShown'
          aria-controls='tag-navigation'
          :aria-label='$t(`common:header.browseTags`)'
        )
          v-icon mdi-tag-multiple-outline
    v-navigation-drawer#tag-navigation.tags-sidebar(
      :model-value='$vuetify.display.mdAndUp || tagDrawerShown'
      @update:model-value='tagDrawerShown = $event'
      location='start'
      :permanent='$vuetify.display.mdAndUp'
      :temporary='$vuetify.display.smAndDown'
      width='300'
      color='surface'
    )
      .tags-sidebar-header
        .tags-sidebar-icon
          v-icon(size='22') mdi-tag-multiple-outline
        div
          .tags-sidebar-eyebrow Explore
          .tags-sidebar-title {{$t('common:header.browseTags')}}
        v-spacer
        v-btn(
          v-if='$vuetify.display.smAndDown'
          icon
          size='small'
          @click='tagDrawerShown = false'
          aria-label='Close tag navigation'
        )
          v-icon mdi-close
      vue-scroll(:ops='scrollStyle')
        async-state(
          v-if='tagsLoading && tags.length === 0'
          state='loading'
          title='Loading tags'
        )
        async-state(
          v-else-if='tagsError'
          state='error'
          title='Tags could not be loaded'
          :message='tagsError'
          retry-label='Try again'
          @retry='loadTags'
        )
        async-state(
          v-else-if='tags.length === 0'
          state='empty'
          title='No tags available'
          message='There are no tags to browse yet.'
        )
        nav.tags-navigation(
          v-else
          :aria-label='$t(`common:header.browseTags`)'
        )
          v-list(density='compact' nav role='presentation')
            v-list-item.tags-home-link(to='/' color='primary')
              template(v-slot:prepend): v-icon mdi-home-outline
              v-list-item-title {{$t('common:header.home')}}
            template(v-for='(tagGroup, groupName) in tagsGrouped', :key='`tagGroup-` + groupName')
              v-list-subheader {{groupName}}
              v-list-item.tags-nav-item(
                v-for='tag of tagGroup'
                link
                role='button'
                :aria-pressed='isSelected(tag.tag)'
                @click='toggleTag(tag.tag)'
                :key='`tag-` + tag.tag'
                :active='isSelected(tag.tag)'
                color='primary'
              )
                template(v-slot:prepend)
                  v-icon(size='18') {{ isSelected(tag.tag) ? 'mdi-check-circle' : 'mdi-tag-outline' }}
                v-list-item-title {{tag.title}}
                
    v-main.tags-main
      v-container.tags-shell(fluid)
        section.tags-hero
          .tags-hero-copy
            .tags-eyebrow
              v-icon(size='16') mdi-compass-outline
              span Knowledge map
            h1 {{$t('common:header.browseTags')}}
            p {{$t('tags:selectOneMoreTags')}}
          .tags-hero-art(aria-hidden='true')
            v-icon(size='64') mdi-tag-multiple-outline

        section.tags-selection(v-if='selection.length > 0' aria-label='Selected tags')
          .tags-selection-label
            span {{$t('tags:currentSelection')}}
            v-btn(
              size='small'
              variant='text'
              color='primary'
              @click='clearSelection'
            )
              v-icon(start size='17') mdi-close
              span {{$t('tags:clearSelection')}}
          .tags-selection-chips
            v-chip(
              v-for='tag of tagsSelected'
              :key='`tagSelected-` + tag.tag'
              color='primary'
              variant='tonal'
              closable
              @click:close='toggleTag(tag.tag)'
            ) {{tag.title}}

        section.tags-controls(v-if='selection.length > 0' aria-label='Filter tagged pages')
          v-text-field.tags-search(
            v-model='innerSearch'
            :label='$t(`tags:searchWithinResultsPlaceholder`)'
            variant='outlined'
            hide-details
            clearable
            prepend-inner-icon='mdi-magnify'
          )
          .tags-controls-options
            v-select(
              v-if='locales.length > 1'
              :items='locales'
              v-model='locale'
              :label='$t(`tags:locale`)'
              item-title='name'
              item-value='code'
              variant='outlined'
              hide-details
              density='comfortable'
            )
            v-select(
              :items='orderByItems'
              v-model='orderBy'
              :label='$t(`tags:orderBy`)'
              variant='outlined'
              hide-details
              density='comfortable'
            )
            v-btn-toggle.tags-sort-direction(v-model='orderByDirection' mandatory color='primary' variant='outlined')
              v-btn(:value='0' aria-label='Sort ascending')
                v-icon(size='20') mdi-sort-ascending
              v-btn(:value='1' aria-label='Sort descending')
                v-icon(size='20') mdi-sort-descending

        section.tags-empty(v-if='selection.length < 1')
          .tags-empty-icon
            v-icon(size='42') mdi-tag-arrow-right-outline
          h2 {{$t('tags:selectOneMoreTags')}}
          p Choose tags to discover related pages.
          v-btn(
            v-if='$vuetify.display.smAndDown'
            color='primary'
            variant='tonal'
            @click='tagDrawerShown = true'
          )
            v-icon(start) mdi-tag-multiple-outline
            span {{$t('common:header.browseTags')}}

        section.tags-results(v-else aria-live='polite')
          v-data-iterator(
            :items='pages'
            :items-per-page='pagination.itemsPerPage'
            :search='innerSearch'
            :loading='isLoading'
            v-model:page='pagination.page'
            :sort-by='pagination.sortBy'
            must-sort
          )
            template(v-slot:loader)
              .tags-state
                v-progress-circular(
                  indeterminate
                  color='primary'
                  size='64'
                  width='3'
                  :aria-label='$t(`tags:retrievingResultsLoading`)'
                )
                h2 {{$t('tags:retrievingResultsLoading')}}
            template(v-slot:no-data)
              async-state(
                v-if='pagesError'
                state='error'
                title='Tagged pages could not be loaded'
                :message='pagesError'
                retry-label='Try again'
                @retry='loadPages'
              )
              .tags-state(v-else-if='innerSearch')
                v-icon(size='48' color='primary') mdi-text-search
                h2 {{$t('tags:noResultsWithFilter')}}
                p Try a different search or clear the filter.
                v-btn(color='primary' variant='tonal' @click='innerSearch = ""')
                  v-icon(start) mdi-close
                  span Clear search
              .tags-state(v-else)
                v-icon(size='48' color='primary') mdi-file-search-outline
                h2 {{$t('tags:noResults')}}
                p Adjust your selected tags to find pages.
                v-btn(color='primary' variant='tonal' @click='clearSelection')
                  v-icon(start) mdi-filter-remove-outline
                  span {{$t('tags:clearSelection')}}
            template(v-slot:default='props')
              .tags-result-grid
                article(v-for='entry of props.items' :key='`page-` + entry.raw.id')
                  v-card.tags-result-card(
                    :to='`/${entry.raw.locale}/${entry.raw.path}`'
                    variant='flat'
                  )
                    v-card-text
                      .tags-result-topline
                        v-chip(size='x-small' color='primary' variant='tonal') {{entry.raw.locale}}
                        span {{ $helpers.formatMoment(entry.raw.updatedAt, 'from') }}
                      h2 {{entry.raw.title}}
                      p {{entry.raw.description || 'No description available.'}}
                      .tags-result-path
                        v-icon(size='17') mdi-file-tree-outline
                        bdi(dir='ltr') /{{entry.raw.path}}
                        v-icon.tags-result-arrow(size='18') {{ $vuetify.locale.isRtl ? 'mdi-arrow-left' : 'mdi-arrow-right' }}
            template(v-slot:footer='{ pageCount }')
              .tags-pagination(v-if='pageCount > 1')
                v-pagination(v-model='pagination.page' :length='pageCount')

    nav-footer
    notify
    search-results
</template>

<script lang='ts'>
import { markRaw } from 'vue'

import { fetchPages, fetchPageTags, type PageListRow, type PageTagRow } from '../helpers/pages-api'
import { setLoading } from '../helpers/root-ui-store'
import AsyncState from '@/components/common/async-state.vue'
import { pathFromTagSelection, tagSelectionFromPath } from '../helpers/tag-navigation'
import { wikiStore } from '@/store/index.ts'

/* global siteLangs */

type TagLocale = {
  name: string
  code: string
}

type TagSortKey = 'createdAt' | 'id' | 'updatedAt' | 'path' | 'title'

function normalizeSortKey (value: unknown): TagSortKey {
  switch (normalizeQueryValue(value)?.toLocaleLowerCase()) {
    case 'createdat':
      return 'createdAt'
    case 'id':
      return 'id'
    case 'updatedat':
      return 'updatedAt'
    case 'path':
      return 'path'
    default:
      return 'title'
  }
}

function normalizeQueryValue (value: unknown): string | undefined {
  const normalized = Array.isArray(value) ? value[0] : value
  return typeof normalized === 'string' && normalized.length > 0 ? normalized : undefined
}


export default {
  components: {
    AsyncState
  },
  i18nOptions: { namespaces: 'tags' },
  data() {
    return {
      tags: [] as PageTagRow[],
      selection: [] as string[],
      tagDrawerShown: false,
      innerSearch: '',
      locale: 'any',
      locales: [] as TagLocale[],
      orderBy: 'title' as TagSortKey,
      orderByDirection: 0,
      routeSyncReady: false,
      pagination: {
        page: 1,
        itemsPerPage: 12,
        sortBy: [{ key: 'title', order: 'asc' as 'asc' | 'desc' }]
      },
      pages: [] as PageListRow[],
      tagsLoading: true,
      tagsError: '',
      pagesError: '',
      isLoading: true,
      pagesLoadSequence: 0,
      scrollStyle: {
        scrollPanel: {
          scrollingX: false
        }
      }
    }
  },
  computed: {
    tagsGrouped () {
      return this.tags.reduce<Record<string, PageTagRow[]>>((groups, tag) => {
        const groupName = (tag.title ?? '').charAt(0).toUpperCase()
        ;(groups[groupName] ??= []).push(tag)
        return groups
      }, {})
    },
    tagsSelected () {
      return this.tags.filter((tag: PageTagRow) => this.selection.includes(tag.tag))
    },
    orderByItems () {
      return [
        { title: this.$t('tags:orderByField.creationDate'), value: 'createdAt' },
        { title: this.$t('tags:orderByField.ID'), value: 'id' },
        { title: this.$t('tags:orderByField.lastModified'), value: 'updatedAt' },
        { title: this.$t('tags:orderByField.path'), value: 'path' },
        { title: this.$t('tags:orderByField.title'), value: 'title' }
      ]
    }
  },
  watch: {
    locale () {
      if (this.routeSyncReady) this.rebuildURL()
    },
    orderBy (newValue: TagSortKey) {
      if (!this.routeSyncReady) return
      this.pagination.sortBy = [{ key: newValue, order: this.orderByDirection === 0 ? 'asc' : 'desc' }]
      this.rebuildURL()
    },
    orderByDirection (newValue: number) {
      if (!this.routeSyncReady) return
      this.pagination.sortBy = [{ key: this.orderBy, order: newValue === 0 ? 'asc' : 'desc' }]
      this.rebuildURL()
    },
    innerSearch () {
      this.pagination.page = 1
    },
    '$route.fullPath' () {
      this.routeSyncReady = false
      this.syncRouteState()
      this.loadPages()
      this.$nextTick(() => {
        this.routeSyncReady = true
      })
      if (this.$vuetify.display.smAndDown) {
        this.tagDrawerShown = false
      }
    }
  },
  created () {
    wikiStore.page.mode = 'tags'
    this.selection = tagSelectionFromPath(this.$route.path)
  },
  mounted () {
    this.locales = [
      { name: this.$t('tags:localeAny'), code: 'any' },
      ...siteLangs
    ]
    this.syncRouteState()
    this.loadTags()
    this.loadPages()
    this.$nextTick(() => {
      this.routeSyncReady = true
    })
  },
  methods: {
    syncRouteState () {
      this.selection = tagSelectionFromPath(this.$route.path)
      this.locale = normalizeQueryValue(this.$route.query.lang) ?? 'any'
      this.orderBy = normalizeSortKey(this.$route.query.sort)
      this.orderByDirection = normalizeQueryValue(this.$route.query.dir) === 'desc' ? 1 : 0
      this.pagination.sortBy = [{
        key: this.orderBy,
        order: this.orderByDirection === 0 ? 'asc' : 'desc'
      }]
      this.pagination.page = 1
    },
    toggleTag (tag: string) {
      this.selection = this.selection.includes(tag)
        ? this.selection.filter(selectedTag => selectedTag !== tag)
        : [...this.selection, tag]
      this.rebuildURL()
    },
    clearSelection () {
      this.selection = []
      this.rebuildURL()
    },
    isSelected (tag: string) {
      return this.selection.includes(tag)
    },
    rebuildURL () {
      const query: Record<string, string> = {}
      if (this.locale !== `any`) {
        query.lang = this.locale
      }
      if (this.orderBy !== `title`) {
        query.sort = this.orderBy.toLowerCase()
      }
      if (this.orderByDirection !== 0) {
        query.dir = `desc`
      }
      this.$router.push({
        path: pathFromTagSelection(this.selection),
        query
      })
    },
    async loadTags () {
      this.tagsLoading = true
      this.tagsError = ''
      setLoading(wikiStore, 'tags-refresh', true)
      try {
        this.tags = markRaw(await fetchPageTags(window.fetch.bind(window)))
      } catch (err) {
        this.tagsError = err instanceof Error ? err.message : 'Unable to load tags.'
      } finally {
        this.tagsLoading = false
        setLoading(wikiStore, 'tags-refresh', false)
      }
    },
    async loadPages () {
      const sequence = ++this.pagesLoadSequence
      const loadingKey = `pages-refresh-${sequence}`
      this.pagesError = ''
      if (this.selection.length < 1) {
        this.pages = []
        this.isLoading = false
        return
      }
      this.isLoading = true
      setLoading(wikiStore, loadingKey, true)
      try {
        const pages = await fetchPages(window.fetch.bind(window), {
          locale: this.locale === 'any' ? undefined : this.locale,
          tags: this.selection
        })
        if (sequence === this.pagesLoadSequence) this.pages = markRaw(pages)
      } catch (err) {
        if (sequence !== this.pagesLoadSequence) return
        this.pages = []
        this.pagesError = err instanceof Error ? err.message : 'Unable to load tagged pages.'
      } finally {
        if (sequence === this.pagesLoadSequence) this.isLoading = false
        setLoading(wikiStore, loadingKey, false)
      }
    },
  }

}
</script>

<style lang='scss'>
.tags {
  font-family: var(--wiki-font-body);
}

.tags-sidebar {
  border-inline-end: 1px solid rgba(var(--v-border-color), .11) !important;
  background:
    linear-gradient(180deg, color-mix(in srgb, rgb(var(--v-theme-primary)) 6%, rgb(var(--v-theme-surface))) 0, rgb(var(--v-theme-surface)) 190px) !important;
}

.tags-sidebar-header {
  display: flex;
  gap: 12px;
  align-items: center;
  min-height: 84px;
  padding: 18px 16px;
  border-bottom: 1px solid rgba(var(--v-border-color), .09);
}

.tags-sidebar-icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 18%, transparent);
  border-radius: 13px;
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, transparent);
  color: rgb(var(--v-theme-primary));
}

.tags-sidebar-eyebrow,
.tags-eyebrow {
  color: rgb(var(--v-theme-primary));
  font-size: .66rem;
  font-weight: 760;
  letter-spacing: .12em;
  text-transform: uppercase;
}

.tags-sidebar-title {
  margin-top: 2px;
  color: rgb(var(--v-theme-on-surface));
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: -.015em;
}

.tags-navigation {
  display: block;
  padding: 8px 10px 28px;

  .v-list {
    background: transparent;
  }

  .v-list-subheader {
    min-height: 34px;
    margin-top: 8px;
    color: rgb(var(--v-theme-on-surface));
    font-size: .66rem;
    font-weight: 760;
    letter-spacing: .11em;
    opacity: .48;
    text-transform: uppercase;
  }

  .v-list-item {
    min-height: 40px;
    margin-block: 2px;
    border-radius: 10px;
    color: rgb(var(--v-theme-on-surface));
    opacity: .76;

    &--active {
      background: color-mix(in srgb, rgb(var(--v-theme-primary)) 11%, transparent);
      color: rgb(var(--v-theme-primary));
      font-weight: 650;
      opacity: 1;
    }
  }
}

.tags-home-link {
  margin-bottom: 10px !important;
  border: 1px solid rgba(var(--v-border-color), .1);
}

.tags-main {
  background:
    radial-gradient(circle at 88% 0%, rgba(var(--v-theme-primary), .08), transparent 32rem),
    rgb(var(--v-theme-background));
}

.tags-shell {
  width: min(100%, var(--wiki-content-max));
  margin: 0 auto;
  padding: 30px var(--wiki-page-gutter) 56px !important;
}

.tags-hero {
  position: relative;
  display: flex;
  overflow: hidden;
  min-height: 196px;
  align-items: center;
  justify-content: space-between;
  padding: clamp(28px, 4vw, 48px);
  border: 1px solid rgba(var(--v-border-color), .1);
  border-radius: var(--wiki-panel-radius);
  background:
    radial-gradient(circle at 82% 35%, rgba(var(--v-theme-primary), .17), transparent 20rem),
    linear-gradient(145deg, color-mix(in srgb, rgb(var(--v-theme-primary)) 9%, rgb(var(--v-theme-surface))), rgb(var(--v-theme-surface)) 65%);
  box-shadow: 0 16px 44px rgba(15, 23, 42, .06);

  h1 {
    margin: 10px 0 7px;
    color: rgb(var(--v-theme-on-surface));
    font-size: clamp(2.15rem, 4vw, 3.3rem);
    font-weight: 770;
    letter-spacing: -.055em;
    line-height: 1.02;
  }

  p {
    max-width: 620px;
    margin: 0;
    color: rgb(var(--v-theme-on-surface));
    font-size: 1.03rem;
    line-height: 1.6;
    opacity: .64;
  }
}

.tags-eyebrow {
  display: inline-flex;
  gap: 7px;
  align-items: center;
}

.tags-hero-art {
  display: grid;
  flex: 0 0 112px;
  width: 112px;
  height: 112px;
  place-items: center;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 20%, transparent);
  border-radius: 32px;
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, transparent);
  color: rgb(var(--v-theme-primary));
  transform: rotate(5deg);
}

.tags-selection,
.tags-controls {
  margin-top: 20px;
  border: 1px solid rgba(var(--v-border-color), .1);
  border-radius: var(--wiki-panel-radius);
  background: rgb(var(--v-theme-surface));
  box-shadow: 0 9px 30px rgba(15, 23, 42, .045);
}

.tags-selection {
  padding: 18px 20px 20px;
}

.tags-selection-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  color: rgb(var(--v-theme-on-surface));
  font-size: .72rem;
  font-weight: 730;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.tags-selection-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tags-controls {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) minmax(420px, 1.5fr);
  gap: 16px;
  padding: 18px;

  .v-field {
    border-radius: var(--wiki-control-radius);
  }
}

.tags-controls-options {
  display: grid;
  grid-template-columns: minmax(130px, .75fr) minmax(180px, 1.15fr) auto;
  gap: 12px;
}

.tags-sort-direction {
  height: 48px;
  border-radius: var(--wiki-control-radius);
}

.tags-empty,
.tags-state {
  display: grid;
  min-height: 320px;
  place-items: center;
  align-content: center;
  gap: 12px;
  margin-top: 22px;
  padding: 40px 24px;
  border: 1px dashed color-mix(in srgb, rgb(var(--v-theme-primary)) 22%, rgba(var(--v-border-color), .15));
  border-radius: var(--wiki-panel-radius);
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 82%, transparent);
  color: rgb(var(--v-theme-on-surface));
  text-align: center;

  h2 {
    margin: 0;
    font-size: 1.2rem;
    font-weight: 700;
    letter-spacing: -.02em;
  }

  p {
    margin: 0 0 8px;
    opacity: .58;
  }
}

.tags-empty-icon {
  display: grid;
  width: 76px;
  height: 76px;
  place-items: center;
  border-radius: 23px;
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, transparent);
  color: rgb(var(--v-theme-primary));
}

.tags-results {
  margin-top: 22px;
}

.tags-result-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.tags-result-card {
  height: 100%;
  border: 1px solid rgba(var(--v-border-color), .1);
  border-radius: var(--wiki-panel-radius) !important;
  background: rgb(var(--v-theme-surface));
  box-shadow: 0 8px 26px rgba(15, 23, 42, .045);
  cursor: pointer;
  transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease;

  &:hover,
  &:focus-within {
    transform: translateY(-2px);
    border-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 25%, transparent);
    box-shadow: 0 16px 36px rgba(15, 23, 42, .08);
  }

  .v-card-text {
    display: flex;
    min-height: 200px;
    flex-direction: column;
    padding: 22px;
  }

  h2 {
    margin: 18px 0 7px;
    color: rgb(var(--v-theme-on-surface));
    font-size: 1.12rem;
    font-weight: 720;
    letter-spacing: -.025em;
  }

  p {
    display: -webkit-box;
    overflow: hidden;
    margin: 0 0 20px;
    color: rgb(var(--v-theme-on-surface));
    line-height: 1.55;
    opacity: .62;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }
}

.tags-result-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: rgb(var(--v-theme-on-surface));
  font-size: .72rem;
  opacity: .64;
}

.tags-result-path {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
  margin-top: auto;
  color: rgb(var(--v-theme-primary));
  font-size: .78rem;

  bdi {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.tags-result-arrow {
  margin-inline-start: auto;
}

.tags-pagination {
  display: flex;
  justify-content: center;
  padding-top: 28px;
}

@media (max-width: 959px) {
  .tags-shell {
    padding: 22px 20px 48px !important;
  }

  .tags-controls {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 699px) {
  .tags-shell {
    padding: 16px 12px 42px !important;
  }

  .tags-hero {
    min-height: 176px;
    padding: 24px 22px;
    border-radius: 18px;

    h1 {
      font-size: 2.15rem;
    }

    p {
      font-size: .9rem;
    }
  }

  .tags-hero-art {
    display: none;
  }

  .tags-controls-options,
  .tags-result-grid {
    grid-template-columns: 1fr;
  }

  .tags-sort-direction {
    width: 100%;

    .v-btn {
      flex: 1 1 50%;
    }
  }

  .tags-empty,
  .tags-state {
    min-height: 270px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tags-result-card {
    transition-duration: .01ms !important;
  }
}
</style>
