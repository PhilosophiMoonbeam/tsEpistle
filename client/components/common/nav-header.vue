<template lang='pug'>
  v-app-bar.nav-header(color='black', flat, :extended='searchIsShown && $vuetify.display.smAndDown')
    template(v-slot:extension v-if='searchIsShown && $vuetify.display.smAndDown')
      v-toolbar(color='deep-purple', flat)
        v-text-field(
          ref='searchFieldMobile'
          v-model='search'
          clearable
          bg-color='deep-purple'
          color='white'
          :label='$t(`common:header.search`)'
          single-line
          variant="solo"
          flat
          hide-details
          prepend-inner-icon='mdi-magnify'
          :loading='searchIsLoading'
          @keyup.enter='searchEnter'
          autocomplete='off'
        )
    v-row(no-gutters)
      v-col(cols='5', md='4')
        v-toolbar.nav-header-inner(color='black', flat, :class='$vuetify.locale.isRtl ? `pr-3` : `pl-3`')
          slot(name='mobileBrand', v-if='$slots.mobileBrand && $vuetify.display.smAndDown')
          v-avatar(v-if='!$slots.mobileBrand || $vuetify.display.mdAndUp', tile, size='34', @click='goHome')
            img.org-logo(:src='logoUrl', :alt='title')
          v-toolbar-title(v-if='!$slots.mobileBrand || $vuetify.display.mdAndUp', :class='{ "mx-3": $vuetify.display.mdAndUp, "mx-1": $vuetify.display.smAndDown }')
            span.text-body-large {{title}}
      v-col(md='4', v-if='$vuetify.display.mdAndUp')
        v-toolbar.nav-header-inner(color='black', flat)
          slot(name='mid')
            transition(name='navHeaderSearch', v-if='searchIsShown')
              v-text-field(
                ref='searchField',
                v-if='searchIsShown && $vuetify.display.mdAndUp',
                v-model='search',
                color='white',
                :label='$t(`common:header.search`)',
                single-line,
                variant="solo"
                flat
                rounded
                hide-details,
                prepend-inner-icon='mdi-magnify',
                :loading='searchIsLoading',
                @keyup.enter='searchEnter'
                @keyup.esc='searchClose'
                @focus='searchFocus'
                @blur='searchBlur'
                @keyup.down='searchMove(`down`)'
                @keyup.up='searchMove(`up`)'
                autocomplete='off'
              )
            v-tooltip(location="bottom")
              template(v-slot:activator='{ props }')
                v-btn.ml-2.mr-0(icon, v-bind='props', href='/t', :aria-label='$t(`common:header.browseTags`)')
                  v-icon(color='grey') mdi-tag-multiple
              span {{$t('common:header.browseTags')}}
      v-col(cols='7', md='4')
        v-toolbar.nav-header-inner.pr-4(color='black', flat)
          v-spacer
          .navHeaderLoading.mr-3
            v-progress-circular(indeterminate, color='blue', :size='22', :width='2' v-show='isLoading', aria-label='Page loading')

          slot(name='actions')

          //- (mobile) SEARCH TOGGLE

          v-btn(
            v-if='!hideSearch && $vuetify.display.smAndDown'
            @click='searchToggle'
            icon
            :aria-label='$t(`common:header.search`)'
            )
            v-icon(color='grey') mdi-magnify

          //- LANGUAGES

          template(v-if='mode === `view` && locales.length > 0')
            v-menu(location="bottom left", transition='slide-y-transition', max-height='320px', min-width='210px')
              template(v-slot:activator='{ props: menuProps }')
                v-tooltip(location="bottom")
                  template(v-slot:activator='{ props: tooltipProps }')
                    v-btn(
                      icon
                      v-bind='{ ...menuProps, ...tooltipProps }'
                      :class='$vuetify.locale.isRtl ? `ml-3` : ``'
                      tile
                      height='64'
                      :aria-label='$t(`common:header.language`)'
                      )
                      v-icon(color='grey') mdi-web
                  span {{$t('common:header.language')}}
              v-list(nav)
                template(v-for='lc of locales', :key='lc.code')
                  v-list-item(@click='changeLocale(lc)')
                    template(v-slot:append): v-chip(:color='lc.code === locale ? `blue` : `grey`', size="small", label) {{lc.code.toUpperCase()}}
                    v-list-item-title {{lc.name}}
            v-divider(vertical)

          //- PAGE ACTIONS

          template(v-if='hasAnyPagePermissions && path && mode !== `edit`')
            v-menu(location="bottom left", transition='slide-y-transition')
              template(v-slot:activator='{ props: menuProps }')
                v-tooltip(location="bottom")
                  template(v-slot:activator='{ props: tooltipProps }')
                    v-btn(
                      icon
                      v-bind='{ ...menuProps, ...tooltipProps }'
                      :class='$vuetify.locale.isRtl ? `ml-3` : ``'
                      tile
                      height='64'
                      :aria-label='$t(`common:header.pageActions`)'
                      )
                      v-icon(color='grey') mdi-file-document-edit-outline
                  span {{$t('common:header.pageActions')}}
              v-list(nav, :class='$vuetify.theme.current.dark ? `bg-grey-darken-4` : ``')
                .text-label-small.pa-4.text-grey {{$t('common:header.currentPage')}}
                v-list-item.pl-4(@click='pageView', v-if='mode !== `view`')
                  template(v-slot:prepend)
                    v-avatar(size='24', tile): v-icon(color='indigo') mdi-file-document-outline
                  v-list-item-title.text-body-medium {{$t('common:header.view')}}
                v-list-item.pl-4(@click='pageEdit', v-if='mode !== `edit` && hasWritePagesPermission')
                  template(v-slot:prepend)
                    v-avatar(size='24', tile): v-icon(color='indigo') mdi-file-document-edit-outline
                  v-list-item-title.text-body-medium {{$t('common:header.edit')}}
                v-list-item.pl-4(@click='pageHistory', v-if='mode !== `history` && hasReadHistoryPermission')
                  template(v-slot:prepend)
                    v-avatar(size='24', tile): v-icon(color='indigo') mdi-history
                  v-list-item-title.text-body-medium {{$t('common:header.history')}}
                v-list-item.pl-4(@click='pageSource', v-if='mode !== `source` && hasReadSourcePermission')
                  template(v-slot:prepend)
                    v-avatar(size='24', tile): v-icon(color='indigo') mdi-code-tags
                  v-list-item-title.text-body-medium {{$t('common:header.viewSource')}}
                v-list-item.pl-4(@click='pageConvert', v-if='hasWritePagesPermission')
                  template(v-slot:prepend)
                    v-avatar(size='24', tile): v-icon(color='indigo') mdi-lightning-bolt
                  v-list-item-title.text-body-medium {{$t('common:header.convert')}}
                v-list-item.pl-4(@click='pageDuplicate', v-if='hasWritePagesPermission')
                  template(v-slot:prepend)
                    v-avatar(size='24', tile): v-icon(color='indigo') mdi-content-duplicate
                  v-list-item-title.text-body-medium {{$t('common:header.duplicate')}}
                v-list-item.pl-4(@click='pageMove', v-if='hasManagePagesPermission')
                  template(v-slot:prepend)
                    v-avatar(size='24', tile): v-icon(color='indigo') mdi-content-save-move-outline
                  v-list-item-title.text-body-medium {{$t('common:header.move')}}
                v-list-item.pl-4(@click='pageDelete', v-if='hasDeletePagesPermission')
                  template(v-slot:prepend)
                    v-avatar(size='24', tile): v-icon(color="red-darken-2") mdi-trash-can-outline
                  v-list-item-title.text-body-medium {{$t('common:header.delete')}}
            v-divider(vertical)

          //- NEW PAGE

          template(v-if='hasNewPagePermission && path && mode !== `edit`')
            v-tooltip(location="bottom")
              template(v-slot:activator='{ props }')
                v-btn(icon, tile, height='64', v-bind='props', @click='pageNew', :aria-label='$t(`common:header.newPage`)')
                  v-icon(color='grey') mdi-text-box-plus-outline
              span {{$t('common:header.newPage')}}
            v-divider(vertical)

          //- ADMIN

          template(v-if='isAuthenticated && isAdmin')
            v-tooltip(location="bottom", v-if='mode !== `admin`')
              template(v-slot:activator='{ props }')
                v-btn(icon, tile, height='64', v-bind='props', href='/a', :aria-label='$t(`common:header.admin`)')
                  v-icon(color='grey') mdi-cog
              span {{$t('common:header.admin')}}
            v-btn(v-else, variant="text", tile, height='64', href='/', :aria-label='$t(`common:actions.exit`)')
              v-icon(start, color='grey') mdi-exit-to-app
              span {{$t('common:actions.exit')}}
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
                    tile
                    height='64'
                    :aria-label='$t(`common:header.account`)'
                    )
                    v-icon(v-if='picture.kind === `initials`', color='grey') mdi-account-circle
                    v-avatar(v-else-if='picture.kind === `image`', :size='34')
                      v-img(:src='picture.url')
                span {{$t('common:header.account')}}
            v-list(nav)
              v-list-item.py-3(:class='$vuetify.theme.current.dark ? `bg-grey-darken-4-l5` : `bg-grey-lighten-5`')
                template(v-slot:prepend)
                  v-avatar
                    v-avatar.bg-blue(v-if='picture.kind === `initials`', :size='40')
                      span.text-white.text-body-large {{picture.initials}}
                    v-avatar(v-else-if='picture.kind === `image`', :size='40')
                      v-img(:src='picture.url')
                v-list-item-title {{name}}
                v-list-item-subtitle {{email}}
              v-list-item(href='/p')
                template(v-slot:append): v-icon(color='blue-grey') mdi-face-profile
                v-list-item-title(:class='$vuetify.theme.current.dark ? `text-blue-grey-lighten-3` : `text-blue-grey`') {{$t('common:header.profile')}}
              v-list-item(@click='logout')
                template(v-slot:append): v-icon(color='red') mdi-logout
                v-list-item-title.text-red {{$t('common:header.logout')}}

          v-tooltip(v-else, location="left")
            template(v-slot:activator='{ props }')
              v-btn(icon, v-bind='props', color="grey-darken-3", href='/login', :aria-label='$t(`common:header.login`)')
                v-icon(color='grey') mdi-account-circle
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
import { movePage } from '../../helpers/pages-api'

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
    locale(): string { return wikiStore.page.locale },
    mode(): string { return wikiStore.page.mode },
    name(): string { return wikiStore.user.name },
    email(): string { return wikiStore.user.email },
    pictureUrl(): string { return wikiStore.user.pictureUrl },
    isAuthenticated(): boolean { return wikiStore.user.authenticated },
    permissions(): string[] { return wikiStore.user.permissions },
    picture (): UserPicture {
      const pictureUrl = typeof this.pictureUrl === 'string' ? this.pictureUrl : ''
      if (pictureUrl.length > 1) {
        return {
          kind: 'image',
          url: (pictureUrl === 'internal') ? `/_userav/${wikiStore.user.id}` : pictureUrl
        }
      }

      const name = typeof this.name === 'string' ? this.name : ''
      const nameParts = name.toUpperCase().split(' ').filter(Boolean)
      let initials = nameParts[0]?.charAt(0) ?? ''
      if (nameParts.length > 1) {
        initials += nameParts[nameParts.length - 1]?.charAt(0) ?? ''
      }
      return {
        kind: 'initials',
        initials
      }
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
      return this.hasAdminPermission || this.hasWritePagesPermission || this.hasManagePagesPermission ||
        this.hasDeletePagesPermission || this.hasReadSourcePermission || this.hasReadHistoryPermission
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
  },
  beforeUnmount () {
    offPageEdit(this.pageEdit)
    offPageHistory(this.pageHistory)
    offPageSource(this.pageSource)
    offPageMove(this.pageMove)
    offPageConvert(this.pageConvert)
    offPageDuplicate(this.pageDuplicate)
    offPageDelete(this.pageDelete)
  },
  methods: {
    searchFocus () {
      this.searchIsFocused = true
    },
    searchBlur () {
      this.searchIsFocused = false
    },
    searchClose () {
      this.search = ''
      this.searchBlur()
    },
    searchToggle () {
      this.searchIsShown = !this.searchIsShown
      if (this.searchIsShown) {
        _.delay(() => {
          ;(this.$refs.searchFieldMobile as { focus: () => void }).focus()
        }, 200)
      }
    },
    searchEnter () {
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
          path
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
      await this.$i18n.changeLanguage(locale.code)
      switch (this.mode) {
        case 'view':
        case 'history':
          window.location.assign(`/${locale.code}/${this.path}`)
          break
      }
    },
    logout () {
      window.location.assign('/logout')
    },
    goHome () {
      if (this.locales && this.locales.length > 0) {
        window.location.assign(`/${this.locale}/home`)
      } else {
        window.location.assign('/')
      }
    }
  }
})
</script>

