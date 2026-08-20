<template lang="pug">
  v-app(v-scroll='upBtnScroll', :class='$vuetify.locale.isRtl ? `is-rtl` : `is-ltr`')
    nav-header(v-if='!printView')
    v-navigation-drawer(
      v-if='navMode !== `NONE` && !printView'
      :class='$vuetify.theme.current.dark ? `bg-grey-darken-4-d4` : `bg-primary`'
      mobile-breakpoint='1280'
      :temporary='$vuetify.display.width < 1280'
      v-model='navShown'
      :location="$vuetify.locale.isRtl ? 'right' : undefined"
      )
      vue-scroll(:ops='scrollStyle')
        nav-sidebar(
          :color='$vuetify.theme.current.dark ? `grey-darken-4-d4` : `primary`'
          :items='sidebarDecoded'
          :nav-mode='navMode'
          :expand-parent-by-default='navExpandParent'
        )

    v-fab-transition(v-if='navMode !== `NONE`')
      v-btn.page-nav-toggle(
        icon
        color='primary'
        fixed
        location='bottom start'
        size="small"
        @click='navShown = !navShown'
        aria-label='Toggle navigation'
        v-if='$vuetify.display.width < 1280'
        v-show='!navShown'
        )
        v-icon mdi-menu

    v-main(ref='content')
      template(v-if='path !== `home`')
        v-toolbar(:color='$vuetify.theme.current.dark ? `grey-darken-4-d3` : `grey-lighten-3`', flat, density="compact", v-if='$vuetify.display.smAndUp')
          //- v-btn.pl-0(v-if='$vuetify.display.xsOnly', flat, @click='toggleNavigation')
          //-   v-icon(color='grey darken-2', left) menu
          //-   span Navigation
          v-breadcrumbs.breadcrumbs-nav.pl-0(
            :items='breadcrumbs'
            divider='/'
            )
            template(v-slot:item='props')
              v-icon(v-if='props.item.path === "/"', size="small", @click='goHome') mdi-home
              v-btn.ma-0(v-else, :href='props.item.path', size="small", variant="text") {{props.item.name}}
          template(v-if='!isPublished')
            v-spacer
            .text-body-small.text-red {{$t('common:page.unpublished')}}
            status-indicator.ml-3(negative, pulse)
        v-divider
      v-container.pa-0(fluid, :class='$vuetify.theme.current.dark ? `bg-grey-darken-4-l3` : `bg-grey-lighten-4`')
        v-row.page-header-section.align-content-center(no-gutters, style='height: 90px;')
          v-col.page-col-content.is-page-header(
            :offset-xl='tocPosition === `left` ? 2 : 0'
            :offset-lg='tocPosition === `left` ? 3 : 0'
            :xl='tocPosition === `right` ? 10 : false'
            :lg='tocPosition === `right` ? 9 : false'
            style='margin-top: auto; margin-bottom: auto;'
            :class='$vuetify.locale.isRtl ? `pr-4` : `pl-4`'
            )
            .page-header-headings
              .d-flex.align-center
                .text-headline-medium(:class='$vuetify.theme.current.dark ? `text-grey-lighten-2` : `text-grey-darken-3`') {{title}}
                v-chip.ml-3(v-if="visibility === 'private'", size="small", color='deep-orange') Private
              .text-body-small.text-grey-darken-1 {{description}}
            .page-edit-shortcuts(
              v-if='editShortcutsObj.editMenuBar'
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
      v-container.pl-5.pt-4(fluid)
        v-row
          v-col.page-col-sd(
            v-if='tocPosition !== `off` && $vuetify.display.lgAndUp'
            :order-xs1='tocPosition !== `right`'
            :order-xs2='tocPosition === `right`'
            lg3
            xl2
            )
            v-card.page-toc-card.mb-5(v-if='tocDecoded.length')
              .text-label-small.pa-5.pb-0(:class='$vuetify.theme.current.dark ? `text-blue-lighten-2` : `text-primary`') {{$t('common:page.toc')}}
              v-list.pb-3(density="compact", nav, :class='$vuetify.theme.current.dark ? `bg-grey-darken-3-d3` : ``')
                template(v-for='tocItem in tocDecoded', :key='tocItem.anchor')
                  v-list-item(@click='goTo(tocItem.anchor, scrollOpts)')
                    template(v-slot:prepend)
                      v-icon(color='grey', size="small") {{ $vuetify.locale.isRtl ? `mdi-chevron-left` : `mdi-chevron-right` }}
                    v-list-item-title.px-3 {{tocItem.title}}
                  //- v-divider(v-if='tocIdx < toc.length - 1 || tocItem.children.length')
                  template(v-for='tocSubItem in tocItem.children', :key='tocSubItem.anchor')
                    v-list-item(@click='goTo(tocSubItem.anchor, scrollOpts)')
                      template(v-slot:prepend)
                        v-icon.px-3(color="grey-lighten-1", size="small") {{ $vuetify.locale.isRtl ? `mdi-chevron-left` : `mdi-chevron-right` }}
                      v-list-item-title.px-3.text-body-small(:class='$vuetify.theme.current.dark ? `text-grey-lighten-1` : `text-grey-darken-1`') {{tocSubItem.title}}
                    //- v-divider(inset, v-if='tocIdx < toc.length - 1')

            v-card.page-tags-card.mb-5(v-if='tags.length > 0')
              .pa-5
                .text-label-small.pb-2(:class='$vuetify.theme.current.dark ? `text-teal-lighten-3` : `text-teal`') {{$t('common:page.tags')}}
                v-chip.mr-1.mb-1(
                  label
                  :color='$vuetify.theme.current.dark ? `teal-darken-1` : `teal-lighten-5`'
                  v-for='tag in tags'
                  :href='`/t/` + tag.tag'
                  :key='`tag-` + tag.tag'
                  )
                  v-icon(:color='$vuetify.theme.current.dark ? `teal-lighten-3` : `teal`', start, size="small") mdi-tag
                  span(:class='$vuetify.theme.current.dark ? `text-teal-lighten-5` : `text-teal-darken-2`') {{tag.title}}
                v-chip.mr-1.mb-1(
                  label
                  :color='$vuetify.theme.current.dark ? `teal-darken-1` : `teal-lighten-5`'
                  :href='`/t/` + tags.map(t => t.tag).join(`/`)'
                  :aria-label='$t(`common:page.tagsMatching`)'
                  )
                  v-icon(:color='$vuetify.theme.current.dark ? `teal-lighten-3` : `teal`', size='20') mdi-tag-multiple

            v-card.page-comments-card.mb-5(v-if='commentsEnabled && commentsPerms.read')
              .pa-5
                .text-label-small.pb-2.d-flex.align-center(:class='$vuetify.theme.current.dark ? `text-blue-grey-lighten-3` : `text-blue-grey-darken-2`')
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
                    :color='$vuetify.theme.current.dark ? `blue-grey` : `blue-grey-darken-2`'
                    variant="outlined"
                    style='flex: 1 1 100%;'
                    size="small"
                    )
                    span(:class='$vuetify.theme.current.dark ? `text-blue-grey-lighten-1` : `text-blue-grey-darken-2`') {{$t('common:comments.viewDiscussion')}}
                  v-tooltip(location="right", v-if='commentsPerms.write')
                    template(v-slot:activator='{ props }')
                      v-btn.ml-2(
                        @click='goToComments(true)'
                        v-bind='props'
                        variant="outlined"
                        size="small"
                        :color='$vuetify.theme.current.dark ? `blue-grey` : `blue-grey-darken-2`'
                        :aria-label='$t(`common:comments.newComment`)'
                        )
                        v-icon(:color='$vuetify.theme.current.dark ? `blue-grey-lighten-1` : `blue-grey-darken-2`', size="small") mdi-comment-plus
                    span {{$t('common:comments.newComment')}}

            v-card.page-author-card.mb-5
              .pa-5
                .text-label-small.d-flex(:class='$vuetify.theme.current.dark ? `text-indigo-lighten-3` : `text-indigo`')
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
                        v-icon(color='indigo', size="small") mdi-history
                    span {{$t('common:header.history')}}
                .page-author-card-name.text-body-medium(:class='$vuetify.theme.current.dark ? `text-grey` : `text-grey-darken-3`') {{ authorName }}
                .page-author-card-date.text-body-small.text-grey-darken-1 {{ $helpers.formatMoment(updatedAt, 'calendar') }}

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
              v-toolbar(:color='$vuetify.theme.current.dark ? `grey-darken-4-d3` : `grey-lighten-3`', flat, density="compact")
                v-spacer
                //- v-tooltip(bottom)
                //-   template(v-slot:activator='{ props }')
                //-     v-btn(icon, tile, v-bind='props', :aria-label='$t(`common:page.bookmark`)'): v-icon(color='grey') mdi-bookmark
                //-   span {{$t('common:page.bookmark')}}
                v-menu(location="bottom", min-width='300')
                  template(v-slot:activator='{ props: menuProps }')
                    v-tooltip(location="bottom")
                      template(v-slot:activator='{ props: tooltipProps }')
                        v-btn(icon, tile, v-bind='{ ...menuProps, ...tooltipProps }', :aria-label='$t(`common:page.share`)'): v-icon(color='grey') mdi-share-variant
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
                          color='red'
                        )
                          v-btn(
                            icon
                            tile
                            v-bind='{ ...menuProps, ...tooltipProps }'
                            @click='loadPageWatchNotifications'
                            aria-label='Page notifications'
                          )
                            v-icon(color='grey') mdi-bell
                      span Page notifications
                  v-card
                    v-card-title.text-subtitle-1 Page notifications
                    v-divider
                    v-list(v-if='pageWatchNotifications.length > 0', lines='two', density='compact')
                      v-list-item(
                        v-for='notification in pageWatchNotifications'
                        :key='notification.id'
                        @click='openPageWatchNotification(notification)'
                        :class='{ "font-weight-bold": !notification.readAt }'
                      )
                        v-list-item-title {{ notification.title }}
                        v-list-item-subtitle {{ pageWatchNotificationSummary(notification) }}
                    v-card-text.text-medium-emphasis(v-else) No page notifications.
                v-tooltip(location="bottom", v-if='isAuthenticated')
                  template(v-slot:activator='{ props }')
                    v-btn(
                      icon
                      tile
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
                          tile
                          v-bind='{ ...menuProps, ...tooltipProps }'
                          aria-label='Watch settings'
                        )
                          v-icon(color='grey') mdi-tune
                      span Watch settings
                  v-card
                    v-card-title.text-subtitle-1 Watch settings
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
                            tile
                            v-bind='{ ...menuProps, ...tooltipProps }'
                            @click='loadApprovalInbox'
                            aria-label='Approval inbox'
                          )
                            v-icon(color='grey') mdi-inbox-arrow-down
                      span Approval inbox
                  v-card
                    v-card-title.text-subtitle-1 Approval inbox
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
                      tile
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
                      tile
                      v-bind='props'
                      @click='openPageProtection'
                      aria-label='Page password protection'
                    )
                      v-icon(:color='pageProtection.protected ? `primary` : `grey`') {{ pageProtection.protected ? 'mdi-lock' : 'mdi-lock-open-outline' }}
                  span Page password protection
                v-tooltip(location="bottom")
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
            v-tooltip(location='start', v-if='hasAnyPagePermissions && editShortcutsObj.editFab')
              template(v-slot:activator='{ props }')
                v-speed-dial(
                  v-model='pageEditFab'
                  direction='top'
                  open-on-hover
                  transition='scale-transition'
                  bottom
                  :right='!$vuetify.locale.isRtl'
                  :left='$vuetify.locale.isRtl'
                  fixed
                  )
                  template(v-slot:activator)
                    v-btn.btn-animate-edit(
                      icon
                      color='primary'
                      v-model='pageEditFab'
                      @click='pageEdit'
                      v-bind="props"
                      :disabled='!hasWritePagesPermission'
                      :aria-label='$t(`common:page.editPage`)'
                      )
                      v-icon mdi-pencil
                  v-tooltip(location='start', v-if='hasReadHistoryPermission')
                    template(v-slot:activator='{ props }')
                      v-btn(
                        icon
                        size="small"
                        color='white'
                        v-bind='props'
                        @click='pageHistory'
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
                        )
                        v-icon(size='20') mdi-content-save-move-outline
                    span {{$t('common:header.move')}}
                  v-tooltip(location='start', v-if='hasDeletePagesPermission')
                    template(v-slot:activator='{ props }')
                      v-btn(
                        icon
                        size="small"
                        color='red'
                        v-bind='props'
                        @click='pageDelete'
                        )
                        v-icon(size='20') mdi-trash-can-outline
                    span {{$t('common:header.delete')}}
              span {{$t('common:page.editPage')}}
            v-alert.mb-5(v-if='!isPublished', color='red', variant="outlined", icon='mdi-minus-circle', density="compact")
              .text-body-small {{$t('common:page.unpublishedWarning')}}
            site-banner(:banner='siteBanner')
            .contents(ref='container')
              slot(name='contents')
            .comments-container#discussion(v-if='commentsEnabled && commentsPerms.read && !printView')
              .comments-header
                v-icon.mr-2 mdi-comment-text-outline
                span {{$t('common:comments.title')}}
              .comments-main
                slot(name='comments')
    nav-footer
    notify
    search-results
    v-dialog(
      v-model='protectionDialog'
      :fullscreen='$vuetify.display.smAndDown'
      max-width='560'
    )
      v-card
        v-toolbar(color='primary', flat)
          v-toolbar-title Page password protection
          v-spacer
          v-btn(icon, @click='protectionDialog = false', aria-label='Close page password protection')
            v-icon mdi-close
        v-progress-linear(v-if='protectionLoading', indeterminate, color='primary')
        v-card-text.pa-5
          v-alert.mb-4(
            :type='pageProtection.protected ? `info` : `warning`'
            variant='tonal'
          )
            template(v-if='pageProtection.protected') Password protection is active. Setting a new password rotates it and immediately revokes every prior unlock.
            template(v-else) Readers can currently access this page without a page password.
          p.text-body-2.text-medium-emphasis.mb-4
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
    )
      v-card
        v-toolbar(color='primary', flat)
          v-toolbar-title Approval workflow
          v-spacer
          v-btn(icon, @click='approvalDialog = false', aria-label='Close approval workflow')
            v-icon mdi-close
        v-progress-linear(v-if='approvalLoading', indeterminate, color='primary')
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
              v-card-title.text-subtitle-1 Review history
              v-list(lines='two', density='compact')
                v-list-item(v-for='transition in pageApproval.transitions', :key='transition.id')
                  v-list-item-title {{ approvalStatusLabel(transition.toStatus) }}
                  v-list-item-subtitle Reviewer {{ transition.actorId }} · {{ new Date(transition.createdAt).toLocaleString() }}
                  v-list-item-subtitle(v-if='transition.comment') {{ transition.comment }}
          template(v-else)
            p.text-body-1.mb-4 Submit the current page revision for review. Later edits make the submission stale and cannot be published without resubmission.
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
            v-btn(
              v-if='pageApproval.status === `submitted` && pageApproval.canReview'
              color='success'
              :disabled='pageApproval.stale'
              @click='transitionPageApproval(`approve`)'
            ) Approve
            v-btn(
              v-if='pageApproval.status === `submitted` && pageApproval.canReview'
              color='warning'
              @click='transitionPageApproval(`request-changes`)'
            ) Request changes
            v-btn(
              v-if='pageApproval.status === `submitted` && pageApproval.canReview'
              color='error'
              @click='transitionPageApproval(`reject`)'
            ) Reject
            v-btn(
              v-if='pageApproval.status === `changes-requested` && pageApproval.canSubmitter'
              color='primary'
              @click='transitionPageApproval(`resubmit`)'
            ) Resubmit
            v-btn(
              v-if='pageApproval.status === `approved` && pageApproval.canReview'
              color='success'
              :disabled='pageApproval.stale'
              @click='transitionPageApproval(`publish`)'
            ) Publish approved revision
            v-btn(
              v-if='pageApproval.canReview && [`submitted`, `approved`, `changes-requested`].includes(pageApproval.status)'
              @click='transitionPageApproval(`reassign`)'
            ) Reassign
            v-btn(
              v-if='pageApproval.canSubmitter && [`submitted`, `approved`, `changes-requested`].includes(pageApproval.status)'
              color='error'
              variant='text'
              @click='transitionPageApproval(`cancel`)'
            ) Cancel request
          v-spacer
          v-btn(@click='approvalDialog = false') Close
    v-fab-transition
      v-btn.page-return-top(
        :class='{ "page-return-top--docked": isReturnTopDocked }'
        v-if='upBtnShown'
        icon
        fixed
        location='bottom start'
        size="small"
        :variant="isReturnTopDocked ? 'flat' : undefined"
        @click='goTo(0, scrollOpts)'
        :color='upBtnColor'
        :style='upBtnPosition'
        :aria-label='$t(`common:actions.returnToTop`)'
        )
        v-icon mdi-arrow-up</template>

