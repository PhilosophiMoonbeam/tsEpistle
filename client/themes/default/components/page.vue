<template lang="pug">
  v-app.wiki-page(v-scroll='upBtnScroll', :class='[$vuetify.locale.isRtl ? `is-rtl` : `is-ltr`, { "wiki-page--reading": readerFocus && !talkActive }]')
    a.page-skip-link(:href='talkActive ? `#discussion` : `#${pageArticleId}`', @click.prevent='talkActive ? goToComments() : focusArticle()') Skip to content
    nav-header(v-if='!printView', reserve-actions)
    .page-position(v-if='!printView', role='progressbar', :aria-label='$t(`common:page.pagePosition`)', :aria-valuenow='readingProgress', aria-valuemin='0', aria-valuemax='100', :style='{ insetInlineStart: pagePositionInsetStart }')
      .page-position-fill(:style='{ transform: `scaleX(${readingProgress / 100})` }')
    .page-reading-dock(v-if='readerFocus && !printView && !talkActive', role='region', :aria-label='$t(`common:page.focusReading`)', style='backdrop-filter: var(--wiki-chrome-blur);')
      v-icon(icon='mdi-book-open-page-variant-outline', size='18', aria-hidden='true')
      span.page-reading-dock-title {{ title }}
      v-btn(variant='text', size='small', prepend-icon='mdi-arrow-collapse-horizontal', @click='toggleReaderFocus') {{$t('common:page.exitFocus')}}
    v-navigation-drawer(
      v-if='navMode !== `NONE` && !printView'
      id='page-navigation-drawer'
      class='page-navigation'
      tag='nav'
      color='surface'
      :mobile-breakpoint='1280'
      :width='navDrawerWidth'
      v-model='navigationOpen'
      :aria-label='$t(`common:sidebar.mainMenu`)'
      @update:model-value='navigationVisibilityChanged'
      )
      vue-scroll.page-nav-scroll(:ops='scrollStyle', style='scrollbar-gutter: auto;')
        nav-sidebar(
          color=''
          :items='sidebarDecoded'
          :nav-mode='navMode'
          :expand-parent-by-default='navExpandParent'
          @navigate='sidebarNavigationStarted'
        )

    v-fab-transition(v-if='navMode !== `NONE` && (!readerFocus || talkActive)')
      v-btn.page-nav-toggle(
        ref='navToggle'
        :class='{ "page-nav-toggle--open": navShown }'
        icon
        color='primary'
        size="small"
        @click='toggleNavigation'
        :aria-expanded='navShown ? `true` : `false`'
        aria-controls='page-navigation-drawer'
        :aria-label='navShown ? $t(`common:sidebar.closeNavigation`) : $t(`common:sidebar.openNavigation`)'
        v-if='$vuetify.display.width < 1280'
        )
        v-icon {{ navShown ? 'mdi-close' : 'mdi-menu' }}

    v-main.page-main(
      ref='content'
      :aria-busy='navigationPending ? `true` : undefined'
    )
      v-container.page-hero(
        ref='pageHero'
        fluid
        :class='{ "page-hero--with-toc": tocPosition !== `off`, "page-hero--accent-present": hasPageBrandingAccent }'
        :style='pageBrandingStyle'
      )
        v-row.page-header-section(:gap='0')
          v-col.page-col-content.is-page-header(
            cols='12'
            :class='[$vuetify.locale.isRtl ? `pr-4` : `pl-4`, `page-header--toc-${tocPosition}`, { "has-edit-shortcuts": editShortcutsObj.editMenuBar && (editShortcutsObj.editMenuBtn || editShortcutsObj.editMenuExternalBtn) }]'
            )
            .page-header-headings(
              :class='{ "page-header-headings--branded": pageBrandingVisible }'
            )
              .page-document-label
                v-icon(icon='mdi-book-open-page-variant-outline', size='15', aria-hidden='true')
                span Knowledge / {{ locale.toUpperCase() }}
              .page-title-row.d-flex.align-center
                h1.page-title(ref='pageTitle', :id='pageTitleId') {{title}}
                v-chip.page-visibility.ml-3(v-if="visibility === 'private'", size="small", color='warning', variant='tonal') {{$t('common:page.private')}}
              page-branding-mark(
                v-if='pageBranding'
                :branding='pageBranding'
                :failed='brandingFailureIdentity === pageBrandingIdentity'
                @error='pageBrandingImageError'
              )
            .page-header-summary
              p.page-description(v-if='description') {{description}}
            .page-header-control-pair(
              v-if='!printView || (editShortcutsObj.editMenuBar && (editShortcutsObj.editMenuBtn || editShortcutsObj.editMenuExternalBtn))'
            )
              nav.page-header-path(
                v-if='!printView && path !== `home`'
                role='navigation'
                :aria-label='$t(`common:header.breadcrumb`)'
              )
                v-breadcrumbs.breadcrumbs-nav.breadcrumbs-nav--inline.pl-0(
                  :items='breadcrumbs'
                  divider='/'
                )
                  template(v-slot:item='props')
                    v-btn.ma-0(
                      v-if='props.item.href === "/"'
                      :href='props.item.href'
                      size="small"
                      variant="text"
                      :aria-label='$t(`common:header.home`)'
                    )
                      v-icon(aria-hidden='true', size="small") mdi-home
                    v-btn.ma-0(
                      v-else
                      :href='props.item.href'
                      size="small"
                      variant="text"
                      :aria-current='props.item.href === breadcrumbs[breadcrumbs.length - 1].href ? `page` : undefined'
                    ) {{props.item.title}}
              template(v-if='!isPublished')
                .text-body-small.text-warning.page-header-unpublished {{$t('common:page.unpublished')}}
                status-indicator.ml-3(negative, pulse)
              .page-header-offline(v-if='!printView')
                v-tooltip(location="bottom")
                  template(v-slot:activator='{ props }')
                    v-btn.page-offline-control(
                      v-bind='props'
                      icon
                      rounded='lg'
                      :class='`page-offline-control--${offlineControlState}`'
                      :color='offlineControlColor'
                      :loading='offlineActionLoading'
                      :disabled='offlineControlDisabled'
                      :aria-label='offlineControlLabel'
                      :aria-pressed='offlineSelected ? `true` : `false`'
                      :aria-describedby='offlineStatusId'
                      :title='offlineControlTitle'
                      :data-offline-state='offlineControlState'
                      @click='toggleOfflinePage'
                    )
                      v-icon(aria-hidden='true') {{ offlineControlIcon }}
                  span.page-offline-tooltip {{ offlineControlTitle }}
                v-tooltip(location="bottom", v-if='offlineCanRetry')
                  template(v-slot:activator='{ props }')
                    v-btn.page-offline-retry-control(
                      v-bind='props'
                      icon
                      rounded='lg'
                      :loading='offlineActionLoading'
                      :disabled='offlineActionLoading || offlineOwnedOperationId !== null'
                      :aria-label='offlineRetryLabel'
                      :title='offlineRetryLabel'
                      @click='retryOfflinePage'
                    )
                      v-icon(aria-hidden='true') mdi-refresh
                  span.page-offline-tooltip {{ offlineRetryLabel }}
                span.page-offline-status.page-header-offline-status(
                  :id='offlineStatusId'
                  role='status'
                  aria-live='polite'
                  aria-atomic='true'
                  :class='[`page-header-offline-status--${offlineControlState}`, { "page-header-offline-status--quiet": !["stale", "sync-pending", "error", "unavailable", "ineligible"].includes(offlineControlState) }]'
                ) {{ offlineStatusLabel }}
              v-btn.page-focus-control(v-if='!printView && !readerFocus && !talkActive', variant='text', size='small', prepend-icon='mdi-book-open-page-variant-outline', :aria-pressed='readerFocus', @click='toggleReaderFocus') {{ $t('common:page.focusReading') }}
              .page-edit-shortcuts(
                v-if='editShortcutsObj.editMenuBar && (editShortcutsObj.editMenuBtn || editShortcutsObj.editMenuExternalBtn)'
                :class='tocPosition === `right` ? `is-right` : ``'
                )
                  v-btn(
                    v-if='editShortcutsObj.editMenuBtn && (!hasWritePagesPermission || $vuetify.display.smAndDown)'
                    @click='pageEdit'
                    variant="flat"
                    size="small"
                    )
                    v-icon.mr-2(size="small") mdi-pencil
                    span.text-none {{$t(`common:actions.edit`)}}
                  v-btn(
                    v-if='editShortcutsObj.editMenuExternalBtn && editMenuExternalUrl'
                    :href='editMenuExternalUrl'
                    target='_blank'
                    rel='noopener'
                    variant="flat"
                    size="small"
                    )
                    v-icon.mr-2(size="small") {{ editShortcutsObj.editMenuExternalIcon }}
                    span.text-none {{$t(`common:page.editExternal`, { name: editShortcutsObj.editMenuExternalName })}}
      v-container.page-body(fluid)
        v-row
          #page-mobile-tools.page-mobile-tools
          #page-tablet-tools.page-tablet-tools

          v-col.page-col-sd(
            ref='desktopRailCol'
            cols='12'
            :class='[tocPosition === `right` ? `page-col-sd--toc-right` : `page-col-sd--toc-left`, { "page-col-sd--with-toc": tocPosition !== `off`, "page-col-sd--toc-off": tocPosition === `off` }]'
            )
            #page-desktop-rail.page-desktop-rail(ref='desktopRail')

            //- v-card.mb-5
            //-   .pa-5
            //-     .text-label-small.pb-2(:class='$vuetify.theme.current.dark ? `text-yellow-darken-3` : `text-yellow-darken-4`') Rating
            //-     .text-center
            //-       v-rating(
            //-         v-model='rating'
            //-         color='yellow-darken-3'
            //-         bg-color='grey-lighten-1'
            //-         half-increments
            //-         hover
            //-         )
            //-       .text-body-small.text-grey 5 votes


          v-col.page-col-content(
            cols='12'
            :class='[tocPosition === `right` ? `page-col-content--toc-right` : `page-col-content--toc-left`, { "page-col-content--with-toc": tocPosition !== `off`, "page-col-content--toc-off": tocPosition === `off` }]'
            )
            v-menu(
              v-if='hasAnyPagePermissions && editShortcutsObj.editFab && $vuetify.display.smAndDown'
              location='top end'
              transition='scale-transition'
            )
              template(v-slot:activator='{ props }')
                v-btn.page-edit-fab(
                  icon
                  color='primary'
                  v-bind='props'
                  :aria-label='$t(`common:header.pageActions`)'
                )
                  v-icon mdi-pencil
              v-list(density='compact', nav)
                v-list-subheader {{$t('common:header.pageActions')}}
                v-list-item(v-if='hasWritePagesPermission', prepend-icon='mdi-pencil', @click='pageEdit')
                  v-list-item-title {{$t('common:page.editPage')}}
                v-list-item(v-if='hasReadHistoryPermission', prepend-icon='mdi-history', @click='pageHistory')
                  v-list-item-title {{$t('common:header.history')}}
                v-list-item(v-if='hasReadSourcePermission', prepend-icon='mdi-code-tags', @click='pageSource')
                  v-list-item-title {{$t('common:header.viewSource')}}
                v-list-item(v-if='hasWritePagesPermission', prepend-icon='mdi-lightning-bolt', @click='pageConvert')
                  v-list-item-title {{$t('common:header.convert')}}
                v-list-item(v-if='hasWritePagesPermission', prepend-icon='mdi-content-duplicate', @click='pageDuplicate')
                  v-list-item-title {{$t('common:header.duplicate')}}
                v-list-item(v-if='hasManagePagesPermission', prepend-icon='mdi-content-save-move-outline', @click='pageMove')
                  v-list-item-title {{$t('common:header.move')}}
                v-list-item.text-error(v-if='hasDeletePagesPermission', prepend-icon='mdi-trash-can-outline', @click='pageDelete')
                  v-list-item-title {{$t('common:header.delete')}}
            v-alert.page-page-context.mb-5(v-if='!isPublished', color='warning', variant="outlined", icon='mdi-minus-circle', density="compact")
              .text-body-small {{$t('common:page.unpublishedWarning')}}
            site-banner.page-page-context(:banner='siteBanner')
            v-tabs.page-view-tabs(
              v-if='commentsEnabled && commentsPerms.read && !commentsExternal && !printView'
              :model-value='activeView'
              color='primary'
              density='compact'
              aria-label='Page view'
              @update:model-value='selectPageView'
            )
              v-tab#page-view-article-tab(value='article' prepend-icon='mdi-file-document-outline') Article
              v-tab#page-view-talk-tab(value='talk' prepend-icon='mdi-forum-outline') Talk
            article.contents(ref='container', v-show='printView || commentsExternal || activeView === `article`', :id='pageArticleId', role='tabpanel', :aria-labelledby='commentsEnabled && commentsPerms.read && !commentsExternal && !printView ? `page-view-article-tab` : pageTitleId', tabindex='-1', :dir='$vuetify.locale.isRtl ? `rtl` : `ltr`')
              template(v-if='$slots.contents')
                slot(name='contents')
              async-state(
                v-else
                state='empty'
                :title='$t(`common:page.noContent`)'
              )
            section.comments-container#discussion(v-if='commentsEnabled && commentsPerms.read && !printView && (commentsExternal || activeView === `talk`)' role='tabpanel' :aria-labelledby='commentsExternal ? `discussion-title` : `page-view-talk-tab`')
              .comments-header
                .comments-header-icon
                  v-icon(size='20') mdi-comment-text-outline
                div
                  h2#discussion-title.comments-title {{$t('common:comments.title')}}
                  .comments-subtitle {{$t('common:page.discussionSubtitle')}}
              .comments-main
                slot(name='comments')
          #page-mobile-metadata.page-mobile-metadata
          //- No :key here: remounting on breakpoint changes makes deferred
          //- teleports land in reverse order in the shared rail container
          //- (Tags jumped above the utilities). `:to` moves content in order.
          Teleport(
            defer
            :to='isTocMobile ? `#page-mobile-tools` : winWidth < 1280 ? `#page-tablet-tools` : `#page-desktop-rail`'
            :disabled='printView'
          )
            v-card.page-tools-card.mb-4(flat, role='group', :aria-label='$t(`common:page.pageTools`)')
              .page-tools-card__utilities(v-if='!isTocMobile')
                v-toolbar(color='transparent', flat, density='compact')
                  v-menu(location='bottom', min-width='300')
                    template(v-slot:activator='{ props: menuProps }')
                      v-tooltip(location='bottom')
                        template(v-slot:activator='{ props: tooltipProps }')
                          v-btn(icon, rounded='lg', v-bind='mergeProps(menuProps, tooltipProps)', :aria-label='$t(`common:page.share`)'): v-icon mdi-share-variant
                        span {{$t('common:page.share')}}
                    social-sharing(
                      :url='pageUrl'
                      :title='title'
                      :description='description'
                    )
                  v-tooltip(location='bottom', v-if='isAuthenticated')
                    template(v-slot:activator='{ props }')
                      v-btn(
                        icon
                        rounded='lg'
                        v-bind='props'
                        :loading='pageWatchLoading'
                        :disabled='pageWatchLoading || !pageOnlineActionReady || !pageWatchAuthorityReady'
                        :title='!pageOnlineActionReady ? pageOnlineActionUnavailableReason : !pageWatchAuthorityReady ? `Refresh page watch state before changing it.` : undefined'
                        :aria-pressed='pageWatched'
                        @click='togglePageWatch'
                        :aria-label='pageWatched ? $t(`common:page.stopWatchingPage`) : $t(`common:page.watchPage`)'
                      )
                        v-icon {{ pageWatched ? 'mdi-bell-ring' : 'mdi-bell-outline' }}
                    span {{ pageWatched ? $t('common:page.stopWatchingPage') : $t('common:page.watchPage') }}
                  v-menu(v-if='pageWatched', location='bottom', :close-on-content-click='false', min-width='260')
                    template(v-slot:activator='{ props: menuProps }')
                      v-tooltip(location='bottom')
                        template(v-slot:activator='{ props: tooltipProps }')
                          v-btn(
                            icon
                            rounded='lg'
                            v-bind='mergeProps(menuProps, tooltipProps)'
                            :aria-label='$t(`common:page.watchSettings`)'
                          )
                            v-icon mdi-tune
                        span {{$t('common:page.watchSettings')}}
                    v-card
                      v-card-title.text-body-large {{$t('common:page.watchSettings')}}
                      v-card-text
                        v-switch(
                          v-model='pageWatchEmailEnabled'
                          :label='$t(`common:page.emailNotifications`)'
                          color='primary'
                          density='compact'
                          hide-details
                          :disabled='pageWatchLoading || !pageWatchActionReady'
                          :title='!pageWatchActionReady ? pageOnlineActionUnavailableReason || `Refresh page watch state before changing it.` : undefined'
                          @update:model-value='savePageWatchSettings'
                        )
                        v-switch(
                          v-model='pageWatchInAppEnabled'
                          :label='$t(`common:page.inAppNotifications`)'
                          color='primary'
                          density='compact'
                          hide-details
                          :disabled='pageWatchLoading || !pageWatchActionReady'
                          :title='!pageWatchActionReady ? pageOnlineActionUnavailableReason || `Refresh page watch state before changing it.` : undefined'
                          @update:model-value='savePageWatchSettings'
                        )
                  v-tooltip(location='bottom', v-if='isAuthenticated && (hasWritePagesPermission || hasManagePagesPermission || hasAdminPermission)')
                    template(v-slot:activator='{ props }')
                      v-btn(
                        icon
                        rounded='lg'
                        v-bind='props'
                        :disabled='!pageOnlineActionReady'
                        :title='!pageOnlineActionReady ? pageOnlineActionUnavailableReason : undefined'
                        @click='openApprovalWorkflow'
                        :aria-label='$t(`common:page.approvalWorkflow`)'
                        :aria-pressed='Boolean(pageApproval)'
                      )
                        v-icon {{ pageApproval ? 'mdi-check-decagram' : 'mdi-check-decagram-outline' }}
                    span {{$t('common:page.approvalWorkflow')}}
                  v-tooltip(location='bottom', v-if='isAuthenticated && (hasWritePagesPermission || hasManagePagesPermission || hasAdminPermission)')
                    template(v-slot:activator='{ props }')
                      v-btn(
                        icon
                        rounded='lg'
                        v-bind='props'
                        :disabled='!pageProtectionActionReady || protectionInitialLoading'
                        :title='!pageProtectionActionReady ? pageOnlineActionUnavailableReason || `Refresh page protection before changing it.` : undefined'
                        @click='openPageProtection'
                        :aria-label='$t(`common:page.pagePasswordProtection`)'
                        :aria-pressed='pageProtection.protected'
                      )
                        v-icon {{ pageProtection.protected ? 'mdi-lock' : 'mdi-lock-open-outline' }}
                    span {{$t('common:page.pagePasswordProtection')}}
                  v-tooltip(location='bottom')
                    template(v-slot:activator='{ props }')
                      v-btn(icon, rounded='lg', v-bind='props', @click='print', :aria-label='$t(`common:page.printFormat`)')
                        v-icon mdi-printer
                    span {{$t('common:page.printFormat')}}
              //- Mobile mirrors the desktop utilities as an inline icon row so
              //- Share/Print/etc. are one tap away instead of buried in a
              //- second "Page actions" three-dot menu below the header's own.
              .page-tools-card__utilities.page-tools-card__utilities--inline(v-else)
                v-menu(location='top end', min-width='300')
                  template(v-slot:activator='{ props: menuProps }')
                    v-btn(
                      icon
                      rounded='lg'
                      size='small'
                      v-bind='menuProps'
                      :aria-label='$t(`common:page.share`)'
                    ): v-icon mdi-share-variant
                  social-sharing(
                    :url='pageUrl'
                    :title='title'
                    :description='description'
                  )
                v-btn(
                  icon
                  rounded='lg'
                  size='small'
                  v-if='isAuthenticated'
                  :loading='pageWatchLoading'
                  :disabled='pageWatchLoading || !pageOnlineActionReady || !pageWatchAuthorityReady'
                  :title='!pageOnlineActionReady ? pageOnlineActionUnavailableReason : !pageWatchAuthorityReady ? `Refresh page watch state before changing it.` : undefined'
                  :aria-pressed='pageWatched'
                  :aria-label='pageWatched ? $t(`common:page.stopWatchingPage`) : $t(`common:page.watchPage`)'
                  @click='togglePageWatch'
                )
                  v-icon {{ pageWatched ? 'mdi-bell-ring' : 'mdi-bell-outline' }}
                v-menu(v-if='pageWatched', location='top end', :close-on-content-click='false', min-width='260')
                  template(v-slot:activator='{ props: menuProps }')
                    v-btn(
                      icon
                      rounded='lg'
                      size='small'
                      v-bind='menuProps'
                      :aria-label='$t(`common:page.watchSettings`)'
                    )
                      v-icon mdi-tune
                  v-card
                    v-card-title.text-body-large {{$t('common:page.watchSettings')}}
                    v-card-text
                      v-switch(
                        v-model='pageWatchEmailEnabled'
                        :label='$t(`common:page.emailNotifications`)'
                        color='primary'
                        density='compact'
                        hide-details
                        :disabled='pageWatchLoading || !pageWatchActionReady'
                        :title='!pageWatchActionReady ? pageOnlineActionUnavailableReason || `Refresh page watch state before changing it.` : undefined'
                        @update:model-value='savePageWatchSettings'
                      )
                      v-switch(
                        v-model='pageWatchInAppEnabled'
                        :label='$t(`common:page.inAppNotifications`)'
                        color='primary'
                        density='compact'
                        hide-details
                        :disabled='pageWatchLoading || !pageWatchActionReady'
                        :title='!pageWatchActionReady ? pageOnlineActionUnavailableReason || `Refresh page watch state before changing it.` : undefined'
                        @update:model-value='savePageWatchSettings'
                      )
                v-btn(
                  icon
                  rounded='lg'
                  size='small'
                  v-if='isAuthenticated && (hasWritePagesPermission || hasManagePagesPermission || hasAdminPermission)'
                  :disabled='!pageOnlineActionReady'
                  :title='!pageOnlineActionReady ? pageOnlineActionUnavailableReason : undefined'
                  @click='openApprovalWorkflow'
                  :aria-label='$t(`common:page.approvalWorkflow`)'
                  :aria-pressed='Boolean(pageApproval)'
                )
                  v-icon {{ pageApproval ? 'mdi-check-decagram' : 'mdi-check-decagram-outline' }}
                v-btn(
                  icon
                  rounded='lg'
                  size='small'
                  v-if='isAuthenticated && (hasWritePagesPermission || hasManagePagesPermission || hasAdminPermission)'
                  :disabled='!pageProtectionActionReady || protectionInitialLoading'
                  :title='!pageProtectionActionReady ? pageOnlineActionUnavailableReason || `Refresh page protection before changing it.` : undefined'
                  @click='openPageProtection'
                  :aria-label='$t(`common:page.pagePasswordProtection`)'
                  :aria-pressed='pageProtection.protected'
                )
                  v-icon {{ pageProtection.protected ? 'mdi-lock' : 'mdi-lock-open-outline' }}
                v-btn(
                  icon
                  rounded='lg'
                  size='small'
                  v-bind='undefined'
                  @click='print'
                  :aria-label='$t(`common:page.printFormat`)'
                )
                  v-icon mdi-printer
              v-divider.page-tools-card__divider(v-if='updatedAt || hasAuthor || canViewHistory')
              .page-tools-card__provenance(v-if='updatedAt || hasAuthor || canViewHistory')
                .page-document-provenance
                  .page-document-row.page-document-row--date(v-if='updatedAt')
                    time(:datetime='updatedAt', :title='accessibleUpdatedAt') {{ $t('common:page.updatedAt', { date: formattedUpdatedAt, interpolation: { escapeValue: false } }) }}
                  .page-document-row.page-document-row--author(v-if='hasAuthor')
                    span.page-document-author
                      | {{ $t('common:page.byAuthor', { author: '' }) }}
                      bdi.page-provenance-author {{ authorName }}
                a.page-tools-history-link(
                  v-if='canViewHistory'
                  :href='pageHistoryUrl'
                  @click='historyLinkClicked($event)'
                  :aria-label='$t(`common:page.viewHistory`)'
                )
                  span {{$t('common:page.view')}}
                  svg.page-tools-history-link__icon(viewBox='0 0 24 24', aria-hidden='true')
                    path(fill='currentColor', d='M9 4v1.38c-.83-.33-1.72-.5-2.61-.5-1.79 0-3.58.68-4.95 2.05l3.33 3.33h1.11v1.11c.86.86 1.98 1.31 3.11 1.36V15H6v3c0 1.1.9 2 2 2h10c1.66 0 3-1.34 3-3V4zm-1.11 6.41V8.26H5.61L4.57 7.22a5.07 5.07 0 0 1 1.82-.34c1.34 0 2.59.52 3.54 1.46l1.41 1.41-.2.2c-.51.51-1.19.8-1.92.8-.47 0-.93-.12-1.33-.34M19 17c0 .55-.45 1-1 1s-1-.45-1-1v-2h-6v-2.59c.57-.23 1.1-.57 1.56-1.03l.2-.2L15.59 14H17v-1.41l-6-5.97V6h8z')
            v-card.page-toc-card.mb-4(v-if='tocPosition !== `off` && !talkActive', tag='nav', :aria-label='$t(`common:page.toc`)')
              v-btn.page-toc-toggle.text-none(
                variant='text'
                block
                :aria-expanded='tocDisclosureExpanded'
                aria-controls='page-toc-content'
                @click='toggleToc'
              )
                span.page-toc-toggle-label.text-label-small {{ isTocMobile ? $t(`common:page.onThisPage`) : $t(`common:page.toc`) }}
                v-icon(size='small', aria-hidden='true') {{ tocDisclosureExpanded ? `mdi-chevron-up` : `mdi-chevron-down` }}
              .text-label-small.page-toc-heading
                span {{$t('common:page.toc')}}
                span.page-toc-count(aria-hidden='true') {{ tocFlattened.length }}
                span.d-sr-only {{ $t('common:page.sectionsCount', { count: tocFlattened.length }) }}

              div#page-toc-content.page-toc-content(
                v-show='tocDisclosureExpanded'
              )
                v-text-field.page-toc-filter(
                  v-if='tocFlattened.length > 10'
                  v-model='tocQuery'
                  :label='$t(`common:page.findSection`)'
                  prepend-inner-icon='mdi-magnify'
                  density='compact'
                  variant='outlined'
                  hide-details
                  clearable
                  @keydown.esc.stop='tocQuery = ``'
                )
                .page-toc-filter-empty(v-if='tocQuery && !tocTreeVisible.length', role='status') {{$t('common:page.noMatchingSections')}}
                .page-toc-tree-wrap(v-else-if='tocTreeVisible.length')
                  page-toc-tree(
                    :nodes='tocTreeVisible'
                    :active-anchor='activeAnchor'
                    :is-expanded='isBranchExpanded'
                    :has-active-descendant='hasActiveDescendant'
                    :on-toggle='toggleBranch'
                    :on-navigate='tocLinkClicked'
                    :is-rtl='$vuetify.locale.isRtl'
                    :t='$t'
                  )
                .page-toc-empty(v-else)
                  v-icon(aria-hidden='true', size='small') mdi-format-list-bulleted
                  span.text-body-small {{$t('common:page.noSections')}}
                  span.text-body-small {{$t('common:page.noSections')}}

          //- Keep this keyless too so both teleports move as a pair and keep
          //- their source order (shortcuts/provenance/toc before tags/comments).
          Teleport(
            defer
            :to='isTocMobile ? `#page-mobile-metadata` : winWidth < 1280 ? `#page-tablet-tools` : `#page-desktop-rail`'
            :disabled='printView'
          )
            v-card.page-tags-card.mb-5(v-if='tags.length > 0')
              .pa-5
                .text-label-small.pb-2.text-secondary {{$t('common:page.tags')}}
                v-chip.page-tag.wiki-tag-color.mr-1.mb-1(
                  label
                  variant='tonal'
                  :data-tag-color='tagColor(tag.tag)'
                  v-for='tag in tags'
                  :href='`/t/` + tag.tag'
                  :key='`tag-` + tag.tag'
                  )
                  v-icon(start, size="small") mdi-tag
                  span {{tag.title}}
                v-chip.page-tags-all.wiki-tag-color.mr-1.mb-1(
                  label
                  variant='tonal'
                  data-tag-color='neutral'
                  :href='`/t/` + tags.map(t => t.tag).join(`/`)'
                  :aria-label='$t(`common:page.tagsMatching`)'
                  )
                  v-icon(size='20') mdi-tag-multiple
            v-card.page-comments-card.mb-5(v-if='commentsEnabled && commentsPerms.read')
              .pa-5
                .text-label-small.pb-2.d-flex.align-center.text-secondary
                  span {{$t('common:comments.sdTitle')}}
                  //- v-spacer
                  //- v-chip.text-center.text-white(
                  //-   v-if='!commentsExternal'
                  //-   label
                  //-   size='x-small'
                  //-   :color='$vuetify.theme.current.dark ? `blue-grey-darken-3` : `blue-grey-darken-2`'
                  //-   style='min-width: 50px; justify-content: center;'
                  //-   )
                  //-   span {{commentsCount}}
                .d-flex
                  v-btn.text-none(
                    @click='goToComments()'
                    color='secondary'
                    variant="outlined"
                    style='flex: 1 1 100%;'
                    size="small"
                    )
                    span {{$t('common:comments.viewDiscussion')}}
                  v-tooltip(location="right", v-if='commentsPerms.write')
                    template(v-slot:activator='{ props }')
                      v-btn.ml-2(
                        @click='goToComments(true)'
                        v-bind='props'
                        variant="outlined"
                        size="small"
                        color='secondary'
                        :aria-label='$t(`common:comments.newComment`)'
                        )
                        v-icon(size="small") mdi-comment-plus
                    span {{$t('common:comments.newComment')}}

    nav-footer
    notify
    search-results
    v-dialog(
      v-model='protectionDialog'
      :fullscreen='$vuetify.display.smAndDown'
      max-width='560'
      aria-labelledby='page-protection-title'
    )
      v-card
        v-toolbar(color='surface', class='border-b', flat)
          v-toolbar-title.text-title-medium#page-protection-title(tag='h2') {{$t('common:page.pagePasswordProtection')}}
          v-spacer
          v-btn(icon, @click='protectionDialog = false', :aria-label='$t(`common:page.closePagePasswordProtection`)')
            v-icon mdi-close
        v-progress-linear(v-if='protectionLoading || protectionInitialLoading', indeterminate, color='primary')
        async-state(
          v-if='protectionInitialLoading'
          state='loading'
          :title='$t(`common:page.loadingPageProtection`)'
        )
        async-state(
          v-else-if='protectionError'
          state='error'
          :title='$t(`common:page.pageProtectionLoadError`)'
          :message='protectionError'
          :retry-label='$t(`common:page.tryAgain`)'
          @retry='loadPageProtection'
        )
        template(v-else)
          v-card-text.pa-5
            v-alert.mb-4(
              :type='pageProtection.protected ? `info` : `warning`'
              variant='tonal'
            )
              template(v-if='pageProtection.protected') {{$t('common:page.pageProtectionActive')}}
              template(v-else) {{$t('common:page.pageProtectionInactive')}}
            p.text-body-medium.text-medium-emphasis.mb-4
              | {{$t('common:page.pageProtectionDetails')}}
            v-text-field(
              v-model='pageProtectionPassword'
              type='password'
              :label='$t(`common:page.newPagePassword`)'
              autocomplete='new-password'
              minlength='12'
              maxlength='1024'
              :hint='$t(`common:page.newPagePasswordHint`)'
              persistent-hint
            )
          v-divider
          v-card-actions.flex-wrap.pa-4
            v-btn(
              color='primary'
              :disabled='!pageProtectionActionReady || pageProtectionPassword.length < 12'
              :title='!pageProtectionActionReady ? pageOnlineActionUnavailableReason || `Refresh page protection before changing it.` : undefined'
              :loading='protectionLoading'
              @click='savePageProtection'
            ) {{ pageProtection.protected ? $t('common:page.rotatePassword') : $t('common:page.enableProtection') }}
            v-btn(
              v-if='pageProtection.protected'
              color='error'
              variant='text'
              :disabled='protectionLoading || !pageProtectionActionReady'
              :title='!pageProtectionActionReady ? pageOnlineActionUnavailableReason || `Refresh page protection before changing it.` : undefined'
              @click='removePageProtection'
            ) {{$t('common:page.removeProtection')}}
            v-spacer
            v-btn(@click='protectionDialog = false') {{$t('common:actions.close')}}
    v-dialog(
      v-model='approvalDialog'
      :fullscreen='$vuetify.display.smAndDown'
      max-width='680'
      scrollable
      aria-labelledby='page-approval-title'
    )
      v-card
        v-toolbar(color='surface', class='border-b', flat)
          v-toolbar-title.text-title-medium#page-approval-title(tag='h2') {{$t('common:page.approvalWorkflow')}}
          v-spacer
          v-btn(icon, @click='approvalDialog = false', :aria-label='$t(`common:page.closeApprovalWorkflow`)')
            v-icon mdi-close
        v-progress-linear(v-if='approvalLoading || approvalInitialLoading', indeterminate, color='primary')
        async-state(
          v-if='approvalInitialLoading'
          state='loading'
          :title='$t(`common:page.loadingApprovalWorkflow`)'
        )
        async-state(
          v-else-if='approvalError'
          state='error'
          :title='$t(`common:page.approvalWorkflowLoadError`)'
          :message='approvalError'
          :retry-label='$t(`common:page.tryAgain`)'
          @retry='loadPageApproval'
        )
        template(v-else)
          v-card-text.pa-5
            template(v-if='pageApproval')
              .d-flex.align-center.flex-wrap.ga-2.mb-4
                v-chip(color='primary', variant='tonal') {{ approvalStatusLabel(pageApproval.status) }}
                v-chip(v-if='pageApproval.stale', color='warning', variant='tonal') {{$t('common:page.staleRevision')}}
                span.text-medium-emphasis {{ $t('common:page.revision', { id: pageApproval.revisionId }) }}
              v-alert.mb-4(
                v-if='pageApproval.stale'
                type='warning'
                variant='tonal'
              ) {{$t('common:page.pageChangedAfterSubmission')}}
              v-text-field(
                v-if='pageApproval.canReview'
                v-model.number='approvalAssigneeId'
                type='number'
                min='1'
                :label='$t(`common:page.reviewerUserId`)'
                :hint='$t(`common:page.keepCurrentReviewerHint`)'
                persistent-hint
              )
              v-textarea(
                v-model='approvalComment'
                :label='$t(`common:page.reviewComment`)'
                rows='3'
                auto-grow
                :hint='$t(`common:page.reviewCommentHint`)'
                persistent-hint
              )
              v-card.mt-5(variant='outlined')
                v-card-title.text-body-large {{$t('common:page.reviewHistory')}}
                v-list(lines='two', density='compact')
                  v-list-item(v-for='transition in pageApproval.transitions', :key='transition.id')
                    v-list-item-title {{ approvalStatusLabel(transition.toStatus) }}
                    v-list-item-subtitle {{ $t('common:page.reviewer', { id: transition.actorId }) }} · {{ new Date(transition.createdAt).toLocaleString() }}
                    v-list-item-subtitle(v-if='transition.comment') {{ transition.comment }}
            template(v-else)
              p.text-body-large.mb-4 {{$t('common:page.submitForReviewDescription')}}
              v-text-field(
                v-model.number='approvalAssigneeId'
                type='number'
                min='1'
                :label='$t(`common:page.reviewerUserIdOptional`)'
              )
              v-textarea(v-model='approvalComment', :label='$t(`common:page.submissionNote`)', rows='3', auto-grow)
            v-alert(
              v-if='!approvalActionReady && !approvalInitialLoading'
              type='warning'
              variant='tonal'
              role='status'
              class='mt-4'
            )
              span {{ approvalActionUnavailableReason }}
              v-btn(
                size='small'
                variant='text'
                class='ml-2'
                :loading='approvalInitialLoading'
                @click='loadPageApproval'
              ) {{$t('common:page.tryAgain')}}
          v-divider
          v-card-actions.flex-wrap.pa-4
            v-btn(
              v-if='hasWritePagesPermission && (!pageApproval || [`rejected`, `cancelled`, `published`].includes(pageApproval.status))'
              color='primary'
              :loading='approvalLoading'
              :disabled='approvalLoading || !approvalActionReady'
              :title='!approvalActionReady ? approvalActionUnavailableReason : undefined'
              @click='submitPageApproval'
            ) {{ pageApproval ? $t('common:page.submitNewRevision') : $t('common:page.submitForApproval') }}
            template(v-if='pageApproval')
              v-btn(v-if='pageApproval.status === `submitted` && pageApproval.canReview', color='success', :disabled='approvalLoading || !approvalActionReady || pageApproval.stale', :title='!approvalActionReady ? approvalActionUnavailableReason : undefined', @click='transitionPageApproval(`approve`)') {{$t('common:page.approve')}}
              v-btn(v-if='pageApproval.status === `submitted` && pageApproval.canReview', color='warning', :disabled='approvalLoading || !approvalActionReady', :title='!approvalActionReady ? approvalActionUnavailableReason : undefined', @click='transitionPageApproval(`request-changes`)') {{$t('common:page.requestChanges')}}
              v-btn(v-if='pageApproval.status === `submitted` && pageApproval.canReview', color='error', :disabled='approvalLoading || !approvalActionReady', :title='!approvalActionReady ? approvalActionUnavailableReason : undefined', @click='transitionPageApproval(`reject`)') {{$t('common:page.reject')}}
              v-btn(v-if='pageApproval.status === `changes-requested` && pageApproval.canSubmitter && hasWritePagesPermission', color='primary', :disabled='approvalLoading || !approvalActionReady', :title='!approvalActionReady ? approvalActionUnavailableReason : undefined', @click='transitionPageApproval(`resubmit`)') {{$t('common:page.resubmit')}}
              v-btn(v-if='pageApproval.status === `approved` && pageApproval.canReview', color='success', :disabled='approvalLoading || !approvalActionReady || pageApproval.stale', :title='!approvalActionReady ? approvalActionUnavailableReason : undefined', @click='transitionPageApproval(`publish`)') {{$t('common:page.publishApprovedRevision')}}
              v-btn(v-if='pageApproval.canReview && [`submitted`, `approved`, `changes-requested`].includes(pageApproval.status)', :disabled='approvalLoading || !approvalActionReady', :title='!approvalActionReady ? approvalActionUnavailableReason : undefined', @click='transitionPageApproval(`reassign`)') {{$t('common:page.reassign')}}
              v-btn(v-if='pageApproval.canSubmitter && [`submitted`, `approved`, `changes-requested`].includes(pageApproval.status)', color='error', variant='text', :disabled='approvalLoading || !approvalActionReady', :title='!approvalActionReady ? approvalActionUnavailableReason : undefined', @click='transitionPageApproval(`cancel`)') {{$t('common:page.cancelRequest')}}
            v-spacer
            v-btn(@click='approvalDialog = false') {{$t('common:actions.close')}}
    v-dialog(v-model='offlineUnlockOpen', max-width='480', :persistent='offlineUnlockBusy')
      v-card
        v-card-title Unlock private offline pages
        v-card-text
          p Enter the secret saved when private offline reading was set up on this device.
          v-text-field(
            v-model='offlineUnlockSecret'
            label='Unlock secret'
            type='password'
            autocomplete='off'
            spellcheck='false'
            :disabled='offlineUnlockBusy'
            :error-messages='offlineUnlockError ? [offlineUnlockError] : []'
            @keyup.enter='unlockPrivateOfflinePage'
          )
        v-card-actions
          v-spacer
          v-btn(variant='text', :disabled='offlineUnlockBusy', @click='closeOfflineUnlock') Cancel
          v-btn(
            color='primary'
            variant='tonal'
            :loading='offlineUnlockBusy'
            :disabled='offlineUnlockBusy || !offlineUnlockSecret'
            @click='unlockPrivateOfflinePage'
          ) Unlock
    v-fab-transition
      v-btn.page-return-top(
        v-if='upBtnShown'
        icon
        position='fixed'
        color='primary'
        @click='returnToTop'
        :aria-label='$t(`common:actions.returnToTop`)'
        )
        v-icon mdi-arrow-up