<style lang='scss'>

.nav-header {
  //z-index: 1000;

  .v-toolbar__extension {
    padding: 0;

    .v-toolbar__content {
      padding: 0;
    }
    .v-text-field .v-field__prepend-inner {
      padding: 0 14px 0 5px;
      padding-right: 14px;
    }
  }

  .org-logo {
    cursor: pointer;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  &-inner {
    .v-toolbar__content {
      padding: 0;

      @include until($tablet) {
        .v-btn--icon {
          width: 40px;
          min-width: 40px;
        }
      }
    }
  }

  &-search-adv {
    position: absolute;
    top: 7px;
    right: 12px;
    border-radius: 4px !important;

    @at-root .v-locale--is-rtl & {
      right: initial;
      left: 12px;
    }

    &::before {
      border-radius: 4px !important;
    }

    &:hover, &:focus {
      position: absolute !important;

      &::before {
        border-radius: 4px;
      }
    }
  }

  &-dev {
    background-color: mc('red', '600');
    position: absolute;
    top: 11px;
    left: 255px;
    padding: 5px 15px;
    border-radius: 5px;
    display: flex;

    .v-icon {
      margin-right: 15px;
    }

    .overline:nth-child(2) {
      text-transform: none;
    }
  }
}

.navHeaderSearch {
  &-enter-active, &-leave-active {
    transition: opacity .25s ease, transform .25s ease;
    opacity: 1;
  }
  &-enter-active {
    transition-delay: .25s;
  }
  &-enter, &-leave-to {
    opacity: 0;
    transform: scale(.7, .7);
  }
}
.navHeaderLoading { // To avoid search bar jumping
  width: 22px;
}

</style>
