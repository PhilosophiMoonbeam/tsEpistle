<template lang="pug">
  v-app(v-scroll='upBtnScroll', :dark='$vuetify.theme.current.dark', :class='$vuetify.locale.isRtl ? `is-rtl` : `is-ltr`')
    nav-header(v-if='!printView')
    v-navigation-drawer(
      v-if='navMode !== `NONE` && !printView'
      :class='$vuetify.theme.current.dark ? `grey darken-4-d4` : `primary`'
      dark
      app
      clipped
      mobile-breakpoint='600'
      :temporary='$vuetify.display.smAndDown'
      v-model='navShown'
      :right='$vuetify.locale.isRtl'
      )
      vue-scroll(:ops='scrollStyle')
        nav-sidebar(:color='$vuetify.theme.current.dark ? `grey darken-4-d4` : `primary`', :items='sidebarDecoded', :nav-mode='navMode')

    v-fab-transition(v-if='navMode !== `NONE`')
      v-btn(
        fab
        color='primary'
        fixed
        bottom
        :right='$vuetify.locale.isRtl'
        :left='!$vuetify.locale.isRtl'
        small
        @click='navShown = !navShown'
        v-if='$vuetify.display.mdAndDown'
        v-show='!navShown'
        )
        v-icon mdi-menu

    v-main(ref='content')
      template(v-if='path !== `home`')
        v-toolbar(:color='$vuetify.theme.current.dark ? `grey darken-4-d3` : `grey lighten-3`', flat, dense, v-if='$vuetify.display.smAndUp')
          //- v-btn.pl-0(v-if='$vuetify.display.xsOnly', flat, @click='toggleNavigation')
          //-   v-icon(color='grey darken-2', left) menu
          //-   span Navigation
          v-breadcrumbs.breadcrumbs-nav.pl-0(
            :items='breadcrumbs'
            divider='/'
            )
            template(v-slot:item='props')
              v-icon(v-if='props.item.path === "/"', small, @click='goHome') mdi-home
              v-btn.ma-0(v-else, :href='props.item.path', small, text) {{props.item.name}}
          template(v-if='!isPublished')
            v-spacer
            .caption.red--text {{$t('common:page.unpublished')}}
            status-indicator.ml-3(negative, pulse)
        v-divider
      v-container.grey.pa-0(fluid, :class='$vuetify.theme.current.dark ? `darken-4-l3` : `lighten-4`')
        v-row.page-header-section(no-gutters, align-content='center', style='height: 90px;')
          v-col.page-col-content.is-page-header(
            :offset-xl='tocPosition === `left` ? 2 : 0'
            :offset-lg='tocPosition === `left` ? 3 : 0'
            :xl='tocPosition === `right` ? 10 : false'
            :lg='tocPosition === `right` ? 9 : false'
            style='margin-top: auto; margin-bottom: auto;'
            :class='$vuetify.locale.isRtl ? `pr-4` : `pl-4`'
            )
            .page-header-headings
              .headline.grey--text(:class='$vuetify.theme.current.dark ? `text--lighten-2` : `text--darken-3`') {{title}}
              .caption.grey--text.text--darken-1 {{description}}
            .page-edit-shortcuts(
              v-if='editShortcutsObj.editMenuBar'
              :class='tocPosition === `right` ? `is-right` : ``'
              )
              v-btn(
                v-if='editShortcutsObj.editMenuBtn'
                @click='pageEdit'
                depressed
                small
                )
                v-icon.mr-2(small) mdi-pencil
                span.text-none {{$t(`common:actions.edit`)}}
              v-btn(
                v-if='editShortcutsObj.editMenuExternalBtn'
                :href='editMenuExternalUrl'
                target='_blank'
                depressed
                small
                )
                v-icon.mr-2(small) {{ editShortcutsObj.editMenuExternalIcon }}
                span.text-none {{$t(`common:page.editExternal`, { name: editShortcutsObj.editMenuExternalName })}}
      v-divider
      v-container.pl-5.pt-4(fluid, grid-list-xl)
        v-row
          v-col.page-col-sd(
            v-if='tocPosition !== `off` && $vuetify.display.lgAndUp'
            :order-xs1='tocPosition !== `right`'
            :order-xs2='tocPosition === `right`'
            lg3
            xl2
            )
            v-card.page-toc-card.mb-5(v-if='tocDecoded.length')
              .overline.pa-5.pb-0(:class='$vuetify.theme.current.dark ? `blue--text text--lighten-2` : `primary--text`') {{$t('common:page.toc')}}
              v-list.pb-3(dense, nav, :class='$vuetify.theme.current.dark ? `darken-3-d3` : ``')
                template(v-for='(tocItem, tocIdx) in tocDecoded')
                  v-list-item(@click='goTo(tocItem.anchor, scrollOpts)')
                    v-icon(color='grey', small) {{ $vuetify.locale.isRtl ? `mdi-chevron-left` : `mdi-chevron-right` }}
                    v-list-item-title.px-3 {{tocItem.title}}
                  //- v-divider(v-if='tocIdx < toc.length - 1 || tocItem.children.length')
                  template(v-for='tocSubItem in tocItem.children')
                    v-list-item(@click='goTo(tocSubItem.anchor, scrollOpts)')
                      v-icon.px-3(color='grey lighten-1', small) {{ $vuetify.locale.isRtl ? `mdi-chevron-left` : `mdi-chevron-right` }}
                      v-list-item-title.px-3.caption.grey--text(:class='$vuetify.theme.current.dark ? `text--lighten-1` : `text--darken-1`') {{tocSubItem.title}}
                    //- v-divider(inset, v-if='tocIdx < toc.length - 1')

            v-card.page-tags-card.mb-5(v-if='tags.length > 0')
              .pa-5
                .overline.teal--text.pb-2(:class='$vuetify.theme.current.dark ? `text--lighten-3` : ``') {{$t('common:page.tags')}}
                v-chip.mr-1.mb-1(
                  label
                  :color='$vuetify.theme.current.dark ? `teal darken-1` : `teal lighten-5`'
                  v-for='(tag, idx) in tags'
                  :href='`/t/` + tag.tag'
                  :key='`tag-` + tag.tag'
                  )
                  v-icon(:color='$vuetify.theme.current.dark ? `teal lighten-3` : `teal`', left, small) mdi-tag
                  span(:class='$vuetify.theme.current.dark ? `teal--text text--lighten-5` : `teal--text text--darken-2`') {{tag.title}}
                v-chip.mr-1.mb-1(
                  label
                  :color='$vuetify.theme.current.dark ? `teal darken-1` : `teal lighten-5`'
                  :href='`/t/` + tags.map(t => t.tag).join(`/`)'
                  :aria-label='$t(`common:page.tagsMatching`)'
                  )
                  v-icon(:color='$vuetify.theme.current.dark ? `teal lighten-3` : `teal`', size='20') mdi-tag-multiple

            v-card.page-comments-card.mb-5(v-if='commentsEnabled && commentsPerms.read')
              .pa-5
                .overline.pb-2.blue-grey--text.d-flex.align-center(:class='$vuetify.theme.current.dark ? `text--lighten-3` : `text--darken-2`')
                  span {{$t('common:comments.sdTitle')}}
                  //- v-spacer
                  //- v-chip.text-center(
                  //-   v-if='!commentsExternal'
                  //-   label
                  //-   x-small
                  //-   :color='$vuetify.theme.current.dark ? `blue-grey darken-3` : `blue-grey darken-2`'
                  //-   dark
                  //-   style='min-width: 50px; justify-content: center;'
                  //-   )
                  //-   span {{commentsCount}}
                .d-flex
                  v-btn.text-none(
                    @click='goToComments()'
                    :color='$vuetify.theme.current.dark ? `blue-grey` : `blue-grey darken-2`'
                    outlined
                    style='flex: 1 1 100%;'
                    small
                    )
                    span.blue-grey--text(:class='$vuetify.theme.current.dark ? `text--lighten-1` : `text--darken-2`') {{$t('common:comments.viewDiscussion')}}
                  v-tooltip(right, v-if='commentsPerms.write')
                    template(v-slot:activator='{ props }')
                      v-btn.ml-2(
                        @click='goToComments(true)'
                        v-bind='props'
                        outlined
                        small
                        :color='$vuetify.theme.current.dark ? `blue-grey` : `blue-grey darken-2`'
                        :aria-label='$t(`common:comments.newComment`)'
                        )
                        v-icon(:color='$vuetify.theme.current.dark ? `blue-grey lighten-1` : `blue-grey darken-2`', dense) mdi-comment-plus
                    span {{$t('common:comments.newComment')}}

            v-card.page-author-card.mb-5
              .pa-5
                .overline.indigo--text.d-flex(:class='$vuetify.theme.current.dark ? `text--lighten-3` : ``')
                  span {{$t('common:page.lastEditedBy')}}
                  v-spacer
                  v-tooltip(right, v-if='isAuthenticated')
                    template(v-slot:activator='{ props }')
                      v-btn.btn-animate-edit(
                        icon
                        :href='"/h/" + locale + "/" + path'
                        v-bind='props'
                        x-small
                        v-if='hasReadHistoryPermission'
                        :aria-label='$t(`common:header.history`)'
                        )
                        v-icon(color='indigo', dense) mdi-history
                    span {{$t('common:header.history')}}
                .page-author-card-name.body-2.grey--text(:class='$vuetify.theme.current.dark ? `` : `text--darken-3`') {{ authorName }}
                .page-author-card-date.caption.grey--text.text--darken-1 {{ $helpers.formatMoment(updatedAt, 'calendar') }}

            //- v-card.mb-5
            //-   .pa-5
            //-     .overline.pb-2.yellow--text(:class='$vuetify.theme.current.dark ? `text--darken-3` : `text--darken-4`') Rating
            //-     .text-center
            //-       v-rating(
            //-         v-model='rating'
            //-         color='yellow darken-3'
            //-         background-color='grey lighten-1'
            //-         half-increments
            //-         hover
            //-       )
            //-       .caption.grey--text 5 votes

            v-card.page-shortcuts-card(flat)
              v-toolbar(:color='$vuetify.theme.current.dark ? `grey darken-4-d3` : `grey lighten-3`', flat, dense)
                v-spacer
                //- v-tooltip(bottom)
                //-   template(v-slot:activator='{ props }')
                //-     v-btn(icon, tile, v-bind='props', :aria-label='$t(`common:page.bookmark`)'): v-icon(color='grey') mdi-bookmark
                //-   span {{$t('common:page.bookmark')}}
                v-menu(offset-y, bottom, min-width='300')
                  template(v-slot:activator='{ props: menuProps }')
                    v-tooltip(bottom)
                      template(v-slot:activator='{ props: tooltipProps }')
                        v-btn(icon, tile, v-bind='{ ...menuProps, ...tooltipProps }', :aria-label='$t(`common:page.share`)'): v-icon(color='grey') mdi-share-variant
                      span {{$t('common:page.share')}}
                  social-sharing(
                    :url='pageUrl'
                    :title='title'
                    :description='description'
                  )
                v-tooltip(bottom)
                  template(v-slot:activator='{ props }')
                    v-btn(icon, tile, v-bind='props', @click='print', :aria-label='$t(`common:page.printFormat`)')
                      v-icon(:color='printView ? `primary` : `grey`') mdi-printer
                  span {{$t('common:page.printFormat')}}
                v-spacer

          v-col.page-col-content(
            xs12
            :lg9='tocPosition !== `off`'
            :xl10='tocPosition !== `off`'
            :order-xs1='tocPosition === `right`'
            :order-xs2='tocPosition !== `right`'
            )
            v-tooltip(:right='$vuetify.locale.isRtl', :left='!$vuetify.locale.isRtl', v-if='hasAnyPagePermissions && editShortcutsObj.editFab')
              template(v-slot:activator='{ on: onEditActivator }')
                v-speed-dial(
                  v-model='pageEditFab'
                  direction='top'
                  open-on-hover
                  transition='scale-transition'
                  bottom
                  :right='!$vuetify.locale.isRtl'
                  :left='$vuetify.locale.isRtl'
                  fixed
                  dark
                  )
                  template(v-slot:activator)
                    v-btn.btn-animate-edit(
                      fab
                      color='primary'
                      v-model='pageEditFab'
                      @click='pageEdit'
                      v-on='onEditActivator'
                      :disabled='!hasWritePagesPermission'
                      :aria-label='$t(`common:page.editPage`)'
                      )
                      v-icon mdi-pencil
                  v-tooltip(:right='$vuetify.locale.isRtl', :left='!$vuetify.locale.isRtl', v-if='hasReadHistoryPermission')
                    template(v-slot:activator='{ props }')
                      v-btn(
                        fab
                        small
                        color='white'
                        light
                        v-bind='props'
                        @click='pageHistory'
                        )
                        v-icon(size='20') mdi-history
                    span {{$t('common:header.history')}}
                  v-tooltip(:right='$vuetify.locale.isRtl', :left='!$vuetify.locale.isRtl', v-if='hasReadSourcePermission')
                    template(v-slot:activator='{ props }')
                      v-btn(
                        fab
                        small
                        color='white'
                        light
                        v-bind='props'
                        @click='pageSource'
                        )
                        v-icon(size='20') mdi-code-tags
                    span {{$t('common:header.viewSource')}}
                  v-tooltip(:right='$vuetify.locale.isRtl', :left='!$vuetify.locale.isRtl', v-if='hasWritePagesPermission')
                    template(v-slot:activator='{ props }')
                      v-btn(
                        fab
                        small
                        color='white'
                        light
                        v-bind='props'
                        @click='pageConvert'
                        )
                        v-icon(size='20') mdi-lightning-bolt
                    span {{$t('common:header.convert')}}
                  v-tooltip(:right='$vuetify.locale.isRtl', :left='!$vuetify.locale.isRtl', v-if='hasWritePagesPermission')
                    template(v-slot:activator='{ props }')
                      v-btn(
                        fab
                        small
                        color='white'
                        light
                        v-bind='props'
                        @click='pageDuplicate'
                        )
                        v-icon(size='20') mdi-content-duplicate
                    span {{$t('common:header.duplicate')}}
                  v-tooltip(:right='$vuetify.locale.isRtl', :left='!$vuetify.locale.isRtl', v-if='hasManagePagesPermission')
                    template(v-slot:activator='{ props }')
                      v-btn(
                        fab
                        small
                        color='white'
                        light
                        v-bind='props'
                        @click='pageMove'
                        )
                        v-icon(size='20') mdi-content-save-move-outline
                    span {{$t('common:header.move')}}
                  v-tooltip(:right='$vuetify.locale.isRtl', :left='!$vuetify.locale.isRtl', v-if='hasDeletePagesPermission')
                    template(v-slot:activator='{ props }')
                      v-btn(
                        fab
                        dark
                        small
                        color='red'
                        v-bind='props'
                        @click='pageDelete'
                        )
                        v-icon(size='20') mdi-trash-can-outline
                    span {{$t('common:header.delete')}}
              span {{$t('common:page.editPage')}}
            v-alert.mb-5(v-if='!isPublished', color='red', outlined, icon='mdi-minus-circle', dense)
              .caption {{$t('common:page.unpublishedWarning')}}
            .contents(ref='container')
              slot(name='contents')
            .comments-container#discussion(v-if='commentsEnabled && commentsPerms.read && !printView')
              .comments-header
                v-icon.mr-2(dark) mdi-comment-text-outline
                span {{$t('common:comments.title')}}
              .comments-main
                slot(name='comments')
    nav-footer
    notify
    search-results
    v-fab-transition
      v-btn(
        v-if='upBtnShown'
        fab
        fixed
        bottom
        :right='$vuetify.locale.isRtl'
        :left='!$vuetify.locale.isRtl'
        small
        :depressed='this.$vuetify.display.mdAndUp'
        @click='goTo(0, scrollOpts)'
        color='primary'
        dark
        :style='upBtnPosition'
        :aria-label='$t(`common:actions.returnToTop`)'
        )
        v-icon mdi-arrow-up