</template>

<script lang='ts'>
import ClipboardJS from 'clipboard'
import i18next from 'i18next'
import _ from 'lodash'
import type { Environment as PrismEnvironment } from 'prismjs'
import { defineComponent, h, inject, markRaw, mergeProps, type PropType, shallowRef, type VNode } from 'vue'
import { useGoTo } from 'vuetify'
import AsyncState from '@/components/common/async-state.vue'
import PageBrandingMark from '@/components/common/page-branding-mark.vue'
import SiteBanner from '@/components/common/site-banner.vue'
import StatusIndicator from '@/components/common/status-indicator.vue'
import {
  buildOutlineTree,
  filterOutlineTree,
  getAncestorAnchors,
  getInitialExpandedAnchors,
  getSearchExpandedAnchors,
  isBranchEffectivelyExpanded,
  type OutlineNode,
  outlineSublistId,
  type PageOutlineTracker, 
  trackPageOutline
} from '@/helpers/page-outline'
import { wikiStore } from '@/store/index.ts'
import { externalSourceUrl } from '../../../../shared/general-policy.ts'
import type { OfflinePagePolicyRecord, OfflinePolicySnapshot, OfflineSnapshotCorpus, OfflineSnapshotRecord, OfflineSnapshotSelector } from '../../../../shared/offline.ts'
import type { PageBrandingView } from '../../../../shared/page-branding.ts'
import { tagColorBucket } from '../../../../shared/tag-colors.ts'
import { decodeBase64Json } from '../../../helpers/base64'
import { hydrateContentExtensions, revealContentExtensionTarget } from '../../../helpers/content-extension-runtime'
import {
  MERMAID_MAX_TEXT_SIZE,
  renderMermaidSvg,
  selectMermaidRenderHosts
} from '../../../helpers/content-extension-runtimes/mermaid.ts'
import {
  type OfflinePageAccessState, 
  offlineIneligibilityIsQuiet,
  offlinePrivateAccessStatus,
  offlineSavedPageState,
  offlineSavedPageStatus,
  offlineSelectionSources
} from '../../../helpers/offline-page-status.ts'
import {
  currentOfflineReadingHandle,
  decodeOfflineReadingSecret,
  isCurrentOfflineReadingHandle,
  unlockOfflineReading
} from '../../../helpers/offline-session.ts'
import {
  type OfflineStorage, 
  openOfflineStorage,
  subscribeOfflineStorageChanges
} from '../../../helpers/offline-storage.ts'
import {
  createOfflineSyncUnavailableResult,
  OFFLINE_SYNC_COORDINATOR_KEY,
  type OfflineSyncResult,
  type OfflineSyncService
} from '../../../helpers/offline-sync.ts'
import {
  emitPageConvert,
  emitPageDelete,
  emitPageDuplicate,
  emitPageEdit,
  emitPageHistory,
  emitPageMove,
  emitPageSource
} from '../../../helpers/page-action-events'
import {
  normalizePageBrandingView,
  pageBrandingIdentity,
  resolvePageBrandingStyle
} from '../../../helpers/page-branding'
import { pwaState } from '../../../helpers/pwa.ts'
import { getErrorMessage, pushGraphError, showNotification } from '../../../helpers/root-ui-store'
import {
  type FlattenedTableOfContentsNode,
  normalizeTableOfContents,
  type TableOfContentsNode
} from '../../../helpers/table-of-contents'
import Prism from '../../../libs/prism/setup'
import boot from '../../../modules/boot.ts'
import { useSiteNotificationsStore } from '../../../store/site-notifications.ts'
import NavSidebar, { type SidebarItem } from './nav-sidebar.vue'

/* global siteLangs */

type Breadcrumb = {
  href: string
  title: string
}

const offlineSyncResultDetail = (result: OfflineSyncResult, fallback: string): string => {
  const detail = result.outcome === 'unavailable'
    ? result.error
    : result.error ?? result.diagnostics?.lastError
  const normalized = typeof detail === 'string' ? detail.trim() : ''
  return (normalized || fallback).slice(0, 512)
}

const offlineSyncAggregateNotice = (result: OfflineSyncResult): string | null => {
  if (result.outcome !== 'error' && result.outcome !== 'unavailable') return null
  const detail = offlineSyncResultDetail(result, 'Offline synchronization reported an issue.')
  return `Other saved pages need attention: ${detail}`.slice(0, 512)
}

const offlineSyncFailureNotice = (detail: string): string =>
  `Background offline synchronization reported an issue: ${(detail.trim() || 'The current page state was refreshed.').slice(0, 512)}`.slice(0, 512)

type PageTag = {
  tag: string
  title: string | null
}



type ApprovalTransition = {
  id: string
  fromStatus: string | null
  toStatus: string
  actorId: number
  comment: string | null
  createdAt: string | number
}

type PageApproval = {
  id: string
  pageId: number
  status: 'submitted' | 'approved' | 'changes-requested' | 'rejected' | 'cancelled' | 'published'
  submitterId: number
  assigneeId: number | null
  revisionId: number
  stale: boolean
  canReview: boolean
  canSubmitter: boolean
  transitions: ApprovalTransition[]
  title?: string
  localeCode?: string
  visibility?: 'public' | 'private'
}

type PageProtection = {
  protected: boolean
  version: number
  updatedBy: number | null
  updatedAt: string | null
}


type OfflinePageState = 'checking' | 'eligible' | 'downloading' | 'saved' | 'expiring' | 'stale' | 'sync-pending' | 'removing' | 'ineligible' | 'error' | 'unavailable' | OfflinePageAccessState
const widenOfflinePageState = (state: OfflinePageState): OfflinePageState => state
type OfflineAccountAwareService = OfflineSyncService & {
  readOfflinePolicy?: () => Promise<OfflinePolicySnapshot>
  readSnapshotCorpus?: (selector?: OfflineSnapshotSelector) => Promise<OfflineSnapshotCorpus>
  setManualOfflineIntent?: (selector: OfflineSnapshotSelector, selected: boolean) => Promise<OfflinePagePolicyRecord>
  removeOfflinePage?: (selector: OfflineSnapshotSelector) => Promise<OfflinePagePolicyRecord>
  recordEligibleReaderVisit?: (selector: OfflineSnapshotSelector) => Promise<OfflinePagePolicyRecord>
}
function decodePageAnchor (anchor: string): string {
  try {
    return decodeURIComponent(anchor)
  } catch {
    return anchor
  }
}

Prism.plugins.toolbar.registerButton('copy-to-clipboard', (env: PrismEnvironment) => {
  let linkCopy = document.createElement('button')
  linkCopy.textContent = i18next.t('page.copyCode', { ns: 'common' })
  linkCopy.setAttribute('aria-label', i18next.t('page.copyCode', { ns: 'common' }))

  const clip = new ClipboardJS(linkCopy, {
    text: () => env.code || ''
  })

  // The whole block acknowledges the copy with the same attractor sweep the
  // inline backtick chips use on their click-to-copy: a single soft accent
  // band rides the block boundary. Fires on the click itself, not on the
  // clipboard outcome.
  linkCopy.addEventListener('click', () => {
    const toolbar = linkCopy.closest<HTMLElement>('.code-toolbar')
    if (!toolbar) return
    // Flash the block's own pre (or the framed card) so the sweep stays
    // clipped inside the panel instead of straying past its start edge.
    const block = toolbar.closest<HTMLElement>('.codeblock-framed') ?? toolbar.querySelector<HTMLElement>('pre')
    if (!block) return
    flashCodeBlockCopy(block)
  })

  clip.on('success', () => {
    linkCopy.textContent = i18next.t('page.codeCopied', { ns: 'common' })
    linkCopy.dataset.copyState = 'success'
    resetClipboardText()
  })
  clip.on('error', () => {
    linkCopy.textContent = i18next.t('page.copyCodeShortcut', { ns: 'common' })
    linkCopy.dataset.copyState = 'error'
    resetClipboardText()
  })

  return linkCopy

  function resetClipboardText() {
    setTimeout(() => {
      linkCopy.textContent = i18next.t('page.copyCode', { ns: 'common' })
      linkCopy.setAttribute('aria-label', i18next.t('page.copyCode', { ns: 'common' }))
      linkCopy.removeAttribute('data-copy-state')
    }, 5000)
  }
})

// ---------------------------------------------------------------------------
// Code-block copy button shimmer scheduler
//
// The attractor sweep is JS-scheduled so it can react to the reader: the
// first time a code block is hovered the sweep fires immediately, then the
// ambient randomized cadence resumes after a short pause. Never-hovered
// blocks keep the ambient cadence from mount.
// ---------------------------------------------------------------------------

const COPY_SHIMMER_SWEEP_MS = 1_900
const COPY_SHIMMER_RESUME_DELAY_MS = 3_000
const COPY_SHIMMER_AMBIENT_MIN_MS = 9_000
const COPY_SHIMMER_AMBIENT_MAX_MS = 18_000

const copyShimmerStates = new WeakMap<HTMLElement, { timer?: number; everHovered: boolean }>()
const copyShimmerWired = new WeakSet<HTMLElement>()

const copyShimmerAmbientDelay = (): number => COPY_SHIMMER_AMBIENT_MIN_MS + Math.floor(Math.random() * (COPY_SHIMMER_AMBIENT_MAX_MS - COPY_SHIMMER_AMBIENT_MIN_MS))

function triggerCopyShimmerSweep (toolbar: HTMLElement): void {
  const button = toolbar.querySelector<HTMLButtonElement>('.toolbar button')
  if (!button) return
  button.classList.remove('wiki-copy-shimmer-run')
  // Force a style flush so a sweep can restart from its beginning even if
  // one was already mid-flight.
  void button.offsetWidth
  button.classList.add('wiki-copy-shimmer-run')
  button.addEventListener('animationend', () => {
    button.classList.remove('wiki-copy-shimmer-run')
  }, { once: true })
}

function scheduleCopyShimmer (toolbar: HTMLElement, delayMs: number): void {
  const state = copyShimmerStates.get(toolbar)
  if (!state) return
  if (state.timer !== undefined) clearTimeout(state.timer)
  state.timer = window.setTimeout(() => {
    const fresh = copyShimmerStates.get(toolbar)
    if (!fresh || !toolbar.isConnected) return
    triggerCopyShimmerSweep(toolbar)
    scheduleCopyShimmer(toolbar, copyShimmerAmbientDelay())
  }, delayMs)
}

function handleCopyToolbarFirstHover (toolbar: HTMLElement): void {
  let state = copyShimmerStates.get(toolbar)
  if (!state) {
    state = { everHovered: false }
    copyShimmerStates.set(toolbar, state)
  }
  state.everHovered = true
  // Drop any pending ambient sweep: the hover sweep fires now and the
  // randomized cadence only resumes after the sweep plus a short pause.
  if (state.timer !== undefined) {
    clearTimeout(state.timer)
    state.timer = undefined
  }
  triggerCopyShimmerSweep(toolbar)
  // The randomized cadence resumes only after the sweep has completed and
  // the deliberate post-hover pause has elapsed.
  scheduleCopyShimmer(toolbar, COPY_SHIMMER_SWEEP_MS + COPY_SHIMMER_RESUME_DELAY_MS + copyShimmerAmbientDelay())
}

// Single whole-block sweep acknowledging a code-block copy click. The band
// rides the block's boundary (::after on the block container) so every line
// of code lights up together, matching the inline chip's click sweep.
const BLOCK_COPY_FLASH_CLASS = 'wiki-code-copy-flash-run'
const BLOCK_COPY_SWEEP_NAME = 'wiki-code-block-copy-sweep'

function flashCodeBlockCopy (block: HTMLElement): void {
  block.classList.remove(BLOCK_COPY_FLASH_CLASS)
  // Force a style flush so the sweep restarts from its beginning even if a
  // previous one was still mid-flight.
  void block.offsetWidth
  block.classList.add(BLOCK_COPY_FLASH_CLASS)
  block.addEventListener('animationend', (event: Event) => {
    // Only our own band's animation ends on the block; the toolbar button's
    // shimmer sweep bubbles its animationend through the same subtree.
    const anim = event as AnimationEvent
    if (anim.animationName === BLOCK_COPY_SWEEP_NAME) {
      block.classList.remove(BLOCK_COPY_FLASH_CLASS)
    }
  }, { once: true })
}

function setupCodeCopyShimmer (container: HTMLElement): void {
  for (const toolbar of container.querySelectorAll<HTMLElement>('.code-toolbar')) {
    if (!copyShimmerStates.has(toolbar)) {
      copyShimmerStates.set(toolbar, { everHovered: false })
      scheduleCopyShimmer(toolbar, copyShimmerAmbientDelay())
    }
  }
  if (copyShimmerWired.has(container)) return
  copyShimmerWired.add(container)
  container.addEventListener('mouseover', (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const toolbar = target.closest<HTMLElement>('.code-toolbar')
    if (!toolbar || !container.contains(toolbar)) return
    // Only genuine entries into the block, not movement between its children.
    if (event.relatedTarget instanceof Node && toolbar.contains(event.relatedTarget)) return
    const state = copyShimmerStates.get(toolbar)
    if (!state || state.everHovered) return
    handleCopyToolbarFirstHover(toolbar)
  })
}

// ---------------------------------------------------------------------------
// Inline-code copy + click-acknowledgment sweep
//
// Backtick-enclosed chips (`:not(pre) > code`) become click-to-copy: clicking
// anywhere on the chip copies its text, with a short success/error tint plus
// the sweep as the interaction acknowledgment. The sweep fires only on the
// click that performs the copy — never on a timer, never on hover.
// ---------------------------------------------------------------------------

const INLINE_COPY_FEEDBACK_MS = 1_400

const inlineCopyWired = new WeakSet<HTMLElement>()

function isStandaloneInlineCode (element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement && !element.closest('pre') && !element.closest('.code-toolbar')
}

function triggerInlineShimmerSweep (codeEl: HTMLElement): void {
  codeEl.classList.remove('wiki-inline-shimmer-run')
  // Force a style flush so a sweep can restart from its beginning even if
  // one was already mid-flight.
  void codeEl.offsetWidth
  codeEl.classList.add('wiki-inline-shimmer-run')
  codeEl.addEventListener('animationend', () => {
    codeEl.classList.remove('wiki-inline-shimmer-run')
  }, { once: true })
}

function setInlineCopyFeedback (codeEl: HTMLElement, state: 'success' | 'error'): void {
  codeEl.dataset.inlineCopyState = state
  window.setTimeout(() => {
    if (codeEl.isConnected && codeEl.dataset.inlineCopyState === state) delete codeEl.dataset.inlineCopyState
  }, INLINE_COPY_FEEDBACK_MS)
}

async function copyInlineCodeText (codeEl: HTMLElement): Promise<boolean> {
  const text = codeEl.textContent || ''
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through to the legacy path */ }
  // Legacy fallback for non-secure or permission-denied contexts.
  const helper = codeEl.ownerDocument.createElement('textarea')
  helper.value = text
  helper.setAttribute('readonly', '')
  helper.style.position = 'fixed'
  helper.style.opacity = '0'
  document.body.appendChild(helper)
  helper.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch { copied = false }
  helper.remove()
  return copied
}

function setupInlineCodeCopy (container: HTMLElement): void {
  for (const codeEl of container.querySelectorAll<HTMLElement>('code')) {
    if (!isStandaloneInlineCode(codeEl)) continue
    if (!codeEl.hasAttribute('title')) codeEl.setAttribute('title', i18next.t('page.copyCode', { ns: 'common' }))
  }
  if (inlineCopyWired.has(container)) return
  inlineCopyWired.add(container)
  container.addEventListener('click', (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const codeEl = target.closest<HTMLElement>('code')
    if (!isStandaloneInlineCode(codeEl) || !container.contains(codeEl)) return
    void copyInlineCodeText(codeEl).then(copied => {
      setInlineCopyFeedback(codeEl, copied ? 'success' : 'error')
      // The attractor acknowledges the interaction with its own sweep.
      triggerInlineShimmerSweep(codeEl)
    })
  })
}

const PAGE_MERMAID_ERROR_CLASS = 'content-extension-diagram__error'
const PAGE_MERMAID_ERROR_MESSAGE = 'Diagram could not be rendered locally. Its source remains available below.'
const PAGE_MERMAID_LIMIT_NOTICE_CLASS = 'content-extension-diagram__limit-notice'
const PAGE_MERMAID_LIMIT_NOTICE_MESSAGE = 'Additional diagrams remain available as source because automatic rendering is limited.'

const pageMermaidSource = (host: HTMLElement): string | null => {
  if (host.matches('.mermaid')) return host.textContent ?? ''
  return host.querySelector<HTMLElement>('.content-extension-diagram__source code')?.textContent ?? null
}

const showPageMermaidLimitNotice = (container: HTMLElement): void => {
  if (container.querySelector(`.${PAGE_MERMAID_LIMIT_NOTICE_CLASS}`)) return
  const notice = container.ownerDocument.createElement('p')
  notice.className = PAGE_MERMAID_LIMIT_NOTICE_CLASS
  notice.textContent = PAGE_MERMAID_LIMIT_NOTICE_MESSAGE
  container.append(notice)
}

