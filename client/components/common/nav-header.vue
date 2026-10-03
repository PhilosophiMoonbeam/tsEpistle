<template lang='pug'>
  v-app-bar.nav-header(:height='dense ? 48 : 52', flat, :class='{ "nav-header--dense": dense, "nav-header--reserved-actions": reserveActions }', :extended='searchIsShown && $vuetify.display.smAndDown', :style='{ "--v-toolbar-height": dense ? "48px" : "52px", "backdrop-filter": "var(--wiki-chrome-blur)" }')
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
          aria-keyshortcuts='Control+k Meta+k Alt+Enter'
        )
    v-row.nav-header-layout(:gap='0')
      v-col.nav-header-brand-col(cols='5', md='4')
        .nav-header-inner.nav-header-brand
          slot(name='navigationToggle', v-if='$vuetify.display.smAndDown')
          slot(name='mobileBrand', v-if='$slots.mobileBrand && $vuetify.display.smAndDown')
          a.nav-header-logo(
            v-if='!$slots.mobileBrand || $vuetify.display.mdAndUp'
            :href='homePath'
            :aria-label='$t(`common:header.home`)'
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
            span.nav-header-title-single {{title}}
            span.nav-header-title-stacked(ref='navHeaderTitleStacked', :style='navHeaderTitleStackedStyle')
              span.nav-header-title-line(v-for='(titleLine, titleLineIndex) in titleLines', :key='titleLineIndex') {{ titleLine }}
      v-col.nav-header-search-col(md='4', v-if='$vuetify.display.mdAndUp')
        .nav-header-inner.nav-header-command
          v-tooltip(location="bottom", v-if='!hideSearch')
            template(v-slot:activator='{ props }')
              v-btn.nav-header-browse(
                v-bind='props'
                icon
                href='/t'
                :aria-disabled='!transportVerified ? `true` : undefined'
                data-search-modal-action
                variant='outlined'
                :aria-current='mode === `tags` ? `page` : undefined'
                :aria-label='$t(`common:header.browseTags`)'
                @click='guardHeaderNavigation'
              )
                v-icon(size='18') mdi-tag-outline
            span {{ transportVerified ? $t('common:header.browseTags') : navigationUnavailableReason }}

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
                aria-keyshortcuts='Control+k Meta+k Alt+Enter'
              )
                template(v-slot:append-inner)
                  kbd.nav-header-search-key(v-if='!search && !searchIsFocused', aria-hidden='true') {{ searchShortcutLabel }}



      v-col.nav-header-actions-col(cols='7', md='4')
        .nav-header-inner.nav-header-actions
          v-spacer
          .navHeaderLoading(v-show='isLoading')
            v-progress-circular(indeterminate, color='primary', :size='22', :width='2', :aria-label='$t(`common:header.pageLoading`, { defaultValue: `Page loading` })')
          v-tooltip(location='bottom')
            template(v-slot:activator='{ props }')
              v-btn.nav-header-agent(
                v-bind='props'
                v-if='canEnterAgent && $vuetify.display.mdAndUp'
                icon
                rounded='lg'
                :aria-label='$t(`common:header.agentOpen`, { defaultValue: `Open Wiki Agent` })'
                data-search-modal-action
                @click='openAgent'
              )
                v-icon(icon='mdi-creation-outline')
                ControlBorderBeam(:enabled='canEnterAgent' :phase-offset-ms='0')
            span {{ $t('common:header.agent', { defaultValue: 'Wiki Agent' }) }}
          template(v-if='hasWritePagesPermission && path && mode !== `edit` && $vuetify.display.mdAndUp')
            v-tooltip(location='bottom')
              template(v-slot:activator='{ props }')
                v-btn.nav-header-edit-btn(
                  v-bind='props'
                  icon
                  rounded='lg'
                  :aria-disabled='!onlineActionReady ? `true` : undefined'
                  @click='pageEdit'
                  :aria-label='$t(`common:header.edit`)'
                )
                  v-icon(icon='mdi-pencil')
              span {{ onlineActionReady ? $t('common:accountMenu.editPage', { defaultValue: 'Edit page' }) : onlineActionUnavailableReason }}
          v-tooltip(location='bottom')
            template(v-slot:activator='{ props }')
              v-btn.nav-header-agent(
                v-bind='props'
                v-if='canEnterAgent && $vuetify.display.smAndDown && !$vuetify.display.xs'
                icon
                rounded='lg'
                :aria-label='$t(`common:header.agentOpen`, { defaultValue: `Open Wiki Agent` })'
                data-search-modal-action
                @click='openAgent'
              )
                v-icon(icon='mdi-creation-outline')
                ControlBorderBeam(:enabled='canEnterAgent' :phase-offset-ms='0')
            span {{ $t('common:header.agent', { defaultValue: 'Wiki Agent' }) }}

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
            :aria-label='searchIsShown ? $t(`common:header.searchCloseLabel`, { defaultValue: `Close search` }) : $t(`common:header.searchOpen`, { defaultValue: `Open search` })'
          )
            v-icon {{ searchIsShown ? 'mdi-close' : 'mdi-magnify' }}
          v-tooltip.nav-header-mobile-browse(v-if='!hideSearch && $vuetify.display.smAndDown && !$vuetify.display.xs', location='bottom')
            template(v-slot:activator='{ props }')
              v-btn.nav-header-browse(
                v-bind='props'
                icon
                href='/t'
                :aria-disabled='!transportVerified ? `true` : undefined'
                data-search-modal-action
                :aria-current='mode === `tags` ? `page` : undefined'
                :aria-label='$t(`common:header.browseTags`)'
                @click='guardHeaderNavigation'
              )
                v-icon mdi-tag-outline
            span {{ transportVerified ? $t('common:header.browseTags') : navigationUnavailableReason }}
          .nav-header-slot-actions(v-if='($vuetify.display.mdAndUp || mobileActions) && $slots.actions')
            slot(name='actions')
          //- Divider between the authoring cluster (Agent / Edit) and the
            {{ $t(`common:navHeader.globalPageAccountControls`) }}
          v-divider(
            v-if='$vuetify.display.mdAndUp && (canEnterAgent || (hasWritePagesPermission && path && mode !== `edit`))'
            vertical
            aria-hidden='true'
          )
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
                p.nav-header-menu__note(v-if='!readerActionReady && onlineActionUnavailableReason') {{ onlineActionUnavailableReason }}
                template(v-for='lc of locales', :key='lc.code')
                  v-list-item(
                    role='button'
                    link
                    :disabled='!readerActionReady'
                    :aria-current='lc.code === locale ? `true` : undefined'
                    @click='changeLocale(lc)'
                  )
                    template(v-slot:append): v-chip(:color='lc.code === locale ? `primary` : undefined', size="small", label) {{lc.code.toUpperCase()}}
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
                .text-label-small.pa-4 {{$t('common:header.currentPage')}}
                p.nav-header-menu__note(v-if='!onlineActionReady && onlineActionUnavailableReason') {{ onlineActionUnavailableReason }}
                v-list-item.pl-4(
                  v-for='action of desktopPageMenuActions'
                  :key='action.handler'
                  role='button'
                  link
                  :disabled='action.handler === `pageView` ? !readerActionReady : !onlineActionReady'
                  @click='runPageMenuAction(action.handler)'
                )
                  template(v-slot:prepend): v-icon(:color='action.handler === `pageDelete` ? `error` : `primary`') {{ action.icon }}
                  v-list-item-title.text-body-medium {{ $t(`common:header.${action.label}`) }}

          //- NEW PAGE

          template(v-if='hasNewPagePermission && path && mode !== `edit` && $vuetify.display.mdAndUp')
            v-tooltip(location="bottom")
              template(v-slot:activator='{ props }')
                v-btn(
                  icon
                  rounded='lg'
                  v-bind='props'
                  :aria-disabled='!onlineActionReady ? `true` : undefined'
                  @click='pageNew'
                  :aria-label='$t(`common:header.newPage`)'
                )
                  v-icon mdi-text-box-plus-outline
              span {{ onlineActionReady ? $t('common:header.newPage') : onlineActionUnavailableReason }}

          //- ADMIN

          template(v-if='isAuthenticated && isAdmin && $vuetify.display.mdAndUp')
            v-tooltip(location="bottom", v-if='mode !== `admin`')
              template(v-slot:activator='{ props }')
                v-btn(
                  icon
                  rounded='lg'
                  v-bind='props'
                  :aria-disabled='!onlineActionReady ? `true` : undefined'
                  @click='openAdmin'
                  :aria-label='$t(`common:header.admin`)'
                )
                  v-icon mdi-cog
              span {{ onlineActionReady ? $t('common:header.admin') : onlineActionUnavailableReason }}
            v-btn(v-else, variant="text", rounded='lg', @click='exitAdmin', :aria-label='$t(`common:actions.exit`)')
              v-icon(start) mdi-exit-to-app
          v-menu(v-if='(hasMobilePageActions || ($vuetify.display.xs && !hideSearch)) && $vuetify.display.smAndDown', location='bottom end', min-width='240')
            template(v-slot:activator='{ props }')
              v-btn.nav-header-mobile-actions(
                icon
                v-bind='props'
                :size='dense ? `small` : `default`'
                :aria-label='$t(`common:header.pageActions`)'
                :data-search-modal-action='$vuetify.display.xs ? `` : undefined'
              )
                v-icon mdi-dots-vertical
            v-list.nav-header-menu(nav)
              v-list-item(
                v-if='$vuetify.display.xs && canEnterAgent'
                role='button'
                link
                prepend-icon='mdi-creation-outline'
                :aria-label='$t(`common:header.agentOpen`, { defaultValue: `Open Wiki Agent` })'
                data-search-modal-action
                @click='openAgent'
              )
                v-list-item-title {{ $t('common:header.agent', { defaultValue: 'Wiki Agent' }) }}
              p.nav-header-menu__note(v-if='$vuetify.display.xs && !hideSearch && !transportVerified') {{ navigationUnavailableReason }}
              v-list-item(
                v-if='$vuetify.display.xs && !hideSearch'
                href='/t'
                prepend-icon='mdi-tag-outline'
                :aria-label='$t(`common:header.browseTags`)'
                :aria-disabled='!transportVerified ? `true` : undefined'
                :aria-current='mode === `tags` ? `page` : undefined'
                data-search-modal-action
                @click='guardHeaderNavigation'
              )
                v-list-item-title {{ $t('common:header.browseTags') }}
              v-divider(v-if='$vuetify.display.xs && !hideSearch && hasMobilePageActions')
              v-list-subheader(v-if='hasMobilePageActions') {{ $t('common:header.pageActions') }}
              p.nav-header-menu__note(v-if='hasMobilePageActions && !onlineActionReady && onlineActionUnavailableReason') {{ onlineActionUnavailableReason }}
              v-list-item(
                v-for='action of mobilePageMenuActions'
                :key='action.handler'
                :role='action.handler === `pageDuplicate` ? undefined : `button`'
                link
                :class='{ "nav-header-menu-danger": action.handler === `pageDelete` }'
                :disabled='action.handler === `pageView` ? !readerActionReady : !onlineActionReady'
                :prepend-icon='action.icon'
                @click='runPageMenuAction(action.handler)'
              )
                v-list-item-title {{ $t(`common:header.${action.label}`) }}
              v-divider(v-if='hasNewPagePermission || (isAuthenticated && isAdmin)')
              v-list-item(
                role='button'
                link
                v-if='hasNewPagePermission && path && mode !== `edit`'
                :disabled='!onlineActionReady'
                prepend-icon='mdi-text-box-plus-outline'
                @click='pageNew'
              )
                v-list-item-title {{$t('common:header.newPage')}}
              v-list-item(
                v-if='isAuthenticated && isAdmin && mode !== `admin`'
                :disabled='!onlineActionReady'
                prepend-icon='mdi-cog'
                @click='openAdmin'
              )
                v-list-item-title {{$t('common:header.admin')}}
              v-list-item(
                v-if='isAuthenticated && isAdmin && mode === `admin`'
                :disabled='!onlineActionReady'
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
                  :aria-current='lc.code === locale ? `true` : undefined'
                  prepend-icon='mdi-web'
                  @click='changeLocale(lc)'
                )
                  v-list-item-title {{lc.name}}


          v-btn.nav-header-sign-in(
            v-if='!isAuthenticated && verifiedAnonymous'
            href='/login'
            variant='text'
            rounded='lg'
            data-no-wiki-navigation
          ) {{ $t('common:accountMenu.signIn', { defaultValue: 'Sign in' }) }}

          v-menu(location="bottom end", transition='slide-y-transition', :close-on-content-click='false', @update:model-value='accountMenuVisibilityChanged')
            template(v-slot:activator='{ props: menuProps }')
              //- Touch keeps the hover state after a tap; the tooltip must not
              //- stay over the open menu.
              v-tooltip(location="bottom", :model-value='accountTooltipOpen', @update:model-value='setAccountTooltip')
                template(v-slot:activator='{ props: tooltipProps }')
                  v-btn.account-menu__trigger(
                    icon
                    v-bind='mergeProps(menuProps, tooltipProps)'
                    :class='$vuetify.locale.isRtl ? `ml-0` : ``'
                    rounded='lg'
                    :aria-label='accountButtonLabel'
                    :aria-description='connectionLabel'
                  )
                    template(v-if='isAuthenticated')
                      v-avatar(v-if='avatar.kind === `initials`', :size='32', color='primary')
                        span.account-menu__initials {{ avatar.initials }}
                      v-avatar(v-else-if='avatar.kind === `image`', :size='32')
                        v-img(:src='avatar.url', alt='', @error='avatarFailed(avatar.url)')
                      v-icon(v-else) mdi-account-circle
                    v-icon(v-else) mdi-account-circle
                    span.account-menu__notification-indicator(
                      v-if='isAuthenticated && notificationState !== `clear`'
                      :class='`account-menu__notification-indicator--${notificationState}`'
                      aria-hidden='true'
                    )
                    span.account-menu__connectivity-indicator(
                      :class='`account-menu__connectivity-indicator--${connectionPresentation.tone}`'
                      :data-connection='connectionPresentation.key'
                      data-connectivity-indicator
                      aria-hidden='true'
                    )
                      v-icon(:icon='connectionPresentation.icon', size='13')
                span {{ accountButtonLabel }} · {{ connectionLabel }}
            v-list.nav-header-menu.account-menu(:aria-label='accountMenuLabel')
              template(v-if='isAuthenticated')
                v-list-item.account-menu__profile.py-3.bg-surface-variant(
                  :href='onlineActionReady ? `/p` : undefined'
                  :aria-label='onlineActionReady ? $t(`common:accountMenu.openProfile`, { name, defaultValue: `Open profile for {{name}}`, interpolation: { escapeValue: false } }) : $t(`common:accountMenu.lastVerifiedAccount`, { name, defaultValue: `Last verified account: {{name}}`, interpolation: { escapeValue: false } })'
                )
                  template(v-slot:prepend)
                    v-avatar.bg-primary(v-if='avatar.kind === `initials`', :size='40')
                      span.text-on-primary.text-body-large {{ avatar.initials }}
                    v-avatar(v-else-if='avatar.kind === `image`', :size='40')
                      v-img(:src='avatar.url', alt='', @error='avatarFailed(avatar.url)')
                    v-avatar.account-menu__avatar-fallback(v-else, :size='40')
                      v-icon(aria-hidden='true') mdi-account
                  v-list-item-title
                    span.account-menu__profile-label {{ onlineActionReady ? $t('common:header.profile') : $t('common:header.account') }}
                    | {{name}}
                  v-list-item-subtitle {{ onlineActionReady ? email : $t('common:accountMenu.lastVerifiedDetail', { defaultValue: 'Last verified account · Reconnect for account actions' }) }}
                v-divider
                .account-menu__tabs(
                  role='tablist'
                  :aria-label='$t(`common:accountMenu.sections`, { defaultValue: `Account menu sections` })'
                  @keydown='accountMenuTabKeydown'
                )
                  button.account-menu__tab(
                    v-for='tab in accountMenuTabs'
                    :key='tab.id'
                    :id='`account-menu-tab-${tab.id}`'
                    type='button'
                    role='tab'
                    :class='{ "account-menu__tab--active": accountMenuTab === tab.id }'
                    :aria-selected='accountMenuTab === tab.id ? `true` : `false`'
                    :aria-controls='`account-menu-panel-${tab.id}`'
                    :tabindex='accountMenuTab === tab.id ? 0 : -1'
                    :data-tab='tab.id'
                    @click='accountMenuTab = tab.id'
                  )
                    span {{ tab.label }}
                    span.account-menu__tab-badge(v-if='tab.badge', aria-hidden='true') {{ tab.badge }}
                    span.account-menu__sr-only(v-if='tab.badgeLabel') , {{ tab.badgeLabel }}
                .account-menu__panels
                  .account-menu__panel(
                    v-for='tab in accountMenuTabs'
                    :key='tab.id'
                    v-show='accountMenuTab === tab.id'
                    :id='`account-menu-panel-${tab.id}`'
                    role='tabpanel'
                    :aria-labelledby='`account-menu-tab-${tab.id}`'
                    tabindex='0'
                  )
                    template(v-if='tab.id === `notifications`')
                      AccountNotifications.account-menu__notifications(
                        v-if='onlineActionReady && !siteNotifications.identityStale'
                        :section='approvalsTabVisible ? `changes` : `all`'
                      )
                      p.account-menu__panel-note(v-else) {{ onlineActionUnavailableReason }}
                    template(v-else-if='tab.id === `approvals`')
                      AccountNotifications.account-menu__approvals(
                        v-if='onlineActionReady && !siteNotifications.identityStale'
                        section='approvals'
                      )
                      p.account-menu__panel-note(v-else) {{ onlineActionUnavailableReason }}
                    section.account-menu__preferences(
                      v-else-if='tab.id === `appearance`'
                      role='region'
                      :aria-label='$t(`common:accountMenu.appearanceSettings`, { defaultValue: `Appearance settings` })'
                    )
                      appearance-selector
                    account-offline-summary(v-else-if='tab.id === `offline`')
                v-divider
                form.account-menu__session(action='/logout', method='post', :aria-busy='logoutPending ? `true` : undefined', @submit='clearAgentChatPinOnLogout')
                  v-list-item(
                    tag='button'
                    type='submit'
                    link
                    :aria-disabled='logoutPending || !onlineActionReady ? `true` : undefined'
                    :class='{ "account-menu__session--blocked": logoutPending || !onlineActionReady }'
                  )
                    template(v-slot:append): v-icon(color='error') mdi-logout
                    v-list-item-title.text-error {{ logoutPending ? $t('common:accountMenu.signingOut', { defaultValue: 'Signing out…' }) : $t('common:header.logout') }}
                    v-list-item-subtitle(v-if='!onlineActionReady && !logoutPending') {{ $t('common:accountMenu.reconnectToSignOut', { defaultValue: 'Reconnect to sign out.' }) }}
              template(v-else)
                .account-menu__offline
                  account-offline-summary
                v-divider
                template(v-if='verifiedAnonymous')
                  v-list-item(
                    role='button'
                    link
                    href='/login'
                    data-no-wiki-navigation
                    :aria-label='$t(`common:accountMenu.signIn`, { defaultValue: `Sign in` })'
                  )
                    template(v-slot:prepend): v-icon(color='primary') mdi-login
                    v-list-item-title {{ $t('common:accountMenu.signIn', { defaultValue: 'Sign in' }) }}
                v-list-item.account-menu__unverified(v-else, role='status')
                  template(v-slot:prepend): v-icon mdi-account-clock-outline
                  v-list-item-title {{ accountVerificationTitle }}
                  v-list-item-subtitle {{ accountVerificationDetail }}
    page-selector(mode='create', v-model='newPageModal', :open-handler='pageNewCreate', :locale='locale')
    page-selector(
      mode='move'
      v-model='movePageModal'
      :open-handler='pageMoveRename'
      :path='path'
      :locale='locale'
      :source-page-id='sourcePageId'
      :source-source-revision='sourceSourceRevision'
      :source-visibility='sourceVisibility'
      @move-acknowledged='pageMoveAcknowledged'
    )
    page-selector(mode='create', v-model='duplicateOpts.modal', :open-handler='pageDuplicateHandle', :path='duplicateOpts.path', :locale='duplicateOpts.locale')
    page-delete(v-model='deletePageModal', v-if='path && path.length')
    page-convert(v-model='convertPageModal', v-if='path && path.length')

    .nav-header-dev(v-if='isDevMode')
      v-icon mdi-alert
      div
        .text-label-small {{ $t(`common:navHeader.developmentVersion`) }}
        .text-label-small {{ $t(`common:navHeader.codeBaseNotProduction`) }}