<script lang='ts'>
import { defineComponent, type PropType } from 'vue'
import { useGoTo } from 'vuetify'
import AsyncState from '@/components/common/async-state.vue'
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
import { hydrateContentExtensions } from '../../../helpers/content-extension-runtime'
import { getErrorMessage, pushGraphError, showNotification } from '../../../helpers/root-ui-store'

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
      pageWatched: false,
      pageWatchLoading: false,
      pageWatchEmailEnabled: true,
      pageWatchInAppEnabled: true,
      pageWatchNotifications: [] as PageWatchNotification[],
      pageWatchUnreadCount: 0,
      approvalDialog: false,
      approvalLoading: false,
      pageApproval: null as PageApproval | null,
      approvalInboxLoading: false,
      approvalInboxError: '',
      approvalInbox: [] as PageApproval[],
      approvalComment: '',
      approvalAssigneeId: null as number | null,
      protectionDialog: false,
      protectionLoading: false,
      pageProtection: { protected: false, version: 0, updatedBy: null, updatedAt: null } as PageProtection,
      pageProtectionPassword: '',
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
      winWidth: 0,
      resizeHandler: null as (() => void) | null,
      contentExtensionCleanup: null as (() => void) | null
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
    isReturnTopDocked () {
      return this.$vuetify.display.width >= 1280 && this.navMode !== 'NONE' && this.navShown
    },
    upBtnColor () {
      return this.isReturnTopDocked ? 'primary-lighten-1' : 'primary'
    },
    upBtnPosition () {
      if (this.isReturnTopDocked) {
        return this.$vuetify.locale.isRtl ? 'right: 0; bottom: 0;' : 'left: 216px; bottom: 0;'
      }
      const offset = this.navMode !== 'NONE' ? 65 : 16
      return this.$vuetify.locale.isRtl ? `right: ${offset}px;` : `left: ${offset}px;`
    },
    sidebarDecoded (): SidebarItem[] {
      return decodeBase64Json<SidebarItem[]>(this.sidebar)
    },
    tocDecoded (): TableOfContentsItem[] {
      return decodeBase64Json<TableOfContentsItem[]>(this.toc)
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
    wikiStore.page.visibility = this.visibility
    wikiStore.page.tags = this.tags
    wikiStore.page.title = this.title
    wikiStore.page.editor = this.editor
    wikiStore.page.updatedAt = this.updatedAt
    wikiStore.page.sourceRevision = this.sourceRevision
    if (this.effectivePermissions) {
      wikiStore.page.effectivePermissions = decodeBase64Json(this.effectivePermissions)
    }
    if (this.editShortcuts) {
      wikiStore.page.editShortcuts = decodeBase64Json(this.editShortcuts)
    }

    wikiStore.page.mode = 'view'
  },
  mounted () {
    if (this.$vuetify.theme.current.dark) {
      this.scrollStyle.bar.background = '#424242'
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

    // -> Highlight Code Blocks
    Prism.highlightAllUnder(this.$refs.container as HTMLElement)

    // -> Render Mermaid diagrams
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: this.$vuetify.theme.current.dark ? `dark` : `default`
    })
    this.$nextTick(() => {
      const diagrams = (this.$refs.container as HTMLElement).querySelectorAll<HTMLElement>('.mermaid')
      void mermaid.run({ nodes: diagrams, suppressErrors: true })
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

    // -> Handle anchor links and activate safe content extensions within the page contents
    this.$nextTick(() => {
      const container = this.$refs.container as HTMLElement
      container.querySelectorAll<HTMLAnchorElement>(`a[href^="#"], a[href^="${window.location.href.replace(window.location.hash, '')}#"]`).forEach(el => {
        el.onclick = (ev: MouseEvent) => {
          ev.preventDefault()
          ev.stopPropagation()
          this.goTo(decodeURIComponent(el.hash), this.scrollOpts)
        }
      })
      this.contentExtensionCleanup?.()
      this.contentExtensionCleanup = hydrateContentExtensions(container)

      boot.notify('page-ready')
    })
  },
  beforeUnmount () {
    if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler)
    this.contentExtensionCleanup?.()
    this.contentExtensionCleanup = null
  },
  methods: {
    async loadPageProtection () {
      try {
        const response = await fetch(`/_api/pages/${this.pageId}/protection`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
        if (!response.ok) throw new Error(`Page protection request failed (${response.status})`)
        this.pageProtection = await response.json() as PageProtection
      } catch (error) {
        pushGraphError(wikiStore, error)
      }
    },
    openPageProtection () {
      this.pageProtectionPassword = ''
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
        pushGraphError(wikiStore, error)
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
      this.approvalDialog = true
      void this.loadPageApproval()
    },
    openApprovalInboxItem (approval: PageApproval) {
      const scope = approval.visibility === 'private' ? '/_private' : ''
      window.location.assign(`${scope}/${approval.localeCode}/${approval.path}`)
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
        pushGraphError(wikiStore, error)
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
      window.location.assign(`${scope}/${notification.localeCode}/${notification.path}`)
    },
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

.page-nav-toggle {
  position: fixed !important;
  bottom: 16px !important;
  z-index: 8;

  &[left='true'] {
    left: 16px !important;
  }

  &[right='true'] {
    right: 16px !important;
  }
}

.page-return-top {
  position: fixed !important;
  bottom: 16px;
  z-index: 8;
}

.page-return-top--docked {
  border-radius: 8px 0 0 0 !important;
}

@media (prefers-reduced-motion: reduce) {
  .page-return-top {
    transition-duration: .01ms !important;
  }
}

.breadcrumbs-nav {
  .v-btn {
    min-width: 0;
    &__content {
      text-transform: none;
    }
  }
  .v-breadcrumbs-divider:nth-child(2n) {
    padding: 0 6px;
  }
  .v-breadcrumbs-divider:nth-child(2) {
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

      @at-root .v-theme--dark & {
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