const renderPageMermaidDiagrams = async (
  container: HTMLElement,
  theme: 'default' | 'dark',
  signal: AbortSignal,
  isCurrent: () => boolean,
  mermaidHosts: ReadonlySet<HTMLElement>
): Promise<void> => {
  const diagrams = [...container.querySelectorAll<HTMLElement>('.mermaid')]
  const allHosts = [...container.querySelectorAll<HTMLElement>('.mermaid, .content-extension--diagram')]
  const excessHosts = allHosts.filter(host => {
    const source = pageMermaidSource(host)
    return source !== null && !mermaidHosts.has(host)
  })
  for (const host of excessHosts) host.setAttribute('aria-busy', 'false')
  if (excessHosts.length > 0) showPageMermaidLimitNotice(container)
  const jobs = diagrams.flatMap(diagram => {
    const source = pageMermaidSource(diagram) ?? ''
    const state = diagram.dataset.pageMermaidState
    const hasRenderedSvg = diagram.querySelector('svg') !== null
    if (
      !mermaidHosts.has(diagram) ||
      hasRenderedSvg ||
      state === 'rendered' ||
      state === 'source-only' ||
      state === 'failed' ||
      source.length > MERMAID_MAX_TEXT_SIZE
    ) {
      if (!mermaidHosts.has(diagram) || source.length > MERMAID_MAX_TEXT_SIZE) {
        diagram.setAttribute('aria-busy', 'false')
        if (source.length > MERMAID_MAX_TEXT_SIZE) diagram.dataset.pageMermaidState = 'source-only'
      }
      return []
    }
    diagram.dataset.pageMermaidState = 'pending'
    return [async (): Promise<void> => {
      const current = (): boolean => isCurrent() && diagram.isConnected && container.contains(diagram)
      diagram.setAttribute('aria-busy', 'true')
      try {
        const safeSvg = await renderMermaidSvg(source, {
          ownerDocument: container.ownerDocument,
          theme,
          signal,
          isCurrent: current
        })
        if (!safeSvg || !current()) return
        safeSvg.setAttribute('role', 'img')
        safeSvg.setAttribute('aria-label', 'Mermaid diagram')
        diagram.replaceChildren(safeSvg)
        diagram.dataset.pageMermaidState = 'rendered'
      } catch {
        if (!current()) return
        if (!diagram.querySelector(`.${PAGE_MERMAID_ERROR_CLASS}`)) {
          const status = container.ownerDocument.createElement('p')
          status.className = PAGE_MERMAID_ERROR_CLASS
          status.setAttribute('role', 'alert')
          status.textContent = PAGE_MERMAID_ERROR_MESSAGE
          diagram.prepend(status)
        }
        diagram.dataset.pageMermaidState = 'failed'
      } finally {
        if (current()) diagram.setAttribute('aria-busy', 'false')
      }
    }]
  })
  await Promise.all(jobs.map(job => job()))
}

const PageTocTree = defineComponent({
  name: 'PageTocTree',
  props: {
    nodes: { type: Array as PropType<OutlineNode[]>, required: true },
    activeAnchor: { type: String, default: '' },
    isExpanded: { type: Function as PropType<(anchor: string) => boolean>, required: true },
    hasActiveDescendant: { type: Function as PropType<(anchor: string) => boolean>, required: true },
    onToggle: { type: Function as PropType<(anchor: string) => void>, required: true },
    onNavigate: { type: Function as PropType<(event: MouseEvent, anchor: string) => void>, required: true },
    isRtl: { type: Boolean, default: false },
    t: { type: Function as PropType<(key: string, params?: Record<string, unknown>) => string>, required: true }
  },
  setup(props) {
    const renderNode = (node: OutlineNode): VNode => {
      const hasChildren = Boolean(node.children && node.children.length > 0)
      const expanded = hasChildren && props.isExpanded(node.anchor)
      const isActive = props.activeAnchor === node.anchor
      const isDescendantActive = !expanded && props.hasActiveDescendant(node.anchor)
      const sublistId = outlineSublistId(node.anchor)

      const chevronIcon = expanded
        ? 'mdi-chevron-down'
        : props.isRtl
        ? 'mdi-chevron-left'
        : 'mdi-chevron-right'

      const visualDepth = Math.min(node.depth, 2)
      const titleClass =
        visualDepth === 0
          ? 'page-toc-item-title--depth-0'
          : visualDepth === 1
          ? 'page-toc-item-title--depth-1'
          : 'page-toc-item-title--depth-2-plus'

      const disclosureControl = hasChildren
        ? h(
            'button',
            {
              type: 'button',
              class: 'page-toc-branch-toggle',
              'aria-expanded': String(expanded),
              'aria-controls': sublistId,
              'aria-label': props.t(
                expanded ? 'common:page.collapseSection' : 'common:page.expandSection',
                { title: node.title }
              ),
              onClick: (e: MouseEvent) => {
                e.stopPropagation()
                props.onToggle(node.anchor)
              },
              onKeydown: (e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation()
                  e.preventDefault()
                  props.onToggle(node.anchor)
                }
              }
            },
            [h('i', { class: ['v-icon', 'notranslate', 'mdi', chevronIcon, 'page-toc-chevron'], 'aria-hidden': 'true' })]
          )
        : h('span', { class: 'page-toc-leaf-spacer', 'aria-hidden': 'true' })

      const link = h(
        'a',
        {
          href: node.anchor,
          class: [
            'page-toc-item',
            isActive ? 'page-toc-item--active' : '',
            isDescendantActive ? 'page-toc-item--descendant-active' : ''
          ],
          'aria-current': isActive ? 'location' : undefined,
          onClick: (e: MouseEvent) => props.onNavigate(e, node.anchor)
        },
        [
          h(
            'span',
            {
              class: ['page-toc-item-title', titleClass]
            },
            [h('span', { class: 'page-toc-item-title-text' }, node.title)]
          )
        ]
      )

      const row = h(
        'div',
        {
          class: 'page-toc-row',
          style: {
            '--toc-indent': `${visualDepth * 10}px`
          }
        },
        [disclosureControl, link]
      )

      const sublist: VNode | null = hasChildren
        ? h(
            'ul',
            {
              id: sublistId,
              class: 'page-toc-sublist',
              style: { display: expanded ? undefined : 'none' },
              'aria-hidden': String(!expanded)
            },
            node.children.map(renderNode)
          )
        : null

      return h(
        'li',
        {
          key: node.anchor,
          class: 'page-toc-node'
        },
        [row, sublist]
      )
    }

    return () =>
      h(
        'ul',
        {
          class: 'page-toc-list',
          role: 'list',
          'aria-label': props.t('common:page.toc')
        },
        props.nodes.map(renderNode)
      )
  }
})

