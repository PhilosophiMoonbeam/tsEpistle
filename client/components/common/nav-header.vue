<template lang='pug'>
  v-app-bar.nav-header(:height='dense ? 56 : 64', color='surface', flat, :class='{ "nav-header--dense": dense }', :extended='searchIsShown && $vuetify.display.smAndDown')
    template(v-slot:extension)
      v-toolbar.nav-header-mobile-search(v-if='searchIsShown && $vuetify.display.smAndDown', id='nav-header-mobile-search', color='surface', flat)
        v-text-field.nav-header-search-control(
          ref='searchFieldMobile'
          v-model='search'
          clearable
          bg-color='surface'
          color='primary'
          :label='searchInputLabel'
          single-line
          variant="solo"
          flat
          hide-details
          :prepend-inner-icon='searchInputIcon'
          :loading='searchIsLoading'
          @keyup.enter='searchEnter($event)'
          @keyup.esc='searchClose'
          @focus='searchFocus'
          @keyup.down='searchMove(`down`)'
          @keyup.up='searchMove(`up`)'
          autocomplete='off'
        )
    v-row.nav-header-layout(no-gutters)
      v-col.nav-header-brand-col(cols='5', md='4')
        .nav-header-inner.nav-header-brand
          slot(name='mobileBrand', v-if='$slots.mobileBrand && $vuetify.display.smAndDown')
          button.nav-header-logo(
            v-if='!$slots.mobileBrand || $vuetify.display.mdAndUp'
            type='button'
            @click='goHome'
            :aria-label='$t(`common:header.home`)'
            )
            img.org-logo(:src='logoUrl', :alt='title')
          v-toolbar-title.nav-header-title(v-if='!$slots.mobileBrand || $vuetify.display.mdAndUp')
            span {{title}}
      v-col.nav-header-search-col(md='4', v-if='$vuetify.display.mdAndUp')
        .nav-header-inner.nav-header-command
          slot(name='mid')
            transition(name='navHeaderSearch', v-if='searchIsShown')
              v-text-field.nav-header-search-control(
                ref='searchField',
                v-if='searchIsShown && $vuetify.display.mdAndUp',
                v-model='search',
                clearable,
                color='primary',
                :label='searchInputLabel',
                single-line,
                variant="solo"
                flat
                hide-details,
                :prepend-inner-icon='searchInputIcon',
                :loading='searchIsLoading',
                @keyup.enter='searchEnter($event)'
                @keyup.esc='searchClose'
                @focus='searchFocus'
                @keyup.down='searchMove(`down`)'
                @keyup.up='searchMove(`up`)'
                autocomplete='off'
              )
            v-tooltip(location="bottom")
              template(v-slot:activator='{ props }')
                v-btn.nav-header-browse(icon, v-bind='props', href='/t', :aria-label='$t(`common:header.browseTags`)')
                  v-icon mdi-tag-multiple
              span {{$t('common:header.browseTags')}}
      v-col.nav-header-actions-col(cols='7', md='4')
        .nav-header-inner.nav-header-actions
          v-spacer
          .navHeaderLoading(v-show='isLoading')
            v-progress-circular(indeterminate, color='primary', :size='22', :width='2', aria-label='Page loading')

          //- (mobile) SEARCH TOGGLE

          v-btn(
            v-if='!hideSearch && $vuetify.display.smAndDown'
            @click='searchToggle'
            icon
            :size='dense ? `small` : `default`'
            :aria-expanded='searchIsShown ? `true` : `false`'
            aria-controls='nav-header-mobile-search'
            :aria-label='searchIsShown ? `Close search` : `Open search`'
          )
            v-icon {{ searchIsShown ? 'mdi-close' : 'mdi-magnify' }}
          .nav-header-slot-actions(v-if='$vuetify.display.mdAndUp')
            slot(name='actions')
          //- LANGUAGES

          template(v-if='mode === `view` && locales.length > 0 && $vuetify.display.mdAndUp')
            v-menu(location="bottom left", transition='slide-y-transition', max-height='320px', min-width='210px')
              template(v-slot:activator='{ props: menuProps }')
                v-tooltip(location="bottom")
                  template(v-slot:activator='{ props: tooltipProps }')
                    v-btn(
                      icon
                      v-bind='{ ...menuProps, ...tooltipProps }'
                      :class='$vuetify.locale.isRtl ? `ml-3` : ``'
                      rounded='0'
                      height='64'
                      :aria-label='$t(`common:header.language`)'
                      )
                      v-icon mdi-web
                  span {{$t('common:header.language')}}
              v-list.nav-header-menu(nav)
                template(v-for='lc of locales', :key='lc.code')
                  v-list-item(@click='changeLocale(lc)')
                    template(v-slot:append): v-chip(:color='lc.code === locale ? `primary` : `grey`', size="small", label) {{lc.code.toUpperCase()}}
                    v-list-item-title {{lc.name}}
            v-divider(vertical)

          //- PAGE ACTIONS

          template(v-if='hasAnyPagePermissions && path && mode !== `edit` && $vuetify.display.mdAndUp')
            v-menu(location="bottom left", transition='slide-y-transition', @update:model-value='pageActionsVisibilityChanged')
              template(v-slot:activator='{ props: menuProps }')
                v-tooltip(location="bottom")
                  template(v-slot:activator='{ props: tooltipProps }')
                    v-btn(
                      icon
                      v-bind='{ ...menuProps, ...tooltipProps }'
                      :class='$vuetify.locale.isRtl ? `ml-3` : ``'
                      rounded='0'
                      height='64'
                      :aria-label='$t(`common:header.pageActions`)'
                      )
                      v-icon mdi-file-document-edit-outline
                  span {{$t('common:header.pageActions')}}
              v-list.nav-header-menu.page-actions-menu(nav)
                .text-label-small.pa-4.text-grey {{$t('common:header.currentPage')}}
                v-list-item.pl-4(role='button', tabindex='0', @click='pageView', @keydown.enter='pageView', @keydown.space.prevent='pageView', v-if='mode !== `view`')
                  template(v-slot:prepend)
                    v-avatar(size='24', rounded='0'): v-icon(color='primary') mdi-file-document-outline
                  v-list-item-title.text-body-medium {{$t('common:header.view')}}
                v-list-item.pl-4(role='button', tabindex='0', @click='pageEdit', @keydown.enter='pageEdit', @keydown.space.prevent='pageEdit', v-if='mode !== `edit` && hasWritePagesPermission')
                  template(v-slot:prepend)
                    v-avatar(size='24', rounded='0'): v-icon(color='primary') mdi-file-document-edit-outline
                  v-list-item-title.text-body-medium {{$t('common:header.edit')}}
                v-list-item.pl-4(role='button', tabindex='0', @click='pageHistory', @keydown.enter='pageHistory', @keydown.space.prevent='pageHistory', v-if='mode !== `history` && hasReadHistoryPermission')
                  template(v-slot:prepend)
                    v-avatar(size='24', rounded='0'): v-icon(color='primary') mdi-history
                  v-list-item-title.text-body-medium {{$t('common:header.history')}}
                v-list-item.pl-4(role='button', tabindex='0', @click='pageSource', @keydown.enter='pageSource', @keydown.space.prevent='pageSource', v-if='mode !== `source` && hasReadSourcePermission')
                  template(v-slot:prepend)
                    v-avatar(size='24', rounded='0'): v-icon(color='primary') mdi-code-tags
                  v-list-item-title.text-body-medium {{$t('common:header.viewSource')}}
                v-list-item.pl-4(role='button', tabindex='0', @click='pageConvert', @keydown.enter='pageConvert', @keydown.space.prevent='pageConvert', v-if='hasWritePagesPermission')
                  template(v-slot:prepend)
                    v-avatar(size='24', rounded='0'): v-icon(color='primary') mdi-lightning-bolt
                  v-list-item-title.text-body-medium {{$t('common:header.convert')}}
                v-list-item.pl-4(role='button', tabindex='0', @click='pageDuplicate', @keydown.enter='pageDuplicate', @keydown.space.prevent='pageDuplicate', v-if='hasWritePagesPermission')
                  template(v-slot:prepend)
                    v-avatar(size='24', rounded='0'): v-icon(color='primary') mdi-content-duplicate
                  v-list-item-title.text-body-medium {{$t('common:header.duplicate')}}
                v-list-item.pl-4(role='button', tabindex='0', @click='pageMove', @keydown.enter='pageMove', @keydown.space.prevent='pageMove', v-if='hasManagePagesPermission')
                  template(v-slot:prepend)
                    v-avatar(size='24', rounded='0'): v-icon(color='primary') mdi-content-save-move-outline
                  v-list-item-title.text-body-medium {{$t('common:header.move')}}
                v-list-item.pl-4(role='button', tabindex='0', @click='pageDelete', @keydown.enter='pageDelete', @keydown.space.prevent='pageDelete', v-if='hasDeletePagesPermission')
                  template(v-slot:prepend)
                    v-avatar(size='24', rounded='0'): v-icon(color='error') mdi-trash-can-outline
                  v-list-item-title.text-body-medium {{$t('common:header.delete')}}
            v-divider(vertical)

          //- NEW PAGE

          template(v-if='hasNewPagePermission && path && mode !== `edit` && $vuetify.display.mdAndUp')
            v-tooltip(location="bottom")
              template(v-slot:activator='{ props }')
                v-btn(icon, rounded='0', height='64', v-bind='props', @click='pageNew', :aria-label='$t(`common:header.newPage`)')
                  v-icon mdi-text-box-plus-outline
              span {{$t('common:header.newPage')}}
            v-divider(vertical)

          //- ADMIN

          template(v-if='isAuthenticated && isAdmin && $vuetify.display.mdAndUp')
            v-tooltip(location="bottom", v-if='mode !== `admin`')
              template(v-slot:activator='{ props }')
                v-btn(icon, rounded='0', height='64', v-bind='props', href='/a', :aria-label='$t(`common:header.admin`)')
                  v-icon mdi-cog
              span {{$t('common:header.admin')}}
            v-btn(v-else, variant="text", rounded='0', height='64', href='/', :aria-label='$t(`common:actions.exit`)')
              v-icon(start) mdi-exit-to-app
          v-menu(v-if='hasMobilePageActions && $vuetify.display.smAndDown', location='bottom end', min-width='240')
            template(v-slot:activator='{ props }')
              v-btn(
                icon
                v-bind='props'
                :size='dense ? `small` : `default`'
                aria-label='More page actions'
              )
                v-icon mdi-dots-vertical
            v-list.nav-header-menu(nav)
              v-list-subheader Page actions
              v-list-item(v-if='path && mode !== `view`', prepend-icon='mdi-file-document-outline', @click='pageView')
                v-list-item-title {{$t('common:header.view')}}
              v-list-item(v-if='path && hasWritePagesPermission && mode !== `edit`', prepend-icon='mdi-file-document-edit-outline', @click='pageEdit')
                v-list-item-title {{$t('common:header.edit')}}
              v-list-item(v-if='path && hasReadHistoryPermission && mode !== `history`', prepend-icon='mdi-history', @click='pageHistory')
                v-list-item-title {{$t('common:header.history')}}
              v-list-item(v-if='path && hasReadSourcePermission && mode !== `source`', prepend-icon='mdi-code-tags', @click='pageSource')
                v-list-item-title {{$t('common:header.viewSource')}}
              v-list-item(v-if='path && hasWritePagesPermission', prepend-icon='mdi-lightning-bolt', @click='pageConvert')
                v-list-item-title {{$t('common:header.convert')}}
              v-list-item(v-if='path && hasWritePagesPermission', prepend-icon='mdi-content-duplicate', @click='pageDuplicate')
                v-list-item-title {{$t('common:header.duplicate')}}
              v-list-item(v-if='path && hasManagePagesPermission', prepend-icon='mdi-content-save-move-outline', @click='pageMove')
                v-list-item-title {{$t('common:header.move')}}
              v-list-item.nav-header-menu-danger(v-if='path && hasDeletePagesPermission', prepend-icon='mdi-trash-can-outline', @click='pageDelete')
                v-list-item-title {{$t('common:header.delete')}}
              v-divider(v-if='hasNewPagePermission || (isAuthenticated && isAdmin)')
              v-list-item(v-if='hasNewPagePermission && path && mode !== `edit`', prepend-icon='mdi-text-box-plus-outline', @click='pageNew')
                v-list-item-title {{$t('common:header.newPage')}}
              v-list-item(v-if='isAuthenticated && isAdmin && mode !== `admin`', prepend-icon='mdi-cog', href='/a')
                v-list-item-title {{$t('common:header.admin')}}
              v-list-item(v-if='isAuthenticated && isAdmin && mode === `admin`', prepend-icon='mdi-exit-to-app', href='/')
                v-list-item-title {{$t('common:actions.exit')}}
              template(v-if='mode === `view` && locales.length > 0')
                v-divider
                v-list-subheader {{$t('common:header.language')}}
                v-list-item(v-for='lc of locales', :key='`mobile-locale-${lc.code}`', prepend-icon='mdi-web', @click='changeLocale(lc)')
                  v-list-item-title {{lc.name}}
          v-divider(vertical)

          //- ACCOUNT

          v-menu(v-if='isAuthenticated', location="bottom left", min-width='300', transition='slide-y-transition')
            template(v-slot:activator='{ props: menuProps }')
              v-tooltip(location="bottom")
                template(v-slot:activator='{ props: tooltipProps }')
                  v-btn(
                    icon
                    v-bind='{ ...menuProps, ...tooltipProps }'
                    :class='$vuetify.locale.isRtl ? `ml-0` : ``'
                    rounded='0'
                    height='64'
                    :aria-label='$t(`common:header.account`)'
                    )
                    v-icon(v-if='picture.kind === `initials`') mdi-account-circle
                    v-avatar(v-else-if='picture.kind === `image`', :size='34')
                      v-img(:src='picture.url')
                span {{$t('common:header.account')}}
            v-list.nav-header-menu(nav)
              v-list-item.py-3(:class='$vuetify.theme.current.dark ? `bg-grey-darken-4` : `bg-grey-lighten-5`')
                template(v-slot:prepend)
                  v-avatar
                    v-avatar.bg-primary(v-if='picture.kind === `initials`', :size='40')
                      span.text-on-primary.text-body-large {{picture.initials}}
                    v-avatar(v-else-if='picture.kind === `image`', :size='40')
                      v-img(:src='picture.url')
                v-list-item-title {{name}}
                v-list-item-subtitle {{email}}
              v-list-item(href='/p')
                template(v-slot:append): v-icon(color='secondary') mdi-face-profile
                v-list-item-title.text-secondary {{$t('common:header.profile')}}
              v-list-item(@click='logout')
                template(v-slot:append): v-icon(color='error') mdi-logout
                v-list-item-title.text-error {{$t('common:header.logout')}}

          v-tooltip(v-else, location="left")
            template(v-slot:activator='{ props }')
              v-btn(icon, v-bind='props', href='/login', :aria-label='$t(`common:header.login`)')
                v-icon mdi-account-circle
            span {{$t('common:header.login')}}

    page-selector(mode='create', v-model='newPageModal', :open-handler='pageNewCreate', :locale='locale')
    page-selector(mode='move', v-model='movePageModal', :open-handler='pageMoveRename', :path='path', :locale='locale')
    page-selector(mode='create', v-model='duplicateOpts.modal', :open-handler='pageDuplicateHandle', :path='duplicateOpts.path', :locale='duplicateOpts.locale')
    page-delete(v-model='deletePageModal', v-if='path && path.length')
    page-convert(v-model='convertPageModal', v-if='path && path.length')

    .nav-header-dev(v-if='isDevMode')
      v-icon mdi-alert
      div
        .text-label-small DEVELOPMENT VERSION
        .text-label-small This code base is NOT for production use!</template>