</template>

<script lang='ts'>
import { defineComponent, type PropType } from 'vue'
import { useGoTo } from 'vuetify'
import StatusIndicator from '@/components/common/status-indicator.vue'
import Tabset from './tabset.vue'
import NavSidebar, { type SidebarItem } from './nav-sidebar.vue'
import Prism, { type Environment as PrismEnvironment } from 'prismjs'
import mermaid from 'mermaid'
import { wikiStore } from '@/store/index.ts'
import _ from 'lodash'
import ClipboardJS from 'clipboard'
import boot from '../../../modules/boot.ts'
import {
  emitPageConvert,
  emitPageDelete,
  emitPageDuplicate,
  emitPageEdit,
  emitPageHistory,
  emitPageMove,
  emitPageSource
} from '../../../helpers/page-action-events'

/* global siteLangs */

type Breadcrumb = {
  path: string
  name: string
}

type TableOfContentsItem = {
  anchor: string
  title: string
  children: TableOfContentsItem[]
}

Prism.plugins.autoloader.languages_path = '/_assets/js/prism/'
Prism.plugins.NormalizeWhitespace.setDefaults({
  'remove-trailing': true,
  'remove-indent': true,
  'left-trim': true,
  'right-trim': true,
  'remove-initial-line-feed': true,
  'tabs-to-spaces': 2
})
Prism.plugins.toolbar.registerButton('copy-to-clipboard', (env: PrismEnvironment) => {
  let linkCopy = document.createElement('button')
  linkCopy.textContent = 'Copy'

  const clip = new ClipboardJS(linkCopy, {
    text: () => env.code || ''
  })

  clip.on('success', () => {
    linkCopy.textContent = 'Copied!'
    resetClipboardText()
  })
  clip.on('error', () => {
    linkCopy.textContent = 'Press Ctrl+C to copy'
    resetClipboardText()
  })

  return linkCopy

  function resetClipboardText() {
    setTimeout(() => {
      linkCopy.textContent = 'Copy'
    }, 5000)
  }
})