export default defineComponent({
  name: 'PageView',
  components: {
    AsyncState,
    NavSidebar,
    StatusIndicator,
    SiteBanner,
    PageBrandingMark,
    PageTocTree,
  },
  emits: ['update:activeView'],
  setup () {
    return {
      goTo: useGoTo(),
      offlineStorage: shallowRef<OfflineStorage | null>(null),
      offlineSyncService: inject<OfflineSyncService>(OFFLINE_SYNC_COORDINATOR_KEY)
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
    sourceRevision: {
      type: String,
      default: ''
    },
    tags: {
      type: Array as PropType<PageTag[]>,
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
    visibility: {
      type: String as PropType<'public' | 'private'>,
      default: 'public'
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
    navExpandParent: {
      type: Boolean,
      default: true
    },
    activeView: {
      type: String as PropType<'article' | 'talk'>,
      default: 'article'
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
    navigationKey: {
      type: Number,
      default: 0
    },
    navigationPending: {
      type: Boolean,
      default: false
    },
    filename: {
      type: String,
      default: ''
    },
    branding: {
      type: Object as PropType<PageBrandingView | null>,
      default: null
    }
  },
  data() {
    const initialWidth = typeof window === 'undefined' ? 0 : window.innerWidth
    return {
      locales: siteLangs,
      navShown: initialWidth >= 1280,
      tocExpanded: initialWidth >= 1280,
      tocQuery: '',
      tocUserScrollAt: 0,
      tocScrollBound: false,
      expandedAnchors: new Set<string>(),
      collapsedByUser: new Set<string>(),
      preSearchExpanded: null as Set<string> | null,
      brandingFailureIdentity: null as string | null,
      preSearchCollapsedByUser: null as Set<string> | null,
      searchOverrides: new Map<string, boolean>(),
      readerFocus: false,
      readingProgress: 0,
      activeAnchor: '',
      outlineCleanup: null as PageOutlineTracker | null,
      tocRevealRafId: null as number | null,
      tocResizeObserver: null as ResizeObserver | null,
      upBtnShown: false,
      pageWatched: false,
      pageWatchLoading: false,
      pageWatchAuthorityReady: false,
      pageWatchRequestId: 0,
      pageWatchEmailEnabled: true,
      pageWatchInAppEnabled: true,
      offlineState: 'checking' as OfflinePageState,
      offlineAccessState: null as OfflinePageAccessState | null,
      offlineError: '',
      offlineAvailabilityError: '',
      offlineUnlockOpen: false,
      offlineUnlockSecret: '',
      offlineUnlockBusy: false,
      offlineUnlockError: '',
      offlineReadingStateVersion: 0,
      offlinePolicy: null as OfflinePagePolicyRecord | null,
      offlineHasSnapshot: false,
      offlineSnapshotRevision: '',
      offlineExpiresAt: null as string | null,
      offlineGeneration: null as number | null,
      offlineOperationId: 0,
      offlineOwnedOperationId: null as number | null,
      offlinePassiveRefreshPending: false,
      offlineDisposed: false,
      pageActionGeneration: 1,
      offlinePolicyRevision: null as number | null,
      offlineStorageChangesUnsubscribe: null as (() => void) | null,
      approvalDialog: false,
      approvalLoading: false,
      approvalInitialLoading: false,
      approvalError: '',
      approvalAuthorityReady: false,
      approvalAuthorityReadyKey: null as string | null,
      approvalRequestId: 0,
      approvalMutationId: 0,
      pageApproval: null as PageApproval | null,
      approvalComment: '',
      approvalAssigneeId: null as number | null,
      protectionDialog: false,
      protectionLoading: false,
      protectionInitialLoading: false,
      protectionAuthorityReady: false,
      protectionRequestId: 0,
      protectionError: '',
      pageProtection: { protected: false, version: 0, updatedBy: null, updatedAt: null } as PageProtection,
      pageProtectionPassword: '',
      scrollOpts: markRaw({
        duration: 250,
        layout: true,
        offset: -24,
        easing: 'easeInOutCubic'
      }),
      scrollStyle: markRaw({
        scrollPanel: {
          scrollingX: false
        }
      }),
      winWidth: initialWidth,
      resizeHandler: null as (() => void) | null,
      loadHandler: null as (() => void) | null,
      beforePrintHandler: null as (() => void) | null,
      afterPrintHandler: null as (() => void) | null,
      printViewBeforePrint: null as boolean | null,
      printDetailsState: null as Map<HTMLDetailsElement, boolean> | null,
      contentExtensionCleanup: null as (() => void) | null,
      mermaidAbortController: null as AbortController | null,
      routeAnimationAbortController: null as AbortController | null,
      scrollAnimationFrame: null as number | null,
      railScrollHandler: null as (() => void) | null,
      railRafId: 0,
      scrollAnimationToken: 0,
      railSettleRafId: 0,
      railSettleFrameCount: 0,
      railSettleStableFrames: 0,
      lastSampledRailTop: -1,
      railSettleHandler: null as (() => void) | null,
      lastRailMaxHeight: -1,
      lastRailAlignmentOffset: null as number | null,
      railAlignmentDirty: true,
      railStickyTop: 80,
      railSpacingGap: 8,
      cachedRailEl: null as HTMLElement | null,
      navFooterEl: null as HTMLElement | null,
      cachedHeaderEl: null as HTMLElement | null,
      cachedTitleEl: null as HTMLElement | null,
      railResizeObserver: null as ResizeObserver | null
    }
  },
  computed: {
    navigationOpen: {
      get (): boolean { return (this.talkActive || !this.readerFocus) && this.navShown },
      set (value: boolean) { if (!this.readerFocus || this.talkActive) this.navShown = value }
    },
    navDrawerWidth (): number {
      return this.$vuetify.display.width >= 1280 ? 269.6 : 244
    },
    // Below 1280 the drawer floats over the content, so the reading bar keeps
    // its full width; docked, it starts where the sidebar ends.
    pagePositionInsetStart (): string {
      const docked = this.navMode !== 'NONE' &&
        this.$vuetify.display.width >= 1280 &&
        this.navigationOpen
      return docked ? `${this.navDrawerWidth}px` : '0px'
    },
    pageArticleId (): string {
      return `wiki-page-shell-${this.pageId}-article`
    },
    pageTitleId (): string {
      return `wiki-page-shell-${this.pageId}-title`
    },
    pageBranding (): PageBrandingView | null {
      return normalizePageBrandingView(this.branding)
    },
    pageBrandingIdentity (): string | null {
      return pageBrandingIdentity(this.pageBranding)
    },
    pageBrandingVisible (): boolean {
      return this.pageBranding !== null && this.pageBrandingIdentity !== this.brandingFailureIdentity
    },
    pageBrandingStyle (): Record<string, string> {
      return resolvePageBrandingStyle(this.pageBranding, this.brandingFailureIdentity, this.$vuetify.theme.current.dark)
    },
    hasPageBrandingAccent (): boolean {
      return this.pageBrandingStyle['--page-branding-rgb'] !== undefined
    },
    pageTransportVerified (): boolean {
      return pwaState.connectionState === 'online' &&
        pwaState.serverReachable === true &&
        pwaState.serverHealthy === true
    },
    pageAuthorizationFresh (): boolean {
      return this.isAuthenticated &&
        wikiStore.authRefreshPending === false &&
        wikiStore.authRefreshSettled === true &&
        wikiStore.authRefreshOutcome === 'authenticated' &&
        wikiStore.offlineIdentityReady === true
    },
    pageOnlineActionReady (): boolean {
      return this.pageTransportVerified && this.pageAuthorizationFresh
    },
    pageOnlineActionUnavailableReason (): string {
      if (!this.pageTransportVerified) {
        if (pwaState.connectionState === 'checking') return 'Waiting for a verified server connection.'
        return 'This action requires a verified server connection.'
      }
      if (!this.pageAuthorizationFresh) return 'This action requires a freshly verified signed-in session.'
      return ''
    },
    pageWatchActionReady (): boolean {
      return this.pageOnlineActionReady && this.pageWatchAuthorityReady
    },
    approvalResourceKey (): string {
      const approval = this.pageApproval
      return [
        this.pageId,
        approval?.id ?? 'none',
        approval?.status ?? 'none',
        approval?.assigneeId ?? 'none',
        approval?.revisionId ?? 'none',
        approval?.stale ?? 'none',
        approval?.canReview ?? 'none',
        approval?.canSubmitter ?? 'none',
        this.sourceRevision
      ].join('\u0000')
    },
    approvalAuthorityContextKey (): string {
      return `${this.pageAuthorityKey}\u0000${this.pageId}\u0000${this.approvalResourceKey}`
    },
    approvalActionReady (): boolean {
      return this.pageOnlineActionReady &&
        this.approvalAuthorityReady &&
        this.approvalAuthorityReadyKey === this.approvalAuthorityContextKey
    },
    approvalActionUnavailableReason (): string {
      if (!this.pageOnlineActionReady) return this.pageOnlineActionUnavailableReason
      if (!this.approvalAuthorityReady || this.approvalAuthorityReadyKey !== this.approvalAuthorityContextKey)
        return 'Refresh approval state before changing it.'
      return ''
    },
    pageProtectionActionReady (): boolean {
      return this.pageOnlineActionReady && this.protectionAuthorityReady
    },
    pageAuthorityKey (): string {
      return [
        wikiStore.user.id,
        wikiStore.user.authenticated,
        wikiStore.authRefreshPending,
        wikiStore.authRefreshSettled,
        wikiStore.authRefreshOutcome,
        wikiStore.offlineIdentityReady,
        wikiStore.offlineIdentityEpoch,
        wikiStore.page.effectivePermissions.pages.write,
        wikiStore.page.effectivePermissions.pages.manage,
        wikiStore.page.effectivePermissions.system.manage,
        pwaState.connectionState,
        pwaState.serverReachable,
        pwaState.serverHealthy
      ].join(':')
    },
    isAuthenticated (): boolean {
      return wikiStore.user.authenticated
    },
    commentsPerms () {
      return wikiStore.page.effectivePermissions.comments
    },
    talkActive (): boolean {
      return this.activeView === 'talk' && this.commentsEnabled && this.commentsPerms.read && !this.commentsExternal
    },
    editShortcutsObj () {
      return wikiStore.page.editShortcuts
    },
    breadcrumbs(): Breadcrumb[] {
      const scope = this.visibility === 'private' ? '/_private' : ''
      let currentPath = `${scope}${this.locales.length > 0 ? `/${this.locale}` : ''}`
      const items: Breadcrumb[] = [{ href: '/', title: this.$t('common:header.home') as string }]
      for (const segment of this.path.split('/').filter(Boolean)) {
        currentPath += `/${segment}`
        items.push({ href: currentPath, title: segment })
      }
      return items
    },
    pageUrl (): string {
      const scope = this.visibility === 'private' ? '/_private' : ''
      const locale = this.locales.length > 0 ? `/${this.locale}` : ''
      return new URL(`${scope}${locale}/${this.path}`, window.location.origin).href
    },
    offlinePrivatePath (): boolean {
      return this.visibility === 'private' || this.offlinePrivateHandle() !== null
    },
    offlineStatusId (): string {
      return `${this.pageArticleId}-offline-status`
    },
    offlineActionLoading (): boolean {
      return this.offlineState === 'downloading' || this.offlineState === 'removing'
    },
    offlineSelected (): boolean {
      const policy = this.offlinePolicy
      return Boolean(policy && !policy.excluded && (policy.manual || policy.automatic || policy.tag))
    },
    offlineHasValidBody (): boolean {
      return this.offlineHasSnapshot && ['saved', 'expiring', 'stale', 'sync-pending'].includes(this.offlineState)
    },
    offlineSelectionSources (): string {
      const policy = this.offlinePolicy
      if (!policy || policy.excluded) return ''
      return offlineSelectionSources({
        manual: policy.manual,
        automatic: policy.automatic,
        tag: policy.tag,
        tagNames: policy.tagNames,
        revealTagNames: !(this.offlinePrivatePath && this.offlineAccessState !== null)
      })
    },
    offlineLocalIneligibilityReason (): string {
      void this.offlineReadingStateVersion
      if (!this.offlineSelector()) return 'This page cannot be saved offline.'
      if (!this.isPublished) return 'Unpublished pages cannot be saved offline.'
      if (this.pageProtection.protected) return 'Password-protected pages cannot be saved offline.'
      return ''
    },
    offlineQuietIneligibility (): boolean {
      return this.offlineState === 'ineligible' && offlineIneligibilityIsQuiet({
        serverDenied: this.offlinePolicy?.availability === 'ineligible',
        selected: this.offlineSelected,
        hasSnapshot: this.offlineHasSnapshot,
        excluded: Boolean(this.offlinePolicy?.excluded),
        localReason: this.offlineLocalIneligibilityReason,
        privatePath: this.offlinePrivatePath
      })
    },
    offlineControlState (): string {
      if (this.offlineState === 'checking') return 'checking'
      if (this.offlineState === 'downloading' || this.offlineState === 'removing') return this.offlineState
      if (this.offlineState === 'setup-required' || this.offlineState === 'locked') return this.offlineState
      if (this.offlineState === 'stale') return 'stale'
      if (this.offlineState === 'sync-pending') return this.pageTransportVerified ? 'sync-pending' : 'saved'
      if (this.offlineState === 'error') return 'error'
      if (this.offlineState === 'unavailable') return 'unavailable'
      if (this.offlineState === 'ineligible' && ((this.offlinePolicy?.excluded && !this.offlineLocalIneligibilityReason) || this.offlineQuietIneligibility)) return 'off'
      if (this.offlineState === 'ineligible') return 'ineligible'
      if (this.offlineSelected) return this.offlineHasValidBody ? (this.offlineState === 'expiring' ? 'expiring' : 'saved') : 'pending'
      return 'off'
    },
    offlineControlColor (): string | undefined {
      if (['saved', 'expiring'].includes(this.offlineControlState)) return 'primary'
      if (['error', 'unavailable'].includes(this.offlineControlState)) return 'error'
      if (['stale', 'sync-pending', 'ineligible', 'setup-required', 'locked'].includes(this.offlineControlState)) return 'warning'
      return undefined
    },
    offlineCanRetry (): boolean {
      return (this.offlineSelected || this.offlineHasSnapshot) &&
        (Boolean(this.offlineAvailabilityError) || ['stale', 'sync-pending', 'error', 'unavailable', 'ineligible'].includes(this.offlineState)) &&
        !this.offlineLocalIneligibilityReason &&
        !this.offlineActionLoading &&
        this.offlineOwnedOperationId === null
    },
    offlineRetryLabel (): string {
      return 'Retry offline sync'
    },
    offlineControlTitle (): string {
      if (this.offlineAccessState !== null) return offlinePrivateAccessStatus(this.offlineAccessState)
      if (this.offlineSelected) return `${this.offlineControlLabel} · ${this.offlineHasValidBody ? this.offlineSelectionSources : 'Copy not saved'}`
      const localReason = this.offlineLocalIneligibilityReason
      if (localReason) return localReason
      if (this.offlineState === 'checking') return 'Checking offline availability.'
      if (this.offlineState === 'downloading' || this.offlineState === 'removing') return 'Offline copy change in progress.'
      if (this.offlineState === 'error' || this.offlineState === 'unavailable') return 'Offline sync is unavailable. Retry offline sync.'
      if (this.offlineQuietIneligibility) return 'Not available for offline use under this Wiki’s access settings.'
      return this.offlineControlLabel
    },
    offlineControlDisabled (): boolean {
      if (this.offlineState === 'setup-required' || this.offlineState === 'locked') return false
      if (!Number.isSafeInteger(this.pageId) || this.pageId < 1 || !this.offlineSelector()) return true
      if (this.offlineOwnedOperationId !== null || this.offlineActionLoading || this.offlineState === 'checking') return true
      if (this.offlineState === 'ineligible' && !this.offlineSelected && !this.offlinePolicy?.excluded) return true
      return Boolean(this.offlineLocalIneligibilityReason && !this.offlineSelected)
    },
    offlineControlLabel (): string {
      if (this.offlineState === 'checking') return 'Checking offline'
      if (this.offlineState === 'downloading') return 'Saving offline copy'
      if (this.offlineState === 'removing') return 'Removing offline copy'
      if (this.offlineState === 'setup-required') return 'Offline setup required'
      if (this.offlineState === 'locked') return 'Unlock private offline reading'
      if (this.offlineQuietIneligibility) return 'Offline copy unavailable'
      return this.offlineSelected ? 'Remove offline copy' : 'Save offline copy'
    },
    offlineControlIcon (): string {
      if (this.offlineState === 'checking') return 'mdi-cloud-search-outline'
      if (this.offlineState === 'downloading' || this.offlineState === 'removing') return 'mdi-cloud-sync-outline'
      if (this.offlineState === 'setup-required' || this.offlineState === 'locked') return 'mdi-lock-outline'
      if (this.offlineState === 'stale' || (this.offlineState === 'sync-pending' && this.pageTransportVerified) || this.offlineState === 'error' || this.offlineState === 'unavailable') return 'mdi-cloud-alert-outline'
      if (this.offlineState === 'ineligible') return 'mdi-cloud-off-outline'
      if (this.offlineSelected && this.offlineHasValidBody) return 'mdi-cloud-check-outline'
      if (this.offlineSelected) return 'mdi-cloud-download-outline'
      return 'mdi-cloud-outline'
    },
    offlineStatusLabel (): string {
      if (this.offlineAccessState !== null) return offlinePrivateAccessStatus(this.offlineAccessState)
      const sources = this.offlineSelectionSources
      const selected = this.offlineSelected
      const selectedDetail = selected ? `Included via ${sources}.` : 'Not included in offline sync.'
      const actionFailure = this.offlineError
      const availabilityFailure = this.offlineAvailabilityError
      const serverDenied = this.offlinePolicy?.availability === 'ineligible'
      if (actionFailure && !serverDenied && !['checking', 'downloading', 'removing'].includes(this.offlineState)) {
        return this.offlineHasSnapshot
          ? `${selectedDetail} The saved readable copy remains available, but this action failed. ${actionFailure}`
          : actionFailure
      }
      switch (this.offlineState) {
        case 'checking':
          return 'Checking offline availability.'
        case 'eligible':
          return selected
            ? `${selectedDetail} A readable offline copy is pending.`
            : 'Not included. Save a readable offline copy on this device.'
        case 'downloading':
          return `${selectedDetail} Saving the readable offline copy; it is not committed yet.`
        case 'expiring':
        case 'stale':
        case 'sync-pending':
        case 'saved':
          return `${selectedDetail} ${offlineSavedPageStatus(this.offlineState, this.pageTransportVerified, selected)}`
        case 'removing':
          return 'Removing the readable offline copy and excluding this page; the change is not committed yet.'
        case 'setup-required':
        case 'locked':
          return offlinePrivateAccessStatus(this.offlineState)
        case 'ineligible': {
          const localReason = this.offlineLocalIneligibilityReason
          if (localReason) return localReason
          if (this.offlinePolicy?.excluded) return 'Excluded from offline sync.'
          if (this.offlineQuietIneligibility) return 'Not available for offline use under this Wiki’s access settings.'
          return 'The server could not create a safe offline copy. Retry, or manage saved pages from your account menu.'
        }
        case 'error':
          return availabilityFailure
            ? `${selectedDetail} Offline sync failed. ${availabilityFailure}`
            : `${selectedDetail} The readable offline copy is not committed.`
        case 'unavailable':
          return `${selectedDetail} Offline synchronization is unavailable. Use Retry offline sync when it is available.`
        default:
          return 'Offline selection is unknown.'
      }
    },
    sidebarDecoded (): SidebarItem[] {
      return decodeBase64Json<SidebarItem[]>(this.sidebar)
    },
    tocDecoded (): TableOfContentsNode[] {
      return decodeBase64Json<TableOfContentsNode[]>(this.toc)
    },
    tocFlattened (): FlattenedTableOfContentsNode[] {
      return normalizeTableOfContents(this.tocDecoded)
    },
    tocTree (): OutlineNode[] {
      return buildOutlineTree(this.tocFlattened)
    },
    tocTreeVisible (): OutlineNode[] {
      if (this.tocQuery?.trim()) return filterOutlineTree(this.tocTree, this.tocQuery)
      return this.tocTree
    },
    formattedUpdatedAt (): string {
      if (!this.updatedAt) return ''
      const formatted = this.$helpers.formatMoment(this.updatedAt, 'calendar')
      return typeof formatted === 'string' ? formatted : String(formatted ?? '')
    },
    accessibleUpdatedAt (): string {
      if (!this.updatedAt) return ''
      const formatted = this.$helpers.formatMoment(this.updatedAt, 'LLLL')
      return typeof formatted === 'string' ? formatted : String(formatted ?? '')
    },
    hasAuthor (): boolean {
      return Boolean(this.authorName && this.authorName.trim() && this.authorName.toLowerCase() !== 'unknown')
    },
    canViewHistory (): boolean {
      return Boolean(this.isAuthenticated && this.hasReadHistoryPermission)
    },
    pageHistoryUrl (): string {
      return (this.visibility === 'private' ? '/h/_private' : '/h') + '/' + this.locale + '/' + this.path
    },
    isTocMobile (): boolean {
      return this.winWidth <= 599
    },
    isTocCompact (): boolean {
      return this.winWidth < 1280
    },
    tocDisclosureExpanded (): boolean {
      return !this.isTocCompact || this.tocExpanded
    },

    tocPosition () {
      return wikiStore.site.tocPosition
    },
    siteBanner () {
      return wikiStore.site.banner
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
      return this.hasWritePagesPermission || this.hasManagePagesPermission ||
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
        return externalSourceUrl(this.editShortcutsObj.editMenuExternalUrl, this.filename)
      } else {
        return ''
      }
    }
  },
  watch: {
    pageBrandingIdentity (value: string | null, previous: string | null) {
      if (value !== previous) this.brandingFailureIdentity = null
    },
    pageAuthorityKey (value: string, previous: string) {
      if (value === previous) return
      this.pageWatchRequestId += 1
      this.protectionRequestId += 1
      this.approvalRequestId += 1
      this.approvalMutationId += 1
      this.pageWatchAuthorityReady = false
      this.protectionAuthorityReady = false
      this.approvalAuthorityReady = false
      this.approvalAuthorityReadyKey = null
      this.approvalInitialLoading = false
      this.approvalLoading = false
      if (!this.pageOnlineActionReady) return
      if (this.isAuthenticated) void this.loadPageWatchState()
      if (this.hasWritePagesPermission || this.hasManagePagesPermission || this.hasAdminPermission) void this.loadPageProtection()
    },
    approvalResourceKey (value: string, previous: string) {
      if (value === previous) return
      if (this.approvalAuthorityReadyKey === this.approvalAuthorityContextKey) return
      this.approvalRequestId += 1
      this.approvalMutationId += 1
      this.approvalAuthorityReady = false
      this.approvalAuthorityReadyKey = null
      this.approvalInitialLoading = false
      this.approvalLoading = false
    },
    tocQuery (newQuery: string, oldQuery: string) {
      const hadQuery = Boolean(oldQuery?.trim())
      const hasQuery = Boolean(newQuery?.trim())
      if (hasQuery && !hadQuery) {
        this.preSearchExpanded = new Set(this.expandedAnchors)
        this.preSearchCollapsedByUser = new Set(this.collapsedByUser)
        this.searchOverrides.clear()
      } else if (!hasQuery && hadQuery) {
        this.searchOverrides.clear()
        if (this.preSearchExpanded) {
          this.expandedAnchors = new Set(this.preSearchExpanded)
          this.preSearchExpanded = null
        }
        if (this.preSearchCollapsedByUser) {
          this.collapsedByUser = new Set(this.preSearchCollapsedByUser)
          this.preSearchCollapsedByUser = null
        }
      } else if (hasQuery && hadQuery && newQuery !== oldQuery) {
        this.searchOverrides.clear()
      }
      this.$nextTick(() => this.ensureActiveTocVisible())
    },
    tocFlattened: {
      immediate: true,
      handler (entries: FlattenedTableOfContentsNode[]) {
        this.expandedAnchors = getInitialExpandedAnchors(entries)
        this.collapsedByUser = new Set()
        this.preSearchExpanded = null
        this.preSearchCollapsedByUser = null
        this.searchOverrides.clear()
        this.$nextTick(() => {
          this.setupTocResizeObserver()
          this.ensureActiveTocVisible()
        })
      }
    },
    tocPosition () {
      this.resetDesktopRailMeasurementState()
      this.$nextTick(() => {
        this.setupDesktopRailObserver()
        this.setupTocResizeObserver()
        this.updateDesktopRailMeasurements(true)
        this.startDesktopRailSettling()
        this.ensureActiveTocVisible()
      })
    },
    navigationKey: {
      flush: 'post',
      async handler(value: number, previous: number) {
        if (value === previous) return
        this.syncPageStore()
        this.resetPageRouteState()
        await this.$nextTick()
        this.setupDesktopRailObserver()
        this.refreshPageContent()
        this.updateDesktopRailMeasurements(true)
        const offlinePageId = this.pageId
        const offlineLocale = this.locale
        void this.recordOfflineReaderVisit().then(() => {
          if (this.offlineDisposed || this.pageId !== offlinePageId || this.locale !== offlineLocale) return
          this.offlinePassiveRefreshPending = false
          void this.refreshOfflinePageState()
        })
        this.startDesktopRailSettling()
        this.animatePageRoute()
        this.focusPageTitle()
        if (this.isAuthenticated) {
          void this.loadPageWatchState()
          void this.loadPageApproval()
          void useSiteNotificationsStore().refresh()
        }
        if (this.hasWritePagesPermission || this.hasManagePagesPermission || this.hasAdminPermission) {
          void this.loadPageProtection()
        }
      }
    }
  },
  created() {
    this.syncPageStore()
  },
  mounted () {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.scrollOpts.duration = 0
    }
    if (this.isAuthenticated) {
      void this.loadPageWatchState()
      void this.loadPageApproval()
    }

    if (this.hasWritePagesPermission || this.hasManagePagesPermission || this.hasAdminPermission) {
      void this.loadPageProtection()
    }
    this.offlineStorageChangesUnsubscribe = subscribeOfflineStorageChanges(notice => {
      if (this.offlineDisposed) return
      if (notice.kind === 'policy' || notice.kind === 'corpus' || notice.kind === 'generation') {
        if (this.offlineOwnedOperationId !== null || this.offlineActionLoading) {
          this.offlinePassiveRefreshPending = true
          return
        }
        this.offlinePassiveRefreshPending = false
        void this.refreshOfflinePageState()
      }
    })

    // -> Check side navigation visibility
    this.handleSideNavVisibility()
    this.resizeHandler = () => {
      this.markDesktopRailAlignmentDirty()
      this.handleSideNavVisibility()
      this.updateDesktopRailMeasurements(true)
      this.startDesktopRailSettling()
      this.ensureActiveTocVisible()
    }
    window.addEventListener('resize', this.resizeHandler)

    this.railScrollHandler = () => this.onDesktopRailScroll()
    window.addEventListener('scroll', this.railScrollHandler, { passive: true })

    this.setupDesktopRailObserver()
    this.setupTocResizeObserver()

    this.refreshPageContent()
    this.setupTocResizeObserver()
    const offlinePageId = this.pageId
    const offlineLocale = this.locale
    void this.recordOfflineReaderVisit().then(() => {
      if (this.offlineDisposed || this.pageId !== offlinePageId || this.locale !== offlineLocale) return
      this.offlinePassiveRefreshPending = false
      void this.refreshOfflinePageState()
    })
    this.$nextTick(() => {
      this.setupDesktopRailObserver()
      this.setupTocResizeObserver()
      this.updateDesktopRailMeasurements(true)
      this.startDesktopRailSettling()
      this.ensureActiveTocVisible()
    })

    if (typeof document !== 'undefined' && 'fonts' in document && document.fonts?.ready) {
      document.fonts.ready.then(() => {
        this.updateDesktopRailMeasurements(true)
        this.startDesktopRailSettling()
      }).catch(() => {})
    }

    this.beforePrintHandler = () => this.preparePrintView()
    this.afterPrintHandler = () => this.restorePrintView()
    window.addEventListener('beforeprint', this.beforePrintHandler)
    window.addEventListener('afterprint', this.afterPrintHandler)

    // -> Handle anchor scrolling
    if (window.location.hash && window.location.hash.length > 1) {
      if (document.readyState === 'complete') {
        this.$nextTick(() => {
          this.scrollToPageAnchor(window.location.hash, false)
        })
      } else {
        this.loadHandler = () => {
          this.loadHandler = null
          this.scrollToPageAnchor(window.location.hash, false)
        }
        window.addEventListener('load', this.loadHandler, { once: true })
      }
    }
  },
  beforeUnmount () {
    this.offlineDisposed = true
    this.pageActionGeneration += 1
    this.pageWatchRequestId += 1
    this.protectionRequestId += 1
    this.approvalRequestId += 1
    this.approvalMutationId += 1
    this.pageWatchAuthorityReady = false
    this.protectionAuthorityReady = false
    this.approvalAuthorityReady = false
    this.approvalAuthorityReadyKey = null
    this.offlineOperationId += 1
    this.offlineOwnedOperationId = null
    this.offlinePassiveRefreshPending = false
    this.offlineStorageChangesUnsubscribe?.()
    this.offlineStorageChangesUnsubscribe = null
    this.offlineStorage?.close()
    this.offlineStorage = null
    this.offlineUnlockSecret = ''
    this.offlineUnlockError = ''
    if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler)
    if (this.railScrollHandler) window.removeEventListener('scroll', this.railScrollHandler)
    this.railScrollHandler = null
    if (this.railRafId) {
      window.cancelAnimationFrame(this.railRafId)
      this.railRafId = 0
    }
    this.cancelDesktopRailSettling()
    this.railSettleHandler = null
    if (this.cachedRailEl) {
      this.cachedRailEl.style.removeProperty('--page-desktop-rail-max-height')
      this.cachedRailEl.style.removeProperty('--page-desktop-rail-align-offset')
      this.cachedRailEl = null
    }
    this.navFooterEl = null
    if (this.railResizeObserver) {
      this.railResizeObserver.disconnect()
      this.railResizeObserver = null
    }
    this.cachedHeaderEl = null
    this.cachedTitleEl = null
    this.lastRailAlignmentOffset = null
    this.railAlignmentDirty = true
    if (this.loadHandler) window.removeEventListener('load', this.loadHandler)
    if (this.beforePrintHandler) window.removeEventListener('beforeprint', this.beforePrintHandler)
    if (this.afterPrintHandler) window.removeEventListener('afterprint', this.afterPrintHandler)
    this.outlineCleanup?.dispose()
    this.outlineCleanup = null
    this.tocResizeObserver?.disconnect()
    this.tocResizeObserver = null
    if (this.tocRevealRafId !== null) {
      window.cancelAnimationFrame(this.tocRevealRafId)
      this.tocRevealRafId = null
    }
    this.restorePrintView()
    this.routeAnimationAbortController?.abort()
    this.routeAnimationAbortController = null
    this.mermaidAbortController?.abort()
    this.mermaidAbortController = null
    this.cancelScheduledScroll()
    this.contentExtensionCleanup?.()
    this.contentExtensionCleanup = null
  },
  methods: {
    mergeProps,
    tagColor (canonicalTag: string): string {
      return tagColorBucket(canonicalTag)
    },
    pageBrandingImageError (identity: string): void {
      if (identity === this.pageBrandingIdentity) this.brandingFailureIdentity = identity
    },
    async toggleReaderFocus(): Promise<void> {
      const container = this.$refs.container as HTMLElement
      const headerBottom = document.querySelector('.nav-header')?.getBoundingClientRect().bottom ?? 64
      const blocks = Array.from(container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, p, li, summary, pre, table'))
        .filter(element => element.checkVisibility())
        .map(element => ({ element, bounds: element.getBoundingClientRect() }))
        .filter(({ bounds }) => bounds.height > 0 && bounds.bottom > headerBottom && bounds.top < window.innerHeight)
      const anchor = (blocks.find(({ bounds }) => bounds.top >= headerBottom) ?? blocks[0])?.element ?? container
      const previousTop = anchor?.getBoundingClientRect().top
      const previousScrollY = window.scrollY
      this.readerFocus = !this.readerFocus
      await this.$nextTick()
      this.cancelScheduledScroll()
      this.scrollAnimationFrame = requestAnimationFrame(() => {
        this.scrollAnimationFrame = null
        if (previousScrollY > 0 && anchor && previousTop !== undefined) window.scrollBy(0, anchor.getBoundingClientRect().top - previousTop)
        const target = this.$el.querySelector(this.readerFocus ? '.page-reading-dock button' : '.page-focus-control') as HTMLElement | null
        target?.focus({ preventScroll: true })
      })
    },
    focusArticle(): void {
      (this.$refs.container as HTMLElement)?.focus()
    },
    syncPageStore(): void {
      wikiStore.page.authorId = this.authorId
      wikiStore.page.authorName = this.authorName
      wikiStore.page.createdAt = this.createdAt
      wikiStore.page.description = this.description
      wikiStore.page.isPublished = this.isPublished
      wikiStore.page.id = this.pageId
      wikiStore.page.locale = this.locale
      wikiStore.page.path = this.path
      wikiStore.page.visibility = this.visibility
      wikiStore.page.tags = this.tags.map((tag: PageTag) => tag.tag)
      wikiStore.page.title = this.title
      wikiStore.page.editor = this.editor
      wikiStore.page.updatedAt = this.updatedAt
      wikiStore.page.sourceRevision = this.sourceRevision
      if (this.effectivePermissions) wikiStore.page.effectivePermissions = decodeBase64Json(this.effectivePermissions)
      if (this.editShortcuts) wikiStore.page.editShortcuts = decodeBase64Json(this.editShortcuts)
      wikiStore.page.mode = 'view'
    },
    offlinePrivateHandle (): ReturnType<typeof currentOfflineReadingHandle> {
      if (typeof window === 'undefined' || !wikiStore.user.authenticated || wikiStore.offlineIdentityReady !== true) return null
      const handle = currentOfflineReadingHandle()
      return handle && isCurrentOfflineReadingHandle(handle) && handle.context.canonicalOrigin === window.location.origin
        ? handle
        : null
    },
    offlineSiteId (): string {
      if (typeof window === 'undefined') return ''
      return this.offlinePrivatePath ? this.offlinePrivateHandle()?.context.siteId ?? '' : window.location.origin
    },
    offlineSelector (): OfflineSnapshotSelector | null {
      const siteId = this.offlineSiteId()
      if (!siteId || !Number.isSafeInteger(this.pageId) || this.pageId < 1 || !this.locale) return null
      return { siteId, pageId: this.pageId, locale: this.locale }
    },
    offlineVisitEligible (): boolean {
      return this.offlineSelector() !== null && this.offlineLocalIneligibilityReason === ''
    },
    isCurrentOfflineOperation (operationId: number, pageId: number): boolean {
      return operationId === this.offlineOperationId && pageId === this.pageId
    },
    async offlineStorageForOperation (operationId: number): Promise<OfflineStorage | null> {
      if (this.offlineStorage && !this.offlineStorage.isClosed) return this.offlineStorage
      const storage = await openOfflineStorage()
      if (operationId !== this.offlineOperationId) {
        storage.close()
        return null
      }
      this.offlineStorage = storage
      return storage
    },
    offlineAccountAwareService (): OfflineAccountAwareService | null {
      return this.offlineSyncService as OfflineAccountAwareService | null
    },
    async offlinePolicyForOperation (storage: OfflineStorage): Promise<OfflinePolicySnapshot> {
      if (!this.offlinePrivatePath) return await storage.readOfflinePolicy()
      const service = this.offlineAccountAwareService()
      if (!service?.readOfflinePolicy) throw new Error('Offline private policy is locked.')
      return await service.readOfflinePolicy()
    },
    async offlineCorpusForOperation (storage: OfflineStorage, selector: OfflineSnapshotSelector, policy: OfflinePolicySnapshot): Promise<OfflineSnapshotCorpus> {
      if (!this.offlinePrivatePath) {
        return await storage.readSnapshotCorpus({
          expectedSessionGeneration: policy.sessionGeneration,
          selector
        })
      }
      const service = this.offlineAccountAwareService()
      if (!service?.readSnapshotCorpus) throw new Error('Offline private policy is locked.')
      return await service.readSnapshotCorpus(selector)
    },
    async setOfflineManualIntent (storage: OfflineStorage, selector: OfflineSnapshotSelector, selected: boolean, policy: OfflinePolicySnapshot): Promise<OfflinePagePolicyRecord> {
      if (this.offlinePrivatePath) {
        const service = this.offlineAccountAwareService()
        if (!service?.setManualOfflineIntent) throw new Error('Offline private policy is locked.')
        return await service.setManualOfflineIntent(selector, selected)
      }
      return await storage.setManualOfflineIntent(selector, selected, {
        expectedSessionGeneration: policy.sessionGeneration,
        expectedPolicyRevision: policy.state.policyRevision
      })
    },
    async removeOfflineSelection (storage: OfflineStorage, selector: OfflineSnapshotSelector, policy: OfflinePolicySnapshot): Promise<OfflinePagePolicyRecord> {
      if (this.offlinePrivatePath) {
        const service = this.offlineAccountAwareService()
        if (service?.removeOfflinePage) return await service.removeOfflinePage(selector)
        if (service?.setManualOfflineIntent) return await service.setManualOfflineIntent(selector, false)
        throw new Error('Offline private policy is locked.')
      }
      return await storage.removeOfflinePage(selector, {
        expectedSessionGeneration: policy.sessionGeneration,
        expectedPolicyRevision: policy.state.policyRevision
      })
    },
    offlinePrivateAccessFromError (error: unknown): OfflinePageAccessState | null {
      if (!this.offlinePrivatePath) return null
      const status = error && typeof error === 'object' ? Number(Reflect.get(error, 'status')) : Number.NaN
      const code = error && typeof error === 'object' ? String(Reflect.get(error, 'code') ?? '') : ''
      const detail = getErrorMessage(error).toLowerCase()
      if (status === 401 || code === 'setup-required' || /enroll|setup required|vault.*(?:missing|not found|enrolled)/u.test(detail)) return 'setup-required'
      if (code === 'locked' || /unlock|reading.*(?:key|handle)|private.*locked/u.test(detail)) return 'locked'
      return null
    },
    async refreshOfflinePageState (): Promise<void> {
      if (this.offlineDisposed) return
      const pageId = this.pageId
      const locale = this.locale
      const operationId = ++this.offlineOperationId
      this.offlineState = 'checking'
      this.offlineAccessState = null
      this.offlineAvailabilityError = ''
      this.offlinePolicy = null
      this.offlineHasSnapshot = false
      this.offlineSnapshotRevision = ''
      this.offlineExpiresAt = null
      this.offlineGeneration = null
      this.offlinePolicyRevision = null
      if (this.offlinePrivatePath && !this.offlinePrivateHandle()) {
        try {
          const storage = await this.offlineStorageForOperation(operationId)
          if (!storage || !this.isCurrentOfflineOperation(operationId, pageId)) return
          const vault = await storage.getReadingVault()
          if (!this.isCurrentOfflineOperation(operationId, pageId)) return
          this.offlineAccessState = vault ? 'locked' : 'setup-required'
          this.offlineState = this.offlineAccessState
        } catch {
          if (!this.isCurrentOfflineOperation(operationId, pageId)) return
          this.offlineState = 'unavailable'
          this.offlineAvailabilityError = 'Private offline reading is unavailable on this device.'
        }
        return
      }
      if (!Number.isSafeInteger(pageId) || pageId < 1 || !this.offlineSelector()) {
        this.offlineState = 'ineligible'
        return
      }

      try {
        const storage = await this.offlineStorageForOperation(operationId)
        if (!storage || !this.isCurrentOfflineOperation(operationId, pageId)) return
        const selector = { siteId: this.offlineSiteId(), pageId, locale }
        const policy = await this.offlinePolicyForOperation(storage)
        if (!this.isCurrentOfflineOperation(operationId, pageId)) return
        const corpus = await this.offlineCorpusForOperation(storage, selector, policy)
        if (!this.isCurrentOfflineOperation(operationId, pageId)) return
        const origin = this.offlineSiteId()
        const now = Date.now()
        const existing = corpus.snapshots.find((record: OfflineSnapshotRecord) => {
          if (record.siteId !== origin || record.pageId !== pageId || record.locale !== locale) return false
          if (!record.snapshot.expiresAt) return true
          const expiry = Date.parse(record.snapshot.expiresAt)
          return Number.isFinite(expiry) && expiry > now
        })
        const pagePolicy = policy.pages.find((record: OfflinePagePolicyRecord) =>
          record.siteId === origin && record.pageId === pageId && record.locale === locale
        )
        this.offlinePolicy = pagePolicy ?? null
        this.offlineGeneration = corpus.sessionGeneration
        this.offlinePolicyRevision = policy.state.policyRevision
        this.offlineHasSnapshot = existing !== undefined
        this.offlineSnapshotRevision = existing?.snapshot.sourceRevision ?? ''
        this.offlineExpiresAt = existing?.snapshot.expiresAt ?? null
        if (this.offlineLocalIneligibilityReason) {
          this.offlineState = 'ineligible'
        } else if (!this.offlinePrivatePath && this.isAuthenticated && pagePolicy?.availability === 'ineligible' && !pagePolicy.excluded && !existing) {
          // A public page may be readable to this account but denied to Guest.
          // Keep the Guest copy private: saving it requires the encrypted reading vault.
          const vault = await storage.getReadingVault()
          if (!this.isCurrentOfflineOperation(operationId, pageId)) return
          this.offlineAccessState = vault ? 'locked' : 'setup-required'
          this.offlineState = this.offlineAccessState
        } else if (pagePolicy?.excluded || pagePolicy?.availability === 'ineligible') {
          this.offlineState = 'ineligible'
        } else if (existing) {
          const refreshFailed = pagePolicy?.availability === 'transient-failure'
          this.offlineState = offlineSavedPageState({
            savedRevision: this.offlineSnapshotRevision,
            latestKnownRevision: this.sourceRevision,
            expiresAt: this.offlineExpiresAt,
            refreshFailed
          })
          if (refreshFailed) this.offlineAvailabilityError = 'The latest offline sync attempt could not be completed.'
        } else if (pagePolicy?.availability === 'transient-failure') {
          this.offlineState = 'error'
          this.offlineAvailabilityError = 'The latest offline sync attempt could not be completed.'
        } else {
          this.offlineState = 'eligible'
        }
      } catch (error) {
        if (!this.isCurrentOfflineOperation(operationId, pageId)) return
        const privateAccess = this.offlinePrivateAccessFromError(error)
        if (privateAccess) {
          this.offlineAccessState = privateAccess
          this.offlineState = privateAccess
          this.offlineAvailabilityError = ''
          return
        }
        const status = error && typeof error === 'object' ? Number(Reflect.get(error, 'status')) : Number.NaN
        this.offlineAvailabilityError = typeof navigator !== 'undefined' && navigator.onLine === false
          ? 'Waiting for a verified server connection.'
          : this.offlinePrivatePath
            ? [403, 404, 410, 422].includes(status)
              ? 'This private page is not available for offline use under the current account.'
              : 'Private offline availability could not be confirmed.'
            : getErrorMessage(error) || 'Offline availability could not be checked.'
        const privateAuthorityDenied = this.offlinePrivatePath && [403, 404, 410, 422].includes(status)
        const unavailable = /unavailable|opening|closed/iu.test(this.offlineAvailabilityError)
        this.offlineState = privateAuthorityDenied ? 'error' : unavailable ? 'unavailable' : this.offlineHasSnapshot ? 'sync-pending' : 'error'
      }
    },
    async recordOfflineReaderVisit (): Promise<void> {
      if (this.offlineDisposed || !this.offlineVisitEligible()) return
      const selector = this.offlineSelector()
      if (!selector) return
      const pageId = selector.pageId
      const operationId = ++this.offlineOperationId
      this.offlineOwnedOperationId = operationId
      try {
        const storage = await this.offlineStorageForOperation(operationId)
        if (!storage || !this.isCurrentOfflineOperation(operationId, pageId)) return
        const policy = this.offlinePrivatePath
          ? await this.offlinePolicyForOperation(storage)
          : await storage.readOfflinePolicy()
        if (!this.isCurrentOfflineOperation(operationId, pageId)) return
        const service = this.offlineAccountAwareService()
        const updated = this.offlinePrivatePath
          ? await (service?.recordEligibleReaderVisit
              ? service.recordEligibleReaderVisit(selector)
              : Promise.reject(new Error('Offline private policy is locked.')))
          : await storage.recordEligibleReaderVisit(selector, {
              expectedSessionGeneration: policy.sessionGeneration,
              expectedPolicyRevision: policy.state.policyRevision
            })
        if (!this.isCurrentOfflineOperation(operationId, pageId)) return
        this.offlineGeneration = policy.sessionGeneration
        this.offlinePolicy = updated
        this.offlinePolicyRevision = policy.state.policyRevision + 1
        if (policy.state.automaticSavingEnabled) {
          await (this.offlineSyncService
            ? this.offlineSyncService.reconcile('visit')
            : createOfflineSyncUnavailableResult('Offline synchronization is unavailable.'))
          if (!this.isCurrentOfflineOperation(operationId, pageId)) return
        }
      } catch {
        // Visit recording is opportunistic and must never block page reading.
      } finally {
        if (this.offlineOwnedOperationId === operationId) this.offlineOwnedOperationId = null
      }
    },
    async updateOfflineAdmission (availability: 'ineligible' | 'unknown'): Promise<void> {
      if (this.offlinePrivatePath) {
        await this.refreshOfflinePageState()
        return
      }
      const selector = this.offlineSelector()
      if (!selector || this.offlineDisposed) return
      const generation = this.pageActionGeneration
      const pageId = selector.pageId
      const locale = selector.locale
      const siteId = selector.siteId
      const isCurrentAdmission = (): boolean =>
        !this.offlineDisposed &&
        generation === this.pageActionGeneration &&
        this.pageId === pageId &&
        this.locale === locale
      let storage: OfflineStorage | null = null
      let closeStorage = false
      try {
        if (this.offlineStorage && !this.offlineStorage.isClosed) {
          storage = this.offlineStorage
        } else {
          storage = await openOfflineStorage()
          closeStorage = true
        }
        if (!storage) return
        const policy = await storage.readOfflinePolicy()
        const variants = policy.pages.filter((record: OfflinePagePolicyRecord) =>
          record.siteId === siteId && record.pageId === pageId
        )
        if (availability === 'unknown') {
          if (variants.length === 0) return
          for (const variant of variants) {
            await storage.setPageAvailability({
              siteId: variant.siteId,
              pageId: variant.pageId,
              locale: variant.locale
            }, 'unknown')
          }
        } else {
          await storage.markPageIneligible(selector)
        }
        const nextPolicy = await storage.readOfflinePolicy()
        if (!isCurrentAdmission()) return
        const nextPage = nextPolicy.pages.find((record: OfflinePagePolicyRecord) =>
          record.siteId === siteId && record.pageId === pageId && record.locale === locale
        )
        this.offlinePolicy = nextPage ?? null
        this.offlineGeneration = nextPolicy.sessionGeneration
        this.offlinePolicyRevision = nextPolicy.state.policyRevision
        if (availability === 'ineligible') {
          this.offlineHasSnapshot = false
          this.offlineSnapshotRevision = ''
          this.offlineExpiresAt = null
          this.offlineState = 'ineligible'
          this.offlineAvailabilityError = ''
        } else {
          this.offlineState = nextPage?.excluded ? 'ineligible' : 'eligible'
        }
      } catch {
        if (!isCurrentAdmission()) return
        showNotification(wikiStore, {
          style: 'red',
          message: 'Offline admission could not be updated after the page protection change.',
          icon: 'alert'
        })
      } finally {
        if (closeStorage) storage?.close()
      }
    },
    async updateOfflinePage (manualSelection: boolean): Promise<void> {
      const selector = this.offlineSelector()
      const pageId = selector?.pageId ?? this.pageId
      if (this.offlineDisposed || !selector || !Number.isSafeInteger(pageId) || pageId < 1 || (manualSelection && !this.offlineVisitEligible())) {
        if (this.offlinePrivatePath && !this.offlinePrivateHandle()) {
          this.offlineAccessState = 'locked'
          this.offlineState = 'locked'
        } else {
          this.offlineState = 'ineligible'
        }
        return
      }
      const generation = this.pageActionGeneration
      const isCurrentPage = (): boolean =>
        !this.offlineDisposed &&
        generation === this.pageActionGeneration &&
        this.pageId === selector.pageId &&
        this.locale === selector.locale
      const operationId = ++this.offlineOperationId
      const isCurrentOperation = (): boolean =>
        isCurrentPage() && this.isCurrentOfflineOperation(operationId, pageId)
      this.offlineOwnedOperationId = operationId
      this.offlineState = manualSelection ? 'downloading' : 'removing'
      this.offlineError = ''
      this.offlineAvailabilityError = ''
      let policyMutationCommitted = false
      let authoritativeRefreshOperationId: number | null = null
      try {
        const storage = await this.offlineStorageForOperation(operationId)
        if (!storage || !isCurrentOperation()) return
        const policy = await this.offlinePolicyForOperation(storage)
        if (!isCurrentOperation()) return
        const previousPolicy = policy.pages.find((record: OfflinePagePolicyRecord) =>
          record.siteId === selector.siteId && record.pageId === selector.pageId && record.locale === selector.locale
        )
        const updatedPolicy = await this.setOfflineManualIntent(storage, selector, manualSelection, policy)
        policyMutationCommitted = true
        if (!isCurrentOperation()) return
        this.offlinePolicy = updatedPolicy
        this.offlineGeneration = policy.sessionGeneration
        const policyChanged = previousPolicy
          ? previousPolicy.manual !== manualSelection || previousPolicy.excluded
          : manualSelection
        this.offlinePolicyRevision = policy.state.policyRevision + (policyChanged ? 1 : 0)
        const syncResult: OfflineSyncResult = this.offlineSyncService
          ? await this.offlineSyncService.reconcile('manual')
          : createOfflineSyncUnavailableResult('Offline synchronization is unavailable.')
        if (!isCurrentOperation()) return
        authoritativeRefreshOperationId = this.offlineOperationId + 1
        this.offlinePassiveRefreshPending = false
        await this.refreshOfflinePageState()
        if (!isCurrentPage() || this.offlineOperationId !== authoritativeRefreshOperationId) return

        if (this.offlineAccessState !== null) {
          showNotification(wikiStore, {
            style: 'warning',
            message: offlinePrivateAccessStatus(this.offlineAccessState),
            icon: 'alert'
          })
          this.offlinePassiveRefreshPending = false
          return
        }
        const refreshedOfflineState = widenOfflinePageState(this.offlineState)
        const pageFailed = Boolean(this.offlineAvailabilityError) || ['stale', 'sync-pending', 'error', 'unavailable', 'ineligible'].includes(refreshedOfflineState)
        if (pageFailed) {
          this.offlineAvailabilityError = refreshedOfflineState === 'ineligible'
            ? 'This page is not available for offline use.'
            : this.offlineAvailabilityError || 'The readable offline copy could not be committed.'
          showNotification(wikiStore, {
            style: 'red',
            message: this.offlineAvailabilityError,
            icon: 'alert'
          })
          this.offlinePassiveRefreshPending = false
          return
        }

        const saved = this.offlineHasValidBody
        const message = saved
          ? 'Page selected for offline sync; a readable copy is saved on this device.'
          : 'Page selected for offline sync; a readable copy will be saved when available.'
        let notification = message
        if (syncResult.outcome === 'offline')
          notification += ' Local synchronization will resume when a connection is available.'
        showNotification(wikiStore, {
          style: 'success',
          message: notification
        })
        const aggregateNotice = offlineSyncAggregateNotice(syncResult)
        if (aggregateNotice) {
          showNotification(wikiStore, {
            style: 'warning',
            message: aggregateNotice,
            icon: 'warning'
          })
        }
      } catch (error) {
        if (!isCurrentOperation()) return
        const detail = getErrorMessage(error).trim().slice(0, 512) || (
          policyMutationCommitted
            ? 'Offline synchronization could not be completed.'
            : 'The offline selection could not be committed.'
        )
        if (!policyMutationCommitted) {
          this.offlineState = this.offlineHasSnapshot ? 'sync-pending' : 'error'
          this.offlineError = detail
          showNotification(wikiStore, {
            style: 'red',
            message: this.offlineError,
            icon: 'alert'
          })
          this.offlinePassiveRefreshPending = false
          return
        }

        authoritativeRefreshOperationId = this.offlineOperationId + 1
        this.offlinePassiveRefreshPending = false
        await this.refreshOfflinePageState()
        if (!isCurrentPage() || this.offlineOperationId !== authoritativeRefreshOperationId) return
        const refreshedOfflineState = widenOfflinePageState(this.offlineState)
        const pageFailed = Boolean(this.offlineAvailabilityError) || ['stale', 'sync-pending', 'error', 'unavailable', 'ineligible'].includes(refreshedOfflineState)
        if (pageFailed) {
          this.offlineAvailabilityError = refreshedOfflineState === 'ineligible'
            ? 'This page is not available for offline use.'
            : this.offlineAvailabilityError || 'The readable offline copy could not be committed.'
          showNotification(wikiStore, {
            style: 'red',
            message: this.offlineAvailabilityError,
            icon: 'alert'
          })
          this.offlinePassiveRefreshPending = false
          return
        }

        const saved = this.offlineHasValidBody
        showNotification(wikiStore, {
          style: 'success',
          message: saved
            ? 'Page selected for offline sync; a readable copy is saved on this device.'
            : 'Page selected for offline sync; a readable copy will be saved when available.'
        })
        showNotification(wikiStore, {
          style: 'warning',
          message: offlineSyncFailureNotice(detail),
          icon: 'warning'
        })
      } finally {
        if (this.offlineOwnedOperationId === operationId) {
          const shouldRefresh = this.offlinePassiveRefreshPending &&
            isCurrentPage() &&
            (authoritativeRefreshOperationId === null
              ? this.offlineOperationId === operationId
              : this.offlineOperationId === authoritativeRefreshOperationId)
          this.offlinePassiveRefreshPending = false
          this.offlineOwnedOperationId = null
          if (shouldRefresh) await this.refreshOfflinePageState()
        }
      }
    },
    async removeOfflinePage (): Promise<void> {
      const selector = this.offlineSelector()
      const pageId = selector?.pageId ?? this.pageId
      if (this.offlineDisposed || !selector || !Number.isSafeInteger(pageId) || pageId < 1) {
        if (this.offlinePrivatePath && !this.offlinePrivateHandle()) {
          this.offlineAccessState = 'locked'
          this.offlineState = 'locked'
        } else {
          this.offlineState = 'ineligible'
        }
        return
      }
      const generation = this.pageActionGeneration
      const isCurrentPage = (): boolean =>
        !this.offlineDisposed &&
        generation === this.pageActionGeneration &&
        this.pageId === selector.pageId &&
        this.locale === selector.locale
      const operationId = ++this.offlineOperationId
      const isCurrentOperation = (): boolean =>
        isCurrentPage() && this.isCurrentOfflineOperation(operationId, pageId)
      this.offlineOwnedOperationId = operationId
      this.offlineState = 'removing'
      this.offlineError = ''
      this.offlineAvailabilityError = ''
      let policyMutationCommitted = false
      let authoritativeRefreshOperationId: number | null = null
      try {
        const storage = await this.offlineStorageForOperation(operationId)
        if (!storage || !isCurrentOperation()) return
        const policy = await this.offlinePolicyForOperation(storage)
        if (!isCurrentOperation()) return
        const excludedPolicy = await this.removeOfflineSelection(storage, selector, policy)
        policyMutationCommitted = true
        if (!isCurrentOperation()) return
        this.offlinePolicy = excludedPolicy
        this.offlineGeneration = policy.sessionGeneration
        this.offlinePolicyRevision = policy.state.policyRevision + 1
        this.offlineHasSnapshot = false
        this.offlineSnapshotRevision = ''
        this.offlineExpiresAt = null
        this.offlineState = 'ineligible'
        const syncResult: OfflineSyncResult = this.offlineSyncService
          ? await this.offlineSyncService.reconcile('manual')
          : createOfflineSyncUnavailableResult('Offline synchronization is unavailable.')
        if (!isCurrentOperation()) return
        authoritativeRefreshOperationId = this.offlineOperationId + 1
        this.offlinePassiveRefreshPending = false
        await this.refreshOfflinePageState()
        if (!isCurrentPage() || this.offlineOperationId !== authoritativeRefreshOperationId) return

        const refreshedOfflineState = widenOfflinePageState(this.offlineState)
        const pageFailed = ['stale', 'sync-pending', 'error', 'unavailable'].includes(refreshedOfflineState)
        const message = syncResult.outcome === 'offline'
          ? 'Offline copy removed and page excluded from offline sync. Local synchronization will resume when a connection is available.'
          : 'Offline copy removed and page excluded from offline sync.'
        showNotification(wikiStore, {
          style: 'success',
          message
        })
        if (pageFailed) {
          this.offlineAvailabilityError = this.offlineAvailabilityError || 'The current offline removal state could not be refreshed.'
          showNotification(wikiStore, {
            style: 'red',
            message: this.offlineAvailabilityError,
            icon: 'alert'
          })
          this.offlinePassiveRefreshPending = false
          return
        }
        const aggregateNotice = offlineSyncAggregateNotice(syncResult)
        if (aggregateNotice) {
          showNotification(wikiStore, {
            style: 'warning',
            message: aggregateNotice,
            icon: 'warning'
          })
        }
      } catch (error) {
        if (!isCurrentOperation()) return
        const detail = getErrorMessage(error).trim().slice(0, 512) || (
          policyMutationCommitted
            ? 'Offline synchronization could not be completed.'
            : 'The offline copy could not be removed.'
        )
        if (!policyMutationCommitted) {
          this.offlineState = 'error'
          this.offlineError = detail
          showNotification(wikiStore, {
            style: 'red',
            message: this.offlineError,
            icon: 'alert'
          })
          this.offlinePassiveRefreshPending = false
          return
        }

        authoritativeRefreshOperationId = this.offlineOperationId + 1
        this.offlinePassiveRefreshPending = false
        await this.refreshOfflinePageState()
        if (!isCurrentPage() || this.offlineOperationId !== authoritativeRefreshOperationId) return
        const refreshedOfflineState = widenOfflinePageState(this.offlineState)
        const pageFailed = ['stale', 'sync-pending', 'error', 'unavailable'].includes(refreshedOfflineState)
        showNotification(wikiStore, {
          style: 'success',
          message: 'Offline copy removed and page excluded from offline sync.'
        })
        if (pageFailed) {
          this.offlineAvailabilityError = this.offlineAvailabilityError || 'The current offline removal state could not be refreshed.'
          showNotification(wikiStore, {
            style: 'red',
            message: this.offlineAvailabilityError,
            icon: 'alert'
          })
        } else {
          showNotification(wikiStore, {
            style: 'warning',
            message: offlineSyncFailureNotice(detail),
            icon: 'warning'
          })
        }
        this.offlinePassiveRefreshPending = false
      } finally {
        if (this.offlineOwnedOperationId === operationId) {
          const shouldRefresh = this.offlinePassiveRefreshPending &&
            isCurrentPage() &&
            (authoritativeRefreshOperationId === null
              ? this.offlineOperationId === operationId
              : this.offlineOperationId === authoritativeRefreshOperationId)
          this.offlinePassiveRefreshPending = false
          this.offlineOwnedOperationId = null
          if (shouldRefresh) await this.refreshOfflinePageState()
        }
      }
    },
    closeOfflineUnlock (): void {
      if (this.offlineUnlockBusy) return
      this.offlineUnlockOpen = false
      this.offlineUnlockSecret = ''
      this.offlineUnlockError = ''
    },
    async unlockPrivateOfflinePage (): Promise<void> {
      if (!this.isAuthenticated || this.offlineState !== 'locked' || this.offlineAccessState !== 'locked' || this.offlineUnlockBusy || !this.offlineUnlockSecret) return
      const entered = this.offlineUnlockSecret
      this.offlineUnlockSecret = ''
      this.offlineUnlockError = ''
      this.offlineUnlockBusy = true
      let secret: Uint8Array | null = null
      try {
        const operationId = this.offlineOperationId
        const storage = await this.offlineStorageForOperation(operationId)
        if (!storage || operationId !== this.offlineOperationId) return
        secret = decodeOfflineReadingSecret(entered)
        await unlockOfflineReading(storage, secret)
        this.offlineReadingStateVersion += 1
        this.offlineUnlockOpen = false
        await this.refreshOfflinePageState()
      } catch {
        this.offlineUnlockError = 'The private offline vault could not be unlocked.'
      } finally {
        secret?.fill(0)
        this.offlineUnlockBusy = false
      }
    },
    async toggleOfflinePage (): Promise<void> {
      if (this.offlineState === 'setup-required') {
        window.location.assign('/p/offline')
        return
      }
      if (this.offlineState === 'locked') {
        this.offlineUnlockError = ''
        this.offlineUnlockOpen = true
        return
      }
      if (this.offlineControlDisabled) return
      if (this.offlineSelected || this.offlineHasSnapshot) {
        await this.removeOfflinePage()
      } else {
        await this.updateOfflinePage(true)
      }
    },
    async retryOfflinePage (): Promise<void> {
      if (!this.offlineCanRetry || this.offlineDisposed) return
      const selector = this.offlineSelector()
      if (!selector) return
      const pageId = selector.pageId
      const generation = this.pageActionGeneration
      const isCurrentPage = (): boolean =>
        !this.offlineDisposed &&
        generation === this.pageActionGeneration &&
        this.pageId === selector.pageId &&
        this.locale === selector.locale
      const operationId = ++this.offlineOperationId
      const isCurrentOperation = (): boolean =>
        isCurrentPage() && this.isCurrentOfflineOperation(operationId, pageId)
      this.offlineOwnedOperationId = operationId
      this.offlineState = 'checking'
      this.offlineError = ''
      this.offlineAvailabilityError = ''
      let authoritativeRefreshOperationId: number | null = null
      let reconcileStarted = false
      try {
        const storage = await this.offlineStorageForOperation(operationId)
        if (!storage || !isCurrentOperation()) return
        const policy = await this.offlinePolicyForOperation(storage)
        if (!isCurrentOperation()) return
        const pagePolicy = policy.pages.find(page => page.siteId === selector.siteId && page.pageId === selector.pageId && page.locale === selector.locale)
        if (!this.offlinePrivatePath && pagePolicy?.availability === 'ineligible' && !pagePolicy.excluded) {
          await storage.setPageAvailability(selector, 'unknown', {
            expectedSessionGeneration: policy.sessionGeneration,
            expectedPolicyRevision: policy.state.policyRevision
          })
          if (!isCurrentOperation()) return
        }
        reconcileStarted = true
        const syncResult: OfflineSyncResult = this.offlineSyncService
          ? await this.offlineSyncService.reconcile('manual')
          : createOfflineSyncUnavailableResult('Offline synchronization is unavailable.')
        if (!isCurrentOperation()) return
        authoritativeRefreshOperationId = this.offlineOperationId + 1
        this.offlinePassiveRefreshPending = false
        await this.refreshOfflinePageState()
        if (!isCurrentPage() || this.offlineOperationId !== authoritativeRefreshOperationId) return

        const refreshedOfflineState = widenOfflinePageState(this.offlineState)
        const pageFailed = Boolean(this.offlineAvailabilityError) || ['stale', 'sync-pending', 'error', 'unavailable', 'ineligible'].includes(refreshedOfflineState)
        if (pageFailed) {
          this.offlineAvailabilityError = refreshedOfflineState === 'ineligible'
            ? 'This page is not available for offline use.'
            : this.offlineAvailabilityError || 'The readable offline copy could not be updated.'
          showNotification(wikiStore, {
            style: 'red',
            message: this.offlineAvailabilityError,
            icon: 'alert'
          })
          this.offlinePassiveRefreshPending = false
          return
        }
        showNotification(wikiStore, {
          style: 'success',
          message: this.offlineHasValidBody
            ? 'Offline copy updated on this device.'
            : 'Offline sync retry completed.'
        })
        const aggregateNotice = offlineSyncAggregateNotice(syncResult)
        if (aggregateNotice) {
          showNotification(wikiStore, {
            style: 'warning',
            message: aggregateNotice,
            icon: 'warning'
          })
        }
      } catch (error) {
        if (!isCurrentOperation()) return
        const detail = getErrorMessage(error).trim().slice(0, 512) || 'Offline synchronization could not be completed.'
        if (!reconcileStarted) {
          this.offlineState = /unavailable|opening|closed/iu.test(detail)
            ? 'unavailable'
            : this.offlineHasSnapshot ? 'sync-pending' : 'error'
          this.offlineAvailabilityError = `Offline sync failed: ${detail}`
          showNotification(wikiStore, {
            style: 'red',
            message: this.offlineAvailabilityError,
            icon: 'alert'
          })
          this.offlinePassiveRefreshPending = false
          return
        }

        authoritativeRefreshOperationId = this.offlineOperationId + 1
        this.offlinePassiveRefreshPending = false
        await this.refreshOfflinePageState()
        if (!isCurrentPage() || this.offlineOperationId !== authoritativeRefreshOperationId) return
        const refreshedOfflineState = widenOfflinePageState(this.offlineState)
        const pageFailed = Boolean(this.offlineAvailabilityError) || ['stale', 'sync-pending', 'error', 'unavailable', 'ineligible'].includes(refreshedOfflineState)
        if (pageFailed) {
          this.offlineAvailabilityError = refreshedOfflineState === 'ineligible'
            ? 'This page is not available for offline use.'
            : this.offlineAvailabilityError || 'The readable offline copy could not be updated.'
          showNotification(wikiStore, {
            style: 'red',
            message: this.offlineAvailabilityError,
            icon: 'alert'
          })
          this.offlinePassiveRefreshPending = false
          return
        }
        showNotification(wikiStore, {
          style: 'success',
          message: this.offlineHasValidBody
            ? 'Offline copy updated on this device.'
            : 'Offline sync retry completed.'
        })
        showNotification(wikiStore, {
          style: 'warning',
          message: offlineSyncFailureNotice(detail),
          icon: 'warning'
        })
      } finally {
        if (this.offlineOwnedOperationId === operationId) {
          const shouldRefresh = this.offlinePassiveRefreshPending &&
            isCurrentPage() &&
            (authoritativeRefreshOperationId === null
              ? this.offlineOperationId === operationId
              : this.offlineOperationId === authoritativeRefreshOperationId)
          this.offlinePassiveRefreshPending = false
          this.offlineOwnedOperationId = null
          if (shouldRefresh) await this.refreshOfflinePageState()
        }
      }
    },
    resetPageRouteState(): void {
      this.pageActionGeneration += 1
      this.pageWatchRequestId += 1
      this.protectionRequestId += 1
      this.approvalRequestId += 1
      this.approvalMutationId += 1
      this.pageWatchAuthorityReady = false
      this.protectionAuthorityReady = false
      this.approvalAuthorityReady = false
      this.approvalAuthorityReadyKey = null
      this.offlineOperationId += 1
      this.offlineOwnedOperationId = null
      this.offlinePassiveRefreshPending = false
      this.offlineError = ''
      this.offlineAvailabilityError = ''
      this.outlineCleanup?.dispose()
      this.outlineCleanup = null
      this.cancelScheduledScroll()
      this.resetDesktopRailMeasurementState()
      this.tocQuery = ''
      this.readingProgress = 0
      this.activeAnchor = ''
      this.expandedAnchors = getInitialExpandedAnchors(this.tocFlattened)
      this.collapsedByUser = new Set()
      this.preSearchExpanded = null
      this.preSearchCollapsedByUser = null
      this.searchOverrides.clear()

      this.brandingFailureIdentity = null
      this.pageWatched = false
      this.pageWatchLoading = false
      this.pageWatchEmailEnabled = true
      this.pageWatchInAppEnabled = true
      this.approvalDialog = false
      this.approvalLoading = false
      this.approvalInitialLoading = false
      this.approvalComment = ''
      this.approvalAssigneeId = null
      this.pageApproval = null
      this.approvalError = ''
      this.protectionDialog = false
      this.protectionLoading = false
      this.protectionInitialLoading = false
      this.protectionError = ''
      this.pageProtection = { protected: false, version: 0, updatedBy: null, updatedAt: null }
      this.pageProtectionPassword = ''
    },
    setupTocResizeObserver(): void {
      this.tocResizeObserver?.disconnect()
      this.tocResizeObserver = null
      const list = this.$el?.querySelector('.page-toc-content .page-toc-list') as HTMLElement | null
      if (!list) return
      const observer = new ResizeObserver(() => this.ensureActiveTocVisible())
      observer.observe(list)
      const content = list.closest('.page-toc-content')
      if (content && content !== list) observer.observe(content)
      this.tocResizeObserver = observer
      // Manual scrolling of the ToC must not be overridden by the automatic
      // active-section repositioning for a short grace period. The grace is
      // armed ONLY by direct interaction with this list (wheel, touch,
      // scrollbar/pointer drag, momentum), never inferred from scroll events:
      // inferred arming falsely triggers during fast page flick scrolls (late
      // event delivery, scroll anchoring, programmatic clamping) and stalls
      // the auto-follow while the row highlight stays correct.
      if (!this.tocScrollBound) {
        const markUserScroll = (): void => {
          this.tocUserScrollAt = performance.now()
        }
        list.addEventListener('wheel', markUserScroll, { passive: true })
        list.addEventListener('touchstart', markUserScroll, { passive: true })
        list.addEventListener('pointerdown', markUserScroll, { passive: true })
        // Pointer moves with a pressed button keep a scrollbar drag covered.
        list.addEventListener('pointermove', (event: PointerEvent) => {
          if (event.buttons !== 0) markUserScroll()
        }, { passive: true })
        this.tocScrollBound = true
      }
    },
    applyTocActiveMarquee (active: HTMLElement | null): void {
      if (typeof window === 'undefined') return
      const root = this.$el as HTMLElement
      if (!root) return
      for (const el of [...root.querySelectorAll<HTMLElement>('.page-toc-item-title--marquee')]) {
        if (active && el.parentElement === active) continue
        el.classList.remove('page-toc-item-title--marquee')
        el.style.removeProperty('--toc-marquee-shift')
        el.style.removeProperty('--toc-marquee-duration')
      }
      if (!active) return
      const title = active.querySelector<HTMLElement>('.page-toc-item-title')
      if (!title) return
      const overflow = title.scrollWidth - title.clientWidth
      if (overflow <= 2) return
      const rtl = getComputedStyle(title).direction === 'rtl'
      const desiredShift = `${rtl ? overflow : -overflow}px`
      // Keep the running animation untouched when re-measured with the same
      // values; re-adding the class would restart the oscillation.
      if (title.classList.contains('page-toc-item-title--marquee')
        && title.style.getPropertyValue('--toc-marquee-shift') === desiredShift) return
      title.classList.add('page-toc-item-title--marquee')
      title.style.setProperty('--toc-marquee-shift', desiredShift)
      const duration = Math.min(8, Math.max(2.5, 2 + overflow / 24))
      title.style.setProperty('--toc-marquee-duration', `${duration.toFixed(2)}s`)
    },
    ensureActiveTocVisible(): void {
      if (this.tocUserScrollAt && performance.now() - this.tocUserScrollAt < 900) return
      if (this.tocRevealRafId !== null || !this.$el) return
      this.tocRevealRafId = requestAnimationFrame(() => {
        this.tocRevealRafId = null
        const root = this.$el as HTMLElement
        const links = [...root.querySelectorAll<HTMLElement>('.page-toc-item')]
        const visible = (item: HTMLElement): boolean => item.getClientRects().length > 0
        let active = links.find(item => item.getAttribute('aria-current') === 'location' && visible(item))
        if (!active) active = links.find(item => item.classList.contains('page-toc-item--descendant-active') && visible(item))
        this.applyTocActiveMarquee(active ?? null)
        if (!active) return
        const row = active.closest('.page-toc-row') as HTMLElement | null
        if (!row) return
        const lists = [...root.querySelectorAll<HTMLElement>('.page-toc-list')].filter(list => list.contains(row))
        const list = lists.find(candidate => candidate.scrollHeight > candidate.clientHeight + 1) ?? lists[0]
        if (!list) return
        const focused = document.activeElement
        const focusedTocControl = focused instanceof Element ? focused.closest('.page-toc-item, .page-toc-filter') : null
        if (focusedTocControl && focusedTocControl !== active) return
        const rowBounds = row.getBoundingClientRect()
        const listBounds = list.getBoundingClientRect()
        const computed = window.getComputedStyle(list)
        const parsedGutter = parseFloat(computed.paddingInlineStart)
        const gutter = Number.isFinite(parsedGutter) ? Math.max(8, parsedGutter) : 8
        const viewportTop = listBounds.top + list.clientTop + gutter
        const viewportBottom = listBounds.top + list.clientTop + list.clientHeight - gutter
        const viewportSize = viewportBottom - viewportTop
        if (viewportSize <= 0) return
        let delta = 0
        if (rowBounds.height >= viewportSize) {
          delta = rowBounds.top - viewportTop
        } else if (rowBounds.top < viewportTop) {
          delta = rowBounds.top - viewportTop
        } else if (rowBounds.bottom > viewportBottom) {
          delta = rowBounds.bottom - viewportBottom
        }
        if (delta !== 0) {
          list.scrollTop += delta
        }
      })
    },
    refreshPageContent(): void {
      const container = this.$refs.container as HTMLElement
      this.mermaidAbortController?.abort()
      const mermaidController = markRaw(new AbortController())
      this.mermaidAbortController = mermaidController
      for (const diagram of container.querySelectorAll<HTMLElement>('.mermaid')) {
        if (diagram.dataset.pageMermaidState === 'pending') delete diagram.dataset.pageMermaidState
      }
      const mermaidCandidates = [...container.querySelectorAll<HTMLElement>('.mermaid, .content-extension--diagram')]
        .filter(host => {
          if (!host.isConnected || !container.contains(host)) return false
          const source = pageMermaidSource(host)
          return source === null || source.length <= MERMAID_MAX_TEXT_SIZE
        })
      const mermaidHosts = selectMermaidRenderHosts(mermaidCandidates)
      Prism.highlightAllUnder(container)
      setupCodeCopyShimmer(container)
      setupInlineCodeCopy(container)
      void renderPageMermaidDiagrams(
        container,
        this.$vuetify.theme.current.dark ? 'dark' : 'default',
        mermaidController.signal,
        () => this.mermaidAbortController === mermaidController,
        mermaidHosts
      )

      const currentPageUrl = window.location.href.replace(window.location.hash, '')
      container.querySelectorAll<HTMLAnchorElement>(`a[href^="#"], a[href^="${currentPageUrl}#"]`).forEach(anchor => {
        anchor.onclick = (event: MouseEvent) => {
          event.preventDefault()
          event.stopPropagation()
          this.scrollToPageAnchor(anchor.hash)
        }
      })
      this.contentExtensionCleanup?.()
      this.contentExtensionCleanup = hydrateContentExtensions(container, undefined, { mermaidHosts })
      this.outlineCleanup?.dispose()
      this.outlineCleanup = trackPageOutline(container, this.tocFlattened, anchor => {
        this.activeAnchor = anchor
        // Reveal after Vue has applied the new aria-current, so the ToC list
        // follows the row that is actually active instead of trailing one
        // highlight behind during fast scrolls.
        this.$nextTick(() => this.ensureActiveTocVisible())
      }, progress => { this.readingProgress = progress })
      this.setupTocResizeObserver()
      boot.notify('page-ready')
    },
    animatePageRoute(): void {
      this.routeAnimationAbortController?.abort()
      this.routeAnimationAbortController = null
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      const contentRef = this.$refs.content as HTMLElement | { $el?: unknown }
      const element = contentRef instanceof HTMLElement
        ? contentRef
        : contentRef.$el instanceof HTMLElement
          ? contentRef.$el
          : null
      if (!element) return
      const controller = markRaw(new AbortController())
      this.routeAnimationAbortController = controller
      element.classList.remove('page-main--route-enter')
      void element.offsetWidth
      element.classList.add('page-main--route-enter')
      element.addEventListener('animationend', () => {
        element.classList.remove('page-main--route-enter')
        if (this.routeAnimationAbortController === controller) {
          this.routeAnimationAbortController = null
        }
      }, { once: true, signal: controller.signal })
    },
    toggleToc () {
      this.tocExpanded = !this.tocExpanded
      this.$nextTick(() => this.ensureActiveTocVisible())
    },
    isBranchExpanded (anchor: string): boolean {
      const searchExpanded = this.tocQuery?.trim()
        ? getSearchExpandedAnchors(this.tocFlattened, this.tocQuery)
        : null
      return isBranchEffectivelyExpanded(
        anchor,
        this.expandedAnchors,
        searchExpanded,
        this.tocQuery?.trim() ? this.searchOverrides : null
      )
    },
    hasActiveDescendant (anchor: string): boolean {
      if (!this.activeAnchor || this.isBranchExpanded(anchor)) return false
      const ancestors = getAncestorAnchors(this.tocFlattened, this.activeAnchor)
      return ancestors.includes(anchor)
    },
    toggleBranch (anchor: string) {
      const currentlyExpanded = this.isBranchExpanded(anchor)
      const nextExpanded = !currentlyExpanded
      if (this.tocQuery?.trim()) {
        this.searchOverrides.set(anchor, nextExpanded)
      } else if (currentlyExpanded) {
        this.expandedAnchors.delete(anchor)
        this.collapsedByUser.add(anchor)
      } else {
        this.expandedAnchors.add(anchor)
        this.collapsedByUser.delete(anchor)
      }
      this.$nextTick(() => this.ensureActiveTocVisible())
    },
    tocLinkClicked (event: MouseEvent, anchor: string): void {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      event.stopPropagation()
      this.activeAnchor = anchor
      this.scrollToPageAnchor(anchor)
    },
    pageScrollTarget (destination: HTMLElement | null): number {
      if (!destination) return 0
      const styles = window.getComputedStyle(destination)
      const rawLayoutOffset = this.scrollOpts.layout ? parseFloat(styles.getPropertyValue('--v-layout-top')) : 0
      const layoutOffset = Number.isFinite(rawLayoutOffset) ? rawLayoutOffset : 0
      const rawOffset = Number(this.scrollOpts.offset)
      const offset = Number.isFinite(rawOffset) ? rawOffset : 0
      const target = destination.getBoundingClientRect().top + window.scrollY - layoutOffset + offset
      const scrollingElement = document.scrollingElement ?? document.documentElement
      const maximum = Math.max(0, scrollingElement.scrollHeight - window.innerHeight)
      return Math.min(maximum, Math.max(0, target))
    },
    animatePageScroll (target: number, destination: HTMLElement | null, focusDestination: boolean, token: number): void {
      const scrollingElement = document.scrollingElement ?? document.documentElement
      const setScrollTop = (value: number): void => {
        scrollingElement.scrollTop = value
        if (Math.abs(window.scrollY - value) > 0 && typeof window.scrollTo === 'function') window.scrollTo(0, value)
      }
      const finish = (): void => {
        if (token !== this.scrollAnimationToken) return
        this.scrollAnimationFrame = null
        if (focusDestination) {
          destination?.setAttribute('tabindex', '-1')
          destination?.focus({ preventScroll: true })
        }
      }
      const start = window.scrollY
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
      const duration = reducedMotion ? 0 : Math.max(0, Number(this.scrollOpts.duration) || 0)
      if (duration === 0 || Math.abs(target - start) < 1) {
        setScrollTop(target)
        finish()
        return
      }
      const startedAt = performance.now()
      let lastAnimatedPosition = start
      const step = (now: number): void => {
        if (token !== this.scrollAnimationToken) return
        if (Math.abs(window.scrollY - lastAnimatedPosition) > 2) {
          this.cancelScheduledScroll()
          return
        }
        const progress = Math.min(1, Math.max(0, (now - startedAt) / duration))
        const eased = progress < .5
          ? 4 * progress * progress * progress
          : 1 - (-2 * progress + 2) ** 3 / 2
        const location = Math.round(start + (target - start) * eased)
        lastAnimatedPosition = location
        setScrollTop(location)
        if (progress >= 1) finish()
        else this.scrollAnimationFrame = requestAnimationFrame(step)
      }
      this.scrollAnimationFrame = requestAnimationFrame(step)
    },
    scrollToPageAnchor(anchor: string, focusDestination = true) {
      const container = this.$refs.container as HTMLElement
      const decodedAnchor = decodePageAnchor(anchor)
      const activeEntry = this.tocFlattened.find(entry => decodePageAnchor(entry.anchor) === decodedAnchor)
      this.cancelScheduledScroll()
      if (activeEntry) {
        this.activeAnchor = activeEntry.anchor
        this.outlineCleanup?.setNavigationAnchor(activeEntry.anchor)
      }
      revealContentExtensionTarget(container, decodedAnchor)
      const id = decodedAnchor.replace(/^#/, '')
      const destination = container.id === id
        ? container
        : [...container.querySelectorAll<HTMLElement>('[id]')].find(element => element.id === id) ?? null
      const view = container.ownerDocument.defaultView
      const token = this.scrollAnimationToken
      const reveal = (): void => {
        if (token !== this.scrollAnimationToken) return
        this.scrollAnimationFrame = null
        this.animatePageScroll(this.pageScrollTarget(destination), destination, focusDestination, token)
      }
      if (view) this.scrollAnimationFrame = view.requestAnimationFrame(reveal)
      else reveal()
    },
    cancelScheduledScroll () {
      this.scrollAnimationToken += 1
      if (this.scrollAnimationFrame !== null) {
        cancelAnimationFrame(this.scrollAnimationFrame)
        this.scrollAnimationFrame = null
      }
      this.outlineCleanup?.setNavigationAnchor(null)
    },
    isCurrentPageAction (pageId: number, generation: number, requestId: number, currentRequestId: number): boolean {
      return (
        pageId === this.pageId &&
        generation === this.pageActionGeneration &&
        requestId === currentRequestId
      )
    },
    isCurrentApprovalAuthority (pageId: number, generation: number, requestId: number, authorityKey: string | null): boolean {
      return this.isCurrentPageAction(pageId, generation, requestId, this.approvalRequestId) &&
        this.pageOnlineActionReady &&
        this.approvalAuthorityReady &&
        authorityKey !== null &&
        this.approvalAuthorityReadyKey === authorityKey &&
        this.approvalAuthorityContextKey === authorityKey
    },
    async loadPageProtection (): Promise<boolean> {
      const pageId = this.pageId
      const generation = this.pageActionGeneration
      const requestId = ++this.protectionRequestId
      if (!this.pageOnlineActionReady) {
        if (pageId === this.pageId && generation === this.pageActionGeneration) {
          this.protectionAuthorityReady = false
          this.protectionInitialLoading = false
          this.protectionError = this.pageOnlineActionUnavailableReason
        }
        return false
      }
      this.protectionInitialLoading = true
      this.protectionAuthorityReady = false
      this.protectionError = ''
      try {
        const response = await fetch(`/_api/pages/${pageId}/protection`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
        if (!response.ok) throw new Error(this.$t('common:page.pageProtectionRequestError', { status: response.status }))
        const protection = await response.json() as PageProtection
        if (!this.isCurrentPageAction(pageId, generation, requestId, this.protectionRequestId) || !this.pageOnlineActionReady) return false
        this.pageProtection = protection
        this.protectionAuthorityReady = true
        return true
      } catch (error) {
        if (pageId !== this.pageId || generation !== this.pageActionGeneration || requestId !== this.protectionRequestId) return false
        this.protectionAuthorityReady = false
        this.protectionError = getErrorMessage(error)
        pushGraphError(wikiStore, error)
        return false
      } finally {
        if (pageId === this.pageId && generation === this.pageActionGeneration && requestId === this.protectionRequestId)
          this.protectionInitialLoading = false
      }
    },
    openPageProtection (): void {
      if (!this.pageOnlineActionReady) {
        this.protectionError = this.pageOnlineActionUnavailableReason
        return
      }
      this.pageProtectionPassword = ''
      this.protectionInitialLoading = true
      this.protectionError = ''
      this.protectionDialog = true
      void this.loadPageProtection()
    },
    async savePageProtection (): Promise<void> {
      if (this.protectionLoading || !this.pageProtectionActionReady) return
      const pageId = this.pageId
      const locale = this.locale
      const generation = this.pageActionGeneration
      const requestId = ++this.protectionRequestId
      const password = this.pageProtectionPassword
      const isCurrentProtection = (): boolean =>
        this.isCurrentPageAction(pageId, generation, requestId, this.protectionRequestId) &&
        this.locale === locale
      this.protectionLoading = true
      this.protectionAuthorityReady = false
      try {
        const response = await fetch(`/_api/pages/${pageId}/protection`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        })
        if (!response.ok) throw await this.approvalResponseError(response, this.$t('common:page.pageProtectionUpdateError'))
        const protection = await response.json() as PageProtection
        if (!isCurrentProtection()) return
        this.pageProtection = protection
        this.protectionAuthorityReady = true
        this.pageProtectionPassword = ''
        await this.updateOfflineAdmission('ineligible')
        if (!isCurrentProtection()) return
        showNotification(wikiStore, {
          style: 'success',
          message: protection.version > 1 ? this.$t('common:page.passwordRotatedSuccess') : this.$t('common:page.passwordProtectionEnabledSuccess')
        })
      } catch (error) {
        if (!isCurrentProtection()) return
        this.protectionAuthorityReady = false
        this.protectionError = getErrorMessage(error)
        pushGraphError(wikiStore, error)
      } finally {
        if (isCurrentProtection()) this.protectionLoading = false
      }
    },
    async removePageProtection (): Promise<void> {
      if (this.protectionLoading || !this.pageProtectionActionReady) return
      const pageId = this.pageId
      const locale = this.locale
      const generation = this.pageActionGeneration
      const requestId = ++this.protectionRequestId
      const isCurrentProtection = (): boolean =>
        this.isCurrentPageAction(pageId, generation, requestId, this.protectionRequestId) &&
        this.locale === locale
      this.protectionLoading = true
      this.protectionAuthorityReady = false
      try {
        const response = await fetch(`/_api/pages/${pageId}/protection`, {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
        if (!response.ok) throw await this.approvalResponseError(response, this.$t('common:page.pageProtectionRemovalError'))
        if (!isCurrentProtection()) return
        this.pageProtection = { protected: false, version: 0, updatedBy: null, updatedAt: null }
        this.protectionAuthorityReady = true
        this.pageProtectionPassword = ''
        await this.updateOfflineAdmission('unknown')
        if (!isCurrentProtection()) return
        showNotification(wikiStore, { style: 'success', message: this.$t('common:page.passwordProtectionRemovedSuccess') })
      } catch (error) {
        if (!isCurrentProtection()) return
        this.protectionAuthorityReady = false
        this.protectionError = getErrorMessage(error)
        pushGraphError(wikiStore, error)
      } finally {
        if (isCurrentProtection()) this.protectionLoading = false
      }
    },
    approvalStatusLabel (status: string) {
      const key = `common:page.approvalStatus.${status}`
      const translated = this.$t(key)
      return translated === key ? status.replaceAll('-', ' ').replace(/\b\w/g, value => value.toUpperCase()) : translated
    },
    async approvalResponseError (response: Response, fallback: string): Promise<Error> {
      const payload = await response.json().catch(() => ({})) as { error?: unknown }
      return new Error(typeof payload.error === 'string' ? payload.error : `${fallback} (${response.status})`)
    },
    async loadPageApproval (): Promise<boolean> {
      const pageId = this.pageId
      const generation = this.pageActionGeneration
      const requestId = ++this.approvalRequestId
      const actorTransportKey = this.pageAuthorityKey
      const resourceKey = this.approvalResourceKey
      const isCurrentRead = (): boolean =>
        this.isCurrentPageAction(pageId, generation, requestId, this.approvalRequestId) &&
        actorTransportKey === this.pageAuthorityKey
      this.approvalAuthorityReady = false
      this.approvalAuthorityReadyKey = null
      this.approvalInitialLoading = true
      this.approvalError = ''
      if (!this.pageOnlineActionReady) {
        if (isCurrentRead()) {
          this.approvalInitialLoading = false
          this.approvalError = this.pageOnlineActionUnavailableReason
        }
        return false
      }
      try {
        const response = await fetch(`/_api/pages/${pageId}/approval`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
        if (!isCurrentRead() || !this.pageOnlineActionReady) return false
        if (!response.ok) throw await this.approvalResponseError(response, this.$t('common:page.pageApprovalRequestError'))
        const payload = await response.json() as { approval?: unknown }
        if (!isCurrentRead() || !this.pageOnlineActionReady || this.approvalResourceKey !== resourceKey) return false
        this.pageApproval = payload.approval && typeof payload.approval === 'object' ? payload.approval as PageApproval : null
        this.approvalAssigneeId = this.pageApproval?.assigneeId ?? null
        const authorityKey = this.approvalAuthorityContextKey
        if (!isCurrentRead() ||
          !this.pageOnlineActionReady ||
          authorityKey !== this.approvalAuthorityContextKey) return false
        this.approvalAuthorityReadyKey = authorityKey
        this.approvalAuthorityReady = true
        return true
      } catch (error) {
        if (!isCurrentRead() || this.approvalResourceKey !== resourceKey) return false
        this.approvalAuthorityReady = false
        this.approvalAuthorityReadyKey = null
        this.approvalError = getErrorMessage(error)
        pushGraphError(wikiStore, error)
        return false
      } finally {
        if (requestId === this.approvalRequestId) this.approvalInitialLoading = false
      }
    },
    openApprovalWorkflow () {
      this.approvalComment = ''
      this.approvalError = ''
      this.approvalDialog = true
      void this.loadPageApproval()
    },
    async submitPageApproval () {
      if (this.approvalLoading) return
      const pageId = this.pageId
      const generation = this.pageActionGeneration
      const requestId = this.approvalRequestId
      const authorityKey = this.approvalAuthorityReadyKey
      const actorTransportKey = this.pageAuthorityKey
      if (!this.isCurrentApprovalAuthority(pageId, generation, requestId, authorityKey)) return
      const expectedSourceRevision = this.sourceRevision
      const mutationId = ++this.approvalMutationId
      this.approvalLoading = true
      try {
        if (!this.isCurrentApprovalAuthority(pageId, generation, requestId, authorityKey)) return
        const response = await fetch(`/_api/pages/${pageId}/approval`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedSourceRevision,
            ...(this.approvalAssigneeId && this.approvalAssigneeId > 0 ? { assigneeId: this.approvalAssigneeId } : {}),
            ...(this.approvalComment.trim() ? { comment: this.approvalComment.trim() } : {})
          })
        })
        if (
          pageId !== this.pageId ||
          generation !== this.pageActionGeneration ||
          mutationId !== this.approvalMutationId ||
          requestId !== this.approvalRequestId ||
          actorTransportKey !== this.pageAuthorityKey ||
          !this.pageOnlineActionReady ||
          this.approvalAuthorityReadyKey !== authorityKey ||
          this.approvalAuthorityContextKey !== authorityKey
        ) return
        if (!response.ok) throw await this.approvalResponseError(response, this.$t('common:page.approvalSubmissionError'))
        if (
          pageId !== this.pageId ||
          generation !== this.pageActionGeneration ||
          mutationId !== this.approvalMutationId ||
          actorTransportKey !== this.pageAuthorityKey ||
          !this.pageOnlineActionReady
        ) return
        const [approvalAccepted] = await Promise.all([this.loadPageApproval(), useSiteNotificationsStore().refresh()])
        if (
          pageId !== this.pageId ||
          generation !== this.pageActionGeneration ||
          mutationId !== this.approvalMutationId ||
          actorTransportKey !== this.pageAuthorityKey ||
          !approvalAccepted ||
          !this.approvalActionReady
        ) return
        this.approvalComment = ''
        showNotification(wikiStore, { style: 'success', message: this.$t('common:page.approvalSubmittedSuccess') })
      } catch (error) {
        if (
          pageId !== this.pageId ||
          generation !== this.pageActionGeneration ||
          mutationId !== this.approvalMutationId ||
          requestId !== this.approvalRequestId ||
          actorTransportKey !== this.pageAuthorityKey ||
          !this.pageOnlineActionReady ||
          this.approvalAuthorityContextKey !== authorityKey
        ) return
        this.approvalAuthorityReady = false
        this.approvalAuthorityReadyKey = null
        pushGraphError(wikiStore, error)
      } finally {
        if (
          pageId === this.pageId &&
          generation === this.pageActionGeneration &&
          mutationId === this.approvalMutationId
        ) this.approvalLoading = false
      }
    },
    async transitionPageApproval (action: 'approve' | 'request-changes' | 'reject' | 'cancel' | 'resubmit' | 'publish' | 'reassign') {
      if (!this.pageApproval || this.approvalLoading) return
      const pageId = this.pageId
      const generation = this.pageActionGeneration
      const requestId = this.approvalRequestId
      const approvalId = this.pageApproval.id
      const authorityKey = this.approvalAuthorityReadyKey
      const actorTransportKey = this.pageAuthorityKey
      if (!this.isCurrentApprovalAuthority(pageId, generation, requestId, authorityKey)) return
      const expectedSourceRevision = action === 'resubmit' ? this.sourceRevision : undefined
      const mutationId = ++this.approvalMutationId
      this.approvalLoading = true
      try {
        if (!this.isCurrentApprovalAuthority(pageId, generation, requestId, authorityKey)) return
        const response = await fetch(`/_api/pages/approvals/${encodeURIComponent(approvalId)}/transition`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            ...(expectedSourceRevision !== undefined ? { expectedSourceRevision } : {}),
            ...(this.approvalComment.trim() ? { comment: this.approvalComment.trim() } : {}),
            ...(action === 'reassign' && this.approvalAssigneeId && this.approvalAssigneeId > 0 ? { assigneeId: this.approvalAssigneeId } : {})
          })
        })
        if (
          pageId !== this.pageId ||
          generation !== this.pageActionGeneration ||
          mutationId !== this.approvalMutationId ||
          requestId !== this.approvalRequestId ||
          actorTransportKey !== this.pageAuthorityKey ||
          !this.pageOnlineActionReady ||
          this.approvalAuthorityReadyKey !== authorityKey ||
          this.approvalAuthorityContextKey !== authorityKey
        ) return
        if (!response.ok) throw await this.approvalResponseError(response, this.$t('common:page.approvalTransitionError'))
        if (
          pageId !== this.pageId ||
          generation !== this.pageActionGeneration ||
          mutationId !== this.approvalMutationId ||
          actorTransportKey !== this.pageAuthorityKey ||
          !this.pageOnlineActionReady
        ) return
        const [approvalAccepted] = await Promise.all([this.loadPageApproval(), useSiteNotificationsStore().refresh()])
        if (
          pageId !== this.pageId ||
          generation !== this.pageActionGeneration ||
          mutationId !== this.approvalMutationId ||
          actorTransportKey !== this.pageAuthorityKey ||
          !approvalAccepted ||
          !this.approvalActionReady
        ) return
        this.approvalComment = ''
        showNotification(wikiStore, { style: 'success', message: this.$t('common:page.approvalTransitionSuccess') })
      } catch (error) {
        if (
          pageId !== this.pageId ||
          generation !== this.pageActionGeneration ||
          mutationId !== this.approvalMutationId ||
          requestId !== this.approvalRequestId ||
          actorTransportKey !== this.pageAuthorityKey ||
          !this.pageOnlineActionReady ||
          this.approvalAuthorityContextKey !== authorityKey
        ) return
        this.approvalAuthorityReady = false
        this.approvalAuthorityReadyKey = null
        pushGraphError(wikiStore, error)
      } finally {
        if (
          pageId === this.pageId &&
          generation === this.pageActionGeneration &&
          mutationId === this.approvalMutationId
        ) this.approvalLoading = false
      }
    },
    async loadPageWatchState (): Promise<boolean> {
      const pageId = this.pageId
      const generation = this.pageActionGeneration
      const requestId = ++this.pageWatchRequestId
      if (!this.pageOnlineActionReady) {
        if (pageId === this.pageId && generation === this.pageActionGeneration) {
          this.pageWatchAuthorityReady = false
          this.pageWatchLoading = false
        }
        return false
      }
      this.pageWatchLoading = true
      this.pageWatchAuthorityReady = false
      try {
        const response = await fetch(`/_api/pages/${pageId}/watch`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
        if (!response.ok) throw new Error(this.$t('common:page.pageWatchRequestError', { status: response.status }))
        const payload = await response.json() as { watched?: unknown; emailEnabled?: unknown; inAppEnabled?: unknown }
        if (!this.isCurrentPageAction(pageId, generation, requestId, this.pageWatchRequestId) || !this.pageOnlineActionReady) return false
        this.pageWatched = payload.watched === true
        this.pageWatchEmailEnabled = payload.emailEnabled === true
        this.pageWatchInAppEnabled = payload.inAppEnabled === true
        this.pageWatchAuthorityReady = true
        return true
      } catch (error) {
        if (pageId !== this.pageId || generation !== this.pageActionGeneration || requestId !== this.pageWatchRequestId) return false
        this.pageWatchAuthorityReady = false
        pushGraphError(wikiStore, error)
        return false
      } finally {
        if (pageId === this.pageId && generation === this.pageActionGeneration && requestId === this.pageWatchRequestId)
          this.pageWatchLoading = false
      }
    },
    async togglePageWatch (): Promise<void> {
      if (this.pageWatchLoading || !this.pageOnlineActionReady || !this.pageWatchAuthorityReady) return
      if (!await this.loadPageWatchState() || !this.pageWatchActionReady) return
      const pageId = this.pageId
      const generation = this.pageActionGeneration
      const requestId = ++this.pageWatchRequestId
      const watched = this.pageWatched
      this.pageWatchLoading = true
      this.pageWatchAuthorityReady = false
      try {
        const response = await fetch(`/_api/pages/${pageId}/watch`, {
          method: watched ? 'DELETE' : 'PUT',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
        if (!response.ok) throw new Error(this.$t('common:page.pageWatchRequestError', { status: response.status }))
        const payload = await response.json() as { watched?: unknown; emailEnabled?: unknown; inAppEnabled?: unknown }
        if (!this.isCurrentPageAction(pageId, generation, requestId, this.pageWatchRequestId) || !this.pageOnlineActionReady) return
        this.pageWatched = payload.watched === true
        if (this.pageWatched) {
          this.pageWatchEmailEnabled = payload.emailEnabled === true
          this.pageWatchInAppEnabled = payload.inAppEnabled === true
        }
        this.pageWatchAuthorityReady = true
        showNotification(wikiStore, {
          style: 'success',
          message: this.pageWatched ? this.$t('common:page.watchEnabled') : this.$t('common:page.watchDisabled')
        })
      } catch (error) {
        if (pageId !== this.pageId || generation !== this.pageActionGeneration || requestId !== this.pageWatchRequestId) return
        this.pageWatchAuthorityReady = false
        pushGraphError(wikiStore, error)
      } finally {
        if (pageId === this.pageId && generation === this.pageActionGeneration && requestId === this.pageWatchRequestId)
          this.pageWatchLoading = false
      }
    },
    async savePageWatchSettings (): Promise<void> {
      if (!this.pageWatched || this.pageWatchLoading || !this.pageWatchActionReady) return
      const emailEnabled = this.pageWatchEmailEnabled
      const inAppEnabled = this.pageWatchInAppEnabled
      if (!await this.loadPageWatchState() || !this.pageWatchActionReady || !this.pageWatched) return
      this.pageWatchEmailEnabled = emailEnabled
      this.pageWatchInAppEnabled = inAppEnabled
      const pageId = this.pageId
      const generation = this.pageActionGeneration
      const requestId = ++this.pageWatchRequestId
      this.pageWatchLoading = true
      this.pageWatchAuthorityReady = false
      try {
        const response = await fetch(`/_api/pages/${pageId}/watch`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ emailEnabled, inAppEnabled })
        })
        if (!response.ok) throw new Error(this.$t('common:page.pageWatchSettingsRequestError', { status: response.status }))
        const payload = await response.json() as { watched?: unknown; emailEnabled?: unknown; inAppEnabled?: unknown }
        if (!this.isCurrentPageAction(pageId, generation, requestId, this.pageWatchRequestId) || !this.pageOnlineActionReady) return
        this.pageWatched = payload.watched === true
        this.pageWatchEmailEnabled = payload.emailEnabled === true
        this.pageWatchInAppEnabled = payload.inAppEnabled === true
        this.pageWatchAuthorityReady = true
      } catch (error) {
        if (pageId !== this.pageId || generation !== this.pageActionGeneration || requestId !== this.pageWatchRequestId) return
        this.pageWatchAuthorityReady = false
        pushGraphError(wikiStore, error)
      } finally {
        if (pageId === this.pageId && generation === this.pageActionGeneration && requestId === this.pageWatchRequestId)
          this.pageWatchLoading = false
      }
    },
    sidebarNavigationStarted () {
      if (this.$vuetify.display.width < 1280) this.navShown = false
    },
    toggleNavigation () {
      const shown = !this.navShown
      this.navShown = shown
      if (shown) {
        this.$nextTick(() => {
          document.querySelector<HTMLElement>('#page-navigation-drawer .nav-sidebar button, #page-navigation-drawer .nav-sidebar a')?.focus()
        })
      }
    },
    upBtnScroll () {
      this.upBtnShown = window.scrollY > window.innerHeight * 0.33
    },
    focusPageTitle () {
      const heading = this.$refs.pageTitle as HTMLElement | undefined
      heading?.setAttribute('tabindex', '-1')
      heading?.focus({ preventScroll: true })
    },
    returnToTop () {
      this.cancelScheduledScroll()
      void this.goTo(0, this.scrollOpts)
      this.$nextTick(() => this.focusPageTitle())
    },
    navigationVisibilityChanged (shown: boolean) {
      if (this.readerFocus) return
      if (shown) {
        this.$nextTick(() => {
          document.querySelector<HTMLElement>('#page-navigation-drawer .nav-sidebar button, #page-navigation-drawer .nav-sidebar a')?.focus()
        })
      } else {
        this.$nextTick(() => {
          const navToggle = this.$refs.navToggle as HTMLElement | { $el?: unknown } | undefined
          const element = navToggle instanceof HTMLElement
            ? navToggle
            : navToggle?.$el instanceof HTMLElement
              ? navToggle.$el
              : null
          element?.focus()
        })
      }
    },
    preparePrintView () {
      if (this.printViewBeforePrint === null) {
        this.printViewBeforePrint = this.printView
      }
      this.printView = true
      if (this.printDetailsState === null) {
        const container = this.$refs.container as HTMLElement | undefined
        const details = Array.from(container?.querySelectorAll<HTMLDetailsElement>('details') ?? [])
        this.printDetailsState = markRaw(new Map(details.map(detail => [detail, detail.open])))
        for (const detail of details) detail.open = true
      }
    },
    print () {
      this.restorePrintView()
      this.preparePrintView()
      this.$nextTick(() => {
        window.print()
      })
    },
    restorePrintView () {
      if (this.printDetailsState !== null) {
        for (const [detail, open] of this.printDetailsState) detail.open = open
        this.printDetailsState = null
      }
      if (this.printViewBeforePrint !== null) {
        this.printView = this.printViewBeforePrint
        this.printViewBeforePrint = null
      }
    },
    pageEdit () {
      emitPageEdit()
    },
    historyLinkClicked (event: MouseEvent) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      this.pageHistory()
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
      const previousWidth = this.winWidth
      const nextWidth = window.innerWidth
      if (nextWidth === previousWidth) { return }
      this.markDesktopRailAlignmentDirty()
      this.winWidth = nextWidth
      if (previousWidth >= 1280 && nextWidth < 1280) {
        this.tocExpanded = false
      }
      if (nextWidth >= 1280) {
        this.navShown = true
      } else {
        this.navShown = false
      }
    },
    markDesktopRailAlignmentDirty(): void {
      this.railAlignmentDirty = true
    },
    resetDesktopRailMeasurementState(): void {
      this.cancelDesktopRailSettling()
      if (this.cachedRailEl) {
        this.cachedRailEl.style.removeProperty('--page-desktop-rail-max-height')
        this.cachedRailEl.style.removeProperty('--page-desktop-rail-align-offset')
      }
      this.cachedRailEl = null
      this.navFooterEl = null
      this.lastRailMaxHeight = -1
      this.lastRailAlignmentOffset = null
      this.railAlignmentDirty = true
    },
    selectPageView(value: unknown): void {
      if (value === 'article' || value === 'talk') this.$emit('update:activeView', value)
    },
    goToComments (focusNewComment = false) {
      this.cancelScheduledScroll()
      if (!this.commentsExternal) this.$emit('update:activeView', 'talk')
      this.$nextTick(() => {
        void this.goTo('#discussion', this.scrollOpts)
        if (focusNewComment) document.querySelector<HTMLElement>('#discussion-new')?.focus()
      })
    },
    getPageHeaderElement(): HTMLElement | null {
      const heroRef = this.$refs.pageHero as { $el?: HTMLElement } | HTMLElement | undefined
      if (heroRef && '$el' in heroRef && heroRef.$el instanceof HTMLElement) {
        return heroRef.$el
      }
      if (heroRef instanceof HTMLElement) {
        return heroRef
      }
      if (typeof document !== 'undefined') {
        return (document.querySelector('.page-hero') as HTMLElement | null)
          ?? (document.querySelector('.page-header-section') as HTMLElement | null)
      }
      return null
    },
    getPageTitleElement(): HTMLElement | null {
      const titleRef = this.$refs.pageTitle as HTMLElement | undefined
      if (titleRef instanceof HTMLElement) return titleRef
      if (typeof document !== 'undefined') return document.querySelector('.page-title')
      return null
    },
    setupDesktopRailObserver(): void {
      if (typeof window === 'undefined' || typeof ResizeObserver === 'undefined') return

      if (!this.railResizeObserver) {
        this.railResizeObserver = new ResizeObserver(() => {
          this.markDesktopRailAlignmentDirty()
          this.updateDesktopRailMeasurements(true)
          this.startDesktopRailSettling()
        })
      }

      const headerEl = this.getPageHeaderElement()
      if (headerEl !== this.cachedHeaderEl) {
        this.markDesktopRailAlignmentDirty()
        if (this.cachedHeaderEl) {
          try {
            this.railResizeObserver.unobserve(this.cachedHeaderEl)
          } catch {}
        }
        this.cachedHeaderEl = headerEl
        if (headerEl) this.railResizeObserver.observe(headerEl)
      }

      const titleEl = this.getPageTitleElement()
      if (titleEl !== this.cachedTitleEl) {
        this.markDesktopRailAlignmentDirty()
        if (this.cachedTitleEl) {
          try {
            this.railResizeObserver.unobserve(this.cachedTitleEl)
          } catch {}
        }
        this.cachedTitleEl = titleEl
        if (titleEl) this.railResizeObserver.observe(titleEl)
      }
    },
    getDesktopRailElement(): HTMLElement | null {
      const colRef = this.$refs.desktopRailCol as { $el?: HTMLElement } | HTMLElement | undefined
      if (colRef && '$el' in colRef && colRef.$el instanceof HTMLElement) {
        return colRef.$el
      }
      if (colRef instanceof HTMLElement) {
        return colRef
      }
      const innerRef = this.$refs.desktopRail as HTMLElement | undefined
      if (innerRef instanceof HTMLElement) {
        return innerRef.closest('.page-col-sd') ?? innerRef.parentElement
      }
      if (typeof document !== 'undefined') {
        return document.querySelector('.page-col-sd')
      }
      return null
    },
    onDesktopRailScroll(): void {
      if (this.railRafId) return
      this.railRafId = window.requestAnimationFrame(() => {
        this.railRafId = 0
        this.updateDesktopRailMeasurements(false)
      })
    },
    cancelDesktopRailSettling(): void {
      if (this.railSettleRafId) {
        window.cancelAnimationFrame(this.railSettleRafId)
        this.railSettleRafId = 0
      }
    },
    startDesktopRailSettling(): void {
      if (typeof window === 'undefined') return
      this.markDesktopRailAlignmentDirty()
      if (window.innerWidth < 1280 || this.tocPosition === 'off') {
        this.cancelDesktopRailSettling()
        return
      }

      this.cancelDesktopRailSettling()
      this.railSettleFrameCount = 0
      this.railSettleStableFrames = 0
      this.lastSampledRailTop = -1

      if (!this.railSettleHandler) {
        this.railSettleHandler = () => this.stepDesktopRailSettling()
      }
      this.railSettleRafId = window.requestAnimationFrame(this.railSettleHandler)
    },
    stepDesktopRailSettling(): void {
      this.railSettleRafId = 0
      if (typeof window === 'undefined') return
      if (window.innerWidth < 1280 || this.tocPosition === 'off') return

      const railEl = (this.cachedRailEl && this.cachedRailEl.isConnected)
        ? this.cachedRailEl
        : this.getDesktopRailElement()
      this.cachedRailEl = railEl
      if (!railEl) {
        this.railSettleFrameCount++
        if (this.railSettleFrameCount < 120) {
          this.railSettleRafId = window.requestAnimationFrame(this.railSettleHandler!)
        }
        return
      }

      const currentTop = railEl.getBoundingClientRect().top
      this.railSettleFrameCount++

      const topChanged = this.lastSampledRailTop === -1 || Math.abs(currentTop - this.lastSampledRailTop) >= 0.5
      if (topChanged) {
        this.lastSampledRailTop = currentTop
        this.railSettleStableFrames = 0
        this.updateDesktopRailMeasurements(true)
      } else {
        this.railSettleStableFrames++
      }

      const MAX_SETTLE_FRAMES = 120
      const MIN_SETTLE_FRAMES = 60
      const STABLE_FRAMES_NEEDED = 15

      const isStable = this.railSettleFrameCount >= MIN_SETTLE_FRAMES && this.railSettleStableFrames >= STABLE_FRAMES_NEEDED
      const reachedMax = this.railSettleFrameCount >= MAX_SETTLE_FRAMES

      if (!isStable && !reachedMax) {
        this.railSettleRafId = window.requestAnimationFrame(this.railSettleHandler!)
      } else {
        this.updateDesktopRailMeasurements(true)
      }
    },
    updateDesktopRailMeasurements(isResize = false): void {
      if (typeof window === 'undefined') return
      if (isResize) this.markDesktopRailAlignmentDirty()

      const previousRailEl = this.cachedRailEl
      const railEl = (this.cachedRailEl && this.cachedRailEl.isConnected)
        ? this.cachedRailEl
        : this.getDesktopRailElement()
      if (railEl !== previousRailEl) this.markDesktopRailAlignmentDirty()
      this.cachedRailEl = railEl
      if (!railEl) return

      if (window.innerWidth < 1280 || this.tocPosition === 'off') {
        this.resetDesktopRailMeasurementState()
        return
      }

      if (isResize || !this.navFooterEl || !this.navFooterEl.isConnected) {
        this.navFooterEl = document.querySelector('.nav-footer')
        const computed = getComputedStyle(railEl)
        const parsedTop = parseFloat(computed.top)
        this.railStickyTop = Number.isFinite(parsedTop) ? parsedTop : 80
        const rawGap = computed.getPropertyValue('--wiki-space-2').trim()
        let resolvedGap = 8
        if (rawGap.endsWith('px')) {
          const parsed = parseFloat(rawGap)
          if (Number.isFinite(parsed) && parsed > 0) resolvedGap = parsed
        } else if (rawGap.endsWith('rem')) {
          const remVal = parseFloat(rawGap)
          if (Number.isFinite(remVal) && remVal > 0) {
            const rootFontSize = typeof document !== 'undefined'
              ? (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16)
              : 16
            const derived = remVal * rootFontSize
            if (Number.isFinite(derived) && derived > 0) resolvedGap = derived
          }
        }
        this.railSpacingGap = Number.isFinite(resolvedGap) && resolvedGap > 0 ? resolvedGap : 8
      }

      let railRect = railEl.getBoundingClientRect()
      if (window.scrollY <= 1 && (isResize || this.railAlignmentDirty)) {
        const heroEl = this.getPageHeaderElement()
        const toolsEl = railEl.querySelector('.page-tools-card')
        const heroRect = heroEl?.getBoundingClientRect()
        const toolsRect = toolsEl?.getBoundingClientRect()
        if (heroRect && toolsRect && toolsRect.height > 0 && railRect.height > 0) {
          const inlineOffset = parseFloat(railEl.style.getPropertyValue('--page-desktop-rail-align-offset'))
          const currentOffset = this.lastRailAlignmentOffset ?? (Number.isFinite(inlineOffset) ? inlineOffset : 0)
          // The seam between the utilities/metadata card and the page contents
          // card rests on the boundary between the page header (hero) and the
          // page reader area. The card gap is space-4, so the seam midpoint
          // sits railSpacingGap (space-2) below the utilities card bottom.
          const currentSeam = toolsRect.bottom + this.railSpacingGap
          const nextOffset = currentOffset + heroRect.bottom - currentSeam
          if (Number.isFinite(nextOffset)) {
            if (this.lastRailAlignmentOffset === null || Math.abs(nextOffset - currentOffset) >= 0.25) {
              this.lastRailAlignmentOffset = nextOffset
              railEl.style.setProperty('--page-desktop-rail-align-offset', `${nextOffset}px`)
              railRect = railEl.getBoundingClientRect()
            }
            this.railAlignmentDirty = false
          }
        }
      }

      const footerTop = this.navFooterEl
        ? this.navFooterEl.getBoundingClientRect().top
        : window.innerHeight
      const boundedBottom = Math.min(window.innerHeight, footerTop)
      const effectiveRailTop = Math.max(railRect.top, this.railStickyTop)
      const calculatedMaxHeight = Math.max(0, Math.floor(boundedBottom - effectiveRailTop - this.railSpacingGap))

      if (this.lastRailMaxHeight !== calculatedMaxHeight) {
        this.lastRailMaxHeight = calculatedMaxHeight
        railEl.style.setProperty('--page-desktop-rail-max-height', `${calculatedMaxHeight}px`)
      }
    },
  }
})
</script>