<script lang='ts'>
import { defineAsyncComponent, defineComponent } from 'vue'
import { wikiStore } from '@/store/index.ts'
import _ from 'lodash'

import {
  offPageConvert,
  offPageDelete,
  offPageDuplicate,
  offPageEdit,
  offPageHistory,
  offPageMove,
  offPageSource,
  onPageConvert,
  onPageDelete,
  onPageDuplicate,
  onPageEdit,
  onPageHistory,
  onPageMove,
  onPageSource
} from '../../helpers/page-action-events'
import { emitSearchEnter, emitSearchMove } from '../../helpers/search-navigation-events'
import { fetchPageLocaleRelations, movePage } from '../../helpers/pages-api'
import { navigateToWikiPage } from '../../helpers/wiki-navigation'

type PageLocation = { path: string, locale: string }
type SiteLocale = { code: string, name: string }
type UserPicture =
  | { kind: 'image', url: string }
  | { kind: 'initials', initials: string }

/* global siteConfig, siteLangs */

export default defineComponent({
  components: {
    PageDelete: defineAsyncComponent(() => import('./page-delete.vue')),
    PageConvert: defineAsyncComponent(() => import('./page-convert.vue'))
  },
  props: {
    dense: {
      type: Boolean,
      default: false
    },
    hideSearch: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      menuIsShown: true,
      searchIsShown: true,
      searchAdvMenuShown: false,
      newPageModal: false,
      movePageModal: false,
      convertPageModal: false,
      deletePageModal: false,
      locales: siteLangs,
      isDevMode: false,
      duplicateOpts: {
        locale: 'en',
        path: 'new-page',
        modal: false
      }
    }
  },
  computed: {
    search: {
      get(): string { return wikiStore.site.search },
      set(value: string) { wikiStore.site.search = value }
    },
    searchMode: {
      get(): 'search' | 'ask' { return wikiStore.site.searchMode },
      set(value: 'search' | 'ask') { wikiStore.site.searchMode = value }
    },
    searchIsFocused: {
      get(): boolean { return wikiStore.site.searchIsFocused },
      set(value: boolean) { wikiStore.site.searchIsFocused = value }
    },
    searchIsLoading: {
      get(): boolean { return wikiStore.site.searchIsLoading },
      set(value: boolean) { wikiStore.site.searchIsLoading = value }
    },
    searchRestrictLocale: {
      get(): boolean { return wikiStore.site.searchRestrictLocale },
      set(value: boolean) { wikiStore.site.searchRestrictLocale = value }
    },
    searchRestrictPath: {
      get(): boolean { return wikiStore.site.searchRestrictPath },
      set(value: boolean) { wikiStore.site.searchRestrictPath = value }
    },
    isLoading(): boolean { return wikiStore.isLoading },
    title(): string { return wikiStore.site.title },
    logoUrl(): string { return wikiStore.site.logoUrl },
    path(): string { return wikiStore.page.path },
    mode(): string { return wikiStore.page.mode },
    locale(): string { return wikiStore.page.locale },
    name(): string { return wikiStore.user.name },
    email(): string { return wikiStore.user.email },
    pictureUrl(): string { return wikiStore.user.pictureUrl },
    isAuthenticated(): boolean { return wikiStore.user.authenticated },
    permissions(): string[] { return wikiStore.user.permissions },
    searchInputLabel(): string { return this.searchMode === 'ask' ? this.$t('common:header.askPlaceholder') : this.$t('common:header.search') },
    searchInputIcon(): string { return this.searchMode === 'ask' ? 'mdi-auto-fix' : 'mdi-magnify' },
    picture (): UserPicture {
      const pictureUrl = typeof this.pictureUrl === 'string' ? this.pictureUrl : ''
      if (pictureUrl.length > 1) {
        return { kind: 'image', url: (pictureUrl === 'internal') ? `/_userav/${wikiStore.user.id}` : pictureUrl }
      }
      const name = typeof this.name === 'string' ? this.name : ''
      const nameParts = name.toUpperCase().split(' ').filter(Boolean)
      let initials = nameParts[0]?.charAt(0) ?? ''
      if (nameParts.length > 1) initials += nameParts[nameParts.length - 1]?.charAt(0) ?? ''
      return { kind: 'initials', initials }
    },
    isAdmin () {
      return _.intersection(this.permissions, ['manage:system', 'write:users', 'manage:users', 'write:groups', 'manage:groups', 'manage:navigation', 'manage:theme', 'manage:api']).length > 0
    },
    hasNewPagePermission () {
      return this.hasAdminPermission || _.intersection(this.permissions, ['write:pages']).length > 0
    },
    hasAdminPermission(): boolean { return wikiStore.page.effectivePermissions.system.manage },
    hasWritePagesPermission(): boolean { return wikiStore.page.effectivePermissions.pages.write },
    hasManagePagesPermission(): boolean { return wikiStore.page.effectivePermissions.pages.manage },
    hasDeletePagesPermission(): boolean { return wikiStore.page.effectivePermissions.pages.delete },
    hasReadSourcePermission(): boolean { return wikiStore.page.effectivePermissions.source.read },
    hasReadHistoryPermission(): boolean { return wikiStore.page.effectivePermissions.history.read },
    hasAnyPagePermissions () {
      return this.hasWritePagesPermission || this.hasManagePagesPermission ||
        this.hasDeletePagesPermission || this.hasReadSourcePermission || this.hasReadHistoryPermission
    },
    hasMobilePageActions (): boolean {
      return Boolean(
        (this.path && (
          this.mode !== 'view' ||
          this.hasAnyPagePermissions ||
          this.hasNewPagePermission
        )) ||
        (this.isAuthenticated && this.isAdmin) ||
        (this.mode === 'view' && this.locales.length > 0)
      )
    }
  },
  created () {
    if (this.hideSearch || this.dense || this.$vuetify.display.smAndDown) {
      this.searchIsShown = false
    }
  },
  mounted () {
    onPageEdit(this.pageEdit)
    onPageHistory(this.pageHistory)
    onPageSource(this.pageSource)
    onPageMove(this.pageMove)
    onPageConvert(this.pageConvert)
    onPageDuplicate(this.pageDuplicate)
    onPageDelete(this.pageDelete)
    this.isDevMode = siteConfig.devMode === true
    window.addEventListener('keydown', this.handleSearchShortcut)
  },
  beforeUnmount () {
    offPageEdit(this.pageEdit)
    offPageHistory(this.pageHistory)
    offPageSource(this.pageSource)
    offPageMove(this.pageMove)
    offPageConvert(this.pageConvert)
    offPageDuplicate(this.pageDuplicate)
    offPageDelete(this.pageDelete)
    window.removeEventListener('keydown', this.handleSearchShortcut)
  },
  methods: {
    async pageActionsVisibilityChanged(open: boolean): Promise<void> {
      if (!open) return
      await this.$nextTick()
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('.page-actions-menu .v-list-item')?.focus()
      })
    },
    searchFocus () {
      this.searchIsFocused = true
    },
    searchClose () {
      this.search = ''
      this.searchMode = 'search'
      this.searchIsFocused = false
    },
    async focusSearchField(): Promise<void> {
      this.searchIsShown = true
      this.searchIsFocused = true
      await this.$nextTick()
      const field = this.$vuetify.display.smAndDown ? this.$refs.searchFieldMobile : this.$refs.searchField
      ;(field as { focus?: () => void } | undefined)?.focus?.()
    },
    searchToggle () {
      this.searchIsShown = !this.searchIsShown
      if (this.searchIsShown) void this.focusSearchField()
      else this.searchClose()
    },
    handleSearchShortcut(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.repeat || event.isComposing) return
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'a') return
      if (!siteConfig.agentsEnabled || !this.isAuthenticated || !this.permissions.some(permission => permission === 'use:agents' || permission === 'manage:system')) return
      event.preventDefault()
      if (this.searchMode === 'ask') {
        this.searchMode = 'search'
        void this.focusSearchField()
        return
      }
      this.searchIsShown = true
      this.searchMode = 'ask'
      void this.focusSearchField()
    },
    searchEnter (event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && siteConfig.agentsEnabled && this.isAuthenticated && this.permissions.some(permission => permission === 'use:agents' || permission === 'manage:system')) {
        event.preventDefault()
        this.searchMode = 'ask'
      }
      emitSearchEnter()
    },
    searchMove(dir: string): void {
      emitSearchMove(dir)
    },
    pageNew () {
      this.newPageModal = true
    },
    pageNewCreate ({ path, locale }: PageLocation): void {
      window.location.assign(`/e/${locale}/${path}`)
    },
    pageView () {
      const scope = wikiStore.page.visibility === 'private' ? '/_private' : ''
      window.location.assign(`${scope}/${this.locale}/${this.path}`)
    },
    pageEdit () {
      const scope = wikiStore.page.visibility === 'private' ? '/_private' : ''
      window.location.assign(`/e${scope}/${this.locale}/${this.path}`)
    },
    pageHistory () {
      const scope = wikiStore.page.visibility === 'private' ? '/_private' : ''
      window.location.assign(`/h${scope}/${this.locale}/${this.path}`)
    },
    pageSource () {
      const scope = wikiStore.page.visibility === 'private' ? '/_private' : ''
      window.location.assign(`/s${scope}/${this.locale}/${this.path}`)
    },
    pageDuplicate () {
      const pathParts = this.path.split('/')
      this.duplicateOpts = {
        locale: this.locale,
        path: (pathParts.length > 1) ? _.initial(pathParts).join('/') + `/new-page` : `new-page`,
        modal: true
      }
    },
    pageDuplicateHandle ({ locale, path }: PageLocation): void {
      window.location.assign(`/e/${locale}/${path}?from=${wikiStore.page.id}`)
    },
    pageConvert () {
      this.convertPageModal = true
    },
    pageMove () {
      this.movePageModal = true
    },
    async pageMoveRename ({ path, locale }: PageLocation): Promise<void> {
      wikiStore.startLoading('page-move')
      try {
        await movePage(
          window.fetch.bind(window),
          wikiStore.page.id,
          locale,
          path,
          wikiStore.page.sourceRevision
        )
        const scope = wikiStore.page.visibility === 'private' ? '/_private' : ''
        window.location.replace(`${scope}/${locale}/${path}`)
      } catch (err) {
        wikiStore.showError(err)
        wikiStore.stopLoading('page-move')
      }
    },
    pageDelete () {
      this.deletePageModal = true
    },
    async changeLocale (locale: SiteLocale): Promise<void> {
      let destinationPath = this.path
      let destinationVisibility = wikiStore.page.visibility
      try {
        const translations = await fetchPageLocaleRelations(window.fetch.bind(window), wikiStore.page.id)
        const translation = translations.find(candidate => candidate.locale === locale.code)
        if (translation) {
          destinationPath = translation.path
          destinationVisibility = translation.visibility
        }
      } catch (err) {
        console.warn(err)
      }
      const scope = destinationVisibility === 'private' ? '/_private' : ''
      window.location.assign(`${scope}/${locale.code}/${destinationPath}`)
    },
    logout () {
      window.location.assign('/logout')
    },
    goHome () {
      navigateToWikiPage(this.locales && this.locales.length > 0 ? `/${this.locale}/home` : '/')
    }
  }
})
</script>

