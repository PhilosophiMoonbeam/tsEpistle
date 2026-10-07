<template lang="pug">
  v-dialog(
    v-model='isShown'
    max-width='850px'
    :fullscreen='$vuetify.display.smAndDown'
    scrim='surface'
    style='--v-overlay-opacity: .7'
    :aria-labelledby='titleId'
    :persistent='isSubmitting || moveReviewLoading || moveReceipt !== null || moveOutcomeUncertain'
    @after-enter='focusPath'
  )
    v-card.page-selector
      .dialog-header
        v-icon.mr-3(color='primary' aria-hidden='true') mdi-page-next-outline
        h2.text-body-large(v-if='mode === `create`' :id='titleId' ref='dialogTitle' tabindex='-1') {{$t('common:pageSelector.createTitle')}}
        h2.text-body-large(v-else-if='mode === `move`' :id='titleId' ref='dialogTitle' tabindex='-1') {{$t('common:pageSelector.moveTitle')}}
        h2.text-body-large(v-else-if='mode === `select`' :id='titleId' ref='dialogTitle' tabindex='-1') {{$t('common:pageSelector.selectTitle')}}
        v-spacer
        v-progress-circular(
          v-if='searchLoading'
          indeterminate
          color='primary'
          :size='20'
          :width='2'
          aria-hidden='true'
        )
      v-row.page-selector__panes(gap='0')
        v-col.page-selector__pane.page-selector__tree-pane(cols='12' md='5')
          v-toolbar.page-selector__pane-toolbar(color='surface-variant' density='compact' flat)
            h3.page-selector__folders-label.text-body-medium(:id='foldersId') {{$t('common:pageSelector.virtualFolders')}}
            v-spacer
            v-tooltip(location='top')
              template(v-slot:activator='{ props }')
                v-btn(v-bind='props' icon rounded='0' href='https://docs.requarks.io/guide/pages#folders' target='_blank' rel='noopener noreferrer' :aria-label='$t(`common:pageSelector.openVirtualFoldersHelp`)')
                  v-icon mdi-help-box-outline
              span {{$t('common:pageSelector.virtualFolders')}}
          div.page-selector__scroller(role='region' :aria-labelledby='foldersId' :aria-busy='searchLoading ? `true` : undefined')
            vue-scroll(:ops='scrollStyle')
              .page-selector__folder-errors(
                v-if='folderLoadFailureList.length > 0'
                role='status'
                aria-live='polite'
                aria-atomic='false'
              )
                v-alert.page-selector__folder-error(
                  v-for='failure in folderLoadFailureList'
                  :key='failure.key'
                  type='error'
                  variant='tonal'
                  density='compact'
                  :title='$t(`common:pageSelector.couldNotLoadPage`, { title: failure.item.title, interpolation: { escapeValue: false } })'
                  :text='failure.message'
                )
                  template(v-slot:append)
                    v-btn(
                      variant='text'
                      size='small'
                      :aria-label='$t(`common:pageSelector.tryLoadingAgain`, { title: failure.item.title, interpolation: { escapeValue: false } })'
                      :loading='isFolderRetrying(failure)'
                      @click='retryFolderLoad(failure)'
                    ) {{$t('common:pageSelector.tryAgain')}}
              v-treeview.page-selector__tree(
                :key='`pageTree-` + treeViewCacheId'
                v-model:activated='currentNode'
                v-model:opened='openNodes'
                :items='tree'
                :load-children='fetchFolders'
                :disabled='isSubmitting || moveReceipt !== null'
                :aria-labelledby='foldersId'
                density='compact'
                expand-icon='mdi-menu-down-outline'
                item-value='id'
                item-title='title'
                activatable
                mandatory
                hoverable
              )
                template(v-slot:prepend='{ isOpen }')
                  v-icon(aria-hidden='true') {{ $t(`common:pageSelector.mdi`, { value: isOpen ? 'folder-open' : 'folder', interpolation: { escapeValue: false } }) }}
        v-col.page-selector__pane.page-selector__pages-pane(cols='12' md='7')
          v-toolbar.page-selector__pane-toolbar(color='surface-variant' density='compact' flat)
            h3.text-body-medium(:id='pagesId') {{$t('common:pageSelector.pages')}}
          .page-selector__filter
            v-text-field.page-selector__filter-input(
              v-model='pageFilter'
              variant='outlined'
              density='compact'
              :label='$t(`common:pageSelector.filterPages`)'
              :hint='$t(`common:pageSelector.filterHint`)'
              persistent-hint
              clearable
              :disabled='isSubmitting || moveReceipt !== null'
            )
              template(v-slot:clear='{ props }')
                v-btn(
                  v-bind='props'
                  icon='mdi-close'
                  size='x-small'
                  variant='text'
                  tabindex='0'
                  :aria-label='$t(`common:pageSelector.clearPageFilter`)'
                )
            p.page-selector__filter-count(v-if='currentPages.length > 0' role='status' aria-live='polite' aria-atomic='true') {{$t('common:pageSelector.filterMatches', { count: filteredPages.length, total: currentPages.length })}}
          div.page-selector__scroller(role='region' :aria-labelledby='pagesId' :aria-busy='currentFolderLoading && currentPages.length > 0 ? `true` : undefined')
            .page-selector__selection-note(
              v-if='currentPages.length > 0 || currentPage'
              :class="{ 'page-selector__selection-note--selected': currentPage }"
              :data-selection-state='currentPage ? `selected` : `none`'
              role='status'
              aria-live='polite'
              aria-atomic='true'
            )
              v-icon(:color='currentPage ? `primary` : `on-surface-variant`' size='16' aria-hidden='true') {{ $t(`common:pageSelector.mdi`, { value: currentPage ? 'check-circle-outline' : 'cursor-default-click-outline', interpolation: { escapeValue: false } }) }}
              span.page-selector__selection-summary(v-if='currentPage')
                span {{$t('common:pageSelector.selectedPageSummary', { title: currentPage.title, interpolation: { escapeValue: false } })}}
                span.page-selector__page-path /{{currentPage.locale}}/{{currentPage.path}}
              span(v-else) {{$t('common:pageSelector.selectPageToContinue')}}
            async-state.page-selector__state(
              v-if='currentFolderLoading && currentPages.length === 0'
              state='loading'
              :title='$t(`common:pageSelector.loadingPages`)'
              :message='$t(`common:pageSelector.loadingPagesSelectedFolder`)'
            )
            v-list.page-selector__pages-list.py-0(
              v-else-if='filteredPages.length > 0'
              v-model:activated='currentPageIds'
              density='compact'
              activatable
              :disabled='isSubmitting || moveReceipt !== null'
              :aria-labelledby='pagesId'
              mandatory
            )
              template(v-for='page of filteredPages' :key='`page-` + page.id')
                v-list-item(
                  :value='page.id'
                  :class="{ 'page-selector__page--selected': currentPage?.id === page.id, 'page-selector__page--current': page.path === path && currentLocale === locale }"
                  :aria-current='page.path === path && currentLocale === locale ? `page` : undefined'
                )
                  template(v-slot:prepend): v-icon(aria-hidden='true') mdi-text-box-outline
                  v-list-item-title {{page.title}}
                  v-list-item-subtitle.page-selector__page-path /{{page.locale}}/{{page.path}}
            async-state.page-selector__state.page-selector__filter-empty(
              v-else-if='currentPages.length > 0'
              state='empty'
              :title='$t(`common:pageSelector.noFilterMatches`)'
            )
              template(v-slot:actions)
                v-btn(
                  variant='text'
                  color='primary'
                  :disabled='isSubmitting || moveReceipt !== null'
                  @click='pageFilter = ``'
                ) {{$t('common:pageSelector.clearPageFilter')}}
            async-state.page-selector__state(
              v-else-if='currentFolderFailure'
              state='error'
              :title='$t(`common:pageSelector.couldNotLoadPage`, { title: currentFolderFailure.item.title, interpolation: { escapeValue: false } })'
              :message='currentFolderFailure.message'
              :retry-label='$t(`common:pageSelector.tryAgain`)'
              :announce='false'
              @retry='retryCurrentFolderLoad'
            )
            async-state.page-selector__state(
              v-else-if='!currentFolderFailure'
              state='empty'
              :title='$t(`common:pageSelector.folderEmptyWarning`)'
              :message='$t(`common:pageSelector.pages`)'
            )
      .page-selector__repair-option(v-if='mode === `move`')
        label.page-selector__repair-toggle
          input(
            v-model='updateIncomingLinks'
            type='checkbox'
            :aria-describedby='moveLinkHelpId'
            :disabled='sourceVisibility !== `public` || !canReviewIncomingLinks || isSubmitting || moveReceipt !== null || moveOutcomeUncertain'
          )
          span {{$t('common:pageSelector.updateSupportedIncomingLinks')}}
        p.page-selector__repair-help(:id='moveLinkHelpId')
          | {{$t('common:pageSelector.repairHelpReviewEdits')}}
        p.page-selector__repair-help(v-if='sourceVisibility === `private`')
          | {{$t('common:pageSelector.repairHelpPrivateSource')}}
        p.page-selector__repair-help(v-else-if='!canReviewIncomingLinks')
          | {{$t('common:pageSelector.repairHelpUnavailable')}}
      section.page-selector__link-review(
        v-if='mode === `move` && updateIncomingLinks && moveReviewStage === `candidates`'
        :aria-labelledby='moveCandidatesId'
        :aria-busy='moveReviewLoading ? `true` : undefined'
      )
        h3(:id='moveCandidatesId' tabindex='-1') {{$t('common:pageSelector.incomingLinkCandidates')}}
        p.page-selector__repair-help
          | {{$t('common:pageSelector.boundedReviewNote')}}
        p.page-selector__coverage(v-if='moveReviewCoverageNotice' role='note') {{moveReviewCoverageNotice}}
        v-alert(v-if='moveReviewError' type='error' variant='tonal' density='compact' role='alert') {{moveReviewError}}
        async-state(
          v-if='moveReviewLoading && moveReviewItems.length === 0'
          state='loading'
          :title='$t(`common:pageSelector.loadingIncomingLinkCandidates`)'
          :message='$t(`common:pageSelector.onlyReadableSourcesIncluded`)'
        )
        p.page-selector__selection-count(v-else role='status' aria-live='polite') {{$t('common:pageSelector.referrerPagesSelected', { count: selectedMovePageIds.length, interpolation: { escapeValue: false } })}}
        .page-selector__candidate-list(v-if='moveReviewItems.length')
          article.page-selector__candidate(v-for='item in moveReviewItems' :key='item.id')
            label.page-selector__candidate-heading
              input(
                v-if='item.eligible && item.id !== sourcePageId'
                type='checkbox'
                :checked='isMovePageSelected(item.id)'
                :disabled='!isMovePageSelected(item.id) && selectedMovePageIds.length >= 20 || moveReviewLoading || moveReviewNeedsRefresh'
                :aria-label='$t(`common:pageSelector.selectCandidatePage`, { title: item.title, locale: item.locale, path: item.path, interpolation: { escapeValue: false } })'
                @change='setMovePageSelected(item.id, $event)'
              )
              span.page-selector__candidate-title {{item.title}}
              span.page-selector__candidate-location {{$t('common:pageSelector.candidateLocation', { locale: item.locale, path: item.path, revision: item.sourceRevision, interpolation: { escapeValue: false } })}}
            p.page-selector__candidate-reason(v-if='item.id === sourcePageId') {{$t('common:pageSelector.selfLinkBundled')}}
            p.page-selector__candidate-reason(v-if='!item.eligible && item.reason') {{item.reason}}
            p.page-selector__candidate-reason(v-if='!item.eligible && !item.reason') {{$t('common:pageSelector.manualRepairRequired')}}
            dl.page-selector__diff(v-if='(isMovePageSelected(item.id) || item.id === sourcePageId) && item.changes.length')
              template(v-for='(change, index) in item.changes' :key='`${item.id}-${index}`')
                dt {{$t('common:pageSelector.before')}}
                dd: code {{change.before}}
                dt {{$t('common:pageSelector.after')}}
                dd: code {{change.after}}
            p.page-selector__candidate-reason(v-else-if='item.eligible && (isMovePageSelected(item.id) || item.id === sourcePageId)') {{$t('common:pageSelector.noSupportedOccurrence')}}
        p.page-selector__empty(v-else-if='!moveReviewLoading && !moveReviewError') {{$t('common:pageSelector.noCandidatesReturned')}}
        p.page-selector__candidate-reason(v-if='hasAutomaticSelfLinkChanges') {{$t('common:pageSelector.selfLinkAutomatic')}}
        .page-selector__review-actions
          v-btn(
            v-if='moveReviewNextCursor'
            variant='text'
            :disabled='moveReviewLoading || moveReviewNeedsRefresh'
            :loading='moveReviewLoading'
            @click='loadMoreMoveCandidates'
          ) {{$t('common:pageSelector.loadMoreCandidates')}}
          v-btn(
            variant='text'
            :disabled='moveReviewLoading'
            @click='refreshMoveCandidates'
          ) {{$t('common:pageSelector.refreshCandidates')}}
      section.page-selector__link-review(
        v-if='mode === `move` && updateIncomingLinks && moveReviewStage === `confirm` && selectedMoveReview'
        :aria-labelledby='moveConfirmId'
      )
        h3(:id='moveConfirmId' tabindex='-1') {{$t('common:pageSelector.reviewExactSourceEdits')}}
        p.page-selector__repair-help {{$t('common:pageSelector.reviewConfirmNote')}}
        p.page-selector__coverage(role='note') {{selectedMoveReview.coverageNotice}}
        v-alert(v-if='moveReviewError' type='error' variant='tonal' density='compact' role='alert') {{moveReviewError}}
        article.page-selector__candidate(v-for='item in selectedMoveReview.items' :key='item.id')
          h4.page-selector__candidate-title {{item.title}}
          p.page-selector__candidate-location {{$t('common:pageSelector.candidateLocation', { locale: item.locale, path: item.path, revision: item.sourceRevision, interpolation: { escapeValue: false } })}}
          p.page-selector__candidate-reason(v-if='item.id === sourcePageId') {{$t('common:pageSelector.selfLinkBundled')}}
          p.page-selector__candidate-reason(v-if='!item.eligible') {{item.reason || $t('common:pageSelector.manualRepairRequired')}}
          dl.page-selector__diff(v-if='item.changes.length')
            template(v-for='(change, index) in item.changes' :key='`${item.id}-${index}`')
              dt {{ $t(`common:pageSelector.before`) }}
              dd: code {{change.before}}
              dt {{ $t(`common:pageSelector.after`) }}
              dd: code {{change.after}}
        p.page-selector__candidate-reason(v-if='selectedReviewHasNoChanges') {{$t('common:pageSelector.selectedPagesNoChanges')}}
        .page-selector__review-actions
          v-btn(variant='text' :disabled='moveReviewLoading || isSubmitting' @click='refreshMoveCandidates') {{$t('common:pageSelector.refreshReview')}}
      section.page-selector__link-review.page-selector__move-result(
        v-if='mode === `move` && moveReviewStage === `result` && moveReceipt'
        :aria-labelledby='moveResultId'
        role='status'
        aria-live='polite'
      )
        h3(:id='moveResultId' tabindex='-1') {{$t('common:pageSelector.moveCommitted')}}
        p {{$t('common:pageSelector.pageNowAtRevision', { pageId: moveReceipt.pageId, sourceRevision: moveReceipt.sourceRevision, interpolation: { escapeValue: false } })}}
        ul(v-if='moveReceipt.updated.length')
          li(v-for='updated in moveReceipt.updated' :key='updated.id')
            | {{$t('common:pageSelector.committedSourceRevision', { title: moveItemTitle(updated.id), sourceRevision: updated.sourceRevision, interpolation: { escapeValue: false } })}}
        p.page-selector__projection-notice {{$t('common:pageSelector.projectionsPending')}}
      section.page-selector__link-review(v-if='mode === `move` && moveOutcomeUncertain' :aria-labelledby='moveUncertainId' role='alert')
        h3(:id='moveUncertainId' tabindex='-1') {{$t('common:pageSelector.moveOutcomeUncertain')}}
        p {{$t('common:pageSelector.moveOutcomeUncertainNote')}}
        v-btn(variant='outlined' @click='refreshCurrentPage') {{$t('common:pageSelector.refreshPage')}}
      v-card-actions.page-selector__options.pa-2(v-if='!mustExist || allowLocaleChange')
        v-select(
          v-model='currentLocale'
          variant='solo'
          flat
          bg-color='surface-variant'
          hide-details
          single-line
          :items='namespaces'
          :label='$t(`common:pageSelector.localeLabel`)'
          :aria-label='$t(`common:pageSelector.pageLocaleLabel`)'
          :disabled='isSubmitting || moveReceipt !== null'
        )
        v-text-field(
          ref='pathIpt'
          v-model='currentPath'
          variant='solo'
          hide-details
          prefix='/'
          :label='$t(`common:pageSelector.pagePathLabel`)'
          :aria-label='$t(`common:pageSelector.pagePathLabel`)'
          flat
          :readonly='mustExist'
          clearable
          :disabled='isSubmitting || moveReceipt !== null'
        )
      v-card-chin.page-selector__chin
        v-alert.page-selector__submission-error(v-if='submissionError' type='error' variant='tonal' density='compact' role='alert') {{ submissionError }}
        v-spacer
        v-btn(
          variant='text'
          :disabled='isSubmitting || moveReviewLoading || moveReceipt !== null || moveOutcomeUncertain'
          @click='close'
        ) {{$t('common:actions.cancel')}}
        v-btn(
          v-if='mode === `move` && updateIncomingLinks && moveReviewStage === `candidates`'
          color='primary'
          :disabled='(selectedMovePageIds.length === 0 && !hasAutomaticSelfLinkChanges) || moveReviewLoading || moveReviewNeedsRefresh'
          :loading='moveReviewLoading'
          @click='reviewSelectedMovePages'
        ) {{selectedMovePageIds.length === 0 ? $t('common:pageSelector.reviewSelfLinkChanges') : $t('common:pageSelector.reviewSelectedChanges')}}
        v-btn(
          v-else-if='mode === `move` && updateIncomingLinks && moveReviewStage === `confirm`'
          color='primary'
          :disabled='!selectedMoveReview || moveReviewLoading || isSubmitting'
          :loading='isSubmitting'
          @click='confirmReviewedMove'
        ) {{$t('common:pageSelector.moveAndUpdateSelectedLinks')}}
        v-btn(
          v-else-if='mode === `move` && moveReceipt'
          color='primary'
          @click='acknowledgeMove'
        ) {{$t('common:pageSelector.done')}}
        v-btn(
          v-else-if='mode === `move` && moveOutcomeUncertain'
          color='primary'
          @click='refreshCurrentPage'
        ) {{$t('common:pageSelector.refreshPage')}}
        v-btn(
          v-else
          color='primary'
          prepend-icon='mdi-check'
          :loading='isSubmitting || moveReviewLoading'
          @click='open'
          :disabled='!isValidPath || isSubmitting || moveReviewLoading || !canReviewIncomingLinks && mode === `move` && updateIncomingLinks'
        ) {{mode === `move` && updateIncomingLinks ? $t('common:pageSelector.findIncomingLinks') : $t('common:actions.select')}}
        v-btn(
          v-if='mode === `move` && updateIncomingLinks && moveReceipt === null && !moveOutcomeUncertain'
          variant='outlined'
          :disabled='isSubmitting || moveReviewLoading'
          @click='moveWithoutRepair'
        ) {{$t('common:pageSelector.moveWithoutLinkRepair')}}