<style lang="scss">
.wiki-page {
  --page-toc-empty-height: calc(var(--wiki-grid-size) * 2);
  --page-toc-desktop-lift: calc(var(--page-toc-empty-height) + var(--wiki-space-6));
  --page-layout-shell-max: 132rem;
  --page-reader-shell-max: var(--page-layout-shell-max);
  --page-metadata-rail-width: clamp(15rem, 18vw, 17rem);
  --page-reader-column-gap: var(--wiki-space-6);
  --page-reader-copy-max: var(--wiki-reader-copy-width, 74ch);

  font-family: var(--wiki-font-body);
}

// The document identity and outline use the same quiet editorial hierarchy.
.page-skip-link {
  position: fixed;
  inset-block-start: .5rem;
  inset-inline-start: 1rem;
  z-index: 3000;
  padding: .75rem 1rem;
  border-radius: var(--wiki-control-radius);
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
  transform: translateY(-200%);
  &:focus { transform: translateY(0); }
}

.page-document-label {
  display: flex;
  align-items: center;
  gap: .5rem;
  margin-block-end: .625rem;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 65%, transparent);
  font-size: .6875rem;
  font-weight: 650;
  letter-spacing: .12em;
  text-transform: uppercase;
}

.page-document-provenance {
  display: flex;
  min-width: 0;
  flex: 0 1 auto;
  flex-wrap: wrap;
  gap: 2px 5px;
}