<style lang='scss'>
.nav-header {
  --nav-header-accent-direction: 90deg;
  isolation: isolate;
  border-bottom: 1px solid var(--wiki-surface-border) !important;
  background:
    linear-gradient(
      var(--nav-header-accent-direction),
      color-mix(in srgb, var(--wiki-accent-warm) 5%, var(--wiki-surface-raised)),
      var(--wiki-surface-raised) 34%,
      var(--wiki-surface-raised) 70%,
      color-mix(in srgb, var(--wiki-accent-spectral) 4%, var(--wiki-surface-raised))
    ) !important;
  color: rgb(var(--v-theme-on-surface));
  box-shadow: var(--wiki-shadow-sm) !important;

  &::after {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 2;
    height: 1px;
    background: linear-gradient(
      var(--nav-header-accent-direction),
      transparent,
      color-mix(in srgb, var(--wiki-ambient-accent) 48%, transparent) 24%,
      color-mix(in srgb, var(--wiki-accent-spectral) 34%, transparent) 76%,
      transparent
    );
    pointer-events: none;
    content: '';
  }

  > .v-toolbar__content {
    overflow: hidden;
  }

  .v-toolbar__extension {
    overflow: hidden;
    padding-inline: var(--wiki-space-4);
    background: var(--wiki-surface-raised);

    .v-toolbar__content {
      height: auto !important;
      min-height: var(--wiki-control-height);
      padding: 0;
    }
  }

  .nav-header-layout {
    width: min(100%, var(--wiki-shell-max));
    height: 100%;
    margin-inline: auto;
  }

  .nav-header-brand-col,
  .nav-header-search-col,
  .nav-header-actions-col {
    min-width: 0;
  }

  .nav-header-inner {
    display: flex;
    width: 100%;
    height: 100%;
    align-items: center;
    gap: var(--wiki-space-1);
  }

  .nav-header-brand {
    gap: var(--wiki-space-3);
    padding-inline: var(--wiki-space-4) var(--wiki-space-3);
  }

  .nav-header-logo {
    position: relative;
    display: inline-grid;
    flex: 0 0 calc(var(--wiki-control-height) - var(--wiki-space-1));
    width: calc(var(--wiki-control-height) - var(--wiki-space-1));
    height: calc(var(--wiki-control-height) - var(--wiki-space-1));
    padding: var(--wiki-space-2);
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 24%, var(--wiki-surface-border));
    border-radius: var(--wiki-control-radius);
    background:
      linear-gradient(
        145deg,
        color-mix(in srgb, var(--wiki-accent-warm) 11%, var(--wiki-surface-raised)),
        color-mix(in srgb, var(--wiki-accent-spectral) 7%, var(--wiki-surface-raised))
      );
    box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);
    cursor: pointer;
    transition:
      transform var(--wiki-motion-normal) var(--wiki-motion-ease-out),
      border-color var(--wiki-motion-normal) var(--wiki-motion-ease),
      box-shadow var(--wiki-motion-normal) var(--wiki-motion-ease);

    &:hover {
      transform: translateY(-1px);
      border-color: color-mix(in srgb, var(--wiki-ambient-accent) 48%, var(--wiki-surface-border));
      box-shadow: var(--wiki-shadow-sm), var(--wiki-shadow-inset);
    }

    &:active {
      transform: translateY(0);
    }
  }

  .org-logo {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .nav-header-title {
    min-width: 0;
    margin: 0;
    color: rgb(var(--v-theme-on-surface));
    font-family: var(--wiki-font-heading);
    font-size: 1rem;
    font-weight: 720;
    letter-spacing: -.018em;
    line-height: var(--wiki-leading-heading);

    span {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .nav-header-command {
    justify-content: center;
    gap: var(--wiki-space-2);
  }

  .nav-header-search-control {
    min-width: 0;
    max-width: 34rem;

    .v-field {
      min-height: var(--wiki-control-height);
      overflow: hidden;
      border: 1px solid var(--wiki-surface-border-strong);
      border-radius: var(--wiki-control-radius);
      background: var(--wiki-surface-sunken) !important;
      box-shadow: var(--wiki-shadow-inset);
      transition:
        border-color var(--wiki-motion-normal) var(--wiki-motion-ease),
        background-color var(--wiki-motion-normal) var(--wiki-motion-ease),
        box-shadow var(--wiki-motion-normal) var(--wiki-motion-ease);
    }

    .v-field__input {
      min-height: var(--wiki-control-height);
      padding-block: 0;
      font-size: .875rem;
      font-weight: 560;
      letter-spacing: .005em;
    }

    .v-field__prepend-inner {
      color: var(--wiki-ambient-accent);
      opacity: 1;
    }

    .v-label {
      color: rgb(var(--v-theme-on-surface));
      font-size: .8125rem;
      opacity: .62;
    }

    .v-field--focused {
      border-color: color-mix(in srgb, var(--wiki-ambient-accent) 62%, transparent);
      background: var(--wiki-surface-raised) !important;
      box-shadow: var(--wiki-focus-ring), var(--wiki-shadow-inset);

      .v-field__prepend-inner {
        color: var(--wiki-accent-warm);
      }
    }

    .v-progress-linear {
      color: var(--wiki-accent-spectral) !important;
    }
  }

  .nav-header-mobile-search {
    width: 100%;
    background: transparent !important;

    .nav-header-search-control {
      max-width: none;
    }
  }

  .nav-header-actions {
    gap: var(--wiki-space-1);
    padding-inline: var(--wiki-space-3) var(--wiki-space-4);
  }

  .nav-header-slot-actions {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: var(--wiki-space-1);
  }

  .nav-header-inner .v-btn {
    min-width: var(--wiki-control-height);
    height: var(--wiki-control-height) !important;
    border: 1px solid transparent;
    border-radius: var(--wiki-control-radius) !important;
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 76%, transparent);
    opacity: 1;
    transition:
      border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
      background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
      color var(--wiki-motion-fast) var(--wiki-motion-ease),
      transform var(--wiki-motion-fast) var(--wiki-motion-ease-out);

    .v-icon {
      color: currentColor !important;
    }

    &:hover {
      border-color: color-mix(in srgb, var(--wiki-ambient-accent) 20%, transparent);
      background: color-mix(in srgb, var(--wiki-ambient-accent) 9%, transparent);
      color: var(--wiki-accent-warm);
      transform: translateY(-1px);
    }

    &:focus-visible {
      border-color: color-mix(in srgb, var(--wiki-focus-color) 48%, transparent);
      background: color-mix(in srgb, var(--wiki-focus-color) 8%, transparent);
      color: var(--wiki-accent-warm);
    }

    &:active {
      transform: translateY(0);
    }

    &[aria-expanded='true'] {
      border-color: color-mix(in srgb, var(--wiki-accent-spectral) 34%, transparent);
      background: color-mix(in srgb, var(--wiki-accent-spectral) 10%, transparent);
      color: var(--wiki-accent-spectral);
    }

    &.v-btn--disabled {
      border-color: transparent;
      background: transparent;
      color: rgb(var(--v-theme-on-surface));
      opacity: .38;
      transform: none;
    }
  }

  .nav-header-browse {
    flex: 0 0 auto;
    margin-inline-start: var(--wiki-space-1);
  }

  .nav-header-inner .v-divider {
    align-self: center;
    height: var(--wiki-space-6);
    max-height: var(--wiki-space-6);
    margin-inline: var(--wiki-space-1);
    border-color: var(--wiki-surface-border);
    opacity: 1;
  }

  .nav-header-dev {
    position: absolute;
    top: 50%;
    inset-inline-start: calc(25% - var(--wiki-space-10));
    z-index: 3;
    display: flex;
    max-width: 13rem;
    align-items: center;
    gap: var(--wiki-space-2);
    padding: var(--wiki-space-1) var(--wiki-space-3);
    transform: translateY(-50%);
    border: 1px solid color-mix(in srgb, rgb(var(--v-theme-error)) 30%, transparent);
    border-radius: var(--wiki-radius-pill);
    background: color-mix(in srgb, rgb(var(--v-theme-error)) 9%, var(--wiki-surface-raised));
    color: rgb(var(--v-theme-error));
    box-shadow: var(--wiki-shadow-xs);

    .text-label-small {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;

      &:nth-child(2) {
        text-transform: none;
      }
    }
  }
}

.nav-header-menu {
  min-width: 14rem;
  padding: var(--wiki-space-2) !important;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius) !important;
  background: var(--wiki-surface-raised) !important;
  color: rgb(var(--v-theme-on-surface));
  box-shadow: var(--wiki-shadow-md) !important;

  .v-list-subheader,
  > .text-label-small {
    min-height: var(--wiki-space-8);
    padding-inline: var(--wiki-space-3) !important;
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 56%, transparent) !important;
    font-size: var(--wiki-label-size);
    font-weight: var(--wiki-label-weight);
    letter-spacing: .075em;
    text-transform: uppercase;
  }

  .v-list-item {
    min-height: var(--wiki-control-height);
    margin-block: var(--wiki-space-1);
    border: 1px solid transparent;
    border-radius: var(--wiki-control-radius);
    transition:
      border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
      background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
      color var(--wiki-motion-fast) var(--wiki-motion-ease);

    &:hover,
    &:focus-visible {
      border-color: color-mix(in srgb, var(--wiki-ambient-accent) 18%, transparent);
      background: color-mix(in srgb, var(--wiki-ambient-accent) 8%, transparent);
      color: var(--wiki-accent-warm);
    }

    &.v-list-item--active {
      border-color: color-mix(in srgb, var(--wiki-accent-spectral) 28%, transparent);
      background: color-mix(in srgb, var(--wiki-accent-spectral) 10%, transparent);
      color: var(--wiki-accent-spectral);
    }

    &.v-list-item--disabled {
      opacity: .4;
    }
  }

  .nav-header-menu-danger {
    color: rgb(var(--v-theme-error));

    &:hover,
    &:focus-visible {
      border-color: color-mix(in srgb, rgb(var(--v-theme-error)) 24%, transparent);
      background: color-mix(in srgb, rgb(var(--v-theme-error)) 8%, transparent);
      color: rgb(var(--v-theme-error));
    }
  }

  .v-list-item.bg-grey-darken-4,
  .v-list-item.bg-grey-lighten-5 {
    border-color: var(--wiki-surface-border);
    background: var(--wiki-surface-sunken) !important;
  }

  .v-divider {
    margin-block: var(--wiki-space-2);
    border-color: var(--wiki-surface-border);
    opacity: 1;
  }
}