</template>

<script lang='ts'>
import { translate } from '@/modules/localization.ts'
import { defineComponent, markRaw, type PropType, useId } from 'vue'
import {
  fetchMoveLinkReview,
  fetchPageTree,
  type MoveLinkReviewItem,
  type MoveLinkReviewResponse,
  type MovePageReceipt,
  type PageTreeRow
} from '../../helpers/pages-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import AsyncState from './async-state.vue'

const localeSegmentRegex = /^[A-Z]{2}(-[A-Z]{2})?$/i

type PageSelectorMode = 'create' | 'move' | 'select'
type PageSelection = {
  locale: string
  path: string
  id: number
  visibility?: 'public' | 'private'
  sourcePageId?: number
  expectedSourceRevision?: string
  reviewToken?: string
}
type OpenHandler = (selection: PageSelection) => boolean | void | MovePageReceipt | Promise<boolean | void | MovePageReceipt>
type PageTreeItem = PageTreeRow & { treeId: number, children?: PageTreeItem[] }
type PageEntry = PageTreeRow & { pageId: number }
type FolderLoadFailure = { key: string, item: PageTreeItem, message: string, requestId: number }

function createRootNode (locale: string, treeId: number): PageTreeItem {
  return {
    id: 0,
    path: '',
    title: translate('common:pageSelector.root'),
    isFolder: true,
    pageId: null,
    parent: 0,
    locale,
    visibility: 'public',
    ownerId: null,
    treeId,
    children: []
  }
}