export default defineComponent({
  components: {
    NavSidebar,
    StatusIndicator,
    Tabset
  },
  setup () {
    return {
      goTo: useGoTo()
    }
  },
  props: {
    pageId: {
      type: Number,
      default: 0
    },
    locale: {
      type: String,
      default: 'en'
    },
    path: {
      type: String,
      default: 'home'
    },
    title: {
      type: String,
      default: 'Untitled Page'
    },
    description: {
      type: String,
      default: ''
    },
    createdAt: {
      type: String,
      default: ''
    },
    updatedAt: {
      type: String,
      default: ''
    },
    tags: {
      type: Array as PropType<string[]>,
      default: () => ([])
    },
    authorName: {
      type: String,
      default: 'Unknown'
    },
    authorId: {
      type: Number,
      default: 0
    },
    editor: {
      type: String,
      default: ''
    },
    isPublished: {
      type: Boolean,
      default: false
    },
    toc: {
      type: String,
      default: ''
    },
    sidebar: {
      type: String,
      default: ''
    },
    navMode: {
      type: String,
      default: 'MIXED'
    },
    commentsEnabled: {
      type: Boolean,
      default: false
    },
    effectivePermissions: {
      type: String,
      default: ''
    },
    commentsExternal: {
      type: Boolean,
      default: false
    },
    editShortcuts: {
      type: String,
      default: ''
    },
    filename: {
      type: String,
      default: ''
    }
  },
  data() {
    return {
      locales: siteLangs,
      navShown: false,
      navExpanded: false,
      upBtnShown: false,
      pageEditFab: false,
      scrollOpts: {
        duration: 1500,
        offset: 0,
        easing: 'easeInOutCubic'
      },
      scrollStyle: {
        vuescroll: {},
        scrollPanel: {
          initialScrollX: 0.01, // fix scrollbar not disappearing on load
          scrollingX: false,
          speed: 50
        },
        rail: {
          gutterOfEnds: '2px'
        },
        bar: {
          onlyShowBarOnScroll: false,
          background: '#42A5F5',
          hoverStyle: {
            background: '#64B5F6'
          }
        }
      },
      winWidth: 0
    }
  },
  computed: {
    isAuthenticated () {
      return wikiStore.user.authenticated
    },
    commentsCount () {
      return wikiStore.page.commentsCount
    },
    commentsPerms () {
      return wikiStore.page.effectivePermissions.comments
    },
    editShortcutsObj () {
      return wikiStore.page.editShortcuts
    },
    rating: {
      get () {
        return 3.5
      },
      set (_val: number) {

      }
    },
    breadcrumbs(): Breadcrumb[] {
      return [{ path: '/', name: 'Home' }].concat(
        _.reduce<string, Breadcrumb[]>(this.path.split('/'), (result, value) => {
          result.push({
            path: (_.last(result)?.path || (this.locales.length > 0 ? `/${this.locale}` : '')) + `/${value}`,
            name: value
          })
          return result
        }, []))
    },
    pageUrl () { return window.location.href },
    upBtnPosition () {
      if (this.$vuetify.display.mdAndUp) {
        return this.$vuetify.locale.isRtl ? `right: 235px;` : `left: 235px;`
      } else {
        return this.$vuetify.locale.isRtl ? `right: 65px;` : `left: 65px;`
      }
    },
    sidebarDecoded (): SidebarItem[] {
      return JSON.parse(Buffer.from(this.sidebar, 'base64').toString()) as SidebarItem[]
    },
    tocDecoded (): TableOfContentsItem[] {
      return JSON.parse(Buffer.from(this.toc, 'base64').toString()) as TableOfContentsItem[]
    },
    tocPosition () {
      return wikiStore.site.tocPosition
    },
    hasAdminPermission () {
      return wikiStore.page.effectivePermissions.system.manage
    },
    hasWritePagesPermission () {
      return wikiStore.page.effectivePermissions.pages.write
    },
    hasManagePagesPermission () {
      return wikiStore.page.effectivePermissions.pages.manage
    },
    hasDeletePagesPermission () {
      return wikiStore.page.effectivePermissions.pages.delete
    },
    hasReadSourcePermission () {
      return wikiStore.page.effectivePermissions.source.read
    },
    hasReadHistoryPermission () {
      return wikiStore.page.effectivePermissions.history.read
    },
    hasAnyPagePermissions () {
      return this.hasAdminPermission || this.hasWritePagesPermission || this.hasManagePagesPermission ||
        this.hasDeletePagesPermission || this.hasReadSourcePermission || this.hasReadHistoryPermission
    },
    printView: {
      get () {
        return wikiStore.site.printView
      },
      set (value: boolean) {
        wikiStore.site.printView = value
      }
    },
    editMenuExternalUrl () {
      if (this.editShortcutsObj.editMenuBar && this.editShortcutsObj.editMenuExternalBtn) {
        return this.editShortcutsObj.editMenuExternalUrl.replace('{filename}', this.filename)
      } else {
        return ''
      }
    }
  },
  created() {
    wikiStore.page.authorId = this.authorId
    wikiStore.page.authorName = this.authorName
    wikiStore.page.createdAt = this.createdAt
    wikiStore.page.description = this.description
    wikiStore.page.isPublished = this.isPublished
    wikiStore.page.id = this.pageId
    wikiStore.page.locale = this.locale
    wikiStore.page.path = this.path
    wikiStore.page.tags = this.tags
    wikiStore.page.title = this.title
    wikiStore.page.editor = this.editor
    wikiStore.page.updatedAt = this.updatedAt
    if (this.effectivePermissions) {
      wikiStore.page.effectivePermissions = JSON.parse(
        Buffer.from(this.effectivePermissions, 'base64').toString()
      ) as typeof wikiStore.page.effectivePermissions
    }
    if (this.editShortcuts) {
      wikiStore.page.editShortcuts = JSON.parse(
        Buffer.from(this.editShortcuts, 'base64').toString()
      ) as typeof wikiStore.page.editShortcuts
    }

    wikiStore.page.mode = 'view'
  },
  mounted () {
    if (this.$vuetify.theme.current.dark) {
      this.scrollStyle.bar.background = '#424242'
    }

    // -> Check side navigation visibility
    this.handleSideNavVisibility()
    window.addEventListener('resize', _.debounce(() => {
      this.handleSideNavVisibility()
    }, 500))

    // -> Highlight Code Blocks
    Prism.highlightAllUnder(this.$refs.container as HTMLElement)

    // -> Render Mermaid diagrams
    mermaid.initialize({
      startOnLoad: true,
      theme: this.$vuetify.theme.current.dark ? `dark` : `default`
    })

    // -> Handle anchor scrolling
    if (window.location.hash && window.location.hash.length > 1) {
      if (document.readyState === 'complete') {
        this.$nextTick(() => {
          this.goTo(decodeURIComponent(window.location.hash), this.scrollOpts)
        })
      } else {
        window.addEventListener('load', () => {
          this.goTo(decodeURIComponent(window.location.hash), this.scrollOpts)
        })
      }
    }

    // -> Handle anchor links within the page contents
    this.$nextTick(() => {
      const container = this.$refs.container as HTMLElement
      container.querySelectorAll<HTMLAnchorElement>(`a[href^="#"], a[href^="${window.location.href.replace(window.location.hash, '')}#"]`).forEach(el => {
        el.onclick = (ev: MouseEvent) => {
          ev.preventDefault()
          ev.stopPropagation()
          this.goTo(decodeURIComponent(el.hash), this.scrollOpts)
        }
      })

      boot.notify('page-ready')
    })
  },
  methods: {
    goHome () {
      if (this.locales && this.locales.length > 0) {
        window.location.assign(`/${this.locale}/home`)
      } else {
        window.location.assign('/')
      }
    },
    toggleNavigation () {
      this.navShown = !this.navShown
    },
    upBtnScroll () {
      const scrollOffset = window.pageYOffset || document.documentElement.scrollTop
      this.upBtnShown = scrollOffset > window.innerHeight * 0.33
    },
    print () {
      if (this.printView) {
        this.printView = false
      } else {
        this.printView = true
        this.$nextTick(() => {
          window.print()
        })
      }
    },
    pageEdit () {
      emitPageEdit()
    },
    pageHistory () {
      emitPageHistory()
    },
    pageSource () {
      emitPageSource()
    },
    pageConvert () {
      emitPageConvert()
    },
    pageDuplicate () {
      emitPageDuplicate()
    },
    pageMove () {
      emitPageMove()
    },
    pageDelete () {
      emitPageDelete()
    },
    handleSideNavVisibility () {
      if (window.innerWidth === this.winWidth) { return }
      this.winWidth = window.innerWidth
      if (this.$vuetify.display.mdAndUp) {
        this.navShown = true
      } else {
        this.navShown = false
      }
    },
    goToComments (focusNewComment = false) {
      this.goTo('#discussion', this.scrollOpts)
      if (focusNewComment) {
        document.querySelector<HTMLElement>('#discussion-new')?.focus()
      }
    }
  }
})
</script>

