<template lang="pug">
  v-app.wiki-page(v-scroll='upBtnScroll', @keydown.esc='readerSectionsEscape', :class='[$vuetify.locale.isRtl ? `is-rtl` : `is-ltr`, { "wiki-page--reading": readerFocus && !talkActive && !linksActive, "wiki-page--full-width": readerFullWidth, "wiki-page--inline-outline": isTocCompact }]')
    a.page-skip-link(:href='linksActive ? `#page-links` : talkActive ? `#discussion` : `#${pageArticleId}`', @click.prevent='linksActive ? focusLinks() : talkActive ? goToComments() : focusArticle()') {{$t('common:page.skipToContent')}}
    glossary-reader(v-if='!printView', :locale='locale', :page-key='`${pageId}:${navigationKey}:${sourceRevision}`', :content-root='readerContentRoot', :request-pin='requestGlossaryPin', :pin-state='glossaryPinState', @pin-selection='selectGlossaryPin', v-slot='{ glossary }')
      nav-header(reserve-actions, :before-search-exit='glossary.canLeave', :navigation-breakpoint='1280', :reading-mode='readerDockVisible', @reading-chrome-change='refreshReadingChromeGeometry')
        template(v-slot:navigationToggle)
          v-btn.page-navigation-control(
            v-if='navMode !== `NONE` && (!readerFocus || talkActive || linksActive)'
            ref='navToggle'
            icon
            variant='text'
            @click='toggleNavigation'
            :aria-expanded='navigationOpen'
            aria-controls='page-navigation-drawer'
            :aria-label='navigationOpen ? $t(`common:sidebar.closeNavigation`) : $t(`common:sidebar.openNavigation`)'
          )
            v-icon(aria-hidden='true') {{ navigationOpen ? 'mdi-close' : 'mdi-menu' }}
      search-results(:glossary='glossary')
    //- Navigation is indeterminate; the header spinner and aria-busy own status.
    .page-navigation-progress(v-if='!printView && showPageProgress && navigationPending', aria-hidden='true')
    //- Scalar position is separate from stored earned-reading coverage.
    .page-position(v-if='!printView && !talkActive && !linksActive && !readerDockVisible && !readerHasSections', role='progressbar', :aria-label='$t(`common:page.articlePosition`)', :aria-valuenow='readingProgress', aria-valuemin='0', aria-valuemax='100', :style='{ insetInlineStart: pagePositionInsetStart }')
      .page-position-fill(:style='{ transform: `scaleX(${readingProgress / 100})` }')
    .page-reading-chrome(v-show='readerFocus && !printView && !talkActive && !linksActive')
      .page-reading-dock(ref='readingDock', v-if='readerFocus && !printView && !talkActive && !linksActive', role='region', :aria-label='$t(`common:page.focusReading`)')
        .page-reading-progress(
          role='progressbar'
          :aria-label='$t(`common:page.articlePosition`)'
          :aria-valuenow='readingProgress'
          aria-valuemin='0'
          aria-valuemax='100'
        )
          .page-reading-progress-fill(:style='{ transform: `scaleX(${readingProgress / 100})` }')
        v-icon(icon='mdi-book-open-page-variant-outline', size='18', aria-hidden='true')
        .page-reading-dock-context
          span.page-reading-dock-title
            span.page-reading-completed(v-if='readerSectionReading && readerSectionReading.completed', :title='$t(`common:page.readingSectionCompleted`)')
              v-icon(icon='mdi-check', size='10', aria-hidden='true')
              span.d-sr-only {{ $t('common:page.readingSectionCompleted') }}
            span {{ readerSection ? readerSection.title : title }}
          .page-reading-dock-meta(v-if='readerSection || readingProgressAvailable')
            span.page-reading-dock-position(v-if='readerSection') {{ $t('common:page.sectionPosition', { current: readerSectionIndex + 1, total: tocFlattened.length }) }}
            span.page-reading-dock-document(v-if='readerSection') {{ title }}
          v-btn.page-reading-dock-top(
            v-if='upBtnShown'
            variant='text'
            size='small'
            prepend-icon='mdi-arrow-up'
            :aria-label='$t(`common:actions.returnToTop`)'
            @click='returnToTop'
          ) {{$t('common:page.top')}}
        .page-reading-dock-actions
          template(v-if='readerHasSections')
            v-btn.page-reading-previous(
              icon
              variant='text'
              size='small'
              :aria-label='$t(`common:page.previousSection`)'
              :disabled='readerSectionIndex <= 0'
              @click='moveReaderSection(-1)'
            )
              v-icon(aria-hidden='true') {{ $vuetify.locale.isRtl ? 'mdi-chevron-right' : 'mdi-chevron-left' }}
            v-btn.page-reading-next(
              icon
              variant='text'
              size='small'
              :aria-label='$t(`common:page.nextSection`)'
              :disabled='readerSectionIndex >= tocFlattened.length - 1'
              @click='moveReaderSection(1)'
            )
              v-icon(aria-hidden='true') {{ $vuetify.locale.isRtl ? 'mdi-chevron-left' : 'mdi-chevron-right' }}
            v-btn.page-reading-sections-toggle(
              variant='text'
              size='small'
              aria-haspopup='dialog'
              aria-controls='page-reading-sections-host'
              :aria-expanded='readerSectionsOpen'
              @click='toggleReaderSections'
            ) {{$t('common:page.chooseSection')}}
          v-btn.page-reading-exit(variant='text', size='small', prepend-icon='mdi-arrow-collapse-horizontal', @click='toggleReaderFocus') {{$t('common:page.exitFocus')}}
      #page-reading-sections-host.page-reading-sections(
        ref='readerSections'
        v-show='readerSectionsOpen'
        role='dialog'
        aria-modal='false'
        aria-labelledby='page-reading-sections-title'
      )
        .page-reading-sections-header
          h2#page-reading-sections-title {{$t('common:page.chooseSection')}} · {{tocFlattened.length}}
          v-btn(icon, variant='text', size='small', :aria-label='$t(`common:actions.close`)', @click='closeReaderSections(true)')
            v-icon(aria-hidden='true') mdi-close
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
      @keydown.esc='navigationEscape'
      )
      vue-scroll.page-nav-scroll(:ops='scrollStyle', style='scrollbar-gutter: auto;')
        nav-sidebar(
          color=''
          :items='sidebarDecoded'
          :nav-mode='navMode'
          :expand-parent-by-default='navExpandParent'
          @navigate='sidebarNavigationStarted'
        )


    v-main.page-main(
      ref='content'
      :aria-busy='navigationPending ? `true` : undefined'
      :class='{ "page-main--with-rail": readerHasSections && !isTocCompact && !printView && !readerDockVisible && !talkActive && !linksActive, "page-main--with-edit-fab": showEditFab }'
    )
      v-container.page-hero(
        fluid
        :class='{ "page-hero--accent-present": hasPageBrandingAccent }'
        :style='pageBrandingStyle'
      )
        v-row.page-header-section(:gap='0')
          v-col.page-col-content.is-page-header(
            cols='12'
            )
            .page-header-headings(
              :class='{ "page-header-headings--branded": pageBrandingVisible }'
            )
              .page-document-label
                span {{$t('common:page.documentKind')}}
                span.page-document-label__divider(aria-hidden='true') /
                bdi(dir='ltr') {{ locale.toUpperCase() }}
              .page-title-row.d-flex.align-center
                h1.page-title(ref='pageTitle', :id='pageTitleId')
                  span(ref='pageTitleText') {{title}}
                v-chip.page-visibility.ml-3(v-if="visibility === 'private'", size="small", color='warning', variant='tonal') {{$t('common:page.private')}}
              page-branding-mark(
                v-if='pageBranding && !pageBrandingDuplicatesSiteLogo'
                :branding='pageBranding'
                :failed='brandingFailureIdentity === pageBrandingIdentity'
                @error='pageBrandingImageError'
              )
            .page-header-summary(v-if='description')
              p.page-description {{description}}
            .page-document-provenance(v-if='updatedAt || hasAuthor')
              time(v-if='updatedAt', :datetime='updatedAt', :title='accessibleUpdatedAt')
                button.page-updated-history(
                  v-if='hasReadHistoryPermission && !printView'
                  type='button'
                  :disabled='!pageOnlineActionReady'
                  :title='$t(`common:header.history`)'
                  @click='pageHistory'
                ) {{ updatedAtLabel }}
                template(v-else) {{ updatedAtLabel }}
              span(v-if='updatedAt && hasAuthor', aria-hidden='true') ·
              span.page-document-author(v-if='hasAuthor')
                | {{ authorAttribution.before }}
                bdi.page-provenance-author(:title='authorName') {{ authorName }}
                | {{ authorAttribution.after }}
              .page-accuracy(v-if='!printView')
                v-menu(
                  :key='accuracyContextKey'
                  location='bottom end'
                  :offset='8'
                  :close-on-content-click='false'
                  :content-props='accuracyMenuContentProps'
                )
                  template(v-slot:activator='{ props }')
                    button.page-accuracy-pill(
                      v-bind='props'
                      :id='`page-accuracy-review-${pageId}`'
                      type='button'
                      aria-haspopup='dialog'
                      :class='`page-accuracy-pill--${accuracyStatus}`'
                    )
                      span(aria-hidden='true') ●
                      |  {{ accuracyLabel }}
                  .page-accuracy-details
                    p {{ $t('common:page.accuracyHumanAttestation') }}
                    p(v-if='accuracyStamp')
                      bdi {{ accuracyStamp.verifiedByName || $t('common:page.accuracyActorUnavailable') }}
                      |  · 
                      time(:datetime='accuracyStamp.verifiedAt') {{ approvalTransitionDate(accuracyStamp.verifiedAt) }}
                      |  · {{ $t('common:page.accuracyAgeDays', { count: accuracyAgeDays }) }}
                    p(v-else) {{ $t('common:page.accuracyUnknown') }}
                    p(v-if='accuracyUnavailableReason') {{ accuracyUnavailableReason }}
                    p(v-if='accuracyError', role='status') {{ accuracyError }}
                    v-btn.page-accuracy-verify(
                      v-if='isAuthenticated'
                      variant='tonal'
                      size='small'
                      prepend-icon='mdi-check-decagram-outline'
                      :disabled='!accuracyActionReady || accuracyPending'
                      :aria-busy='accuracyPending'
                      @click='verifyAccuracy'
                    ) {{ $t(accuracyPending ? 'common:page.accuracyVerifying' : 'common:page.verifyAccuracy') }}
                    a(v-if='accuracyReviewRequired', :href='pageUrl') {{ $t('common:page.accuracyReloadReview') }}
                    v-btn(v-else-if='!accuracyPending', variant='text', size='small', prepend-icon='mdi-refresh', @click='loadAccuracy') {{ $t('common:page.accuracyRefresh') }}
            .page-hero-actions(v-if='!printView')
              v-btn.page-focus-control(
                v-if='!talkActive && !linksActive'
                variant='tonal'
                size='small'
                prepend-icon='mdi-book-open-page-variant-outline'
                :aria-label='$t(readerFocus ? `common:page.exitFocusEscape` : `common:page.focusReading`)'
                :aria-pressed='readerFocus'
                @click='toggleReaderFocus'
              ) {{$t(readerFocus ? 'common:page.exitFocusEscape' : 'common:page.focusReading')}}
              v-menu(v-model='shareMenuOpen', location='bottom end', min-width='280', max-width='360', :close-on-content-click='false', :content-props='shareMenuContentProps')
                template(v-slot:activator='{ props }')
                  v-btn(v-bind='props', data-reader-share-trigger, variant='tonal', size='small', prepend-icon='mdi-share-variant', aria-haspopup='dialog', :aria-label='$t(`common:page.share`)', @keydown.capture='handleShareMenuKeydown') {{$t('common:page.share')}}
                social-sharing(:url='pageUrl', :title='title', :description='description', :section-anchor='shareSectionAnchor', :public-context-eligible='publicSharingContextEligible', @keydown.capture='handleShareMenuKeydown')
              v-tooltip(:disabled='readerFocus', :close-delay='0', :transition='false', location='bottom', max-width='320')
                template(v-slot:activator='{ props }')
                  v-btn.page-offline-control(
                    v-bind='props'
                    variant='tonal'
                    size='small'
                    :icon='offlineControl.icon'
                    :class='[`page-offline-control--${offlineControl.tone}`, { "page-offline-control--blocked": offlineControl.blocked }]'
                    :loading='offlineActionLoading'
                    :aria-disabled='offlineControl.blocked ? `true` : undefined'
                    :aria-label='offlineControl.label'
                    :aria-pressed='offlineControl.pressed'
                    :aria-describedby='[props["aria-describedby"], offlineStatusId].filter(Boolean).join(" ")'
                    :data-offline-state='offlineControl.state'
                    @click='toggleOfflinePage'
                  )
                .page-offline-tooltip
                  strong.page-offline-tooltip__title {{ offlineControl.title }}
                  span.page-offline-tooltip__detail(v-if='offlineControl.detail') {{ offlineControl.detail }}
              span.page-offline-status(:id='offlineStatusId', role='status') {{ offlineStatusLabel }}
              .page-edit-shortcuts(v-if='showHeaderEditButton || (editShortcutsObj.editMenuBar && editShortcutsObj.editMenuExternalBtn && editMenuExternalUrl)')
                v-btn(v-if='showHeaderEditButton', @click='pageEdit', variant='tonal', size='small', prepend-icon='mdi-pencil', :aria-label='$t(`common:actions.edit`)')
                  span.text-none {{$t('common:actions.edit')}}
                v-btn(v-if='editShortcutsObj.editMenuBar && editShortcutsObj.editMenuExternalBtn && editMenuExternalUrl', :href='editMenuExternalUrl', target='_blank', rel='noopener', variant='text', size='small', :prepend-icon='editShortcutsObj.editMenuExternalIcon', :aria-label='$t(`common:page.editExternal`, { name: editShortcutsObj.editMenuExternalName })')
                  span.text-none {{$t('common:page.editExternal', { name: editShortcutsObj.editMenuExternalName })}}
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
                    v-if='props.item.href === breadcrumbs[0].href'
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
                  )
                    span.breadcrumbs-nav__label {{props.item.title}}
            //- One static unpublished surface: chip plus one sentence.
            .page-header-unpublished(v-if='!isPublished', role='note')
              v-chip.page-unpublished-chip(size='small', color='warning', variant='tonal', prepend-icon='mdi-eye-off-outline') {{$t('common:page.unpublished')}}
              span.page-header-unpublished-text.text-body-small {{$t('common:page.unpublishedWarning')}}
      v-container.page-body(fluid)
        v-row
          v-col.page-col-sd(
            v-show='readerHasSections && !isTocCompact && !printView'
            cols='12'
            :class='tocPosition === `right` ? `page-col-sd--toc-right` : `page-col-sd--toc-left`'
          )
            //- Keep the Teleport target mounted through responsive and print transitions.
            #page-desktop-rail.page-desktop-rail

          v-col.page-col-content(
            cols='12'
            :class='[tocPosition === `right` ? `page-col-content--toc-right` : `page-col-content--toc-left`, { "page-col-content--with-toc": readerHasSections && !isTocCompact, "page-col-content--toc-off": !readerHasSections || isTocCompact }]'
            )
            #page-inline-toc.page-inline-toc
            v-menu(
              v-if='showEditFab'
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
                  v-icon mdi-dots-horizontal
              v-list(density='compact', nav)
                v-list-subheader {{$t('common:header.pageActions')}}
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
            site-banner.page-page-context(v-if='selectedPageView === `article` || printView', :banner='siteBanner')
            v-tabs.page-view-tabs(
              v-if='showPageViewTabs'
              :model-value='selectedPageView'
              color='primary'
              density='compact'
              :aria-label='$t(`common:page.pageView`)'
              @update:model-value='selectPageView'
            )
              v-tab#page-view-article-tab(value='article' prepend-icon='mdi-file-document-outline') {{$t('common:page.viewArticle')}}
              v-tab#page-view-talk-tab(v-if='commentsEnabled && commentsPerms.read && !commentsExternal' value='talk' prepend-icon='mdi-forum-outline') {{$t('common:comments.title')}}
              v-tab#page-view-links-tab(v-if='linksVisible' value='links' prepend-icon='mdi-link-variant') {{$t('common:page.viewLinks')}}
            article.contents(ref='container', v-show='printView || selectedPageView === `article`', :id='pageArticleId', role='tabpanel', :aria-labelledby='showPageViewTabs ? `page-view-article-tab` : pageTitleId', tabindex='-1', :lang='locale', :dir='contentDirection')
              template(v-if='$slots.contents')
                slot(name='contents')
              async-state(
                v-else
                state='empty'
                :title='$t(`common:page.noContent`)'
              )
            page-governance(
              v-show='!printView && selectedPageView === `article`'
              :page-id='pageId'
              :source-revision='sourceRevision'
              :locale='locale'
              :path='path'
              :ready='readerPageActionsState.ready && pageTransportVerified'
              :writer='hasWritePagesPermission'
              :manage='hasManagePagesPermission || hasAdminPermission'
              :attestation-href='`#page-accuracy-review-${pageId}`'
            )
            .page-annotations-panel(v-if='!printView', v-show='selectedPageView === `article`')
              discussion-annotations(:page-id='pageId', :content-root='readerContentRoot', :enabled='commentsEnabled && commentsPerms.read && !commentsExternal', @compose='composePassage', @thread='$emit(`focus-thread`, $event)')
            section.page-links-panel.contents#page-links(v-if='linksActive', role='tabpanel', aria-labelledby='page-view-links-tab', tabindex='-1')
              slot(name='links', :page-id='pageId', :locale='locale', :source-revision='sourceRevision')
            section.comments-container#discussion(v-if='!printView && ((commentsExternal && !linksActive) || (!commentsExternal && discussionMounted && commentsEnabled && commentsPerms.read))', v-show='commentsExternal || selectedPageView === `talk`', role='tabpanel', :aria-labelledby='commentsExternal ? `discussion-title` : `page-view-talk-tab`')
              .comments-header
                .comments-header-icon
                  v-icon(size='20', aria-hidden='true') mdi-forum-outline
                div
                  h2#discussion-title.comments-title {{$t('common:comments.title')}}
                  .comments-subtitle {{$t('common:page.discussionSubtitle')}}
              .comments-main
                slot(name='comments')
          //- One outline moves without remounting its filter, branches or links.
          Teleport(
            defer
            :to='readerSectionsOpen ? `#page-reading-sections-host` : isTocCompact ? `#page-inline-toc` : `#page-desktop-rail`'
            :disabled='printView || !readerHasSections'
          )
              v-card.page-toc-card(v-show='readerHasSections && !talkActive && !linksActive', tag='nav', :aria-label='$t(`common:page.onThisPage`)')
                .page-reading-progress(
                  v-if='!readerDockVisible && readerHasSections'
                  role='progressbar'
                  :aria-label='$t(`common:page.articlePosition`)'
                  :aria-valuenow='readingProgress'
                  aria-valuemin='0'
                  aria-valuemax='100'
                )
                  .page-reading-progress-fill(:style='{ transform: `scaleX(${readingProgress / 100})` }')
                //- In the picker the outline is always disclosed.
                .page-toc-summary(v-if='isTocCompact && !readerSectionsOpen')
                  v-btn.page-toc-toggle.text-none(
                    variant='text'
                    :aria-expanded='tocDisclosureExpanded'
                    aria-controls='page-toc-content'
                    @click='toggleToc'
                  )
                    span.page-toc-heading-label.text-label-small {{$t('common:page.onThisPage')}}
                    span.page-toc-toggle-meta
                      span.page-toc-count(aria-hidden='true') {{ tocFlattened.length }}
                      span.d-sr-only {{ $t('common:page.sectionsCount', { count: tocFlattened.length }) }}
                      v-icon(size='small', aria-hidden='true') {{ tocDisclosureExpanded ? `mdi-chevron-up` : `mdi-chevron-down` }}
                  v-btn.page-reading-top(
                    v-if='upBtnShown'
                    variant='text'
                    size='small'
                    :aria-label='$t(`common:actions.returnToTop`)'
                    @click='returnToTop'
                  )
                    v-icon(aria-hidden='true') mdi-arrow-up
                .page-toc-heading(v-else-if='!readerSectionsOpen')
                  span.page-toc-heading-label.text-label-small {{$t('common:page.onThisPage')}}
                  span.page-toc-count(aria-hidden='true') {{ tocFlattened.length }}
                  span.d-sr-only {{ $t('common:page.sectionsCount', { count: tocFlattened.length }) }}

                div#page-toc-content.page-toc-content(
                  v-show='readerSectionsOpen || tocDisclosureExpanded'
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
                      :reading-sections='readingSectionsByAnchor'
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

          .page-metadata(v-if='!printView')
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
                v-tooltip(location='bottom')
                  template(v-slot:activator='{ props }')
                    v-chip.page-tags-all.wiki-tag-color.mr-1.mb-1(
                      v-bind='props'
                      label
                      variant='tonal'
                      data-tag-color='neutral'
                      :href='`/t/` + tags.map(t => t.tag).join(`/`)'
                      :aria-label='$t(`common:page.tagsMatching`)'
                      )
                      v-icon(size='20', aria-hidden='true') mdi-tag-multiple
                  span {{$t('common:page.tagsMatching')}}
            template(v-if='ratingsVisible && !printView')
              slot(name='ratings', :page-id='pageId')
            v-card.page-comments-card.mb-5(v-if='commentsEnabled && commentsPerms.read')
              .pa-5
                .text-label-small.pb-2.d-flex.align-center.text-secondary
                  span {{$t('common:comments.title')}}
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
    v-dialog(
      v-model='pageWatchSettingsOpen'
      max-width='380'
      aria-labelledby='page-watch-settings-title'
      @after-leave='restoreReaderActionFocus'
    )
      v-card.page-watch-settings
        v-toolbar(color='surface', class='border-b', flat)
          v-toolbar-title.text-title-medium#page-watch-settings-title(tag='h2') {{$t('common:page.watchSettings')}}
          v-spacer
          v-btn(icon, @click='pageWatchSettingsOpen = false', :aria-label='$t(`common:actions.close`)')
            v-icon(aria-hidden='true') mdi-close
        v-card-text
          v-switch(
            :model-value='pageWatchEmailEnabled'
            :label='$t(`common:page.emailNotifications`)'
            color='primary'
            density='compact'
            hide-details
            :disabled='pageWatchLoading || !pageWatchActionReady'
            :aria-describedby='pageWatchBlockedReason ? `page-watch-settings-reason` : undefined'
            @update:model-value='setPageWatchDelivery(`pageWatchEmailEnabled`, $event)'
          )
          v-switch(
            :model-value='pageWatchInAppEnabled'
            :label='$t(`common:page.inAppNotifications`)'
            color='primary'
            density='compact'
            hide-details
            :disabled='pageWatchLoading || !pageWatchActionReady'
            :aria-describedby='pageWatchBlockedReason ? `page-watch-settings-reason` : undefined'
            @update:model-value='setPageWatchDelivery(`pageWatchInAppEnabled`, $event)'
          )
          p.page-tool-helper#page-watch-settings-reason(v-if='pageWatchBlockedReason', role='status') {{ pageWatchBlockedReason }}
        v-card-actions
          v-btn.page-watch-stop(
            variant='text'
            prepend-icon='mdi-bell-off-outline'
            :loading='pageWatchLoading'
            :aria-disabled='pageWatchBlockedReason ? `true` : undefined'
            :aria-describedby='pageWatchBlockedReason ? `page-watch-settings-reason` : undefined'
            @click='togglePageWatch'
          ) {{$t('common:page.stopWatchingPage')}}
    v-dialog(
      v-model='protectionDialog'
      :fullscreen='$vuetify.display.smAndDown'
      max-width='560'
      aria-labelledby='page-protection-title'
      @after-leave='restoreReaderActionFocus'
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
            v-alert.mt-4(
              v-if='!pageProtectionActionReady'
              type='warning'
              variant='tonal'
              role='status'
            )
              span {{ pageOnlineActionUnavailableReason || $t('common:page.protectionStateStale') }}
              v-btn.ml-2(
                v-if='pageOnlineActionReady'
                size='small'
                variant='text'
                :loading='protectionInitialLoading'
                @click='loadPageProtection'
              ) {{$t('common:page.tryAgain')}}
          v-divider
          v-card-actions.flex-wrap.pa-4
            v-btn(
              color='primary'
              :disabled='!pageProtectionActionReady || pageProtectionPassword.length < 12'
              :loading='protectionLoading'
              @click='savePageProtection'
            ) {{ pageProtection.protected ? $t('common:page.rotatePassword') : $t('common:page.enableProtection') }}
            v-btn(
              v-if='pageProtection.protected'
              color='error'
              variant='text'
              :disabled='protectionLoading || !pageProtectionActionReady'
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
      @after-leave='restoreReaderActionFocus'
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
              v-autocomplete.page-approval-reviewer(
                v-if='pageApproval.canReview'
                v-model='approvalAssigneeId'
                v-model:search='approvalReviewerQuery'
                :items='approvalReviewerItems'
                item-title='label'
                item-value='id'
                :label='$t(`common:page.reviewerField`)'
                :hint='approvalReviewerHint($t(`common:page.keepCurrentReviewerHint`))'
                :loading='approvalReviewerLoading'
                :no-data-text='approvalReviewerNoDataText'
                no-filter
                clearable
                persistent-hint
                autocomplete='off'
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
                    v-list-item-subtitle
                      bdi {{ approvalActorLabel(transition.actorId, transition.actorName) }}
                      |  · 
                      time(:datetime='approvalTransitionIso(transition.createdAt)') {{ approvalTransitionDate(transition.createdAt) }}
                    v-list-item-subtitle(v-if='transition.comment') {{ transition.comment }}
            template(v-else)
              p.text-body-large.mb-4 {{$t('common:page.submitForReviewDescription')}}
              v-autocomplete.page-approval-reviewer(
                v-model='approvalAssigneeId'
                v-model:search='approvalReviewerQuery'
                :items='approvalReviewerItems'
                item-title='label'
                item-value='id'
                :label='$t(`common:page.reviewerOptional`)'
                :hint='approvalReviewerHint()'
                :loading='approvalReviewerLoading'
                :no-data-text='approvalReviewerNoDataText'
                no-filter
                clearable
                persistent-hint
                autocomplete='off'
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
              @click='submitPageApproval'
            ) {{ pageApproval ? $t('common:page.submitNewRevision') : $t('common:page.submitForApproval') }}
            template(v-if='pageApproval')
              v-btn(v-if='pageApproval.status === `submitted` && pageApproval.canReview', color='success', :disabled='approvalLoading || !approvalActionReady || pageApproval.stale', @click='transitionPageApproval(`approve`)') {{$t('common:page.approve')}}
              v-btn(v-if='pageApproval.status === `submitted` && pageApproval.canReview', color='warning', :disabled='approvalLoading || !approvalActionReady', @click='transitionPageApproval(`request-changes`)') {{$t('common:page.requestChanges')}}
              v-btn(v-if='pageApproval.status === `submitted` && pageApproval.canReview', color='error', :disabled='approvalLoading || !approvalActionReady', @click='transitionPageApproval(`reject`)') {{$t('common:page.reject')}}
              v-btn(v-if='pageApproval.status === `changes-requested` && pageApproval.canSubmitter && hasWritePagesPermission', color='primary', :disabled='approvalLoading || !approvalActionReady', @click='transitionPageApproval(`resubmit`)') {{$t('common:page.resubmit')}}
              v-btn(v-if='pageApproval.status === `approved` && pageApproval.canReview', color='success', :disabled='approvalLoading || !approvalActionReady || pageApproval.stale', @click='transitionPageApproval(`publish`)') {{$t('common:page.publishApprovedRevision')}}
              v-btn(v-if='pageApproval.canReview && [`submitted`, `approved`, `changes-requested`].includes(pageApproval.status)', :disabled='approvalLoading || !approvalActionReady', @click='transitionPageApproval(`reassign`)') {{$t('common:page.reassign')}}
              v-btn(v-if='pageApproval.canSubmitter && [`submitted`, `approved`, `changes-requested`].includes(pageApproval.status)', color='error', variant='text', :disabled='approvalLoading || !approvalActionReady', @click='transitionPageApproval(`cancel`)') {{$t('common:page.cancelRequest')}}
            v-spacer
            v-btn(@click='approvalDialog = false') {{$t('common:actions.close')}}
    v-dialog(v-model='offlineUnlockOpen', max-width='480', :persistent='offlineUnlockBusy', aria-labelledby='page-private-offline-unlock-title')
      v-card
        v-card-title(id='page-private-offline-unlock-title') {{ $t(`common:page.unlockPrivateOfflinePages`) }}
        v-card-text
          p {{ $t(`common:page.enterSecretSavedWhen`) }}
          v-text-field(
            v-model='offlineUnlockSecret'
            :label='$t(`common:page.unlockSecret`)'
            type='password'
            autocomplete='off'
            spellcheck='false'
            :disabled='offlineUnlockBusy'
            :error-messages='offlineUnlockError ? [offlineUnlockError] : []'
            @keyup.enter='unlockPrivateOfflinePage'
          )
        v-card-actions
          v-spacer
          v-btn(variant='text', :disabled='offlineUnlockBusy', @click='closeOfflineUnlock') {{ $t(`common:actions.cancel`) }}
          v-btn(
            color='primary'
            variant='tonal'
            :loading='offlineUnlockBusy'
            :disabled='offlineUnlockBusy || !offlineUnlockSecret'
            @click='unlockPrivateOfflinePage'
          ) {{ $t(`common:page.unlock`) }}
    v-fab-transition
      v-btn.page-return-top(
        v-if='upBtnShown && (!isTocCompact || tocPosition === `off` || talkActive || linksActive) && (!readerFocus || talkActive || linksActive)'
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
import type { Environment as PrismEnvironment } from 'prismjs'
import { defineComponent, h, inject, markRaw, type PropType, shallowRef, useId, type VNode } from 'vue'
import { useGoTo } from 'vuetify'
import AsyncState from '@/components/common/async-state.vue'
import PageBrandingMark from '@/components/common/page-branding-mark.vue'
import SiteBanner from '@/components/common/site-banner.vue'
import GlossaryReader from '@/components/common/glossary-reader.vue'
import DiscussionAnnotations from '@/components/common/discussion-annotations.vue'
import PageGovernance from '@/components/page-governance.vue'
import { composeDiscussionAnnotation, onJumpDiscussionAnnotation } from '@/helpers/discussion-annotation-events'
import type { DiscussionAnnotationAnchor } from '../../../../shared/discussion-annotations.ts'
import { fetchPage, verifyPageAccuracy } from '@/helpers/pages-api'
import { PageAccuracyViewSchema, PAGE_ACCURACY_DAY_MS, type PageAccuracyView } from '../../../../shared/page-accuracy.ts'
import { publicationBoundaryTimestamp, publicationWindowOpen } from '../../../../shared/publication-window.ts'
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
  type PageReadingProgressScope,
  type PageReadingProgressState,
  type PageReadingSectionProgress,
  trackPageOutline
} from '@/helpers/page-outline'
import { wikiStore } from '@/store/index.ts'
import { externalSourceUrl } from '../../../../shared/general-policy.ts'
import type { OfflinePagePolicyRecord, OfflinePolicySnapshot, OfflineSnapshotCorpus, OfflineSnapshotRecord, OfflineSnapshotSelector } from '../../../../shared/offline.ts'
import type { PageBrandingView } from '../../../../shared/page-branding.ts'
import { tagColorBucket } from '../../../../shared/tag-colors.ts'
import { decodeBase64Json } from '../../../helpers/base64'
import { hydrateContentExtensions, revealContentExtensionTarget } from '../../../helpers/content-extension-runtime'
import { hydrateReaderCitedCopy, type ReaderCitedCopySource } from '../../../helpers/reader-cited-copy.ts'
import {
  MERMAID_MAX_TEXT_SIZE,
  renderMermaidSvg,
  selectMermaidRenderHosts
} from '../../../helpers/content-extension-runtimes/mermaid.ts'
import {
  OFFLINE_SUPPORTED_EDITORS,
  type OfflineLocalIneligibility,
  type OfflinePageAccessState,
  type OfflinePageControl,
  offlineIneligibilityIsQuiet,
  offlinePageControl,
  offlinePrivateAccessStatus,
  offlineSavedPageState
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
  emitPageSource,
  emitReaderPageActionsChanged,
  offReaderPageAction,
  offReaderPageActionsRequest,
  onReaderPageAction,
  onReaderPageActionsRequest,
  sameReaderPageIdentity,
  type ReaderPageActionRequest,
  type ReaderPageActionsRequest,
  type ReaderPageActionsState,
  type ReaderPageIdentity
} from '../../../helpers/page-action-events'
import {
  brandingDuplicatesSiteLogo,
  normalizePageBrandingView,
  pageBrandingIdentity,
  resolvePageBrandingStyle
} from '../../../helpers/page-branding'
import { pwaState } from '../../../helpers/pwa.ts'
import { useGlossaryMemory } from '../../../helpers/glossary-memory.ts'
import { canSearchReviewerDirectory, manualReviewerId, searchApprovalReviewers, type ApprovalReviewerOption } from '../../../helpers/approval-reviewer-search.ts'
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
import { translate } from '../../../modules/localization.ts'
import type { Translate } from '@/helpers/use-translate.ts'

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

const offlineSyncAggregateNotice = (t: Translate, result: OfflineSyncResult): string | null => {
  if (result.outcome !== 'error' && result.outcome !== 'unavailable') return null
  const detail = offlineSyncResultDetail(result, t('common:offline.syncIssueDetail'))
  return t('common:offline.otherPagesNeedAttention', { detail, interpolation: { escapeValue: false } }).slice(0, 512)
}

const offlineSyncFailureNotice = (t: Translate, detail: string): string =>
  t('common:offline.backgroundSyncIssue', { detail: (detail.trim() || t('common:offline.currentStateRefreshed')), interpolation: { escapeValue: false } }).slice(0, 512)

type PageTag = {
  tag: string
  title: string | null
}



type ApprovalTransition = {
  id: string
  fromStatus: string | null
  toStatus: string
  actorId: number
  // Display name from the approval API; null when the account has no name.
  actorName?: string | null
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
const PAGE_MERMAID_ERROR_MESSAGE = 'common:page.diagramCouldNotRendered'
const PAGE_MERMAID_LIMIT_NOTICE_CLASS = 'content-extension-diagram__limit-notice'
const PAGE_MERMAID_LIMIT_NOTICE_MESSAGE = 'common:page.additionalDiagramsRemainAvailable'

const pageMermaidSource = (host: HTMLElement): string | null => {
  if (host.matches('.mermaid')) return host.textContent ?? ''
  return host.querySelector<HTMLElement>('.content-extension-diagram__source code')?.textContent ?? null
}

const showPageMermaidLimitNotice = (t: Translate, container: HTMLElement): void => {
  if (container.querySelector(`.${PAGE_MERMAID_LIMIT_NOTICE_CLASS}`)) return
  const notice = container.ownerDocument.createElement('p')
  notice.className = PAGE_MERMAID_LIMIT_NOTICE_CLASS
  notice.textContent = t(PAGE_MERMAID_LIMIT_NOTICE_MESSAGE)
  container.append(notice)
}

const renderPageMermaidDiagrams = async (
  t: Translate,
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
  if (excessHosts.length > 0) showPageMermaidLimitNotice(t, container)
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
        safeSvg.setAttribute('aria-label', t('common:page.mermaidDiagram'))
        diagram.replaceChildren(safeSvg)
        diagram.dataset.pageMermaidState = 'rendered'
      } catch {
        if (!current()) return
        if (!diagram.querySelector(`.${PAGE_MERMAID_ERROR_CLASS}`)) {
          const status = container.ownerDocument.createElement('p')
          status.className = PAGE_MERMAID_ERROR_CLASS
          status.setAttribute('role', 'alert')
          status.textContent = t(PAGE_MERMAID_ERROR_MESSAGE)
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
    readingSections: { type: Object as PropType<ReadonlyMap<string, PageReadingSectionProgress>>, required: true },
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
      const reading = props.readingSections.get(decodePageAnchor(node.anchor))
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
            isDescendantActive ? 'page-toc-item--descendant-active' : '',
            reading?.completed ? 'page-toc-item--completed' : ''
          ],
          'aria-current': isActive ? 'location' : undefined,
          title: node.title,
          onClick: (e: MouseEvent) => props.onNavigate(e, node.anchor)
        },
        [
          h(
            'span',
            {
              class: ['page-toc-item-title', titleClass]
            },
            [h('span', { class: 'page-toc-item-title-text' }, node.title)]
          ),
          reading?.completed ? h('span', { class: 'page-reading-completed', 'aria-hidden': 'true' }, [
            h('i', { class: ['mdi', 'mdi-check'] })
          ]) : null
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

function nextReaderContent(node: ChildNode | null): ChildNode | null {
  while (node && (node.nodeType === 8 || (node.nodeType === 3 && !node.textContent?.trim()))) node = node.nextSibling
  return node
}

function readerHeadingText(node: Node): string | null {
  if (node.nodeType === 3) return node.textContent ?? ''
  if (!(node instanceof Element) || node.matches('a.toc-anchor')) return ''
  if (node.matches('a,img,svg,math,video,audio,iframe,input,button,[aria-label],[aria-hidden]')) return null
  if (node.tagName === 'BR') return ' '
  let text = ''
  for (const child of node.childNodes) {
    const part = readerHeadingText(child)
    if (part === null) return null
    text += part
  }
  return text
}

function normalizeReaderTitle(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase()
}

export default defineComponent({
  name: 'PageView',
  components: {
    AsyncState,
    GlossaryReader,
    DiscussionAnnotations,
    PageGovernance,
    NavSidebar,
    SiteBanner,
    PageBrandingMark,
    PageTocTree,
  },
  emits: ['update:activeView', 'focus-thread'],
  setup (props) {
    const glossaryMemory = useGlossaryMemory(() => `${props.pageId}:${props.navigationKey}:${props.sourceRevision}`, () => props.locale)
    return {
      glossaryPinState: glossaryMemory.pinState,
      selectGlossaryPin: glossaryMemory.selectPin,
      requestGlossaryPin: glossaryMemory.requestPin,
      goTo: useGoTo(),
      readerCitedCopyHintPrefix: `reader-cited-copy-hint-${useId()}`,
      readerContentRoot: shallowRef<HTMLElement | null>(null),
      readerActionReturnFocus: shallowRef<HTMLElement | null>(null),
      readingContentNode: shallowRef<HTMLElement | null>(null),
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
      default: () => translate('common:page.untitledPage')
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
      default: () => translate('common:page.unknown')
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
    effectiveIsPublished: {
      type: Boolean,
      default: false
    },
    publicSharingEligible: {
      type: Boolean,
      default: false
    },
    publishStartDate: {
      type: String as PropType<string | null>,
      default: null
    },
    publishEndDate: {
      type: String as PropType<string | null>,
      default: null
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
      type: String as PropType<'article' | 'talk' | 'links'>,
      default: 'article'
    },
    linksVisible: {
      type: Boolean,
      default: false
    },
    ratingsVisible: {
      type: Boolean,
      default: false
    },
    lastEditorVisible: {
      type: Boolean,
      default: false
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
    pageTransitions: {
      type: Boolean,
      default: true
    },
    showPageProgress: {
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
    const viewportMedia = typeof window === 'undefined' ? null : window.matchMedia('(min-width: 1280px)')
    const initialWideViewport = viewportMedia?.matches ?? false
    return {
      locales: siteLangs,
      discussionMounted: false,
      annotationJumpUnsubscribe: null as (() => void) | null,
      navShown: initialWideViewport,
      tocExpanded: false,
      tocQuery: '',
      tocUserScrollAt: 0,
      tocScrollBound: false,
      expandedAnchors: new Set<string>(),
      collapsedByUser: new Set<string>(),
      preSearchExpanded: null as Set<string> | null,
      brandingFailureIdentity: null as string | null,
      leadingTitle: null as { heading: HTMLElement; id: string; alias: HTMLElement } | null,
      preSearchCollapsedByUser: null as Set<string> | null,
      searchOverrides: new Map<string, boolean>(),
      readerFocus: false,
      readerFullWidth: false,
      shareMenuOpen: false,
      readingDockObserver: null as ResizeObserver | null,
      readingDockNode: null as HTMLElement | null,
      readingDockHeight: 0,
      readerActionReturnPage: null as ReaderPageIdentity | null,
      pageWatchSettingsOpen: false,
      readerSectionsOpen: false,
      readingProgress: 0,
      accuracyView: null as PageAccuracyView | null,
      accuracyReadyKey: '',
      accuracyRequestId: 0,
      accuracyMutationId: 0,
      accuracyPending: false,
      accuracyError: '',
      accuracyReviewRequired: false,
      accuracyTimer: null as ReturnType<typeof setTimeout> | null,
      accuracyVisibilityHandler: null as (() => void) | null,
      publicationClock: Date.now(),
      publicationTimer: null as ReturnType<typeof setTimeout> | null,
      measuredReading: { status: 'disabled', progress: 0, sections: [], completedAnchors: [] } as PageReadingProgressState,
      readingContentAuthority: null as string | null,
      readingAdmittedContentKey: '',
      readingOutlineEpoch: 0,
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
      offlinePassiveOperationId: null as number | null,
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
      approvalReviewerQuery: '',
      approvalReviewerOptions: [] as ApprovalReviewerOption[],
      approvalReviewerLoading: false,
      approvalReviewerSearchFailed: false,
      approvalReviewerSearchSeq: 0,
      approvalReviewerTimer: null as ReturnType<typeof setTimeout> | null,
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
      viewportMedia,
      wideViewport: initialWideViewport,
      resizeHandler: null as (() => void) | null,
      loadHandler: null as (() => void) | null,
      beforePrintHandler: null as (() => void) | null,
      afterPrintHandler: null as (() => void) | null,
      printViewBeforePrint: null as boolean | null,
      printDetailsState: null as Map<HTMLDetailsElement, boolean> | null,
      contentExtensionCleanup: null as (() => void) | null,
      readerCitedCopyCleanup: null as (() => void) | null,
      mermaidAbortController: null as AbortController | null,
      routeAnimationAbortController: null as AbortController | null,
      scrollAnimationFrame: null as number | null,
      scrollAnimationToken: 0,
      scrollLandingCleanup: null as (() => void) | null,
    }
  },
  computed: {
    readerPageIdentity (): ReaderPageIdentity {
      return { pageId: this.pageId, locale: this.locale, path: this.path, visibility: this.visibility, sourceRevision: this.sourceRevision }
    },
    readerPageActionsState (): ReaderPageActionsState {
      const page = this.readerPageIdentity
      const current = wikiStore.page
      const ready = !this.navigationPending && !this.offlineDisposed &&
        page.pageId > 0 && page.sourceRevision.length > 0 &&
        current.mode === 'view' && current.id === page.pageId && current.locale === page.locale &&
        current.path === page.path && current.visibility === page.visibility && current.sourceRevision === page.sourceRevision
      const canManage = this.isAuthenticated && (this.hasWritePagesPermission || this.hasManagePagesPermission || this.hasAdminPermission)
      return {
        page,
        ready,
        actions: {
          print: { visible: true, enabled: true, active: this.printView },
          fullWidth: { visible: !this.talkActive && !this.linksActive, enabled: true, active: this.readerFullWidth },
          watch: {
            visible: this.isAuthenticated && !this.pageWatched,
            enabled: this.pageWatchActionReady && !this.pageWatchLoading,
            blockedReason: this.pageWatchBlockedReason
          },
          watchSettings: {
            visible: this.isAuthenticated && this.pageWatched,
            enabled: this.pageWatchActionReady && !this.pageWatchLoading,
            active: this.pageWatched,
            blockedReason: this.pageWatchBlockedReason
          },
          approval: {
            visible: canManage,
            enabled: this.pageOnlineActionReady && !this.approvalLoading && !this.approvalInitialLoading,
            active: Boolean(this.pageApproval),
            blockedReason: this.pageOnlineActionUnavailableReason
          },
          protection: {
            visible: canManage,
            enabled: this.pageOnlineActionReady && !this.protectionLoading && !this.protectionInitialLoading,
            active: this.pageProtection.protected,
            blockedReason: this.pageProtectionBlockedReason
          }
        }
      }
    },
    navigationOpen: {
      get (): boolean { return (this.talkActive || this.linksActive || !this.readerFocus) && this.navShown },
      set (value: boolean) { if (!this.readerFocus || this.talkActive || this.linksActive) this.navShown = value }
    },
    navDrawerWidth (): number {
      return this.wideViewport ? 256 : 244
    },
    // Below 1280 the drawer floats over the content, so the reading bar keeps
    // its full width; docked, it starts where the sidebar ends.
    pagePositionInsetStart (): string {
      const docked = this.navMode !== 'NONE' &&
        this.wideViewport &&
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
      return this.pageBranding !== null && !this.pageBrandingDuplicatesSiteLogo && this.pageBrandingIdentity !== this.brandingFailureIdentity
    },
    // The header already shows the site logo; skip a page mark that is the same file.
    pageBrandingDuplicatesSiteLogo (): boolean {
      return brandingDuplicatesSiteLogo(this.pageBranding, wikiStore.site)
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
    readingContentKey (): string {
      return JSON.stringify([this.pageId, this.locale, this.sourceRevision, this.navigationKey])
    },
    readingReaderAuthority (): string {
      // A warm bootstrap identity, an offline body, or a failed session refresh
      // is not admission to measure this reader's content.
      if (!this.pageTransportVerified || wikiStore.authRefreshPending || !wikiStore.authRefreshSettled) return ''
      const permissions = [this.effectivePermissions, wikiStore.page.effectivePermissions, wikiStore.user.permissions]
      if (this.pageAuthorizationFresh && Number.isSafeInteger(wikiStore.user.id) && wikiStore.user.id > 0 &&
        Number.isSafeInteger(wikiStore.user.authVersion) && wikiStore.user.authVersion >= 0) {
        return JSON.stringify(['account', wikiStore.user.id, wikiStore.user.authVersion, wikiStore.offlineIdentityEpoch, permissions])
      }
      return !this.isAuthenticated && wikiStore.authRefreshOutcome === 'anonymous'
        ? JSON.stringify(['anonymous', wikiStore.offlineIdentityEpoch, permissions])
        : ''
    },
    readingProgressScope (): PageReadingProgressScope | null {
      const workspace = typeof window === 'undefined' ? null : window.siteConfig?.offlineDraftSiteId
      if (typeof workspace !== 'string' || !workspace.trim() ||
        !this.readingReaderAuthority || this.readingContentAuthority !== this.readingReaderAuthority ||
        this.readingAdmittedContentKey !== this.readingContentKey ||
        !Number.isSafeInteger(this.pageId) || this.pageId < 1 || !this.locale.trim() || !this.sourceRevision.trim() ||
        this.navigationPending || this.printView || this.selectedPageView !== 'article' ||
        (this.visibility !== 'public' && this.visibility !== 'private') ||
        (this.visibility === 'private' && !this.pageAuthorizationFresh)) return null
      return {
        canonicalWorkspaceId: workspace.trim(),
        reader: this.isAuthenticated ? { kind: 'account', accountId: String(wikiStore.user.id) } : { kind: 'anonymous' },
        locale: this.locale,
        pageId: String(this.pageId),
        sourceRevision: this.sourceRevision,
        authority: this.visibility === 'private' ? 'private-readable' : 'public-readable',
        // Stable across reloads, but changes with membership/authority. Never
        // use a session token or the transient identity epoch in persisted scope.
        authorityKey: JSON.stringify([this.visibility, this.isAuthenticated ? wikiStore.user.authVersion : null,
          this.effectivePermissions, wikiStore.page.effectivePermissions, wikiStore.user.permissions])
      }
    },
    readingProgressContextKey (): string {
      return JSON.stringify([this.readingContentKey, this.readingReaderAuthority, this.visibility,
        this.navigationPending, this.printView, this.selectedPageView])
    },
    readerCitedCopyContextKey (): string {
      return JSON.stringify([this.readingProgressContextKey, this.readingContentAuthority,
        this.readingAdmittedContentKey, this.readerPageActionsState.ready, this.path,
        this.updatedAt, this.title, this.description, this.offlineDisposed])
    },
    readerCitedCopySource (): ReaderCitedCopySource | null {
      if (this.offlineDisposed || !this.readerPageActionsState.ready || !this.pageTransportVerified ||
        !this.readingReaderAuthority || this.readingContentAuthority !== this.readingReaderAuthority ||
        this.readingAdmittedContentKey !== this.readingContentKey ||
        this.readingContentNode !== this.$refs.container || this.navigationPending || this.printView ||
        this.selectedPageView !== 'article' || !this.sourceRevision.trim() ||
        !this.updatedAt.trim() || !Number.isFinite(Date.parse(this.updatedAt)) ||
        (this.visibility === 'private' && !this.pageAuthorizationFresh)) return null
      return {
        id: this.pageId, locale: this.locale, path: this.path, title: this.title,
        description: this.description, visibility: this.visibility,
        updatedAt: this.updatedAt, sourceRevision: this.sourceRevision
      }
    },
    readingProgressAvailable (): boolean {
      return this.readingProgressScope !== null && this.measuredReading.status === 'tracking' && this.measuredReading.sections.length > 0
    },
    readingSectionsByAnchor (): ReadonlyMap<string, PageReadingSectionProgress> {
      return new Map(this.readingProgressAvailable
        ? this.measuredReading.sections.map(section => [decodePageAnchor(section.anchor), section] as const)
        : [])
    },
    readingProgressSummary (): string {
      if (!this.tocFlattened.length) {
        return this.$t('common:page.readingSectionProgress', { percent: this.measuredReading.progress })
      }
      return this.$t('common:page.readingProgressSummary', {
        percent: this.measuredReading.progress,
        completed: this.measuredReading.completedAnchors.length,
        total: this.measuredReading.sections.length
      })
    },
    readingProgressDescription (): string {
      return `${this.readingProgressSummary}. ${this.$t('common:page.readingProgressMeaning')}`
    },
    readerSectionReading (): PageReadingSectionProgress | null {
      return this.readerSection ? this.readingSectionsByAnchor.get(decodePageAnchor(this.readerSection.anchor)) ?? null : null
    },
    pageOnlineActionUnavailableReason (): string {
      if (!this.pageTransportVerified) {
        if (pwaState.connectionState === 'checking') return this.$t('common:page.waitingForConnection')
        return this.$t('common:page.connectionRequired')
      }
      if (!this.pageAuthorizationFresh) return this.$t('common:page.freshSessionRequired')
      return ''
    },
    // Reason shown in the watch tooltip and settings while the action is blocked.
    pageWatchBlockedReason (): string {
      if (!this.pageOnlineActionReady) return this.pageOnlineActionUnavailableReason
      if (!this.pageWatchAuthorityReady && !this.pageWatchLoading) return this.$t('common:page.watchStateStale')
      return ''
    },
    pageProtectionBlockedReason (): string {
      if (!this.pageOnlineActionReady) return this.pageOnlineActionUnavailableReason
      if (this.protectionInitialLoading) return this.$t('common:page.loadingPageProtection')
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
        return this.$t('common:page.approvalStateStale')
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
    accuracyContextKey (): string {
      return JSON.stringify([this.pageAuthorityKey, wikiStore.user.authVersion, this.pageActionGeneration,
        this.pageId, this.locale, this.path, this.sourceRevision, this.navigationKey,
        this.navigationPending, this.printView, this.readerPageActionsState.ready])
    },
    accuracyMenuContentProps () {
      return { role: 'dialog', 'aria-label': this.$t('common:page.accuracyDetails') }
    },
    shareMenuContentProps () {
      return { role: 'dialog', 'aria-label': this.$t('common:page.share') }
    },
    accuracyCurrent (): PageAccuracyView | null {
      if (this.accuracyReadyKey !== this.accuracyContextKey || !this.pageTransportVerified ||
        wikiStore.authRefreshPending || !wikiStore.authRefreshSettled || this.navigationPending ||
        this.offlineDisposed || this.accuracyReviewRequired ||
        (this.visibility === 'private' && !this.pageAuthorizationFresh)) return null
      const view = this.accuracyView
      if (!view || view.sourceRevision !== this.sourceRevision ||
        (view.latestAttestation && view.latestAttestation.pageId !== this.pageId)) return null
      return view
    },
    accuracyStatus (): string {
      return this.accuracyCurrent?.status ?? 'needs-verification'
    },
    accuracyLabel (): string {
      return this.$t(`common:page.accuracyStatus.${this.accuracyStatus}`)
    },
    accuracyStamp () {
      const view = this.accuracyCurrent
      const stamp = view?.latestAttestation
      return stamp && Date.parse(stamp.verifiedAt) <= Date.parse(view!.asOf) ? stamp : null
    },
    accuracyAgeDays (): number {
      const view = this.accuracyCurrent
      return view && this.accuracyStamp
        ? Math.floor((Date.parse(view.asOf) - Date.parse(this.accuracyStamp.verifiedAt)) / PAGE_ACCURACY_DAY_MS)
        : 0
    },
    accuracyActionReady (): boolean {
      return Boolean(this.accuracyCurrent?.canVerify && this.pageOnlineActionReady &&
        this.readerPageActionsState.ready && !this.printView && !this.accuracyReviewRequired)
    },
    accuracyUnavailableReason (): string {
      if (this.accuracyReviewRequired) return this.$t('common:page.accuracyRevisionChanged')
      if (!this.pageOnlineActionReady) return this.pageOnlineActionUnavailableReason
      if (!this.accuracyCurrent) return this.$t('common:page.accuracyUnknown')
      if (!this.accuracyCurrent.canVerify) return this.$t('common:page.accuracyNotAuthorized')
      return ''
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
    linksActive (): boolean {
      return this.activeView === 'links' && this.linksVisible && !this.printView
    },
    selectedPageView (): 'article' | 'talk' | 'links' {
      if (this.activeView === 'talk' && !this.talkActive) return 'article'
      if (this.activeView === 'links' && !this.linksActive) return 'article'
      return this.activeView
    },
    showPageViewTabs (): boolean {
      return !this.printView && (this.linksVisible || (this.commentsEnabled && this.commentsPerms.read && !this.commentsExternal))
    },
    contentDirection (): 'ltr' | 'rtl' {
      return i18next.dir(this.locale)
    },
    editShortcutsObj () {
      return wikiStore.page.editShortcuts
    },
    // The hero owns Edit; the configured FAB retains other page actions.
    showEditFab (): boolean {
      return Boolean(this.hasAnyPagePermissions && this.editShortcutsObj.editFab && this.$vuetify.display.smAndDown)
    },
    showHeaderEditButton (): boolean {
      return this.hasWritePagesPermission && Boolean((this.editShortcutsObj.editMenuBar && this.editShortcutsObj.editMenuBtn) || this.editShortcutsObj.editFab)
    },
    // i18next places {{author}} anywhere in the sentence; split around it so the
    // name renders in an isolated <bdi> without breaking word order.
    authorAttribution (): { before: string; after: string } {
      const marker = this.$t('common:page.author')
      const sentence = String(this.$t('common:page.byAuthor', { author: marker, interpolation: { escapeValue: false } }))
      const index = sentence.indexOf(marker)
      if (index < 0) return { before: `${sentence} `, after: '' }
      return { before: sentence.slice(0, index), after: sentence.slice(index + marker.length) }
    },
    // Names the approval API returned for history actors, reused to label a selected reviewer.
    approvalActorNames (): Map<number, string> {
      const names = new Map<number, string>()
      for (const transition of this.pageApproval?.transitions ?? []) {
        if (typeof transition.actorName === 'string' && transition.actorName.trim()) names.set(transition.actorId, transition.actorName.trim())
      }
      return names
    },
    approvalReviewerItems (): ApprovalReviewerOption[] {
      const options = [...this.approvalReviewerOptions]
      const typedId = manualReviewerId(this.approvalReviewerQuery ?? '')
      const known = new Set(options.map(option => option.id))
      if (typedId !== null && !known.has(typedId)) {
        options.unshift({ id: typedId, label: this.approvalActorLabel(typedId), source: 'manual' })
        known.add(typedId)
      }
      const selected = this.approvalAssigneeId
      if (typeof selected === 'number' && selected > 0 && !known.has(selected)) {
        options.push({ id: selected, label: this.approvalActorLabel(selected), source: 'manual' })
      }
      return options
    },
    approvalReviewerNoDataText (): string {
      if (this.approvalReviewerLoading) return this.$t('common:page.reviewerSearching')
      if (this.approvalReviewerSearchFailed) return this.$t('common:page.reviewerSearchUnavailable')
      return this.$t('common:page.reviewerNoMatches')
    },
    breadcrumbs(): Breadcrumb[] {
      const scope = this.visibility === 'private' ? '/_private' : ''
      const localePrefix = this.locales.length > 0 ? `/${encodeURIComponent(this.locale)}` : ''
      let currentPath = `${scope}${localePrefix}`
      const items: Breadcrumb[] = [{ href: localePrefix ? `${localePrefix}/home` : '/', title: this.$t('common:header.home') as string }]
      for (const segment of this.path.split('/').filter(Boolean)) {
        currentPath += `/${encodeURIComponent(segment)}`
        items.push({ href: currentPath, title: segment })
      }
      return items
    },
    pageUrl (): string {
      const scope = this.visibility === 'private' ? '/_private' : ''
      const locale = this.locales.length > 0 ? `/${encodeURIComponent(this.locale)}` : ''
      const path = this.path.split('/').map(segment => encodeURIComponent(segment)).join('/')
      return new URL(`${scope}${locale}/${path}`, window.location.origin).href
    },
    offlinePrivatePath (): boolean {
      void this.offlineReadingStateVersion
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
    offlineLocalIneligibilityReason (): OfflineLocalIneligibility {
      void this.offlineReadingStateVersion
      if (!this.offlineSelector()) return 'no-selector'
      if (!this.isPublished) return 'unpublished'
      if (this.pageProtection.protected) return 'protected'
      if (this.editor && !OFFLINE_SUPPORTED_EDITORS.has(this.editor)) return 'editor'
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
    offlineControl (): OfflinePageControl {
      const policy = this.offlinePolicy
      const owned = this.offlineOwnedOperationId
      return offlinePageControl({
        state: this.offlineState,
        accessState: this.offlineAccessState,
        selected: this.offlineSelected,
        hasSnapshot: this.offlineHasSnapshot,
        hasValidBody: this.offlineHasValidBody,
        excluded: Boolean(policy?.excluded),
        manual: Boolean(policy && !policy.excluded && policy.manual),
        automatic: Boolean(policy && !policy.excluded && policy.automatic),
        tag: Boolean(policy && !policy.excluded && policy.tag),
        tagNames: policy?.tagNames ?? [],
        revealTagNames: !(this.offlinePrivatePath && this.offlineAccessState !== null),
        quietIneligibility: this.offlineQuietIneligibility,
        localReason: this.offlineLocalIneligibilityReason,
        serverReason: policy?.availability === 'ineligible' ? policy.ineligibleReason ?? null : null,
        connected: this.pageTransportVerified,
        // A passive visit record never blocks the toggle; an explicit change does.
        busy: owned !== null && owned !== this.offlinePassiveOperationId,
        errorDetail: this.offlineError || this.offlineAvailabilityError
      }, (key, options) => this.$t(key, options))
    },
    offlineStatusLabel (): string {
      const { title, detail } = this.offlineControl
      if (!detail) return title
      return /[.…!?]$/u.test(title) ? `${title} ${detail}` : `${title}. ${detail}`
    },
    sidebarDecoded (): SidebarItem[] {
      return decodeBase64Json<SidebarItem[]>(this.sidebar)
    },
    tocDecoded (): TableOfContentsNode[] {
      return decodeBase64Json<TableOfContentsNode[]>(this.toc)
    },
    tocFlattened (): FlattenedTableOfContentsNode[] {
      const entries = normalizeTableOfContents(this.tocDecoded)
      const id = this.leadingTitle?.id
      if (!id) return entries
      const index = entries.findIndex(entry => decodePageAnchor(entry.anchor).replace(/^#/, '') === id)
      return index < 0 ? entries : entries.filter((_, entryIndex) => entryIndex !== index)
    },
    tocTree (): OutlineNode[] {
      return buildOutlineTree(this.tocFlattened)
    },
    tocTreeVisible (): OutlineNode[] {
      if (this.tocQuery?.trim()) return filterOutlineTree(this.tocTree, this.tocQuery)
      return this.tocTree
    },
    readerHasSections (): boolean {
      return this.tocPosition !== 'off' && this.tocFlattened.length >= 2
    },
    readerSectionsAvailable (): boolean {
      return this.readerFocus && !this.printView && !this.talkActive && !this.linksActive && this.readerHasSections
    },
    readerDockVisible (): boolean {
      return this.readerFocus && !this.printView && !this.talkActive && !this.linksActive
    },
    readerSectionIndex (): number {
      if (!this.readerHasSections) return -1
      const anchor = decodePageAnchor(this.activeAnchor)
      return Math.max(0, this.tocFlattened.findIndex(entry => decodePageAnchor(entry.anchor) === anchor))
    },
    readerSection (): FlattenedTableOfContentsNode | null {
      return this.readerHasSections ? this.tocFlattened[this.readerSectionIndex] ?? null : null
    },
    shareSectionAnchor (): string {
      const id = decodePageAnchor(this.activeAnchor).replace(/^#/, '')
      const container = this.$refs.container
      if (!id || this.navigationPending || this.selectedPageView !== 'article' || !(container instanceof HTMLElement)) return ''
      return this.tocFlattened.some(entry => decodePageAnchor(entry.anchor).replace(/^#/, '') === id) &&
        Array.from(container.querySelectorAll<HTMLElement>('[id]')).some(element => element.id === id) ? id : ''
    },
    currentPublicationEligible (): boolean {
      return this.effectiveIsPublished === true && this.isPublished &&
        publicationWindowOpen(this, Math.max(this.publicationClock, Date.now()))
    },
    publicSharingContextEligible (): boolean {
      return this.publicSharingEligible === true && this.visibility === 'public' && this.currentPublicationEligible && this.pageTransportVerified &&
        Boolean(this.readingReaderAuthority) && this.readingContentAuthority === this.readingReaderAuthority &&
        this.readingAdmittedContentKey === this.readingContentKey && this.readingContentNode === this.$refs.container &&
        !this.offlineDisposed && !this.navigationPending && !this.printView && this.selectedPageView === 'article'
    },
    updatedAtLabel (): string {
      return this.$t('common:page.updatedAt', { date: this.formatUpdatedAt('calendar'), interpolation: { escapeValue: false } })
    },
    accessibleUpdatedAt (): string {
      return this.formatUpdatedAt('LLLL')
    },
    hasAuthor (): boolean {
      return this.lastEditorVisible && Boolean(this.authorName && this.authorName.trim() && this.authorName.toLowerCase() !== 'unknown')
    },
    isTocCompact (): boolean {
      return !this.wideViewport
    },
    tocDisclosureExpanded (): boolean {
      return !this.isTocCompact || this.tocExpanded
    },

    tocPosition () {
      const position = wikiStore.site.tocPosition
      return position === 'auto' ? 'right' : position
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
    isTocCompact () {
      const focused = document.activeElement instanceof HTMLElement && document.activeElement.closest('.page-toc-card')
        ? document.activeElement : null
      this.$nextTick(() => {
        this.setupTocResizeObserver()
        this.ensureActiveTocVisible()
        this.outlineCleanup?.refresh()
        if (focused?.isConnected) {
          const target = this.isTocCompact && !this.tocExpanded && !this.readerSectionsOpen
            ? (this.$el as HTMLElement).querySelector<HTMLElement>('.page-toc-toggle') : focused
          target?.focus({ preventScroll: true })
        }
      })
    },
    readerCitedCopyContextKey: {
      flush: 'sync',
      handler () {
        this.retireReaderCitedCopy()
        const identity = this.readerCitedCopyContextKey
        this.$nextTick(() => {
          if (!this.offlineDisposed && identity === this.readerCitedCopyContextKey) this.setupReaderCitedCopy()
        })
      }
    },
    accuracyContextKey: {
      flush: 'sync',
      handler () {
        this.invalidateAccuracy()
        this.accuracyReviewRequired = false
        if (!this.offlineDisposed) void this.loadAccuracy()
      }
    },
    readingProgressContextKey: {
      flush: 'sync',
      handler () {
        // Fence callbacks/dwell/storage synchronously, before changed authority
        // or a replacement article can render. Reuse the one outline lifecycle.
        this.retirePageOutline(true)
        const epoch = this.readingOutlineEpoch
        this.$nextTick(() => {
          if (!this.offlineDisposed && epoch === this.readingOutlineEpoch) this.setupPageOutline()
        })
      }
    },
    effectiveIsPublished () { this.refreshPublicationClock() },
    publishStartDate () { this.refreshPublicationClock() },
    publishEndDate () { this.refreshPublicationClock() },
    title () {
      this.$nextTick(() => {
        if (!this.offlineDisposed) this.refreshPageContent()
      })
    },
    readerDockVisible () {
      this.$nextTick(this.observeReadingDock)
    },
    readerPageActionsState: {
      deep: true,
      handler () { emitReaderPageActionsChanged() }
    },
    pageWatched (watched: boolean) {
      if (!watched) this.pageWatchSettingsOpen = false
    },
    selectedPageView: {
      immediate: true,
      handler(value: string) {
        if (value === 'talk') this.discussionMounted = true
      }
    },
    readerSectionsAvailable (available: boolean) {
      if (!available) this.closeReaderSections()
    },
    approvalReviewerQuery (query: string | null | undefined) {
      if (!this.approvalDialog) return
      this.queueApprovalReviewerSearch(query ?? '')
    },
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
        this.retirePageOutline()
        this.closeReaderSections()
        this.expandedAnchors = getInitialExpandedAnchors(entries)
        this.collapsedByUser = new Set()
        this.preSearchExpanded = null
        this.preSearchCollapsedByUser = null
        this.searchOverrides.clear()
        this.$nextTick(() => {
          if (!this.offlineDisposed) this.setupPageOutline()
          this.setupTocResizeObserver()
          this.ensureActiveTocVisible()
        })
      }
    },
    tocPosition () {
      const restoreFocus = this.tocPosition === 'off' && document.activeElement instanceof HTMLElement && Boolean(document.activeElement.closest('.page-toc-card'))
      this.$nextTick(() => {
        this.setupTocResizeObserver()
        this.ensureActiveTocVisible()
        if (restoreFocus) this.focusPageTitle()
      })
    },
    navigationKey: {
      flush: 'post',
      async handler(value: number, previous: number) {
        if (value === previous) return
        this.syncPageStore()
        this.resetPageRouteState()
        this.discussionMounted = this.selectedPageView === 'talk'
        await this.$nextTick()
        if (this.offlineDisposed || value !== this.navigationKey) return
        this.refreshPageContent()
        const offlinePageId = this.pageId
        const offlineLocale = this.locale
        void this.recordOfflineReaderVisit().then(() => {
          if (this.offlineDisposed || this.pageId !== offlinePageId || this.locale !== offlineLocale) return
          // A save or remove started during the visit owns the next refresh.
          if (this.offlineOwnedOperationId !== null) {
            this.offlinePassiveRefreshPending = true
            return
          }
          this.offlinePassiveRefreshPending = false
          void this.refreshOfflinePageState()
        })
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
    // Subscribe before the child: queue the native pane update before its nextTick jump.
    this.annotationJumpUnsubscribe = onJumpDiscussionAnnotation(pageId => {
      if (pageId === this.pageId && this.commentsEnabled && this.commentsPerms.read && !this.commentsExternal) this.selectPageView('article')
    })
  },
  mounted () {
    onReaderPageActionsRequest(this.provideReaderPageActions)
    this.refreshPublicationClock()
    this.accuracyVisibilityHandler = () => {
      this.refreshPublicationClock()
      this.invalidateAccuracy()
      if (document.visibilityState === 'visible') void this.loadAccuracy()
    }
    document.addEventListener('visibilitychange', this.accuracyVisibilityHandler)
    void this.loadAccuracy()
    onReaderPageAction(this.runReaderPageAction)
    emitReaderPageActionsChanged()
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
        // Same-generation policy/corpus updates do not revoke a locked reading vault.
        void this.refreshOfflinePageState(notice.kind !== 'generation' && notice.sessionGeneration === this.offlineGeneration)
      }
    })

    // -> Check side navigation visibility
    this.handleSideNavVisibility()
    this.resizeHandler = () => {
      // Mobile Chrome can settle its visual viewport without a second window resize.
      if (this.$vuetify.display.width !== window.innerWidth) this.$vuetify.display.update()
      this.handleSideNavVisibility()
      this.ensureActiveTocVisible()
    }
    window.addEventListener('resize', this.resizeHandler)
    window.visualViewport?.addEventListener('resize', this.resizeHandler)

    this.setupTocResizeObserver()

    this.refreshPageContent()
    this.setupTocResizeObserver()
    const offlinePageId = this.pageId
    const offlineLocale = this.locale
    void this.recordOfflineReaderVisit().then(() => {
      if (this.offlineDisposed || this.pageId !== offlinePageId || this.locale !== offlineLocale) return
      // A save or remove started during the visit owns the next refresh.
      if (this.offlineOwnedOperationId !== null) {
        this.offlinePassiveRefreshPending = true
        return
      }
      this.offlinePassiveRefreshPending = false
      void this.refreshOfflinePageState()
    })
    this.$nextTick(() => {
      this.setupTocResizeObserver()
      this.ensureActiveTocVisible()
    })


    this.beforePrintHandler = () => this.preparePrintView()
    this.afterPrintHandler = () => this.restorePrintView()
    window.addEventListener('beforeprint', this.beforePrintHandler)
    window.addEventListener('afterprint', this.afterPrintHandler)

    // -> Handle anchor scrolling
    if (window.location.hash && window.location.hash.length > 1 && !/^#(?:discussion$|comment-post-id-)/u.test(window.location.hash)) {
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
    if (this.publicationTimer !== null) clearTimeout(this.publicationTimer)
    this.publicationTimer = null
    this.invalidateAccuracy()
    if (this.accuracyVisibilityHandler) document.removeEventListener('visibilitychange', this.accuracyVisibilityHandler)
    offReaderPageActionsRequest(this.provideReaderPageActions)
    offReaderPageAction(this.runReaderPageAction)
    this.offlineDisposed = true
    this.readingDockObserver?.disconnect()
    this.readingDockObserver = null
    this.readingDockNode = null
    this.readerActionReturnFocus = null
    this.readerActionReturnPage = null
    emitReaderPageActionsChanged()
    this.annotationJumpUnsubscribe?.()
    if (this.approvalReviewerTimer !== null) clearTimeout(this.approvalReviewerTimer)
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
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler)
      window.visualViewport?.removeEventListener('resize', this.resizeHandler)
    }
    if (this.loadHandler) window.removeEventListener('load', this.loadHandler)
    if (this.beforePrintHandler) window.removeEventListener('beforeprint', this.beforePrintHandler)
    if (this.afterPrintHandler) window.removeEventListener('afterprint', this.afterPrintHandler)
    this.retirePageOutline()
    this.restoreLeadingTitle()
    this.readingContentNode = null
    this.readingContentAuthority = null
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
    refreshPublicationClock (): void {
      if (this.publicationTimer !== null) clearTimeout(this.publicationTimer)
      this.publicationTimer = null
      this.publicationClock = Date.now()
      if (this.offlineDisposed || !this.effectiveIsPublished) return
      const end = publicationBoundaryTimestamp(this.publishEndDate)
      if (end === null || !Number.isFinite(end) || end < this.publicationClock) return
      this.publicationTimer = setTimeout(() => {
        this.publicationTimer = null
        this.refreshPublicationClock()
      }, Math.max(1, Math.min(60_000, end - this.publicationClock + 1)))
    },
    invalidateAccuracy (): void {
      this.accuracyRequestId += 1
      this.accuracyReadyKey = ''
      this.accuracyView = null
      this.accuracyError = ''
      if (this.accuracyTimer !== null) clearTimeout(this.accuracyTimer)
      this.accuracyTimer = null
    },
    acceptAccuracy (view: PageAccuracyView, key: string): void {
      this.accuracyView = view
      this.accuracyReadyKey = key
      if (this.accuracyTimer !== null) clearTimeout(this.accuracyTimer)
      // Re-read at the exact server-age boundary; never promote cached truth
      // using a browser clock. The short lease also refreshes write authority.
      const stamp = view.latestAttestation
      const age = stamp ? Date.parse(view.asOf) - Date.parse(stamp.verifiedAt) : NaN
      const boundary = age >= 0 && age < 30 * PAGE_ACCURACY_DAY_MS
        ? 30 * PAGE_ACCURACY_DAY_MS - age
        : age >= 0 && age <= 90 * PAGE_ACCURACY_DAY_MS ? 90 * PAGE_ACCURACY_DAY_MS - age + 1 : 60_000
      this.accuracyTimer = setTimeout(() => {
        this.invalidateAccuracy()
        void this.loadAccuracy()
      }, Math.max(1, Math.min(60_000, boundary)))
    },
    async loadAccuracy (): Promise<void> {
      if (this.offlineDisposed || this.accuracyPending || this.printView || this.navigationPending ||
        !this.readerPageActionsState.ready || !this.pageTransportVerified ||
        wikiStore.authRefreshPending || !wikiStore.authRefreshSettled ||
        (this.visibility === 'private' && !this.pageAuthorizationFresh)) return
      const key = this.accuracyContextKey
      const request = ++this.accuracyRequestId
      this.accuracyReadyKey = ''
      try {
        const page = await fetchPage(fetch, this.pageId, this.$t('common:page.accuracyReadFailed'))
        if (this.offlineDisposed || key !== this.accuracyContextKey || request !== this.accuracyRequestId) return
        if (page.sourceRevision !== this.sourceRevision) {
          this.accuracyReviewRequired = true
          return
        }
        const parsed = PageAccuracyViewSchema.safeParse(page.accuracy)
        if (!parsed.success || parsed.data.sourceRevision !== this.sourceRevision ||
          (parsed.data.latestAttestation && parsed.data.latestAttestation.pageId !== this.pageId)) throw new Error(this.$t('common:page.accuracyReadFailed'))
        this.accuracyError = ''
        this.acceptAccuracy(parsed.data, key)
      } catch {
        if (key === this.accuracyContextKey && request === this.accuracyRequestId) {
          this.accuracyError = this.$t('common:page.accuracyReadFailed')
        }
      }
    },
    async verifyAccuracy (): Promise<void> {
      if (!this.accuracyActionReady || this.accuracyPending) return
      const key = this.accuracyContextKey
      const request = ++this.accuracyRequestId
      const pageId = this.pageId
      const expectedSourceRevision = this.sourceRevision
      const mutation = ++this.accuracyMutationId
      this.accuracyPending = true
      this.accuracyError = ''
      if (this.accuracyTimer !== null) clearTimeout(this.accuracyTimer)
      this.accuracyTimer = null
      try {
        const view = await verifyPageAccuracy(fetch, pageId, { expectedSourceRevision }, this.$t('common:page.accuracyVerifyFailed'))
        if (this.offlineDisposed || key !== this.accuracyContextKey || request !== this.accuracyRequestId || !this.pageOnlineActionReady) return
        this.acceptAccuracy(view, key)
      } catch {
        if (this.offlineDisposed || key !== this.accuracyContextKey || request !== this.accuracyRequestId) return
        this.accuracyReadyKey = ''
        this.accuracyView = null
        this.accuracyError = this.$t('common:page.accuracyVerifyFailed')
        // A rejected action is never replayed. Review the current server read;
        // a changed revision requires navigation before another deliberate click.
        this.accuracyPending = false
        await this.loadAccuracy()
        if (key === this.accuracyContextKey && mutation === this.accuracyMutationId) this.accuracyError = this.$t('common:page.accuracyVerifyFailed')
      } finally {
        if (mutation === this.accuracyMutationId) {
          this.accuracyPending = false
          if (key !== this.accuracyContextKey && !this.offlineDisposed) void this.loadAccuracy()
        }
      }
    },
    observeReadingDock (): void {
      if (this.offlineDisposed) return
      const node = this.readerDockVisible ? this.$refs.readingDock : null
      if (node === this.readingDockNode) {
        this.updateReadingDockClearance()
        return
      }
      this.readingDockObserver?.disconnect()
      this.readingDockObserver = null
      this.readingDockNode = null
      this.readingDockHeight = 0
      if (!(node instanceof HTMLElement)) {
        (this.$el as HTMLElement).style.removeProperty('--page-reading-dock-height')
        return
      }
      this.readingDockNode = node
      this.updateReadingDockClearance()
      this.readingDockObserver = new ResizeObserver(this.updateReadingDockClearance)
      this.readingDockObserver.observe(node)
    },
    updateReadingDockClearance (): void {
      const node = this.readingDockNode
      if (this.offlineDisposed || !node?.isConnected) return
      const height = Math.ceil(node.getBoundingClientRect().height)
      if (height === this.readingDockHeight) return
      this.readingDockHeight = height
      ;(this.$el as HTMLElement).style.setProperty('--page-reading-dock-height', `${height}px`)
    },
    provideReaderPageActions (request: ReaderPageActionsRequest): void {
      if (sameReaderPageIdentity(request.page, this.readerPageIdentity)) request.reply(this.readerPageActionsState)
    },
    runReaderPageAction (request: ReaderPageActionRequest): void {
      const state = this.readerPageActionsState
      const action = state.actions[request.action]
      if (!state.ready || !sameReaderPageIdentity(request.page, state.page) || !action?.visible || !action.enabled) return
      if (request.action === 'print') { this.print(); return }
      if (request.action === 'fullWidth') { this.readerFullWidth = !this.readerFullWidth; return }
      if (request.action === 'watch') { void this.togglePageWatch(); return }
      this.readerActionReturnFocus = request.returnFocusTo
      this.readerActionReturnPage = state.page
      if (request.action === 'watchSettings') this.openPageWatchSettings()
      else if (request.action === 'approval') this.openApprovalWorkflow()
      else if (request.action === 'protection') this.openPageProtection()
    },
    handleShareMenuKeydown (event: KeyboardEvent): void {
      if (event.isComposing || event.defaultPrevented) return
      const trigger = (this.$el as HTMLElement).querySelector<HTMLElement>('[data-reader-share-trigger]')
      if (!trigger) return
      if (event.key === 'Escape' && this.shareMenuOpen) {
        event.preventDefault()
        event.stopImmediatePropagation()
        this.shareMenuOpen = false
        trigger.focus({ preventScroll: true })
        return
      }
      if (event.currentTarget !== trigger || this.shareMenuOpen ||
        (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
      event.preventDefault()
      event.stopImmediatePropagation()
      this.shareMenuOpen = true
      const focusLast = event.key === 'ArrowUp'
      let target: HTMLElement | null = null
      let attempts = 0
      const focusWhenReady = (): void => {
        if (!this.shareMenuOpen || this.offlineDisposed || !trigger.isConnected ||
          document.activeElement !== trigger) return
        if (!target) {
          const overlayId = trigger.getAttribute('aria-controls')
          const controls = overlayId
            ? document.getElementById(overlayId)?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled), a[href]')
            : null
          target = (focusLast ? controls?.[controls.length - 1] : controls?.[0]) ?? null
        }
        target?.focus({ preventScroll: true })
        // Connected menus reject focus until positioned; match VMenu's bounded settling.
        if (document.activeElement !== target && ++attempts <= 10) requestAnimationFrame(focusWhenReady)
      }
      void this.$nextTick(focusWhenReady)
    },
    openPageWatchSettings (event?: MouseEvent): void {
      if (!this.pageWatched) return
      if (event?.currentTarget instanceof HTMLElement) {
        this.readerActionReturnFocus = event.currentTarget
        this.readerActionReturnPage = this.readerPageIdentity
      }
      this.pageWatchSettingsOpen = true
    },
    restoreReaderActionFocus (): void {
      if (this.pageWatchSettingsOpen || this.approvalDialog || this.protectionDialog) return
      const target = this.readerActionReturnFocus
      const page = this.readerActionReturnPage
      this.readerActionReturnFocus = null
      this.readerActionReturnPage = null
      if (page && sameReaderPageIdentity(page, this.readerPageIdentity) &&
        target?.isConnected && target.getClientRects().length > 0 && !target.matches(':disabled,[aria-disabled="true"]')) {
        target.focus({ preventScroll: true })
      }
    },
    tagColor (canonicalTag: string): string {
      return tagColorBucket(canonicalTag)
    },
    pageBrandingImageError (identity: string): void {
      if (identity === this.pageBrandingIdentity) this.brandingFailureIdentity = identity
    },
    async toggleReaderFocus(): Promise<void> {
      const page = this.readerPageIdentity
      const authority = this.readingReaderAuthority
      const originalFocus = document.activeElement
      const container = this.$refs.container as HTMLElement
      const headerBottom = document.querySelector('.nav-header')?.getBoundingClientRect().bottom ?? 64
      const blocks = Array.from(container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, p, li, summary, pre, table'))
        .filter(element => element.checkVisibility())
        .map(element => ({ element, bounds: element.getBoundingClientRect() }))
        .filter(({ bounds }) => bounds.height > 0 && bounds.bottom > headerBottom && bounds.top < window.innerHeight)
      const anchor = (blocks.find(({ bounds }) => bounds.top >= headerBottom) ?? blocks[0])?.element ?? container
      const previousTop = anchor?.getBoundingClientRect().top
      const previousScrollY = window.scrollY
      this.closeReaderSections()
      this.readerFocus = !this.readerFocus
      await this.$nextTick()
      this.cancelScheduledScroll()
      this.scrollAnimationFrame = requestAnimationFrame(() => {
        this.scrollAnimationFrame = null
        if (this.offlineDisposed || !sameReaderPageIdentity(page, this.readerPageIdentity) ||
          authority !== this.readingReaderAuthority ||
          (document.activeElement !== originalFocus && !(originalFocus instanceof HTMLElement &&
            !originalFocus.isConnected && document.activeElement === document.body))) return
        if (previousScrollY > 0 && anchor && previousTop !== undefined) window.scrollBy(0, anchor.getBoundingClientRect().top - previousTop)
        if (!this.readerFocus && !this.offlineDisposed && this.selectedPageView === 'article' &&
          !document.querySelector('.v-overlay--active')) {
          const target = this.$el.querySelector('.page-focus-control') as HTMLElement | null
          target?.focus({ preventScroll: true })
        }
      })
    },
    async toggleReaderSections(): Promise<void> {
      if (this.readerSectionsOpen) {
        this.closeReaderSections(true)
        return
      }
      if (!this.readerSectionsAvailable) return
      this.readerSectionsOpen = true
      await this.$nextTick()
      if (!this.readerSectionsOpen) return
      this.setupTocResizeObserver()
      this.ensureActiveTocVisible()
      const panel = this.$refs.readerSections as HTMLElement
      const target = panel.querySelector<HTMLElement>('.page-toc-filter input, .page-toc-item[aria-current="location"]')
        ?? panel.querySelector<HTMLElement>('.page-toc-item--descendant-active')
        ?? panel.querySelector<HTMLElement>('.page-toc-item')
        ?? panel.querySelector<HTMLElement>('button')
      target?.focus({ preventScroll: true })
    },
    closeReaderSections(restoreFocus = false): void {
      if (!this.readerSectionsOpen) return
      this.readerSectionsOpen = false
      if (restoreFocus) {
        this.$nextTick(() => {
          const target = this.$el.querySelector('.page-reading-sections-toggle, .page-reading-exit') as HTMLElement | null
          target?.focus({ preventScroll: true })
        })
      }
    },
    readerSectionsEscape(event: KeyboardEvent): void {
      if (event.isComposing || event.defaultPrevented) return
      if (this.readerSectionsOpen) {
        event.preventDefault()
        event.stopPropagation()
        this.closeReaderSections(true)
      } else if (this.readerDockVisible && !document.querySelector('.v-overlay--active')) {
        event.preventDefault()
        event.stopPropagation()
        void this.toggleReaderFocus()
      }
    },
    moveReaderSection(direction: -1 | 1): void {
      if (!this.readerSectionsAvailable) return
      const destination = this.tocFlattened[this.readerSectionIndex + direction]
      if (!destination) return
      this.closeReaderSections()
      this.scrollToPageAnchor(destination.anchor)
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
      if (!service?.readOfflinePolicy) throw new Error(this.$t('common:page.offlinePrivatePolicyLocked'))
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
      if (!service?.readSnapshotCorpus) throw new Error(this.$t('common:page.offlinePrivatePolicyLocked'))
      return await service.readSnapshotCorpus(selector)
    },
    async setOfflineManualIntent (storage: OfflineStorage, selector: OfflineSnapshotSelector, selected: boolean, policy: OfflinePolicySnapshot): Promise<OfflinePagePolicyRecord> {
      if (this.offlinePrivatePath) {
        const service = this.offlineAccountAwareService()
        if (!service?.setManualOfflineIntent) throw new Error(this.$t('common:page.offlinePrivatePolicyLocked'))
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
        throw new Error(this.$t('common:page.offlinePrivatePolicyLocked'))
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
    async refreshOfflinePageState (preserveLockedAccess = false): Promise<void> {
      if (this.offlineDisposed) return
      const pageId = this.pageId
      const locale = this.locale
      const operationId = ++this.offlineOperationId
      const privateHandle = this.offlinePrivatePath ? this.offlinePrivateHandle() : null
      const retainLocked = preserveLockedAccess && this.offlinePrivatePath && !privateHandle &&
        this.offlineState === 'locked' && this.offlineAccessState === 'locked'
      if (!retainLocked) {
        this.offlineState = 'checking'
        this.offlineAccessState = null
      }
      this.offlineAvailabilityError = ''
      this.offlinePolicy = null
      this.offlineHasSnapshot = false
      this.offlineSnapshotRevision = ''
      this.offlineExpiresAt = null
      if (!retainLocked) this.offlineGeneration = null
      this.offlinePolicyRevision = null
      if (this.offlinePrivatePath && !privateHandle) {
        try {
          const storage = await this.offlineStorageForOperation(operationId)
          if (!storage || !this.isCurrentOfflineOperation(operationId, pageId)) return
          const vault = await storage.getReadingVault()
          if (!this.isCurrentOfflineOperation(operationId, pageId)) return
          this.offlineAccessState = vault ? 'locked' : 'setup-required'
          this.offlineGeneration = vault?.sessionGeneration ?? null
          this.offlineState = this.offlineAccessState
        } catch {
          if (!this.isCurrentOfflineOperation(operationId, pageId)) return
          this.offlineAccessState = null
          this.offlineGeneration = null
          this.offlineState = 'unavailable'
          this.offlineAvailabilityError = this.$t('common:page.privateOfflineReadingUnavailable')
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
          if (refreshFailed) this.offlineAvailabilityError = this.$t('common:page.latestOfflineSyncAttempt')
        } else if (pagePolicy?.availability === 'transient-failure') {
          this.offlineState = 'error'
          this.offlineAvailabilityError = this.$t('common:page.latestOfflineSyncAttempt')
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
          ? this.$t('common:page.waitingForConnection')
          : this.offlinePrivatePath
            ? [403, 404, 410, 422].includes(status)
              ? this.$t('common:page.privatePageNotAvailable')
              : this.$t('common:page.privateOfflineAvailabilityCould')
            : getErrorMessage(error) || this.$t('common:page.offlineAvailabilityCouldNot')
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
      this.offlinePassiveOperationId = operationId
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
              : Promise.reject(new Error(this.$t('common:page.offlinePrivatePolicyLocked'))))
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
            : createOfflineSyncUnavailableResult(this.$t('common:page.offlineSynchronizationUnavailable')))
          if (!this.isCurrentOfflineOperation(operationId, pageId)) return
        }
      } catch {
        // Visit recording is opportunistic and must never block page reading.
      } finally {
        if (this.offlineOwnedOperationId === operationId) this.offlineOwnedOperationId = null
        if (this.offlinePassiveOperationId === operationId) this.offlinePassiveOperationId = null
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
          message: this.$t('common:page.offlineAdmissionCouldNot'),
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
          : createOfflineSyncUnavailableResult(this.$t('common:page.offlineSynchronizationUnavailable'))
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
            ? this.$t('common:page.pageNotAvailableOffline')
            : this.offlineAvailabilityError || this.$t('common:page.readableOfflineCopyCould')
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
          ? this.$t('common:page.pageSelectedOfflineSync')
          : this.$t('common:page.pageSelectedOfflineSync2')
        let notification = message
        if (syncResult.outcome === 'offline')
          notification += ` ${this.$t('common:page.localSynchronizationWillResume')}`
        showNotification(wikiStore, {
          style: 'success',
          message: notification
        })
        const aggregateNotice = offlineSyncAggregateNotice(this.$t, syncResult)
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
            ? this.$t('common:page.offlineSynchronizationCouldNot')
            : this.$t('common:page.offlineSelectionCouldNot')
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
            ? this.$t('common:page.pageNotAvailableOffline')
            : this.offlineAvailabilityError || this.$t('common:page.readableOfflineCopyCould')
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
            ? this.$t('common:page.pageSelectedOfflineSync')
            : this.$t('common:page.pageSelectedOfflineSync2')
        })
        showNotification(wikiStore, {
          style: 'warning',
          message: offlineSyncFailureNotice(this.$t, detail),
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
          : createOfflineSyncUnavailableResult(this.$t('common:page.offlineSynchronizationUnavailable'))
        if (!isCurrentOperation()) return
        authoritativeRefreshOperationId = this.offlineOperationId + 1
        this.offlinePassiveRefreshPending = false
        await this.refreshOfflinePageState()
        if (!isCurrentPage() || this.offlineOperationId !== authoritativeRefreshOperationId) return

        const refreshedOfflineState = widenOfflinePageState(this.offlineState)
        const pageFailed = ['stale', 'sync-pending', 'error', 'unavailable'].includes(refreshedOfflineState)
        const message = syncResult.outcome === 'offline'
          ? this.$t('common:page.offlineCopyRemovedPage')
          : this.$t('common:page.offlineCopyRemovedPage2')
        showNotification(wikiStore, {
          style: 'success',
          message
        })
        if (pageFailed) {
          this.offlineAvailabilityError = this.offlineAvailabilityError || this.$t('common:page.currentOfflineRemovalState')
          showNotification(wikiStore, {
            style: 'red',
            message: this.offlineAvailabilityError,
            icon: 'alert'
          })
          this.offlinePassiveRefreshPending = false
          return
        }
        const aggregateNotice = offlineSyncAggregateNotice(this.$t, syncResult)
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
            ? this.$t('common:page.offlineSynchronizationCouldNot')
            : this.$t('common:page.offlineCopyCouldNot')
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
          message: this.$t('common:page.offlineCopyRemovedPage2')
        })
        if (pageFailed) {
          this.offlineAvailabilityError = this.offlineAvailabilityError || this.$t('common:page.currentOfflineRemovalState')
          showNotification(wikiStore, {
            style: 'red',
            message: this.offlineAvailabilityError,
            icon: 'alert'
          })
        } else {
          showNotification(wikiStore, {
            style: 'warning',
            message: offlineSyncFailureNotice(this.$t, detail),
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
        this.offlineUnlockError = this.$t('common:page.privateOfflineVaultCould')
      } finally {
        secret?.fill(0)
        this.offlineUnlockBusy = false
      }
    },
    async toggleOfflinePage (): Promise<void> {
      const { action, blocked } = this.offlineControl
      // aria-disabled keeps the control focusable so its tooltip can explain why it does nothing.
      if (blocked) return
      if (action === 'setup') {
        window.location.assign('/p/offline')
        return
      }
      if (action === 'unlock') {
        this.offlineUnlockError = ''
        this.offlineUnlockOpen = true
        return
      }
      // The toggle acts the same for manual, automatic, and tag selections: removal
      // excludes the page from automatic saving and frees its automatic slot.
      if (action === 'remove') await this.removeOfflinePage()
      else if (action === 'save') await this.updateOfflinePage(true)
    },
    resetPageRouteState(): void {
      this.restoreLeadingTitle()
      this.readerActionReturnFocus = null
      this.readerActionReturnPage = null
      this.pageWatchSettingsOpen = false
      this.readerFullWidth = false
      this.shareMenuOpen = false
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
      this.retirePageOutline()
      this.cancelScheduledScroll()
      this.tocExpanded = false
      this.closeReaderSections()
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
    restoreLeadingTitle(): void {
      const previous = this.leadingTitle
      if (!previous) return
      previous.heading.hidden = false
      if (previous.id) previous.heading.id = previous.id
      previous.alias.removeAttribute('id')
      this.leadingTitle = null
    },
    syncLeadingTitle(): void {
      const container = this.$refs.container as HTMLElement | undefined
      const alias = this.$refs.pageTitleText as HTMLElement | undefined
      if (!container || !alias) return
      let heading = nextReaderContent(container.firstChild)
      // Server slots have one marked transport; SPA navigation adds one more.
      // Bound the depth so an authored nested container is never crossed.
      for (let layers = this.navigationKey > 0 ? 2 : 1;
        layers > 0 && heading instanceof HTMLElement && heading.tagName === 'DIV' &&
        heading.classList.contains('wiki-page-rendered-contents') && !nextReaderContent(heading.nextSibling);
        layers--) {
        heading = nextReaderContent(heading.firstChild)
      }
      let matches = this.editor === 'markdown' && heading instanceof HTMLElement && heading.tagName === 'H1'
      if (matches) {
        const element = heading as HTMLElement
        const title = normalizeReaderTitle(this.title)
        const text = title && (!element.hidden || this.leadingTitle?.heading === element) ? readerHeadingText(element) : null
        matches = text !== null && normalizeReaderTitle(text) === title
      }
      if (matches && this.leadingTitle?.heading === heading) return
      this.restoreLeadingTitle()
      if (!matches) return
      const element = heading as HTMLElement
      const id = element.id
      // Preserve the original fragment on the visible title, not an empty target.
      if (id) alias.id = id
      element.removeAttribute('id')
      if (element.contains(container.ownerDocument.activeElement)) this.focusPageTitle()
      element.hidden = true
      this.leadingTitle = markRaw({ heading: element, id, alias })
    },
    retirePageOutline (invalidateScope = false): void {
      this.readingOutlineEpoch += 1
      if (invalidateScope) this.outlineCleanup?.setReadingProgressScope(null)
      this.outlineCleanup?.dispose()
      this.outlineCleanup = null
      this.measuredReading = { status: 'disabled', progress: 0, sections: [], completedAnchors: [] }
    },
    refreshReadingChromeGeometry (): void {
      this.outlineCleanup?.refresh()
      this.updateReadingDockClearance()
    },
    setupPageOutline (): void {
      const container = this.$refs.container
      if (this.offlineDisposed || !(container instanceof HTMLElement) || !container.isConnected) return
      if (this.readingContentNode !== container || this.readingAdmittedContentKey !== this.readingContentKey) {
        this.readingContentNode = container
        this.readingAdmittedContentKey = this.readingContentKey
        this.readingContentAuthority = null
      }
      // Initial auth may settle after mount. Bind once, never re-admit an old
      // private DOM to a changed account/membership without a new content epoch.
      if (this.readingContentAuthority === null && this.readingReaderAuthority) {
        this.readingContentAuthority = this.readingReaderAuthority
      }
      if (this.outlineCleanup) {
        this.outlineCleanup.refresh()
        return
      }
      const epoch = this.readingOutlineEpoch
      this.outlineCleanup = markRaw(trackPageOutline(container, this.tocFlattened, anchor => {
        if (epoch !== this.readingOutlineEpoch) return
        this.activeAnchor = anchor
        this.$nextTick(() => this.ensureActiveTocVisible())
      }, progress => {
        if (epoch === this.readingOutlineEpoch) this.readingProgress = progress
      }, {
        scope: this.readingProgressScope,
        onChange: state => {
          if (epoch === this.readingOutlineEpoch) this.measuredReading = state
        }
      }))
    },
    retireReaderCitedCopy (): void {
      this.readerCitedCopyCleanup?.()
      this.readerCitedCopyCleanup = null
    },
    setupReaderCitedCopy (): void {
      this.retireReaderCitedCopy()
      const container = this.$refs.container
      if (this.offlineDisposed || this.navigationPending || this.printView ||
        this.selectedPageView !== 'article' || !(container instanceof HTMLElement) || !container.isConnected) return
      const identity = this.readerCitedCopyContextKey
      this.readerCitedCopyCleanup = hydrateReaderCitedCopy(container, {
        appContext: this.$.appContext,
        identity,
        hintIdPrefix: this.readerCitedCopyHintPrefix,
        source: () => this.readerCitedCopySource,
        isCurrent: () => !this.offlineDisposed && !this.navigationPending && !this.printView &&
          this.selectedPageView === 'article' && identity === this.readerCitedCopyContextKey &&
          this.$refs.container === container,
        unavailable: this.$t('common:readerCitedCopy.unavailable')
      })
    },
    refreshPageContent(): void {
      const container = this.$refs.container as HTMLElement
      this.cancelScheduledScroll()
      this.retireReaderCitedCopy()
      this.retirePageOutline()
      this.syncLeadingTitle()
      this.readerContentRoot = container
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
        this.$t,
        container,
        this.$vuetify.theme.current.dark ? 'dark' : 'default',
        mermaidController.signal,
        () => this.mermaidAbortController === mermaidController,
        mermaidHosts
      )

      const currentPageUrl = window.location.href.replace(window.location.hash, '')
      container.querySelectorAll<HTMLAnchorElement>(`a[href^="#"], a[href^="${currentPageUrl}#"]`).forEach(anchor => {
        if (/^#(?:discussion$|comment-post-id-)/u.test(anchor.hash)) return
        anchor.onclick = (event: MouseEvent) => {
          event.preventDefault()
          event.stopPropagation()
          this.scrollToPageAnchor(anchor.hash)
        }
      })
      this.contentExtensionCleanup?.()
      const extensionCleanup = hydrateContentExtensions(container, undefined, { mermaidHosts })
      this.contentExtensionCleanup = () => {
        this.retireReaderCitedCopy()
        extensionCleanup()
      }
      this.setupPageOutline()
      this.setupReaderCitedCopy()
      this.setupTocResizeObserver()
      boot.notify('page-ready')
    },
    animatePageRoute(): void {
      this.routeAnimationAbortController?.abort()
      this.routeAnimationAbortController = null
      const contentRef = this.$refs.content as HTMLElement | { $el?: unknown } | undefined
      const element = contentRef instanceof HTMLElement
        ? contentRef
        : contentRef?.$el instanceof HTMLElement
          ? contentRef.$el
          : null
      if (!element) return
      element.classList.remove('page-main--route-enter')
      if (!this.pageTransitions || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      const controller = markRaw(new AbortController())
      this.routeAnimationAbortController = controller
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
      this.closeReaderSections()
      if (this.isTocCompact) this.tocExpanded = false
      this.activeAnchor = anchor
      this.scrollToPageAnchor(anchor)
    },
    pageScrollTarget (destination: HTMLElement | null, clamp = true): number {
      if (!destination) return 0
      const styles = window.getComputedStyle(destination)
      const rawLayoutOffset = this.scrollOpts.layout ? parseFloat(styles.getPropertyValue('--v-layout-top')) : 0
      const layoutOffset = Number.isFinite(rawLayoutOffset) ? rawLayoutOffset : 0
      const rawOffset = Number(this.scrollOpts.offset)
      const offset = Number.isFinite(rawOffset) ? rawOffset : 0
      const summaryHeight = this.isTocCompact && !this.readerFocus
        ? document.querySelector('.page-inline-toc .page-toc-summary')?.getBoundingClientRect().height ?? 0
        : 0
      const target = destination.getBoundingClientRect().top + window.scrollY - layoutOffset - summaryHeight + offset
      const scrollingElement = document.scrollingElement ?? document.documentElement
      const maximum = Math.max(0, scrollingElement.scrollHeight - window.innerHeight)
      return clamp ? Math.min(maximum, Math.max(0, target)) : target
    },
    animatePageScroll (target: number, destination: HTMLElement | null, focusDestination: boolean, token: number, navigationFocus = document.activeElement, onComplete?: () => void): void {
      const scrollingElement = document.scrollingElement ?? document.documentElement
      const setScrollTop = (value: number): void => {
        scrollingElement.scrollTop = value
        if (Math.abs(window.scrollY - value) > 0 && typeof window.scrollTo === 'function') window.scrollTo(0, value)
      }
      const finish = (): void => {
        if (token !== this.scrollAnimationToken) return
        this.scrollAnimationFrame = null
        if (focusDestination && destination?.isConnected && document.activeElement === navigationFocus) {
          destination?.setAttribute('tabindex', '-1')
          destination?.focus({ preventScroll: true })
        }
        onComplete?.()
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
      const destination = this.leadingTitle?.id === id
        ? this.$refs.pageTitle as HTMLElement
        : container.id === id
          ? container
          : [...container.querySelectorAll<HTMLElement>('[id]')].find(element => element.id === id) ?? null
      for (let parent = destination?.parentElement; parent && container.contains(parent); parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true
      }
      const view = container.ownerDocument.defaultView
      const token = this.scrollAnimationToken
      const navigationFocus = document.activeElement
      let completed = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let landingScrollY = 0
      let observer: ResizeObserver | null = null
      const isCurrentDestination = (): boolean => this.$refs.container === container && container.isConnected &&
        destination?.isConnected === true && (container.contains(destination) ||
          (this.leadingTitle?.id === id && this.$refs.pageTitle === destination))
      const measureLanding = (): void => {
        if (!completed || token !== this.scrollAnimationToken) return
        if (!destination || !isCurrentDestination()) {
          cleanup()
          return
        }
        const requested = this.pageScrollTarget(destination, false)
        const scrollingElement = document.scrollingElement ?? document.documentElement
        const maximum = Math.max(0, scrollingElement.scrollHeight - window.innerHeight)
        destination.classList.toggle('page-anchor-landing', requested > maximum + 1 || requested < -1)
      }
      const interrupt = (): void => this.cancelScheduledScroll()
      const interruptScroll = (): void => {
        if (Math.abs(window.scrollY - landingScrollY) > 2) interrupt()
      }
      const interruptKey = (event: KeyboardEvent): void => {
        if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ', 'Escape', 'Tab'].includes(event.key)) interrupt()
      }
      const cleanup = (): void => {
        if (this.scrollLandingCleanup !== cleanup) return
        completed = false
        destination?.classList.remove('page-anchor-landing')
        if (timer !== null) clearTimeout(timer)
        observer?.disconnect()
        window.removeEventListener('wheel', interrupt)
        window.removeEventListener('touchstart', interrupt)
        window.removeEventListener('pointerdown', interrupt)
        window.removeEventListener('keydown', interruptKey)
        window.removeEventListener('resize', measureLanding)
        window.removeEventListener('scroll', interruptScroll)
        container.removeEventListener('load', measureLanding, true)
        container.removeEventListener('toggle', measureLanding, true)
        if (this.scrollLandingCleanup === cleanup) this.scrollLandingCleanup = null
      }
      this.scrollLandingCleanup = markRaw(cleanup)
      window.addEventListener('wheel', interrupt, { passive: true })
      window.addEventListener('touchstart', interrupt, { passive: true })
      window.addEventListener('pointerdown', interrupt, { passive: true })
      window.addEventListener('keydown', interruptKey)
      const finishLanding = (): void => {
        if (token !== this.scrollAnimationToken) return
        this.scrollAnimationFrame = requestAnimationFrame(() => {
          if (token !== this.scrollAnimationToken) return
          this.scrollAnimationFrame = null
          if (!isCurrentDestination()) {
            cleanup()
            return
          }
          completed = true
          measureLanding()
          landingScrollY = window.scrollY
          window.addEventListener('scroll', interruptScroll, { passive: true })
          // Layout can settle after disclosure/extension reveal (images, fonts).
          // Observe only this bounded landing window; never create reading intent.
          observer = new ResizeObserver(measureLanding)
          observer.observe(container)
          observer.observe(document.documentElement)
          window.addEventListener('resize', measureLanding)
          container.addEventListener('load', measureLanding, true)
          container.addEventListener('toggle', measureLanding, true)
          timer = setTimeout(cleanup, 1800)
        })
      }
      const reveal = (): void => {
        if (token !== this.scrollAnimationToken) return
        this.scrollAnimationFrame = null
        if (!isCurrentDestination()) {
          cleanup()
          return
        }
        this.animatePageScroll(this.pageScrollTarget(destination), destination, focusDestination, token, navigationFocus, finishLanding)
      }
      if (view) this.scrollAnimationFrame = view.requestAnimationFrame(reveal)
      else reveal()
    },
    cancelScheduledScroll () {
      this.scrollAnimationToken += 1
      this.scrollLandingCleanup?.()
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
      if (this.protectionInitialLoading) return
      this.pageProtectionPassword = ''
      this.protectionInitialLoading = true
      this.protectionError = ''
      this.protectionDialog = true
      void this.loadPageProtection()
    },
    async savePageProtection (): Promise<void> {
      if (this.protectionLoading || !this.pageProtectionActionReady || this.pageProtectionPassword.length < 12) return
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
      // aria-disabled keeps the button focusable for its tooltip; refuse here.
      if (!this.pageOnlineActionReady) return
      this.approvalComment = ''
      this.approvalError = ''
      this.resetApprovalReviewerSearch()
      this.approvalDialog = true
      void this.loadPageApproval()
    },
    resetApprovalReviewerSearch (): void {
      if (this.approvalReviewerTimer !== null) clearTimeout(this.approvalReviewerTimer)
      this.approvalReviewerTimer = null
      this.approvalReviewerSearchSeq += 1
      this.approvalReviewerQuery = ''
      this.approvalReviewerOptions = []
      this.approvalReviewerLoading = false
      this.approvalReviewerSearchFailed = false
    },
    queueApprovalReviewerSearch (query: string): void {
      if (this.approvalReviewerTimer !== null) clearTimeout(this.approvalReviewerTimer)
      this.approvalReviewerTimer = null
      const trimmed = query.trim()
      // Selecting an option writes its label into the search text; keep the list.
      if (trimmed && this.approvalReviewerItems.some(option => option.label === trimmed)) return
      const seq = ++this.approvalReviewerSearchSeq
      if (trimmed.length < 2 || manualReviewerId(trimmed) !== null) {
        this.approvalReviewerOptions = []
        this.approvalReviewerLoading = false
        return
      }
      this.approvalReviewerLoading = true
      this.approvalReviewerTimer = setTimeout(() => {
        this.approvalReviewerTimer = null
        void this.runApprovalReviewerSearch(trimmed, seq)
      }, 250)
    },
    async runApprovalReviewerSearch (query: string, seq: number): Promise<void> {
      const pageId = this.pageId
      try {
        const options = await searchApprovalReviewers({
          fetchImpl: (url, init) => window.fetch(url, init),
          pageId,
          query,
          directory: canSearchReviewerDirectory(wikiStore.user.permissions)
        })
        if (seq !== this.approvalReviewerSearchSeq || pageId !== this.pageId) return
        this.approvalReviewerOptions = options
        this.approvalReviewerSearchFailed = false
      } catch {
        if (seq !== this.approvalReviewerSearchSeq || pageId !== this.pageId) return
        // Fall back to typed user IDs; the server still validates the reviewer.
        this.approvalReviewerOptions = []
        this.approvalReviewerSearchFailed = true
      } finally {
        if (seq === this.approvalReviewerSearchSeq) this.approvalReviewerLoading = false
      }
    },
    approvalReviewerHint (prefix = ''): string {
      const help = this.approvalReviewerSearchFailed
        ? this.$t('common:page.reviewerSearchUnavailable')
        : this.$t('common:page.reviewerSearchHint')
      return prefix ? `${prefix} ${help}` : help
    },
    approvalActorLabel (actorId: number, actorName?: unknown): string {
      if (wikiStore.user.authenticated && actorId === wikiStore.user.id) return this.$t('common:page.reviewerYou')
      const name = typeof actorName === 'string' && actorName.trim() ? actorName.trim() : this.approvalActorNames?.get(actorId)
      return name || this.$t('common:page.reviewerById', { id: actorId })
    },
    formatUpdatedAt (format: 'calendar' | 'LLLL'): string {
      if (!this.updatedAt) return ''
      const time = String(this.$helpers.formatMoment(this.updatedAt, format) ?? '')
      // Name the browser zone when a signed-in reader's account could not load.
      if (!time || wikiStore.authRefreshOutcome !== 'unavailable' || this.$helpers.timeZoneKnown()) return time
      return this.$t('common:dateTime.withZone', { time, zone: this.$helpers.timeZoneLabel(this.updatedAt), defaultValue: '{{time}} ({{zone}})', interpolation: { escapeValue: false } })
    },
    approvalTransitionDate (value: string | number): string {
      const formatted = this.$helpers.formatMoment(value, 'calendar')
      return typeof formatted === 'string' ? formatted : String(formatted ?? '')
    },
    approvalTransitionIso (value: string | number): string | undefined {
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
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
      if ((action === 'approve' || action === 'publish') && this.pageApproval.stale) return
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
      if (this.pageWatchLoading || !this.pageOnlineActionReady) return
      // A stale watch state is reloaded instead of changed; the tooltip says so.
      if (!this.pageWatchAuthorityReady) {
        await this.loadPageWatchState()
        return
      }
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
    async setPageWatchDelivery (field: 'pageWatchEmailEnabled' | 'pageWatchInAppEnabled', value: boolean | null): Promise<void> {
      if (value === null) return
      this[field] = value
      await this.savePageWatchSettings()
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
      if (!this.wideViewport) this.navShown = false
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
    navigationEscape (event: KeyboardEvent): void {
      if (event.defaultPrevented || event.isComposing || this.wideViewport || !this.navigationOpen) return
      event.preventDefault()
      event.stopPropagation()
      this.navShown = false
      this.navigationVisibilityChanged(false)
    },
    navigationVisibilityChanged (shown: boolean) {
      // Drawer resize callbacks can precede the reactive breakpoint cache.
      if (this.readerDockVisible || (shown && this.viewportMedia?.matches)) return
      if (shown) {
        this.$nextTick(() => {
          if (this.readerDockVisible || this.viewportMedia?.matches) return
          document.querySelector<HTMLElement>('#page-navigation-drawer .nav-sidebar button, #page-navigation-drawer .nav-sidebar a')?.focus()
        })
      } else {
        this.$nextTick(() => {
          const focused = document.activeElement
          // A breakpoint or another surface may have already claimed focus.
          if (focused && focused !== document.body && !focused.closest('#page-navigation-drawer')) return
          const navToggle = this.$refs.navToggle as HTMLElement | { $el?: unknown } | undefined
          const element = navToggle instanceof HTMLElement
            ? navToggle
            : navToggle?.$el instanceof HTMLElement
              ? navToggle.$el
              : null
          element?.focus({ preventScroll: true })
        })
      }
    },
    preparePrintView () {
      this.shareMenuOpen = false
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
      const page = this.readerPageIdentity
      const originalFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const fromPageActions = originalFocus?.hasAttribute('data-page-actions-activator')
      this.restorePrintView()
      this.preparePrintView()
      this.$nextTick(() => {
        try {
          window.print()
        } finally {
          // Some native print implementations return without emitting afterprint.
          this.restorePrintView()
          this.$nextTick(() => {
            if (this.offlineDisposed || !sameReaderPageIdentity(page, this.readerPageIdentity)) return
            const target = originalFocus?.isConnected
              ? originalFocus
              : (this.$el as HTMLElement).querySelector<HTMLElement>(fromPageActions ? '[data-page-actions-activator]' : '.page-title')
            if (target?.getClientRects().length && !target.matches(':disabled,[aria-disabled="true"]')) {
              target.focus({ preventScroll: true })
            }
          })
        }
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
      const previousWide = this.wideViewport
      const nextWide = this.viewportMedia?.matches ?? false
      if (nextWide === previousWide) { return }
      const focused = document.activeElement instanceof HTMLElement && document.activeElement.closest('.page-toc-card')
        ? document.activeElement
        : null
      this.wideViewport = nextWide
      if (previousWide && !nextWide) {
        this.tocExpanded = false
      }
      this.navShown = nextWide
      this.$nextTick(() => {
        this.setupTocResizeObserver()
        if (focused?.isConnected) {
          const target = this.isTocCompact && !this.tocExpanded && !this.readerSectionsOpen
            ? document.querySelector<HTMLElement>('.page-toc-toggle')
            : focused
          target?.focus({ preventScroll: true })
        }
      })
    },
    selectPageView(value: unknown): void {
      if (value === 'article' || value === 'talk' || (value === 'links' && this.linksVisible)) this.$emit('update:activeView', value)
    },
    async composePassage(anchor: DiscussionAnnotationAnchor): Promise<void> {
      if (!this.commentsEnabled || this.commentsExternal || !this.commentsPerms.write || !this.pageOnlineActionReady) return
      const pageId = this.pageId
      const authorityKey = this.pageAuthorityKey
      this.goToComments()
      await this.$nextTick()
      if (pageId !== this.pageId || authorityKey !== this.pageAuthorityKey || !this.talkActive || !this.commentsPerms.write || !this.pageOnlineActionReady) return
      composeDiscussionAnnotation(pageId, anchor)
    },
    focusLinks (): void {
      this.$nextTick(() => document.querySelector<HTMLElement>('#page-links')?.focus({ preventScroll: true }))
    },
    goToComments (focusNewComment = false) {
      this.cancelScheduledScroll()
      if (!this.commentsExternal) this.$emit('update:activeView', 'talk')
      this.$nextTick(() => {
        void this.goTo('#discussion', this.scrollOpts)
        if (focusNewComment) document.querySelector<HTMLElement>('#discussion-new')?.focus()
      })
    },
  }
})
</script>

<style lang="scss">
// Static for every motion preference: the dashed boundary carries the cue
// independently of color, with no flash, fade or layout displacement.
.wiki-page .page-anchor-landing {
  outline: 2px dashed var(--wiki-focus-color, var(--wiki-accent-ink));
  outline-offset: 4px;
  background-color: color-mix(in srgb, var(--wiki-accent-warm) 12%, rgb(var(--v-theme-surface)));
  animation: none !important;
  transition: none !important;
}
@media (forced-colors: active) {
  .wiki-page .page-anchor-landing {
    outline-color: CanvasText;
    background-color: Canvas;
  }
}

// Respect the render-only title suppression even if content heading typography
// supplies an explicit display value. Authored nonmatching headings stay intact.
.wiki-page .contents h1[hidden] {
  display: none !important;
}
.wiki-page .contents h1[hidden] + :is(p, h2, h3, h4, h5, h6) {
  margin-block-start: 0;
}

// Controls are transient siblings, never interactive descendants of <summary>
// or part of the authored block. Reserve icon width without adding prose rows.
.wiki-page .contents .reader-cited-copy-surface {
  position: relative;
  display: flow-root;
  margin-block: var(--wiki-space-6, 1.5rem);
  border-radius: var(--wiki-panel-radius, 12px);

  > :is(details, blockquote, .admonitionblock) { margin-block: 0; }
  > blockquote { padding-inline-end: 3.75rem; }
  > .admonitionblock { padding-inline-end: 3.75rem; }
  > details > summary { padding-inline-end: 3.75rem; }

  .reader-cited-copy-mount {
    position: absolute;
    inset-block-start: 0;
    inset-inline-end: .125rem;
    z-index: 2;
    max-width: calc(100% - 1rem);
    font-family: var(--wiki-font-body);
    font-style: normal;
    font-weight: 400;
    text-align: start;

    &[hidden], [hidden] { display: none !important; }
    .cited-copy-action__button > span { display: none; }
    .cited-copy-action__button {
      width: 44px;
      min-height: 44px;
      padding: .375rem;
      border-color: transparent;
      background: transparent;
      &:disabled { pointer-events: none; }
    }
    .cited-copy-action__receipt:not(:empty),
    .reader-cited-copy-unavailable:not([hidden]) {
      position: absolute;
      inset-block-start: 100%;
      inset-inline-end: 0;
      width: max-content;
      max-width: min(18rem, calc(100vw - 3rem));
      padding: .375rem .625rem;
      border: 1px solid var(--wiki-surface-border);
      border-radius: .375rem;
      color: rgb(var(--v-theme-on-surface));
      background: rgb(var(--v-theme-surface));
      font-size: .8125rem;
      line-height: 1.4;
      overflow-wrap: anywhere;
      box-shadow: var(--wiki-shadow-inset);
    }
    .reader-cited-copy-unavailable { display: none; }
    &:hover .reader-cited-copy-unavailable:not([hidden]),
    &:focus-within .reader-cited-copy-unavailable:not([hidden]) { display: block; }
  }
}

@media (hover: hover) and (pointer: fine) {
  .reader-cited-copy-surface:not(:hover):not(:focus-within) .cited-copy-action[data-copy-state='idle'] .cited-copy-action__button { opacity: 0; }
}
@media print {
  .wiki-page .contents .reader-cited-copy-mount { display: none !important; }
}

.wiki-page {
  --page-toc-empty-height: calc(var(--wiki-grid-size) * 2);
  --page-layout-shell-max: 132rem;
  --page-reader-shell-max: var(--page-layout-shell-max);
  --page-toc-rail-width: 224px;
  --page-reader-column-gap: var(--wiki-space-6);
  --page-reader-inline-gutter: min(var(--wiki-page-gutter), var(--wiki-space-6));
  --page-reader-copy-max: var(--wiki-reader-copy-width, 74ch);
  --page-reader-safe-end: env(safe-area-inset-right, 0px);
  --page-return-top-inset: max(1rem, calc((100vw - var(--wiki-shell-max)) / 2 + 1rem), var(--page-reader-safe-end));

  font-family: var(--wiki-font-body);
}

.wiki-page.is-rtl {
  --page-reader-safe-end: env(safe-area-inset-left, 0px);
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
  gap: .375rem;
  margin-block-end: .625rem;
  color: var(--wiki-text-muted);
  font-size: .6875rem;
  font-weight: 650;
  letter-spacing: .12em;
  text-transform: uppercase;
}

.page-document-label__divider {
  color: var(--wiki-text-subtle);
}


.page-tool-helper {
  margin: var(--wiki-space-2) 0 0;
  color: var(--wiki-text-muted);
  font-size: .75rem;
  line-height: 1.4;
}

.page-document-provenance {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 5px;
  margin-block-start: var(--wiki-space-1);
  color: var(--wiki-text-muted);
  font-size: .75rem;
  line-height: 1.4;
}
.page-updated-history {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  line-height: inherit;
  text-decoration: underline;
  text-underline-offset: .15em;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid var(--wiki-focus-color);
    outline-offset: 2px;
  }

  &:disabled {
    text-decoration: none;
    cursor: default;
  }
}

.page-accuracy { display: inline-flex; position: relative; }
.page-accuracy-pill {
  position: relative;
  box-sizing: border-box;
  block-size: 1lh;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding-inline: 6px;
  padding-block: 0;
  font: inherit;
  line-height: inherit;
  border: 1px solid var(--wiki-surface-border);
  border-radius: 999px;
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-specular-border);
  color: var(--wiki-text-muted);
  cursor: pointer;
  &::after {
    content: '';
    position: absolute;
    inset-inline: 0;
    inset-block-start: 50%;
    block-size: 44px;
    transform: translateY(-50%);
  }
  &--verified-fresh { color: var(--wiki-success-ink); }
  &--review-soon { color: var(--wiki-warning-ink); }
}
.page-accuracy-details {
  box-sizing: border-box;
  width: min(300px, calc(100vw - 24px));
  max-height: calc(100dvh - 24px);
  overflow: auto;
  padding: var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-radius-md);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-md);
  color: rgb(var(--v-theme-on-surface));
  p { margin-block: 0 8px; }
  a { display: block; }
}
.page-accuracy-verify { min-height: 44px; }
.page-accuracy-pill:focus-visible,
.page-accuracy-details :is(button, a):focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
@media (forced-colors: active) {
  .page-accuracy-pill, .page-accuracy-details { color: CanvasText; background: Canvas; border-color: CanvasText; }
  .page-accuracy-verify:disabled { color: GrayText; }
}



.page-offline-status {
  // Full state text for screen readers; sighted users read the tooltip.
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.page-offline-control {
  flex: 0 0 auto;
  transition: color var(--wiki-motion-fast) var(--wiki-motion-ease);

  // One color per meaning. The glyph also changes, so color is never the only cue.
  &--saved { color: var(--wiki-primary-ink) !important; }
  &--warning { color: var(--wiki-warning-ink) !important; }
  &--error { color: var(--wiki-error-ink) !important; }
  &--muted { color: var(--wiki-text-muted) !important; }
  &--action { color: var(--wiki-info-ink) !important; }

  &--blocked {
    cursor: default;
  }
}

.page-offline-tooltip {
  display: grid;
  gap: 2px;
}

.page-offline-tooltip__title {
  font-weight: 650;
}

.page-offline-tooltip__detail {
  font-size: .8125rem;
  line-height: 1.4;
}

@media (prefers-reduced-motion: reduce) {
  .page-offline-control { transition: none; }
}

.page-document-author {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-provenance-author {
  overflow-wrap: anywhere;
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
  color: var(--wiki-text-muted);
  font-family: var(--wiki-font-mono);
  font-size: .6875rem;
}

// Accessible clarification of the section count, hidden visually.
.page-toc-heading .d-sr-only,
.page-toc-toggle .d-sr-only {
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
  color: var(--wiki-text-muted);
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



.page-return-top {
  inset-block-start: auto !important;
  inset-inline-start: auto !important;
  inset-block-end: calc(max(var(--v-layout-bottom, 0px), calc(var(--wiki-footer-height) + env(safe-area-inset-bottom, 0px))) + var(--wiki-grid-size) + 24px) !important;
  inset-inline-end: var(--page-return-top-inset) !important;
  inline-size: 3rem;
  min-inline-size: 3rem;
  block-size: 3rem;
}


.breadcrumbs-nav {
  min-width: 0;
  color: var(--wiki-text-muted);
  font-size: .8125rem;

  :is(.v-breadcrumbs-item, .v-breadcrumbs__item) {
    min-width: 0;
  }

  .v-btn {
    min-width: 0;
    border-radius: var(--wiki-radius-xs);
    font-size: inherit;
    letter-spacing: .01em;

    // The label, not the flex content box, truncates: an ellipsis on a flex
    // container never shows, and centered overflow clipped both ends.
    &__content {
      min-width: 0;
      max-width: 100%;
      text-transform: none;
    }

    &:hover {
      background: color-mix(in srgb, var(--wiki-accent-warm) 8%, transparent);
      color: var(--wiki-accent-ink);
    }
  }

  .breadcrumbs-nav__label {
    display: block;
    min-width: 0;
    max-width: min(24rem, 34vw);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .v-breadcrumbs-divider {
    padding-inline: var(--wiki-space-2);
    color: var(--wiki-text-subtle);
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
  background-color: var(--wiki-surface-raised);
  background-image: var(--wiki-surface-gradient);
  box-shadow: var(--wiki-specular-border), var(--wiki-shadow-xs);
  border-block-end: 1px solid var(--wiki-surface-border);

  &.page-hero--accent-present::before {
    position: absolute;
    inset-block: 0;
    inset-inline-end: 0;
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



// Static state: no pulse, so the indicator does not move while people read.
.page-header-unpublished {
  display: flex;
  flex: 0 1 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--wiki-space-1) var(--wiki-space-2);
  margin-block-start: var(--wiki-space-2);
  min-width: 0;
}

.page-header-unpublished-text {
  color: var(--wiki-text-muted);
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
    grid-template-columns: minmax(0, 1fr);
    grid-auto-rows: auto;
    column-gap: var(--wiki-space-4);
    row-gap: 0;
    align-items: start;
    align-content: start;
    padding:
      var(--wiki-space-4)
      var(--page-reader-inline-gutter) !important;
  }

  > .is-page-header > :is(.page-header-headings, .page-header-summary, .page-document-provenance, .page-header-path, .page-header-unpublished, .page-edit-shortcuts, .page-hero-actions) {
    grid-column: 1 / -1;
    min-width: 0;
  }

  .page-hero-actions {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: var(--wiki-space-2);
    margin-block-start: var(--wiki-space-2);

    .v-btn {
      min-width: 32px;
      min-height: 32px;
      height: 32px;
      padding-block: 0;
      border-color: var(--wiki-surface-border-strong);
      border-radius: var(--wiki-radius-pill);
      text-transform: none;
      letter-spacing: 0;
      color: rgb(var(--v-theme-on-surface));
    }

    .v-btn--icon { width: 32px; }

    .v-btn:focus-visible {
      outline: 2px solid var(--wiki-focus-color);
      outline-offset: 2px;
      box-shadow: var(--wiki-specular-border), var(--wiki-focus-ring);
    }
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
      inset-block-start: calc(var(--wiki-space-2) * -1);
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
    color: var(--wiki-text-muted);
    font-size: 1.0625rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
    text-wrap: pretty;
  }

  .page-edit-shortcuts {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 8px;
    margin-inline-start: auto;
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

}

@media (min-width: 1280px) {
  .page-header-section .page-header-headings--branded {
    --page-branding-mark-size: 128px;
  }

}


// Keep the article and its local controls above the hero backing.
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
    var(--page-reader-inline-gutter)
    var(--wiki-space-12) !important;
}


@media (min-width: 1280px) {
  // The end gutter contains Top, and the optional edit FAB, even in Full width.
  .wiki-page:not(.wiki-page--reading) .page-body {
    padding-inline-end: max(var(--wiki-page-gutter), calc(var(--page-return-top-inset) + 4rem)) !important;
  }
  .wiki-page:not(.wiki-page--reading) .page-main--with-edit-fab .page-body {
    padding-inline-end: max(var(--wiki-page-gutter), calc(var(--page-return-top-inset) + 4rem), calc(var(--wiki-space-5) + var(--wiki-control-height) + var(--wiki-space-3) + 4rem)) !important;
  }
}

.wiki-page--reading .page-body {
  padding-block-end: max(6rem, calc(var(--page-reading-dock-height, 0px) + var(--wiki-footer-height) + env(safe-area-inset-bottom, 0px) + 1rem + 24px)) !important;
}

.page-body > .v-row {
  --v-col-gap-x: 0px;
  --v-col-gap-y: 0px;
  gap: 0;
}

.page-col-sd {
  display: none;
}

.page-metadata {
  order: 3;
  flex: 0 0 100%;
  min-width: 0;
  margin-block-start: var(--wiki-space-6);
}

.page-inline-toc:empty { display: none; }

@media (min-width: 1280px) {
  .page-main--with-rail .page-body > .v-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--page-toc-rail-width);
    column-gap: var(--page-reader-column-gap);
    align-items: start;
  }

  .page-main--with-rail .page-body > .v-row:has(.page-col-sd--toc-left) {
    grid-template-columns: var(--page-toc-rail-width) minmax(0, 1fr);
  }

  .page-col-sd {
    display: block;
    position: sticky;
    inset-block-start: calc(var(--v-layout-top, 56px) + var(--wiki-space-3));
    width: var(--page-toc-rail-width);
    max-width: var(--page-toc-rail-width);
    padding: 0;
    grid-row: 1;
    grid-column: 2;
  }

  .page-col-sd--toc-left { grid-column: 1; }
  .page-col-content--toc-left { grid-column: 2; }
  .page-col-content--toc-right { grid-column: 1; }
  .page-col-content--with-toc { grid-row: 1; }
  .page-metadata { grid-column: 1 / -1; }
  .page-inline-toc { display: none; }

  .page-toc-card {
    max-height: calc(100dvh - var(--v-layout-top, 56px) - var(--wiki-space-6));
  }
}

.page-toc-content,
.page-toc-tree-wrap {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}

.page-toc-content .page-toc-list {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}


// Scalar article position, never earned-reading coverage.
.page-reading-progress {
  position: absolute;
  z-index: 1;
  inset-inline: 0;
  inset-block-start: 0;
  height: 2px;
  overflow: hidden;
  pointer-events: none;
}
.page-reading-progress-fill {
  width: 100%;
  height: 2px;
  background: var(--wiki-accent-warm);
  transform-origin: left;
}
.is-rtl .page-reading-progress-fill { transform-origin: right; }


.page-toc-summary .page-toc-heading-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-toc-card .page-toc-toggle-meta { flex-shrink: 0; }

.page-reading-completed {
  display: inline-flex;
  flex: 0 0 12px;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  border: 1px solid currentColor;
  border-radius: var(--wiki-radius-pill);
  // Muted bronze using palette-safe ink; the check and text carry the meaning.
  background: color-mix(in oklch, var(--wiki-accent-warm) 14%, var(--wiki-surface-raised));
  color: color-mix(in oklch, var(--wiki-accent-ink) 45%, var(--wiki-text-muted));
  font-size: 10px;
  line-height: 1;
}

.page-toc-item--completed {
  gap: var(--wiki-space-1);
  .page-toc-item-title { flex: 1 1 auto; }
}

.page-reading-dock-title > .page-reading-completed {
  margin-inline-end: var(--wiki-space-1);
  vertical-align: middle;
}

.page-toc-card {
  position: relative;
  display: flex;
  min-height: var(--page-toc-empty-height);
  flex-direction: column;
  border: 0 !important;
  border-inline-start: 1px solid var(--wiki-surface-border) !important;
  border-radius: 0;
  background: transparent !important;
  box-shadow: none !important;

  > .page-toc-heading {
    flex: 0 0 auto;
    padding:
      var(--wiki-space-4)
      var(--wiki-space-4)
      var(--wiki-space-2) !important;
    font-family: var(--wiki-font-body);
  }

  .page-toc-heading-label {
    color: var(--wiki-accent-ink);
    font-family: var(--wiki-font-body);
    font-size: .8125rem;
    font-weight: var(--wiki-label-weight) !important;
    letter-spacing: .09em !important;
    text-transform: uppercase;
  }

  .page-toc-toggle-meta {
    display: inline-flex;
    align-items: center;
    gap: var(--wiki-space-2);
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
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
  text-decoration: none;
  transition:
    background-color 180ms var(--wiki-motion-ease),
    border-color 180ms var(--wiki-motion-ease),
    color 180ms var(--wiki-motion-ease);


  &:hover {
    background: color-mix(in srgb, var(--wiki-accent-warm) 8%, transparent);
    color: rgb(var(--v-theme-on-surface));
  }

  &:focus-visible {
    outline: 2px solid var(--wiki-focus-color, var(--wiki-accent-ink));
    outline-offset: 1px;
  }

  &[aria-current='location'],
  &.page-toc-item--active {
    border-inline-start-color: rgb(var(--v-theme-primary));
    background: color-mix(in srgb, var(--wiki-accent-warm) 10%, transparent);
    color: rgb(var(--v-theme-on-surface));
    .page-toc-item-title--depth-0 {
      font-weight: 700;
    }

    .page-toc-item-title--depth-1 {
      font-weight: 600;
    }

    .page-toc-item-title--depth-2-plus {
      font-weight: 500;
    }

  }

  &.page-toc-item--descendant-active {
    border-inline-start-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 40%, transparent);
  }
}

// Nested entries stay visually subordinate to top-level sections.
.page-toc-sublist .page-toc-item {
  color: var(--wiki-text-muted);

  &:hover,
  &[aria-current='location'],
  &.page-toc-item--active {
    color: rgb(var(--v-theme-on-surface));
  }
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

.page-toc-item:is(:hover, :focus-visible, [aria-current='location']) .page-toc-item-title {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  white-space: normal;
  line-height: 1.35;
  overflow-wrap: anywhere;
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


.page-col-content:not(.is-page-header) {
  min-width: 0;
  padding: 0;
}


.page-col-content > .contents {
  --page-reader-surface-padding: var(--wiki-space-3);

  min-height: calc(var(--wiki-grid-size) * 3);
  width: 100%;
  max-inline-size: var(--page-reader-copy-max);
  margin-inline: auto;
  scroll-margin-block-start: calc(var(--v-layout-top, 64px) + 24px);
  padding: var(--page-reader-surface-padding) 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;

  > div {
    width: 100%;
    margin: 0;

  }

  :not(pre) > code {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
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
    overflow-wrap: anywhere;

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
.page-col-content > .contents :where(pre, code) {
  direction: ltr;
  unicode-bidi: isolate;
  text-align: start;
}

.page-view-tabs {
  width: fit-content;
  margin-block-end: var(--wiki-space-5);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-xs);
}

.page-view-tabs ~ .comments-container {
  margin-block-start: 0;
}

.comments-container {
  overflow: hidden;
  margin-block-start: var(--wiki-space-8);
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
  border-block-end: 1px solid var(--wiki-surface-border);
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
  color: var(--wiki-primary-ink);
}

.comments-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 720;
  letter-spacing: -.01em;
}

.comments-subtitle {
  margin-block-start: var(--wiki-space-1);
  color: var(--wiki-text-muted);
  font-size: .8125rem;
}

.page-inline-toc {
  position: sticky;
  inset-block-start: var(--v-layout-top, 56px);
  z-index: 4;
  margin-block-end: var(--wiki-space-1);
}

.page-inline-toc > .page-toc-card {
  min-height: 40px;
  max-height: min(60dvh, 32rem);
  border: 0 !important;
}

@media (max-width: 1279px) {
  .page-body { padding-block-start: var(--wiki-space-2) !important; }

  .page-toc-summary {
    display: flex;
    flex: 0 0 auto;
    min-width: 0;
    min-height: 40px;
    .page-toc-toggle { flex: 1 1 auto; min-width: 0; }
    .page-reading-top { flex: 0 0 40px; min-width: 40px; height: 40px; }
  }
  .page-toc-toggle {
    flex: 0 0 40px;
    height: auto !important;
    min-height: 40px !important;
    padding-inline: var(--wiki-space-3) !important;
    background-color: var(--wiki-surface-raised) !important;
    background-image: var(--wiki-surface-gradient) !important;
    box-shadow: var(--wiki-specular-border), var(--wiki-shadow-xs);
    color: var(--wiki-accent-ink);

    .v-btn__content { width: 100%; justify-content: space-between; white-space: normal; }
    &:focus-visible {
      outline: 2px solid var(--wiki-focus-color);
      outline-offset: -2px;
      box-shadow: var(--wiki-specular-border), var(--wiki-shadow-xs), var(--wiki-focus-ring);
    }
  }

  .page-toc-row, .page-toc-item { min-height: 2.5rem; }
  .page-toc-content .page-toc-list { max-height: 48dvh; }
  .page-col-content > .contents { padding-block-start: 0; }
  .page-header-section > .is-page-header { padding-block: var(--wiki-space-4) var(--wiki-space-3) !important; }
  .page-header-section .page-document-label {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .page-header-section .page-title { font-size: clamp(1.5rem, 1.25rem + 1vw, 2rem); line-height: 1.05; }
  .page-header-section .page-description { font-size: .875rem; line-height: 1.35; }
  .page-header-section .page-document-provenance { margin-block-start: 12px; font-size: .6875rem; line-height: 1.35; }
  .page-header-section .page-hero-actions {
    gap: 8px;
    margin-block-start: var(--wiki-space-2);
    .v-btn { min-width: 32px; min-height: 32px; height: 32px; padding-inline: .5rem; font-size: .75rem; }
  }
  .page-header-section .breadcrumbs-nav .v-btn { min-height: 1.25rem; height: auto; font-size: .6875rem; }
  .page-view-tabs { margin-block-end: var(--wiki-space-1); }
}

@media (max-width: 599px) {
  .breadcrumbs-nav {
    font-size: .75rem;
  }

  // Phones: the current page may use most of the row; parents stay short.
  .breadcrumbs-nav [aria-current='page'] .breadcrumbs-nav__label {
    max-width: calc(100vw - 8rem);
  }

  .page-header-path {
    flex-basis: 100%;
    margin-inline-end: 0;
  }


  .page-hero,
  .page-header-section {
    min-height: 0;
  }

  .page-header-section {

    .page-title {
      font-size: clamp(1.5rem, 1.25rem + 1vw, 1.75rem);
      line-height: 1.05;
    }

    .page-description {
      margin-block-start: var(--wiki-space-1);
      font-size: .875rem;
      line-height: 1.35;
    }
  }


  .page-body {
    padding:
      var(--wiki-space-2)
      var(--page-reader-inline-gutter)
      var(--wiki-space-10) !important;
  }


  .page-col-content > .contents {
    min-height: calc(var(--wiki-grid-size) * 2);
    padding:
      var(--wiki-space-1)
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
    margin-block-start: var(--wiki-space-4);
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

}

@media print {
  .page-navigation,
  .page-header-path,
  .page-edit-shortcuts,
  .page-edit-fab,
  .page-return-top,
  .page-metadata,
  .page-hero-actions,
  .page-col-sd,
  .page-toc-card,
  .page-tags-card,
  .page-comments-card,
  .comments-container {
    display: none !important;
  }
  .page-main--with-rail .page-body > .v-row {
    display: block;
  }

  .page-header-section > .is-page-header {
    grid-template-columns: minmax(0, 1fr);
  }

  .page-header-section > .is-page-header > .page-header-headings {
    grid-column: 1;
    padding-inline-start: 0;
  }

  .page-header-section > .is-page-header > .page-header-summary,
  .page-header-section > .is-page-header > .page-header-unpublished {
    grid-column: 1;
    padding-inline-start: 0;
  }
  .page-document-provenance,
  .page-document-provenance time,
  .page-document-author {
    color: CanvasText;
  }
  .page-document-author {
    overflow: visible;
    white-space: normal;
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
  .page-reading-progress {
    // Preserve a two-pixel data mark using the user's system palette.
    forced-color-adjust: none;
    background: GrayText;
  }
  .page-reading-progress-fill {
    background: Highlight;
  }
  .page-reading-completed {
    border-color: CanvasText;
    background: Canvas;
    color: CanvasText;
  }
  .page-col-content > .contents,
  .page-col-sd > .v-card,
  .comments-container {
    border-color: CanvasText;
    box-shadow: none;
  }
  .page-hero,
  .page-reading-sections,
  .page-toc-card {
    border-color: CanvasText !important;
    background: Canvas !important;
    color: CanvasText;
    box-shadow: none !important;
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

  .page-toc-item::before {
    display: none !important;
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
  .page-header-section .page-edit-shortcuts .v-btn:hover {
    transform: none;
  }
}
.page-navigation-progress {
  position: fixed;
  inset-block-start: 0;
  inset-inline: 0;
  height: 3px;
  z-index: 1010;
  overflow: hidden;
  pointer-events: none;

  &::after {
    content: '';
    display: block;
    width: 100%;
    height: 100%;
    background: rgb(var(--v-theme-primary));
    opacity: .7;
  }
}

@media (prefers-reduced-motion: no-preference) {
  .page-navigation-progress::after {
    animation: page-navigation-pending 1.4s ease-in-out infinite;
  }
}

@keyframes page-navigation-pending {
  0% { transform: translateX(-100%) scaleX(.35); }
  100% { transform: translateX(100%) scaleX(.35); }
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
  background: var(--wiki-accent-warm);
  transform-origin: left;
}

.is-rtl .page-position-fill {
  transform-origin: right;
}



.page-reading-chrome {
  position: fixed;
  inset-block-end: calc(var(--wiki-footer-height) + env(safe-area-inset-bottom) + 1rem);
  inset-inline-start: calc(1rem + env(safe-area-inset-left));
  inset-inline-end: calc(1rem + env(safe-area-inset-right));
  z-index: 1006;
  width: max-content;
  max-width: min(46rem, calc(100vw - 2rem - env(safe-area-inset-left) - env(safe-area-inset-right)));
  margin-inline: auto;
}
.page-reading-chrome::after {
  content: '';
  position: absolute;
  z-index: -1;
  inset-inline: -1rem;
  inset-block-start: 100%;
  height: 36px;
  background:
    linear-gradient(to top, var(--wiki-canvas-bg) 35%, transparent) bottom / 100% 32px no-repeat,
    linear-gradient(to top, var(--wiki-canvas-bg) 40%, transparent);
  pointer-events: none;
}
@media (prefers-reduced-transparency: reduce), (forced-colors: active) {
  .page-reading-chrome::after { background: none; }
}

.page-reading-dock {
  position: relative;
  display: flex;
  align-items: center;
  gap: .5rem;
  width: 100%;
  isolation: isolate;
  padding: .25rem .375rem .25rem .75rem;
  border: var(--wiki-hud-border);
  border-radius: var(--wiki-radius-pill);
  background: var(--wiki-reading-dock-surface) !important;
  color: rgb(var(--v-theme-on-surface));
  box-shadow: var(--wiki-glass-specular), var(--wiki-shadow-md);
  -webkit-backdrop-filter: var(--wiki-hud-filter) !important;
  backdrop-filter: var(--wiki-hud-filter) !important;


  .v-icon,
  .page-reading-dock-title,
  .v-btn {
    opacity: 1;
  }

  .v-btn { flex-shrink: 0; min-height: 36px; height: 36px; color: rgb(var(--v-theme-on-surface)); }
}


.page-reading-dock-context {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: .5rem;
  min-height: 44px;
  align-content: center;
  flex: 1 1 auto;
  min-width: 0;

  > .page-reading-dock-title,
  > .page-reading-dock-meta { grid-column: 1; }

  > .page-reading-dock-top {
    grid-column: 2;
    grid-row: 1 / span 2;
    min-height: 44px;
  }
}

.page-reading-dock-actions {
  display: flex;
  align-items: center;
  gap: .125rem;
  flex: 0 0 auto;
}

.page-reading-dock-meta {
  display: flex;
  gap: .625rem;
  min-width: 0;
  color: var(--wiki-text-muted);
  font-size: .6875rem;
}

.page-reading-dock-position { flex: 0 0 auto; }

.page-reading-dock-document {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-reading-dock-title {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--wiki-font-display);
  font-size: .9375rem;
}

.page-reading-sections {
  position: absolute;
  inset-block-end: calc(100% + var(--wiki-space-2));
  inset-inline: 0;
  display: flex;
  flex-direction: column;
  width: min(26rem, 100%);
  max-height: min(36rem, calc(100dvh - var(--v-layout-top, var(--wiki-grid-size)) - var(--wiki-footer-height) - env(safe-area-inset-bottom) - 10rem));
  margin-inline: auto;
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--wiki-panel-radius);
  background-color: var(--wiki-surface-raised);
  background-image: var(--wiki-surface-gradient);
  box-shadow: var(--wiki-specular-border), var(--wiki-shadow-md);

  > .page-toc-card {
    flex: 1 1 auto;
    min-height: 0;
    max-height: none;
    margin-bottom: 0 !important;
    border: 0 !important;
    border-radius: 0;
  }

  .page-toc-content,
  .page-toc-tree-wrap {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
  }

  .page-toc-filter,
  .page-toc-heading,
  .page-toc-filter-empty {
    flex: 0 0 auto;
  }

  .page-toc-filter .v-field--focused { box-shadow: none; }

  .page-toc-list {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    max-height: none;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
}

.page-reading-sections-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: 0 0 auto;
  gap: var(--wiki-space-2);
  padding-inline: var(--wiki-space-4) var(--wiki-space-2);
  border-bottom: 1px solid var(--wiki-surface-border);
  color: var(--wiki-accent-ink);
  font-family: var(--wiki-font-display);

  h2 { margin: 0; font: inherit; }
}

.wiki-page.wiki-page--reading {
  --page-reader-shell-max: 64rem;
  --page-reader-copy-max: min(72ch, var(--wiki-reader-copy-width, 74ch));

  .page-col-sd,
  .page-inline-toc,
  .page-metadata,
  .page-hero-actions > :not(.page-focus-control),
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
    inset-inline-end: calc((min(100vw, var(--page-layout-shell-max)) - min(100vw, var(--page-reader-shell-max))) / -2);
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

  .page-header-section > .is-page-header > .page-header-summary {
    grid-column: 1;
    padding-inline-start: 0;
  }

  .page-main,
  .page-body { background: var(--page-reader-background); }
}

// A transient view command; it does not change the saved reading measure.
.wiki-page.wiki-page--full-width {
  --page-reader-shell-max: var(--page-layout-shell-max);
  --page-reader-copy-max: 100%;
}

@media (max-width: 599px) {
  .page-reading-chrome {
    width: calc(100vw - 2rem - env(safe-area-inset-left) - env(safe-area-inset-right));
  }

  .page-reading-dock {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: .25rem;
    padding: .5rem .375rem .25rem;
    border-radius: var(--wiki-panel-radius);

    > .v-icon { display: none; }
    .v-btn { min-height: 44px; height: 44px; }
    .page-reading-previous,
    .page-reading-next { width: 44px; }
    .page-reading-exit .v-btn__prepend { display: none; }
  }

  .page-reading-dock-context { padding-inline: .375rem; }
  .page-reading-dock-document { display: none; }

  .page-reading-dock-actions {
    display: grid;
    grid-template-columns: 44px 44px minmax(0, 1fr) minmax(0, 1fr);


    &:not(:has(.page-reading-sections-toggle)) { grid-template-columns: minmax(0, 1fr); }

    .v-btn {
      min-width: 0;
      padding-inline: .25rem;
      font-size: .6875rem;
      white-space: normal;
    }
  }

  .page-reading-sections-header .v-btn { min-width: 44px; min-height: 44px; }
}

@media (pointer: coarse) {
  .page-header-section .page-hero-actions .v-btn {
    min-width: 44px;
    min-height: 44px;
    height: 44px;
  }
  .page-header-section .page-hero-actions .v-btn--icon { width: 44px; }
  .page-updated-history { min-height: 44px; }
}

@media (pointer: coarse) and (max-width: 1279px) {
  // Keep real touch targets without restoring the retired above-prose stack.
  .page-header-section > .is-page-header { padding-block: var(--wiki-space-4) var(--wiki-space-3) !important; }
  .page-body { padding-block-start: 2px !important; }
  .page-inline-toc { margin-block-end: 2px; }
  .page-view-tabs { margin-block-end: 0; }
  .page-col-content > .contents { padding-block-start: 0; }
}
.wiki-page--inline-outline:not(.wiki-page--reading) .page-inline-toc {
  display: block;
  position: sticky;
  inset-block-start: var(--v-layout-top, 56px);
  z-index: 4;
}
.page-toc-summary, .page-toc-heading, .page-toc-filter { flex-shrink: 0; }
.page-toc-summary { display: flex; }
.page-toc-toggle { flex: 1 1 auto; min-width: 0; }
.page-toc-toggle > .v-btn__content { width: 100%; justify-content: space-between; }
.page-header-section .page-document-provenance { grid-row: 4; margin-block-start: 12px; }
.page-header-section .page-hero-actions { grid-row: 3; }
.page-hero-actions { container-type: inline-size; container-name: reader-actions; }
.page-focus-control { order: 1; }
[data-reader-share-trigger] { order: 2; }
.page-offline-control { order: 3; }
.page-hero-actions .page-edit-shortcuts { order: 4; }
@container reader-actions (max-width: 42rem) {
  .page-header-section .page-hero-actions .v-btn__prepend { margin-inline: 0; }
  .page-header-section .page-hero-actions .page-focus-control > .v-btn__content,
  .page-header-section .page-hero-actions [data-reader-share-trigger] > .v-btn__content,
  .page-header-section .page-edit-shortcuts .v-btn > .v-btn__content { display: none; }
  .page-header-section .page-hero-actions .page-focus-control[aria-pressed='true'] > .v-btn__content { display: flex; }
}
.page-header-section > .is-page-header {
  width: 100%;
  margin-inline: 0;
}
@media (min-width: 1280px) {
  .page-header-section {
    box-sizing: border-box;
    padding-inline: var(--page-reader-inline-gutter) max(var(--wiki-page-gutter), calc(var(--page-return-top-inset) + 4rem));
  }
  .page-header-section > .is-page-header {
    padding-inline: 0 !important;
  }
  .wiki-page--reading .page-header-section { padding-inline: var(--page-reader-inline-gutter); }
}

@media print {
  .page-position,
  .page-focus-control,
  .page-inline-toc,
  .page-reading-chrome { display: none !important; }
}

</style>
