<template lang="pug">
  v-app.wiki-page(v-scroll='upBtnScroll', :class='$vuetify.locale.isRtl ? `is-rtl` : `is-ltr`')
    nav-header(v-if='!printView')
    v-navigation-drawer(
      v-if='navMode !== `NONE` && !printView'
      id='page-navigation-drawer'
      class='page-navigation'
      color='surface'
      mobile-breakpoint='1280'
      :width='$vuetify.display.width >= 1280 ? 281.6 : 256'
      :temporary='$vuetify.display.width < 1280'
      v-model='navShown'
      :aria-label='$t(`common:sidebar.mainMenu`)'
      @update:model-value='navigationVisibilityChanged'
      :location="$vuetify.locale.isRtl ? 'right' : undefined"
      )
      vue-scroll.page-nav-scroll(:ops='scrollStyle', style='scrollbar-gutter: auto;')
        nav-sidebar(
          color=''
          :items='sidebarDecoded'
          :nav-mode='navMode'
          :expand-parent-by-default='navExpandParent'
          @navigate='sidebarNavigationStarted'
        )

    v-fab-transition(v-if='navMode !== `NONE`')
      v-btn.page-nav-toggle(
        ref='navToggle'
        :class='{ "page-nav-toggle--open": navShown }'
        icon
        color='primary'
        size="small"
        @click='toggleNavigation'
        :aria-expanded='navShown ? `true` : `false`'
        aria-controls='page-navigation-drawer'
        :aria-label='navShown ? `Close navigation` : `Open navigation`'
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
            aria-label='Breadcrumb'
          )
            template(v-slot:item='props')
              v-btn.ma-0(
                v-if='props.item.path === "/"'
                size="small"
                variant="text"
                @click='goHome'
                aria-label='Home'
              )
                v-icon(aria-hidden='true', size="small") mdi-home
              v-btn.ma-0(
                v-else
                :href='props.item.path'
                size="small"
                variant="text"
                :aria-current='props.item.path === breadcrumbs[breadcrumbs.length - 1].path ? `page` : undefined'
              ) {{props.item.name}}
          template(v-if='!isPublished')
            v-spacer
            .text-body-small.text-warning {{$t('common:page.unpublished')}}
            status-indicator.ml-3(negative, pulse)
        v-divider
      v-container.page-hero(
        fluid
        :class='{ "page-hero--with-toc": tocPosition !== `off` }'
      )
        v-row.page-header-section(no-gutters)
          v-col.page-col-content.is-page-header(
            cols='12'
            :class='[$vuetify.locale.isRtl ? `pr-4` : `pl-4`, `page-header--toc-${tocPosition}`, { "has-edit-shortcuts": editShortcutsObj.editMenuBar && (editShortcutsObj.editMenuBtn || editShortcutsObj.editMenuExternalBtn) }]'
            )
            .page-header-headings
              .page-title-row.d-flex.align-center
                h1.page-title {{title}}
                v-chip.page-visibility.ml-3(v-if="visibility === 'private'", size="small", color='warning', variant='tonal') Private
              p.page-description(v-if='description') {{description}}
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
                v-if='editShortcutsObj.editMenuExternalBtn'
                :href='editMenuExternalUrl'
                target='_blank'
                variant="flat"
                size="small"
                )
                v-icon.mr-2(size="small") {{ editShortcutsObj.editMenuExternalIcon }}
                span.text-none {{$t(`common:page.editExternal`, { name: editShortcutsObj.editMenuExternalName })}}
      v-divider
      v-container.page-body(fluid)
        v-row
          v-col.page-col-sd(
            cols='12'
            :lg='tocPosition !== `off` ? 3 : 12'
            :xl='tocPosition !== `off` ? 2 : 12'
            :class='[tocPosition === `right` ? `order-2 order-lg-2` : `order-2 order-lg-1`, { "page-col-sd--with-toc": tocPosition !== `off`, "page-col-sd--toc-off": tocPosition === `off` }]'
            )
            v-card.page-toc-card.mb-4(v-if='tocPosition !== `off`', tag='nav', :aria-label='$t(`common:page.toc`)')
              .text-label-small.text-primary {{$t('common:page.toc')}}
              v-list.py-2(v-if='tocFlattened.length', density="compact", nav)
                v-list-item.page-toc-item(
                  v-for='tocItem in tocFlattened'
                  :key='tocItem.anchor'
                  :href='tocItem.anchor'
                  :style='`--toc-indent: ${Math.min(tocItem.depth, 5) * 14}px`'
                  @click='tocLinkClicked($event, tocItem.anchor)'
                  )
                  template(v-slot:prepend)
                    v-icon.page-toc-item-marker(size="x-small") {{ $vuetify.locale.isRtl ? `mdi-chevron-left` : `mdi-chevron-right` }}
                  v-list-item-title.page-toc-item-title(
                    :class='{ "font-weight-medium": tocItem.depth === 0 }'
                    ) {{tocItem.title}}
              .page-toc-empty(v-else)
                v-icon(aria-hidden='true', size='small') mdi-format-list-bulleted
                span.text-body-small No sections on this page

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

            v-card.page-author-card.mb-5
              .pa-5
                .text-label-small.d-flex.text-accent
                  span {{$t('common:page.lastEditedBy')}}
                  v-spacer
                  v-tooltip(location="right", v-if='isAuthenticated')
                    template(v-slot:activator='{ props }')
                      v-btn.btn-animate-edit(
                        icon
                        :href='(visibility === `private` ? `/h/_private` : `/h`) + `/` + locale + `/` + path'
                        v-bind='props'
                        size="x-small"
                        v-if='hasReadHistoryPermission'
                        :aria-label='$t(`common:header.history`)'
                        )
                        v-icon(color='accent', size="small") mdi-history
                    span {{$t('common:header.history')}}
                .page-author-card-name.text-body-medium {{ authorName }}
                .page-author-card-date.text-body-small.text-medium-emphasis {{ $helpers.formatMoment(updatedAt, 'calendar') }}

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

            v-card.page-shortcuts-card(flat)
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
                        v-btn(icon, rounded='0', v-bind='{ ...menuProps, ...tooltipProps }', :aria-label='$t(`common:page.share`)'): v-icon(color='grey') mdi-share-variant
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
                            v-bind='{ ...menuProps, ...tooltipProps }'
                            @click='loadPageWatchNotifications'
                            aria-label='Page notifications'
                          )
                            v-icon(color='grey') mdi-bell
                      span Page notifications
                  v-card
                    v-card-title.text-body-large Page notifications
                    v-divider
                    async-state(
                      v-if='pageWatchNotificationsLoading'
                      state='loading'
                      title='Loading page notifications'
                    )
                    async-state(
                      v-else-if='pageWatchNotificationsError'
                      state='error'
                      title='Page notifications could not be loaded'
                      :message='pageWatchNotificationsError'
                      retry-label='Try again'
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
                      title='No page notifications'
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
                      :aria-label='pageWatched ? `Stop watching page` : `Watch page`'
                    )
                      v-icon(:color='pageWatched ? `primary` : `grey`') {{ pageWatched ? 'mdi-bell-ring' : 'mdi-bell-outline' }}
                  span {{ pageWatched ? 'Stop watching page' : 'Watch page' }}
                v-menu(v-if='pageWatched', location="bottom", :close-on-content-click='false', min-width='260')
                  template(v-slot:activator='{ props: menuProps }')
                    v-tooltip(location="bottom")
                      template(v-slot:activator='{ props: tooltipProps }')
                        v-btn(
                          icon
                          rounded='0'
                          v-bind='{ ...menuProps, ...tooltipProps }'
                          aria-label='Watch settings'
                        )
                          v-icon(color='grey') mdi-tune
                      span Watch settings
                  v-card
                    v-card-title.text-body-large Watch settings
                    v-card-text
                      v-switch(
                        v-model='pageWatchEmailEnabled'
                        label='Email notifications'
                        color='primary'
                        density='compact'
                        hide-details
                        @update:model-value='savePageWatchSettings'
                      )
                      v-switch(
                        v-model='pageWatchInAppEnabled'
                        label='In-app notifications'
                        color='primary'
                        density='compact'
                        hide-details
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
                            v-bind='{ ...menuProps, ...tooltipProps }'
                            @click='loadApprovalInbox'
                            aria-label='Approval inbox'
                          )
                            v-icon(color='grey') mdi-inbox-arrow-down
                      span Approval inbox
                  v-card
                    v-card-title.text-body-large Approval inbox
                    v-divider
                    async-state(
                      v-if='approvalInboxLoading'
                      state='loading'
                      title='Loading approval inbox'
                    )
                    async-state(
                      v-else-if='approvalInboxError'
                      state='error'
                      title='Approval inbox could not be loaded'
                      :message='approvalInboxError'
                      retry-label='Try again'
                      @retry='loadApprovalInbox'
                    )
                    v-list(v-else-if='approvalInbox.length > 0', lines='three', density='compact')
                      v-list-item(
                        v-for='approval in approvalInbox'
                        :key='approval.id'
                        @click='openApprovalInboxItem(approval)'
                      )
                        v-list-item-title {{ approval.title }}
                        v-list-item-subtitle {{ approvalStatusLabel(approval.status) }} · Revision {{ approval.revisionId }}
                        v-list-item-subtitle(v-if='approval.stale') Submitted revision is stale
                    async-state(
                      v-else
                      state='empty'
                      title='No active approval requests'
                    )
                v-tooltip(location="bottom", v-if='isAuthenticated && (hasWritePagesPermission || hasManagePagesPermission || hasAdminPermission)')
                  template(v-slot:activator='{ props }')
                    v-btn(
                      icon
                      rounded='0'
                      v-bind='props'
                      @click='openApprovalWorkflow'
                      aria-label='Approval workflow'
                    )
                      v-icon(:color='pageApproval ? `primary` : `grey`') mdi-check-decagram-outline
                  span Approval workflow
                v-tooltip(location="bottom", v-if='isAuthenticated && (hasWritePagesPermission || hasManagePagesPermission || hasAdminPermission)')
                  template(v-slot:activator='{ props }')
                    v-btn(
                      icon
                      rounded='0'
                      v-bind='props'
                      @click='openPageProtection'
                      aria-label='Page password protection'
                    )
                      v-icon(:color='pageProtection.protected ? `primary` : `grey`') {{ pageProtection.protected ? 'mdi-lock' : 'mdi-lock-open-outline' }}
                  span Page password protection
                v-tooltip(location="bottom")
                  template(v-slot:activator='{ props }')
                    v-btn(icon, rounded='0', v-bind='props', @click='print', :aria-label='$t(`common:page.printFormat`)')
                      v-icon(:color='printView ? `primary` : `grey`') mdi-printer
                  span {{$t('common:page.printFormat')}}
                v-spacer

          v-col.page-col-content(
            cols='12'
            :lg='tocPosition !== `off` ? 9 : 12'
            :xl='tocPosition !== `off` ? 10 : 12'
            :class='[tocPosition === `right` ? `order-1 order-lg-1` : `order-1 order-lg-2`, { "page-col-content--with-toc": tocPosition !== `off`, "page-col-content--toc-off": tocPosition === `off` }]'
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
                      aria-label='Page actions'
                    )
                      v-icon mdi-pencil
                  v-tooltip(location='start', v-if='hasWritePagesPermission')
                    template(v-slot:activator='{ props }')
                      v-btn(icon, size="small", color='white', v-bind='props', @click='pageEdit', aria-label='Edit page')
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
            v-alert.mb-5(v-if='!isPublished', color='warning', variant="outlined", icon='mdi-minus-circle', density="compact")
              .text-body-small {{$t('common:page.unpublishedWarning')}}
            site-banner(:banner='siteBanner')
            .contents(ref='container')
              .wiki-gutter-art.page-gutter-ornament.page-gutter-ornament--start(
                :class='`wiki-gutter-art--${gutterStyle}`'
                :style='gutterOrnamentStyle'
                aria-hidden='true'
              )
                page-gutter-column(v-if='gutterStyle === `columns`')
              .wiki-gutter-art.page-gutter-ornament.page-gutter-ornament--end(
                :class='`wiki-gutter-art--${gutterStyle}`'
                :style='gutterOrnamentStyle'
                aria-hidden='true'
              )
                page-gutter-column(v-if='gutterStyle === `columns`')
              template(v-if='$slots.contents')
                slot(name='contents')
              async-state(
                v-else
                state='empty'
                title='This page has no content'
              )
            section.comments-container#discussion(v-if='commentsEnabled && commentsPerms.read && !printView' aria-labelledby='discussion-title')
              .comments-header
                .comments-header-icon
                  v-icon(size='20') mdi-comment-text-outline
                div
                  h2#discussion-title.comments-title {{$t('common:comments.title')}}
                  .comments-subtitle Join the conversation around this page
              .comments-main
                slot(name='comments')
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
          v-toolbar-title#page-protection-title(tag='h2') Page password protection
          v-spacer
          v-btn(icon, @click='protectionDialog = false', aria-label='Close page password protection')
            v-icon mdi-close
        v-progress-linear(v-if='protectionLoading || protectionInitialLoading', indeterminate, color='primary')
        async-state(
          v-if='protectionInitialLoading'
          state='loading'
          title='Loading page protection'
        )
        async-state(
          v-else-if='protectionError'
          state='error'
          title='Page protection could not be loaded'
          :message='protectionError'
          retry-label='Try again'
          @retry='loadPageProtection'
        )
        template(v-else)
          v-card-text.pa-5
            v-alert.mb-4(
              :type='pageProtection.protected ? `info` : `warning`'
              variant='tonal'
            )
              template(v-if='pageProtection.protected') Password protection is active. Setting a new password rotates it and immediately revokes every prior unlock.
              template(v-else) Readers can currently access this page without a page password.
            p.text-body-medium.text-medium-emphasis.mb-4
              | Unlocks last 12 hours in the current browser session. Group page permissions do not bypass the password; system administrators can recover access. Protected source, history, downloads, linked assets, and content APIs use the same unlock.
            v-text-field(
              v-model='pageProtectionPassword'
              type='password'
              label='New page password'
              autocomplete='new-password'
              minlength='12'
              maxlength='1024'
              hint='Use at least 12 characters. Passwords are stored only as bcrypt cost-12 hashes.'
              persistent-hint
            )
          v-divider
          v-card-actions.flex-wrap.pa-4
            v-btn(
              color='primary'
              :disabled='pageProtectionPassword.length < 12'
              :loading='protectionLoading'
              @click='savePageProtection'
            ) {{ pageProtection.protected ? 'Rotate password' : 'Enable protection' }}
            v-btn(
              v-if='pageProtection.protected'
              color='error'
              variant='text'
              :disabled='protectionLoading'
              @click='removePageProtection'
            ) Remove protection
            v-spacer
            v-btn(@click='protectionDialog = false') Close
    v-dialog(
      v-model='approvalDialog'
      :fullscreen='$vuetify.display.smAndDown'
      max-width='680'
      scrollable
      aria-labelledby='page-approval-title'
    )
      v-card
        v-toolbar(color='primary', flat)
          v-toolbar-title#page-approval-title(tag='h2') Approval workflow
          v-spacer
          v-btn(icon, @click='approvalDialog = false', aria-label='Close approval workflow')
            v-icon mdi-close
        v-progress-linear(v-if='approvalLoading || approvalInitialLoading', indeterminate, color='primary')
        async-state(
          v-if='approvalInitialLoading'
          state='loading'
          title='Loading approval workflow'
        )
        async-state(
          v-else-if='approvalError'
          state='error'
          title='Approval workflow could not be loaded'
          :message='approvalError'
          retry-label='Try again'
          @retry='loadPageApproval'
        )
        template(v-else)
          v-card-text.pa-5
            template(v-if='pageApproval')
              .d-flex.align-center.flex-wrap.ga-2.mb-4
                v-chip(color='primary', variant='tonal') {{ approvalStatusLabel(pageApproval.status) }}
                v-chip(v-if='pageApproval.stale', color='warning', variant='tonal') Stale revision
                span.text-medium-emphasis Revision {{ pageApproval.revisionId }}
              v-alert.mb-4(
                v-if='pageApproval.stale'
                type='warning'
                variant='tonal'
              ) This page changed after submission. Request changes and resubmit before approval.
              v-text-field(
                v-if='pageApproval.canReview'
                v-model.number='approvalAssigneeId'
                type='number'
                min='1'
                label='Reviewer user ID'
                hint='Leave unchanged to keep the current reviewer.'
                persistent-hint
              )
              v-textarea(
                v-model='approvalComment'
                label='Review comment'
                rows='3'
                auto-grow
                hint='Required when requesting changes or rejecting.'
                persistent-hint
              )
              v-card.mt-5(variant='outlined')
                v-card-title.text-body-large Review history
                v-list(lines='two', density='compact')
                  v-list-item(v-for='transition in pageApproval.transitions', :key='transition.id')
                    v-list-item-title {{ approvalStatusLabel(transition.toStatus) }}
                    v-list-item-subtitle Reviewer {{ transition.actorId }} · {{ new Date(transition.createdAt).toLocaleString() }}
                    v-list-item-subtitle(v-if='transition.comment') {{ transition.comment }}
            template(v-else)
              p.text-body-large.mb-4 Submit the current page revision for review. Later edits make the submission stale and cannot be published without resubmission.
              v-text-field(
                v-model.number='approvalAssigneeId'
                type='number'
                min='1'
                label='Reviewer user ID (optional)'
              )
              v-textarea(v-model='approvalComment', label='Submission note', rows='3', auto-grow)
          v-divider
          v-card-actions.flex-wrap.pa-4
            v-btn(
              v-if='hasWritePagesPermission && (!pageApproval || [`rejected`, `cancelled`, `published`].includes(pageApproval.status))'
              color='primary'
              :loading='approvalLoading'
              @click='submitPageApproval'
            ) {{ pageApproval ? 'Submit new revision' : 'Submit for approval' }}
            template(v-if='pageApproval')
              v-btn(v-if='pageApproval.status === `submitted` && pageApproval.canReview', color='success', :disabled='pageApproval.stale', @click='transitionPageApproval(`approve`)') Approve
              v-btn(v-if='pageApproval.status === `submitted` && pageApproval.canReview', color='warning', @click='transitionPageApproval(`request-changes`)') Request changes
              v-btn(v-if='pageApproval.status === `submitted` && pageApproval.canReview', color='error', @click='transitionPageApproval(`reject`)') Reject
              v-btn(v-if='pageApproval.status === `changes-requested` && pageApproval.canSubmitter', color='primary', @click='transitionPageApproval(`resubmit`)') Resubmit
              v-btn(v-if='pageApproval.status === `approved` && pageApproval.canReview', color='success', :disabled='pageApproval.stale', @click='transitionPageApproval(`publish`)') Publish approved revision
              v-btn(v-if='pageApproval.canReview && [`submitted`, `approved`, `changes-requested`].includes(pageApproval.status)', @click='transitionPageApproval(`reassign`)') Reassign
              v-btn(v-if='pageApproval.canSubmitter && [`submitted`, `approved`, `changes-requested`].includes(pageApproval.status)', color='error', variant='text', @click='transitionPageApproval(`cancel`)') Cancel request
            v-spacer
            v-btn(@click='approvalDialog = false') Close
    v-fab-transition
      v-btn.page-return-top(
        v-if='upBtnShown'
        icon
        fixed
        color='primary'
        @click='returnToTop'
        :aria-label='$t(`common:actions.returnToTop`)'
        )
        v-icon mdi-arrow-up