.page-header-control-pair {
  display: flex;
  min-width: 0;
  max-width: 100%;
  flex: 1 1 auto;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--wiki-space-2);
  margin-inline-start: auto;
  margin-block-start: calc(var(--wiki-space-1) - 2px);
}

.page-header-offline {
  display: flex;
  min-width: 0;
  max-width: min(100%, 34rem);
  flex: 0 1 auto;
  align-items: center;
  gap: var(--wiki-space-2);
}

.page-header-offline-status {
  min-width: 0;
  overflow-wrap: anywhere;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
  font-size: .75rem;
  line-height: 1.35;
}

.page-header-offline-status--saved,
.page-header-offline-status--expiring {
  color: var(--wiki-accent-warm);
}

.page-header-offline-status--quiet {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.page-header-offline-status--stale,
.page-header-offline-status--sync-pending,
.page-header-offline-status--ineligible {
  color: rgb(var(--v-theme-warning));
}

.page-header-offline-status--error,
.page-header-offline-status--unavailable {
  color: rgb(var(--v-theme-error));
}

.page-offline-control,
.page-offline-retry-control {
  flex: 0 0 auto;
}

.page-offline-control {
  width: 26px !important;
  height: 26px !important;
  min-width: 26px !important;
  min-height: 26px !important;
  padding: 0 !important;
  border: 1px solid color-mix(in srgb, var(--wiki-accent-ink) 24%, var(--wiki-surface-border)) !important;
  background: color-mix(in srgb, var(--wiki-accent-ink) 8%, transparent) !important;
  color: var(--wiki-accent-ink) !important;
  transition:
    border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    background var(--wiki-motion-fast) var(--wiki-motion-ease),
    color var(--wiki-motion-fast) var(--wiki-motion-ease);

  &:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--wiki-accent-ink) 44%, var(--wiki-surface-border)) !important;
    background: color-mix(in srgb, var(--wiki-accent-ink) 14%, transparent) !important;
  }

  .v-icon {
    font-size: .875rem !important;
  }

  &--saved,
  &--expiring {
    border-color: color-mix(in srgb, var(--wiki-accent-warm) 44%, var(--wiki-surface-border)) !important;
    background: color-mix(in srgb, var(--wiki-accent-warm) 13%, transparent) !important;
    color: var(--wiki-accent-warm) !important;
  }

  &--stale,
  &--sync-pending,
  &--error,
  &--unavailable,
  &--ineligible {
    border-color: color-mix(in srgb, var(--wiki-accent-warm) 46%, var(--wiki-surface-border)) !important;
    background: color-mix(in srgb, var(--wiki-accent-warm) 9%, transparent) !important;
    color: var(--wiki-accent-warm) !important;
  }
}