.navHeaderSearch {
  &-enter-active,
  &-leave-active {
    opacity: 1;
    transition:
      opacity var(--wiki-motion-normal) var(--wiki-motion-ease),
      transform var(--wiki-motion-normal) var(--wiki-motion-ease-out);
  }

  &-enter-active {
    transition-delay: var(--wiki-motion-fast);
  }

  &-enter-from,
  &-leave-to {
    opacity: 0;
    transform: translateY(calc(var(--wiki-space-1) * -1)) scale(.98);
  }
}

.nav-header--dense {
  .nav-header-logo {
    flex-basis: calc(var(--wiki-control-height) - var(--wiki-space-2));
    width: calc(var(--wiki-control-height) - var(--wiki-space-2));
    height: calc(var(--wiki-control-height) - var(--wiki-space-2));
  }

  .nav-header-inner .v-btn {
    min-width: calc(var(--wiki-control-height) - var(--wiki-space-1));
    height: calc(var(--wiki-control-height) - var(--wiki-space-1)) !important;
  }
}

.navHeaderLoading {
  flex: 0 0 var(--wiki-space-6);
  width: var(--wiki-space-6);
}

.v-locale--is-rtl .nav-header {
  --nav-header-accent-direction: 270deg;
}

.v-theme--dark .nav-header {
  border-bottom-color: var(--wiki-surface-border-strong) !important;
  background:
    linear-gradient(
      var(--nav-header-accent-direction),
      color-mix(in srgb, var(--wiki-accent-warm) 7%, var(--wiki-surface-raised)),
      var(--wiki-surface-raised) 36%,
      var(--wiki-surface-raised) 68%,
      color-mix(in srgb, var(--wiki-accent-spectral) 6%, var(--wiki-surface-raised))
    ) !important;
  box-shadow: 0 var(--wiki-space-2) var(--wiki-space-8) color-mix(in srgb, rgb(var(--v-theme-background)) 54%, transparent) !important;
}