</template>

<script lang='ts'>
import { defineComponent, type PropType } from 'vue'
import { useGoTo } from 'vuetify'
import AsyncState from '@/components/common/async-state.vue'
import PageGutterColumn from '@/components/common/page-gutter-column.vue'
import StatusIndicator from '@/components/common/status-indicator.vue'
import SiteBanner from '@/components/common/site-banner.vue'
import NavSidebar, { type SidebarItem } from './nav-sidebar.vue'
import type { Environment as PrismEnvironment } from 'prismjs'
import Prism from '../../../libs/prism/setup'
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
  name: string
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
    AsyncState,
    PageGutterColumn,
    NavSidebar,
    StatusIndicator,
    SiteBanner,
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
    }
  },
  data() {
    return {
      locales: siteLangs,
      navShown: false,
      navExpanded: false,
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
      gutterStyle: siteConfig.gutterStyle,
      gutterCustomCss: siteConfig.gutterCustomCss,
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
          background: 'rgb(var(--v-theme-primary))',
          hoverStyle: {
            background: 'rgb(var(--v-theme-primary-darken-1))'
          }
        }
      },
      winWidth: 0,
      resizeHandler: null as (() => void) | null,
      contentExtensionCleanup: null as (() => void) | null
    }
  },
  computed: {
    gutterOrnamentStyle (): string | undefined {
      return this.gutterStyle === 'custom' ? this.gutterCustomCss : undefined
    },
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
      const scope = this.visibility === 'private' ? '/_private' : ''
      return [{ path: '/', name: 'Home' }].concat(
        _.reduce<string, Breadcrumb[]>(this.path.split('/'), (result, value) => {
          result.push({
            path: (_.last(result)?.path || `${scope}${this.locales.length > 0 ? `/${this.locale}` : ''}`) + `/${value}`,
            name: value
          })
          return result
        }, []))
    },
    pageUrl () { return window.location.href },
    sidebarDecoded (): SidebarItem[] {
      return decodeBase64Json<SidebarItem[]>(this.sidebar)
    },
    tocDecoded (): TableOfContentsNode[] {
      return decodeBase64Json<TableOfContentsNode[]>(this.toc)
    },
    tocFlattened (): FlattenedTableOfContentsNode[] {
      return flattenTableOfContents(this.tocDecoded)
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
        return this.editShortcutsObj.editMenuExternalUrl.replace('{filename}', this.filename)
      } else {
        return ''
      }
    }
  },
  watch: {
    navigationKey: {
      flush: 'post',
      async handler(value: number, previous: number) {
        if (value === previous) return
        this.syncPageStore()
        this.resetPageRouteState()
        await this.$nextTick()
        this.refreshPageContent()
        this.animatePageRoute()
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
    this.resizeHandler = () => this.handleSideNavVisibility()
    window.addEventListener('resize', this.resizeHandler)

    this.refreshPageContent()

    // -> Handle anchor scrolling
    if (window.location.hash && window.location.hash.length > 1) {
      if (document.readyState === 'complete') {
        this.$nextTick(() => {
          this.scrollToPageAnchor(decodeURIComponent(window.location.hash), false)
        })
      } else {
        window.addEventListener('load', () => {
          this.scrollToPageAnchor(decodeURIComponent(window.location.hash), false)
        }, { once: true })
      }
    }
  },
  beforeUnmount () {
    if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler)
    this.contentExtensionCleanup?.()
    this.contentExtensionCleanup = null
  },
  methods: {
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
      wikiStore.page.tags = this.tags
      wikiStore.page.title = this.title
      wikiStore.page.editor = this.editor
      wikiStore.page.updatedAt = this.updatedAt
      wikiStore.page.sourceRevision = this.sourceRevision
      if (this.effectivePermissions) wikiStore.page.effectivePermissions = decodeBase64Json(this.effectivePermissions)
      if (this.editShortcuts) wikiStore.page.editShortcuts = decodeBase64Json(this.editShortcuts)
      wikiStore.page.mode = 'view'
    },
    resetPageRouteState(): void {
      this.pageEditFab = false
      this.pageWatched = false
      this.pageWatchLoading = false
      this.pageWatchNotifications = []
      this.pageWatchNotificationsError = ''
      this.pageWatchUnreadCount = 0
      this.pageApproval = null
      this.approvalError = ''
      this.protectionDialog = false
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
          this.scrollToPageAnchor(decodeURIComponent(anchor.hash))
        }
      })
      this.contentExtensionCleanup?.()
      this.contentExtensionCleanup = hydrateContentExtensions(container)
      boot.notify('page-ready')
    },
    animatePageRoute(): void {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      const contentRef = this.$refs.content as HTMLElement | { $el?: unknown }
      const element = contentRef instanceof HTMLElement
        ? contentRef
        : contentRef.$el instanceof HTMLElement
          ? contentRef.$el
          : null
      if (!element) return
      element.classList.remove('page-main--route-enter')
      void element.offsetWidth
      element.classList.add('page-main--route-enter')
      element.addEventListener('animationend', () => {
        element.classList.remove('page-main--route-enter')
      }, { once: true })
    },
    tocLinkClicked (event: MouseEvent, anchor: string) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      this.scrollToPageAnchor(anchor)
    },
    scrollToPageAnchor(anchor: string, focusDestination = true) {
      const container = this.$refs.container as HTMLElement
      revealContentExtensionTarget(container, anchor)
      requestAnimationFrame(() => {
        this.goTo(anchor, this.scrollOpts)
        if (focusDestination) {
          const id = anchor.replace(/^#/, '')
          const destination = document.getElementById(id)
          destination?.setAttribute('tabindex', '-1')
          destination?.focus({ preventScroll: true })
        }
      })
    },
    async loadPageProtection () {
      this.protectionInitialLoading = true
      this.protectionError = ''
      try {
        const response = await fetch(`/_api/pages/${this.pageId}/protection`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
        if (!response.ok) throw new Error(`Page protection request failed (${response.status})`)
        this.pageProtection = await response.json() as PageProtection
      } catch (error) {
        this.protectionError = getErrorMessage(error)
        pushGraphError(wikiStore, error)
      } finally {
        this.protectionInitialLoading = false
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
      this.protectionLoading = true
      try {
        const response = await fetch(`/_api/pages/${this.pageId}/protection`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: this.pageProtectionPassword })
        })
        if (!response.ok) throw await this.approvalResponseError(response, 'Page protection update failed')
        this.pageProtection = await response.json() as PageProtection
        this.pageProtectionPassword = ''
        showNotification(wikiStore, {
          style: 'success',
          message: this.pageProtection.version > 1 ? 'Page password rotated and prior unlocks revoked.' : 'Page password protection enabled.'
        })
      } catch (error) {
        pushGraphError(wikiStore, error)
      } finally {
        this.protectionLoading = false
      }
    },
    async removePageProtection () {
      this.protectionLoading = true
      try {
        const response = await fetch(`/_api/pages/${this.pageId}/protection`, {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
        if (!response.ok) throw await this.approvalResponseError(response, 'Page protection removal failed')
        this.pageProtection = { protected: false, version: 0, updatedBy: null, updatedAt: null }
        this.pageProtectionPassword = ''
        showNotification(wikiStore, { style: 'success', message: 'Page password protection removed.' })
      } catch (error) {
        pushGraphError(wikiStore, error)
      } finally {
        this.protectionLoading = false
      }
    },
    approvalStatusLabel (status: string) {
      return status.replaceAll('-', ' ').replace(/\b\w/g, value => value.toUpperCase())
    },
    async approvalResponseError (response: Response, fallback: string): Promise<Error> {
      const payload = await response.json().catch(() => ({})) as { error?: unknown }
      return new Error(typeof payload.error === 'string' ? payload.error : `${fallback} (${response.status})`)
    },
    async loadPageApproval () {
      this.approvalInitialLoading = true
      this.approvalError = ''
      try {
        const response = await fetch(`/_api/pages/${this.pageId}/approval`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
        if (!response.ok) throw await this.approvalResponseError(response, 'Page approval request failed')
        const payload = await response.json() as { approval?: unknown }
        this.pageApproval = payload.approval && typeof payload.approval === 'object' ? payload.approval as PageApproval : null
        this.approvalAssigneeId = this.pageApproval?.assigneeId ?? null
      } catch (error) {
        this.approvalError = getErrorMessage(error)
        pushGraphError(wikiStore, error)
      } finally {
        this.approvalInitialLoading = false
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
        if (!response.ok) throw await this.approvalResponseError(response, 'Approval inbox request failed')
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
      this.approvalLoading = true
      try {
        const response = await fetch(`/_api/pages/${this.pageId}/approval`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(this.approvalAssigneeId && this.approvalAssigneeId > 0 ? { assigneeId: this.approvalAssigneeId } : {}),
            ...(this.approvalComment.trim() ? { comment: this.approvalComment.trim() } : {})
          })
        })
        if (!response.ok) throw await this.approvalResponseError(response, 'Approval submission failed')
        this.approvalComment = ''
        await Promise.all([this.loadPageApproval(), this.loadApprovalInbox()])
        showNotification(wikiStore, { style: 'success', message: 'Page submitted for approval.' })
      } catch (error) {
        pushGraphError(wikiStore, error)
      } finally {
        this.approvalLoading = false
      }
    },
    async transitionPageApproval (action: 'approve' | 'request-changes' | 'reject' | 'cancel' | 'resubmit' | 'publish' | 'reassign') {
      if (!this.pageApproval) return
      this.approvalLoading = true
      try {
        const response = await fetch(`/_api/pages/approvals/${encodeURIComponent(this.pageApproval.id)}/transition`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            ...(this.approvalComment.trim() ? { comment: this.approvalComment.trim() } : {}),
            ...(action === 'reassign' && this.approvalAssigneeId && this.approvalAssigneeId > 0 ? { assigneeId: this.approvalAssigneeId } : {})
          })
        })
        if (!response.ok) throw await this.approvalResponseError(response, 'Approval transition failed')
        this.approvalComment = ''
        await Promise.all([this.loadPageApproval(), this.loadApprovalInbox()])
        showNotification(wikiStore, { style: 'success', message: `Approval ${this.approvalStatusLabel(action)} completed.` })
      } catch (error) {
        pushGraphError(wikiStore, error)
      } finally {
        this.approvalLoading = false
      }
    },
    async loadPageWatchState () {
      this.pageWatchLoading = true
      try {
        const response = await fetch(`/_api/pages/${this.pageId}/watch`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
        if (!response.ok) throw new Error(`Page watch request failed (${response.status})`)
        const payload = await response.json() as { watched?: unknown; emailEnabled?: unknown; inAppEnabled?: unknown }
        this.pageWatched = payload.watched === true
        this.pageWatchEmailEnabled = payload.emailEnabled === true
        this.pageWatchInAppEnabled = payload.inAppEnabled === true
      } catch (error) {
        pushGraphError(wikiStore, error)
      } finally {
        this.pageWatchLoading = false
      }
    },
    async togglePageWatch () {
      this.pageWatchLoading = true
      try {
        const response = await fetch(`/_api/pages/${this.pageId}/watch`, {
          method: this.pageWatched ? 'DELETE' : 'PUT',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
        if (!response.ok) throw new Error(`Page watch request failed (${response.status})`)
        const payload = await response.json() as { watched?: unknown; emailEnabled?: unknown; inAppEnabled?: unknown }
        this.pageWatched = payload.watched === true
        if (this.pageWatched) {
          this.pageWatchEmailEnabled = payload.emailEnabled === true
          this.pageWatchInAppEnabled = payload.inAppEnabled === true
        }
        showNotification(wikiStore, {
          style: 'success',
          message: this.pageWatched ? 'You are now watching this page.' : 'You are no longer watching this page.'
        })
      } catch (error) {
        pushGraphError(wikiStore, error)
      } finally {
        this.pageWatchLoading = false
      }
    },
    async savePageWatchSettings () {
      if (!this.pageWatched || this.pageWatchLoading) return
      this.pageWatchLoading = true
      try {
        const response = await fetch(`/_api/pages/${this.pageId}/watch`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            emailEnabled: this.pageWatchEmailEnabled,
            inAppEnabled: this.pageWatchInAppEnabled
          })
        })
        if (!response.ok) throw new Error(`Page watch settings request failed (${response.status})`)
      } catch (error) {
        pushGraphError(wikiStore, error)
        await this.loadPageWatchState()
      } finally {
        this.pageWatchLoading = false
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
        if (!response.ok) throw new Error(`Page notifications request failed (${response.status})`)
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
      const action = ({
        'page.updated': 'updated',
        'page.restored': 'restored',
        'page.moved': 'moved',
        'page.deleted': 'deleted',
        'page.visibility-changed': 'changed visibility for',
        'page.ownership-transferred': 'transferred ownership of'
      } as Record<string, string>)[notification.eventType] ?? 'changed'
      return `${notification.actorName} ${action} this page`
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
      this.navShown = !this.navShown
    },
    upBtnScroll () {
      const scrollOffset = window.pageYOffset || document.documentElement.scrollTop
      this.upBtnShown = scrollOffset > window.innerHeight * 0.33
    },
    returnToTop () {
      this.goTo(0, this.scrollOpts)
      this.$nextTick(() => {
        const heading = document.querySelector<HTMLElement>('.page-title')
        heading?.setAttribute('tabindex', '-1')
        heading?.focus({ preventScroll: true })
      })
    },
    navigationVisibilityChanged (shown: boolean) {
      if (shown) {
        this.$nextTick(() => {
          document.querySelector<HTMLElement>('#page-navigation-drawer .nav-sidebar button, #page-navigation-drawer .nav-sidebar a')?.focus()
        })
      } else {
        this.$nextTick(() => {
          (this.$refs.navToggle as HTMLElement | undefined)?.focus?.()
        })
      }
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
      if (window.innerWidth >= 1280) {
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
.wiki-page {
  --page-toc-empty-height: calc(var(--wiki-grid-size) * 2);
  --page-toc-desktop-lift: calc(var(--page-toc-empty-height) / 2 + var(--wiki-space-12));

  font-family: var(--wiki-font-body);
}

.page-main {
  background:
    radial-gradient(
      circle at 88% 0%,
      color-mix(in srgb, var(--wiki-accent-spectral) 9%, transparent),
      transparent calc(var(--wiki-grid-size) * 7)
    ),
    linear-gradient(
      180deg,
      var(--wiki-surface-sunken),
      rgb(var(--v-theme-background)) calc(var(--wiki-grid-size) * 8)
    );
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
  box-shadow: var(--wiki-shadow-sm) !important;
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
  inset-block-end: calc(var(--wiki-footer-height) + env(safe-area-inset-bottom) + var(--wiki-space-4)) !important;
  inset-inline-start: var(--wiki-space-5) !important;
}

.page-nav-toggle--open {
  z-index: 1007;
}

.page-return-top {
  right: calc(env(safe-area-inset-right) + var(--wiki-space-5)) !important;
  bottom: calc(var(--v-layout-bottom, 0px) + var(--wiki-grid-size) + var(--wiki-space-6)) !important;
  left: auto !important;
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

  .v-breadcrumbs__item {
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
      color: var(--wiki-accent-warm);
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
  overflow: hidden;
  min-height: 0;
  padding: 0 !important;
  background:
    radial-gradient(
      circle at 82% 18%,
      color-mix(in srgb, var(--wiki-accent-spectral) 15%, transparent),
      transparent calc(var(--wiki-grid-size) * 5)
    ),
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--wiki-accent-warm) 7%, rgb(var(--v-theme-surface))),
      rgb(var(--v-theme-surface)) 64%
    );

  &::before {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(
        to right,
        color-mix(in srgb, rgb(var(--v-theme-on-surface)) 4%, transparent) 1px,
        transparent 1px
      ),
      linear-gradient(
        to bottom,
        color-mix(in srgb, rgb(var(--v-theme-on-surface)) 3%, transparent) 1px,
        transparent 1px
      );
    background-size: var(--wiki-grid-size) var(--wiki-grid-size);
    content: '';
    mask-image: linear-gradient(to right, transparent, rgb(var(--v-theme-on-surface)) 72%, transparent);
    pointer-events: none;
  }
}

.page-hero--with-toc,
.page-hero--with-toc .page-header-section {
  min-height: calc(var(--page-toc-empty-height) + var(--wiki-space-8));
}

.page-header-section {
  position: relative;
  width: min(100%, var(--wiki-shell-max));
  min-height: 0;
  margin-inline: auto;

  > .is-page-header {
    position: relative;
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

  .page-title-row {
    min-width: 0;
    flex-wrap: wrap;
    justify-content: flex-start;
    gap: var(--wiki-space-2) var(--wiki-space-3);
  }

  .page-title {
    min-width: 0;
    margin: 0;
    color: rgb(var(--v-theme-on-surface));
    font-family: var(--wiki-font-heading);
    font-size: clamp(1.9375rem, 1.5rem + 1.5vw, 3.125rem);
    font-weight: 760;
    letter-spacing: -.052em;
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
    font-size: clamp(.9375rem, .9rem + .14vw, 1rem);
    line-height: 1.45;
    overflow-wrap: anywhere;
    text-wrap: pretty;
  }

  .page-edit-shortcuts {
    position: static;
    z-index: 2;
    display: flex;
    justify-content: flex-end;
    gap: var(--wiki-space-2);

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
      display: flex;
      width: min(100%, var(--page-header-action-reserve));
      min-width: 0;
      max-width: var(--page-header-action-reserve);
      grid-column: 2;
      justify-self: end;
      overflow: hidden;

      .v-btn {
        min-width: 0;
        max-width: 100%;
        flex: 0 1 auto;
        overflow: hidden;
      }

      .v-btn__content {
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
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
    --page-header-toc-column: calc(3.3 * (100% + var(--v-col-gap-x)) / 12 - var(--v-col-gap-x));

    > .is-page-header {
      min-height: inherit;
      gap: var(--v-col-gap-x);
      align-content: center;
    }

    > .page-header--toc-left {
      grid-template-columns:
        var(--page-header-toc-column)
        minmax(0, 1fr);

      .page-header-headings {
        grid-column: 2;
      }
    }

    > .page-header--toc-left.has-edit-shortcuts {
      grid-template-columns:
        var(--page-header-toc-column)
        minmax(0, 1fr)
        minmax(0, var(--page-header-action-reserve));

      .page-edit-shortcuts {
        grid-column: 3;
      }
    }

    > .page-header--toc-right {
      grid-template-columns:
        minmax(0, 1fr)
        var(--page-header-toc-column);
    }

    > .page-header--toc-right.has-edit-shortcuts {
      grid-template-columns:
        minmax(0, 1fr)
        minmax(0, var(--page-header-action-reserve))
        var(--page-header-toc-column);
    }
  }
}

@media (min-width: 1920px) {
  .page-header-section {
    --page-header-toc-column: calc(2.2 * (100% + var(--v-col-gap-x)) / 12 - var(--v-col-gap-x));
  }
}


.page-body {
  position: relative;
  z-index: 1;
  width: min(100%, var(--wiki-shell-max));
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
  max-height: calc(100dvh - var(--v-layout-top, var(--wiki-grid-size)) - var(--wiki-space-8));
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

  > .v-card {
    overflow: hidden;
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-panel-radius);
    background: var(--wiki-surface-raised);
    box-shadow: var(--wiki-shadow-xs);
  }

  .text-label-small {
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, var(--wiki-accent-warm));
    font-weight: var(--wiki-label-weight) !important;
    letter-spacing: .09em !important;
    text-transform: uppercase;
  }

  .v-chip {
    border-radius: var(--wiki-radius-xs);
  }
}

.page-col-sd--with-toc {
  margin-block-start: calc(var(--page-toc-desktop-lift) * -1);
}

.page-col-sd--toc-off,
.page-col-content--toc-off {
  flex: 0 0 100%;
  max-width: 100%;
}

@media (min-width: 1280px) {
  .page-col-sd--with-toc {
    flex: 0 0 calc(3.3 * (100% + var(--v-col-gap-x)) / 12 - var(--v-col-gap-x));
    max-width: calc(3.3 * (100% + var(--v-col-gap-x)) / 12 - var(--v-col-gap-x));
  }

  .page-col-content--with-toc {
    flex: 0 0 calc(8.7 * (100% + var(--v-col-gap-x)) / 12 - var(--v-col-gap-x));
    max-width: calc(8.7 * (100% + var(--v-col-gap-x)) / 12 - var(--v-col-gap-x));
  }
}

@media (min-width: 1920px) {
  .page-col-sd--with-toc {
    flex-basis: calc(2.2 * (100% + var(--v-col-gap-x)) / 12 - var(--v-col-gap-x));
    max-width: calc(2.2 * (100% + var(--v-col-gap-x)) / 12 - var(--v-col-gap-x));
  }

  .page-col-content--with-toc {
    flex-basis: calc(9.8 * (100% + var(--v-col-gap-x)) / 12 - var(--v-col-gap-x));
    max-width: calc(9.8 * (100% + var(--v-col-gap-x)) / 12 - var(--v-col-gap-x));
  }
}



.page-toc-card {
  display: flex;
  min-height: var(--page-toc-empty-height);
  flex-direction: column;

  > .text-label-small {
    padding:
      var(--wiki-space-4)
      var(--wiki-space-4)
      var(--wiki-space-2) !important;
  }

  .v-list {
    padding:
      var(--wiki-space-1)
      var(--wiki-space-1)
      var(--wiki-space-3);
    background: transparent;
  }
}

.page-toc-empty {
  display: grid;
  min-height: var(--wiki-grid-size);
  flex: 1 1 auto;
  place-content: center;
  justify-items: center;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-4);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  text-align: center;
}