</template>

<script lang='ts'>
import { defineAsyncComponent, defineComponent, markRaw, mergeProps } from 'vue'
import {
  invalidateOfflineIdentity,
  markOfflineLogoutPending,
  OFFLINE_IDENTITY_CLEANUP_FAILURE_MESSAGE,
  wikiStore
} from '@/store/index.ts'
import AccountNotifications from './account-notifications.vue'
import AccountOfflineSummary from './account-offline-summary.vue'
import ControlBorderBeam from './control-border-beam.vue'
import { fetchPageLocaleRelations, movePage, type MovePageReceipt } from '../../helpers/pages-api'
import { useAgentsStore } from '../../store/agents.ts'
import { useSiteNotificationsStore } from '../../store/site-notifications.ts'
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
import { emitSearchEnter, emitSearchExit, emitSearchMove, onSearchFocus, offSearchFocus } from '../../helpers/search-navigation-events'
import { resolveUserPicture } from '../../helpers/user-picture.ts'
import type { UserPicture } from '../../helpers/user-picture.ts'
import * as pwa from '../../helpers/pwa.ts'
import { translateConnection } from '../../helpers/offline-sync-status.ts'

type PageLocation = { path: string, locale: string }
type AccountMenuTabId = 'notifications' | 'approvals' | 'appearance' | 'offline'
type AccountMenuTab = { id: AccountMenuTabId, label: string, badge?: string, badgeLabel?: string }
const APPROVAL_PERMISSION_NAMES = new Set(['write:pages', 'manage:pages', 'manage:system'])
type SiteLocale = { code: string, name: string }
type PageMoveSelection = PageLocation & {
  sourcePageId?: number
  expectedSourceRevision?: string
  reviewToken?: string
}
type PageMoveAcknowledgement = { locale: string, path: string, receipt: MovePageReceipt }

