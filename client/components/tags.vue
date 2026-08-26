<template lang='pug'>
  v-app.tags
    nav-header
      template(v-slot:actions)
        v-btn.tags-filter-toggle(
          v-if='$vuetify.display.smAndDown'
          icon
          @click='tagDrawerShown = !tagDrawerShown'
          :aria-expanded='tagDrawerShown'
          aria-controls='tag-navigation'
          :aria-label='$t(`common:header.browseTags`)'
        )
          v-icon mdi-tag-multiple-outline
    v-navigation-drawer#tag-navigation.tags-sidebar(
      v-model='tagDrawerShown'
      :location="$vuetify.locale.isRtl ? 'right' : undefined"
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
        nav.tags-navigation(:aria-label='$t(`common:header.browseTags`)')
          v-list(density='compact' nav)
            v-list-item.tags-home-link(href='/' color='primary')
              template(v-slot:prepend): v-icon mdi-home-outline
              v-list-item-title {{$t('common:header.home')}}
            template(v-for='(tagGroup, groupName) in tagsGrouped', :key='`tagGroup-` + groupName')
              v-list-subheader {{groupName}}
              v-list-item.tags-nav-item(
                v-for='tag of tagGroup'
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
              @click='selection = []'
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

        section.tags-controls(aria-label='Filter tagged pages')
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
              item-title='text'
              item-value='value'
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
          h2 {{$t('tags:selectOneMoreTagsHint')}}
          p Choose tags from the sidebar to discover related pages.
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
            :items-per-page='12'
            :search='innerSearch'
            :loading='isLoading'
            v-model:options='pagination'
            @page-count='pageTotal = $event'
            hide-default-footer
            ref='dude'
          )
            template(v-slot:loading)
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
              .tags-state
                v-icon(size='48' color='primary') mdi-file-search-outline
                h2 {{$t('tags:noResults')}}
            template(v-slot:no-results)
              .tags-state
                v-icon(size='48' color='primary') mdi-text-search
                h2 {{$t('tags:noResultsWithFilter')}}
            template(v-slot:default='props')
              .tags-result-grid
                article(v-for='entry of props.items' :key='`page-` + entry.raw.id')
                  v-card.tags-result-card(
                    @click='goTo(entry.raw)'
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
                        span /{{entry.raw.path}}
                        v-icon.tags-result-arrow(size='18') mdi-arrow-up-right
          .tags-pagination(v-if='pageTotal > 1')
            v-pagination(v-model='pagination.page' :length='pageTotal')

    nav-footer
    notify
    search-results
</template>

<script lang='ts'>
import _ from 'lodash'

import { fetchPages, fetchPageTags, type PageListRow, type PageTagRow } from '../helpers/pages-api'
import { setLoading } from '../helpers/root-ui-store'
import { pathFromTagSelection, tagSelectionFromPath } from '../helpers/tag-navigation'
import { wikiStore } from '@/store/index.ts'

/* global siteConfig, siteLangs */

type TagLocale = {
  name: string
  code: string
}

function normalizeQueryValue (value: unknown): string | undefined {
  const normalized = Array.isArray(value) ? value[0] : value
  return typeof normalized === 'string' && normalized.length > 0 ? normalized : undefined
}


export default {
  i18nOptions: { namespaces: 'tags' },
  data() {
    return {
      tags: [] as PageTagRow[],
      selection: [] as string[],
      tagDrawerShown: true,
      innerSearch: '',
      locale: 'any',
      locales: [] as TagLocale[],
      orderBy: 'title',
      orderByDirection: 0,
      pagination: {
        page: 1,
        itemsPerPage: 12,
        mustSort: true,
        sortBy: ['title'],
        sortDesc: [false]
      },
      pages: [] as PageListRow[],
      pageTotal: 0,
      isLoading: true,
      scrollStyle: {
        vuescroll: {},
        scrollPanel: {
          initialScrollY: 0,
          initialScrollX: 0,
          scrollingX: false,
          easing: 'easeOutQuad',
          speed: 1000,
          verticalNativeBarPos: siteConfig.rtl ? `left` : `right`
        },
        rail: {
          gutterOfEnds: '2px'
        },
        bar: {
          onlyShowBarOnScroll: false,
          background: '#CCC',
          hoverStyle: {
            background: '#999'
          }
        }
      }
    }
  },
  computed: {
    tagsGrouped () {
      return _.groupBy(this.tags, (tag: PageTagRow) => (tag.title ?? '').charAt(0).toUpperCase())
    },
    tagsSelected () {
      return _.filter(this.tags, (tag: PageTagRow) => _.includes(this.selection, tag.tag))
    },
    orderByItems () {
      return [
        { text: this.$t('tags:orderByField.creationDate'), value: 'createdAt' },
        { text: this.$t('tags:orderByField.ID'), value: 'id' },
        { text: this.$t('tags:orderByField.lastModified'), value: 'updatedAt' },
        { text: this.$t('tags:orderByField.path'), value: 'path' },
        { text: this.$t('tags:orderByField.title'), value: 'title' }
      ]
    }
  },
  watch: {
    locale (newValue: string, _oldValue: string) {
      this.rebuildURL()
    },
    orderBy (newValue: string, _oldValue: string) {
      this.rebuildURL()
      this.pagination.sortBy = [newValue]
    },
    orderByDirection (newValue: number, _oldValue: number) {
      this.rebuildURL()
      this.pagination.sortDesc = [newValue === 1]
    },
    $route () {
      this.selection = tagSelectionFromPath(this.$route.path)
      this.loadPages()
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
    this.locales = _.concat(
      [{name: this.$t('tags:localeAny'), code: 'any'}],
      (siteLangs.length > 0 ? siteLangs : [])
    )
    const lang = normalizeQueryValue(this.$route.query.lang)
    if (lang) {
      this.locale = lang
    }
    const sort = normalizeQueryValue(this.$route.query.sort)
    if (sort) {
      this.orderBy = sort.toLowerCase()
      switch (this.orderBy) {
        case 'updatedat':
          this.orderBy = 'updatedAt'
          break
      }
      this.pagination.sortBy = [this.orderBy]
    }
    const direction = normalizeQueryValue(this.$route.query.dir)
    if (direction) {
      this.orderByDirection = direction === 'asc' ? 0 : 1
      this.pagination.sortDesc = [this.orderByDirection === 1]
    }
    this.loadTags()
    this.loadPages()
  },
  methods: {
    toggleTag (tag: string) {
      if (_.includes(this.selection, tag)) {
        this.selection = _.without(this.selection, tag)
      } else {
        this.selection.push(tag)
      }
      this.rebuildURL()
    },
    isSelected (tag: string) {
      return _.includes(this.selection, tag)
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
        query.dir = this.orderByDirection === 0 ? `asc` : `desc`
      }
      this.$router.push({
        path: pathFromTagSelection(this.selection),
        query
      })
    },
    goTo (page: PageListRow) {
      window.location.assign(`/${page.locale}/${page.path}`)
    },
    async loadTags () {
      setLoading(wikiStore, 'tags-refresh', true)
      try {
        this.tags = await fetchPageTags(window.fetch.bind(window))
      } finally {
        setLoading(wikiStore, 'tags-refresh', false)
      }
    },
    async loadPages () {
      if (this.selection.length < 1) {
        this.pages = []
        this.isLoading = false
        return
      }
      this.isLoading = true
      setLoading(wikiStore, 'pages-refresh', true)
      try {
        this.pages = await fetchPages(window.fetch.bind(window), {
          locale: this.locale === 'any' ? undefined : this.locale,
          tags: this.selection
        })
      } finally {
        this.isLoading = false
        setLoading(wikiStore, 'pages-refresh', false)
      }
    }
  }

}
</script>

<style lang='scss'>
.tags {
  font-family: 'WikiAgentSans', 'Roboto', sans-serif;
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
  width: min(100%, 1500px);
  margin: 0 auto;
  padding: 34px 36px 64px !important;
}

.tags-hero {
  position: relative;
  display: flex;
  overflow: hidden;
  min-height: 210px;
  align-items: center;
  justify-content: space-between;
  padding: clamp(30px, 5vw, 58px);
  border: 1px solid rgba(var(--v-border-color), .1);
  border-radius: 24px;
  background:
    radial-gradient(circle at 82% 35%, rgba(var(--v-theme-primary), .17), transparent 20rem),
    linear-gradient(145deg, color-mix(in srgb, rgb(var(--v-theme-primary)) 9%, rgb(var(--v-theme-surface))), rgb(var(--v-theme-surface)) 65%);
  box-shadow: 0 16px 44px rgba(15, 23, 42, .06);

  h1 {
    margin: 12px 0 8px;
    color: rgb(var(--v-theme-on-surface));
    font-size: clamp(2.2rem, 5vw, 4.2rem);
    font-weight: 780;
    letter-spacing: -.06em;
    line-height: 1;
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
  flex: 0 0 132px;
  width: 132px;
  height: 132px;
  place-items: center;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 20%, transparent);
  border-radius: 38px;
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, transparent);
  color: rgb(var(--v-theme-primary));
  transform: rotate(6deg);
}

.tags-selection,
.tags-controls {
  margin-top: 20px;
  border: 1px solid rgba(var(--v-border-color), .1);
  border-radius: 18px;
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
    border-radius: 12px;
  }
}

.tags-controls-options {
  display: grid;
  grid-template-columns: minmax(130px, .75fr) minmax(180px, 1.15fr) auto;
  gap: 12px;
}

.tags-sort-direction {
  height: 48px;
  border-radius: 12px;
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
  border-radius: 20px;
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
  border-radius: 17px !important;
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

  span {
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
    padding: 24px 20px 52px !important;
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
    min-height: 190px;
    padding: 28px 24px;
    border-radius: 20px;

    h1 {
      font-size: 2.45rem;
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