.page-toc-item {
  min-height: calc(var(--wiki-control-height) - var(--wiki-space-2)) !important;
  padding-inline:
    calc(var(--wiki-space-1) + var(--toc-indent))
    var(--wiki-space-2) !important;
  border-inline-start: .125rem solid transparent;
  border-radius: var(--wiki-radius-xs);
  transition:
    background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    color var(--wiki-motion-fast) var(--wiki-motion-ease);

  &:hover,
  &:focus-within {
    border-inline-start-color: color-mix(in srgb, var(--wiki-accent-warm) 58%, transparent);
    background: color-mix(in srgb, var(--wiki-accent-warm) 8%, transparent);
    color: var(--wiki-accent-warm);
  }

  .v-list-item__prepend {
    align-self: center;
  }

  .v-list-item__prepend > .v-icon {
    margin-inline-end: var(--wiki-space-1);
    color: var(--wiki-accent-warm);
    opacity: .58;
  }

  .v-list-item__prepend > .v-list-item__spacer {
    width: var(--wiki-space-1);
  }
}

.page-toc-item-title {
  padding-inline: 0 !important;
  font-size: .8125rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
  white-space: normal;
}

.page-tags-card,
.page-comments-card,
.page-author-card {
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

.page-author-card-name {
  margin-top: var(--wiki-space-3);
  color: rgb(var(--v-theme-on-surface));
  font-weight: 650;
  overflow-wrap: anywhere;
}

.page-author-card-date {
  margin-top: var(--wiki-space-1);
  line-height: 1.45;
}

.page-shortcuts-card {
  --page-shortcut-target: calc(var(--wiki-control-height) - var(--wiki-space-1));

  border: 1px solid var(--wiki-surface-border) !important;
  overflow: visible !important;

  .v-toolbar {
    height: auto !important;
    min-height: var(--page-shortcut-target);
    background: transparent !important;
  }

  .v-toolbar__content {
    display: flex;
    height: auto !important;
    min-height: var(--page-shortcut-target);
    flex-wrap: wrap;
    gap: var(--wiki-space-1);
    justify-content: center;
    padding-inline: var(--wiki-space-1);
  }

  .v-spacer {
    display: none;
  }

  .v-btn {
    width: var(--page-shortcut-target);
    min-width: var(--page-shortcut-target);
    height: var(--page-shortcut-target);
    border-radius: var(--wiki-radius-xs) !important;

    &:hover {
      background: color-mix(in srgb, var(--wiki-accent-warm) 8%, transparent);
    }
  }
}

.page-col-content:not(.is-page-header) {
  min-width: 0;
  padding-inline: var(--wiki-space-4) 0;
}

.page-col-content.order-lg-1:not(.is-page-header) {
  padding-inline: 0 var(--wiki-space-4);
}

.page-col-content > .contents {
  position: relative;
  isolation: isolate;
  min-height: calc(var(--wiki-grid-size) * 3);
  padding: clamp(var(--wiki-space-6), 3vw, var(--wiki-space-12));
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-hero-radius);
  background: rgb(var(--v-theme-surface));
  box-shadow:
    var(--wiki-shadow-inset),
    var(--wiki-shadow-sm);
  container-name: reading-surface;
  container-type: inline-size;

  > div:not(.page-gutter-ornament) {
    position: relative;
    z-index: 1;
    width: min(100%, 76ch);
    margin-inline: auto;
  }
}