.page-offline-retry-control {
  width: 26px !important;
  height: 26px !important;
  min-width: 26px !important;
  min-height: 26px !important;
  padding: 0 !important;

  .v-icon {
    font-size: .875rem !important;
  }
}

.page-document-row {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.page-document-row--date {
  color: rgb(var(--v-theme-on-surface));
  font-weight: 550;
}

.page-document-row--author {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
}

.page-tools-history-link {
  padding: 2px 4px;
  min-height: 32px;
}

@media (pointer: coarse) {
  .page-tools-history-link {
    min-width: 44px !important;
    min-height: 44px !important;
  }

  .page-offline-control,
  .page-offline-retry-control,
  .page-focus-control {
    height: 32px !important;
    min-height: 32px !important;
  }

  .page-offline-control,
  .page-offline-retry-control {
    width: 32px !important;
    min-width: 32px !important;
  }

  .page-focus-control {
    min-width: 32px !important;
    padding-inline-end: var(--wiki-space-2);
    padding-block-end: 0 !important;
  }
}

.page-toc-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--wiki-accent-ink);
  font-family: var(--wiki-font-body);
  font-size: .8125rem;
  font-weight: var(--wiki-label-weight) !important;
  letter-spacing: .09em !important;
  text-transform: uppercase;
}

.page-toc-count {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 65%, transparent);
  font-family: var(--wiki-font-mono);
  font-size: .6875rem;
}

// Accessible clarification of the section count, hidden visually.
.page-toc-heading .d-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.page-toc-filter {
  margin: .5rem .75rem;
  .v-field { border-radius: .5rem; }
  .v-field__input, .v-label { font-size: .8125rem; }
}

.page-toc-filter-empty {
  padding: .75rem 1rem;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 65%, transparent);
  font-size: .8125rem;
}

.page-toc-item[aria-current='location'] {
  border-inline-start-color: rgb(var(--v-theme-primary));
  background: color-mix(in srgb, var(--wiki-accent-warm) 10%, transparent);
  color: var(--wiki-accent-ink);
}

.page-main {
  --page-reader-background: rgb(var(--v-theme-background));
  transition: none;
  background: var(--page-reader-background);
}
.page-main--route-enter {
  .page-header-headings,
  .page-body > .v-row {
    animation: wiki-page-route-enter var(--wiki-motion-normal) var(--wiki-motion-ease-out) both;
  }
}

@keyframes wiki-page-route-enter {
  from {
    opacity: 0;
    transform: translateY(var(--wiki-space-2));
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}


.page-navigation {
  border-inline-end: 1px solid var(--wiki-surface-border) !important;
  box-shadow: none !important;
}

.page-nav-scroll {
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--wiki-accent-warm) 6%, rgb(var(--v-theme-surface))),
      rgb(var(--v-theme-surface)) calc(var(--wiki-grid-size) * 3)
    );
}

.page-edit-fab,
.page-nav-toggle,
.page-return-top {
  position: fixed !important;
  z-index: 1005;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-primary)) 14%, transparent);
  box-shadow: var(--wiki-shadow-md) !important;
  transition:
    transform var(--wiki-motion-normal) var(--wiki-motion-ease-out),
    box-shadow var(--wiki-motion-normal) var(--wiki-motion-ease);

  &:hover {
    box-shadow: var(--wiki-shadow-lg) !important;
    transform: translateY(calc(var(--wiki-space-1) * -.5));
  }
}

.v-speed-dial__content {
  gap: var(--wiki-space-2);

  > .v-btn {
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-control-radius) !important;
    box-shadow: var(--wiki-shadow-sm);
  }

  > .v-btn.bg-white {
    background: var(--wiki-surface-raised) !important;
    color: rgb(var(--v-theme-on-surface)) !important;
  }
}

.page-edit-fab {
  inset-block-end: calc(var(--v-layout-bottom, 0px) + var(--wiki-space-5));
  inset-inline-end: calc(var(--wiki-space-5) + var(--wiki-control-height) + var(--wiki-space-3));
}

.page-nav-toggle {
  inset-block-start: auto !important;
  inset-inline-end: auto !important;
  inset-block-end: calc(max(var(--v-layout-bottom, 0px), calc(var(--wiki-footer-height) + env(safe-area-inset-bottom, 0px))) + var(--wiki-grid-size) + 24px) !important;
  inset-inline-start: calc(env(safe-area-inset-left) + var(--wiki-space-5)) !important;
}

.page-nav-toggle--open {
  z-index: 1007;
}

.page-return-top {
  inset-block-start: auto !important;
  inset-inline-start: auto !important;
  inset-block-end: calc(max(var(--v-layout-bottom, 0px), calc(var(--wiki-footer-height) + env(safe-area-inset-bottom, 0px))) + var(--wiki-grid-size) + 24px) !important;
  inset-inline-end: calc(env(safe-area-inset-right) + var(--wiki-space-5)) !important;
}

.is-rtl {
  .page-nav-toggle {
    inset-inline-start: calc(env(safe-area-inset-right) + var(--wiki-space-5)) !important;
  }
  .page-return-top {
    inset-inline-end: calc(env(safe-area-inset-left) + var(--wiki-space-5)) !important;
  }
}

.breadcrumbs-nav {
  min-width: 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
  font-size: .8125rem;

  :is(.v-breadcrumbs-item, .v-breadcrumbs__item) {
    min-width: 0;
  }

  .v-btn {
    min-width: 0;
    border-radius: var(--wiki-radius-xs);
    font-size: inherit;
    letter-spacing: .01em;

    &__content {
      overflow: hidden;
      max-width: min(24rem, 34vw);
      text-overflow: ellipsis;
      text-transform: none;
      white-space: nowrap;
    }

    &:hover {
      background: color-mix(in srgb, var(--wiki-accent-warm) 8%, transparent);
      color: var(--wiki-accent-ink);
    }
  }

  .v-breadcrumbs-divider {
    padding-inline: var(--wiki-space-2);
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 36%, transparent);
  }

  .v-breadcrumbs-divider:nth-child(2) {
    padding-inline-start: var(--wiki-space-3);
  }
}

.page-header-path {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  max-width: 100%;
  margin-inline-end: auto;
  align-items: center;
}

.breadcrumbs-nav--inline {
  flex: 1 1 auto;
  min-width: 0;
  flex-wrap: nowrap;
  padding-block: 0;
  margin-block: 0;
  align-self: center;
  overflow-x: auto;
  overflow-inline: auto;
  scrollbar-width: none;

  .v-btn {
    height: 1.625rem;
    min-height: 1.625rem;
  }

  &::-webkit-scrollbar { display: none; }

  // Pull the first crumb's glyph flush with the page-description text start.
  .v-btn:first-child,
  .v-btn:first-of-type {
    margin-inline-start: -12px;
  }
}

.page-hero {
  position: relative;
  z-index: 2;
  overflow: visible;
  min-height: 0;
  padding: 0 !important;
  background: rgb(var(--v-theme-surface));
  border-block-end: 1px solid var(--wiki-surface-border);

  &.page-hero--accent-present::before {
    position: absolute;
    inset-block: 0;
    right: 0;
    z-index: 0;
    width: 37.5%;
    pointer-events: none;
    content: '';
    background: linear-gradient(
      to bottom left,
      rgb(var(--page-branding-rgb) / var(--page-branding-alpha)) 0%,
      rgb(var(--page-branding-rgb) / calc(var(--page-branding-alpha) * .62)) 20%,
      rgb(var(--page-branding-rgb) / calc(var(--page-branding-alpha) * .24)) 38%,
      rgb(var(--page-branding-rgb) / 0) 54%,
      rgb(var(--page-branding-rgb) / 0) 100%
    );
  }
}


.page-hero--with-toc,
.page-hero--with-toc .page-header-section {
  min-height: 0;
}

.page-header-section {
  position: relative;
  z-index: 2;
  overflow: visible;
  width: min(100%, var(--page-reader-shell-max));
  min-height: 0;
  margin-inline: auto;

  > .is-page-header {
    position: relative;
    overflow: visible;
    display: grid;
    min-width: 0;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-rows: auto auto;
    column-gap: var(--wiki-space-4);
    row-gap: 0;
    align-items: start;
    align-content: start;
    padding:
      calc(var(--wiki-space-2) + 2px)
      var(--wiki-page-gutter) !important;
  }

  > .is-page-header > .page-header-headings {
    grid-column: 1;
    grid-row: 1;
  }

  > .is-page-header > .page-header-summary {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  > .is-page-header > .page-header-control-pair {
    grid-column: 1 / -1;
    grid-row: 3;
    margin-inline-start: 0;
    margin-block-start: calc(var(--wiki-space-1) - 2px);
  }

  .page-header-summary {
    display: flex;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: var(--wiki-space-2) var(--wiki-space-4);
    min-width: 0;
    margin-block-start: var(--wiki-space-1);

    .page-description { flex: 1 1 18rem; margin: 0; }
  }

  .page-header-headings {
    width: 100%;
    min-width: 0;
    max-width: 80rem;
    margin-inline: 0;
    text-align: start;
  }

  .page-header-headings--branded {
    --page-branding-mark-size: 80px;
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--page-branding-mark-size);
    grid-template-rows: auto auto auto;
    row-gap: 0;
    isolation: isolate;

    > .page-document-label {
      grid-column: 1;
      grid-row: 1;
    }

    > .page-title-row {
      grid-column: 1;
      grid-row: 2;
    }

    > .page-description {
      grid-column: 1;
      grid-row: 3;
    }

    > .page-branding-mark {
      position: absolute;
      grid-column: 2;
      grid-row: 2 / span 2;
      top: calc(var(--wiki-space-2) * -1);
      right: 0;
      z-index: 2;
      max-inline-size: var(--page-branding-mark-size);
      max-block-size: 100%;
    }
  }


  .page-title-row {
    min-width: 0;
    flex-wrap: wrap;
    justify-content: flex-start;
    gap: var(--wiki-space-2) var(--wiki-space-3);
  }

  .page-title,
  .page-description {
    font-family: var(--wiki-font-body);
    font-optical-sizing: auto;
  }

  .page-title {
    font-family: var(--wiki-font-display);
    min-width: 0;
    margin: 0;
    color: rgb(var(--v-theme-on-surface));
    font-size: clamp(2.125rem, 1.6rem + 1.8vw, 3.25rem);
    font-weight: 550;
    letter-spacing: -.035em;
    line-height: 1.02;
    overflow-wrap: anywhere;
    text-wrap: balance;
  }

  .page-visibility {
    flex: 0 0 auto;
    margin-inline-start: 0 !important;
    border: 1px solid color-mix(in srgb, rgb(var(--v-theme-warning)) 28%, transparent);
    font-weight: var(--wiki-label-weight);
  }

  .page-description {
    max-width: 68ch;
    margin: var(--wiki-space-1) 0 0;
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
    font-size: 1.0625rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
    text-wrap: pretty;
  }

  .page-edit-shortcuts {
    position: relative;
    z-index: 2;
    display: flex;
    justify-content: flex-end;
    gap: var(--wiki-space-2);
    align-self: center;
    overflow: visible;

    .v-btn {
      height: 1.625rem;
      min-height: 1.625rem;
      padding-inline: var(--wiki-space-3);
      border: 1px solid var(--wiki-surface-border) !important;
      border-radius: var(--wiki-radius-md) !important;
      background: var(--wiki-surface-raised) !important;
      color: rgb(var(--v-theme-on-surface));
      font-size: .75rem;
      box-shadow: var(--wiki-shadow-sm);
      transition:
        border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
        box-shadow var(--wiki-motion-normal) var(--wiki-motion-ease),
        transform var(--wiki-motion-normal) var(--wiki-motion-ease-out);

      .v-icon {
        color: var(--wiki-accent-warm);
      }

      &:hover {
        border-color: color-mix(in srgb, var(--wiki-accent-warm) 38%, var(--wiki-surface-border)) !important;
        box-shadow: var(--wiki-shadow-md);
        transform: translateY(calc(var(--wiki-space-1) * -.5));
      }
    }
  }
}
.wiki-page.is-rtl .page-header-headings--branded {
  grid-template-columns: var(--page-branding-mark-size) minmax(0, 1fr);

  > .page-document-label,
  > .page-title-row,
  > .page-description {
    grid-column: 2;
  }

  > .page-branding-mark {
    grid-column: 1;
  }
}





 

@media (min-width: 600px) {
  .page-header-section .page-header-headings--branded {
    --page-branding-mark-size: 96px;
  }

  .page-header-section {
    > .is-page-header {
      grid-template-columns: minmax(0, 1fr);
    }

    .page-edit-shortcuts { max-width: 100%; flex-wrap: wrap; }
  }
}

@media (min-width: 1280px) {
  .page-header-section .page-header-headings--branded {
    --page-branding-mark-size: 128px;
  }

  .page-header-section {
    > .is-page-header {
      min-height: inherit;
      column-gap: var(--page-reader-column-gap);
      row-gap: 0;
      align-content: center;
    }

    > .page-header--toc-left {
      grid-template-columns:
        var(--page-metadata-rail-width)
        minmax(0, 1fr);

      .page-header-headings {
        grid-column: 2;
        padding-inline-start: var(--wiki-space-4);
      }
    }


    > .page-header--toc-right {
      grid-template-columns:
        minmax(0, 1fr)
        var(--page-metadata-rail-width);
    }


    > .page-header--toc-left > .page-header-summary,
    > .page-header--toc-left > .page-header-control-pair {
      padding-inline-start: var(--wiki-space-4);
      grid-column: 2 / -1;
    }

    > .page-header--toc-right > .page-header-summary,
    > .page-header--toc-right > .page-header-control-pair {
      grid-column: 1 / -2;
    }
  }
}


/* Stacking context must paint above .page-hero (z-index: 2) so upward-lifted desktop rail cards remain visible and interactive */
.page-body {
  position: relative;
  z-index: 3;
  width: min(100%, var(--page-reader-shell-max));
  margin-inline: auto;
  // Block-start padding is deliberately compact: the page hero already closes
  // with its own divider, so the body starts close beneath it and the reader
  // meets the first heading without a wide empty band.
  padding:
    var(--wiki-space-4)
    var(--wiki-page-gutter)
    var(--wiki-space-12) !important;
}

.page-col-sd {
  position: sticky;
  top: calc(var(--v-layout-top, var(--wiki-grid-size)) + var(--wiki-space-4));
  align-self: flex-start;
  max-height: calc(100dvh - var(--v-layout-top, var(--wiki-grid-size)) - max(var(--v-layout-bottom, 0px), var(--wiki-footer-height)) - var(--wiki-space-6));
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-color: color-mix(in srgb, var(--wiki-accent-warm) 54%, transparent) transparent;
  scrollbar-width: thin;

  &::-webkit-scrollbar {
    width: var(--wiki-space-2);
  }

  &::-webkit-scrollbar-thumb {
    border: var(--wiki-space-1) solid transparent;
    border-radius: var(--wiki-radius-pill);
    background: color-mix(in srgb, var(--wiki-accent-warm) 54%, transparent);
    background-clip: padding-box;
  }

  > .v-card,
  > .page-desktop-rail > .v-card {

    overflow: hidden;
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-panel-radius);
    background: var(--wiki-surface-raised);
    box-shadow: var(--wiki-shadow-xs);
  }

  .text-label-small {
    color: var(--wiki-accent-ink);
    font-weight: var(--wiki-label-weight) !important;
    letter-spacing: .09em !important;
    text-transform: uppercase;
  }

  .v-chip {
    border-radius: var(--wiki-radius-xs);
  }
}

.page-mobile-tools,
.page-tablet-tools,
.page-mobile-metadata {
  display: none;
}

.page-desktop-rail {
  display: contents;
}

.page-col-sd--with-toc {
  margin-block-start: calc(
    (var(--page-toc-desktop-lift) * -1) +
    var(--page-desktop-rail-align-offset, 0px)
  );
}

.page-col-sd--toc-off,
.page-col-content--toc-off {
  flex: 0 0 100%;
  max-width: 100%;
}
.page-col-sd--toc-left,
.page-col-sd--toc-right {
  order: 2;
}

.page-col-content--toc-left,
.page-col-content--toc-right {
  order: 1;
}


@media (min-width: 1280px) {
  .page-col-sd {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    max-height: var(--page-desktop-rail-max-height, calc(100dvh - var(--v-layout-top, var(--wiki-grid-size)) - max(var(--v-layout-bottom, 0px), var(--wiki-footer-height)) - var(--wiki-space-6)));
  }

  .page-desktop-rail {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
  }

  .page-tools-card {
    flex: 0 0 auto;
  }

  .page-toc-card {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
  }

  .page-toc-heading,
  .page-toc-filter,
  .page-toc-filter-empty {
    flex: 0 0 auto;
  }

  .page-toc-content {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
  }

  .page-toc-tree-wrap {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
  }

  .page-toc-content .page-toc-list {
    flex: 1 1 auto;
    min-height: 0;
    max-height: none;
    overflow-y: auto;
    overflow-x: clip;
    overscroll-behavior: contain;
  }

  .page-tags-card,
  .page-comments-card {
    flex: 0 0 auto;
  }

  .page-col-sd--toc-left,
  .page-col-content--toc-right {
    order: 1;
  }

  .page-col-sd--toc-right,
  .page-col-content--toc-left {
    order: 2;
  }

  .page-col-sd--with-toc {
    flex: 0 0 var(--page-metadata-rail-width);
    max-width: var(--page-metadata-rail-width);
  }

  .page-col-content--with-toc {
    flex: 0 0 calc(100% - var(--page-metadata-rail-width) - var(--v-col-gap-x));
    max-width: calc(100% - var(--page-metadata-rail-width) - var(--v-col-gap-x));
  }
}


.page-toc-card {
  display: flex;
  min-height: var(--page-toc-empty-height);
  flex-direction: column;
  border: 1px solid var(--wiki-surface-border) !important;
  border-radius: var(--wiki-panel-radius);
  background:
    linear-gradient(
      165deg,
      color-mix(in srgb, var(--wiki-accent-warm) 6%, transparent),
      transparent 34%,
      color-mix(in srgb, var(--wiki-accent-spectral) 5%, transparent)
    ),
    color-mix(in srgb, var(--wiki-surface-raised) 88%, transparent) !important;
  box-shadow: var(--wiki-shadow-xs);

  @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    backdrop-filter: var(--wiki-chrome-blur);
    -webkit-backdrop-filter: var(--wiki-chrome-blur);
    border-color: var(--wiki-glass-border) !important;
  }

  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    background: var(--wiki-surface-raised) !important;
  }

  > .page-toc-heading {
    padding:
      var(--wiki-space-4)
      var(--wiki-space-4)
      var(--wiki-space-2) !important;
    font-family: var(--wiki-font-body);
  }

  .page-toc-toggle {
    display: none;
  }

  .page-toc-toggle-label {
    color: var(--wiki-accent-ink);
    font-family: var(--wiki-font-body);
    font-size: .8125rem;
    font-weight: var(--wiki-label-weight) !important;
    letter-spacing: .09em !important;
    text-transform: uppercase;
  }

  .page-toc-content {
    min-width: 0;
  }
}

.page-toc-list,
.page-toc-sublist {
  list-style: none;
  margin: 0;
  padding: 0;
}

.page-toc-content .page-toc-list {
  max-height: calc(100dvh - var(--v-layout-top, var(--wiki-grid-size)) - max(var(--v-layout-bottom, 0px), var(--wiki-footer-height)) - var(--wiki-space-12));
  overflow-y: auto;
  overflow-x: clip;
  overscroll-behavior: contain;
  padding: var(--wiki-space-1) var(--wiki-space-1) var(--wiki-space-2);
}

.page-toc-node {
  margin: 0;
  padding: 0;
}

.page-toc-row {
  display: flex;
  align-items: center;
  min-height: 2rem;
  padding-inline-start: var(--toc-indent, 0px);
  gap: 2px;
}

.page-toc-branch-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  min-width: 28px;
  height: 28px;
  min-height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--wiki-radius-xs);
  background: transparent;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 60%, transparent);
  cursor: pointer;
  flex: 0 0 28px;

  &:hover {
    background: color-mix(in srgb, var(--wiki-accent-warm) 12%, transparent);
    color: var(--wiki-accent-ink);
  }

  &:focus-visible {
    outline: 2px solid var(--wiki-focus-color, var(--wiki-accent-ink));
    outline-offset: 1px;
  }

  .v-icon,
  .page-toc-chevron {
    font-size: 16px !important;
    width: 16px;
    height: 16px;
  }
}

.page-toc-leaf-spacer {
  display: inline-block;
  width: 28px;
  min-width: 28px;
  height: 28px;
  flex: 0 0 28px;
}

.page-toc-item {
  position: relative;
  isolation: isolate;
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
  min-height: calc(var(--wiki-control-height) - var(--wiki-space-2)) !important;
  padding: 2px var(--wiki-space-1);
  border-inline-start: 2px solid transparent;
  border-radius: var(--wiki-radius-xs);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
  text-decoration: none;
  transition:
    background-color 180ms var(--wiki-motion-ease),
    border-color 180ms var(--wiki-motion-ease),
    color 180ms var(--wiki-motion-ease);

  // Faint amber glow behind the active row. Each row owns its glow (it fades
  // in and out in place instead of sliding across the list) and it is clipped
  // by the card's rounded overflow box. Text and icons stay sharp above it.
  &::after {
    content: '';
    position: absolute;
    z-index: -1;
    inset: -7px -10px;
    border-radius: var(--wiki-radius-sm);
    background: radial-gradient(
      62% 95% at 32% 50%,
      color-mix(in srgb, var(--wiki-accent-warm) 26%, transparent),
      transparent 76%
    );
    opacity: 0;
    transition: opacity 180ms var(--wiki-motion-ease);
    pointer-events: none;
  }

  &:hover {
    background: color-mix(in srgb, var(--wiki-accent-warm) 8%, transparent);
    color: var(--wiki-accent-ink);
  }

  &:focus-visible {
    outline: 2px solid var(--wiki-focus-color, var(--wiki-accent-ink));
    outline-offset: 1px;
  }

  &[aria-current='location'],
  &.page-toc-item--active {
    border-inline-start-color: rgb(var(--v-theme-primary));
    background: color-mix(in srgb, var(--wiki-accent-warm) 10%, transparent);
    color: var(--wiki-accent-ink);
    font-weight: 600;

    &::after {
      opacity: 1;
    }
  }

  &.page-toc-item--descendant-active {
    border-inline-start-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 40%, transparent);
  }
}