<style lang="scss">

.breadcrumbs-nav {
  .v-btn {
    min-width: 0;
    &__content {
      text-transform: none;
    }
  }
  .v-breadcrumbs__divider:nth-child(2n) {
    padding: 0 6px;
  }
  .v-breadcrumbs__divider:nth-child(2) {
    padding: 0 6px 0 12px;
  }
}

.page-col-sd {
  margin-top: -90px;
  align-self: flex-start;
  position: sticky;
  top: 64px;
  max-height: calc(100vh - 64px);
  overflow-y: auto;
  -ms-overflow-style: none;
}

.page-col-sd::-webkit-scrollbar {
  display: none;
}

.page-header-section {
  position: relative;

  > .is-page-header {
    position: relative;
  }

  .page-header-headings {
    min-height: 52px;
    display: flex;
    justify-content: center;
    flex-direction: column;
  }

  .page-edit-shortcuts {
    position: absolute;
    bottom: -33px;
    right: 10px;

    .v-btn {
      border-right: 1px solid #DDD !important;
      border-bottom: 1px solid #DDD !important;
      border-radius: 0;
      color: #777;
      background-color: #FFF !important;

      @at-root .theme--dark & {
        background-color: #222 !important;
        border-right-color: #444 !important;
        border-bottom-color: #444 !important;
        color: #CCC;
      }

      .v-icon {
        color: mc('blue', '700');
      }

      &:first-child {
        border-top-left-radius: 5px;
        border-bottom-left-radius: 5px;
      }

      &:last-child {
        border-top-right-radius: 5px;
        border-bottom-right-radius: 5px;
      }
    }
  }
}

</style>
