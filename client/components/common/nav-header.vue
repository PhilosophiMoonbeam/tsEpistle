<template lang='pug'>
  v-app-bar.nav-header(:height='dense ? 56 : 64', flat, :class='{ "nav-header--dense": dense, "nav-header--reserved-actions": reserveActions }', :extended='searchIsShown && $vuetify.display.smAndDown', style='backdrop-filter: var(--wiki-chrome-blur);')
    template(v-slot:extension)
      v-toolbar.nav-header-mobile-search(v-if='searchIsShown && $vuetify.display.smAndDown', id='nav-header-mobile-search', flat, style='backdrop-filter: var(--wiki-chrome-blur);')
        v-text-field.nav-header-search-control(
          style='backdrop-filter: blur(12px) saturate(150%);'
          ref='searchFieldMobile'
          v-model='search'
          clearable
          color='primary'
          :label='searchInputLabel'
          single-line
          variant="solo"
          flat
          hide-details
          :prepend-inner-icon='searchInputIcon'
          :loading='searchIsLoading'
          @keydown.enter='searchEnter($event)'
          @keydown.esc='searchEscape'
          @keydown.tab='searchTab($event)'
          @focus='searchFocus'
          @keydown.down.prevent='searchMove(`down`)'
          @keydown.up.prevent='searchMove(`up`)'
          autocomplete='off'
        )
    v-row.nav-header-layout(:gap='0')
      v-col.nav-header-brand-col(cols='5', md='4')
        .nav-header-inner.nav-header-brand
          slot(name='mobileBrand', v-if='$slots.mobileBrand && $vuetify.display.smAndDown')
          a.nav-header-logo(
            v-if='!$slots.mobileBrand || $vuetify.display.mdAndUp'
            :href='homePath'
            :title='!transportVerified ? navigationUnavailableReason : undefined'
            :aria-label='$t(`common:header.home`)'
            @click='guardHeaderNavigation'
          )
            img.org-logo(
              v-if='logoUrl && !logoImageFailed'
              :key='logoUrl'
              :src='logoUrl'
              :data-logo-source='logoUrl'
              alt=''
              @error='handleLogoError'
              @load='handleLogoLoad'
            )
            .nav-header-logo-fallback(v-else, aria-hidden='true') {{ logoFallback }}
          v-toolbar-title.nav-header-title(v-if='!$slots.mobileBrand || $vuetify.display.mdAndUp')
            span {{title}}
      v-col.nav-header-search-col(md='4', v-if='$vuetify.display.mdAndUp')
        .nav-header-inner.nav-header-command
          v-tooltip(location="bottom", v-if='!hideSearch')
            template(v-slot:activator='{ props }')
              v-btn.nav-header-browse(
                v-bind='props'
                icon
                href='/t'
                :disabled='!transportVerified'
                :title='!transportVerified ? navigationUnavailableReason : undefined'
                data-search-modal-action
                variant='outlined'
                :aria-current='mode === `tags` ? `page` : undefined'
                :aria-label='$t(`common:header.browseTags`)'
                @click='guardHeaderNavigation'
              )
                v-icon(size='18') mdi-tag-outline
            span {{$t('common:header.browseTags')}}

          slot(name='mid')
            transition(name='navHeaderSearch', v-if='searchIsShown')
              v-text-field.nav-header-search-control(
                style='backdrop-filter: blur(12px) saturate(150%);'
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
                @keydown.enter='searchEnter($event)'
                @keydown.esc='searchClose'
                @keydown.tab='searchTab($event)'
                @focus='searchFocus'
                @keydown.down.prevent='searchMove(`down`)'
                @keydown.up.prevent='searchMove(`up`)'
                autocomplete='off'
                aria-keyshortcuts='Control+k Meta+k'
              )
                template(v-slot:append-inner)
                  kbd.nav-header-search-key(v-if='!search && !searchIsFocused', aria-hidden='true') {{ searchShortcutLabel }}



      v-col.nav-header-actions-col(cols='7', md='4')
        .nav-header-inner.nav-header-actions
          v-spacer
          .navHeaderLoading(v-show='isLoading')
            v-progress-circular(indeterminate, color='primary', :size='22', :width='2', aria-label='Page loading')
          v-btn.nav-header-agent(
            v-if='canEnterAgent && $vuetify.display.mdAndUp'
            prepend-icon='mdi-creation-outline'
            aria-label='Open Wiki Agent'
            title='Wiki Agent · Ctrl/⌘ + Shift + A'
            variant='tonal'
            color='primary'
            size='small'
            data-search-modal-action
            @click='openAgent'
          )
            span.nav-header-agent-label Agent
            ControlBorderBeam(:enabled='canEnterAgent' :phase-offset-ms='0')
          template(v-if='hasWritePagesPermission && path && mode !== `edit` && $vuetify.display.mdAndUp')
            v-btn.nav-header-edit-btn(
              variant='tonal'
              color='primary'
              size='small'
              rounded='lg'
              prepend-icon='mdi-pencil'
              :disabled='!onlineActionReady'
              :title='!onlineActionReady ? onlineActionUnavailableReason : undefined'
              @click='pageEdit'
              :aria-label='$t(`common:header.edit`)'
            )
              span.nav-header-edit-label.font-weight-medium {{$t('common:header.edit')}}

          v-btn.nav-header-agent(
            v-if='canEnterAgent && $vuetify.display.smAndDown'
            icon
            aria-label='Open Wiki Agent'
            title='Wiki Agent · Ctrl/⌘ + Shift + A'
            variant='tonal'
            color='primary'
            size='small'
            data-search-modal-action
            @click='openAgent'
          )
            v-icon(icon='mdi-creation-outline')
            ControlBorderBeam(:enabled='canEnterAgent' :phase-offset-ms='0')

          //- (mobile) SEARCH TOGGLE

          v-btn.nav-header-search-toggle(
            ref='searchToggle'
            v-if='!hideSearch && $vuetify.display.smAndDown'
            @click='searchToggle'
            icon
            data-search-modal-action
            :size='dense ? `small` : `default`'
            :aria-expanded='searchIsShown ? `true` : `false`'
            aria-controls='nav-header-mobile-search'
            :aria-label='searchIsShown ? `Close search` : `Open search`'
          )
            v-icon {{ searchIsShown ? 'mdi-close' : 'mdi-magnify' }}
          v-tooltip.nav-header-mobile-browse(v-if='!hideSearch && $vuetify.display.smAndDown', location='bottom')
            template(v-slot:activator='{ props }')
              v-btn.nav-header-browse(
                v-bind='props'
                icon
                href='/t'
                :disabled='!transportVerified'
                :title='!transportVerified ? navigationUnavailableReason : undefined'
                data-search-modal-action
                :aria-current='mode === `tags` ? `page` : undefined'
                :aria-label='$t(`common:header.browseTags`)'
                @click='guardHeaderNavigation'
              )
                v-icon mdi-tag-outline
            span {{$t('common:header.browseTags')}}
          .nav-header-slot-actions(v-if='$vuetify.display.mdAndUp || mobileActions')
            slot(name='actions')
          //- LANGUAGES

          template(v-if='mode === `view` && locales.length > 0 && $vuetify.display.mdAndUp')
            v-menu(location="bottom end", transition='slide-y-transition', max-height='320px', min-width='210px')
              template(v-slot:activator='{ props: menuProps }')
                v-tooltip(location="bottom")
                  template(v-slot:activator='{ props: tooltipProps }')
                    v-btn(
                      icon
                      v-bind='mergeProps(menuProps, tooltipProps)'
                      :class='$vuetify.locale.isRtl ? `ml-3` : ``'
                      rounded='lg'
                      :aria-label='$t(`common:header.language`)'
                      )
                      v-icon mdi-web
                  span {{$t('common:header.language')}}
              v-list.nav-header-menu(nav)
                template(v-for='lc of locales', :key='lc.code')
                  v-list-item(
                    role='button'
                    link
                    :disabled='!readerActionReady'
                    :title='!readerActionReady ? onlineActionUnavailableReason : undefined'
                    :aria-current='lc.code === locale ? `true` : undefined'
                    @click='changeLocale(lc)'
                  )
                    template(v-slot:append): v-chip(:color='lc.code === locale ? `primary` : `grey`', size="small", label) {{lc.code.toUpperCase()}}
                    v-list-item-title {{lc.name}}

          //- PAGE ACTIONS

          template(v-if='hasAnyPagePermissions && path && mode !== `edit` && $vuetify.display.mdAndUp')
            v-menu(location="bottom end", transition='slide-y-transition', @update:model-value='pageActionsVisibilityChanged')
              template(v-slot:activator='{ props: menuProps }')
                v-tooltip(location="bottom")
                  template(v-slot:activator='{ props: tooltipProps }')
                    v-btn(
                      icon
                      v-bind='mergeProps(menuProps, tooltipProps)'
                      rounded='lg'
                      :aria-label='$t(`common:header.pageActions`)'
                      )
                      v-icon mdi-dots-horizontal
                  span {{$t('common:header.pageActions')}}
              v-list.nav-header-menu.page-actions-menu(ref='pageActionsMenu' nav)
                .text-label-small.pa-4.text-grey {{$t('common:header.currentPage')}}
                v-list-item.pl-4(
                  role='button'
                  link
                  :disabled='!readerActionReady'
                  :title='!readerActionReady ? onlineActionUnavailableReason : undefined'
                  @click='pageView'
                  v-if='mode !== `view`'
                )
                  template(v-slot:prepend): v-icon(color='primary') mdi-file-document-outline
                  v-list-item-title.text-body-medium {{$t('common:header.view')}}
                v-list-item.pl-4(
                  role='button'
                  link
                  :disabled='!onlineActionReady'
                  :title='!onlineActionReady ? onlineActionUnavailableReason : undefined'
                  @click='pageHistory'
                  v-if='mode !== `history` && hasReadHistoryPermission'
                )
                  template(v-slot:prepend): v-icon(color='primary') mdi-history
                  v-list-item-title.text-body-medium {{$t('common:header.history')}}
                v-list-item.pl-4(
                  role='button'
                  link
                  :disabled='!onlineActionReady'
                  :title='!onlineActionReady ? onlineActionUnavailableReason : undefined'
                  @click='pageSource'
                  v-if='mode !== `source` && hasReadSourcePermission'
                )
                  template(v-slot:prepend): v-icon(color='primary') mdi-code-tags
                  v-list-item-title.text-body-medium {{$t('common:header.viewSource')}}
                v-list-item.pl-4(
                  role='button'
                  link
                  :disabled='!onlineActionReady'
                  :title='!onlineActionReady ? onlineActionUnavailableReason : undefined'
                  @click='pageConvert'
                  v-if='hasWritePagesPermission'
                )
                  template(v-slot:prepend): v-icon(color='primary') mdi-lightning-bolt
                  v-list-item-title.text-body-medium {{$t('common:header.convert')}}
                v-list-item.pl-4(
                  role='button'
                  link
                  :disabled='!onlineActionReady'
                  :title='!onlineActionReady ? onlineActionUnavailableReason : undefined'
                  @click='pageDuplicate'
                  v-if='hasWritePagesPermission'
                )
                  template(v-slot:prepend): v-icon(color='primary') mdi-content-duplicate
                  v-list-item-title.text-body-medium {{$t('common:header.duplicate')}}
                v-list-item.pl-4(
                  role='button'
                  link
                  :disabled='!onlineActionReady'
                  :title='!onlineActionReady ? onlineActionUnavailableReason : undefined'
                  @click='pageMove'
                  v-if='hasManagePagesPermission'
                )
                  template(v-slot:prepend): v-icon(color='primary') mdi-content-save-move-outline
                  v-list-item-title.text-body-medium {{$t('common:header.move')}}
                v-list-item.pl-4(
                  role='button'
                  link
                  :disabled='!onlineActionReady'
                  :title='!onlineActionReady ? onlineActionUnavailableReason : undefined'
                  @click='pageDelete'
                  v-if='hasDeletePagesPermission'
                )
                  template(v-slot:prepend): v-icon(color='error') mdi-trash-can-outline
                  v-list-item-title.text-body-medium {{$t('common:header.delete')}}

          //- NEW PAGE

          template(v-if='hasNewPagePermission && path && mode !== `edit` && $vuetify.display.mdAndUp')
            v-tooltip(location="bottom")
              template(v-slot:activator='{ props }')
                v-btn(
                  icon
                  rounded='lg'
                  v-bind='props'
                  :disabled='!onlineActionReady'
                  :title='!onlineActionReady ? onlineActionUnavailableReason : undefined'
                  @click='pageNew'
                  :aria-label='$t(`common:header.newPage`)'
                )
                  v-icon mdi-text-box-plus-outline
              span {{$t('common:header.newPage')}}

          //- ADMIN

          template(v-if='isAuthenticated && isAdmin && $vuetify.display.mdAndUp')
            v-tooltip(location="bottom", v-if='mode !== `admin`')
              template(v-slot:activator='{ props }')
                v-btn(
                  icon
                  rounded='lg'
                  v-bind='props'
                  :disabled='!onlineActionReady'
                  :title='!onlineActionReady ? onlineActionUnavailableReason : undefined'
                  @click='openAdmin'
                  :aria-label='$t(`common:header.admin`)'
                )
                  v-icon mdi-cog
              span {{$t('common:header.admin')}}
            v-btn(v-else, variant="text", rounded='lg', @click='exitAdmin', :aria-label='$t(`common:actions.exit`)')
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
              v-list-item(
                role='button'
                link
                v-if='path && mode !== `view`'
                :disabled='!readerActionReady'
                :title='!readerActionReady ? onlineActionUnavailableReason : undefined'
                prepend-icon='mdi-file-document-outline'
                @click='pageView'
              )
                v-list-item-title {{$t('common:header.view')}}
              v-list-item(
                role='button'
                link
                v-if='path && hasWritePagesPermission && mode !== `edit`'
                :disabled='!onlineActionReady'
                :title='!onlineActionReady ? onlineActionUnavailableReason : undefined'
                prepend-icon='mdi-file-document-edit-outline'
                @click='pageEdit'
              )
                v-list-item-title {{$t('common:header.edit')}}
              v-list-item(
                role='button'
                link
                v-if='path && hasReadHistoryPermission && mode !== `history`'
                :disabled='!onlineActionReady'
                :title='!onlineActionReady ? onlineActionUnavailableReason : undefined'
                prepend-icon='mdi-history'
                @click='pageHistory'
              )
                v-list-item-title {{$t('common:header.history')}}
              v-list-item(
                role='button'
                link
                v-if='path && hasReadSourcePermission && mode !== `source`'
                :disabled='!onlineActionReady'
                :title='!onlineActionReady ? onlineActionUnavailableReason : undefined'
                prepend-icon='mdi-code-tags'
                @click='pageSource'
              )
                v-list-item-title {{$t('common:header.viewSource')}}
              v-list-item(
                role='button'
                link
                v-if='path && hasWritePagesPermission'
                :disabled='!onlineActionReady'
                :title='!onlineActionReady ? onlineActionUnavailableReason : undefined'
                prepend-icon='mdi-lightning-bolt'
                @click='pageConvert'
              )
                v-list-item-title {{$t('common:header.convert')}}
              v-list-item(
                link
                v-if='path && hasWritePagesPermission'
                :disabled='!onlineActionReady'
                :title='!onlineActionReady ? onlineActionUnavailableReason : undefined'
                prepend-icon='mdi-content-duplicate'
                @click='pageDuplicate'
              )
                v-list-item-title {{$t('common:header.duplicate')}}
              v-list-item(
                role='button'
                link
                v-if='path && hasManagePagesPermission'
                :disabled='!onlineActionReady'
                :title='!onlineActionReady ? onlineActionUnavailableReason : undefined'
                prepend-icon='mdi-content-save-move-outline'
                @click='pageMove'
              )
                v-list-item-title {{$t('common:header.move')}}
              v-list-item.nav-header-menu-danger(
                role='button'
                link
                v-if='path && hasDeletePagesPermission'
                :disabled='!onlineActionReady'
                :title='!onlineActionReady ? onlineActionUnavailableReason : undefined'
                prepend-icon='mdi-trash-can-outline'
                @click='pageDelete'
              )
                v-list-item-title {{$t('common:header.delete')}}
              v-divider(v-if='hasNewPagePermission || (isAuthenticated && isAdmin)')
              v-list-item(
                role='button'
                link
                v-if='hasNewPagePermission && path && mode !== `edit`'
                :disabled='!onlineActionReady'
                :title='!onlineActionReady ? onlineActionUnavailableReason : undefined'
                prepend-icon='mdi-text-box-plus-outline'
                @click='pageNew'
              )
                v-list-item-title {{$t('common:header.newPage')}}
              v-list-item(
                v-if='isAuthenticated && isAdmin && mode !== `admin`'
                :disabled='!onlineActionReady'
                :title='!onlineActionReady ? onlineActionUnavailableReason : undefined'
                prepend-icon='mdi-cog'
                @click='openAdmin'
              )
                v-list-item-title {{$t('common:header.admin')}}
              v-list-item(
                v-if='isAuthenticated && isAdmin && mode === `admin`'
                :disabled='!onlineActionReady'
                :title='!onlineActionReady ? onlineActionUnavailableReason : undefined'
                prepend-icon='mdi-exit-to-app'
                @click='exitAdmin'
              )
                v-list-item-title {{$t('common:actions.exit')}}
              template(v-if='mode === `view` && locales.length > 0')
                v-divider
                v-list-subheader {{$t('common:header.language')}}
                v-list-item(
                  role='button'
                  link
                  v-for='lc of locales'
                  :key='`mobile-locale-${lc.code}`'
                  :disabled='!readerActionReady'
                  :title='!readerActionReady ? onlineActionUnavailableReason : undefined'
                  :aria-current='lc.code === locale ? `true` : undefined'
                  prepend-icon='mdi-web'
                  @click='changeLocale(lc)'
                )
                  v-list-item-title {{lc.name}}

          //- ACCOUNT & APP

          v-menu.nav-header-app-status-menu(
            location="bottom end"
            transition='slide-y-transition'
            :close-on-content-click='false'
          )
            template(v-slot:activator='{ props: menuProps }')
              v-tooltip(location="bottom")
                template(v-slot:activator='{ props: tooltipProps }')
                  v-btn.nav-header-app-status-trigger(
                    icon
                    v-bind='mergeProps(menuProps, tooltipProps)'
                    rounded='lg'
                    :class='`nav-header-app-status-trigger--${connectionPresentation.tone}`'
                    :aria-label='connectionPresentation.label'
                    :title='connectionPresentation.label'
                  )
                    v-icon(:icon='connectionPresentation.icon', aria-hidden='true')
                span {{connectionPresentation.label}}
            .nav-header-app-status-content
              PwaStatus

          v-menu(location="bottom end", transition='slide-y-transition', :close-on-content-click='false', @update:model-value='accountMenuVisibilityChanged')
            template(v-slot:activator='{ props: menuProps }')
              v-tooltip(location="bottom")
                template(v-slot:activator='{ props: tooltipProps }')
                  v-btn.account-menu__trigger(
                    icon
                    v-bind='mergeProps(menuProps, tooltipProps)'
                    :class='$vuetify.locale.isRtl ? `ml-0` : ``'
                    rounded='lg'
                    :aria-label='accountButtonLabel'
                  )
                    template(v-if='isAuthenticated')
                      v-avatar(v-if='picture.kind === `initials`', :size='32', color='primary')
                        span.account-menu__initials {{ picture.initials }}
                      v-avatar(v-else-if='picture.kind === `image`', :size='32')
                        v-img(:src='picture.url', alt='')
                      v-icon(v-else) mdi-account-circle
                    v-icon(v-else) mdi-account-circle
                    span.account-menu__notification-indicator(
                      v-if='isAuthenticated && notificationState !== `clear`'
                      :class='`account-menu__notification-indicator--${notificationState}`'
                      aria-hidden='true'
                    )
                span {{accountButtonLabel}}
            v-list.nav-header-menu.account-menu(:aria-label='accountMenuLabel')
              template(v-if='isAuthenticated')
                v-list-item.py-3.bg-surface-variant(
                  href='/p'
                  :aria-label='`Open profile for ${name}`'
                )
                  template(v-slot:prepend)
                    v-avatar
                      v-avatar.bg-primary(v-if='picture.kind === `initials`', :size='40')
                        span.text-on-primary.text-body-large {{picture.initials}}
                      v-avatar(v-else-if='picture.kind === `image`', :size='40')
                        v-img(:src='picture.url', alt='')
                  v-list-item-title
                    span.account-menu__profile-label Profile
                    | {{name}}
                  v-list-item-subtitle {{email}}
                  template(v-slot:append): v-icon(color='secondary') mdi-face-profile
                v-divider
                AccountNotifications.account-menu__notifications(v-if='!siteNotifications.identityStale')
                v-divider
                section.account-menu__preferences(role='region' aria-label='Appearance settings')
                  appearance-selector
                v-divider
                form(action='/logout', method='post', :aria-busy='logoutPending ? `true` : undefined', @submit='clearAgentChatPinOnLogout')
                  v-list-item(tag='button', type='submit', link, :disabled='logoutPending')
                    template(v-slot:append): v-icon(color='error') mdi-logout
                    v-list-item-title.text-error {{ logoutPending ? `Signing out…` : $t('common:header.logout') }}
                v-divider
              template(v-else)
                v-list-item(
                  role='button'
                  link
                  href='/login'
                  data-no-wiki-navigation
                  aria-label='Sign in'
                )
                  template(v-slot:prepend): v-icon(color='primary') mdi-login
                  v-list-item-title Sign in
    page-selector(mode='create', v-model='newPageModal', :open-handler='pageNewCreate', :locale='locale')
    page-selector(mode='move', v-model='movePageModal', :open-handler='pageMoveRename', :path='path', :locale='locale')
    page-selector(mode='create', v-model='duplicateOpts.modal', :open-handler='pageDuplicateHandle', :path='duplicateOpts.path', :locale='duplicateOpts.locale')
    page-delete(v-model='deletePageModal', v-if='path && path.length')
    page-convert(v-model='convertPageModal', v-if='path && path.length')

    .nav-header-dev(v-if='isDevMode')
      v-icon mdi-alert
      div
        .text-label-small DEVELOPMENT VERSION
        .text-label-small This code base is NOT for production use!
