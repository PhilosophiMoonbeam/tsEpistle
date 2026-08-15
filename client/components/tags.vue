<template lang='pug'>
  v-app(:dark='$vuetify.theme.current.dark').tags
    nav-header
    v-navigation-drawer.pb-0.elevation-1(app, fixed, clipped, :right='$vuetify.locale.isRtl', permanent, width='300')
      vue-scroll(:ops='scrollStyle')
        v-list(dense, nav)
          v-list-item(href='/')
            div.v-list-item-icon: v-icon mdi-home
            v-list-item-title {{$t('common:header.home')}}
          template(v-for='(tags, groupName) in tagsGrouped', :key='`tagGroup-` + groupName')
            v-divider.my-2
            v-list-subheader.pl-4 {{groupName}}
            v-list-item(v-for='tag of tags', @click='toggleTag(tag.tag)', :key='`tag-` + tag.tag')
              div.v-list-item-icon
                v-icon(v-if='isSelected(tag.tag)', color='primary') mdi-checkbox-intermediate
                v-icon(v-else) mdi-checkbox-blank-outline
              v-list-item-title {{tag.title}}
    v-main.grey(:class='$vuetify.theme.current.dark ? `darken-4-d5` : `lighten-3`')
      v-toolbar(color='primary', dark, flat, height='58')
        template(v-if='selection.length > 0')
          .overline.mr-3.animated.fadeInLeft {{$t('tags:currentSelection')}}
          v-chip.mr-3.primary--text(
            v-for='tag of tagsSelected'
            :key='`tagSelected-` + tag.tag'
            color='white'
            closable
            @click:close='toggleTag(tag.tag)'
            ) {{tag.title}}
          v-spacer
          v-btn.animated.fadeIn(
            small
            outlined
            color='blue lighten-4'
            rounded
            @click='selection = []'
            )
            v-icon(left) mdi-close
            span {{$t('tags:clearSelection')}}
        template(v-else)
          v-icon.mr-3.animated.fadeInRight mdi-arrow-left
          .overline.animated.fadeInRight {{$t('tags:selectOneMoreTags')}}
      v-toolbar(:color='$vuetify.theme.current.dark ? `grey darken-4-l5` : `grey lighten-4`', flat, height='58')
        v-text-field.tags-search(
          v-model='innerSearch'
          :label='$t(`tags:searchWithinResultsPlaceholder`)'
          solo
          hide-details
          flat
          rounded
          single-line
          height='40'
          prepend-icon='mdi-text-box-search-outline'
          append-icon='mdi-arrow-right'
          clearable
        )
        template(v-if='locales.length > 1')
          v-divider.mx-3(vertical)
          .overline {{$t('tags:locale')}}
          v-select.ml-2(
            :items='locales'
            v-model='locale'
            :background-color='$vuetify.theme.current.dark ? `grey darken-3` : `white`'
            hide-details
            :label='$t(`tags:locale`)'
            item-title='name'
            item-value='code'
            rounded
            single-line
            dense
            height='40'
            style='max-width: 170px;'
          )
        v-divider.mx-3(vertical)
        .overline {{$t('tags:orderBy')}}
        v-select.ml-2(
          :items='orderByItems'
          v-model='orderBy'
          :background-color='$vuetify.theme.current.dark ? `grey darken-3` : `white`'
          hide-details
          :label='$t(`tags:orderBy`)'
          rounded
          single-line
          dense
          height='40'
          style='max-width: 250px;'
        )
        v-btn-toggle.ml-2(v-model='orderByDirection', rounded, mandatory)
          v-btn(text, height='40'): v-icon(size='20') mdi-chevron-double-up
          v-btn(text, height='40'): v-icon(size='20') mdi-chevron-double-down
      v-divider
      .text-center.pt-10(v-if='selection.length < 1')
        img(src='/_assets/svg/icon-price-tag.svg')
        .subtitle-2.grey--text {{$t('tags:selectOneMoreTagsHint')}}
      .px-5.py-2(v-else)
        v-data-iterator(
          :items='pages'
          :items-per-page='4'
          :search='innerSearch'
          :loading='isLoading'
          v-model:options='pagination'
          @page-count='pageTotal = $event'
          hide-default-footer
          ref='dude'
          )
          template(v-slot:loading)
            .text-center.pt-10
              v-progress-circular(
                indeterminate
                color='primary'
                size='96'
                width='2'
                :aria-label='$t(`tags:retrievingResultsLoading`)'
                )
              .subtitle-2.grey--text.mt-5 {{$t('tags:retrievingResultsLoading')}}
          template(v-slot:no-data)
            .text-center.pt-10
              img(src='/_assets/svg/icon-info.svg')
              .subtitle-2.grey--text {{$t('tags:noResults')}}
          template(v-slot:no-results)
            .text-center.pt-10
              img(src='/_assets/svg/icon-info.svg')
              .subtitle-2.grey--text {{$t('tags:noResultsWithFilter')}}
          template(v-slot:default='props')
            v-row(align='stretch')
              v-col(
                v-for='item of props.items'
                :key='`page-` + item.id'
                cols='12'
                lg='6'
                )
                v-card.radius-7(
                  @click='goTo(item)'
                  style='height:100%;'
                  :class='$vuetify.theme.current.dark ? `grey darken-4` : ``'
                  )
                  v-card-text
                    .d-flex.flex-row.align-center
                      .body-1: strong.primary--text {{item.title}}
                      v-spacer
                      i18next.caption(tag='div', path='tags:pageLastUpdated')
                        span(place='date') {{ $helpers.formatMoment(item.updatedAt, 'from') }}
                    .body-2.grey--text {{item.description || '---'}}
                    v-divider.my-2
                    .d-flex.flex-row.align-center
                      v-chip(small, label, :color='$vuetify.theme.current.dark ? `grey darken-3-l5` : `grey lighten-4`').overline {{item.locale}}
                      .caption.ml-1 / {{item.path}}
        .text-center.py-2.animated.fadeInDown(v-if='this.pageTotal > 1')
          v-pagination(v-model='pagination.page', :length='pageTotal')

    nav-footer
    notify
    search-results
</template>

<script lang='ts'>
import _ from 'lodash'

import { fetchPages, fetchPageTags, type PageListRow, type PageTagRow } from '../helpers/pages-api'
import { setLoading } from '../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'

/* global siteLangs */

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
          verticalNativeBarPos: this.$vuetify.locale.isRtl ? `left` : `right`
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
      this.selection = _.compact(decodeURI(this.$route.path).split('/'))
      this.loadPages()
    }
  },
  created () {
    wikiStore.page.mode = 'tags'
    this.selection = _.compact(decodeURI(this.$route.path).split('/'))
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
      if (this.orderBy !== `TITLE`) {
        query.sort = this.orderBy.toLowerCase()
      }
      if (this.orderByDirection !== 0) {
        query.dir = this.orderByDirection === 0 ? `asc` : `desc`
      }
      this.$router.push({
        path: '/' + this.selection.join('/'),
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
.tags-search {
  .v-input__control {
    min-height: initial !important;
  }
  .v-input__prepend-outer {
    margin-top: 8px !important;
  }
}
</style>