// Nested entries stay visually subordinate to top-level sections.
.page-toc-sublist .page-toc-item {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
}

.page-toc-item-title {
  padding-inline: 0 !important;
  font-size: .8125rem;
  line-height: 1.4;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

// Long active headings oscillate: the text starts clipped at its end, eases
// left until the beginning is clipped, then eases back and repeats. Runs
// unconditionally so the behavior does not depend on the reduced-motion
// media query.
// The animated span slides out of the clipped title box (whole box would
// leave the highlight), so the oscillation targets an inner text span while
// the title box itself stretches across the full highlight width; the clip
// edge then coincides with the highlight's own left/right edges.
.page-toc-item-title--marquee {
  margin-inline: calc(var(--wiki-space-1) * -1);
  padding-inline: var(--wiki-space-1) !important;
  text-overflow: clip;
}

.page-toc-item-title--marquee .page-toc-item-title-text {
  display: inline-block;
  animation: page-toc-marquee var(--toc-marquee-duration, 4s) ease-in-out infinite;
  will-change: transform;
}

@keyframes page-toc-marquee {
  0%, 32% { transform: translateX(0); }
  62%, 84% { transform: translateX(var(--toc-marquee-shift, 0px)); }
  100% { transform: translateX(0); }
}

.page-toc-item-title--depth-0 {
  font-weight: 650;
}

.page-toc-item-title--depth-1 {
  font-weight: 550;
}

.page-toc-item-title--depth-2-plus {
  font-weight: 400;
}

.page-tags-card,
.page-comments-card {
  .pa-5 {
    padding: var(--wiki-space-4) !important;
  }
}

.page-tags-card {
  .v-chip {
    max-width: 100%;
    margin:
      0
      var(--wiki-space-1)
      var(--wiki-space-1)
      0 !important;
  }

  .v-chip__content {
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.page-comments-card {
  .v-btn {
    min-width: 0;
    border-color: var(--wiki-surface-border-strong);
    border-radius: var(--wiki-control-radius);
  }
}
.page-tools-card {
  --page-shortcut-target: 36px;

  border: 1px solid var(--wiki-surface-border) !important;
  overflow: hidden !important;
  border-radius: var(--wiki-panel-radius);
  background:
    linear-gradient(
      165deg,
      color-mix(in srgb, var(--wiki-accent-warm) 6%, transparent),
      transparent 34%,
      color-mix(in srgb, var(--wiki-accent-spectral) 5%, transparent)
    ),
    color-mix(in srgb, var(--wiki-surface-raised) 88%, transparent) !important;
  box-shadow: var(--wiki-shadow-xs);

  @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    backdrop-filter: var(--wiki-chrome-blur);
    -webkit-backdrop-filter: var(--wiki-chrome-blur);
    border-color: var(--wiki-glass-border) !important;
  }

  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    background: var(--wiki-surface-raised) !important;
  }

  &__utilities {
    .v-toolbar {
      height: auto !important;
      min-height: var(--page-shortcut-target);
      background: transparent !important;
      overflow: visible !important;
      padding: var(--wiki-space-1) var(--wiki-space-2) !important;
    }

    .v-toolbar__content {
      display: flex;
      height: auto !important;
      min-height: var(--page-shortcut-target);
      flex-wrap: wrap;
      column-gap: var(--wiki-space-1);
      row-gap: var(--wiki-space-1);
      justify-content: space-between;
      > :not(.v-spacer) {
        display: flex;
        min-width: 0;
        flex: 1 1 0;
        justify-content: center;
      }
      align-items: center;
      padding: 0 !important;
      overflow: visible !important;
    }

    .v-badge {
      display: inline-flex;
      flex: 0 0 auto;
      overflow: visible;

      .v-badge__wrapper {
        overflow: visible;
      }
    }
  }

  &__utilities--menu {
    padding: var(--wiki-space-1) var(--wiki-space-2);
  }

  &__divider {
    opacity: 1;
    border-color: var(--wiki-surface-border);
  }

  &__provenance {
    display: flex;
    align-items: center;
    justify-content: space-between;
    column-gap: var(--wiki-space-2);
    row-gap: var(--wiki-space-1);
    flex-wrap: wrap;
    padding: var(--wiki-space-2) var(--wiki-space-3);
  }

  // Neutral resting icons at a readable contrast; active toggles stay amber
  // with a glyph change as the non-color cue.
  .v-btn {
    width: var(--page-shortcut-target) !important;
    min-width: var(--page-shortcut-target) !important;
    max-width: var(--page-shortcut-target) !important;
    height: var(--page-shortcut-target) !important;
    min-height: var(--page-shortcut-target) !important;
    max-height: var(--page-shortcut-target) !important;
    padding: 0 !important;
    border-radius: var(--wiki-radius-xs) !important;
    flex: 0 0 var(--page-shortcut-target) !important;
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 84%, transparent);

    .v-icon {
      font-size: 20px !important;
      width: 20px !important;
      height: 20px !important;
    }

    &:hover {
      background: color-mix(in srgb, var(--wiki-accent-warm) 10%, transparent);
      color: var(--wiki-accent-ink);
    }

    &:focus-visible {
      outline: 2px solid var(--wiki-focus-color, var(--wiki-accent-ink));
      outline-offset: 2px;
      box-shadow: var(--wiki-focus-ring);
    }
  }

  /* Mobile utilities: same icon row as desktop, sized for a narrow card.
     Buttons distribute across the full row (first at the start, last at the
     end, the rest evenly between) like the desktop rail toolbar. */
  .page-tools-card__utilities--inline {
    display: flex;
    flex: 1 1 auto;
    flex-wrap: wrap;
    justify-content: space-between;
    padding-inline: var(--wiki-space-1);

    .v-btn--icon.v-btn--size-small {
      width: 36px;
      height: 36px;
      min-width: 36px;
      min-height: 36px;
      border-radius: var(--wiki-control-radius, .75rem);
      color: var(--wiki-accent-ink);

      .v-icon {
        font-size: 20px;
      }

      &[aria-pressed='true'] {
        color: rgb(var(--v-theme-primary));
      }
    }
  }

  .page-document-provenance {
    display: flex;
    flex: 0 1 auto;
    min-width: 0;
    flex-direction: column;
    align-items: flex-start;
    row-gap: 2px;
    column-gap: var(--wiki-space-3);
    font-size: .75rem;
    line-height: 1.35;
    text-align: start;
  }

  .page-tools-history-link {
    flex: 0 0 auto;
  }

  .page-tools-history-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border-radius: var(--wiki-radius-xs);
    color: var(--wiki-accent-ink);
    font-size: .75rem;
    font-weight: 550;
    text-decoration: none;

    &:hover span {
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    &:focus-visible {
      outline: 2px solid var(--wiki-focus-color, var(--wiki-accent-ink));
      outline-offset: 2px;
    }

    &__icon {
      flex: 0 0 auto;
      width: .875rem;
      height: .875rem;
      color: var(--wiki-accent-ink);
    }
  }
}

.v-theme--dark .page-tools-card {
  // Neutral charcoal: keep the warm cast restrained so the surface never
  // reads brown in dark mode.
  background:
    linear-gradient(
      165deg,
      color-mix(in srgb, var(--wiki-accent-warm) 3%, transparent),
      transparent 34%,
      color-mix(in srgb, var(--wiki-accent-spectral) 3%, transparent)
    ),
    color-mix(in srgb, var(--wiki-surface-raised) 92%, transparent) !important;
}

.page-col-content:not(.is-page-header) {
  min-width: 0;
  padding-inline: var(--wiki-space-4) 0;
}

.page-col-content--toc-right:not(.is-page-header) {
  padding-inline: 0 var(--wiki-space-4);
}

.page-col-content > .contents {
  --page-reader-surface-padding: var(--wiki-space-3);

  min-height: calc(var(--wiki-grid-size) * 3);
  scroll-margin-block-start: calc(var(--v-layout-top, 64px) + 24px);
  padding: var(--page-reader-surface-padding) 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;

  > div {
    width: 100%;
    margin: 0;

    // Keep prose comfortable while tables, diagrams and code use the canvas.
    > :where(p, ul, ol, blockquote, h1, h2, h3, h4, h5, h6) {
      max-inline-size: var(--page-reader-copy-max);
    }
  }

  h1,
  h2,
  h3,
  h4,
  h5,
  h6 {
    position: relative;
    scroll-margin-block-start: calc(var(--v-layout-top, var(--wiki-grid-size)) + var(--wiki-space-8));
    padding-inline-end: 1.3em;

    .toc-anchor {
      position: absolute;
      inset-block-end: .08em;
      inset-inline-end: 0;
      inset-inline-start: auto;
      display: inline-flex;
      color: var(--wiki-accent-ink);
      font-size: .72em;
      opacity: 0;
      transition:
        color var(--wiki-motion-fast) var(--wiki-motion-ease),
        opacity var(--wiki-motion-fast) var(--wiki-motion-ease);
    }

    &:hover .toc-anchor,
    .toc-anchor:focus-visible {
      display: inline-flex;
      color: var(--wiki-accent-ink);
      opacity: .72;
    }
  }

  :where(.footnote-item, .footnote-ref > [id]) {
    scroll-margin-block-start: calc(max(var(--v-layout-top, 0px), var(--wiki-grid-size, 64px)) + var(--wiki-space-8));
  }

}

.page-view-tabs {
  width: fit-content;
  margin-bottom: var(--wiki-space-5);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-xs);
}

.page-view-tabs ~ .comments-container {
  margin-top: 0;
}

.comments-container {
  overflow: hidden;
  margin-top: var(--wiki-space-8);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-hero-radius);
  background: rgb(var(--v-theme-surface));
  box-shadow: var(--wiki-shadow-sm);
}

.comments-header {
  display: flex;
  gap: var(--wiki-space-3);
  align-items: center;
  padding: var(--wiki-space-5) var(--wiki-space-6);
  border-bottom: 1px solid var(--wiki-surface-border);
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--wiki-accent-spectral) 7%, rgb(var(--v-theme-surface))),
      rgb(var(--v-theme-surface))
    );
  color: rgb(var(--v-theme-on-surface));
}

.comments-header-icon {
  display: grid;
  width: var(--wiki-control-height);
  height: var(--wiki-control-height);
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 18%, transparent);
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--wiki-accent-warm) 10%, transparent);
  color: var(--wiki-accent-warm);
}

.comments-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 720;
  letter-spacing: -.01em;
}

.comments-subtitle {
  margin-top: var(--wiki-space-1);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  font-size: .8125rem;
}

@media (max-width: 1279px) {
  .page-hero--with-toc,
  .page-hero--with-toc .page-header-section {
    min-height: 0;
  }

  .page-col-sd {
    display: none;
  }


  .page-toc-card {
    display: flex;
    flex-direction: column;
    min-height: var(--wiki-control-height);
    max-height: calc(var(--wiki-grid-size) * 5);
  }

  .page-toc-card .page-toc-toggle {
    border: 1px solid transparent;
    border-radius: var(--wiki-radius-xs);
    background: color-mix(in srgb, var(--wiki-ambient-accent) 7%, var(--wiki-surface-raised)) !important;
    color: var(--wiki-accent-ink);
    transition:
      border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
      background var(--wiki-motion-fast) var(--wiki-motion-ease),
      color var(--wiki-motion-fast) var(--wiki-motion-ease),
      box-shadow var(--wiki-motion-fast) var(--wiki-motion-ease);

    &:hover {
      border-color: color-mix(in srgb, var(--wiki-ambient-accent) 34%, var(--wiki-surface-border-strong));
      background: color-mix(in srgb, var(--wiki-ambient-accent) 13%, var(--wiki-surface-raised)) !important;
    }

    &:focus-visible {
      outline: 2px solid var(--wiki-focus-color);
      outline-offset: -2px;
      box-shadow: var(--wiki-focus-ring);
    }

    &[aria-expanded='true'] {
      border-color: color-mix(in srgb, var(--wiki-ambient-accent) 48%, var(--wiki-surface-border-strong));
      background:
        linear-gradient(
          90deg,
          color-mix(in srgb, var(--wiki-accent-warm) 12%, var(--wiki-surface-raised)),
          color-mix(in srgb, var(--wiki-accent-spectral) 9%, var(--wiki-surface-raised))
        ) !important;
      color: var(--wiki-accent-ink);
      box-shadow: var(--wiki-shadow-inset);
    }
  }


  .page-toc-row,
  .page-toc-item {
    min-height: 2.5rem;
  }

  .page-toc-card > .page-toc-heading { display: none; }

  .page-toc-card .page-toc-toggle {
    display: flex;
    flex: 0 0 auto;
    min-height: var(--wiki-control-height);
    justify-content: space-between;
    padding-inline: var(--wiki-space-4) !important;
    .v-btn__content { width: 100%; justify-content: space-between; }
  }

  .page-toc-content {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
  }

  .page-toc-filter,
  .page-toc-filter-empty {
    flex: 0 0 auto;
  }

  .page-toc-tree-wrap {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
  }

  .page-toc-content .page-toc-list {
    flex: 1 1 auto;
    min-height: 0;
    max-height: none;
    overflow-y: auto;
    overflow-x: clip;
    overscroll-behavior: contain;
  }
  .page-col-content:not(.is-page-header),
  .page-col-content--toc-right:not(.is-page-header) {
    padding-inline: 0;
  }
  .v-theme--dark .page-toc-card .page-toc-toggle {
    background: color-mix(in srgb, var(--wiki-surface-sunken) 90%, transparent) !important;

    &[aria-expanded='true'] {
      border-color: color-mix(in srgb, var(--wiki-ambient-accent) 48%, var(--wiki-surface-border-strong));
      background:
        linear-gradient(
          90deg,
          color-mix(in srgb, var(--wiki-accent-warm) 14%, var(--wiki-surface-raised)),
          color-mix(in srgb, var(--wiki-accent-spectral) 8%, var(--wiki-surface-raised))
        ) !important;
    }
  }

}
@media (min-width: 600px) and (max-width: 1279px) {
  .page-tablet-tools {
    display: flex;
    width: 100%;
    flex: 0 0 100%;
    flex-direction: column;
    gap: var(--wiki-space-4);
  }

  .page-tablet-tools > .page-tools-card,
  .page-tablet-tools > .page-toc-card,
  .page-tablet-tools > .page-tags-card,
  .page-tablet-tools > .page-comments-card {
    order: initial;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    flex: 0 0 auto;
    margin-bottom: 0 !important;
  }

  .page-body > .v-row {
    gap: var(--wiki-space-4);
  }
}

@media (max-width: 959px) {
  .page-nav-toggle,
  .page-return-top {
    inset-block-start: auto !important;
    inset-block-end: calc(max(var(--v-layout-bottom, 0px), calc(var(--wiki-footer-height) + env(safe-area-inset-bottom, 0px))) + 16px) !important;
  }

  .page-col-sd {
    grid-template-columns: minmax(0, 1fr);
  }

  .page-header-section > .is-page-header {
    padding-inline: var(--wiki-page-gutter) !important;
  }

  .page-col-content > .contents {
    padding: var(--wiki-space-8) 0;
  }
}

@media (max-width: 599px) {
  .breadcrumbs-nav {
    font-size: .75rem;
  }

  .page-header-path {
    flex-basis: 100%;
    margin-inline-end: 0;
  }

  .page-header-unpublished {
    flex: 0 0 auto;
  }

  .page-hero,
  .page-header-section {
    min-height: 0;
  }

  .page-header-section {
    > .is-page-header {
      grid-template-columns: minmax(0, 1fr);
      padding:
        var(--wiki-space-3)
        var(--wiki-page-gutter)
        var(--wiki-space-4) !important;
    }

    .page-title {
      font-size: clamp(1.875rem, 1.55rem + 2vw, 2.25rem);
      line-height: 1.05;
    }

    .page-description {
      margin-top: var(--wiki-space-1);
      font-size: 1rem;
      line-height: 1.5;
    }

    .page-edit-shortcuts {
      display: none;
    }
  }
  .page-header-control-pair {
    justify-content: flex-start;
    margin-inline-start: 0;
  }

  .page-header-offline {
    max-width: 100%;
    flex-basis: auto;
  }


  .page-body {
    padding:
      var(--wiki-space-3)
      var(--wiki-page-gutter)
      var(--wiki-space-10) !important;
  }

  .page-col-sd {
    gap: var(--wiki-space-3);
    padding-block-end: var(--wiki-space-4);
  }

  .page-mobile-tools {
    display: flex;
    width: 100%;
    flex: 0 0 100%;
    flex-direction: column;
    gap: var(--wiki-space-3);
  }

  .page-mobile-metadata {
    display: flex;
    width: 100%;
    flex: 0 0 100%;
    order: 2;
    flex-direction: column;
    gap: var(--wiki-space-3);
  }

  .page-mobile-metadata > .v-card {
    width: 100%;
    max-width: 100%;
    flex: 0 0 auto;
    margin-bottom: 0 !important;
  }

  .page-mobile-tools > .page-tools-card,
  .page-mobile-tools > .page-toc-card {
    width: 100%;
    max-width: 100%;
    flex: 0 0 auto;
    margin-bottom: 0 !important;
  }

  .page-toc-heading {
    display: none;
  }

  .page-toc-card .page-toc-toggle {
    display: flex;
    flex: 0 0 auto;
    min-height: var(--wiki-control-height);
    align-items: center;
    justify-content: space-between;
    padding: var(--wiki-space-3) var(--wiki-space-4) !important;
  }


  .page-toc-card {
    min-height: var(--wiki-control-height);
    max-height: calc(var(--wiki-grid-size) * 5);
  }

  .page-col-content > .contents {
    min-height: calc(var(--wiki-grid-size) * 2);
    padding:
      var(--wiki-space-6)
      0
      var(--wiki-space-8);
    border-radius: 0;

    h1 .toc-anchor {
      opacity: .48;
    }

    h2,
    h3,
    h4,
    h5,
    h6 {
      .toc-anchor {
        opacity: .48;
      }
    }
  }

  .comments-container {
    margin-top: var(--wiki-space-4);
    border-radius: var(--wiki-panel-radius);
  }

  .comments-header,
  .comments-main {
    padding-inline: var(--wiki-space-4);
  }

  .comments-subtitle {
    display: none;
  }

  .page-edit-fab {
    inset-block-end: calc(var(--v-layout-bottom, 0px) + var(--wiki-space-4));
    inset-inline-end: calc(var(--wiki-space-4) + var(--wiki-control-height) + var(--wiki-space-3));
  }

  .page-nav-toggle,
  .page-return-top {
    width: 40px !important;
    min-width: 40px !important;
    max-width: 40px !important;
    height: 40px !important;
    min-height: 40px !important;
    max-height: 40px !important;
    inset-block-start: auto !important;
    inset-block-end: calc(max(var(--v-layout-bottom, 0px), calc(var(--wiki-footer-height) + env(safe-area-inset-bottom, 0px))) + 12px) !important;
  }

  .page-nav-toggle {
    inset-inline-end: auto !important;
    inset-inline-start: calc(env(safe-area-inset-left) + var(--wiki-space-4)) !important;
  }

  .page-return-top {
    inset-inline-start: auto !important;
    inset-inline-end: calc(env(safe-area-inset-right) + var(--wiki-space-4)) !important;
  }

  .is-rtl {
    .page-nav-toggle {
      inset-inline-start: calc(env(safe-area-inset-right) + var(--wiki-space-4)) !important;
    }
    .page-return-top {
      inset-inline-end: calc(env(safe-area-inset-left) + var(--wiki-space-4)) !important;
    }
  }
}

@media print {
  .page-navigation,
  .page-nav-toggle,
  .page-header-path,
  .page-edit-shortcuts,
  .page-edit-fab,
  .page-return-top,
  .page-header-offline,
  .page-mobile-tools,
  .page-tablet-tools,
  .page-mobile-metadata,
  .page-col-sd,
  .page-tools-card__utilities,
  .page-tools-card__divider,
  .page-tools-history-link,
  .page-toc-card,
  .page-tags-card,
  .page-comments-card,
  .comments-container {
    display: none !important;
  }
  .page-tools-card {
    width: 100%;
    min-height: 0;
    margin: 0 0 var(--wiki-space-4) !important;
    border: 0 !important;
    border-block-end: 1px solid currentColor !important;
    border-radius: 0;
    background: transparent !important;
    box-shadow: none !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }

  .page-tools-card__provenance {
    min-height: 0;
    padding: 0 0 var(--wiki-space-2) !important;
    color: CanvasText;
  }

  .page-tools-card .page-document-row--date,
  .page-tools-card .page-document-row--author,
  .page-tools-card .page-document-author,
  .page-tools-card time {
    color: CanvasText;
  }

  .page-main,
  .page-hero,
  .page-col-content > .contents {
    border: 0 !important;
    background: transparent !important;
    box-shadow: none !important;
  }

  .page-hero::before {
    display: none;
  }

  .page-branding-mark {
    display: none !important;
  }

  .page-header-headings--branded {
    display: block;
  }

  .page-hero,
  .page-header-section,
  .page-header-section > .is-page-header {
    min-height: 0;
  }

  .page-header-section > .is-page-header {
    padding:
      0
      0
      var(--wiki-space-6) !important;
  }

  .page-header-section .page-title,
  .page-header-section .page-description {
    color: CanvasText;
  }
  .page-header-section .page-title {
    font-size: 28pt;
    font-weight: 700;
    line-height: 1.05;
  }

  .page-header-section .page-description {
    font-size: 12pt;
    line-height: 1.4;
  }

  .page-body,
  .page-col-content > .contents {
    width: 100%;
    padding: 0 !important;
  }

  .page-col-content {
    max-width: 100% !important;
    flex-basis: 100% !important;
  }

  .page-col-content > .contents {
    > div {
      width: 100%;
      max-width: none;
    }

    .toc-anchor {
      display: none !important;
    }
  }
}

@media (forced-colors: active) {
  .page-col-content > .contents,
  .page-col-sd > .v-card,
  .comments-container {
    border-color: CanvasText;
    box-shadow: none;
  }
  .page-toc-card {
    border-color: CanvasText !important;
    background: Canvas !important;
    box-shadow: none;
  }

  .page-toc-card .page-toc-toggle {
    border-color: CanvasText;
    background: Canvas !important;
    color: CanvasText;
    box-shadow: none;

    .v-icon {
      color: currentColor;
    }

    &:focus-visible {
      outline: 2px solid Highlight;
      outline-offset: 2px;
      box-shadow: none;
    }

    &[aria-expanded='true'] {
      border-color: Highlight;
      background: Highlight !important;
      color: HighlightText;
    }
  }

  .page-hero--accent-present::before {
    display: none !important;
  }

  .page-branding-mark {
    display: none !important;
  }

  .page-header-headings--branded {
    display: block;
  }
}


@media (prefers-reduced-motion: reduce) {
  .page-return-top,
  .page-edit-fab,
  .page-nav-toggle,
  .page-header-section .page-edit-shortcuts .v-btn,
  .page-toc-item,
  .page-toc-item::after {
    transition-duration: .001ms !important;
  }

  .page-main--route-enter .page-header-headings,
  .page-main--route-enter .page-body > .v-row {
    animation: none !important;
  }

  .page-return-top:hover,
  .page-edit-fab:hover,
  .page-nav-toggle:hover,
  .page-header-section .page-edit-shortcuts .v-btn:hover {
    transform: none;
  }
}
.page-position {
  position: fixed;
  transition: inset-inline-start var(--wiki-motion-fast, .15s) var(--wiki-motion-ease, ease);
  /* The Wiki header is a 52px chrome bar (48px dense) plus a 1px bottom
     border; --v-layout-top is not emitted for it, so anchor to the shared
     chrome token and sit flush under the border. */
  inset-block-start: calc(var(--wiki-chrome-height, 3.25rem) + 1px);
  inset-inline: 0;
  z-index: 1004;
  height: 2px;
  pointer-events: none;
}

.nav-header--dense + .page-position {
  inset-block-start: calc(var(--wiki-chrome-height-dense, 3rem) + 1px);
}

.page-position-fill {
  width: 100%;
  height: 100%;
  /* Reading-position wash: very faint at the reading start, strengthening
     along the scroll direction up to a strong accent at the leading edge. */
  background: linear-gradient(90deg, color-mix(in srgb, var(--wiki-accent-ink) 25%, transparent), color-mix(in srgb, var(--wiki-accent-ink) 85%, transparent));
  transform-origin: left;
}

.is-rtl .page-position-fill {
  transform-origin: right;
  background: linear-gradient(270deg, color-mix(in srgb, var(--wiki-accent-ink) 25%, transparent), color-mix(in srgb, var(--wiki-accent-ink) 85%, transparent));
}

.page-focus-control {
  /* Match the offline cloud control so both header actions read as one row. */
  height: 1.625rem;
  min-height: 1.625rem;
  margin-inline-start: var(--wiki-space-1);
  border-inline-start: 1px solid var(--wiki-surface-border);
  padding-inline-start: var(--wiki-space-2);
  border-radius: 0;
  color: var(--wiki-accent-ink);
  letter-spacing: 0;

  .v-icon {
    font-size: .875rem !important;
  }
}


.page-reading-dock {
  position: fixed;
  inset-block-end: calc(var(--wiki-footer-height) + env(safe-area-inset-bottom) + 1rem);
  inset-inline-start: 50%;
  z-index: 1006;
  display: flex;
  align-items: center;
  gap: .5rem;
  width: max-content;
  max-width: min(26rem, calc(100% - 2rem));
  isolation: isolate;
  padding: .25rem .375rem .25rem .75rem;
  border: 1px solid color-mix(in srgb, var(--wiki-surface-border-strong) 82%, transparent);
  border-radius: var(--wiki-radius-pill);
  background-color: var(--wiki-chrome-surface) !important;
  background-image: linear-gradient(90deg, color-mix(in srgb, var(--wiki-accent-warm) 8%, transparent), transparent 42%, color-mix(in srgb, var(--wiki-accent-spectral) 6%, transparent)) !important;
  color: rgb(var(--v-theme-on-surface));
  box-shadow: var(--wiki-shadow-md);
  backdrop-filter: var(--wiki-chrome-blur) !important;
  -webkit-backdrop-filter: var(--wiki-chrome-blur) !important;
  transform: translateX(-50%);

  @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    border-color: var(--wiki-glass-border);
  }

  .v-icon,
  .page-reading-dock-title,
  .v-btn {
    opacity: 1;
  }

  .v-btn { flex-shrink: 0; min-height: 28px; height: 28px; color: var(--wiki-accent-ink); }
}

.is-rtl .page-reading-dock { transform: translateX(50%); }

.page-reading-dock-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--wiki-font-display);
  font-size: .9375rem;
}

.wiki-page.wiki-page--reading {
  --page-reader-shell-max: 64rem;
  --page-reader-copy-max: min(72ch, var(--wiki-reader-copy-width, 74ch));

  .page-col-sd,
  .page-mobile-tools,
  .page-tablet-tools,
  .page-mobile-metadata,
  .page-body > .v-row > .v-card,
  .page-tools-card,
  .page-edit-shortcuts,
  .page-edit-fab { display: none !important; }

  .page-header-section > .is-page-header {
    grid-template-columns: minmax(0, 1fr);
    padding-block: var(--wiki-space-4) !important;
  }

  .page-header-section .page-header-headings {
    grid-column: 1;
    max-width: none;
    margin-inline: 0;
    font-size: 1.0625rem;
    padding-inline-start: 0;
  }

  // Keep the mark anchored to the standard responsive edge while its focused
  // heading containing block preserves the mark's standard rendered size.
  .page-header-section,
  .page-header-section > .is-page-header {
    position: static;
  }

  .page-header-headings--branded > .page-branding-mark {
    right: calc((min(100vw, var(--page-layout-shell-max)) - min(100vw, var(--page-reader-shell-max))) / -2);
  }

  .page-col-content:not(.is-page-header) {
    flex: 0 0 100%;
    max-width: 100%;
    padding-inline: 0;
  }

  .page-col-content > .contents {
    padding-block-start: var(--wiki-space-4);
    border-color: transparent;
    border-radius: 0;
    box-shadow: none;

    > div { margin-inline: auto; }
  }

  .page-header-section > .is-page-header > .page-header-summary,
  .page-header-section > .is-page-header > .page-header-control-pair {
    grid-column: 1;
    padding-inline-start: 0;
  }

  .page-main,
  .page-body { background: var(--page-reader-background); }
}

@media (max-width: 599px) {
  .page-reading-dock-title { display: none; }

}

@media print {
  .page-position,
  .page-focus-control,
  .page-reading-dock { display: none !important; }
}

</style>