</template>

<script lang='ts'>
import { defineAsyncComponent, defineComponent, markRaw, mergeProps } from 'vue'
import { invalidateOfflineIdentity, wikiStore } from '@/store/index.ts'
import { useSiteNotificationsStore } from '../../store/site-notifications.ts'
import AccountNotifications from './account-notifications.vue'
import ControlBorderBeam from './control-border-beam.vue'
import PwaStatus from '../pwa/pwa-status.vue'
import { fetchPageLocaleRelations, movePage } from '../../helpers/pages-api'
import { clearAgentChatPin } from '../../helpers/agent-chat-pin'
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
import { emitSearchEnter, emitSearchExit, emitSearchMove } from '../../helpers/search-navigation-events'
import * as pwa from '../../helpers/pwa.ts'

type PageLocation = { path: string, locale: string }
type SiteLocale = { code: string, name: string }
type UserPicture =
  | { kind: 'image', url: string }
  | { kind: 'initials', initials: string }

const ADMIN_PERMISSION_NAMES = new Set([
  'manage:system',
  'write:users',
  'manage:users',
  'write:groups',
  'manage:groups',
  'manage:navigation',
  'manage:theme',
  'manage:api'
])
export default defineComponent({
  components: {
    AccountNotifications,
    PwaStatus,
    ControlBorderBeam,
    AppearanceSelector: defineAsyncComponent(() => import('./appearance-selector.vue')),
    PageDelete: defineAsyncComponent(() => import('./page-delete.vue')),
    PageConvert: defineAsyncComponent(() => import('./page-convert.vue'))
  },
  setup() {
    const siteNotifications = useSiteNotificationsStore()
    return { siteNotifications }
  },
  props: {
    dense: {
      type: Boolean,
      default: false
    },
    hideSearch: {
      type: Boolean,
      default: false
    },
    mobileActions: {
      type: Boolean,
      default: false
    },
    reserveActions: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      searchIsShown: true,
      newPageModal: false,
      movePageModal: false,
      convertPageModal: false,
      deletePageModal: false,
      locales: markRaw(siteLangs),
      isDevMode: false,
      failedLogoUrl: null as string | null,
      pageActionsAreOpen: false,
      pageActionsFocusFrame: null as number | null,
      notificationIdentityRecovery: null as Promise<void> | null,
      notificationIdentityRecoveryGeneration: 0,
      headerActionGeneration: 1,
      logoutPending: false,
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
    connectionPresentation(): pwa.PwaConnectionPresentation {
      return pwa.pwaConnectionPresentation(pwa.pwaState)
    },
    title(): string { return wikiStore.site.title },
    logoUrl(): string { return wikiStore.site.logoUrl },
    logoImageFailed (): boolean { return this.failedLogoUrl === this.logoUrl },
    logoFallback (): string {
      const title = this.title.trim()
      return title ? title.charAt(0).toUpperCase() : '?'
    },
    homePath(): string { return this.locales.length > 0 ? `/${this.locale}/home` : '/' },
    path(): string { return wikiStore.page.path },
    mode(): string { return wikiStore.page.mode },
    locale(): string { return wikiStore.page.locale },
    name(): string { return wikiStore.user.name },
    email(): string { return wikiStore.user.email },
    pictureUrl(): string { return wikiStore.user.pictureUrl },
    transportVerified(): boolean {
      return pwa.pwaState?.connectionState === 'online' &&
        pwa.pwaState?.serverReachable === true &&
        pwa.pwaState?.serverHealthy === true
    },
    navigationUnavailableReason(): string {
      return this.transportVerified ? '' : 'This navigation requires a verified server connection.'
    },
    authorizationFresh(): boolean {
      return this.isAuthenticated &&
        wikiStore.authRefreshPending === false &&
        wikiStore.authRefreshSettled === true &&
        wikiStore.authRefreshOutcome === 'authenticated' &&
        wikiStore.offlineIdentityReady === true
    },
    pageResourceReady(): boolean {
      return Number.isSafeInteger(wikiStore.page.id) &&
        wikiStore.page.id > 0 &&
        typeof this.path === 'string' &&
        this.path.length > 0
    },
    readerActionReady(): boolean {
      return this.transportVerified &&
        this.pageResourceReady &&
        (wikiStore.page.visibility !== 'private' || this.authorizationFresh)
    },
    onlineActionReady(): boolean {
      return this.transportVerified && this.authorizationFresh
    },
    onlineActionUnavailableReason(): string {
      if (!this.transportVerified) return 'This action requires a verified server connection.'
      if (!this.authorizationFresh) return 'This action requires a freshly verified signed-in session.'
      return ''
    },
    isAuthenticated(): boolean { return wikiStore.user.authenticated },
    notificationOwnerId(): number { return this.isAuthenticated ? wikiStore.user.id : 0 },
    notificationState(): 'available' | 'unknown' | 'clear' { return this.siteNotifications.notificationState },
    hasNotifications(): boolean { return this.notificationState === 'available' },
    accountButtonLabel(): string {
      const account = this.$t('common:header.account')
      if (!this.isAuthenticated) return account
      if (this.notificationState === 'available') {
        return this.$t('common:header.accountNotificationsAvailable', { account })
      }
      if (this.notificationState === 'unknown') {
        return this.$t('common:header.accountNotificationsUnknown', { account })
      }
      return account
    },
    accountMenuLabel(): string {
      return 'Account menu'
    },
    permissions(): string[] { return wikiStore.user.permissions },
    searchInputLabel(): string { return this.searchMode === 'ask' ? this.$t('common:header.askPlaceholder') : this.$t('common:header.search') },
    canEnterAgent(): boolean {
      return Boolean(
        siteConfig.agentsEnabled &&
        this.onlineActionReady &&
        this.permissions.some(permission => permission === 'use:agents' || permission === 'manage:system') &&
        !this.hideSearch &&
        !this.dense &&
        this.mode !== 'edit'
      )
    },
    searchShortcutLabel(): string { return /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K' },
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
    isAdmin (): boolean {
      return this.permissions.some(permission => ADMIN_PERMISSION_NAMES.has(permission))
    },
    hasNewPagePermission (): boolean {
      return this.hasAdminPermission || this.permissions.includes('write:pages')
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
  watch: {
    searchIsFocused(open: boolean): void {
      if (!open && this.$vuetify.display.smAndDown) this.searchIsShown = false
    },
    '$vuetify.display.smAndDown'(small: boolean): void {
      if (small) {
        if (!this.searchIsFocused) this.searchIsShown = false
      } else {
        const showSearch = !this.hideSearch && !this.dense
        if (!showSearch && this.searchIsFocused) this.searchClose()
        this.searchIsShown = showSearch
      }
    },
    hideSearch(hidden: boolean): void {
      if (hidden) {
        this.searchClose()
        this.searchIsShown = false
      } else if (!this.dense && this.$vuetify.display.mdAndUp) {
        this.searchIsShown = true
      }
    },
    dense(dense: boolean): void {
      if (this.$vuetify.display.mdAndUp) {
        if (dense && this.searchIsFocused) this.searchClose()
        this.searchIsShown = !dense && !this.hideSearch
      }
    },
    notificationOwnerId(ownerId: number, previousOwnerId: number | undefined): void {
      if (ownerId === previousOwnerId) return
      if (this.siteNotifications.identityStale || this.notificationIdentityRecovery) return
      this.siteNotifications.reset()
      if (ownerId > 0) void this.siteNotifications.initialize(ownerId)
    },
    'siteNotifications.identityStale'(stale: boolean): void {
      if (stale) void this.recoverSiteNotificationsIdentity()
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
    document.addEventListener('visibilitychange', this.handleNotificationVisibility)
    window.addEventListener('focus', this.handleNotificationFocus)
    this.syncSiteNotifications()
  },
  beforeUnmount () {
    this.notificationIdentityRecoveryGeneration += 1
    this.headerActionGeneration += 1
    offPageEdit(this.pageEdit)
    offPageHistory(this.pageHistory)
    offPageSource(this.pageSource)
    offPageMove(this.pageMove)
    offPageConvert(this.pageConvert)
    offPageDuplicate(this.pageDuplicate)
    offPageDelete(this.pageDelete)
    window.removeEventListener('keydown', this.handleSearchShortcut)
    document.removeEventListener('visibilitychange', this.handleNotificationVisibility)
    window.removeEventListener('focus', this.handleNotificationFocus)
    this.pageActionsAreOpen = false
    if (this.pageActionsFocusFrame !== null) {
      window.cancelAnimationFrame(this.pageActionsFocusFrame)
      this.pageActionsFocusFrame = null
    }
  },
  methods: {
    mergeProps,
    handleLogoError (event: Event): void {
      const image = event.currentTarget
      if (!(image instanceof HTMLImageElement)) return
      const source = image.getAttribute('data-logo-source')
      if (!source || source !== this.logoUrl) return
      this.failedLogoUrl = source
    },
    handleLogoLoad (event: Event): void {
      const image = event.currentTarget
      if (!(image instanceof HTMLImageElement)) return
      const source = image.getAttribute('data-logo-source')
      if (!source || source !== this.logoUrl) return
      if (this.failedLogoUrl === source) this.failedLogoUrl = null
    },
    clearAgentChatPinOnLogout (event: SubmitEvent): void {
      event.preventDefault()
      if (this.logoutPending) return
      this.logoutPending = true

      const currentTarget = event.currentTarget
      const form = currentTarget && typeof (currentTarget as HTMLFormElement).submit === 'function'
        ? currentTarget as HTMLFormElement
        : null
      const accountId = this.isAuthenticated && Number.isSafeInteger(wikiStore.user.id) && wikiStore.user.id > 0
        ? wikiStore.user.id
        : undefined

      this.notificationIdentityRecoveryGeneration += 1
      clearAgentChatPin()
      this.siteNotifications.reset()

      void (async () => {
        await invalidateOfflineIdentity(accountId)
        if (form) form.submit()
      })()
    },
    clearNotificationData (): void {
      this.siteNotifications.watches = []
      this.siteNotifications.approvals = []
      this.siteNotifications.watchesLoading = false
      this.siteNotifications.approvalsLoading = false
      this.siteNotifications.watchesError = ''
      this.siteNotifications.approvalsError = ''
      this.siteNotifications.approvalsNextCursor = null
    },
    syncSiteNotifications(refresh = false): void {
      if (this.siteNotifications.identityStale) {
        void this.recoverSiteNotificationsIdentity()
        return
      }
      if (this.notificationIdentityRecovery) return
      const ownerId = this.notificationOwnerId
      if (ownerId <= 0) {
        this.siteNotifications.reset()
        return
      }
      if (refresh) void this.siteNotifications.refresh()
      else void this.siteNotifications.initialize(ownerId)
    },
    recoverSiteNotificationsIdentity(): Promise<void> {
      const pending = this.notificationIdentityRecovery
      if (pending) return pending
      if (!this.siteNotifications.identityStale) return Promise.resolve()
      const recoveryGeneration = this.notificationIdentityRecoveryGeneration

      const recovery = (async () => {
        try {
          const outcome = await wikiStore.refreshAuth()
          if (
            recoveryGeneration !== this.notificationIdentityRecoveryGeneration ||
            !this.siteNotifications.identityStale
          ) return
          if (outcome === 'authenticated') {
            const ownerId = this.notificationOwnerId
            if (ownerId <= 0 || !this.isAuthenticated) {
              this.clearNotificationData()
              this.siteNotifications.identityStale = true
              return
            }
            this.siteNotifications.reset()
            await this.siteNotifications.initialize(ownerId)
            return
          }
          if (outcome === 'anonymous') {
            this.siteNotifications.reset()
            return
          }
          this.clearNotificationData()
          this.siteNotifications.identityStale = true
        } catch {
          if (
            recoveryGeneration !== this.notificationIdentityRecoveryGeneration ||
            !this.siteNotifications.identityStale
          ) return
          this.clearNotificationData()
          this.siteNotifications.identityStale = true
        }
      })()
      const serialized = recovery.finally(() => {
        this.notificationIdentityRecovery = null
      })
      this.notificationIdentityRecovery = markRaw(serialized)
      return serialized
    },
    refreshSiteNotifications(): void {
      this.syncSiteNotifications(true)
    },
    handleNotificationFocus(): void {
      this.refreshSiteNotifications()
    },
    handleNotificationVisibility(): void {
      if (document.visibilityState === 'visible') this.refreshSiteNotifications()
    },
    accountMenuVisibilityChanged(open: boolean): void {
      if (open) this.refreshSiteNotifications()
    },
    async pageActionsVisibilityChanged(open: boolean): Promise<void> {
      this.pageActionsAreOpen = open
      if (this.pageActionsFocusFrame !== null) {
        window.cancelAnimationFrame(this.pageActionsFocusFrame)
        this.pageActionsFocusFrame = null
      }
      if (!open) return
      await this.$nextTick()
      if (!this.pageActionsAreOpen) return
      this.pageActionsFocusFrame = window.requestAnimationFrame(() => {
        this.pageActionsFocusFrame = null
        if (!this.pageActionsAreOpen) return
        const menu = this.$refs.pageActionsMenu
        const root = menu instanceof HTMLElement
          ? menu
          : (menu as { $el?: unknown } | undefined)?.$el
        if (root instanceof HTMLElement) {
          root.querySelector<HTMLElement>('[role="button"]')?.focus()
        }
      })
    },
    guardHeaderNavigation (event: Event): void {
      if (!this.transportVerified) event.preventDefault()
    },
    searchFocus () {
      this.searchIsFocused = true
    },
    async searchTab (event: KeyboardEvent): Promise<void> {
      event.preventDefault()
      emitSearchExit(false)
      this.searchClose()
      await this.$nextTick()
      const desktop = this.$vuetify.display.mdAndUp
      const previousTarget = document.querySelector<HTMLElement>(
        desktop ? '.nav-header-browse' : '.nav-header-agent'
      ) ?? document.querySelector<HTMLElement>('.nav-header-logo')
      const forwardTarget = document.querySelector<HTMLElement>(
        desktop
          ? '.nav-header-actions button:not(:disabled), .nav-header-actions a[href]'
          : '.nav-header-browse'
      ) ?? document.querySelector<HTMLElement>('.nav-header-actions button:not(:disabled), .nav-header-actions a[href]')
      const target = event.shiftKey ? previousTarget : forwardTarget
      target?.focus({ preventScroll: true })
    },
    searchClose () {
      this.searchIsFocused = false
      this.searchMode = 'search'
      this.search = ''
    },
    async focusSearchField(): Promise<void> {
      if (this.hideSearch) return
      this.searchIsShown = true
      this.searchIsFocused = true
      await this.$nextTick()
      const field = this.$vuetify.display.smAndDown ? this.$refs.searchFieldMobile : this.$refs.searchField
      ;(field as { focus?: () => void } | undefined)?.focus?.()
    },
    async searchEscape(): Promise<void> {
      this.searchClose()
      if (!this.$vuetify.display.smAndDown) return
      await this.$nextTick()
      const toggle = this.$refs.searchToggle
      const element = toggle instanceof HTMLElement
        ? toggle
        : (toggle as { $el?: unknown } | undefined)?.$el
      if (element instanceof HTMLElement) element.focus()
    },
    searchToggle () {
      this.searchIsShown = !this.searchIsShown
      if (this.searchIsShown) void this.focusSearchField()
      else this.searchClose()
    },
    openAgent(): void {
      if (!this.canEnterAgent || !this.onlineActionReady) return
      this.searchMode = 'ask'
      void this.focusSearchField()
    },
    handleSearchShortcut(event: KeyboardEvent): void {
      if (this.hideSearch || event.defaultPrevented || event.repeat || event.isComposing) return
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        this.searchMode = 'search'
        void this.focusSearchField()
        return
      }
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'a') return
      if (!this.canEnterAgent) return
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
      if (event.isComposing) return
      if ((event.ctrlKey || event.metaKey) && this.canEnterAgent) {
        event.preventDefault()
        this.searchMode = 'ask'
      }
      emitSearchEnter()
    },
    searchMove(dir: string): void {
      emitSearchMove(dir)
    },
    pageNew () {
      if (!this.onlineActionReady) return
      this.newPageModal = true
    },
    pageNewCreate ({ path, locale }: PageLocation): void {
      if (!this.onlineActionReady) return
      window.location.assign(`/e/${locale}/${path}`)
    },
    pageView () {
      if (!this.readerActionReady) return
      const scope = wikiStore.page.visibility === 'private' ? '/_private' : ''
      window.location.assign(`${scope}/${this.locale}/${this.path}`)
    },
    pageEdit () {
      if (!this.onlineActionReady || !this.pageResourceReady) return
      const scope = wikiStore.page.visibility === 'private' ? '/_private' : ''
      window.location.assign(`/e${scope}/${this.locale}/${this.path}`)
    },
    pageHistory () {
      if (!this.onlineActionReady || !this.pageResourceReady) return
      const scope = wikiStore.page.visibility === 'private' ? '/_private' : ''
      window.location.assign(`/h${scope}/${this.locale}/${this.path}`)
    },
    pageSource () {
      if (!this.onlineActionReady || !this.pageResourceReady) return
      const scope = wikiStore.page.visibility === 'private' ? '/_private' : ''
      window.location.assign(`/s${scope}/${this.locale}/${this.path}`)
    },
    pageDuplicate () {
      if (!this.onlineActionReady || !this.pageResourceReady) return
      const pathParts = this.path.split('/')
      this.duplicateOpts = {
        locale: this.locale,
        path: (pathParts.length > 1) ? pathParts.slice(0, -1).join('/') + `/new-page` : `new-page`,
        modal: true
      }
    },
    pageDuplicateHandle ({ locale, path }: PageLocation): void {
      if (!this.onlineActionReady || !this.pageResourceReady) return
      window.location.assign(`/e/${locale}/${path}?from=${wikiStore.page.id}`)
    },
    pageConvert () {
      if (!this.onlineActionReady || !this.pageResourceReady) return
      this.convertPageModal = true
    },
    pageMove () {
      if (!this.onlineActionReady || !this.pageResourceReady) return
      this.movePageModal = true
    },
    async pageMoveRename ({ path, locale }: PageLocation): Promise<void> {
      if (!this.onlineActionReady || !this.pageResourceReady) return
      const generation = this.headerActionGeneration
      wikiStore.startLoading('page-move')
      try {
        await movePage(
          window.fetch.bind(window),
          wikiStore.page.id,
          locale,
          path,
          wikiStore.page.sourceRevision
        )
        if (generation !== this.headerActionGeneration || !this.onlineActionReady) {
          wikiStore.stopLoading('page-move')
          return
        }
        const scope = wikiStore.page.visibility === 'private' ? '/_private' : ''
        window.location.replace(`${scope}/${locale}/${path}`)
      } catch (err) {
        if (generation !== this.headerActionGeneration) return
        wikiStore.showError(err)
        wikiStore.stopLoading('page-move')
      }
    },
    pageDelete () {
      if (!this.onlineActionReady || !this.pageResourceReady) return
      this.deletePageModal = true
    },
    async changeLocale (locale: SiteLocale): Promise<void> {
      if (!this.readerActionReady) return
      const generation = this.headerActionGeneration
      let destinationPath = this.path
      let destinationVisibility = wikiStore.page.visibility
      try {
        const translations = await fetchPageLocaleRelations(window.fetch.bind(window), wikiStore.page.id)
        if (generation !== this.headerActionGeneration || !this.readerActionReady) return
        const translation = translations.find(candidate => candidate.locale === locale.code)
        if (translation) {
          destinationPath = translation.path
          destinationVisibility = translation.visibility
        }
      } catch (err) {
        if (generation !== this.headerActionGeneration) return
        console.warn(err)
      }
      if (generation !== this.headerActionGeneration || !this.readerActionReady) return
      const scope = destinationVisibility === 'private' ? '/_private' : ''
      window.location.assign(`${scope}/${locale.code}/${destinationPath}`)
    },
    openAdmin (): void {
      if (!this.onlineActionReady || !this.isAdmin) return
      window.location.assign('/a')
    },
    exitAdmin (): void {
      if (!this.onlineActionReady) return
      window.location.assign('/')
    }
  }
})
</script>

<style lang='scss'>
.nav-header-search-key {
  flex: 0 0 auto;
  padding: .125rem .375rem;
  border: 1px solid var(--wiki-surface-border);
  border-radius: .375rem;
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: .6875rem;
  white-space: nowrap;
}
.nav-header-agent {
  position: relative;
  isolation: isolate;
  flex: 0 0 auto;
  margin-inline: 0;
}
.nav-header-agent .v-btn__prepend,
.nav-header-agent .v-btn__append {
  position: relative;
  z-index: 1;
}

.nav-header-agent .v-btn__content {
  position: static;
  border-radius: inherit;
}

.nav-header {
  --nav-header-tint: linear-gradient(90deg, color-mix(in srgb, var(--wiki-accent-warm) 8%, transparent), transparent 42%, color-mix(in srgb, var(--wiki-accent-spectral) 6%, transparent));
  --nav-header-surface: var(--wiki-chrome-surface);
  isolation: isolate;
  border-bottom: 1px solid var(--wiki-surface-border) !important;
  background-color: var(--nav-header-surface) !important;
  background-image: var(--nav-header-tint) !important;
  color: rgb(var(--v-theme-on-surface));
  box-shadow: 0 3px 10px color-mix(in srgb, var(--wiki-shadow-color) 35%, transparent) !important;
  backdrop-filter: var(--wiki-chrome-blur) !important;
  -webkit-backdrop-filter: var(--wiki-chrome-blur) !important;

  @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    border-bottom-color: var(--wiki-glass-border) !important;
  }

  > .v-toolbar__content {
    overflow: hidden;
    background: transparent !important;
  }

  .v-toolbar__extension {
    overflow: hidden;
    padding-inline: var(--wiki-space-4);
    background-color: var(--nav-header-surface) !important;
    background-image: var(--nav-header-tint) !important;
    backdrop-filter: var(--wiki-chrome-blur) !important;
    -webkit-backdrop-filter: var(--wiki-chrome-blur) !important;

    .v-toolbar__content {
      height: auto !important;
      min-height: var(--wiki-control-height);
      padding: 0;
      background: transparent !important;
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
    min-width: 0;
    gap: var(--wiki-space-3);
    padding-inline: var(--wiki-space-4) var(--wiki-space-3);
  }

  .nav-header-logo {
    position: relative;
    display: inline-flex;
    flex: 0 1 auto;
    width: max-content;
    min-width: 44px;
    max-width: 112px;
    height: 44px;
    min-height: 44px;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    padding: 2px 4px;
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
    text-decoration: none;
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
    width: auto;
    max-width: 100%;
    height: 40px;
    max-height: 40px;
    object-fit: contain;
    object-position: center;
  }

  .nav-header-logo-fallback {
    display: grid;
    width: 36px;
    height: 36px;
    place-items: center;
    color: rgb(var(--v-theme-on-surface));
    font-size: 1rem;
    font-weight: 720;
    line-height: 1;
  }

  .nav-header-title {
    min-width: 0;
    flex: 1 1 auto;
    margin: 0;
    overflow: hidden;
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
    justify-content: stretch;
    gap: var(--wiki-space-1);
  }

  .nav-header-search-control {
    min-width: 0;
    max-width: 34rem;

    .v-field {
      min-height: var(--wiki-control-height);
      overflow: hidden;
      border: 1px solid var(--wiki-glass-border, var(--wiki-surface-border-strong));
      border-radius: var(--wiki-control-radius);
      background-color: rgba(var(--v-theme-surface), .42) !important;
      background-image: none !important;
      color: rgb(var(--v-theme-on-surface)) !important;
      backdrop-filter: blur(12px) saturate(150%) !important;
      -webkit-backdrop-filter: blur(12px) saturate(150%) !important;
      box-shadow: var(--wiki-shadow-inset);
      transition:
        border-color var(--wiki-motion-normal) var(--wiki-motion-ease),
        background-color var(--wiki-motion-normal) var(--wiki-motion-ease),
        box-shadow var(--wiki-motion-normal) var(--wiki-motion-ease);
    }

    .v-field__overlay {
      background: transparent !important;
      opacity: 1 !important;
    }

    .v-field__input {
      min-height: var(--wiki-control-height);
      padding-block: 0;
      font-size: .875rem;
      font-weight: 560;
      letter-spacing: .005em;
      opacity: 1 !important;
    }

    .v-field__input input {
      opacity: 1 !important;
    }

    .v-field__prepend-inner {
      color: var(--wiki-ambient-accent);
      opacity: 1;
    }

    .v-field__prepend-inner > .v-icon,
    .v-field__append-inner > .v-icon,
    .v-field__clearable > .v-icon {
      opacity: 1 !important;
    }

    .v-label {
      color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, rgb(var(--v-theme-surface)) 38%);
      font-size: .8125rem;
      opacity: 1;
    }

    .v-field--focused {
      border-color: color-mix(in srgb, var(--wiki-ambient-accent) 62%, transparent);
      background-color: rgba(var(--v-theme-surface), .54) !important;
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
    background-color: var(--nav-header-surface) !important;
    background-image: var(--nav-header-tint) !important;
    backdrop-filter: var(--wiki-chrome-blur) !important;
    -webkit-backdrop-filter: var(--wiki-chrome-blur) !important;

    .nav-header-search-control {
      max-width: none;
    }
  }

  .nav-header-mobile-browse {
    display: none;
  }



  @media (max-width: 959.98px) {
    .nav-header-mobile-browse {
      display: block;
      flex: 0 0 auto;
    }
  }

  .nav-header-actions {
    gap: var(--wiki-space-2, 8px);
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
    border: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 12%, transparent);
    border-radius: var(--wiki-control-radius) !important;
    background: color-mix(in srgb, rgb(var(--v-theme-surface)) 72%, transparent);
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 80%, rgb(var(--v-theme-surface)) 20%);
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
      transform: none;
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
  .nav-header-inner .nav-header-agent,
  .nav-header-inner .nav-header-edit-btn {
    border-color: color-mix(in srgb, var(--wiki-ambient-accent) 32%, transparent);
    background: color-mix(in srgb, var(--wiki-accent-warm) 12%, transparent) !important;
    color: var(--wiki-accent-ink) !important;
  }
  .nav-header-command .nav-header-browse:hover {
    transform: none;
  }

  .nav-header-browse {
    flex: 0 0 auto;
    margin-inline-start: 0;
  }
  .nav-header-inner .nav-header-browse {
    width: var(--wiki-control-height);
    min-width: var(--wiki-control-height);
  }
  @media (min-width: 960px) {
    .nav-header-inner .nav-header-agent,
    .nav-header-inner .nav-header-browse,
    .nav-header-inner .nav-header-edit-btn {
      min-height: 36px;
      height: 36px !important;
      border-radius: var(--wiki-radius-pill) !important;
    }

    .nav-header-inner .nav-header-agent,
    .nav-header-inner .nav-header-edit-btn {
      padding-inline: var(--wiki-space-3);
    }

    .nav-header-inner .nav-header-browse {
      width: 36px;
      min-width: 36px;
    }
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

.nav-header-menu.account-menu {
  width: min(calc(100vw - (var(--wiki-space-4) * 2)), 22rem);
  max-height: min(82dvh, 44rem);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.account-menu__trigger {
  position: relative;
}
.nav-header-app-status-content {
  width: min(24rem, calc(100vw - (var(--wiki-space-4) * 2)));
  max-width: calc(100vw - (var(--wiki-space-4) * 2));
}

.nav-header .nav-header-inner .nav-header-app-status-trigger {
  flex: 0 0 auto;
  min-width: max(44px, var(--wiki-control-height, 44px)) !important;
  min-height: max(44px, var(--wiki-control-height, 44px)) !important;
  height: max(44px, var(--wiki-control-height, 44px)) !important;
}

.nav-header-app-status-trigger--success {
  color: rgb(var(--v-theme-success)) !important;
}

.nav-header-app-status-trigger--warning {
  color: rgb(var(--v-theme-warning)) !important;
}

.nav-header-app-status-trigger--error {
  color: rgb(var(--v-theme-error)) !important;
}


.account-menu__initials {
  font-size: .8125rem;
  font-weight: 700;
  color: rgb(var(--v-theme-on-primary));
  line-height: 1;
}

.nav-header .nav-header-inner .nav-header-edit-btn {
  flex: 0 0 auto;
  min-height: 36px;
  height: 36px !important;
  padding-inline: var(--wiki-space-3);
  font-weight: 600;
  border-radius: var(--wiki-radius-pill) !important;
}

.account-menu__notification-indicator {
  position: absolute;
  top: .3rem;
  inset-inline-end: .3rem;
  width: .5rem;
  height: .5rem;
  border: 2px solid rgb(var(--v-theme-surface));
  border-radius: 50%;
}

.account-menu__notification-indicator--available {
  background: rgb(var(--v-theme-primary));
  box-shadow: 0 0 0 1px color-mix(in srgb, rgb(var(--v-theme-primary)) 24%, transparent);
}

.account-menu__notification-indicator--unknown {
  width: .6rem;
  height: .6rem;
  border: 1.5px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  background: transparent;
  box-shadow: 0 0 0 1px color-mix(in srgb, rgb(var(--v-theme-on-surface)) 12%, transparent);
}

.account-menu__profile-label {
  display: block;
  margin-block-end: .1rem;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 60%, transparent);
  font-size: .6875rem;
  font-weight: 700;
  letter-spacing: .07em;
  line-height: 1.2;
  text-transform: uppercase;
}

.account-menu__notifications {
  min-height: 0;
  scrollbar-gutter: stable;
}

.account-menu__preferences {
  display: grid;
  width: 100%;
  min-width: 0;
  gap: var(--wiki-space-3);
  margin-inline: 0;
  padding: var(--wiki-space-2) var(--wiki-space-3);
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
    min-width: 44px;
    max-width: 100px;
    width: max-content;
    height: 40px;
    min-height: 40px;
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

.v-theme--dark .nav-header {
  border-bottom-color: var(--wiki-surface-border-strong) !important;
}

@media (min-width: 960px) {
  .nav-header {
    .nav-header-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr) minmax(0, 1fr);
    }

    &.nav-header--dense.nav-header--reserved-actions {
      .nav-header-layout {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) max-content;
      }

      .nav-header-actions-col {
        min-width: max-content;
      }
    }
    .nav-header-brand-col,
    .nav-header-search-col,
    .nav-header-actions-col {
      width: auto;
      max-width: none;
    }

    .nav-header-actions {
      justify-content: flex-end;
      min-width: max-content;
    }

    .nav-header-command {
      display: grid;
      grid-template-columns: 36px minmax(0, 1fr);
      gap: var(--wiki-space-1);
    }

    .nav-header-command > .nav-header-browse {
      grid-column: 1;
      justify-self: start;
      margin: 0;
    }

    .nav-header-command > .nav-header-search-control {
      grid-column: 2;
      justify-self: stretch;
      width: 100%;
    }


    .nav-header-slot-actions {
      flex: 0 0 auto;
    }
  }
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
    .nav-header-agent-label,
    .nav-header-edit-label {
      display: none;
    }

    .nav-header-actions .nav-header-agent,
    .nav-header-actions .nav-header-edit-btn {
      width: calc(var(--wiki-control-height) - var(--wiki-space-2));
      min-width: calc(var(--wiki-control-height) - var(--wiki-space-2));
      padding-inline: 0;
    }

    .nav-header-actions .nav-header-agent .v-btn__prepend,
    .nav-header-actions .nav-header-edit-btn .v-btn__prepend {
      margin-inline: 0;
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
    .nav-header-layout { flex-wrap: nowrap; }
    .nav-header-brand-col { flex: 1 1 0; width: auto; max-width: none; }
    .nav-header-actions-col { flex: 0 0 auto; width: auto; max-width: none; }
    .nav-header-agent { margin-inline: 0; }

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
      min-width: 44px;
      max-width: 72px;
      width: max-content;
      height: 40px;
      min-height: 40px;
      padding: 2px 3px;
    }


    .nav-header-inner .v-btn {
      min-width: calc(var(--wiki-control-height) - var(--wiki-space-1));
      height: calc(var(--wiki-control-height) - var(--wiki-space-1)) !important;
    }
    .nav-header-inner .nav-header-browse {
      width: calc(var(--wiki-control-height) - var(--wiki-space-1));
      min-width: calc(var(--wiki-control-height) - var(--wiki-space-1));
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
@media (pointer: coarse) {
  .nav-header .nav-header-inner .nav-header-browse {
    min-width: 2.75rem;
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