.page-gutter-ornament {
  position: absolute;
  inset-block-start: 50%;
  z-index: 0;
  display: none;
  width: clamp(
    calc(var(--wiki-grid-size) * 1.125),
    calc((100% - 76ch) / 2 - var(--wiki-space-4)),
    calc(var(--wiki-grid-size) * 3.75)
  );
  height: min(
    calc(100% - var(--wiki-space-8)),
    max(calc(var(--wiki-grid-size) * 7), 68%)
  );
  opacity: .58;
  transform: translateY(-50%);
  container-type: size;

  &--start {
    inset-inline-start: var(--wiki-space-1);
  }

  &--end {
    inset-inline-end: var(--wiki-space-1);
    transform: translateY(-50%) scaleX(-1);
  }
}

@container reading-surface (min-width: 70rem) {
  .page-gutter-ornament {
    display: block;
  }
}

.v-main .contents {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 88%, transparent);
  font-family: var(--wiki-font-body);
  font-size: clamp(.9875rem, .95rem + .14vw, 1.0625rem);
  line-height: 1.78;
  text-wrap: pretty;

  > div:not(.page-gutter-ornament) > :first-child {
    margin-block-start: 0;
  }

  > div:not(.page-gutter-ornament) > :last-child {
    margin-block-end: 0;
  }

  h1,
  h2,
  h3,
  h4,
  h5,
  h6 {
    position: relative;
    color: rgb(var(--v-theme-on-surface));
    font-family: var(--wiki-font-heading);
    font-weight: 720;
    letter-spacing: -.025em;
    line-height: var(--wiki-leading-heading);
    scroll-margin-block-start: calc(var(--v-layout-top, var(--wiki-grid-size)) + var(--wiki-space-8));
    text-wrap: balance;

    &::after {
      display: none;
    }

    .toc-anchor {
      position: absolute;
      inset-block-end: .08em;
      inset-inline-start: calc(100% + var(--wiki-space-2));
      display: inline-flex;
      color: var(--wiki-accent-spectral);
      font-size: .72em;
      opacity: 0;
      transition:
        color var(--wiki-motion-fast) var(--wiki-motion-ease),
        opacity var(--wiki-motion-fast) var(--wiki-motion-ease);
    }

    &:hover .toc-anchor,
    .toc-anchor:focus-visible {
      display: inline-flex;
      color: var(--wiki-accent-warm);
      opacity: .72;
    }
  }

  h1 {
    margin: 0 0 var(--wiki-space-6);
    color: var(--wiki-accent-warm);
    font-size: clamp(1.75rem, 1.5rem + 1vw, 2.375rem);
    letter-spacing: -.04em;
    strong {
      color: inherit;
    }
  }

  h2 {
    margin: var(--wiki-space-12) 0 var(--wiki-space-4);
    padding-block-end: var(--wiki-space-2);
    border-bottom: 1px solid var(--wiki-surface-border);
    font-size: clamp(1.4rem, 1.2rem + .7vw, 1.8125rem);
  }

  h3 {
    margin: var(--wiki-space-10) 0 var(--wiki-space-3);
    font-size: clamp(1.1875rem, 1.08rem + .35vw, 1.375rem);
  }

  h4,
  h5,
  h6 {
    margin: var(--wiki-space-8) 0 var(--wiki-space-2);
    font-size: 1.0625rem;
    letter-spacing: -.012em;
  }

  p {
    margin: 0 0 var(--wiki-space-5);
    padding: 0;
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 86%, transparent);
  }

  strong {
    color: rgb(var(--v-theme-on-surface));
    font-weight: 680;
  }

  a {
    color: color-mix(in srgb, var(--wiki-accent-warm) 82%, rgb(var(--v-theme-on-surface)));
    font-weight: 580;
    text-decoration-color: color-mix(in srgb, currentColor 38%, transparent);
    text-decoration-thickness: .08em;
    text-underline-offset: .18em;
    transition:
      color var(--wiki-motion-fast) var(--wiki-motion-ease),
      text-decoration-color var(--wiki-motion-fast) var(--wiki-motion-ease);

    &:hover,
    &:focus-visible {
      color: var(--wiki-accent-warm);
      text-decoration-color: currentColor;
    }

    &.is-internal-link.is-invalid-page {
      color: rgb(var(--v-theme-error));
      text-decoration-style: dashed;
    }

    &.is-external-link::after {
      color: currentColor;
      font-size: .9em;
      opacity: .54;
    }
  }

  ul:not(.tabset-tabs):not(.content-extension-gallery__list):not(.content-extension-index__list),
  ol:not(.content-extension-index__list) {
    width: 100%;
    margin: var(--wiki-space-3) 0 var(--wiki-space-5);
    padding-block-start: 0;
    padding-inline-start: var(--wiki-space-6);

    > li {
      margin: var(--wiki-space-1) 0;
      padding-inline-start: var(--wiki-space-1);

      &::marker {
        color: color-mix(in srgb, var(--wiki-accent-warm) 72%, var(--wiki-accent-spectral));
        font-weight: 650;
      }

      > ul,
      > ol {
        margin-block: var(--wiki-space-2);
      }
    }
  }

  .task-list-item {
    padding-inline-start: var(--wiki-space-1);

    &::before {
      display: none;
    }
  }

  blockquote {
    --page-callout-tone: var(--wiki-accent-warm);

    position: relative;
    margin: var(--wiki-space-6) 0;
    padding:
      var(--wiki-space-4)
      var(--wiki-space-5);
    border: 1px solid color-mix(in srgb, var(--page-callout-tone) 24%, var(--wiki-surface-border));
    border-inline-start: .25rem solid var(--page-callout-tone);
    border-radius: var(--wiki-panel-radius);
    background: color-mix(in srgb, var(--page-callout-tone) 7%, rgb(var(--v-theme-surface)));
    color: rgb(var(--v-theme-on-surface));
    box-shadow: var(--wiki-shadow-inset);

    &::before {
      display: none;
    }

    &.is-info {
      --page-callout-tone: rgb(var(--v-theme-info));
    }

    &.is-warning {
      --page-callout-tone: rgb(var(--v-theme-warning));
    }

    &.is-danger {
      --page-callout-tone: rgb(var(--v-theme-error));
    }

    &.is-success {
      --page-callout-tone: rgb(var(--v-theme-success));
    }

    > .admonition__title {
      padding: 0;
      color: color-mix(in srgb, var(--page-callout-tone) 78%, rgb(var(--v-theme-on-surface)));
      font-weight: 720;
    }

    > :last-child {
      margin-block-end: 0;
    }
  }

  .admonitionblock {
    --page-admonition-tone: rgb(var(--v-theme-info));

    margin: var(--wiki-space-6) 0;

    &.tip {
      --page-admonition-tone: rgb(var(--v-theme-success));
    }

    &.warning {
      --page-admonition-tone: rgb(var(--v-theme-warning));
    }

    &.caution {
      --page-admonition-tone: var(--wiki-accent-spectral);
    }

    &.important {
      --page-admonition-tone: rgb(var(--v-theme-error));
    }

    table {
      overflow: hidden;
      margin: 0;
      border: 1px solid color-mix(in srgb, var(--page-admonition-tone) 24%, var(--wiki-surface-border));
      border-radius: var(--wiki-panel-radius);
      background: color-mix(in srgb, var(--page-admonition-tone) 7%, rgb(var(--v-theme-surface)));
      box-shadow: var(--wiki-shadow-inset);
    }

    td.icon {
      width: var(--wiki-grid-size);
      border: 0;
      background: color-mix(in srgb, var(--page-admonition-tone) 14%, transparent);
      color: var(--page-admonition-tone);
    }

    td.content {
      border: 0;
      background: transparent;
      color: rgb(var(--v-theme-on-surface));
    }
  }

  .exampleblock {
    margin: var(--wiki-space-6) 0;

    > .title {
      margin-block-end: var(--wiki-space-2);
      color: color-mix(in srgb, var(--wiki-accent-spectral) 68%, rgb(var(--v-theme-on-surface)));
      font-size: .875rem !important;
      font-style: normal;
      font-weight: 650;
    }

    > .content {
      margin: 0;
      padding: var(--wiki-space-4);
      border: 1px solid var(--wiki-surface-border);
      border-radius: var(--wiki-panel-radius);
      background: var(--wiki-surface-raised);
      box-shadow: var(--wiki-shadow-inset);
    }
  }

  hr {
    height: 1px;
    margin: var(--wiki-space-10) 0;
    border: 0;
    background:
      linear-gradient(
        to right,
        transparent,
        var(--wiki-surface-border-strong) 18%,
        var(--wiki-surface-border-strong) 82%,
        transparent
      );
  }

  :not(pre) > code,
  kbd {
    padding: .16em .42em;
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-radius-xs);
    background: color-mix(in srgb, var(--wiki-accent-spectral) 6%, var(--wiki-surface-sunken));
    color: color-mix(in srgb, var(--wiki-accent-warm) 74%, rgb(var(--v-theme-on-surface)));
    font-family: var(--wiki-font-mono);
    font-size: .88em;
    box-shadow: none;
    overflow-wrap: anywhere;
  }

  kbd {
    border-bottom-color: var(--wiki-surface-border-strong);
    box-shadow: 0 .125rem 0 var(--wiki-surface-border);
    font-weight: 650;
  }

  pre,
  .prismjs {
    overflow-x: auto;
    margin: var(--wiki-space-6) 0;
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-panel-radius);
    background: var(--wiki-surface-sunken);
    box-shadow: var(--wiki-shadow-sm);
    scrollbar-gutter: stable;

    > code {
      border: 0;
      background: transparent;
      box-shadow: none;
      font-family: var(--wiki-font-mono);
      font-size: .875rem;
      line-height: 1.65;
    }
  }

  .codeblock-framed {
    overflow: hidden;
    margin: var(--wiki-space-6) 0;
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-panel-radius);
    background: var(--wiki-surface-sunken);
    box-shadow: var(--wiki-shadow-sm);

    > .codeblock-title {
      padding: var(--wiki-space-2) var(--wiki-space-4);
      border-bottom: 1px solid var(--wiki-surface-border);
      background: var(--wiki-surface-raised);
      color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 70%, transparent);
      font-size: var(--wiki-label-size);
      font-weight: var(--wiki-label-weight);
      letter-spacing: .06em;
      text-transform: uppercase;
    }

    > pre {
      margin: 0;
      border: 0;
      border-radius: 0;
      box-shadow: none;
    }
  }

  .table-container {
    overflow-x: auto;
    margin: var(--wiki-space-6) 0;
    border-radius: var(--wiki-panel-radius);
    scrollbar-gutter: stable;

    > table {
      margin: 0;
    }
  }

  table {
    width: 100%;
    margin: var(--wiki-space-6) 0;
    border: 1px solid var(--wiki-surface-border);
    border-collapse: separate;
    border-spacing: 0;
    border-radius: var(--wiki-panel-radius);
    background: rgb(var(--v-theme-surface));
    box-shadow: var(--wiki-shadow-xs);

    th {
      background: color-mix(in srgb, var(--wiki-accent-spectral) 7%, var(--wiki-surface-raised));
      color: rgb(var(--v-theme-on-surface));
      font-size: var(--wiki-label-size);
      font-weight: var(--wiki-label-weight);
      letter-spacing: .055em;
      text-transform: uppercase;
    }

    th,
    td {
      padding: var(--wiki-space-3) var(--wiki-space-4);
      border-inline-end: 1px solid var(--wiki-surface-border);
      border-block-end: 1px solid var(--wiki-surface-border);
      line-height: 1.5;
      text-align: start;
      vertical-align: top;
      overflow-wrap: anywhere;
    }

    th:last-child,
    td:last-child {
      border-inline-end: 0;
    }

    tr:last-child td {
      border-block-end: 0;
    }

    tbody tr:nth-child(even) {
      background: color-mix(in srgb, var(--wiki-surface-sunken) 52%, transparent);
    }
  }

  figure,
  .imageblock {
    margin: var(--wiki-space-8) auto;
  }

  img:not(.emoji) {
    max-width: 100%;
    height: auto;
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-panel-radius);
    background: var(--wiki-surface-sunken);
    box-shadow: var(--wiki-shadow-sm);
  }

  figcaption,
  .imageblock > .title {
    margin-top: var(--wiki-space-2);
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
    font-size: .8125rem;
    line-height: 1.5;
    text-align: center;
  }

  details {
    overflow: hidden;
    margin: var(--wiki-space-6) 0;
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-panel-radius);
    background: var(--wiki-surface-raised);
    box-shadow: var(--wiki-shadow-inset);

    > summary {
      padding: var(--wiki-space-3) var(--wiki-space-4);
      color: rgb(var(--v-theme-on-surface));
      font-weight: 650;
      cursor: pointer;

      &:hover {
        background: color-mix(in srgb, var(--wiki-accent-warm) 7%, transparent);
      }
    }

    > :not(summary) {
      margin-inline: var(--wiki-space-4);
    }
  }

  .footnotes {
    margin-block-start: var(--wiki-space-12);
    padding-block-start: var(--wiki-space-4);
    border-block-start: 1px solid var(--wiki-surface-border);
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
    font-size: .875rem;
  }

  .content-extension {
    position: relative;
    margin: var(--wiki-space-8) 0;
    padding: var(--wiki-space-4);
    border: 1px solid var(--wiki-surface-border);
    border-inline-start: .1875rem solid color-mix(in srgb, var(--wiki-ambient-accent) 64%, transparent);
    border-radius: var(--wiki-panel-radius);
    background: var(--wiki-surface-raised);
    box-shadow: var(--wiki-shadow-inset);
  }

  .content-extension--tabs {
    overflow: hidden;
    padding: 0;
  }

  .content-extension-tabs__list {
    display: flex;
    overflow-x: auto;
    flex-wrap: nowrap;
    border-bottom: 1px solid var(--wiki-surface-border);
    background: var(--wiki-surface-sunken);
  }

  .content-extension-tabs__tab {
    position: relative;
    min-height: var(--wiki-control-height);
    padding: var(--wiki-space-3) var(--wiki-space-4);
    border: 0;
    border-inline-end: 1px solid var(--wiki-surface-border);
    background: transparent;
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
    font: inherit;
    font-size: .875rem;
    font-weight: 650;
    white-space: nowrap;
    cursor: pointer;

    &[aria-selected='true'] {
      background: rgb(var(--v-theme-surface));
      color: var(--wiki-accent-warm);
      box-shadow: inset 0 .1875rem 0 var(--wiki-ambient-accent);
    }

    &:hover {
      background: color-mix(in srgb, var(--wiki-accent-warm) 7%, transparent);
      color: rgb(var(--v-theme-on-surface));
    }
  }

  .content-extension-tabs__panel {
    padding: var(--wiki-space-5);
  }

  .content-extension--spoiler {
    overflow: hidden;
    padding: 0;
  }

  .content-extension-spoiler__toggle {
    padding: var(--wiki-space-4);

    &:hover,
    &:focus-visible {
      background: color-mix(in srgb, var(--wiki-accent-warm) 7%, transparent);
    }
  }

  .content-extension-gallery__link,
  .content-extension-index__link {
    border-color: var(--wiki-surface-border);
    border-radius: var(--wiki-control-radius);
    background: rgb(var(--v-theme-surface));
    box-shadow: var(--wiki-shadow-xs);
  }

  .content-extension-index__link {
    border-inline-start-color: color-mix(in srgb, var(--wiki-ambient-accent) 58%, var(--wiki-surface-border));
  }

  .content-extension-remote__load {
    min-height: var(--wiki-control-height);
    padding-inline: var(--wiki-space-4);
    border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 42%, var(--wiki-surface-border));
    border-radius: var(--wiki-control-radius);
    background: color-mix(in srgb, var(--wiki-accent-warm) 10%, rgb(var(--v-theme-surface)));
    color: var(--wiki-accent-warm);
    font: inherit;
    font-weight: 650;
    cursor: pointer;

    &:hover {
      background: color-mix(in srgb, var(--wiki-accent-warm) 16%, rgb(var(--v-theme-surface)));
    }
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