@media (max-width: 1279px) {
  .nav-header .nav-header-dev {
    display: none;
  }
}

@media (min-width: 960px) and (max-width: 1279px) {
  .nav-header {
    .nav-header-brand {
      padding-inline: var(--wiki-space-3) var(--wiki-space-2);
    }

    .nav-header-actions {
      padding-inline: var(--wiki-space-2);
    }

    .nav-header-actions .v-btn {
      min-width: calc(var(--wiki-control-height) - var(--wiki-space-2));
      height: calc(var(--wiki-control-height) - var(--wiki-space-2)) !important;
      padding-inline: var(--wiki-space-2);
    }

    .nav-header-actions .v-divider {
      margin-inline: 0;
    }

    .nav-header-search-control .v-field__input {
      font-size: .8125rem;
    }
  }
}

@media (max-width: 959px) {
  .nav-header {
    .nav-header-brand {
      padding-inline: var(--wiki-space-3) var(--wiki-space-2);
    }

    .nav-header-actions {
      min-width: 0;
      padding-inline: var(--wiki-space-2) var(--wiki-space-3);
    }

    .nav-header-title {
      font-size: .9375rem;
    }

    .nav-header-inner .v-btn {
      min-width: var(--wiki-control-height);
      padding-inline: var(--wiki-space-2);
    }
    .nav-header-mobile-search .nav-header-search-control .v-field__input {
      font-size: 1rem;
    }
  }
}