function isPageEntry (item: PageTreeRow): item is PageEntry {
  return item.pageId !== null && item.pageId > 0
}

function isPageTreeItem (item: unknown): item is PageTreeItem {
  return typeof item === 'object' && item !== null &&
    typeof (item as { id?: unknown }).id === 'number' &&
    typeof (item as { treeId?: unknown }).treeId === 'number'
}

function comparePageEntries (left: PageEntry, right: PageEntry): number {
  if (left.title !== right.title) return left.title < right.title ? -1 : 1
  if (left.path === right.path) return 0
  return left.path < right.path ? -1 : 1
}

function appendUniqueById<T extends { id: number }> (current: T[], additions: T[]): T[] {
  const ids = new Set(current.map(item => item.id))
  return current.concat(additions.filter(item => {
    if (ids.has(item.id)) return false
    ids.add(item.id)
    return true
  }))
}

function isMovePageReceipt(value: unknown): value is MovePageReceipt {
  if (typeof value !== 'object' || value === null) return false
  const receipt = value as Partial<MovePageReceipt>
  return receipt.message === 'Page has been moved.' &&
    typeof receipt.pageId === 'number' &&
    Number.isSafeInteger(receipt.pageId) &&
    receipt.pageId > 0 &&
    typeof receipt.sourceRevision === 'string' &&
    receipt.sourceRevision.length > 0 &&
    receipt.projections === 'pending' &&
    Array.isArray(receipt.updated) &&
    receipt.updated.every(item =>
      typeof item.id === 'number' &&
      Number.isSafeInteger(item.id) &&
      item.id > 0 &&
      typeof item.sourceRevision === 'string' &&
      item.sourceRevision.length > 0
    )
}