.comments-main {
  padding: var(--wiki-space-6);
  background: rgb(var(--v-theme-surface)) !important;
}

@media (max-width: 1279px) {
  .page-hero--with-toc,
  .page-hero--with-toc .page-header-section {
    min-height: 0;
  }

  .page-col-sd {
    position: static;
    display: grid;
    max-height: none;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--wiki-space-4);
    align-items: start;
    overflow: visible;
    padding-block-end: var(--wiki-space-5);
    margin-block-start: 0;

    > .v-card {
      margin-bottom: 0 !important;
    }
  }

  .page-toc-card {
    max-height: calc(var(--wiki-grid-size) * 5);
    overflow-y: auto !important;
  }

  .page-col-content:not(.is-page-header),
  .page-col-content.order-lg-1:not(.is-page-header) {
    padding-inline: 0;
  }
}

@media (max-width: 959px) {
  .page-return-top {
    bottom: calc(var(--v-layout-bottom, 0px) + var(--wiki-space-4)) !important;
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

  .page-breadcrumb-bar .breadcrumbs-nav .v-breadcrumbs__list {
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
      font-size: clamp(1.6875rem, 1.35rem + 2.2vw, 2rem);
      line-height: 1.06;
    }

    .page-description {
      margin-top: var(--wiki-space-1);
      font-size: .875rem;
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

  .page-toc-card {
    max-height: calc(var(--wiki-grid-size) * 5);
  }

  .page-col-content > .contents {
    min-height: calc(var(--wiki-grid-size) * 2);
    padding:
      var(--wiki-space-6)
      var(--wiki-space-4)
      var(--wiki-space-8);
    border-radius: var(--wiki-panel-radius);
  }

  .v-main .contents {
    font-size: .975rem;
    line-height: 1.72;

    h1 {
      font-size: 1.7rem;
    }

    h2 {
      margin-block-start: var(--wiki-space-10);
      font-size: 1.4rem;
    }

    h3 {
      margin-block-start: var(--wiki-space-8);
      font-size: 1.1875rem;
    }

    h1,
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

    blockquote {
      padding: var(--wiki-space-4);
    }

    .admonitionblock td.icon {
      width: var(--wiki-grid-size);
    }

    .table-container {
      margin-inline: calc(var(--wiki-space-4) * -1);
      padding-inline: var(--wiki-space-4);
    }

    th,
    td {
      padding: var(--wiki-space-2) var(--wiki-space-3);
    }

    .content-extension {
      margin-block: var(--wiki-space-6);
      padding: var(--wiki-space-3);
    }

    .content-extension--tabs,
    .content-extension--spoiler {
      padding: 0;
    }

    .content-extension-tabs__panel {
      padding: var(--wiki-space-4);
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
    inset-inline-end: var(--wiki-space-4);
  }

  .page-nav-toggle {
    inset-block-end: calc(var(--wiki-footer-height) + env(safe-area-inset-bottom) + var(--wiki-space-3)) !important;
    inset-inline-start: var(--wiki-space-4) !important;
  }

  .page-return-top {
    right: calc(env(safe-area-inset-right) + var(--wiki-space-4)) !important;
    bottom: calc(var(--v-layout-bottom, 0px) + var(--wiki-space-3)) !important;
    left: auto !important;
  }
}

@media print {
  .page-navigation,
  .page-nav-toggle,
  .page-breadcrumb-bar,
  .page-edit-shortcuts,
  .page-edit-fab,
  .page-return-top,
  .page-col-sd,
  .comments-container,
  .page-gutter-ornament {
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

  .page-body,
  .page-col-content > .contents {
    width: 100%;
    padding: 0 !important;
  }

  .page-col-content {
    max-width: 100% !important;
    flex-basis: 100% !important;
  }

  .v-main .contents {
    color: CanvasText;
    font-size: 11pt;
    line-height: 1.55;

    > div:not(.page-gutter-ornament) {
      width: 100%;
      max-width: none;
    }

    h1,
    h2,
    h3,
    h4,
    h5,
    h6,
    p,
    strong,
    a {
      color: CanvasText;
    }

    h1,
    h2,
    h3 {
      break-after: avoid-page;
    }

    pre,
    blockquote,
    table,
    figure,
    img,
    .admonitionblock,
    .exampleblock,
    .content-extension {
      break-inside: avoid-page;
      box-shadow: none !important;
    }

    a {
      text-decoration-color: currentColor;
    }

    .toc-anchor,
    .content-extension-tabs__list,
    .content-extension-spoiler__toggle {
      display: none !important;
    }

    .content-extension,
    blockquote,
    .exampleblock > .content,
    details {
      border-color: currentColor;
      background: transparent;
    }

    pre,
    .prismjs,
    .codeblock-framed {
      border-color: currentColor;
      background: transparent;
      box-shadow: none;
    }

    img:not(.emoji) {
      border-color: color-mix(in srgb, CanvasText 32%, transparent);
      box-shadow: none;
    }
  }
}

@media (forced-colors: active) {
  .page-col-content > .contents,
  .page-col-sd > .v-card,
  .comments-container,
  .v-main .contents :where(blockquote, pre, table, details, .content-extension) {
    border-color: CanvasText;
    box-shadow: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .page-return-top,
  .page-edit-fab,
  .page-nav-toggle,
  .page-header-section .page-edit-shortcuts .v-btn,
  .page-toc-item,
  .v-main .contents * {
    transition-duration: .001ms !important;
  }

  .page-main--route-enter > * {
    animation: none !important;
  }

  .page-return-top:hover,
  .page-edit-fab:hover,
  .page-nav-toggle:hover,
  .page-header-section .page-edit-shortcuts .v-btn:hover {
    transform: none;
  }
}
</style>