@media (max-width: 599px) {
  .nav-header {
    .v-toolbar__extension {
      padding-inline: var(--wiki-space-3);
    }

    .nav-header-brand {
      gap: var(--wiki-space-2);
      padding-inline: var(--wiki-space-3) var(--wiki-space-1);
    }

    .nav-header-actions {
      flex: 1 1 auto;
      min-width: 0;
      padding-inline: var(--wiki-space-1) var(--wiki-space-2);
    }

    .nav-header-title {
      font-size: .875rem;
    }

    .nav-header-logo {
      flex-basis: calc(var(--wiki-control-height) - var(--wiki-space-2));
      width: calc(var(--wiki-control-height) - var(--wiki-space-2));
      height: calc(var(--wiki-control-height) - var(--wiki-space-2));
      padding: var(--wiki-space-1);
    }

    .nav-header-inner .v-btn {
      min-width: calc(var(--wiki-control-height) - var(--wiki-space-1));
      height: calc(var(--wiki-control-height) - var(--wiki-space-1)) !important;
    }

    .navHeaderLoading {
      margin-inline-end: var(--wiki-space-1) !important;
    }
  }

  .nav-header-menu {
    width: min(calc(100vw - (var(--wiki-space-4) * 2)), 20rem);
    max-height: min(70dvh, 34rem);
    overflow-y: auto;
  }
}

@media (forced-colors: active) {
  .nav-header,
  .nav-header .nav-header-logo,
  .nav-header .nav-header-search-control .v-field,
  .nav-header-menu,
  .nav-header-menu .v-list-item {
    border-color: CanvasText !important;
  }

  .nav-header::after {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .nav-header *,
  .navHeaderSearch-enter-active,
  .navHeaderSearch-leave-active,
  .nav-header-menu .v-list-item {
    transition-duration: .01ms !important;
  }
}
</style>