/* global siteLangs, siteConfig */

export default defineComponent({
  components: { AsyncState },
  emits: ['update:modelValue', 'move-acknowledged'],
  props: {
    modelValue: { type: Boolean, default: false },
    path: { type: String, default: 'new-page' },
    locale: { type: String, default: 'en' },
    mode: { type: String as PropType<PageSelectorMode>, default: 'create' },
    openHandler: { type: Function as PropType<OpenHandler>, default: () => undefined },
    mustExist: { type: Boolean, default: false },
    allowLocaleChange: { type: Boolean, default: false },
    sourcePageId: { type: Number, default: 0 },
    sourceSourceRevision: { type: String, default: '' },
    sourceVisibility: { type: String as PropType<'public' | 'private'>, default: 'public' }
  },
  setup() {
    const id = useId()
    return {
      titleId: `${id}-title`,
      foldersId: `${id}-folders`,
      pagesId: `${id}-pages`,
      moveLinkHelpId: `${id}-move-link-help`,
      moveCandidatesId: `${id}-move-link-candidates`,
      moveConfirmId: `${id}-move-link-confirm`,
      moveResultId: `${id}-move-result`,
      moveUncertainId: `${id}-move-uncertain`
    }
  },
  data() {
    return {
      treeViewCacheId: 0,
      pendingRequests: 0,
      folderLoadFailures: {} as Record<string, FolderLoadFailure>,
      folderRequestIds: {} as Record<string, number>,
      folderPendingRequestIds: {} as Record<string, number>,
      folderRequestSequence: 0,
      moveReviewRequestId: 0,
      updateIncomingLinks: false,
      moveReviewLoading: false,
      moveReviewStage: 'idle' as 'idle' | 'candidates' | 'confirm' | 'result',
      moveReviewItems: [] as MoveLinkReviewItem[],
      moveReviewNextCursor: null as string | null,
      moveReviewCoverageNotice: '',
      selectedMovePageIds: [] as number[],
      selectedMoveReview: null as MoveLinkReviewResponse | null,
      moveReviewNeedsRefresh: false,
      moveReviewError: '',
      moveReceipt: null as MovePageReceipt | null,
      committedMoveDestination: null as Readonly<{ locale: string, path: string }> | null,
      moveOutcomeUncertain: false,
      submissionError: '',
      isSubmitting: false,
      currentLocale: siteConfig.lang,
      currentPath: 'new-page' as string | null,
      currentPage: null as PageEntry | null,
      pageFilter: '' as string | null,
      currentNode: [0] as number[],
      openNodes: [0] as number[],
      tree: [createRootNode(siteConfig.lang, 0)] as PageTreeItem[],
      pages: [] as PageEntry[],
      all: [] as PageTreeRow[],
      namespaces: markRaw(siteLangs.length ? siteLangs.map(ns => ns.code) : [siteConfig.lang]),
      scrollStyle: markRaw({
        scrollPanel: { scrollingX: false }
      }),
      treeAbortController: null as AbortController | null,
      submissionRequestId: 0
    }
  },
  computed: {
    isShown: {
      get(): boolean { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    },
    searchLoading(): boolean { return this.pendingRequests > 0 },
    canReviewIncomingLinks(): boolean {
      return this.sourceVisibility === 'public' &&
        Number.isSafeInteger(this.sourcePageId) &&
        this.sourcePageId > 0 &&
        this.sourceSourceRevision.length > 0
    },
    hasAutomaticSelfLinkChanges(): boolean {
      return this.moveReviewItems.some(item => item.id === this.sourcePageId && item.changes.length > 0)
    },
    folderLoadFailureList(): FolderLoadFailure[] {
      return Object.values(this.folderLoadFailures)
    },
    currentFolderRequestKey(): string | null {
      const nodeId = this.currentNode[0]
      return nodeId === undefined ? null : `${this.treeViewCacheId}:${nodeId}`
    },
    currentFolderFailure(): FolderLoadFailure | null {
      return this.currentFolderRequestKey ? this.folderLoadFailures[this.currentFolderRequestKey] ?? null : null
    },
    currentFolderLoading(): boolean {
      return this.currentFolderRequestKey ? this.folderPendingRequestIds[this.currentFolderRequestKey] !== undefined : false
    },
    currentPages (): PageEntry[] {
      const parentId = this.currentNode[0] ?? 0
      return this.pages.filter(page => page.parent === parentId).sort(comparePageEntries)
    },
    filteredPages(): PageEntry[] {
      const query = (this.pageFilter ?? '').trim().toLowerCase()
      if (!query) return this.currentPages
      const terms = query.split(/\s+/)
      return this.currentPages.filter(page => {
        const titleAndPath = `${page.title} /${page.locale}/${page.path}`.toLowerCase()
        return terms.every(term => titleAndPath.includes(term))
      })
    },
    currentPageIds: {
      get(): number[] { return this.currentPage ? [this.currentPage.id] : [] },
      set(value: number[]) {
        this.currentPage = this.currentPages.find(page => page.id === value[0]) ?? null
      }
    },
    selectedReviewHasNoChanges(): boolean {
      return Boolean(this.selectedMoveReview?.items.some(item => item.id !== this.sourcePageId && item.changes.length === 0))
    },
    isValidPath (): boolean {
      if (!this.currentPath || (this.mustExist && !this.currentPage)) return false
      const firstSection = this.currentPath.split('/')[0]
      if (!firstSection || firstSection.length <= 1 || localeSegmentRegex.test(firstSection)) return false
      return !['login', 'logout', 'register', 'verify', 'favicons', 'fonts', 'img', 'js', 'svg'].includes(firstSection)
    }
  },
  watch: {
    isShown: {
      immediate: true,
      handler(newValue: boolean, oldValue: boolean | undefined) {
        if (newValue && !oldValue) {
          this.pageFilter = ''
          this.moveReceipt = null
          this.committedMoveDestination = null
          this.resetMoveLinkReview()
          this.updateIncomingLinks = false
          this.moveOutcomeUncertain = false
          this.moveReviewNeedsRefresh = false
          this.submissionError = ''
          this.moveReviewError = ''
          this.currentPath = this.path
          const localeChanged = this.currentLocale !== this.locale
          this.currentLocale = this.locale
          if (!localeChanged) void this.reloadTree(this.locale)
        } else if (!newValue && oldValue) {
          this.treeViewCacheId += 1
          this.treeAbortController?.abort()
          this.treeAbortController = null
          this.pendingRequests = 0
          this.moveReviewRequestId += 1
          this.moveReviewLoading = false
        }
      }
    },
    currentNode (newValue: number[], oldValue: number[]) {
      if (this.moveReceipt !== null) return
      const nodeId = newValue[0]
      if (nodeId === undefined) {
        void this.$nextTick(() => { this.currentNode = oldValue })
        return
      }
      if (nodeId !== oldValue[0]) this.pageFilter = ''
      const current = this.all.find(item => item.id === nodeId)
      const opened = new Set(this.openNodes)
      if (current) opened.add(current.parent)
      opened.add(nodeId)
      this.openNodes = [...opened]
      this.currentPage = null
      const pathParts = this.currentPath?.split('/') ?? []
      this.currentPath = [current?.path ?? '', pathParts[pathParts.length - 1] ?? ''].filter(Boolean).join('/')
    },
    currentPage (newValue: PageEntry | null) {
      if (this.moveReceipt !== null) return
      if (newValue) this.currentPath = newValue.path
    },
    currentLocale(newValue: string) {
      if (this.moveReceipt !== null && this.committedMoveDestination !== null) {
        if (newValue !== this.committedMoveDestination.locale)
          this.currentLocale = this.committedMoveDestination.locale
        return
      }
      this.pageFilter = ''
      this.resetMoveLinkReview()
      void this.reloadTree(newValue)
    },
    currentPath(newValue: string | null) {
      if (this.moveReceipt !== null && this.committedMoveDestination !== null) {
        if (newValue !== this.committedMoveDestination.path)
          this.currentPath = this.committedMoveDestination.path
        return
      }
      if (this.mode === 'move') this.resetMoveLinkReview()
    },
    updateIncomingLinks() {
      this.resetMoveLinkReview()
    },
    sourcePageId() {
      this.resetMoveLinkReview()
    },
    sourceSourceRevision() {
      this.resetMoveLinkReview()
    },
    sourceVisibility() {
      this.resetMoveLinkReview()
    }
  },
  beforeUnmount() {
    this.submissionRequestId += 1
    this.moveReviewRequestId += 1
    this.treeViewCacheId += 1
    this.treeAbortController?.abort()
    this.treeAbortController = null
  },
  methods: {
    focusPath(): void {
      const input = this.$refs.pathIpt as { focus?: () => void } | undefined
      if (input?.focus) {
        input.focus()
        return
      }
      const title = this.$refs.dialogTitle
      if (title instanceof HTMLElement) title.focus()
    },
    focusMoveReviewHeading(id: string): void {
      void this.$nextTick(() => {
        const heading = document.getElementById(id)
        if (heading instanceof HTMLElement) heading.focus()
      })
    },
    close(): void {
      if (!this.isSubmitting && !this.moveReviewLoading && this.moveReceipt === null && !this.moveOutcomeUncertain)
        this.isShown = false
    },
    async open(): Promise<void> {
      if (!this.currentPath || !this.isValidPath || this.isSubmitting || this.moveReviewLoading) return
      if (this.mode === 'move' && this.updateIncomingLinks) {
        await this.loadMoveCandidates(null, true)
        return
      }
      await this.submitSelection()
    },
    async moveWithoutRepair(): Promise<void> {
      if (this.mode !== 'move' || this.isSubmitting || this.moveReviewLoading || this.moveReceipt || this.moveOutcomeUncertain) return
      this.updateIncomingLinks = false
      await this.submitSelection()
    },
    async submitSelection(reviewToken?: string): Promise<void> {
      if (!this.currentPath || !this.isValidPath || this.isSubmitting) return
      const requestId = ++this.submissionRequestId
      const destinationLocale = this.currentLocale
      const destinationPath = this.currentPath
      this.submissionError = ''
      this.isSubmitting = true
      try {
        const result = await this.openHandler?.({
          locale: destinationLocale,
          path: destinationPath,
          id: (this.mustExist && this.currentPage) ? this.currentPage.pageId : 0,
          ...(this.currentPage ? { visibility: this.currentPage.visibility } : {}),
          ...(this.mode === 'move'
            ? { sourcePageId: this.sourcePageId, expectedSourceRevision: this.sourceSourceRevision }
            : {}),
          ...(reviewToken === undefined ? {} : { reviewToken })
        })
        if (requestId !== this.submissionRequestId) return
        if (result === false) {
          if (this.mode === 'move') {
            if (reviewToken !== undefined) {
              this.selectedMoveReview = null
              this.moveReviewStage = 'candidates'
              this.moveReviewNeedsRefresh = true
              this.moveReviewError = this.$t('common:pageSelector.moveNotStartedRefreshCandidates')
              this.focusMoveReviewHeading(this.moveCandidatesId)
            } else {
              this.submissionError = this.$t('common:pageSelector.moveNotStartedRefreshAuthorization')
            }
          }
          return
        }
        if (reviewToken !== undefined) {
          if (!isMovePageReceipt(result) || result.pageId !== this.sourcePageId)
            throw new Error(this.$t('common:pageSelector.moveReceiptNotVerified'))
          this.moveReceipt = result
          this.committedMoveDestination = Object.freeze({
            locale: destinationLocale,
            path: destinationPath
          })
          this.currentLocale = destinationLocale
          this.currentPath = destinationPath
          this.moveReviewStage = 'result'
          this.moveReviewError = ''
          this.focusMoveReviewHeading(this.moveResultId)
          return
        }
        this.isShown = false
      } catch (error) {
        if (requestId !== this.submissionRequestId) return
        const status = error && typeof error === 'object' ? Reflect.get(error, 'status') : undefined
        const knownRejection =
          typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429
        if (this.mode === 'move' && !knownRejection) {
          this.moveOutcomeUncertain = true
          this.moveReviewStage = 'idle'
          this.selectedMoveReview = null
          this.submissionError = ''
          this.moveReviewError = ''
          this.focusMoveReviewHeading(this.moveUncertainId)
        } else if (reviewToken !== undefined) {
          this.selectedMoveReview = null
          this.moveReviewStage = 'candidates'
          this.moveReviewNeedsRefresh = true
          this.moveReviewError = this.$t('common:pageSelector.reviewStaleReviewingAgain')
          this.focusMoveReviewHeading(this.moveCandidatesId)
        } else {
          this.submissionError = getErrorMessage(error) || this.$t('common:pageSelector.pageSelectionNotCompleted')
        }
      } finally {
        if (requestId === this.submissionRequestId) this.isSubmitting = false
      }
    },
    async loadMoveCandidates(cursor: string | null, refresh: boolean): Promise<void> {
      if (
        !this.canReviewIncomingLinks ||
        !this.currentPath ||
        this.moveReviewLoading ||
        this.isSubmitting ||
        this.moveReceipt ||
        this.moveOutcomeUncertain
      )
        return
      if (refresh) this.resetMoveLinkReview()
      const requestId = ++this.moveReviewRequestId
      const destinationLocale = this.currentLocale
      const destinationPath = this.currentPath
      const sourceRevision = this.sourceSourceRevision
      this.moveReviewLoading = true
      this.moveReviewStage = 'candidates'
      this.moveReviewError = ''
      if (refresh) this.moveReviewCoverageNotice = ''
      try {
        const response = await fetchMoveLinkReview(
          window.fetch.bind(window),
          this.sourcePageId,
          {
            destinationLocale,
            destinationPath,
            expectedSourceRevision: sourceRevision,
            ...(cursor === null ? {} : { cursor })
          },
          this.$t('common:pageSelector.incomingLinkReviewUnavailable')
        )
        if (
          requestId !== this.moveReviewRequestId ||
          !this.isShown ||
          destinationLocale !== this.currentLocale ||
          destinationPath !== this.currentPath ||
          sourceRevision !== this.sourceSourceRevision
        )
          return
        this.moveReviewItems = cursor === null ? response.items : appendUniqueById(this.moveReviewItems, response.items)
        this.moveReviewNextCursor = response.nextCursor
        this.moveReviewCoverageNotice = response.coverageNotice
        this.moveReviewNeedsRefresh = false
        this.focusMoveReviewHeading(this.moveCandidatesId)
      } catch {
        if (requestId === this.moveReviewRequestId) {
          this.moveReviewError = this.$t('common:pageSelector.unableLoadIncomingLinkReview')
          this.focusMoveReviewHeading(this.moveCandidatesId)
        }
      } finally {
        if (requestId === this.moveReviewRequestId) this.moveReviewLoading = false
      }
    },
    loadMoreMoveCandidates(): void {
      if (this.moveReviewNextCursor) void this.loadMoveCandidates(this.moveReviewNextCursor, false)
    },
    refreshMoveCandidates(): void {
      void this.loadMoveCandidates(null, true)
    },
    isMovePageSelected(pageId: number): boolean {
      return this.selectedMovePageIds.includes(pageId)
    },
    setMovePageSelected(pageId: number, event: Event): void {
      if (pageId === this.sourcePageId || this.moveReviewLoading || this.moveReviewNeedsRefresh) return
      const checked = (event.target as HTMLInputElement | null)?.checked === true
      if (checked) {
        if (!this.selectedMovePageIds.includes(pageId) && this.selectedMovePageIds.length < 20) {
          this.selectedMovePageIds = [...this.selectedMovePageIds, pageId]
          this.selectedMoveReview = null
          this.moveReviewError = ''
        }
      } else {
        this.selectedMovePageIds = this.selectedMovePageIds.filter(id => id !== pageId)
        this.selectedMoveReview = null
      }
    },
    async reviewSelectedMovePages(): Promise<void> {
      if (
        !this.canReviewIncomingLinks ||
        !this.currentPath ||
        (this.selectedMovePageIds.length === 0 && !this.hasAutomaticSelfLinkChanges) ||
        this.selectedMovePageIds.length > 20 ||
        this.moveReviewLoading ||
        this.isSubmitting ||
        this.moveReviewNeedsRefresh
      )
        return
      const requestId = ++this.moveReviewRequestId
      const selectedIds = [...this.selectedMovePageIds]
      const expectedIds = new Set(selectedIds)
      const destinationLocale = this.currentLocale
      const destinationPath = this.currentPath
      const sourceRevision = this.sourceSourceRevision
      this.moveReviewLoading = true
      this.moveReviewError = ''
      try {
        const response = await fetchMoveLinkReview(
          window.fetch.bind(window),
          this.sourcePageId,
          {
            destinationLocale,
            destinationPath,
            expectedSourceRevision: sourceRevision,
            selectedPageIds: selectedIds
          },
          this.$t('common:pageSelector.selectedIncomingLinkReviewUnavailable')
        )
        if (
          requestId !== this.moveReviewRequestId ||
          !this.isShown ||
          destinationLocale !== this.currentLocale ||
          destinationPath !== this.currentPath ||
          sourceRevision !== this.sourceSourceRevision
        )
          return
        const reviewedReferrers = response.items.filter(item => item.id !== this.sourcePageId)
        if (
          reviewedReferrers.length !== selectedIds.length ||
          selectedIds.some(id => !reviewedReferrers.some(item => item.id === id && item.eligible)) ||
          reviewedReferrers.some(item => !expectedIds.has(item.id)) ||
          response.items.some(item => item.id === this.sourcePageId && item.changes.length > 0 && !item.eligible)
        )
          throw new Error(this.$t('common:pageSelector.selectedReviewChanged'))
        if (
          selectedIds.length === 0 &&
          !response.items.some(item => item.id === this.sourcePageId && item.changes.length > 0)
        )
          throw new Error(this.$t('common:pageSelector.noReviewedSelfLinkChange'))
        this.selectedMoveReview = response
        this.moveReviewCoverageNotice = response.coverageNotice
        this.focusMoveReviewHeading(this.moveConfirmId)
        this.moveReviewStage = 'confirm'
      } catch {
        if (requestId === this.moveReviewRequestId) {
          this.selectedMoveReview = null
          this.moveReviewStage = 'candidates'
          this.moveReviewNeedsRefresh = true
          this.moveReviewError = this.$t('common:pageSelector.reviewStaleContinuing')
          this.focusMoveReviewHeading(this.moveCandidatesId)
        }
      } finally {
        if (requestId === this.moveReviewRequestId) this.moveReviewLoading = false
      }
    },
    confirmReviewedMove(): void {
      const token = this.selectedMoveReview?.reviewToken
      if (!token || this.moveReviewNeedsRefresh || this.isSubmitting || this.moveReviewLoading) return
      void this.submitSelection(token)
    },
    moveItemTitle(pageId: number): string {
      const item = this.selectedMoveReview?.items.find(candidate => candidate.id === pageId) ??
        this.moveReviewItems.find(candidate => candidate.id === pageId)
      return item?.title ?? (pageId === this.sourcePageId ? this.$t('common:pageSelector.movedPage') : this.$t('common:pageSelector.pageWithId', { pageId, interpolation: { escapeValue: false } }))
    },
    resetMoveLinkReview(): void {
      if (this.moveReceipt !== null) return
      this.moveReviewRequestId += 1
      this.moveReviewLoading = false
      this.moveReviewStage = 'idle'
      this.moveReviewItems = []
      this.moveReviewNextCursor = null
      this.moveReviewCoverageNotice = ''
      this.selectedMovePageIds = []
      this.selectedMoveReview = null
      this.moveReviewNeedsRefresh = false
      this.moveReviewError = ''
    },
    acknowledgeMove(): void {
      if (!this.moveReceipt || !this.committedMoveDestination) return
      this.$emit('move-acknowledged', {
        locale: this.committedMoveDestination.locale,
        path: this.committedMoveDestination.path,
        receipt: this.moveReceipt
      })
      this.isShown = false
    },
    refreshCurrentPage(): void {
      window.location.reload()
    },
    async reloadTree (locale: string): Promise<void> {
      this.treeAbortController?.abort()
      this.treeAbortController = new AbortController()
      this.treeViewCacheId += 1
      const root = createRootNode(locale, this.treeViewCacheId)
      this.pendingRequests = 0
      this.folderLoadFailures = {}
      this.folderRequestIds = {}
      this.folderPendingRequestIds = {}
      this.tree = [root]
      this.currentNode = [0]
      this.openNodes = [0]
      this.currentPage = null
      this.pages = []
      this.all = []
      await this.fetchFolders(root)
    },
    isFolderRetrying(failure: FolderLoadFailure): boolean {
      return this.folderPendingRequestIds[failure.key] !== undefined
    },
    retryCurrentFolderLoad(): void {
      if (this.currentFolderFailure) this.retryFolderLoad(this.currentFolderFailure)
    },
    retryFolderLoad(failure: FolderLoadFailure): void {
      if (failure.item.treeId !== this.treeViewCacheId || this.isFolderRetrying(failure)) return
      void this.fetchFolders(failure.item)
    },
    async fetchFolders (item: unknown): Promise<void> {
      if (!isPageTreeItem(item)) throw new TypeError(this.$t('common:pageSelector.invalidPageTreeItem'))
      const requestLocale = this.currentLocale
      const requestTreeId = item.treeId
      if (requestTreeId !== this.treeViewCacheId) return
      const controller = this.treeAbortController
      if (!controller || controller.signal.aborted) return
      const requestKey = `${requestTreeId}:${item.id}`
      const requestId = ++this.folderRequestSequence
      this.folderRequestIds[requestKey] = requestId
      this.folderPendingRequestIds[requestKey] = requestId
      this.pendingRequests += 1
      try {
        const items = await fetchPageTree(
          (url, init) => window.fetch(url, { ...init, signal: controller.signal }),
          { parent: item.id, mode: 'ALL', locale: requestLocale }
        )
        if (
          requestTreeId !== this.treeViewCacheId ||
          item.locale !== this.currentLocale ||
          requestLocale !== this.currentLocale ||
          this.folderRequestIds[requestKey] !== requestId
        ) return
        const itemFolders: PageTreeItem[] = items.filter(item => item.isFolder).map(folder => ({ ...folder, treeId: requestTreeId, children: [] }))
        const itemPages = items.filter(isPageEntry)
        item.children = itemFolders.length > 0 ? itemFolders : undefined
        this.pages = appendUniqueById(this.pages, itemPages)
        this.all = appendUniqueById(this.all, items)
        delete this.folderLoadFailures[requestKey]
      } catch (err) {
        if (controller.signal.aborted) return
        if (
          requestTreeId === this.treeViewCacheId &&
          requestLocale === this.currentLocale &&
          this.folderRequestIds[requestKey] === requestId
        ) {
          this.folderLoadFailures[requestKey] = {
            key: requestKey,
            item,
            message: getErrorMessage(err) || this.$t('common:pageSelector.pagesCouldNotLoaded'),
            requestId
          }
        }
      } finally {
        if (requestTreeId === this.treeViewCacheId) this.pendingRequests = Math.max(0, this.pendingRequests - 1)
        if (this.folderPendingRequestIds[requestKey] === requestId) delete this.folderPendingRequestIds[requestKey]
      }
    }
  }
})
</script>

<style lang='scss'>
.page-selector {
  --page-selector-row-height: 2.75rem;

  overflow: hidden;
  background: var(--wiki-surface-raised, rgb(var(--v-theme-surface)));
  color: rgb(var(--v-theme-on-surface));

  .v-treeview .v-list-item-title {
    font-size: 13px;
  }

  .v-treeview .v-list-item {
    cursor: pointer;
  }

  &__panes {
    min-width: 0;
    border-block-end: 1px solid var(--wiki-surface-border);
  }

  &__pane {
    min-width: 0;
    padding: 0 !important;
    background: var(--wiki-surface-raised, rgb(var(--v-theme-surface)));
  }

  &__tree-pane {
    background: color-mix(
      in srgb,
      var(--wiki-surface-sunken, rgb(var(--v-theme-background))) 34%,
      var(--wiki-surface-raised, rgb(var(--v-theme-surface)))
    );
  }

  &__pages-pane {
    border-inline-start: 1px solid var(--wiki-surface-border);
  }

  &__pane-toolbar {
    min-height: var(--page-selector-row-height);
    border-block-end: 1px solid var(--wiki-surface-border);
    color: rgb(var(--v-theme-on-surface));
  }

  &__folders-label {
    padding-inline-start: var(--wiki-space-3);
  }

  &__folder-errors {
    display: grid;
    gap: var(--wiki-space-2);
    padding: var(--wiki-space-2) var(--wiki-space-3);
  }

  &__folder-error {
    border-radius: var(--wiki-control-radius);
  }
  &__filter {
    min-width: 0;
    padding: var(--wiki-space-3) var(--wiki-space-3) var(--wiki-space-2);
    border-block-end: 1px solid var(--wiki-surface-border);
  }

  &__filter-input {
    min-width: 0;
    font-size: var(--wiki-type-body-sm, .875rem);
  }

  &__filter-count {
    margin: var(--wiki-space-2) 0 0;
    color: rgb(var(--v-theme-on-surface-variant));
    font-size: var(--wiki-type-body-sm, .875rem);
  }


  &__scroller {
    min-height: 12rem;
    max-height: min(400px, 52dvh);
    overflow: hidden;
    padding-block: var(--wiki-space-2);
  }

  &__pages-pane &__scroller {
    display: flex;
    flex-direction: column;
  }

  &__pages-pane &__selection-note {
    flex-shrink: 0;
  }

  &__pages-list {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior-y: contain;
  }

  &__tree,
  &__pages-list {
    padding-block: 0 var(--wiki-space-2);
    padding-inline: var(--wiki-space-2);
  }

  &__tree .v-list-item,
  &__pages-list .v-list-item {
    min-height: var(--page-selector-row-height);
    border: 1px solid transparent;
    border-radius: var(--wiki-control-radius);
    color: rgb(var(--v-theme-on-surface));
    transition:
      background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
      border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
      box-shadow var(--wiki-motion-fast) var(--wiki-motion-ease);
  }

  &__tree .v-list-item {
    margin-block: 1px;
  }

  &__tree .v-list-item--active {
    border-color: color-mix(in srgb, var(--wiki-accent-ink) 34%, transparent);
    background: color-mix(
      in srgb,
      var(--wiki-accent-ink) 9%,
      var(--wiki-surface-raised, rgb(var(--v-theme-surface)))
    );
    color: var(--wiki-accent-ink);
  }

  &__pages-list .v-list-item {
    margin-block: var(--wiki-space-1);
    padding-inline: var(--wiki-space-3);
  }

  &__pages-list .v-list-item-title,
  &__page-path {
    white-space: normal;
    overflow-wrap: anywhere;
  }

  &__page-path {
    display: block;
    margin-block-start: .2rem;
    color: rgb(var(--v-theme-on-surface-variant));
    font-size: .8rem;
    line-height: 1.45;
    opacity: 1;
  }

  &__selection-summary {
    display: flex;
    min-width: 0;
    flex-direction: column;
    overflow-wrap: anywhere;
  }

  &__selection-note {
    display: flex;
    min-height: 2.25rem;
    align-items: center;
    gap: var(--wiki-space-2);
    margin: var(--wiki-space-2) var(--wiki-space-3) var(--wiki-space-1);
    padding: var(--wiki-space-1) var(--wiki-space-2);
    border: 1px dashed var(--wiki-surface-border);
    border-radius: var(--wiki-control-radius);
    background: var(--wiki-surface-sunken, rgb(var(--v-theme-background)));
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 70%, transparent);
    font-size: var(--wiki-type-body-sm, .875rem);
  }

  &__selection-note--selected {
    border-style: solid;
    border-color: color-mix(in srgb, var(--wiki-accent-ink) 44%, transparent);
    background: color-mix(
      in srgb,
      var(--wiki-accent-ink) 7%,
      var(--wiki-surface-raised, rgb(var(--v-theme-surface)))
    );
    color: var(--wiki-accent-ink);
  }

  &__page--current {
    border-style: dashed;
    border-color: color-mix(in srgb, var(--wiki-accent-ink) 52%, transparent);
    background: color-mix(
      in srgb,
      var(--wiki-accent-ink) 5%,
      var(--wiki-surface-raised, rgb(var(--v-theme-surface)))
    );
  }

  &__page--selected {
    border-style: solid;
    border-color: color-mix(in srgb, var(--wiki-accent-ink) 62%, transparent);
    background: color-mix(
      in srgb,
      var(--wiki-accent-ink) 13%,
      var(--wiki-surface-raised, rgb(var(--v-theme-surface)))
    );
    box-shadow: inset .2rem 0 var(--wiki-accent-ink);
    color: var(--wiki-accent-ink);
  }

  &__page--selected.page-selector__page--current {
    border-style: solid;
    box-shadow:
      inset .2rem 0 var(--wiki-accent-ink),
      0 0 0 1px color-mix(in srgb, var(--wiki-accent-ink) 24%, transparent);
  }

  &__state {
    min-height: 7.5rem;
    margin: var(--wiki-space-3);
  }

  &__filter-empty {
    min-height: 0;
    overflow-y: auto;
    justify-content: flex-start;
  }

  &__state.async-state--loading {
    border-style: solid;
    border-color: color-mix(in srgb, var(--wiki-accent-ink) 24%, transparent);
  }

  &__state.async-state--empty {
    background: var(--wiki-surface-sunken, rgb(var(--v-theme-background)));
  }

  &__state.async-state--error {
    border-style: solid;
  }

  &__options {
    gap: var(--wiki-space-2);
  }

  &__repair-option {
    padding: var(--wiki-space-3);
    border-block-end: 1px solid var(--wiki-surface-border);
  }

  &__repair-toggle {
    display: flex;
    min-height: 2.5rem;
    align-items: center;
    gap: var(--wiki-space-2);
    font-weight: 650;
    cursor: pointer;
  }

  &__repair-toggle input {
    width: 1.15rem;
    height: 1.15rem;
    flex: 0 0 auto;
    accent-color: var(--wiki-accent-ink);
  }

  &__repair-help,
  &__coverage {
    margin: var(--wiki-space-2) 0 0;
    color: rgb(var(--v-theme-on-surface-variant));
    font-size: .82rem;
    line-height: 1.45;
  }

  &__link-review {
    display: grid;
    gap: var(--wiki-space-2);
    max-height: min(38dvh, 30rem);
    overflow-y: auto;
    padding: var(--wiki-space-3);
    border-block-end: 1px solid var(--wiki-surface-border);
  }

  &__link-review h3,
  &__link-review h4 {
    margin: 0;
    color: rgb(var(--v-theme-on-surface));
    font-size: .95rem;
    font-weight: 650;
  }

  &__candidate-list {
    display: grid;
    gap: var(--wiki-space-2);
  }

  &__candidate {
    min-width: 0;
    padding: var(--wiki-space-3);
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-control-radius);
    background: var(--wiki-surface-sunken, rgb(var(--v-theme-background)));
  }

  &__candidate-heading {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: var(--wiki-space-2);
    flex-wrap: wrap;
    cursor: pointer;
  }

  &__candidate-heading input {
    width: 1.15rem;
    height: 1.15rem;
    flex: 0 0 auto;
    accent-color: var(--wiki-accent-ink);
  }

  &__candidate-title {
    min-width: 0;
    color: rgb(var(--v-theme-on-surface));
    font-weight: 650;
    overflow-wrap: anywhere;
  }

  &__candidate-location,
  &__candidate-reason,
  &__selection-count,
  &__empty {
    margin: 0;
    color: rgb(var(--v-theme-on-surface-variant));
    font-size: .8rem;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  &__diff {
    display: grid;
    grid-template-columns: 4rem minmax(0, 1fr);
    gap: .25rem var(--wiki-space-2);
    margin: var(--wiki-space-2) 0 0;
  }

  &__diff dt {
    color: rgb(var(--v-theme-on-surface-variant));
    font-size: .75rem;
    font-weight: 600;
  }

  &__diff dd {
    min-width: 0;
    margin: 0;
  }

  &__diff code {
    display: block;
    max-width: 100%;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  &__review-actions {
    display: flex;
    gap: var(--wiki-space-2);
    flex-wrap: wrap;
  }

  &__projection-notice {
    padding: var(--wiki-space-2);
    border-inline-start: .2rem solid var(--wiki-accent-ink);
    background: color-mix(in srgb, var(--wiki-accent-ink) 8%, transparent);
  }
  &__options .v-select {
    flex: 0 1 10rem;
    min-width: 7rem;
  }

  &__options .v-text-field {
    flex: 1 1 14rem;
    min-width: 0;
  }

  &__chin {
    position: sticky;
    bottom: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: var(--wiki-space-2);
    flex-wrap: wrap;
  }

  &__submission-error {
    flex: 1 1 100%;
    min-width: 0;
    border-radius: var(--wiki-control-radius);
  }
}

@media (max-width: 599.98px) {
  .page-selector__panes {
    display: block;
    overflow-y: auto;
    border-block-end: 0;
  }

  .page-selector__pages-pane {
    border-block-start: 1px solid var(--wiki-surface-border);
    border-inline-start: 0;
  }

  .page-selector__scroller {
    max-height: 34dvh;
  }

  .page-selector__options {
    flex-wrap: wrap;
  }

  .page-selector__options .v-select,
  .page-selector__options .v-text-field {
    flex: 1 1 100%;
  }
  .page-selector__link-review {
    max-height: 42dvh;
    padding-inline: var(--wiki-space-2);
  }

  .page-selector__candidate-location {
    flex-basis: 100%;
  }

  .page-selector__chin {
    align-items: stretch;
  }

  .page-selector__chin > .v-btn {
    flex: 1 1 100%;
  }
}
</style>
