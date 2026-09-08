<template lang="pug">
  v-app.wiki-page(v-scroll='upBtnScroll', :class='[$vuetify.locale.isRtl ? `is-rtl` : `is-ltr`, { "wiki-page--reading": readerFocus, "wiki-page--branded": hasPageBrandingAccent }]', :style='pageBrandingStyle')
    a.page-skip-link(:href='`#${pageArticleId}`', @click.prevent='focusArticle') Skip to content
    nav-header(v-if='!printView')
    .page-position(v-if='!printView', role='progressbar', :aria-label='$t(`common:page.pagePosition`)', :aria-valuenow='readingProgress', aria-valuemin='0', aria-valuemax='100')
      .page-position-fill(:style='{ transform: `scaleX(${readingProgress / 100})` }')
    .page-reading-dock(v-if='readerFocus && !printView', role='region', :aria-label='$t(`common:page.focusReading`)')
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
      :width='$vuetify.display.width >= 1280 ? 281.6 : 256'
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

    v-fab-transition(v-if='navMode !== `NONE` && !readerFocus')
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
      template(v-if='path !== `home`')
        v-toolbar.page-breadcrumb-bar(color='surface', flat, density="compact")
          //- v-btn.pl-0(v-if='$vuetify.display.xsOnly', variant='flat', @click='toggleNavigation')
          //-   v-icon(color='grey-darken-2', start) menu
          v-breadcrumbs.breadcrumbs-nav.pl-0(
            :items='breadcrumbs'
            divider='/'
            role='navigation'
            :aria-label='$t(`common:header.breadcrumb`)'
          )
            template(v-slot:item='props')
              v-btn.ma-0(
                v-if='props.item.path === "/"'
                size="small"
                variant="text"
                @click='goHome'
                :aria-label='$t(`common:header.home`)'
              )
                v-icon(aria-hidden='true', size="small") mdi-home
              v-btn.ma-0(
                v-else
                :href='props.item.path'
                size="small"
                variant="text"
                :aria-current='props.item.path === breadcrumbs[breadcrumbs.length - 1].path ? `page` : undefined'
              ) {{props.item.title}}
          template(v-if='!isPublished')
            v-spacer
            .text-body-small.text-warning {{$t('common:page.unpublished')}}
            status-indicator.ml-3(negative, pulse)
        v-divider
      v-container.page-hero(
        ref='pageHero'
        fluid
        :class='{ "page-hero--with-toc": tocPosition !== `off` }'
      )
        v-row.page-header-section(:gap='0')
          v-col.page-col-content.is-page-header(
            cols='12'
            :class='[$vuetify.locale.isRtl ? `pr-4` : `pl-4`, `page-header--toc-${tocPosition}`, { "has-edit-shortcuts": editShortcutsObj.editMenuBar && (editShortcutsObj.editMenuBtn || editShortcutsObj.editMenuExternalBtn) }]'
            )
            .page-header-headings(:class='{ "page-header-headings--branded": pageBrandingVisible }')
              .page-document-label
                v-icon(icon='mdi-book-open-page-variant-outline', size='15', aria-hidden='true')
                span Knowledge / {{ locale.toUpperCase() }}
              .page-title-row.d-flex.align-center
                h1.page-title(ref='pageTitle', :id='pageTitleId') {{title}}
                v-chip.page-visibility.ml-3(v-if="visibility === 'private'", size="small", color='warning', variant='tonal') {{$t('common:page.private')}}
              p.page-description(v-if='description') {{description}}
              .page-document-meta
                .page-document-provenance
                  .page-document-row.page-document-row--date(v-if='updatedAt')
                    v-tooltip(location='top', v-if='canViewHistory')
                      template(v-slot:activator='{ props }')
                        v-btn.page-history-btn(
                          v-bind='props'
                          :href='pageHistoryUrl'
                          @click='historyLinkClicked($event)'
                          :aria-label='$t(`common:page.viewHistory`)'
                          icon='mdi-history'
                          variant='text'
                          size='x-small'
                          density='compact'
                        )
                      span {{ $t('common:page.viewHistory') }}
                    time(:datetime='updatedAt', :title='accessibleUpdatedAt') {{ $t('common:page.updatedAt', { date: formattedUpdatedAt }) }}
                  .page-document-row.page-document-row--author(v-if='hasAuthor')
                    span.page-document-author
                      | {{ $t('common:page.byAuthor', { author: '' }) }}
                      bdi.page-provenance-author {{ authorName }}
                v-btn.page-focus-control(v-if='!printView', variant='text', size='small', :prepend-icon='readerFocus ? `mdi-arrow-collapse-horizontal` : `mdi-book-open-page-variant-outline`', :aria-pressed='readerFocus', @click='toggleReaderFocus') {{ $t(readerFocus ? 'common:page.exitFocus' : 'common:page.focusReading') }}
              page-branding-mark(
                v-if='pageBranding'
                :branding='pageBranding'
                :failed='brandingFailureIdentity === pageBrandingIdentity'
                @error='pageBrandingImageError'
              )

            .page-edit-shortcuts(
              v-if='editShortcutsObj.editMenuBar && (editShortcutsObj.editMenuBtn || editShortcutsObj.editMenuExternalBtn)'
              :class='tocPosition === `right` ? `is-right` : ``'
              )
              v-btn(
                v-if='editShortcutsObj.editMenuBtn'
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
      v-divider
      v-container.page-body(fluid)
        v-row
          #page-mobile-tools.page-mobile-tools

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
            v-tooltip(location='start', v-if='hasAnyPagePermissions && editShortcutsObj.editFab && !$vuetify.display.smAndDown')
              template(v-slot:activator='{ props: tooltipProps }')
                v-speed-dial(
                  v-model='pageEditFab'
                  :activator-props='tooltipProps'
                  location='top center'
                  transition='scale-transition'
                )
                  template(v-slot:activator='{ props: speedDialProps }')
                    v-btn.btn-animate-edit.page-edit-fab(
                      icon
                      color='primary'
                      v-bind='speedDialProps'
                      :aria-expanded='pageEditFab ? `true` : `false`'
                      :aria-label='$t(`common:header.pageActions`)'
                    )
                      v-icon mdi-pencil
                  v-tooltip(location='start', v-if='hasWritePagesPermission')
                    template(v-slot:activator='{ props }')
                      v-btn(icon, size="small", color='white', v-bind='props', @click='pageEdit', :aria-label='$t(`common:page.editPage`)')
                        v-icon(size='20') mdi-pencil
                    span {{$t('common:page.editPage')}}
                  v-tooltip(location='start', v-if='hasReadHistoryPermission')
                    template(v-slot:activator='{ props }')
                      v-btn(
                        icon
                        size="small"
                        color='white'
                        v-bind='props'
                        @click='pageHistory'
                        :aria-label='$t(`common:header.history`)'
                      )
                        v-icon(size='20') mdi-history
                    span {{$t('common:header.history')}}
                  v-tooltip(location='start', v-if='hasReadSourcePermission')
                    template(v-slot:activator='{ props }')
                      v-btn(
                        icon
                        size="small"
                        color='white'
                        v-bind='props'
                        @click='pageSource'
                        :aria-label='$t(`common:header.viewSource`)'
                        )
                        v-icon(size='20') mdi-code-tags
                    span {{$t('common:header.viewSource')}}
                  v-tooltip(location='start', v-if='hasWritePagesPermission')
                    template(v-slot:activator='{ props }')
                      v-btn(
                        icon
                        size="small"
                        color='white'
                        v-bind='props'
                        @click='pageConvert'
                        :aria-label='$t(`common:header.convert`)'
                        )
                        v-icon(size='20') mdi-lightning-bolt
                    span {{$t('common:header.convert')}}
                  v-tooltip(location='start', v-if='hasWritePagesPermission')
                    template(v-slot:activator='{ props }')
                      v-btn(
                        icon
                        size="small"
                        color='white'
                        v-bind='props'
                        @click='pageDuplicate'
                        :aria-label='$t(`common:header.duplicate`)'
                        )
                        v-icon(size='20') mdi-content-duplicate
                    span {{$t('common:header.duplicate')}}
                  v-tooltip(location='start', v-if='hasManagePagesPermission')
                    template(v-slot:activator='{ props }')
                      v-btn(
                        icon
                        size="small"
                        color='white'
                        v-bind='props'
                        @click='pageMove'
                        :aria-label='$t(`common:header.move`)'
                        )
                        v-icon(size='20') mdi-content-save-move-outline
                    span {{$t('common:header.move')}}
                  v-tooltip(location='start', v-if='hasDeletePagesPermission')
                    template(v-slot:activator='{ props }')
                      v-btn(
                        icon
                        size="small"
                        color='error'
                        v-bind='props'
                        @click='pageDelete'
                        :aria-label='$t(`common:header.delete`)'
                        )
                        v-icon(size='20') mdi-trash-can-outline
                    span {{$t('common:header.delete')}}
              span {{$t('common:page.editPage')}}
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
            article.contents(ref='container', :id='pageArticleId', tabindex='-1', :aria-labelledby='pageTitleId', :dir='$vuetify.locale.isRtl ? `rtl` : `ltr`')
              template(v-if='$slots.contents')
                slot(name='contents')
              async-state(
                v-else
                state='empty'
                :title='$t(`common:page.noContent`)'
              )
            section.comments-container#discussion(v-if='commentsEnabled && commentsPerms.read && !printView' aria-labelledby='discussion-title')
              .comments-header
                .comments-header-icon
                  v-icon(size='20') mdi-comment-text-outline
                div
                  h2#discussion-title.comments-title {{$t('common:comments.title')}}
                  .comments-subtitle {{$t('common:page.discussionSubtitle')}}
              .comments-main
                slot(name='comments')
          #page-mobile-metadata.page-mobile-metadata
          Teleport(
            defer
            :key='isTocMobile ? `mobile-tools` : winWidth < 1280 ? `tablet-tools` : `desktop-tools`'
            :to='isTocMobile ? `#page-mobile-tools` : `#page-desktop-rail`'
            :disabled='winWidth >= 600 && winWidth < 1280'
          )
            v-card.page-shortcuts-card.mb-4(flat)
              v-toolbar(color='surface', flat, density="compact")
                v-spacer
                //- v-tooltip(bottom)
                //-   template(v-slot:activator='{ props }')
                //-     v-btn(icon, rounded='0', v-bind='props', :aria-label='$t(`common:page.bookmark`)'): v-icon(color='grey') mdi-bookmark
                //-   span {{$t('common:page.bookmark')}}
                v-menu(location="bottom", min-width='300')
                  template(v-slot:activator='{ props: menuProps }')
                    v-tooltip(location="bottom")
                      template(v-slot:activator='{ props: tooltipProps }')
                        v-btn(icon, rounded='0', v-bind='mergeProps(menuProps, tooltipProps)', :aria-label='$t(`common:page.share`)'): v-icon(color='grey') mdi-share-variant
                      span {{$t('common:page.share')}}
                  social-sharing(
                    :url='pageUrl'
                    :title='title'
                    :description='description'
                  )
                v-menu(v-if='isAuthenticated', location="bottom", min-width='340', max-width='420')
                  template(v-slot:activator='{ props: menuProps }')
                    v-tooltip(location="bottom")
                      template(v-slot:activator='{ props: tooltipProps }')
                        v-badge(
                          :content='pageWatchUnreadCount'
                          :model-value='pageWatchUnreadCount > 0'
                          color='error'
                        )
                          v-btn(
                            icon
                            rounded='0'
                            v-bind='mergeProps(menuProps, tooltipProps)'
                            @click='loadPageWatchNotifications'
                            :aria-label='$t(`common:page.pageNotifications`)'
                          )
                            v-icon(color='grey') mdi-bell
                      span {{$t('common:page.pageNotifications')}}
                  v-card
                    v-card-title.text-body-large {{$t('common:page.pageNotifications')}}
                    v-divider
                    async-state(
                      v-if='pageWatchNotificationsLoading'
                      state='loading'
                      :title='$t(`common:page.loadingPageNotifications`)'
                    )
                    async-state(
                      v-else-if='pageWatchNotificationsError'
                      state='error'
                      :title='$t(`common:page.pageNotificationsLoadError`)'
                      :message='pageWatchNotificationsError'
                      :retry-label='$t(`common:page.tryAgain`)'
                      @retry='loadPageWatchNotifications'
                    )
                    v-list(v-else-if='pageWatchNotifications.length > 0', lines='two', density='compact')
                      v-list-item(
                        v-for='notification in pageWatchNotifications'
                        :key='notification.id'
                        @click='openPageWatchNotification(notification)'
                        :class='{ "font-weight-bold": !notification.readAt }'
                      )
                        v-list-item-title {{ notification.title }}
                        v-list-item-subtitle {{ pageWatchNotificationSummary(notification) }}
                    async-state(
                      v-else
                      state='empty'
                      :title='$t(`common:page.noPageNotifications`)'
                    )
                v-tooltip(location="bottom", v-if='isAuthenticated')
                  template(v-slot:activator='{ props }')
                    v-btn(
                      icon
                      rounded='0'
                      v-bind='props'
                      :loading='pageWatchLoading'
                      :disabled='pageWatchLoading'
                      @click='togglePageWatch'
                      :aria-label='pageWatched ? $t(`common:page.stopWatchingPage`) : $t(`common:page.watchPage`)'
                    )
                      v-icon(:color='pageWatched ? `primary` : `grey`') {{ pageWatched ? 'mdi-bell-ring' : 'mdi-bell-outline' }}
                  span {{ pageWatched ? $t('common:page.stopWatchingPage') : $t('common:page.watchPage') }}
                v-menu(v-if='pageWatched', location="bottom", :close-on-content-click='false', min-width='260')
                  template(v-slot:activator='{ props: menuProps }')
                    v-tooltip(location="bottom")
                      template(v-slot:activator='{ props: tooltipProps }')
                        v-btn(
                          icon
                          rounded='0'
                          v-bind='mergeProps(menuProps, tooltipProps)'
                          :aria-label='$t(`common:page.watchSettings`)'
                        )
                          v-icon(color='grey') mdi-tune
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
                        :disabled='pageWatchLoading'
                        @update:model-value='savePageWatchSettings'
                      )
                      v-switch(
                        v-model='pageWatchInAppEnabled'
                        :label='$t(`common:page.inAppNotifications`)'
                        color='primary'
                        density='compact'
                        hide-details
                        :disabled='pageWatchLoading'
                        @update:model-value='savePageWatchSettings'
                      )
                v-menu(v-if='isAuthenticated', location="bottom", min-width='340', max-width='440')
                  template(v-slot:activator='{ props: menuProps }')
                    v-tooltip(location="bottom")
                      template(v-slot:activator='{ props: tooltipProps }')
                        v-badge(
                          :content='approvalInbox.length'
                          :model-value='approvalInbox.length > 0'
                          color='primary'
                        )
                          v-btn(
                            icon
                            rounded='0'
                            v-bind='mergeProps(menuProps, tooltipProps)'
                            @click='loadApprovalInbox'
                            :aria-label='$t(`common:page.approvalInbox`)'
                          )
                            v-icon(color='grey') mdi-inbox-arrow-down
                      span {{$t('common:page.approvalInbox')}}
                  v-card
                    v-card-title.text-body-large {{$t('common:page.approvalInbox')}}
                    v-divider
                    async-state(
                      v-if='approvalInboxLoading'
                      state='loading'
                      :title='$t(`common:page.loadingApprovalInbox`)'
                    )
                    async-state(
                      v-else-if='approvalInboxError'
                      state='error'
                      :title='$t(`common:page.approvalInboxLoadError`)'
                      :message='approvalInboxError'
                      :retry-label='$t(`common:page.tryAgain`)'
                      @retry='loadApprovalInbox'
                    )
                    v-list(v-else-if='approvalInbox.length > 0', lines='three', density='compact')
                      v-list-item(
                        v-for='approval in approvalInbox'
                        :key='approval.id'
                        @click='openApprovalInboxItem(approval)'
                      )
                        v-list-item-title {{ approval.title }}
                        v-list-item-subtitle {{ approvalStatusLabel(approval.status) }} · {{ $t('common:page.revision', { id: approval.revisionId }) }}
                        v-list-item-subtitle(v-if='approval.stale') {{$t('common:page.submittedRevisionStale')}}
                    async-state(
                      v-else
                      state='empty'
                      :title='$t(`common:page.noActiveApprovalRequests`)'
                    )
                v-tooltip(location="bottom", v-if='isAuthenticated && (hasWritePagesPermission || hasManagePagesPermission || hasAdminPermission)')
                  template(v-slot:activator='{ props }')
                    v-btn(
                      icon
                      rounded='0'
                      v-bind='props'
                      @click='openApprovalWorkflow'
                      :aria-label='$t(`common:page.approvalWorkflow`)'
                    )
                      v-icon(:color='pageApproval ? `primary` : `grey`') mdi-check-decagram-outline
                  span {{$t('common:page.approvalWorkflow')}}
                v-tooltip(location="bottom", v-if='isAuthenticated && (hasWritePagesPermission || hasManagePagesPermission || hasAdminPermission)')
                  template(v-slot:activator='{ props }')
                    v-btn(
                      icon
                      rounded='0'
                      v-bind='props'
                      @click='openPageProtection'
                      :aria-label='$t(`common:page.pagePasswordProtection`)'
                    )
                      v-icon(:color='pageProtection.protected ? `primary` : `grey`') {{ pageProtection.protected ? 'mdi-lock' : 'mdi-lock-open-outline' }}
                  span {{$t('common:page.pagePasswordProtection')}}
                v-tooltip(location="bottom")
                  template(v-slot:activator='{ props }')
                    v-btn(icon, rounded='0', v-bind='props', @click='print', :aria-label='$t(`common:page.printFormat`)')
                      v-icon(:color='printView ? `primary` : `grey`') mdi-printer
                  span {{$t('common:page.printFormat')}}
                v-spacer
            v-card.page-toc-card.mb-4(v-if='tocPosition !== `off`', tag='nav', :aria-label='$t(`common:page.toc`)')
              v-btn.page-toc-toggle.text-none(
                variant='text'
                block
                :aria-expanded='tocDisclosureExpanded'
                aria-controls='page-toc-content'
                @click='toggleToc'
              )
                span.page-toc-toggle-label.text-label-small {{$t('common:page.toc')}}
                v-icon(size='small', aria-hidden='true') {{ tocDisclosureExpanded ? `mdi-chevron-up` : `mdi-chevron-down` }}
              .text-label-small.page-toc-heading
                span {{$t('common:page.toc')}}
                span.page-toc-count {{ tocFlattened.length }}

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

          Teleport(
            defer
            :key='isTocMobile ? `mobile-metadata` : winWidth < 1280 ? `tablet-metadata` : `desktop-metadata`'
            :to='isTocMobile ? `#page-mobile-metadata` : `#page-desktop-rail`'
            :disabled='winWidth >= 600 && winWidth < 1280'
          )
            v-card.page-tags-card.mb-5(v-if='tags.length > 0')
              .pa-5
                .text-label-small.pb-2.text-secondary {{$t('common:page.tags')}}
                v-chip.mr-1.mb-1(
                  label
                  color='secondary'
                  variant='tonal'
                  v-for='tag in tags'
                  :href='`/t/` + tag.tag'
                  :key='`tag-` + tag.tag'
                  )
                  v-icon(start, size="small") mdi-tag
                  span {{tag.title}}
                v-chip.mr-1.mb-1(
                  label
                  color='secondary'
                  variant='tonal'
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
        v-toolbar(color='primary', flat)
          v-toolbar-title#page-protection-title(tag='h2') {{$t('common:page.pagePasswordProtection')}}
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
              :disabled='pageProtectionPassword.length < 12'
              :loading='protectionLoading'
              @click='savePageProtection'
            ) {{ pageProtection.protected ? $t('common:page.rotatePassword') : $t('common:page.enableProtection') }}
            v-btn(
              v-if='pageProtection.protected'
              color='error'
              variant='text'
              :disabled='protectionLoading'
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
        v-toolbar(color='primary', flat)
          v-toolbar-title#page-approval-title(tag='h2') {{$t('common:page.approvalWorkflow')}}
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
          v-divider
          v-card-actions.flex-wrap.pa-4
            v-btn(
              v-if='hasWritePagesPermission && (!pageApproval || [`rejected`, `cancelled`, `published`].includes(pageApproval.status))'
              color='primary'
              :loading='approvalLoading'
              @click='submitPageApproval'
            ) {{ pageApproval ? $t('common:page.submitNewRevision') : $t('common:page.submitForApproval') }}
            template(v-if='pageApproval')
              v-btn(v-if='pageApproval.status === `submitted` && pageApproval.canReview', color='success', :disabled='approvalLoading || pageApproval.stale', @click='transitionPageApproval(`approve`)') {{$t('common:page.approve')}}
              v-btn(v-if='pageApproval.status === `submitted` && pageApproval.canReview', color='warning', :disabled='approvalLoading', @click='transitionPageApproval(`request-changes`)') {{$t('common:page.requestChanges')}}
              v-btn(v-if='pageApproval.status === `submitted` && pageApproval.canReview', color='error', :disabled='approvalLoading', @click='transitionPageApproval(`reject`)') {{$t('common:page.reject')}}
              v-btn(v-if='pageApproval.status === `changes-requested` && pageApproval.canSubmitter', color='primary', :disabled='approvalLoading', @click='transitionPageApproval(`resubmit`)') {{$t('common:page.resubmit')}}
              v-btn(v-if='pageApproval.status === `approved` && pageApproval.canReview', color='success', :disabled='approvalLoading || pageApproval.stale', @click='transitionPageApproval(`publish`)') {{$t('common:page.publishApprovedRevision')}}
              v-btn(v-if='pageApproval.canReview && [`submitted`, `approved`, `changes-requested`].includes(pageApproval.status)', :disabled='approvalLoading', @click='transitionPageApproval(`reassign`)') {{$t('common:page.reassign')}}
              v-btn(v-if='pageApproval.canSubmitter && [`submitted`, `approved`, `changes-requested`].includes(pageApproval.status)', color='error', variant='text', :disabled='approvalLoading', @click='transitionPageApproval(`cancel`)') {{$t('common:page.cancelRequest')}}
            v-spacer
            v-btn(@click='approvalDialog = false') {{$t('common:actions.close')}}
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
import { defineComponent, h, markRaw, mergeProps, type PropType, type VNode } from 'vue'
import i18next from 'i18next'
import { useGoTo } from 'vuetify'
import AsyncState from '@/components/common/async-state.vue'
import PageBrandingMark from '@/components/common/page-branding-mark.vue'
import StatusIndicator from '@/components/common/status-indicator.vue'
import { externalSourceUrl } from '../../../../shared/general-policy.ts'
import type { PageBrandingView } from '../../../../shared/page-branding.ts'
import type { PageBrandingTheme } from '../../../helpers/page-branding'
import {
  normalizePageBrandingView,
  pageBrandingIdentity,
  resolvePageBrandingStyle
} from '../../../helpers/page-branding'
import SiteBanner from '@/components/common/site-banner.vue'
import NavSidebar, { type SidebarItem } from './nav-sidebar.vue'
import type { Environment as PrismEnvironment } from 'prismjs'
import Prism from '../../../libs/prism/setup'
import mermaid from 'mermaid'
import { wikiStore } from '@/store/index.ts'
import _ from 'lodash'
import {
  type OutlineNode,
  buildOutlineTree,
  filterOutlineTree,
  getAncestorAnchors,
  getInitialExpandedAnchors,
  getSearchExpandedAnchors,
  isBranchEffectivelyExpanded,
  outlineSublistId,
  trackPageOutline
} from '@/helpers/page-outline'
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
import { decodeBase64Json } from '../../../helpers/base64'
import { hydrateContentExtensions, revealContentExtensionTarget } from '../../../helpers/content-extension-runtime'
import { getErrorMessage, pushGraphError, showNotification } from '../../../helpers/root-ui-store'
import { navigateToWikiPage } from '../../../helpers/wiki-navigation'
import {
  flattenTableOfContents,
  type FlattenedTableOfContentsNode,
  type TableOfContentsNode
} from '../../../helpers/table-of-contents'

/* global siteLangs */

type Breadcrumb = {
  path: string
  title: string
}

type PageTag = {
  tag: string
  title: string | null
}


type PageWatchNotification = {
  id: string
  pageId: number
  eventType: string
  actorName: string
  title: string
  path: string
  localeCode: string
  visibility: 'public' | 'private'
  createdAt: string | number
  readAt: string | null
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
  path?: string
  localeCode?: string
  visibility?: 'public' | 'private'
}

type PageProtection = {
  protected: boolean
  version: number
  updatedBy: number | null
  updatedAt: string | null
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

  const clip = new ClipboardJS(linkCopy, {
    text: () => env.code || ''
  })

  clip.on('success', () => {
    linkCopy.textContent = i18next.t('page.codeCopied', { ns: 'common' })
    resetClipboardText()
  })
  clip.on('error', () => {
    linkCopy.textContent = i18next.t('page.copyCodeShortcut', { ns: 'common' })
    resetClipboardText()
  })

  return linkCopy

  function resetClipboardText() {
    setTimeout(() => {
      linkCopy.textContent = i18next.t('page.copyCode', { ns: 'common' })
    }, 5000)
  }
})

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
            node.title
          )
        ]
      )

      const row = h(
        'div',
        {
          class: 'page-toc-row',
          style: {
            '--toc-indent': `${visualDepth * 14}px`
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
  components: {
    AsyncState,
    NavSidebar,
    StatusIndicator,
    SiteBanner,
    PageBrandingMark,
    PageTocTree,
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
      expandedAnchors: new Set<string>(),
      collapsedByUser: new Set<string>(),
      preSearchExpanded: null as Set<string> | null,
      brandingFailureIdentity: null as string | null,
      preSearchCollapsedByUser: null as Set<string> | null,
      searchOverrides: new Map<string, boolean>(),
      readerFocus: false,
      readingProgress: 0,
      activeAnchor: '',
      outlineCleanup: null as (() => void) | null,
      upBtnShown: false,
      pageEditFab: false,
      pageWatched: false,
      pageWatchLoading: false,
      pageWatchEmailEnabled: true,
      pageWatchInAppEnabled: true,
      pageWatchNotifications: [] as PageWatchNotification[],
      pageWatchNotificationsLoading: false,
      pageWatchNotificationsError: '',
      pageWatchUnreadCount: 0,
      approvalDialog: false,
      approvalLoading: false,
      approvalInitialLoading: false,
      approvalError: '',
      pageApproval: null as PageApproval | null,
      approvalInboxLoading: false,
      approvalInboxError: '',
      approvalInbox: [] as PageApproval[],
      approvalComment: '',
      approvalAssigneeId: null as number | null,
      protectionDialog: false,
      protectionLoading: false,
      protectionInitialLoading: false,
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
      routeAnimationAbortController: null as AbortController | null,
      scrollAnimationFrame: null as number | null,
      railScrollHandler: null as (() => void) | null,
      railRafId: 0,
      railSettleRafId: 0,
      railSettleFrameCount: 0,
      railSettleStableFrames: 0,
      lastSampledRailTop: -1,
      railSettleHandler: null as (() => void) | null,
      lastRailMaxHeight: -1,
      railStickyTop: 80,
      railSpacingGap: 8,
      cachedRailEl: null as HTMLElement | null,
      navFooterEl: null as HTMLElement | null,
      cachedHeaderEl: null as HTMLElement | null,
      railResizeObserver: null as ResizeObserver | null
    }
  },
  computed: {
    navigationOpen: {
      get (): boolean { return !this.readerFocus && this.navShown },
      set (value: boolean) { if (!this.readerFocus) this.navShown = value }
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
    pageBrandingTheme (): PageBrandingTheme {
      const dark = this.$vuetify.theme.current.dark
      const colors = this.$vuetify.theme.current.colors as Record<string, unknown>
      return {
        dark,
        surface: typeof colors.surface === 'string' ? colors.surface : '',
        onSurface: typeof colors['on-surface'] === 'string' ? colors['on-surface'] : ''
      }
    },
    pageBrandingStyle (): Record<string, string> {
      return resolvePageBrandingStyle(this.pageBranding, this.brandingFailureIdentity, this.pageBrandingTheme)
    },
    hasPageBrandingAccent (): boolean {
      return this.pageBrandingStyle['--page-branding-surface'] !== undefined
    },
    isAuthenticated (): boolean {
      return wikiStore.user.authenticated
    },
    commentsPerms () {
      return wikiStore.page.effectivePermissions.comments
    },
    editShortcutsObj () {
      return wikiStore.page.editShortcuts
    },
    breadcrumbs(): Breadcrumb[] {
      const scope = this.visibility === 'private' ? '/_private' : ''
      let currentPath = `${scope}${this.locales.length > 0 ? `/${this.locale}` : ''}`
      const items: Breadcrumb[] = [{ path: '/', title: this.$t('common:header.home') as string }]
      for (const segment of this.path.split('/').filter(Boolean)) {
        currentPath += `/${segment}`
        items.push({ path: currentPath, title: segment })
      }
      return items
    },
    pageUrl (): string {
      const scope = this.visibility === 'private' ? '/_private' : ''
      const locale = this.locales.length > 0 ? `/${this.locale}` : ''
      return new URL(`${scope}${locale}/${this.path}`, window.location.origin).href
    },
    sidebarDecoded (): SidebarItem[] {
      return decodeBase64Json<SidebarItem[]>(this.sidebar)
    },
    tocDecoded (): TableOfContentsNode[] {
      return decodeBase64Json<TableOfContentsNode[]>(this.toc)
    },
    tocFlattened (): FlattenedTableOfContentsNode[] {
      return flattenTableOfContents(this.tocDecoded).filter(node => node.depth <= 1)
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
    },
    tocFlattened: {
      immediate: true,
      handler (entries: FlattenedTableOfContentsNode[]) {
        this.expandedAnchors = getInitialExpandedAnchors(entries)
        this.collapsedByUser = new Set()
        this.preSearchExpanded = null
        this.preSearchCollapsedByUser = null
        this.searchOverrides.clear()
      }
    },
    tocPosition () {
      this.$nextTick(() => {
        this.updateDesktopRailMeasurements(true)
        this.startDesktopRailSettling()
      })
    },
    navigationKey: {
      flush: 'post',
      async handler(value: number, previous: number) {
        if (value === previous) return
        this.syncPageStore()
        this.resetPageRouteState()
        await this.$nextTick()
        this.refreshPageContent()
        this.updateDesktopRailMeasurements(true)
        this.startDesktopRailSettling()
        this.animatePageRoute()
        this.focusPageTitle()
        if (this.isAuthenticated) {
          void this.loadPageWatchState()
          void this.loadPageWatchNotifications()
          void this.loadPageApproval()
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
      void this.loadPageWatchNotifications()
      void this.loadPageApproval()
      void this.loadApprovalInbox()
    }

    if (this.hasWritePagesPermission || this.hasManagePagesPermission || this.hasAdminPermission) {
      void this.loadPageProtection()
    }

    // -> Check side navigation visibility
    this.handleSideNavVisibility()
    this.resizeHandler = () => {
      this.handleSideNavVisibility()
      this.updateDesktopRailMeasurements(true)
      this.startDesktopRailSettling()
    }
    window.addEventListener('resize', this.resizeHandler)

    this.railScrollHandler = () => this.onDesktopRailScroll()
    window.addEventListener('scroll', this.railScrollHandler, { passive: true })

    this.setupDesktopRailObserver()

    this.refreshPageContent()
    this.$nextTick(() => {
      this.setupDesktopRailObserver()
      this.updateDesktopRailMeasurements(true)
      this.startDesktopRailSettling()
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
      this.cachedRailEl = null
    }
    this.navFooterEl = null
    if (this.railResizeObserver) {
      this.railResizeObserver.disconnect()
      this.railResizeObserver = null
    }
    this.cachedHeaderEl = null
    if (this.loadHandler) window.removeEventListener('load', this.loadHandler)
    if (this.beforePrintHandler) window.removeEventListener('beforeprint', this.beforePrintHandler)
    if (this.afterPrintHandler) window.removeEventListener('afterprint', this.afterPrintHandler)
    this.outlineCleanup?.()
    this.restorePrintView()
    this.routeAnimationAbortController?.abort()
    this.routeAnimationAbortController = null
    this.cancelScheduledScroll()
    this.contentExtensionCleanup?.()
    this.contentExtensionCleanup = null
  },
  methods: {
    mergeProps,
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
      wikiStore.page.tags = this.tags.map(tag => tag.tag)
      wikiStore.page.title = this.title
      wikiStore.page.editor = this.editor
      wikiStore.page.updatedAt = this.updatedAt
      wikiStore.page.sourceRevision = this.sourceRevision
      if (this.effectivePermissions) wikiStore.page.effectivePermissions = decodeBase64Json(this.effectivePermissions)
      if (this.editShortcuts) wikiStore.page.editShortcuts = decodeBase64Json(this.editShortcuts)
      wikiStore.page.mode = 'view'
    },
    resetPageRouteState(): void {
      this.cancelScheduledScroll()
      this.tocExpanded = !this.isTocCompact
      this.tocQuery = ''
      this.readingProgress = 0
      this.activeAnchor = ''
      this.expandedAnchors = getInitialExpandedAnchors(this.tocFlattened)
      this.collapsedByUser = new Set()
      this.preSearchExpanded = null
      this.preSearchCollapsedByUser = null
      this.searchOverrides.clear()

      this.pageEditFab = false
      this.brandingFailureIdentity = null
      this.pageWatched = false
      this.pageWatchLoading = false
      this.pageWatchEmailEnabled = true
      this.pageWatchInAppEnabled = true
      this.pageWatchNotificationsLoading = false
      this.pageWatchNotifications = []
      this.pageWatchNotificationsError = ''
      this.pageWatchUnreadCount = 0
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
    refreshPageContent(): void {
      const container = this.$refs.container as HTMLElement
      Prism.highlightAllUnder(container)
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: this.$vuetify.theme.current.dark ? 'dark' : 'default'
      })
      const diagrams = container.querySelectorAll<HTMLElement>('.mermaid')
      void mermaid.run({ nodes: diagrams, suppressErrors: true })

      const currentPageUrl = window.location.href.replace(window.location.hash, '')
      container.querySelectorAll<HTMLAnchorElement>(`a[href^="#"], a[href^="${currentPageUrl}#"]`).forEach(anchor => {
        anchor.onclick = (event: MouseEvent) => {
          event.preventDefault()
          event.stopPropagation()
          this.scrollToPageAnchor(anchor.hash)
        }
      })
      this.contentExtensionCleanup?.()
      this.contentExtensionCleanup = hydrateContentExtensions(container)
      this.outlineCleanup?.()
      this.outlineCleanup = trackPageOutline(container, this.tocFlattened, anchor => {
        this.activeAnchor = anchor
        void this.$nextTick(() => {
          const active = this.$el.querySelector('.page-toc-item[aria-current="location"]') as HTMLElement | null
          const list = (active?.closest('.page-toc-list') || active?.closest('.page-toc-content')) as HTMLElement | null
          if (!active || !list || list.contains(document.activeElement)) return
          const row = active.getBoundingClientRect()
          const viewport = list.getBoundingClientRect()
          if (row.top < viewport.top) list.scrollTop -= viewport.top - row.top
          else if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom
        })
      }, progress => { this.readingProgress = progress })
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
      } else {
        if (currentlyExpanded) {
          this.expandedAnchors.delete(anchor)
          this.collapsedByUser.add(anchor)
        } else {
          this.expandedAnchors.add(anchor)
          this.collapsedByUser.delete(anchor)
        }
      }
    },
    tocLinkClicked (event: MouseEvent, anchor: string) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      if (this.isTocCompact) {
        this.tocExpanded = false
      }
      event.preventDefault()
      this.scrollToPageAnchor(anchor)
    },
    scrollToPageAnchor(anchor: string, focusDestination = true) {
      const container = this.$refs.container as HTMLElement
      const decodedAnchor = decodePageAnchor(anchor)
      const destination = document.getElementById(decodedAnchor.replace(/^#/, ''))
      revealContentExtensionTarget(container, decodedAnchor)
      this.cancelScheduledScroll()
      this.scrollAnimationFrame = requestAnimationFrame(() => {
        this.scrollAnimationFrame = null
        void this.goTo(destination ?? 0, this.scrollOpts)
        if (focusDestination) {
          destination?.setAttribute('tabindex', '-1')
          destination?.focus({ preventScroll: true })
        }
      })
    },
    cancelScheduledScroll () {
      if (this.scrollAnimationFrame === null) return
      cancelAnimationFrame(this.scrollAnimationFrame)
      this.scrollAnimationFrame = null
    },
    async loadPageProtection () {
      const pageId = this.pageId
      this.protectionInitialLoading = true
      this.protectionError = ''
      try {
        const response = await fetch(`/_api/pages/${pageId}/protection`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
        if (!response.ok) throw new Error(this.$t('common:page.pageProtectionRequestError', { status: response.status }))
        const protection = await response.json() as PageProtection
        if (pageId !== this.pageId) return
        this.pageProtection = protection
      } catch (error) {
        if (pageId !== this.pageId) return
        this.protectionError = getErrorMessage(error)
        pushGraphError(wikiStore, error)
      } finally {
        if (pageId === this.pageId) this.protectionInitialLoading = false
      }
    },
    openPageProtection () {
      this.pageProtectionPassword = ''
      this.protectionInitialLoading = true
      this.protectionError = ''
      this.protectionDialog = true
      void this.loadPageProtection()
    },
    async savePageProtection () {
      if (this.protectionLoading) return
      const pageId = this.pageId
      this.protectionLoading = true
      try {
        const response = await fetch(`/_api/pages/${pageId}/protection`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: this.pageProtectionPassword })
        })
        if (!response.ok) throw await this.approvalResponseError(response, this.$t('common:page.pageProtectionUpdateError'))
        const protection = await response.json() as PageProtection
        if (pageId !== this.pageId) return
        this.pageProtection = protection
        this.pageProtectionPassword = ''
        showNotification(wikiStore, {
          style: 'success',
          message: protection.version > 1 ? this.$t('common:page.passwordRotatedSuccess') : this.$t('common:page.passwordProtectionEnabledSuccess')
        })
      } catch (error) {
        if (pageId === this.pageId) pushGraphError(wikiStore, error)
      } finally {
        if (pageId === this.pageId) this.protectionLoading = false
      }
    },
    async removePageProtection () {
      if (this.protectionLoading) return
      const pageId = this.pageId
      this.protectionLoading = true
      try {
        const response = await fetch(`/_api/pages/${pageId}/protection`, {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
        if (!response.ok) throw await this.approvalResponseError(response, this.$t('common:page.pageProtectionRemovalError'))
        if (pageId !== this.pageId) return
        this.pageProtection = { protected: false, version: 0, updatedBy: null, updatedAt: null }
        this.pageProtectionPassword = ''
        showNotification(wikiStore, { style: 'success', message: this.$t('common:page.passwordProtectionRemovedSuccess') })
      } catch (error) {
        if (pageId === this.pageId) pushGraphError(wikiStore, error)
      } finally {
        if (pageId === this.pageId) this.protectionLoading = false
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
    async loadPageApproval () {
      const pageId = this.pageId
      this.approvalInitialLoading = true
      this.approvalError = ''
      try {
        const response = await fetch(`/_api/pages/${pageId}/approval`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
        if (!response.ok) throw await this.approvalResponseError(response, this.$t('common:page.pageApprovalRequestError'))
        const payload = await response.json() as { approval?: unknown }
        if (pageId !== this.pageId) return
        this.pageApproval = payload.approval && typeof payload.approval === 'object' ? payload.approval as PageApproval : null
        this.approvalAssigneeId = this.pageApproval?.assigneeId ?? null
      } catch (error) {
        if (pageId !== this.pageId) return
        this.approvalError = getErrorMessage(error)
        pushGraphError(wikiStore, error)
      } finally {
        if (pageId === this.pageId) this.approvalInitialLoading = false
      }
    },
    async loadApprovalInbox () {
      this.approvalInboxLoading = true
      this.approvalInboxError = ''
      try {
        const response = await fetch('/_api/pages/approvals/inbox', {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
        if (!response.ok) throw await this.approvalResponseError(response, this.$t('common:page.approvalInboxRequestError'))
        const payload = await response.json() as { items?: unknown }
        this.approvalInbox = Array.isArray(payload.items) ? payload.items as PageApproval[] : []
      } catch (error) {
        this.approvalInboxError = getErrorMessage(error)
        pushGraphError(wikiStore, error)
      } finally {
        this.approvalInboxLoading = false
      }
    },
    openApprovalWorkflow () {
      this.approvalComment = ''
      this.approvalInitialLoading = true
      this.approvalError = ''
      this.approvalDialog = true
      void this.loadPageApproval()
    },
    openApprovalInboxItem (approval: PageApproval) {
      const scope = approval.visibility === 'private' ? '/_private' : ''
      navigateToWikiPage(`${scope}/${approval.localeCode}/${approval.path}`)
    },
    async submitPageApproval () {
      if (this.approvalLoading) return
      const pageId = this.pageId
      this.approvalLoading = true
      try {
        const response = await fetch(`/_api/pages/${pageId}/approval`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(this.approvalAssigneeId && this.approvalAssigneeId > 0 ? { assigneeId: this.approvalAssigneeId } : {}),
            ...(this.approvalComment.trim() ? { comment: this.approvalComment.trim() } : {})
          })
        })
        if (!response.ok) throw await this.approvalResponseError(response, this.$t('common:page.approvalSubmissionError'))
        if (pageId !== this.pageId) return
        this.approvalComment = ''
        await Promise.all([this.loadPageApproval(), this.loadApprovalInbox()])
        showNotification(wikiStore, { style: 'success', message: this.$t('common:page.approvalSubmittedSuccess') })
      } catch (error) {
        if (pageId === this.pageId) pushGraphError(wikiStore, error)
      } finally {
        if (pageId === this.pageId) this.approvalLoading = false
      }
    },
    async transitionPageApproval (action: 'approve' | 'request-changes' | 'reject' | 'cancel' | 'resubmit' | 'publish' | 'reassign') {
      if (!this.pageApproval || this.approvalLoading) return
      const pageId = this.pageId
      const approvalId = this.pageApproval.id
      this.approvalLoading = true
      try {
        const response = await fetch(`/_api/pages/approvals/${encodeURIComponent(approvalId)}/transition`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            ...(this.approvalComment.trim() ? { comment: this.approvalComment.trim() } : {}),
            ...(action === 'reassign' && this.approvalAssigneeId && this.approvalAssigneeId > 0 ? { assigneeId: this.approvalAssigneeId } : {})
          })
        })
        if (!response.ok) throw await this.approvalResponseError(response, this.$t('common:page.approvalTransitionError'))
        if (pageId !== this.pageId) return
        this.approvalComment = ''
        await Promise.all([this.loadPageApproval(), this.loadApprovalInbox()])
        showNotification(wikiStore, { style: 'success', message: this.$t('common:page.approvalTransitionSuccess') })
      } catch (error) {
        if (pageId === this.pageId) pushGraphError(wikiStore, error)
      } finally {
        if (pageId === this.pageId) this.approvalLoading = false
      }
    },
    async loadPageWatchState () {
      const pageId = this.pageId
      this.pageWatchLoading = true
      try {
        const response = await fetch(`/_api/pages/${pageId}/watch`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
        if (!response.ok) throw new Error(this.$t('common:page.pageWatchRequestError', { status: response.status }))
        const payload = await response.json() as { watched?: unknown; emailEnabled?: unknown; inAppEnabled?: unknown }
        if (pageId !== this.pageId) return
        this.pageWatched = payload.watched === true
        this.pageWatchEmailEnabled = payload.emailEnabled === true
        this.pageWatchInAppEnabled = payload.inAppEnabled === true
      } catch (error) {
        if (pageId === this.pageId) pushGraphError(wikiStore, error)
      } finally {
        if (pageId === this.pageId) this.pageWatchLoading = false
      }
    },
    async togglePageWatch () {
      if (this.pageWatchLoading) return
      const pageId = this.pageId
      this.pageWatchLoading = true
      try {
        const response = await fetch(`/_api/pages/${pageId}/watch`, {
          method: this.pageWatched ? 'DELETE' : 'PUT',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
        if (!response.ok) throw new Error(this.$t('common:page.pageWatchRequestError', { status: response.status }))
        const payload = await response.json() as { watched?: unknown; emailEnabled?: unknown; inAppEnabled?: unknown }
        if (pageId !== this.pageId) return
        this.pageWatched = payload.watched === true
        if (this.pageWatched) {
          this.pageWatchEmailEnabled = payload.emailEnabled === true
          this.pageWatchInAppEnabled = payload.inAppEnabled === true
        }
        showNotification(wikiStore, {
          style: 'success',
          message: this.pageWatched ? this.$t('common:page.watchEnabled') : this.$t('common:page.watchDisabled')
        })
      } catch (error) {
        if (pageId === this.pageId) pushGraphError(wikiStore, error)
      } finally {
        if (pageId === this.pageId) this.pageWatchLoading = false
      }
    },
    async savePageWatchSettings () {
      if (!this.pageWatched || this.pageWatchLoading) return
      const pageId = this.pageId
      this.pageWatchLoading = true
      try {
        const response = await fetch(`/_api/pages/${pageId}/watch`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            emailEnabled: this.pageWatchEmailEnabled,
            inAppEnabled: this.pageWatchInAppEnabled
          })
        })
        if (!response.ok) throw new Error(this.$t('common:page.pageWatchSettingsRequestError', { status: response.status }))
      } catch (error) {
        if (pageId !== this.pageId) return
        pushGraphError(wikiStore, error)
        await this.loadPageWatchState()
      } finally {
        if (pageId === this.pageId) this.pageWatchLoading = false
      }
    },
    async loadPageWatchNotifications () {
      this.pageWatchNotificationsLoading = true
      this.pageWatchNotificationsError = ''
      try {
        const response = await fetch('/_api/pages/watches/notifications', {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
        if (!response.ok) throw new Error(this.$t('common:page.pageNotificationsRequestError', { status: response.status }))
        const payload = await response.json() as { items?: unknown; unreadCount?: unknown }
        this.pageWatchNotifications = Array.isArray(payload.items) ? payload.items as PageWatchNotification[] : []
        this.pageWatchUnreadCount = typeof payload.unreadCount === 'number' ? payload.unreadCount : 0
      } catch (error) {
        this.pageWatchNotificationsError = getErrorMessage(error)
        pushGraphError(wikiStore, error)
      } finally {
        this.pageWatchNotificationsLoading = false
      }
    },
    pageWatchNotificationSummary (notification: PageWatchNotification) {
      const key = ({
        'page.updated': 'common:page.watchEventUpdated',
        'page.restored': 'common:page.watchEventRestored',
        'page.moved': 'common:page.watchEventMoved',
        'page.deleted': 'common:page.watchEventDeleted',
        'page.visibility-changed': 'common:page.watchEventVisibilityChanged',
        'page.ownership-transferred': 'common:page.watchEventOwnershipTransferred'
      } as Record<string, string>)[notification.eventType] ?? 'common:page.watchEventChanged'
      return this.$t(key, { actor: notification.actorName })
    },
    async openPageWatchNotification (notification: PageWatchNotification) {
      if (!notification.readAt) {
        await fetch(`/_api/pages/watches/notifications/${encodeURIComponent(notification.id)}/read`, {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
      }
      const scope = notification.visibility === 'private' ? '/_private' : ''
      navigateToWikiPage(`${scope}/${notification.localeCode}/${notification.path}`)
    },
    goHome () {
      navigateToWikiPage(this.locales && this.locales.length > 0 ? `/${this.locale}/home` : '/')
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
    goToComments (focusNewComment = false) {
      void this.goTo('#discussion', this.scrollOpts)

      if (focusNewComment) {
        document.querySelector<HTMLElement>('#discussion-new')?.focus()
      }
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
    setupDesktopRailObserver(): void {
      if (typeof window === 'undefined' || typeof ResizeObserver === 'undefined') return

      if (!this.railResizeObserver) {
        this.railResizeObserver = new ResizeObserver(() => {
          this.updateDesktopRailMeasurements(true)
          this.startDesktopRailSettling()
        })
      }

      const headerEl = (this.cachedHeaderEl && this.cachedHeaderEl.isConnected)
        ? this.cachedHeaderEl
        : this.getPageHeaderElement()

      if (headerEl && headerEl !== this.cachedHeaderEl) {
        if (this.cachedHeaderEl) {
          try {
            this.railResizeObserver.unobserve(this.cachedHeaderEl)
          } catch {}
        }
        this.cachedHeaderEl = headerEl
        this.railResizeObserver.observe(headerEl)
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

      const railEl = (this.cachedRailEl && this.cachedRailEl.isConnected)
        ? this.cachedRailEl
        : this.getDesktopRailElement()
      this.cachedRailEl = railEl
      if (!railEl) return

      if (window.innerWidth < 1280 || this.tocPosition === 'off') {
        if (this.lastRailMaxHeight !== -1) {
          railEl.style.removeProperty('--page-desktop-rail-max-height')
          this.lastRailMaxHeight = -1
        }
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

      const footerTop = this.navFooterEl
        ? this.navFooterEl.getBoundingClientRect().top
        : (window.innerHeight - 24)
      const railRect = railEl.getBoundingClientRect()
      const effectiveRailTop = Math.max(railRect.top, this.railStickyTop)
      const calculatedMaxHeight = Math.max(0, Math.floor(footerTop - effectiveRailTop - this.railSpacingGap))

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
  --page-reader-shell-max: 132rem;
  --page-metadata-rail-width: clamp(15rem, 18vw, 17rem);
  --page-reader-column-gap: var(--wiki-space-6);
  --page-reader-copy-max: var(--wiki-reader-copy-width, 101ch);

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

.page-document-label,
.page-document-meta {
  display: flex;
  align-items: center;
  gap: .5rem;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 65%, transparent);
}

.page-document-label {
  margin-block-end: .625rem;
  font-size: .6875rem;
  font-weight: 650;
  letter-spacing: .12em;
  text-transform: uppercase;
}

.page-document-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  margin-block-start: .875rem;
  font-size: .75rem;
  line-height: 1.4;
  gap: var(--wiki-space-3);
}

.page-document-provenance {
  display: flex;
  flex-direction: column;
  gap: 2px;
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

.page-history-btn {
  width: 20px !important;
  height: 20px !important;
  min-width: 20px !important;
  min-height: 20px !important;
  padding: 0 !important;
  color: var(--wiki-accent-ink) !important;
  margin-inline-end: 2px;

  .v-icon {
    font-size: 15px !important;
  }
}

.page-toc-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.page-toc-count {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 65%, transparent);
  font-family: var(--wiki-font-mono);
  font-size: .6875rem;
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
  transition: none;
  background: rgb(var(--v-theme-background));
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

.page-breadcrumb-bar {
  min-height: var(--wiki-control-height);
  border-bottom: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-raised) !important;
  box-shadow: var(--wiki-shadow-xs);

  .v-toolbar__content {
    width: min(100%, var(--wiki-shell-max));
    min-width: 0;
    margin-inline: auto;
    padding-inline: var(--wiki-page-gutter);
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

.page-hero {
  position: relative;
  z-index: 2;
  overflow: visible;
  min-height: 0;
  padding: 0 !important;
  background: rgb(var(--v-theme-surface));
}

.wiki-page--branded .page-hero {
  background: var(--page-branding-surface);
}

.wiki-page--branded .page-header-section::after {
  position: absolute;
  inset-block: var(--wiki-space-4);
  inset-inline-start: 0;
  inline-size: 1px;
  content: '';
  background: var(--page-branding-divider);
  pointer-events: none;
}

.page-hero--with-toc,
.page-hero--with-toc .page-header-section {
  min-height: calc(var(--page-toc-empty-height) + var(--wiki-space-8));
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
    gap: var(--wiki-space-4);
    align-items: center;
    align-content: start;
    padding:
      var(--wiki-space-4)
      var(--wiki-page-gutter) !important;
  }

  .page-header-headings {
    width: 100%;
    min-width: 0;
    max-width: 80rem;
    margin-inline: 0;
    text-align: start;
  }

  .page-header-headings--branded {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: var(--wiki-space-4);
    align-items: start;

    > .page-document-label,
    > .page-title-row,
    > .page-description,
    > .page-document-meta {
      grid-column: 1;
    }

    > .page-branding-mark {
      grid-column: 2;
      grid-row: 1 / span 4;
      align-self: start;
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
    align-self: end;
    overflow: visible;

    .v-btn {
      min-height: calc(var(--wiki-control-height) * .85);
      border: 1px solid var(--wiki-surface-border) !important;
      border-radius: var(--wiki-control-radius) !important;
      background: var(--wiki-surface-raised) !important;
      color: rgb(var(--v-theme-on-surface));
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
 

@media (min-width: 600px) {
  .page-header-section {
    > .is-page-header {
      grid-template-columns: minmax(0, 1fr);
    }

    > .is-page-header.has-edit-shortcuts {
      --page-header-action-reserve: clamp(
        calc(var(--wiki-control-height) * 3),
        22vw,
        calc(var(--wiki-control-height) * 6 + var(--wiki-space-4))
      );
      grid-template-columns:
        minmax(0, 1fr)
        minmax(0, var(--page-header-action-reserve));
    }

    .has-edit-shortcuts .page-header-headings {
      grid-column: 1;
    }

    .has-edit-shortcuts .page-edit-shortcuts {
      position: relative;
      z-index: 2;
      display: flex;
      width: min(100%, var(--page-header-action-reserve));
      min-width: 0;
      max-width: var(--page-header-action-reserve);
      grid-column: 2;
      justify-self: end;
      transform: translateY(calc(var(--wiki-space-4) + 50%));
      overflow: visible;
      .v-btn {
        min-width: 0;
        max-width: 100%;
        flex: 0 1 auto;
        overflow: visible;
      }

      .v-btn__content {
        min-width: 0;
        max-width: 100%;
        overflow: visible;
      }

      .v-btn .text-none {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }
  }
}

@media (min-width: 1280px) {
  .page-header-section {
    > .is-page-header {
      min-height: inherit;
      gap: var(--page-reader-column-gap);
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

    > .page-header--toc-left.has-edit-shortcuts {
      grid-template-columns:
        var(--page-metadata-rail-width)
        minmax(0, 1fr)
        minmax(0, var(--page-header-action-reserve));

      .page-edit-shortcuts {
        grid-column: 3;
      }
    }

    > .page-header--toc-right {
      grid-template-columns:
        minmax(0, 1fr)
        var(--page-metadata-rail-width);
    }

    > .page-header--toc-right.has-edit-shortcuts {
      grid-template-columns:
        minmax(0, 1fr)
        minmax(0, var(--page-header-action-reserve))
        var(--page-metadata-rail-width);

      .page-edit-shortcuts {
        padding-inline-end: var(--wiki-space-4);
      }
    }
  }
}


/* Stacking context must paint above .page-hero (z-index: 2) so upward-lifted desktop rail cards remain visible and interactive */
.page-body {
  position: relative;
  z-index: 3;
  width: min(100%, var(--page-reader-shell-max));
  margin-inline: auto;
  padding:
    var(--wiki-space-8)
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
.page-mobile-metadata {
  display: none;
}

.page-desktop-rail {
  display: contents;
}

.page-col-sd--with-toc {
  margin-block-start: calc(var(--page-toc-desktop-lift) * -1);
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

  .page-shortcuts-card {
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

  > .page-toc-heading {
    padding:
      var(--wiki-space-4)
      var(--wiki-space-4)
      var(--wiki-space-2) !important;
  }

  .page-toc-toggle {
    display: none;
  }

  .page-toc-toggle-label {
    color: var(--wiki-accent-ink);
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
  overscroll-behavior: contain;
  padding: var(--wiki-space-1) var(--wiki-space-2) var(--wiki-space-2);
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
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
  min-height: calc(var(--wiki-control-height) - var(--wiki-space-2)) !important;
  padding: 2px var(--wiki-space-2);
  border-inline-start: 2px solid transparent;
  border-radius: var(--wiki-radius-xs);
  color: rgb(var(--v-theme-on-surface));
  text-decoration: none;
  transition:
    background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    color var(--wiki-motion-fast) var(--wiki-motion-ease);

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
  }

  &.page-toc-item--descendant-active {
    border-inline-start-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 40%, transparent);
  }
}

.page-toc-item-title {
  padding-inline: 0 !important;
  font-size: .8125rem;
  line-height: 1.4;
  overflow-wrap: break-word;
}

.page-toc-item-title--depth-0 {
  font-weight: 700;
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

.page-shortcuts-card {
  --page-shortcut-target: 28px;

  border: 1px solid var(--wiki-surface-border) !important;
  overflow: visible !important;
  min-height: 32px;

  .v-toolbar {
    height: auto !important;
    min-height: 32px;
    background: transparent !important;
    overflow: visible !important;
    padding: 2px 4px !important;
  }

  .v-toolbar__content {
    display: flex;
    height: auto !important;
    min-height: 28px;
    flex-wrap: nowrap;
    gap: 0;
    justify-content: center;
    align-items: center;
    padding: 0 !important;
    overflow: visible !important;
  }

  .v-spacer {
    display: none;
  }

  .v-badge {
    display: inline-flex;
    flex: 0 0 auto;
    overflow: visible;

    .v-badge__wrapper {
      overflow: visible;
    }
  }

  .v-btn {
    width: 28px !important;
    min-width: 28px !important;
    max-width: 28px !important;
    height: 28px !important;
    min-height: 28px !important;
    max-height: 28px !important;
    padding: 0 !important;
    border-radius: var(--wiki-radius-xs) !important;
    flex: 0 0 28px !important;

    .v-icon {
      font-size: 18px !important;
      width: 18px !important;
      height: 18px !important;
    }

    &:hover {
      background: color-mix(in srgb, var(--wiki-accent-warm) 8%, transparent);
    }
  }
}

.page-col-content:not(.is-page-header) {
  min-width: 0;
  padding-inline: var(--wiki-space-4) 0;
}

.page-col-content--toc-right:not(.is-page-header) {
  padding-inline: 0 var(--wiki-space-4);
}

.page-col-content > .contents {
  --page-reader-surface-padding: clamp(var(--wiki-space-6), 3vw, var(--wiki-space-12));

  min-height: calc(var(--wiki-grid-size) * 3);
  scroll-margin-block-start: calc(var(--v-layout-top, 64px) + 24px);
  padding: var(--page-reader-surface-padding);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: rgb(var(--v-theme-surface));
  box-shadow: var(--wiki-shadow-xs);

  > div {
    width: min(100%, var(--page-reader-copy-max));
    margin: 0 auto 0 0;
  }

  h1,
  h2,
  h3,
  h4,
  h5,
  h6 {
    position: relative;
    scroll-margin-block-start: calc(var(--v-layout-top, var(--wiki-grid-size)) + var(--wiki-space-8));

    .toc-anchor {
      position: absolute;
      inset-block-end: .08em;
      inset-inline-start: calc(100% + var(--wiki-space-2));
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
    overscroll-behavior: contain;
  }
  .page-col-content:not(.is-page-header),
  .page-col-content--toc-right:not(.is-page-header) {
    padding-inline: 0;
  }
}
@media (min-width: 600px) and (max-width: 1279px) {
  .page-body > .v-row > .page-shortcuts-card,
  .page-body > .v-row > .page-toc-card {
    order: 0 !important;
    align-self: flex-start;
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-control-radius);
  }

  .page-body > .v-row {
    gap: var(--wiki-space-4);
  }

  .page-body > .v-row > .page-shortcuts-card,
  .page-body > .v-row > .page-toc-card,
  .page-body > .v-row > .page-tags-card,
  .page-body > .v-row > .page-comments-card {
    order: 2;
    width: calc(50% - var(--wiki-space-4) / 2);
    max-width: calc(50% - var(--wiki-space-4) / 2);
    min-width: 0;
    flex: 0 0 calc(50% - var(--wiki-space-4) / 2);
    margin-bottom: 0 !important;
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
    padding: var(--wiki-space-8);
  }
}

@media (max-width: 599px) {
  .page-breadcrumb-bar {
    min-height: calc(var(--wiki-control-height) - var(--wiki-space-2));
  }

  .page-breadcrumb-bar .v-toolbar__content {
    gap: var(--wiki-space-2);
    overflow: hidden;
    padding-inline: var(--wiki-space-2);
  }

  .page-breadcrumb-bar .breadcrumbs-nav {
    flex: 1 1 auto;
    overflow-x: auto;
    overflow-inline: auto;
    white-space: nowrap;
  }

  .page-breadcrumb-bar .breadcrumbs-nav.v-breadcrumbs {
    flex-wrap: nowrap;
  }

  .page-breadcrumb-bar .v-spacer,
  .page-breadcrumb-bar .text-warning,
  .page-breadcrumb-bar .status-indicator {
    flex: 0 0 auto;
  }

  .page-breadcrumb-bar .v-spacer {
    display: none;
  }

  .breadcrumbs-nav {
    font-size: .75rem;
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

  .page-mobile-tools > .page-shortcuts-card,
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
    border-radius: 0;
  }


  .page-toc-card {
    min-height: var(--wiki-control-height);
    max-height: calc(var(--wiki-grid-size) * 5);
  }

  .page-col-content > .contents {
    min-height: calc(var(--wiki-grid-size) * 2);
    padding:
      var(--wiki-space-6)
      var(--wiki-space-4)
      var(--wiki-space-8);
    border-radius: var(--wiki-panel-radius);

    h1 .toc-anchor {
      opacity: .48;
    }

    h2,
    h3,
    h4,
    h5,
    h6 {
      .toc-anchor {
        position: static;
        margin-inline-start: var(--wiki-space-1);
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
  .page-breadcrumb-bar,
  .page-edit-shortcuts,
  .page-edit-fab,
  .page-return-top,
  .page-mobile-tools,
  .page-mobile-metadata,
  .page-col-sd,
  .page-shortcuts-card,
  .page-toc-card,
  .page-tags-card,
  .page-comments-card,
  .page-history-btn,
  .comments-container {
    display: none !important;
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

  .page-header-section::after,
  .page-branding-mark {
    display: none !important;
  }

  .page-header-headings--branded {
    display: block;
  }

  .page-header-headings--branded > .page-document-label {
    min-block-size: auto;
    padding-inline-end: 0;
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

  .wiki-page--branded .page-hero {
    background: Canvas !important;
  }

  .page-header-section::after,
  .page-branding-mark {
    display: none !important;
  }

  .page-header-headings--branded {
    display: block;
  }

  .page-header-headings--branded > .page-document-label {
    min-block-size: auto;
    padding-inline-end: 0;
  }
}


@media (prefers-reduced-motion: reduce) {
  .page-return-top,
  .page-edit-fab,
  .page-nav-toggle,
  .page-header-section .page-edit-shortcuts .v-btn,
  .page-toc-item {
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
  inset-block-start: var(--v-layout-top, 64px);
  inset-inline: 0;
  z-index: 1004;
  height: 2px;
  pointer-events: none;
}

.page-position-fill {
  width: 100%;
  height: 100%;
  background: var(--wiki-accent-ink);
  transform-origin: left;
}

.is-rtl .page-position-fill { transform-origin: right; }

.page-focus-control {
  margin-inline-start: var(--wiki-space-1);
  border-inline-start: 1px solid var(--wiki-surface-border);
  padding-inline-start: var(--wiki-space-3);
  border-radius: 0;
  color: var(--wiki-accent-ink);
  letter-spacing: 0;
}


.page-reading-dock {
  position: fixed;
  inset-block-end: calc(var(--wiki-footer-height) + env(safe-area-inset-bottom) + 1rem);
  inset-inline-start: 50%;
  z-index: 1006;
  display: flex;
  align-items: center;
  gap: .75rem;
  width: max-content;
  max-width: min(32rem, calc(100% - 2rem));
  padding: .5rem .5rem .5rem 1rem;
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--wiki-radius-pill);
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
  box-shadow: var(--wiki-shadow-md);
  transform: translateX(-50%);

  .v-btn { flex-shrink: 0; color: var(--wiki-accent-ink); }
}

.is-rtl .page-reading-dock { transform: translateX(50%); }

.page-reading-dock-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--wiki-font-display);
  font-size: 1.125rem;
}

.wiki-page.wiki-page--reading {
  --page-reader-shell-max: 64rem;
  --page-reader-copy-max: min(72ch, var(--wiki-reader-copy-width, 101ch));

  .page-col-sd,
  .page-mobile-tools,
  .page-mobile-metadata,
  .page-body > .v-row > .v-card,
  .page-edit-shortcuts,
  .page-edit-fab { display: none !important; }

  .page-header-section > .is-page-header {
    grid-template-columns: minmax(0, 1fr);
    padding-block: var(--wiki-space-8) !important;
  }

  .page-header-section .page-header-headings {
    grid-column: 1;
    max-width: var(--page-reader-copy-max);
    margin-inline: auto;
    font-size: 1.0625rem;
    padding-inline-start: 0;
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

  .page-main,
  .page-body { background: rgb(var(--v-theme-surface)); }
}

@media (max-width: 599px) {
  .page-reading-dock-title { display: none; }

  .page-header-headings--branded {
    display: block;

    > .page-document-label {
      min-block-size: 40px;
      padding-inline-end: calc(40px + var(--wiki-space-3));
      align-items: center;
    }

    > .page-branding-mark {
      position: absolute;
      inset-block-start: 0;
      inset-inline-end: 0;
    }
  }
}

@media print {
  .page-position,
  .page-focus-control,
  .page-history-btn,
  .page-reading-dock { display: none !important; }
}

</style>