// Both page menus share order and permission gates; their presentation stays local.
const PAGE_MENU_ACTIONS = [
  { handler: 'pageView', label: 'view', icon: 'mdi-file-document-outline', mode: 'view', permission: null },
  { handler: 'pageEdit', label: 'edit', icon: 'mdi-file-document-edit-outline', mode: 'edit', permission: 'hasWritePagesPermission' },
  { handler: 'pageHistory', label: 'history', icon: 'mdi-history', mode: 'history', permission: 'hasReadHistoryPermission' },
  { handler: 'pageSource', label: 'viewSource', icon: 'mdi-code-tags', mode: 'source', permission: 'hasReadSourcePermission' },
  { handler: 'pageConvert', label: 'convert', icon: 'mdi-lightning-bolt', mode: null, permission: 'hasWritePagesPermission' },
  { handler: 'pageDuplicate', label: 'duplicate', icon: 'mdi-content-duplicate', mode: null, permission: 'hasWritePagesPermission' },
  { handler: 'pageMove', label: 'move', icon: 'mdi-content-save-move-outline', mode: null, permission: 'hasManagePagesPermission' },
  { handler: 'pageDelete', label: 'delete', icon: 'mdi-trash-can-outline', mode: null, permission: 'hasDeletePagesPermission' }
] as const

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
    ControlBorderBeam,
    AppearanceSelector: defineAsyncComponent(() => import('./appearance-selector.vue')),
    AccountOfflineSummary,
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
      accountMenuOpen: false,
      accountTooltipOpen: false,
      accountMenuTab: 'notifications' as AccountMenuTabId,
      failedAvatarUrl: null as string | null,
      pageActionsFocusFrame: null as number | null,
      notificationIdentityRecovery: null as Promise<void> | null,
      notificationIdentityRecoveryGeneration: 0,
      headerActionGeneration: 1,
      searchFocusGeneration: 0,
      logoutPending: false,
      navHeaderTitleFitScale: 1 as number,
      navHeaderTitleResizeObserver: null as ResizeObserver | null,
      duplicateOpts: {
        locale: 'en',
        path: 'new-page',
        modal: false
      }
    }
  },
  computed: {
    pageMenuActions(): (typeof PAGE_MENU_ACTIONS)[number][] {
      return PAGE_MENU_ACTIONS.filter(action =>
        (action.mode === null || this.mode !== action.mode) &&
        (action.permission === null || this[action.permission])
      )
    },
    desktopPageMenuActions(): (typeof PAGE_MENU_ACTIONS)[number][] {
      return this.pageMenuActions.filter(action => action.handler !== 'pageEdit')
    },
    mobilePageMenuActions(): (typeof PAGE_MENU_ACTIONS)[number][] {
      return this.path ? this.pageMenuActions : []
    },
    search: {
      get(): string { return wikiStore.site.search ?? '' },
      set(value: string | null | undefined) { wikiStore.site.search = value ?? '' }
    },
    searchMode: {
      get(): 'search' | 'ask' { return wikiStore.site.searchMode },
      set(value: 'search' | 'ask') { wikiStore.site.searchMode = value }
    },
    searchIsFocused: {
      get(): boolean { return wikiStore.site.searchIsFocused },
      set(value: boolean) { wikiStore.site.searchIsFocused = value }
    },
    searchIsLoading(): boolean { return wikiStore.site.searchIsLoading },
    isLoading(): boolean { return wikiStore.isLoading },
    connectionPresentation(): pwa.PwaConnectionPresentation {
      return pwa.pwaConnectionPresentation(pwa.pwaState)
    },
    title(): string { return wikiStore.site.title },
    titleWords(): string[] { return this.title.trim().split(/\s+/u).filter(Boolean) },
    // Balanced two-line split for small screens: pick the word boundary that
    // minimizes the longest resulting line so both halves read evenly.
    titleLines(): string[] {
      const words = this.titleWords
      if (words.length <= 1) return words
      let bestSplit = 1
      let bestWidest = Number.POSITIVE_INFINITY
      for (let split = 1; split < words.length; split += 1) {
        const first = words.slice(0, split).join(' ')
        const second = words.slice(split).join(' ')
        const widest = Math.max(first.length, second.length)
        if (widest < bestWidest) {
          bestWidest = widest
          bestSplit = split
        }
      }
      return [words.slice(0, bestSplit).join(' '), words.slice(bestSplit).join(' ')]
    },
    navHeaderTitleStackedStyle(): Record<string, string> {
      return { '--nav-header-title-fit': this.navHeaderTitleFitScale.toFixed(3) }
    },
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
    sourcePageId(): number { return wikiStore.page.id },
    sourceSourceRevision(): string { return wikiStore.page.sourceRevision },
    sourceVisibility(): 'public' | 'private' { return wikiStore.page.visibility },
    name(): string { return wikiStore.user.name },
    email(): string { return wikiStore.user.email },
    transportVerified(): boolean {
      return pwa.pwaState?.connectionState === 'online' &&
        pwa.pwaState?.serverReachable === true &&
        pwa.pwaState?.serverHealthy === true
    },
    navigationUnavailableReason(): string {
      return this.transportVerified ? '' : this.$t('common:accountMenu.reasonConnection', { defaultValue: 'Reconnect to the server to use this.' })
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
      if (!this.transportVerified) return this.$t('common:accountMenu.reasonConnection', { defaultValue: 'Reconnect to the server to use this.' })
      if (!this.authorizationFresh) return this.$t('common:accountMenu.reasonSession', { defaultValue: 'Your sign-in must be checked again before you can use this.' })
      return ''
    },
    isAuthenticated(): boolean { return wikiStore.user.authenticated },
    verifiedAnonymous(): boolean {
      return this.transportVerified && !wikiStore.authRefreshPending &&
        wikiStore.authRefreshSettled && wikiStore.authRefreshOutcome === 'anonymous'
    },
    accountVerificationTitle(): string {
      return this.transportVerified && wikiStore.authRefreshPending ? this.$t('common:navHeader.checkingAccount') : this.$t('common:navHeader.accountNotVerified')
    },
    accountVerificationDetail(): string {
      return this.transportVerified && wikiStore.authRefreshPending
        ? this.$t('common:navHeader.confirmingSessionServer')
        : this.$t('common:navHeader.reconnectVerifySessionOffline')
    },
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
      return this.$t('common:accountMenu.label', { defaultValue: 'Account menu' })
    },
    connectionLabel(): string {
      return translateConnection(this.connectionPresentation, (key, options) => this.$t(key, options))
    },
    approvalsTabVisible(): boolean {
      return this.isAuthenticated && (
        this.permissions.some(permission => APPROVAL_PERMISSION_NAMES.has(permission)) ||
        this.siteNotifications.approvals.length > 0
      )
    },
    accountMenuTabs(): AccountMenuTab[] {
      const tabs: AccountMenuTab[] = [
        { id: 'notifications', label: this.$t('common:accountMenu.tabNotifications', { defaultValue: 'Notifications' }) }
      ]
      if (this.approvalsTabVisible) {
        const count = this.siteNotifications.approvals.length
        const more = this.siteNotifications.approvalsNextCursor !== null
        const badge = count > 0 ? `${count}${more ? '+' : ''}` : undefined
        tabs.push({
          id: 'approvals',
          label: this.$t('common:accountMenu.tabApprovals', { defaultValue: 'Approvals' }),
          badge,
          badgeLabel: badge ? this.$t('common:accountMenu.approvalsCount', { count: badge, defaultValue: '{{count}} active' }) : undefined
        })
      }
      tabs.push(
        { id: 'appearance', label: this.$t('common:accountMenu.tabAppearance', { defaultValue: 'Appearance' }) },
        { id: 'offline', label: this.$t('common:accountMenu.tabOffline', { defaultValue: 'Offline' }) }
      )
      return tabs
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
    searchShortcutLabel(): string { return /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : this.$t('common:navHeader.ctrlK') },
    searchInputIcon(): string { return this.searchMode === 'ask' ? 'mdi-auto-fix' : 'mdi-magnify' },
    picture (): UserPicture {
      return resolveUserPicture(wikiStore.user)
    },
    avatar (): UserPicture | { kind: 'icon' } {
      const picture = this.picture
      if (picture.kind === 'image' && picture.url !== this.failedAvatarUrl) return picture
      // A failed image falls back to initials; no name falls back to a person icon.
      const fallback = picture.kind === 'initials' ? picture : resolveUserPicture({ ...wikiStore.user, pictureUrl: '' })
      const initials = fallback.kind === 'initials' ? fallback.initials : ''
      return initials ? { kind: 'initials', initials } : { kind: 'icon' }
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
    approvalsTabVisible(visible: boolean): void {
      if (!visible && this.accountMenuTab === 'approvals') this.accountMenuTab = 'notifications'
    },
    title(): void {
      void this.$nextTick().then(() => this.applyNavHeaderTitleFit())
    },
    transportVerified(connected: boolean, previous: boolean): void {
      if (connected && previous === false && !wikiStore.authRefreshPending) void wikiStore.refreshAuth()
    },
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
    onSearchFocus(this.handleSearchFocusCommand)
    onPageDelete(this.pageDelete)
    this.isDevMode = siteConfig.devMode === true
    if (typeof ResizeObserver !== 'undefined') {
      const titleBox = this.$refs.navHeaderTitleStacked as HTMLElement | undefined
      if (titleBox) {
        this.navHeaderTitleResizeObserver = markRaw(new ResizeObserver(() => this.applyNavHeaderTitleFit()))
        this.navHeaderTitleResizeObserver.observe(titleBox)
      }
    }
    if (typeof document !== 'undefined' && typeof document.fonts !== 'undefined' && document.fonts.ready) {
      void document.fonts.ready.then(() => this.applyNavHeaderTitleFit()).catch(() => {})
    }
    window.addEventListener('keydown', this.handleSearchShortcut)
    document.addEventListener('visibilitychange', this.handleNotificationVisibility)
    window.addEventListener('focus', this.handleNotificationFocus)
    this.syncSiteNotifications()
  },
  beforeUnmount () {
    this.searchFocusGeneration += 1
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
    offSearchFocus(this.handleSearchFocusCommand)
    window.removeEventListener('focus', this.handleNotificationFocus)
    this.pageActionsAreOpen = false
    if (this.pageActionsFocusFrame !== null) {
      window.cancelAnimationFrame(this.pageActionsFocusFrame)
      this.pageActionsFocusFrame = null
    }
    this.navHeaderTitleResizeObserver?.disconnect()
    this.navHeaderTitleResizeObserver = null
  },
  methods: {
    mergeProps,
    runPageMenuAction(handler: (typeof PAGE_MENU_ACTIONS)[number]['handler']): void {
      this[handler]()
    },
    // Keeps the workspace title whole on narrow screens. The stacked variant
    // starts from a balanced two-word-group split and lets each group wrap
    // (balanced) onto more lines. If a word or the line count still does not
    // fit the header, the text steps down in size. Each run starts again at
    // full size, so the result depends only on the available space and cannot
    // oscillate. At the smallest step an over-long word breaks instead of
    // being cut off.
    applyNavHeaderTitleFit (): void {
      if (typeof window === 'undefined' || typeof document === 'undefined') return
      const box = this.$refs.navHeaderTitleStacked as HTMLElement | undefined
      if (!box) return
      if (box.clientWidth <= 0 || box.getBoundingClientRect().width <= 0) {
        // Hidden on this breakpoint (the single desktop line owns wide screens).
        this.navHeaderTitleFitScale = 1
        return
      }
      const lines = Array.from(box.querySelectorAll<HTMLElement>('.nav-header-title-line'))
      // Flex-shrunk, overflow-hidden lines can clip even when the box fits.
      const fits = (): boolean =>
        box.scrollHeight <= box.clientHeight + 1 && lines.every(line =>
          line.scrollWidth <= line.clientWidth + 1 && line.scrollHeight <= line.clientHeight + 1
        )
      const steps = [1, 0.92, 0.84, 0.76, 0.7]
      let next = steps[steps.length - 1]!
      box.classList.add('is-measuring')
      for (const scale of steps) {
        box.style.setProperty('--nav-header-title-fit', scale.toFixed(3))
        if (fits()) {
          next = scale
          break
        }
      }
      box.classList.remove('is-measuring')
      box.style.setProperty('--nav-header-title-fit', next.toFixed(3))
      this.navHeaderTitleFitScale = next
    },
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
    avatarFailed (url: string): void {
      this.failedAvatarUrl = url
    },
    accountMenuTabKeydown (event: KeyboardEvent): void {
      const tabs = this.accountMenuTabs
      const index = tabs.findIndex(tab => tab.id === this.accountMenuTab)
      if (index < 0 || tabs.length === 0) return
      const forward = this.$vuetify.locale.isRtl ? 'ArrowLeft' : 'ArrowRight'
      const backward = this.$vuetify.locale.isRtl ? 'ArrowRight' : 'ArrowLeft'
      let next = index
      if (event.key === forward) next = (index + 1) % tabs.length
      else if (event.key === backward) next = (index - 1 + tabs.length) % tabs.length
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = tabs.length - 1
      else return
      // The surrounding v-list also handles arrows, Home, and End.
      event.preventDefault()
      event.stopPropagation()
      const tab = tabs[next]
      if (!tab) return
      this.accountMenuTab = tab.id
      void this.$nextTick(() => {
        const root = this.$el instanceof Element ? this.$el.ownerDocument : document
        root.getElementById(`account-menu-tab-${tab.id}`)?.focus()
      })
    },
    clearAgentChatPinOnLogout (event: SubmitEvent): void {
      event.preventDefault()
      if (this.logoutPending || !this.onlineActionReady) return
      this.logoutPending = true

      const currentTarget = event.currentTarget
      const form = currentTarget && typeof (currentTarget as HTMLFormElement).submit === 'function'
        ? currentTarget as HTMLFormElement
        : null
      const accountId = this.isAuthenticated && Number.isSafeInteger(wikiStore.user.id) && wikiStore.user.id > 0
        ? wikiStore.user.id
        : undefined

      if (!markOfflineLogoutPending(accountId)) {
        this.logoutPending = false
        wikiStore.showError(new Error(OFFLINE_IDENTITY_CLEANUP_FAILURE_MESSAGE))
        return
      }

      this.notificationIdentityRecoveryGeneration += 1
      // Retire the live workspace too, so pagehide cannot recreate its bookmarks.
      useAgentsStore().destroyWorkspace()
      this.siteNotifications.reset()

      void (async () => {
        const retired = await invalidateOfflineIdentity(accountId)
        if (!retired) {
          this.logoutPending = false
          wikiStore.showError(new Error(OFFLINE_IDENTITY_CLEANUP_FAILURE_MESSAGE))
          return
        }
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
      this.accountMenuOpen = open
      if (open) this.accountTooltipOpen = false
      if (open) this.refreshSiteNotifications()
    },
    setAccountTooltip(open: boolean): void {
      this.accountTooltipOpen = open && !this.accountMenuOpen
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
        desktop ? '.nav-header-browse' : this.$vuetify.display.xs ? '.nav-header-logo' : '.nav-header-agent'
      ) ?? document.querySelector<HTMLElement>('.nav-header-logo')
      const forwardTarget = document.querySelector<HTMLElement>(
        desktop
          ? '.nav-header-actions button:not(:disabled), .nav-header-actions a[href]'
          : this.$vuetify.display.xs ? '.nav-header-mobile-actions' : '.nav-header-browse'
      ) ?? document.querySelector<HTMLElement>('.nav-header-actions button:not(:disabled), .nav-header-actions a[href]')
      const target = event.shiftKey ? previousTarget : forwardTarget
      target?.focus({ preventScroll: true })
    },
    searchClose () {
      this.searchFocusGeneration += 1
      this.searchIsFocused = false
      this.searchMode = 'search'
      this.search = ''
    },
    handleSearchFocusCommand (): void {
      if (this.hideSearch || (this.dense && this.$vuetify.display.mdAndUp)) return
      void this.focusSearchField()
    },
    async focusSearchField (): Promise<void> {
      if (this.hideSearch || (this.dense && this.$vuetify.display.mdAndUp)) return
      const focusGeneration = ++this.searchFocusGeneration
      this.searchIsShown = true
      this.searchIsFocused = true
      await this.$nextTick()
      if (
        focusGeneration !== this.searchFocusGeneration ||
        this.hideSearch ||
        !this.searchIsShown ||
        !this.searchIsFocused ||
        (this.dense && this.$vuetify.display.mdAndUp)
      ) return
      const field = this.$vuetify.display.smAndDown ? this.$refs.searchFieldMobile : this.$refs.searchField
      const focusable = field as { focus?: (options?: FocusOptions) => void, $el?: unknown } | undefined
      if (typeof focusable?.focus === 'function') {
        focusable.focus({ preventScroll: true })
        return
      }
      const root = focusable?.$el
      if (root instanceof HTMLElement) {
        root.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
      }
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
    async openAgent(): Promise<void> {
      if (!this.canEnterAgent || !this.onlineActionReady) return
      if (this.$vuetify.display.xs) {
        // Retire an existing Search scope so Agent owns the stable menu opener,
        // rather than inheriting Search's original restore target.
        if (this.searchIsFocused) {
          emitSearchExit(false)
          this.searchIsFocused = false
          await this.$nextTick()
        }
        // VMenu's activator props own the ref; capture the rendered button.
        document.querySelector<HTMLButtonElement>('.nav-header-mobile-actions')?.focus({ preventScroll: true })
      }
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
      if (event.defaultPrevented || event.isComposing || event.altKey) return
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
    async pageMoveRename({
      path,
      locale,
      sourcePageId,
      expectedSourceRevision,
      reviewToken
    }: PageMoveSelection): Promise<boolean | void | MovePageReceipt> {
      if (!this.onlineActionReady || !this.pageResourceReady) return false
      if (
        typeof sourcePageId !== 'number' ||
        !Number.isSafeInteger(sourcePageId) ||
        sourcePageId < 1 ||
        typeof expectedSourceRevision !== 'string' ||
        expectedSourceRevision.length < 1 ||
        sourcePageId !== this.sourcePageId ||
        expectedSourceRevision !== this.sourceSourceRevision
      ) {
        const staleError = new Error(this.$t('common:navHeader.pageChangedBeforeMove')) as Error & { status: number }
        staleError.status = 409
        throw staleError
      }
      const generation = this.headerActionGeneration
      wikiStore.startLoading('page-move')
      try {
        const receipt = await movePage(
          window.fetch.bind(window),
          sourcePageId,
          locale,
          path,
          expectedSourceRevision,
          this.$t('common:navHeader.pageMoveFailed'),
          reviewToken
        )
        if (generation !== this.headerActionGeneration)
          throw new Error(this.$t('common:navHeader.moveResponseCouldNot'))
        if (reviewToken !== undefined) {
          if (!receipt) throw new Error(this.$t('common:navHeader.moveReceiptCouldNot'))
          return receipt
        }
        const scope = this.sourceVisibility === 'private' ? '/_private' : ''
        window.location.replace(`${scope}/${locale}/${path}`)
      } finally {
        wikiStore.stopLoading('page-move')
      }
    },
    pageMoveAcknowledged({ locale, path, receipt }: PageMoveAcknowledgement): void {
      if (receipt.pageId !== this.sourcePageId) return
      const scope = this.sourceVisibility === 'private' ? '/_private' : ''
      window.location.replace(`${scope}/${locale}/${path}`)
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
  // The spark beam sweeping the button border shares the Agent icon's accent,
  // overriding the global warm/spectral beam palette for this control only.
  --wiki-beam-violet: var(--nav-header-agent-icon-color);
  --wiki-beam-cool: color-mix(in srgb, var(--nav-header-agent-icon-color) 62%, rgb(var(--v-theme-surface)));
}
/* The Agent entry button keeps the shared focus outline but semi-transparent:
   40% of the neutral focus color instead of the fully opaque default. */
.nav-header-agent:focus-visible {
  outline-color: color-mix(in srgb, var(--wiki-focus-color) 40%, transparent);
}

.nav-header {
  // Same palette-aware agent mark color as the Wiki Agent thread (agent-thread.vue).
  --nav-header-agent-icon-color: color-mix(in srgb, rgb(var(--v-theme-info)) 85%, rgb(var(--v-theme-on-surface)));
  --nav-header-edit-icon-color: #fdb600;
  --nav-header-edit-eraser-color: #dbb7bb;
  --nav-header-tint: linear-gradient(90deg, color-mix(in srgb, var(--wiki-accent-warm) 8%, transparent), transparent 42%, color-mix(in srgb, var(--wiki-accent-spectral) 6%, transparent));
  --nav-header-surface: var(--wiki-chrome-surface);
  isolation: isolate;
  border-bottom: 1px solid var(--wiki-surface-border) !important;
  background-color: var(--nav-header-surface) !important;
  background-image: var(--nav-header-tint) !important;
  color: rgb(var(--v-theme-on-surface));
  box-shadow: 0 3px 10px color-mix(in srgb, var(--wiki-shadow-color) 35%, transparent) !important;
  -webkit-backdrop-filter: var(--wiki-chrome-blur) !important;
  backdrop-filter: var(--wiki-chrome-blur) !important;

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
    -webkit-backdrop-filter: var(--wiki-chrome-blur) !important;
    backdrop-filter: var(--wiki-chrome-blur) !important;

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

    // Wide screens: one line when it fits, otherwise balanced lines.
    .nav-header-title-single {
      display: block;
      overflow: hidden;
      overflow-wrap: break-word;
      text-wrap: balance;
      white-space: normal;
      line-height: 1.15;
    }

    // Small-screen stacked workspace title: multi-word names start from two
    // balanced word groups, and each group may wrap (balanced) again. A title
    // that still does not fit shrinks in steps via --nav-header-title-fit,
    // measured by applyNavHeaderTitleFit(). Nothing is cut off with an ellipsis.
    .nav-header-title-stacked {
      display: none;
      flex-direction: column;
      align-items: flex-start;
      justify-content: center;
      gap: 0;
      min-width: 0;
      max-width: 100%;
      max-height: 3rem;
      overflow: hidden;
      font-size: calc(.8125rem * var(--nav-header-title-fit, 1));
      letter-spacing: -.012em;
      line-height: 1.16;
      padding-block: 2px;
    }

    .nav-header-title-line {
      display: block;
      max-width: 100%;
      overflow: hidden;
      overflow-wrap: break-word;
      text-wrap: balance;
      white-space: normal;
    }

    // While measuring, long words overflow instead of breaking, so the fit
    // can prefer a smaller size over a word split mid-way.
    .nav-header-title-stacked.is-measuring .nav-header-title-line {
      overflow-wrap: normal;
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
      min-height: var(--wiki-search-field-height, 2.25rem);
      overflow: hidden;
      border: 1px solid var(--wiki-glass-border, var(--wiki-surface-border-strong));
      border-radius: var(--wiki-control-radius);
      background-color: rgba(var(--v-theme-surface), .42) !important;
      background-image: none !important;
      color: rgb(var(--v-theme-on-surface)) !important;
      -webkit-backdrop-filter: blur(12px) saturate(150%) !important;
      backdrop-filter: blur(12px) saturate(150%) !important;
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
      min-height: var(--wiki-search-field-height, 2.25rem);
      padding-block: 0;
      font-size: .875rem;
      font-weight: 560;
      letter-spacing: .005em;
      opacity: 1 !important;
    }

    /* Vuetify puts .v-field__input ON the native input here, so the text row
       needs the height on the input itself: a full-height line box makes the
       text caret span the whole field instead of hovering mid-field with dead
       space above and below. */
    input.v-field__input {
      opacity: 1 !important;
      line-height: var(--wiki-search-field-height, 2.25rem);
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
      color: var(--wiki-text-muted);
      font-size: .8125rem;
      opacity: 1;
    }

    .v-field--focused {
      border-color: color-mix(in srgb, var(--wiki-ambient-accent) 62%, transparent);
      background-color: rgba(var(--v-theme-surface), .54) !important;
      box-shadow: var(--wiki-focus-ring), var(--wiki-shadow-inset);

      .v-field__prepend-inner {
        color: var(--wiki-primary-ink);
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
    -webkit-backdrop-filter: var(--wiki-chrome-blur) !important;
    backdrop-filter: var(--wiki-chrome-blur) !important;

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

    // Hover-only chrome cast: guarded so touch taps can't latch :hover
    // (mobile browsers keep the hover state until the user taps elsewhere,
    // which made the tint linger after opening the Agent). Touch feedback
    // stays with the button's own :active/ripple.
    @media (hover: hover) {
      &:hover {
        border-color: color-mix(in srgb, var(--wiki-ambient-accent) 20%, transparent);
        background: color-mix(in srgb, var(--wiki-ambient-accent) 9%, transparent);
        color: var(--wiki-primary-ink);
        transform: none;
      }
    }

    &:focus-visible {
      border-color: color-mix(in srgb, var(--wiki-focus-color) 48%, transparent);
      background: color-mix(in srgb, var(--wiki-focus-color) 8%, transparent);
      color: var(--wiki-primary-ink);
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
  // Agent + Edit share the transparent square chrome AND the standard theme
  // hover cast of the other header controls (.nav-header-inner .v-btn above);
  // only their border tint follows each control's own fixed icon accent.
  // Hover-only border tint is guarded so touch taps can't latch :hover
  // (mobile browsers keep hover until the next tap elsewhere).
  @media (hover: hover) {
    .nav-header-inner .nav-header-agent:hover {
      border-color: color-mix(in srgb, var(--nav-header-agent-icon-color) 48%, transparent) !important;
    }
    .nav-header-inner .nav-header-edit-btn:hover {
      border-color: color-mix(in srgb, var(--nav-header-edit-icon-color) 48%, transparent) !important;
    }

    // Hover accents touch only the glyph and label: the button fill keeps its
    // resting value. Each accent blends the control's own hue with the active
    // palette (secondary for Agent, primary for Edit) so custom themes follow.
    .nav-header-inner .nav-header-agent:hover:not(.v-btn--disabled):not([aria-disabled='true']),
    .nav-header-inner .nav-header-edit-btn:hover:not(.v-btn--disabled):not([aria-disabled='true']) {
      background: color-mix(in srgb, rgb(var(--v-theme-surface)) 72%, transparent);

      > .v-btn__overlay {
        opacity: 0;
      }
    }
    .nav-header-inner .nav-header-agent:hover:not(.v-btn--disabled) {
      --nav-header-hover-accent: color-mix(in oklab, var(--nav-header-agent-icon-color) 55%, var(--wiki-accent-spectral));
      color: var(--nav-header-hover-accent);
    }
    .nav-header-inner .nav-header-edit-btn:hover:not(.v-btn--disabled):not([aria-disabled='true']) {
      --nav-header-hover-accent: color-mix(in oklab, var(--nav-header-edit-icon-color) 60%, var(--wiki-accent-warm));
      color: var(--nav-header-hover-accent);
    }
    .nav-header-inner .nav-header-agent:hover:not(.v-btn--disabled) .v-icon,
    .nav-header-inner .nav-header-edit-btn:hover:not(.v-btn--disabled):not([aria-disabled='true']) .v-icon {
      color: var(--nav-header-hover-accent) !important;
      // !important also pauses the Agent shimmer keyframes while hovered.
      filter: drop-shadow(0 0 4px color-mix(in srgb, var(--nav-header-hover-accent) 45%, transparent)) !important;
    }
    // The pencil keeps its eraser cap; only the barrel takes the accent.
    .nav-header-inner .nav-header-edit-btn:hover:not(.v-btn--disabled):not([aria-disabled='true']) .v-icon::before {
      background: linear-gradient(45deg, var(--nav-header-hover-accent) 67%, var(--nav-header-edit-eraser-color) 67%);
      background-clip: text;
    }
  }
  .nav-header-inner .nav-header-agent:focus-visible {
    border-color: color-mix(in srgb, var(--nav-header-agent-icon-color) 48%, transparent) !important;
  }
  .nav-header-inner .nav-header-edit-btn:focus-visible {
    border-color: color-mix(in srgb, var(--nav-header-edit-icon-color) 48%, transparent) !important;
  }

  .nav-header-inner .nav-header-agent .v-icon,
  .nav-header-inner .nav-header-edit-btn .v-icon {
    transition:
      transform var(--wiki-motion-fast) var(--wiki-motion-ease-out),
      color var(--wiki-motion-normal) var(--wiki-motion-ease),
      filter var(--wiki-motion-normal) var(--wiki-motion-ease);
  }

  // Icon accents: the Agent spark follows the palette info color (the agent mark)
  // and the Edit pencil stays pencil yellow with a pink eraser in every theme.
  // Labels and button chrome keep inheriting the surrounding accent-ink color.
  .nav-header-inner .nav-header-agent .v-icon {
    color: var(--nav-header-agent-icon-color) !important;
    animation: nav-header-agent-spark-shimmer 7s ease-in-out infinite;
  }

  // Periodic sparkle: the spark rests for most of each 7s cycle, then glows and
  // brightens briefly around the 90% mark before settling again.
  @keyframes nav-header-agent-spark-shimmer {
    0%, 84%, 100% {
      filter: none;
      opacity: 1;
    }
    88% {
      filter: brightness(1.35) drop-shadow(0 0 7px color-mix(in srgb, var(--nav-header-agent-icon-color) 70%, transparent));
      opacity: 1;
    }
    91% {
      opacity: .6;
    }
    95% {
      filter: brightness(1.15) drop-shadow(0 0 3px color-mix(in srgb, var(--nav-header-agent-icon-color) 45%, transparent));
      opacity: 1;
    }
  }

  .nav-header-inner .nav-header-edit-btn .v-icon {
    color: var(--nav-header-edit-icon-color) !important;
  }
  // The MDI pencil points toward the upper right; a hard stop across its
  // diagonal separates its eraser cap without changing the icon silhouette.
  .nav-header-inner .nav-header-edit-btn .v-icon::before {
    background: linear-gradient(45deg, var(--nav-header-edit-icon-color) 67%, var(--nav-header-edit-eraser-color) 67%);
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  @media (hover: hover) {
    .nav-header-inner .nav-header-agent:hover .v-icon,
    .nav-header-inner .nav-header-edit-btn:hover .v-icon {
      transform: translateY(-1px);
    }
  }
  .nav-header-inner .nav-header-agent:focus-visible .v-icon,
  .nav-header-inner .nav-header-edit-btn:focus-visible .v-icon {
    transform: translateY(-1px);
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
    .nav-header-inner .nav-header-browse {
      min-height: 36px;
      height: 36px !important;
      width: 36px;
      min-width: 36px;
      border-radius: var(--wiki-radius-pill) !important;
    }
  }

  .nav-header-inner .v-divider {
    align-self: center;
    height: var(--wiki-space-6);
    max-height: var(--wiki-space-6);
    // The actions row's flex gap already spaces the divider 8px per side.
    margin-inline: 0;
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
    color: var(--wiki-text-muted) !important;
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
      color: var(--wiki-primary-ink);
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

  .v-divider {
    margin-block: var(--wiki-space-2);
    border-color: var(--wiki-surface-border);
    opacity: 1;
  }
}

.nav-header-menu.account-menu {
  width: min(calc(100vw - (var(--wiki-space-4) * 2)), 24rem);
  max-height: min(82dvh, 44rem);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.account-menu__trigger {
  position: relative;
}
.account-menu__profile .v-list-item-subtitle,
.account-menu__offline .v-list-item-subtitle,
.account-menu__unverified .v-list-item-subtitle {
  white-space: normal;
  -webkit-line-clamp: unset;
  line-height: 1.5;
}

.account-menu__connectivity-indicator {
  position: absolute;
  inset-inline-start: .2rem;
  bottom: .2rem;
  display: grid;
  width: 1rem;
  height: 1rem;
  place-items: center;
  border: 0;
  background: transparent;
  color: rgb(var(--v-theme-on-surface-variant));
  line-height: 1;
}

.account-menu__connectivity-indicator--success { color: rgb(var(--v-theme-success)); }
.account-menu__connectivity-indicator--warning { color: rgb(var(--v-theme-warning)); }
.account-menu__connectivity-indicator--error { color: rgb(var(--v-theme-error)); }


.account-menu__initials {
  font-size: .8125rem;
  font-weight: 700;
  color: rgb(var(--v-theme-on-primary));
  line-height: 1;
}

// The Edit control now shares the transparent square chrome of the other
// header buttons (.nav-header-inner .v-btn); no pill sizing of its own.

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
  border: 1.5px solid var(--wiki-text-muted);
  background: transparent;
  box-shadow: 0 0 0 1px color-mix(in srgb, rgb(var(--v-theme-on-surface)) 12%, transparent);
}

.account-menu__profile-label {
  display: block;
  margin-block-end: .1rem;
  color: var(--wiki-text-muted);
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

// Tabs size to their full label and share the leftover width. A narrow
// menu or a longer translation wraps them onto a second row; labels are
// never cut off.
.account-menu__tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--wiki-space-1);
  padding: var(--wiki-space-1) var(--wiki-space-2);
}

.account-menu__tab {
  display: inline-flex;
  flex: 1 0 auto;
  min-height: 36px;
  align-items: center;
  justify-content: center;
  gap: .3rem;
  padding: 0 var(--wiki-space-1);
  border: 0;
  border-radius: var(--wiki-control-radius, 8px);
  background: transparent;
  color: var(--wiki-text-muted);
  font: inherit;
  font-size: .8125rem;
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--wiki-motion-fast) var(--wiki-motion-ease), color var(--wiki-motion-fast) var(--wiki-motion-ease);

  > span:first-child {
    white-space: nowrap;
  }

  &:hover {
    background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 6%, transparent);
    color: rgb(var(--v-theme-on-surface));
  }

}

.account-menu__tab--active,
.account-menu__tab--active:hover {
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 14%, transparent);
  color: var(--wiki-primary-ink);
  font-weight: 750;
}

.account-menu__tab-badge {
  min-width: 1.25rem;
  padding: 0 .3rem;
  border-radius: 999px;
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
  font-size: .6875rem;
  font-weight: 700;
  line-height: 1.25rem;
  font-variant-numeric: tabular-nums;
}

.account-menu__sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.nav-header-menu__note {
  max-width: 18rem;
  margin: 0;
  padding: 0 var(--wiki-space-4) var(--wiki-space-2);
  color: var(--wiki-text-muted);
  font-size: .8125rem;
  line-height: 1.4;
}

.account-menu__panel-note {
  margin: 0;
  padding: var(--wiki-space-2) var(--wiki-space-3);
  color: var(--wiki-text-muted);
  font-size: .8125rem;
}

.account-menu__avatar-fallback {
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 10%, transparent);
  color: var(--wiki-text-muted);
}

.account-menu__session--blocked {
  cursor: default;
}

@media (prefers-reduced-motion: reduce) {
  .account-menu__tab { transition: none; }
}

.account-menu__panels {
  min-width: 0;
}

.account-menu__session {
  position: sticky;
  inset-block-end: 0;
  z-index: 1;
  background: rgb(var(--v-theme-surface));
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
      grid-template-columns: 36px minmax(0, 1fr) 36px;
      gap: var(--wiki-space-1);
    }

    .nav-header-command > .nav-header-browse {
      grid-column: 1;
      justify-self: start;
      margin: 0;
    }

    .nav-header-command > .nav-header-search-control {
      grid-column: 2;
      justify-self: center;
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

@media (min-width: 960px) and (max-width: 1319px) {
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

    // Square 44px targets with a small gap leave the workspace title room
    // to show whole at a readable size.
    .nav-header-actions {
      flex: 1 1 auto;
      gap: var(--wiki-space-1);
      min-width: 0;
      padding-inline: var(--wiki-space-1) var(--wiki-space-2);

      > .v-btn.v-btn--icon {
        width: 44px;
        min-width: 44px;
      }
    }

    .nav-header-title {
      font-size: .875rem;

      .nav-header-title-single {
        display: none;
      }

      .nav-header-title-stacked {
        display: flex;
      }
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
      min-width: 44px;
      min-height: 44px;
      height: 44px !important;
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
  .nav-header .nav-header-inner .nav-header-agent,
  .nav-header .nav-header-inner .nav-header-edit-btn {
    border-color: ButtonText !important;
    background: ButtonFace !important;
    color: ButtonText !important;
    transform: none !important;
    transition: none !important;
  }

  .nav-header .nav-header-inner .nav-header-agent .v-icon,
  .nav-header .nav-header-inner .nav-header-edit-btn .v-icon {
    color: ButtonText !important;
    transform: none !important;
    transition: none !important;
  }
  .nav-header .nav-header-inner .nav-header-edit-btn .v-icon::before {
    background: none;
    -webkit-text-fill-color: ButtonText;
  }

  .account-menu__connectivity-indicator {
    background: transparent;
    color: ButtonText;
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
  .nav-header .nav-header-inner .nav-header-agent .v-icon {
    animation: none !important;
  }
  .nav-header .nav-header-inner .nav-header-agent:hover .v-icon,
  .nav-header .nav-header-inner .nav-header-agent:focus-visible .v-icon,
  .nav-header .nav-header-inner .nav-header-edit-btn:hover .v-icon,
  .nav-header .nav-header-inner .nav-header-edit-btn:focus-visible .v-icon {
    transform: none !important;
  }
}
</style>
