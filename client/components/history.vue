<template lang='pug'>
  v-app.history
    nav-header
    v-main.history-main
      v-toolbar.history-toolbar(color='surface', flat)
        .history-toolbar-copy
          .history-eyebrow Revision history
          h1.history-toolbar-title Viewing history of #[strong.history-path-fragment /{{path}}]
          .history-toolbar-meta(v-if='$vuetify.display.mdAndUp')
            span {{total}} revisions
            span {{locale}}
        v-spacer
        v-btn.history-live-action(variant='flat', color='primary', size='small', @click='goLive', aria-label='Return to page')
          v-icon(v-if='$vuetify.display.smAndDown') mdi-close
          span(v-else) Return to page
      v-container.history-shell(fluid)
        v-row.history-shell-row
          v-col.history-trail-column(cols='12')
            .history-trail-panel(ref='trailContainer', tabindex='0', role='region', aria-label='Revision history', @scroll.passive='onTrailScroll')
              .history-trail-header
                .history-trail-heading
                  span.history-section-kicker Revisions
                  strong {{total}} total
                .history-live-chip
                  v-icon(size='small', aria-hidden='true') mdi-access-point
                  span Live
              .history-refreshing(v-if='trailLoading && trail.length > 0', role='status', aria-live='polite')
                v-progress-circular(indeterminate, size='16', width='2', color='primary', aria-hidden='true')
                span Refreshing history…
              async-state(
                v-if='trailLoading && trail.length === 0'
                state='loading'
                title='Loading page history'
                message='Fetching revision metadata.'
              )
              async-state(
                v-else-if='trailError && trail.length === 0'
                state='error'
                title='Page history could not be loaded'
                :message='trailError'
                retry-label='Retry history'
                @retry='loadHistory'
              )
              async-state(
                v-else-if='trailLoaded && trail.length === 0'
                state='empty'
                title='No revisions yet'
                message='This page has no saved revisions to compare.'
              )
              template(v-else)
                .history-refresh-error(v-if='trailError', role='alert')
                  v-icon(size='small', aria-hidden='true') mdi-alert-circle-outline
                  span {{trailError}}
                  v-btn(size='small', variant='text', color='primary', @click='loadHistory') Retry
                .history-revision-list(v-if='trail.length > 0', role='list', aria-label='Saved revisions')
                  .history-revision-row(
                    v-for='(ph, idx) in fullTrail'
                    :key='ph.versionId'
                    :class='{ "history-revision-row--target": diffTarget === ph.versionId, "history-revision-row--source": diffSource === ph.versionId }'
                    role='listitem'
                  )
                    .history-revision-main(
                      role='button'
                      :tabindex='canSelectVersion(idx) ? 0 : -1'
                      :aria-disabled='!canSelectVersion(idx)'
                      :aria-current='diffTarget === ph.versionId ? `true` : undefined'
                      :aria-label='revisionAriaLabel(ph, idx)'
                      @click='selectVersion(idx)'
                      @keydown.enter.prevent='selectVersion(idx)'
                      @keydown.space.prevent='selectVersion(idx)'
                    )
                      .history-revision-date(:title='String($helpers.formatMoment(ph.versionDate, `LLL`))') {{ $helpers.formatMoment(ph.versionDate, 'll') }}
                      .history-revision-copy
                        .history-revision-action(v-if='ph.actionType === `edit`') Edited by #[strong {{ ph.authorName }}]
                        .history-revision-action(v-else-if='ph.actionType === `move`') Moved from #[strong.history-path-fragment {{ph.valueBefore}}] to #[strong.history-path-fragment {{ph.valueAfter}}] by #[strong {{ ph.authorName }}]
                        .history-revision-action(v-else-if='ph.actionType === `initial`') Initial revision by #[strong {{ ph.authorName }}]
                        .history-revision-action(v-else-if='ph.actionType === `live`') Live version, last edited by #[strong {{ ph.authorName }}]
                        .history-revision-action(v-else) Revision by #[strong {{ ph.authorName }}]
                      .history-revision-selection(v-if='diffTarget === ph.versionId') Newer
                      .history-revision-selection(v-if='diffSource === ph.versionId') Older
                    .history-revision-actions
                      v-menu(location='start')
                        template(v-slot:activator='{ props }')
                          v-btn(
                            v-bind='props'
                            icon
                            size='small'
                            variant='text'
                            :aria-label='`More actions for ${ph.versionId === 0 ? `live version` : `revision ${ph.versionId}`}`'
                            @click.stop
                          ): v-icon mdi-dots-horizontal
                        v-list(density='compact', nav).history-promptmenu
                          v-list-item(@click.stop='setDiffSource(ph.versionId)', :disabled='!canSetDiffSource(ph.versionId)')
                            template(v-slot:prepend)
                              v-icon(size='small') mdi-chevron-down
                            v-list-item-title Set as Older revision
                          v-list-item(@click.stop='setDiffTarget(ph.versionId)', :disabled='!canSetDiffTarget(ph.versionId)')
                            template(v-slot:prepend)
                              v-icon(size='small') mdi-chevron-up
                            v-list-item-title Set as Newer revision
                          v-list-item(@click.stop='viewSource(ph.versionId)')
                            template(v-slot:prepend)
                              v-icon(size='small') mdi-code-tags
                            v-list-item-title View Source
                          v-list-item(@click.stop='download(ph.versionId)')
                            template(v-slot:prepend)
                              v-icon(size='small') mdi-cloud-download-outline
                            v-list-item-title Download Version
                          v-list-item(@click.stop='restore(ph.versionId, ph.versionDate)', :disabled='ph.versionId === 0')
                            template(v-slot:prepend)
                              v-icon(size='small') mdi-history
                            v-list-item-title Restore
                          v-list-item(@click.stop='branchOff(ph.versionId)')
                            template(v-slot:prepend)
                              v-icon(size='small') mdi-source-branch
                            v-list-item-title Branch off from here
                      v-btn.history-selection-button(
                        size='small'
                        variant='text'
                        :aria-label='`Set revision ${ph.versionId === 0 ? `live version` : ph.versionId} as Older revision`'
                        :aria-pressed='diffSource === ph.versionId'
                        :disabled='!canSetDiffSource(ph.versionId)'
                        @click.stop='setDiffSource(ph.versionId)'
                      ) Older
                      v-btn.history-selection-button(
                        size='small'
                        variant='text'
                        :aria-label='`Set revision ${ph.versionId === 0 ? `live version` : ph.versionId} as Newer revision`'
                        :aria-pressed='diffTarget === ph.versionId'
                        :disabled='!canSetDiffTarget(ph.versionId)'
                        @click.stop='setDiffTarget(ph.versionId)'
                      ) Newer
                .history-pagination(v-if='trailLoaded && trail.length > 0')
                  v-btn.history-load-more(
                    v-if='total > trail.length && !paginationError'
                    block
                    color='primary'
                    variant='tonal'
                    @click='loadMore'
                    :loading='loadingMore'
                    :disabled='loadingMore || trailLoading'
                  ) Load more revisions
                  async-state(
                    v-if='paginationError'
                    state='error'
                    title='Older revisions could not be loaded'
                    :message='paginationError'
                    retry-label='Retry older revisions'
                    @retry='loadMore'
                  )
                  .history-end-state(v-else-if='total <= trail.length', role='status')
                    v-icon(size='small', aria-hidden='true') mdi-archive-check-outline
                    span End of revision history
          v-col.history-comparison-column(cols='12')
            v-card.history-comparison-surface(v-if='trailLoaded && trail.length > 0')
              v-card-text
                .history-comparison-header
                  .history-comparison-heading-copy
                    span.history-section-kicker Comparison
                    h2#history-comparison-heading.history-comparison-heading(ref='comparisonHeading', tabindex='-1') Older revision to Newer revision
                    .history-comparison-range(aria-live='polite')
                      span.history-comparison-range-item
                        strong Older
                        span {{sourceSelectionLabel}}
                      v-icon(size='small', aria-hidden='true') mdi-arrow-right
                      span.history-comparison-range-item
                        strong Newer
                        span {{targetSelectionLabel}}
                  .history-comparison-controls(role='group', aria-label='Comparison format')
                    v-btn.history-view-choice(
                      size='small'
                      :variant='viewMode === `line-by-line` ? `flat` : `text`'
                      :color='viewMode === `line-by-line` ? `primary` : undefined'
                      :aria-pressed='viewMode === `line-by-line`'
                      @click='setViewMode(`line-by-line`)'
                    ) Unified
                    v-btn.history-view-choice(
                      size='small'
                      :variant='viewMode === `side-by-side` ? `flat` : `text`'
                      :color='viewMode === `side-by-side` ? `primary` : undefined'
                      :aria-pressed='viewMode === `side-by-side`'
                      @click='setViewMode(`side-by-side`)'
                    ) Side by side
                .history-comparison-details(v-if='targetReady')
                  h3.history-comparison-title {{target.title}}
                  .history-comparison-description(v-if='target.description') {{target.description}}
                  .history-revision-meta
                    span {{ target.versionId === 0 ? 'Live version' : `Revision ${target.versionId}` }}
                    span {{ target.editor || 'unknown editor' }} / {{ target.contentType || 'unknown format' }}
                    span {{ target.visibility || 'unknown visibility' }}{{ target.isPublished === false ? ' / unpublished' : '' }}
                    span(v-if='target.tags && target.tags.length > 0') Tags: {{ target.tags.join(', ') }}
                async-state(
                  v-if='comparisonLoading'
                  state='loading'
                  title='Loading comparison'
                  message='Fetching the selected revisions.'
                )
                async-state(
                  v-else-if='sourceError'
                  state='error'
                  title='Older revision is unavailable'
                  :message='sourceError'
                  retry-label='Retry Older revision'
                  @retry='retrySource'
                )
                async-state(
                  v-else-if='targetError'
                  state='error'
                  title='Newer revision is unavailable'
                  :message='targetError'
                  retry-label='Retry Newer revision'
                  @retry='retryTarget'
                )
                async-state(
                  v-else-if='comparisonError'
                  state='error'
                  title='Comparison could not be rendered'
                  :message='comparisonError'
                )
                async-state(
                  v-else-if='comparisonEmpty'
                  state='empty'
                  title='No textual changes'
                  message='These revisions contain the same text.'
                )
                .history-diff(v-else-if='comparisonReady', dir='ltr', aria-labelledby='history-comparison-heading')
                  div(v-html='diffHTML')
    v-dialog(
      v-model='isRestoreConfirmDialogShown'
      max-width='650'
      persistent
      :aria-label='$t(`history:restore.confirmTitle`)'
    )
      v-card.history-restore-dialog
        .dialog-header.history-restore-header {{$t('history:restore.confirmTitle')}}
        v-card-text.pa-4
          i18next(tag='span', path='history:restore.confirmText')
            strong(place='date') {{ $helpers.formatMoment(restoreTarget.versionDate, 'LLL') }}
        v-card-actions
          v-spacer
          v-btn(variant='text', @click='isRestoreConfirmDialogShown = false', :disabled='restoreLoading') {{$t('common:actions.cancel')}}
          v-btn(color='warning', variant='flat', @click='restoreConfirm', :loading='restoreLoading') {{$t('history:restore.confirmButton')}}
    page-selector(mode='create', v-model='branchOffOpts.modal', :open-handler='branchOffHandle', :path='branchOffOpts.path', :locale='branchOffOpts.locale')
    nav-footer
    notify
    search-results
</template>

<script lang='ts'>
import { markRaw, onWatcherCleanup } from 'vue'
import * as Diff2Html from 'diff2html'
import { createPatch } from 'diff'
import AsyncState from '@/components/common/async-state.vue'
import { fetchPageHistory, fetchPageVersion, restorePageVersion, type PageHistoryTrailItem, type PageVersion } from '../helpers/pages-api'
import { getPageDownloadPath, getPageSourcePath } from '../helpers/page-actions'
import { getErrorMessage, loadingStart, loadingStop, setLoading, showNotification } from '../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'
import { decodeBase64Json } from '../helpers/base64'

const HISTORY_PAGE_SIZE = 25
const MAX_COMPARISON_CHARACTERS = 1_000_000
const MAX_COMPARISON_LINES = 100_000
const COMPARISON_TIMEOUT_MS = 150
const MAX_COMPARISON_EDITS = 2_000
const MAX_RENDERED_PATCH_LINES = 4_000
const MAX_MATCHED_PATCH_LINES = 200
const COMPARISON_LIMIT_MESSAGE = 'This comparison is too large to render safely. Choose closer revisions, or use View Source or Download Version from the revision menu.'

type HistorySide = 'source' | 'target'

const emptyPageVersion = (versionId = 0): PageVersion => ({
  versionId,
  content: '',
  contentType: 'markdown',
  title: '',
  description: '',
  editor: 'markdown',
  locale: 'en',
  path: '',
  tags: [],
  versionDate: '',
  visibility: 'public'
})

const cancelledError = (): Error => {
  const error = new Error('Request cancelled')
  error.name = 'AbortError'
  return error
}

const isAbortError = (error: unknown): boolean => Boolean(
  error && typeof error === 'object' && 'name' in error && Reflect.get(error, 'name') === 'AbortError'
)

export default {
  components: {
    AsyncState
  },
  i18nOptions: { namespaces: 'history' },
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
    visibility: {
      type: String,
      default: 'public'
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
    editor: {
      type: String,
      default: 'markdown'
    },
    contentType: {
      type: String,
      default: 'markdown'
    },
    tags: {
      type: Array,
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
    isPublished: {
      type: Boolean,
      default: false
    },
    liveContent: {
      type: String,
      default: ''
    },
    effectivePermissions: {
      type: String,
      default: ''
    }
  },
  data () {
    return {
      source: emptyPageVersion(),
      target: emptyPageVersion(),
      sourceReady: false,
      targetReady: true,
      sourceLoading: false,
      targetLoading: false,
      sourceError: '',
      targetError: '',
      sourceRequestId: 0,
      targetRequestId: 0,
      sourceVersionController: null as AbortController | null,
      targetVersionController: null as AbortController | null,
      activeVersionControllers: markRaw(new Set<AbortController>()),
      trail: [] as PageHistoryTrailItem[],
      diffSource: 0,
      diffTarget: 0,
      offsetPage: 0,
      total: 0,
      viewMode: 'line-by-line' as 'line-by-line' | 'side-by-side',
      trailScrollTop: 0,
      cache: [] as PageVersion[],
      restoreTarget: {
        versionId: 0,
        versionDate: ''
      },
      branchOffOpts: {
        versionId: 0,
        locale: 'en',
        path: 'new-page',
        modal: false
      },
      isRestoreConfirmDialogShown: false,
      trailError: '',
      paginationError: '',
      trailLoading: true,
      trailLoaded: false,
      loadingMore: false,
      restoreLoading: false,
      restoreRedirectTimer: null as number | null,
      historyRefreshController: null as AbortController | null,
      historyMoreController: null as AbortController | null,
      historyRefreshRequestId: 0,
      historyMoreRequestId: 0,
      restoreRequestId: 0,
      isUnmounted: false,
      requestsAbortController: markRaw(new AbortController())
    }
  },
  computed: {
    fullTrail () {
      const liveTrailItem: PageHistoryTrailItem = {
        versionId: 0,
        authorId: this.authorId,
        authorName: this.authorName,
        actionType: 'live',
        valueBefore: null,
        valueAfter: null,
        versionDate: this.updatedAt
      }
      const prevPage = this.cache.find(page => page.versionId === (this.trail[0]?.versionId ?? -1))
      if (prevPage && this.path !== prevPage.path) {
        liveTrailItem.actionType = 'move'
        liveTrailItem.valueBefore = prevPage.path
        liveTrailItem.valueAfter = this.path
      }
      return [liveTrailItem, ...this.trail]
    },
    sourceSelectionLabel () {
      if (this.diffSource === -1) return 'Empty baseline'
      if (this.diffSource === 0) return 'Live version'
      return `Revision ${this.diffSource}`
    },
    targetSelectionLabel () {
      if (this.diffTarget === 0) return 'Live version'
      return `Revision ${this.diffTarget}`
    },
    comparisonReady () {
      return Boolean(
        this.sourceReady &&
        this.targetReady &&
        this.source.versionId === this.diffSource &&
        this.target.versionId === this.diffTarget
      )
    },
    comparisonLoading () {
      return Boolean(
        this.sourceLoading ||
        this.targetLoading ||
        (!this.sourceReady && !this.sourceError) ||
        (!this.targetReady && !this.targetError)
      )
    },
    diffResult () {
      if (!this.comparisonReady) return { patch: '', html: '', error: '', empty: false }
      const sourceContent = typeof this.source.content === 'string' ? this.source.content : ''
      const targetContent = typeof this.target.content === 'string' ? this.target.content : ''
      if (sourceContent === targetContent) return { patch: '', html: '', error: '', empty: true }
      if (sourceContent.length + targetContent.length > MAX_COMPARISON_CHARACTERS) {
        return {
          patch: '',
          html: '',
          error: COMPARISON_LIMIT_MESSAGE,
          empty: false
        }
      }
      const sourceLines = sourceContent.length === 0 ? 0 : sourceContent.split('\n').length
      const targetLines = targetContent.length === 0 ? 0 : targetContent.split('\n').length
      if (sourceLines + targetLines > MAX_COMPARISON_LINES) {
        return {
          patch: '',
          html: '',
          error: COMPARISON_LIMIT_MESSAGE,
          empty: false
        }
      }
      try {
        const patch = createPatch(`/${this.path}`, sourceContent, targetContent, undefined, undefined, {
          timeout: COMPARISON_TIMEOUT_MS,
          maxEditLength: MAX_COMPARISON_EDITS
        })
        const patchLines = patch?.split('\n').length ?? 0
        if (patch === undefined || patchLines > MAX_RENDERED_PATCH_LINES) {
          return { patch: '', html: '', error: COMPARISON_LIMIT_MESSAGE, empty: false }
        }
        return {
          patch,
          html: Diff2Html.html(patch, {
            drawFileList: false,
            matching: patchLines <= MAX_MATCHED_PATCH_LINES ? 'lines' : 'none',
            matchingMaxComparisons: 100,
            maxLineLengthHighlight: patchLines <= MAX_MATCHED_PATCH_LINES ? 500 : 0,
            outputFormat: this.viewMode
          }),
          error: '',
          empty: false
        }
      } catch {
        return {
          patch: '',
          html: '',
          error: 'This comparison could not be rendered. Retry the selected revisions.',
          empty: false
        }
      }
    },
    diffs () {
      return this.diffResult.patch
    },
    diffHTML () {
      return this.diffResult.html
    },
    comparisonError () {
      return this.diffResult.error
    },
    comparisonEmpty () {
      return this.diffResult.empty
    }
  },
  watch: {
    trail () {
      this.reconcileSelections()
    },
    viewMode () {
      this.preserveTrailScroll()
    },
    async diffSource (newValue: number) {
      if (this.sourceReady && !this.sourceError && newValue === this.source.versionId) return
      await this.loadSelectedVersion('source', newValue, cleanup => onWatcherCleanup(cleanup))
    },
    async diffTarget (newValue: number) {
      if (this.targetReady && !this.targetError && newValue === this.target.versionId) return
      await this.loadSelectedVersion('target', newValue, cleanup => onWatcherCleanup(cleanup))
    }
  },
  created () {
    wikiStore.page.id = this.pageId
    wikiStore.page.locale = this.locale
    wikiStore.page.path = this.path
    wikiStore.page.visibility = this.visibility === 'private' ? 'private' : 'public'
    wikiStore.page.mode = 'history'
    this.cache.push({
      action: 'live',
      authorId: this.authorId,
      authorName: this.authorName,
      content: this.liveContent,
      contentType: this.contentType,
      createdAt: this.createdAt,
      description: this.description,
      editor: this.editor,
      visibility: this.visibility === 'private' ? 'private' : 'public',
      ownerId: wikiStore.page.ownerId,
      isPublished: this.isPublished,
      locale: this.locale,
      pageId: this.pageId,
      path: this.path,
      publishEndDate: '',
      publishStartDate: '',
      tags: this.tags.filter((tag): tag is string => typeof tag === 'string'),
      title: this.title,
      versionId: 0,
      versionDate: this.updatedAt
    })
    this.target = this.cache[0]!
    if (this.effectivePermissions) {
      wikiStore.page.effectivePermissions = decodeBase64Json(this.effectivePermissions)
    }
  },
  mounted () {
    void this.loadHistory()
  },
  beforeUnmount () {
    this.isUnmounted = true
    this.historyRefreshRequestId += 1
    this.historyMoreRequestId += 1
    this.sourceRequestId += 1
    this.targetRequestId += 1
    this.restoreRequestId += 1
    this.historyRefreshController?.abort()
    this.historyMoreController?.abort()
    this.sourceVersionController?.abort()
    this.targetVersionController?.abort()
    for (const controller of this.activeVersionControllers) controller.abort()
    this.historyRefreshController = null
    this.historyMoreController = null
    this.sourceVersionController = null
    this.targetVersionController = null
    this.requestsAbortController.abort()
    if (this.restoreRedirectTimer !== null) {
      window.clearTimeout(this.restoreRedirectTimer)
      this.restoreRedirectTimer = null
    }
  },
  methods: {
    fetchWithAbort (url: string, init: RequestInit): Promise<Response> {
      return window.fetch(url, {
        ...init,
        signal: this.requestsAbortController.signal
      })
    },
    fetchWithSignal (signal: AbortSignal) {
      return (url: string, init: RequestInit): Promise<Response> => window.fetch(url, {
        ...init,
        signal
      })
    },
    resolveElementRef (value: unknown): HTMLElement | null {
      let candidate = value
      if (Array.isArray(candidate)) candidate = candidate[0]
      if (candidate && typeof candidate === 'object' && '$el' in candidate) candidate = Reflect.get(candidate, '$el')
      if (!candidate || typeof candidate !== 'object') return null
      return candidate as HTMLElement
    },
    historyTrailIds (): Set<number> {
      return new Set(this.trail.map(item => item.versionId))
    },
    reconcileSelections () {
      const ids = this.historyTrailIds()
      const firstRevision = this.trail[0]?.versionId ?? 0
      let target = this.diffTarget
      let source = this.diffSource
      if (target !== 0 && !ids.has(target)) target = 0
      if (this.trail.length === 0) {
        target = 0
        source = 0
      } else if (source !== -1 && (source <= 0 || !ids.has(source))) {
        source = firstRevision
      }
      const ordered = this.fullTrail
      const targetIndex = ordered.findIndex(item => item.versionId === target)
      const targetItem = targetIndex >= 0 ? ordered[targetIndex] : undefined
      const initialBaselineAllowed = Boolean(
        source === -1 &&
        targetItem?.actionType === 'initial' &&
        this.total <= this.trail.length
      )
      if (source === -1 && !initialBaselineAllowed) source = firstRevision
      const nextTargetIndex = ordered.findIndex(item => item.versionId === target)
      const nextSourceIndex = ordered.findIndex(item => item.versionId === source)
      if (target !== 0 && (source === 0 || source > 0 && nextSourceIndex <= nextTargetIndex)) {
        target = 0
        source = firstRevision
      }
      if (this.diffTarget !== target) this.diffTarget = target
      if (this.diffSource !== source) this.diffSource = source
    },
    async loadVersion (versionId: number, controller?: AbortController): Promise<PageVersion> {
      if (this.isUnmounted || this.requestsAbortController.signal.aborted) throw cancelledError()
      const requestController = controller ?? markRaw(new AbortController())
      this.activeVersionControllers.add(requestController)
      loadingStart(wikiStore, 'history-version-' + versionId)
      try {
        const page = await fetchPageVersion(this.fetchWithSignal(requestController.signal), this.pageId, versionId)
        if (
          requestController.signal.aborted ||
          this.requestsAbortController.signal.aborted ||
          this.isUnmounted
        ) throw cancelledError()
        const cached = this.cache.find(item => item.versionId === page.versionId)
        if (cached) return cached
        this.cache.push(page)
        return page
      } finally {
        this.activeVersionControllers.delete(requestController)
        loadingStop(wikiStore, 'history-version-' + versionId)
      }
    },
    async loadSelectedVersion (
      side: HistorySide,
      versionId: number,
      registerCleanup?: (cleanup: () => void) => void
    ): Promise<boolean> {
      if (this.isUnmounted) return false
      const isSource = side === 'source'
      const previousController = isSource ? this.sourceVersionController : this.targetVersionController
      previousController?.abort()
      const controller = markRaw(new AbortController())
      const requestId = isSource ? ++this.sourceRequestId : ++this.targetRequestId
      let cancelled = false
      registerCleanup?.(() => {
        cancelled = true
        controller.abort()
      })
      const isCurrent = (): boolean => Boolean(
        !cancelled &&
        !this.isUnmounted &&
        (isSource ? this.sourceRequestId : this.targetRequestId) === requestId &&
        (isSource ? this.diffSource : this.diffTarget) === versionId &&
        (isSource ? this.sourceVersionController : this.targetVersionController) === controller
      )
      if (isSource) {
        this.sourceVersionController = controller
        this.sourceLoading = versionId !== -1
        this.sourceError = ''
        this.sourceReady = false
      } else {
        this.targetVersionController = controller
        this.targetLoading = true
        this.targetError = ''
        this.targetReady = false
      }
      try {
        if (versionId === -1 && isSource) {
          if (!isCurrent()) return false
          this.source = {
            ...emptyPageVersion(-1),
            path: this.path,
            locale: this.locale
          }
          this.sourceReady = true
          return true
        }
        const cached = this.cache.find(item => item.versionId === versionId)
        const page = cached ?? await this.loadVersion(versionId, controller)
        if (!isCurrent()) return false
        if (isSource) {
          this.source = page
          this.sourceReady = true
        } else {
          this.target = page
          this.targetReady = true
        }
        return true
      } catch (error) {
        if (!isCurrent() || isAbortError(error)) return false
        const message = getErrorMessage(error)
        if (isSource) {
          this.sourceError = message
          this.sourceReady = false
          showNotification(wikiStore, { style: 'red', message: `Older revision unavailable: ${message}`, icon: 'alert' })
        } else {
          this.targetError = message
          this.targetReady = false
          showNotification(wikiStore, { style: 'red', message: `Newer revision unavailable: ${message}`, icon: 'alert' })
        }
        return false
      } finally {
        if (isCurrent()) {
          if (isSource) {
            this.sourceLoading = false
            this.sourceVersionController = null
          } else {
            this.targetLoading = false
            this.targetVersionController = null
          }
        }
        }
    },
    retrySource () {
      if (this.isUnmounted || this.sourceLoading || this.diffSource <= 0) return
      void this.loadSelectedVersion('source', this.diffSource)
    },
    retryTarget () {
      if (this.isUnmounted || this.targetLoading || this.diffTarget < 0) return
      void this.loadSelectedVersion('target', this.diffTarget)
    },
    viewSource (versionId: number) {
      window.location.assign(getPageSourcePath(this.locale, this.path, versionId, this.visibility === 'private' ? 'private' : 'public'))
    },
    download (versionId: number) {
      window.location.assign(getPageDownloadPath(this.locale, this.path, versionId, this.visibility === 'private' ? 'private' : 'public'))
    },
    restore (versionId: number, versionDate: string) {
      this.restoreTarget = { versionId, versionDate }
      this.isRestoreConfirmDialogShown = true
    },
    async restoreConfirm () {
      if (this.isUnmounted || this.restoreLoading) return
      const requestId = ++this.restoreRequestId
      const isCurrent = (): boolean => Boolean(
        !this.isUnmounted &&
        requestId === this.restoreRequestId &&
        !this.requestsAbortController.signal.aborted
      )
      this.restoreLoading = true
      loadingStart(wikiStore, 'history-restore')
      try {
        await restorePageVersion(this.fetchWithAbort, this.pageId, this.restoreTarget.versionId, this.sourceRevision)
        if (!isCurrent()) return
        showNotification(wikiStore, {
          style: 'success',
          message: this.$t('history:restore.success'),
          icon: 'check'
        })
        this.isRestoreConfirmDialogShown = false
        this.restoreRedirectTimer = window.setTimeout(() => {
          if (!isCurrent()) return
          window.location.assign(`/${this.locale}/${this.path}`)
        }, 1000)
      } catch (error) {
        if (!isCurrent() || isAbortError(error)) return
        showNotification(wikiStore, {
          style: 'red',
          message: getErrorMessage(error),
          icon: 'alert'
        })
      } finally {
        loadingStop(wikiStore, 'history-restore')
        if (!isCurrent()) return
        this.restoreLoading = false
      }
    },
    branchOff (versionId: number) {
      const pathParts = this.path.split('/')
      this.branchOffOpts = {
        versionId,
        locale: this.locale,
        path: pathParts.length > 1 ? pathParts.slice(0, -1).join('/') + '/new-page' : 'new-page',
        modal: true
      }
    },
    branchOffHandle ({ locale, path }: { locale: string, path: string }) {
      window.location.assign(`/e/${locale}/${path}?from=${this.pageId},${this.branchOffOpts.versionId}`)
    },
    setViewMode (mode: 'line-by-line' | 'side-by-side') {
      if (mode !== 'line-by-line' && mode !== 'side-by-side') return
      this.viewMode = mode
      this.preserveTrailScroll()
    },
    goLive () {
      const privatePrefix = this.visibility === 'private' ? '/_private' : ''
      window.location.assign(`${privatePrefix}/${this.locale}/${this.path}`)
    },
    revisionAriaLabel (item: PageHistoryTrailItem, index: number) {
      const date = this.$helpers.formatMoment(item.versionDate, 'LLL')
      if (!this.canSelectVersion(index)) return `Revision from ${date} has no earlier comparison source`
      return `Compare revision from ${date}`
    },
    canSelectVersion (index: number) {
      const target = this.fullTrail[index]
      const source = this.fullTrail[index + 1]
      return Boolean(
        target &&
        (
          (source && source.versionId > 0) ||
          (target.actionType === 'initial' && this.total <= this.trail.length)
        )
      )
    },
    selectVersion (index: number) {
      const target = this.fullTrail[index]
      const source = this.fullTrail[index + 1]
      if (!target) return
      if (source && source.versionId > 0) {
        this.diffSource = source.versionId
      } else if (target.actionType === 'initial' && this.total <= this.trail.length) {
        this.diffSource = -1
      } else {
        return
      }
      this.diffTarget = target.versionId
      this.preserveTrailScroll()
      if (this.isMobileViewport()) this.scrollToComparison()
    },
    canSetDiffSource (versionId: number) {
      if (versionId <= 0) return false
      const sourceIndex = this.fullTrail.findIndex(item => item.versionId === versionId)
      const targetIndex = this.fullTrail.findIndex(item => item.versionId === this.diffTarget)
      return sourceIndex >= 0 && (this.diffTarget === 0 || targetIndex < 0 || sourceIndex > targetIndex)
    },
    canSetDiffTarget (versionId: number) {
      if (versionId < 0 || versionId === this.diffSource && this.diffSource !== -1) return false
      if (this.diffSource === -1) return true
      if (versionId === 0) return true
      const targetIndex = this.fullTrail.findIndex(item => item.versionId === versionId)
      const sourceIndex = this.fullTrail.findIndex(item => item.versionId === this.diffSource)
      return targetIndex >= 0 && sourceIndex >= 0 && targetIndex < sourceIndex
    },
    isMobileViewport (): boolean {
      if (typeof window !== 'undefined' && typeof window.innerWidth === 'number') return window.innerWidth < 960
      return Boolean(this.$vuetify?.display?.smAndDown)
    },
    scrollToComparison () {
      this.$nextTick(() => {
        const heading = this.resolveElementRef(this.$refs.comparisonHeading)
        if (!heading) return
        const rootStyles = typeof window !== 'undefined' && typeof document !== 'undefined'
          ? window.getComputedStyle(document.documentElement)
          : null
        const layoutTopRaw = rootStyles ? parseFloat(rootStyles.getPropertyValue('--v-layout-top')) : 0
        const layoutTop = Number.isNaN(layoutTopRaw) ? 0 : layoutTopRaw
        const headingTop = heading.getBoundingClientRect().top + (typeof window !== 'undefined' ? window.scrollY : 0)
        const targetY = Math.max(0, headingTop - layoutTop - 12)
        if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
          window.scrollTo({
            top: targetY,
            behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth'
          })
        }
        if (typeof heading.focus === 'function') heading.focus({ preventScroll: true })
        this.preserveTrailScroll()
      })
    },
    onTrailScroll (event: Event) {
      const target = event.target as HTMLElement | null
      if (target) this.trailScrollTop = target.scrollTop
    },
    preserveTrailScroll () {
      this.$nextTick(() => {
        const trailEl = this.resolveElementRef(this.$refs.trailContainer) ??
          this.resolveElementRef((this.$el as HTMLElement | undefined)?.querySelector?.('.history-trail-panel'))
        if (trailEl && typeof this.trailScrollTop === 'number' && trailEl.scrollTop !== this.trailScrollTop) {
          trailEl.scrollTop = this.trailScrollTop
        }
      })
    },
    setDiffSource (versionId: number) {
      if (!this.canSetDiffSource(versionId)) return
      this.diffSource = versionId
      this.preserveTrailScroll()
    },
    setDiffTarget (versionId: number) {
      if (!this.canSetDiffTarget(versionId)) return
      this.diffTarget = versionId
      this.preserveTrailScroll()
    },
    dedupeTrail (trail: PageHistoryTrailItem[]) {
      const seen = new Set<number>()
      return trail.filter(item => {
        if (seen.has(item.versionId)) return false
        seen.add(item.versionId)
        return true
      })
    },
    async loadMore (): Promise<boolean> {
      if (
        this.isUnmounted ||
        this.trailLoading ||
        this.loadingMore ||
        !this.trailLoaded ||
        this.total <= this.trail.length
      ) return false
      const offsetPage = this.offsetPage + 1
      const refreshRequestId = this.historyRefreshRequestId
      this.historyMoreController?.abort()
      const controller = markRaw(new AbortController())
      const requestId = ++this.historyMoreRequestId
      this.historyMoreController = controller
      this.loadingMore = true
      this.paginationError = ''
      setLoading(wikiStore, 'history-trail-refresh', true)
      const isCurrent = (): boolean => Boolean(
        !this.isUnmounted &&
        this.historyMoreRequestId === requestId &&
        this.historyRefreshRequestId === refreshRequestId &&
        this.historyMoreController === controller &&
        !controller.signal.aborted
      )
      try {
        const result = await this.fetchHistoryPage(offsetPage, controller.signal)
        if (!isCurrent()) return false
        const seen = new Set(this.trail.map(item => item.versionId))
        const additions = result.trail.filter(item => {
          if (seen.has(item.versionId)) return false
          seen.add(item.versionId)
          return true
        })
        this.offsetPage = offsetPage
        this.total = result.total
        this.trail = [...this.trail, ...additions]
        this.paginationError = ''
        this.preserveTrailScroll()
        return true
      } catch (error) {
        if (!isCurrent() || isAbortError(error)) return false
        this.paginationError = getErrorMessage(error)
        return false
      } finally {
        setLoading(wikiStore, 'history-trail-refresh', false)
        if (isCurrent()) {
          this.historyMoreController = null
          this.loadingMore = false
        }
      }
    },
    async loadHistory (): Promise<boolean> {
      if (this.isUnmounted) return false
      this.historyRefreshController?.abort()
      this.historyMoreController?.abort()
      const controller = markRaw(new AbortController())
      const requestId = ++this.historyRefreshRequestId
      ++this.historyMoreRequestId
      this.historyRefreshController = controller
      this.historyMoreController = null
      this.trailLoading = true
      this.loadingMore = false
      this.trailError = ''
      this.paginationError = ''
      setLoading(wikiStore, 'history-trail-refresh', true)
      const isCurrent = (): boolean => Boolean(
        !this.isUnmounted &&
        this.historyRefreshRequestId === requestId &&
        this.historyRefreshController === controller &&
        !controller.signal.aborted
      )
      try {
        const result = await this.fetchHistoryPage(0, controller.signal)
        if (!isCurrent()) return false
        this.offsetPage = 0
        this.total = result.total
        this.trail = this.dedupeTrail(result.trail)
        this.trailLoaded = true
        this.reconcileSelections()
        this.preserveTrailScroll()
        return true
      } catch (error) {
        if (!isCurrent() || isAbortError(error)) return false
        this.trailError = getErrorMessage(error)
        return false
      } finally {
        setLoading(wikiStore, 'history-trail-refresh', false)
        if (isCurrent()) {
          this.historyRefreshController = null
          this.trailLoading = false
        }
      }
    },
    fetchHistoryPage (offsetPage: number, signal?: AbortSignal): Promise<{ trail: PageHistoryTrailItem[], total: number }> {
      const requestSignal = signal ?? this.requestsAbortController.signal
      return fetchPageHistory(
        this.fetchWithSignal(requestSignal),
        this.pageId,
        offsetPage,
        HISTORY_PAGE_SIZE
      )
    }
  }
}
</script>

<style lang='scss'>
.history {
  min-height: 100dvh;

  .v-application__wrap {
    min-height: 100dvh;
  }
}

.history-main {
  min-height: 0;
  background: rgb(var(--v-theme-background));
}

.history-toolbar {
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-10)) !important;
  padding-inline: var(--wiki-page-gutter);
  border-bottom: 1px solid var(--wiki-surface-border) !important;
  background: var(--wiki-surface-raised) !important;
}

.history-toolbar-copy {
  min-width: 0;
  padding-block: var(--wiki-space-3);
}

.history-eyebrow,
.history-section-kicker {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .12em;
  text-transform: uppercase;
}

.history-toolbar-title {
  overflow: hidden;
  margin: var(--wiki-space-1) 0 0;
  color: rgb(var(--v-theme-on-surface));
  font-size: 1rem;
  font-weight: 520;
  text-overflow: ellipsis;
  white-space: nowrap;

  strong {
    font-family: var(--wiki-font-mono);
    font-weight: 680;
  }
}

.history-path-fragment {
  direction: ltr;
  unicode-bidi: isolate;
}

.history-toolbar-meta,
.history-revision-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--wiki-space-1) var(--wiki-space-4);
  margin-top: var(--wiki-space-1);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
  font-size: .75rem;
}

.history-live-action,
.history-load-more,
.history-view-choice,
.history-selection-button {
  border-radius: var(--wiki-control-radius);
  font-weight: 650;
  text-transform: none;
}

.history-shell {
  width: min(100%, var(--wiki-content-max));
  margin: 0 auto;
  padding: var(--wiki-space-6) var(--wiki-page-gutter) var(--wiki-space-12) !important;
}

.history-shell-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--wiki-space-6);

  > .history-trail-column,
  > .history-comparison-column {
    width: auto;
    max-width: none;
    flex: none;
    padding: 0;
  }
}

.history-trail-column,
.history-comparison-column {
  min-width: 0;
}

.history-trail-panel {
  min-width: 0;
  padding: var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
}

.history-trail-panel:focus-visible {
  outline: .125rem solid var(--wiki-focus-color);
  outline-offset: calc(var(--wiki-focus-offset) * -1);
  box-shadow: inset var(--wiki-focus-ring);
}

.history-trail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-1) var(--wiki-space-1) var(--wiki-space-3);
}

.history-trail-heading {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--wiki-space-1);

  strong {
    color: rgb(var(--v-theme-on-surface));
    font-size: .8125rem;
    font-weight: 650;
  }
}

.history-live-chip {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--wiki-space-1);
  padding: .25rem .5rem;
  border: 1px solid var(--wiki-surface-border);
  border-radius: 999px;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 70%, transparent);
  font-size: .75rem;
  font-weight: 650;
}

.history-refreshing,
.history-refresh-error,
.history-end-state {
  display: flex;
  align-items: center;
  gap: var(--wiki-space-2);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
  font-size: .8125rem;
}

.history-refreshing {
  padding: 0 var(--wiki-space-1) var(--wiki-space-2);
}

.history-refresh-error {
  margin: 0 0 var(--wiki-space-2);
  padding: var(--wiki-space-2);
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-error)) 28%, transparent);
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 6%, var(--wiki-surface-raised));
  color: rgb(var(--v-theme-on-surface));
}

.history-refresh-error span {
  min-width: 0;
  flex: 1 1 auto;
}

.history-revision-list {
  overflow: hidden;
  border-block: 1px solid var(--wiki-surface-border);
}

.history-revision-row {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-bottom: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-raised);

  &:last-child {
    border-bottom: 0;
  }

  &::before {
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    width: .2rem;
    background: transparent;
    content: '';
  }

  &--target::before {
    background: rgb(var(--v-theme-primary));
  }

  &--source::before {
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 50%, rgb(var(--v-theme-on-surface)));
  }
}

.history-revision-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  min-width: 0;
  flex: 1 1 auto;
  align-items: flex-start;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-3) var(--wiki-space-2) var(--wiki-space-3) var(--wiki-space-3);
  cursor: pointer;

  &[aria-disabled='true'] {
    cursor: default;
    opacity: .62;
  }

  &:focus-visible {
    outline: .125rem solid var(--wiki-focus-color);
    outline-offset: calc(var(--wiki-focus-offset) * -1);
    box-shadow: inset var(--wiki-focus-ring);
  }
}

.history-revision-date {
  grid-column: 1;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
  font-family: var(--wiki-font-mono);
  font-size: .7rem;
  line-height: 1.35;
}

.history-revision-copy {
  grid-column: 1 / -1;
  grid-row: 2;
  min-width: 0;
  flex: 1 1 auto;
}

.history-revision-action {
  overflow-wrap: anywhere;
  color: rgb(var(--v-theme-on-surface));
  font-size: .8125rem;
  line-height: 1.45;
}

.history-revision-selection {
  grid-column: 2;
  grid-row: 1;
  flex: 0 0 auto;
  align-self: flex-start;
  padding: .125rem .375rem;
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: 999px;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
  font-size: .65rem;
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
}

.history-revision-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-end;
  gap: 0;
  padding: 0 var(--wiki-space-2) var(--wiki-space-2);

  .v-btn {
    min-width: 0;
    min-height: var(--wiki-control-height);
    padding-inline: var(--wiki-space-2);
  }
}

.history-selection-button {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
  font-size: .7rem;
}

.history-selection-button[aria-pressed='true'] {
  color: rgb(var(--v-theme-primary));
}

.history-promptmenu,
.history-restore-dialog {
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-md);
}

.history-pagination {
  padding-top: var(--wiki-space-3);
}

.history-load-more {
  margin: 0 !important;
}

.history-end-state {
  justify-content: center;
  padding: var(--wiki-space-3) var(--wiki-space-1) var(--wiki-space-1);
}

.history-comparison-surface {
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius) !important;
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-sm);

  > .v-card-text {
    padding: var(--wiki-space-5);
  }
}

.history-comparison-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--wiki-space-5);
  padding-bottom: var(--wiki-space-4);
  border-bottom: 1px solid var(--wiki-surface-border);
}

.history-comparison-heading-copy {
  min-width: 0;
}

.history-comparison-heading {
  margin: var(--wiki-space-1) 0 0;
  color: rgb(var(--v-theme-on-surface));
  font-size: 1.15rem;
  font-weight: 720;
}

.history-comparison-range {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--wiki-space-2);
  margin-top: var(--wiki-space-2);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
  font-size: .8125rem;
}

.history-comparison-range-item {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--wiki-space-1);

  strong {
    color: rgb(var(--v-theme-on-surface));
    font-weight: 700;
  }
}

.history-comparison-controls {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--wiki-space-1);
  padding: .125rem;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
}

.history-view-choice {
  min-height: var(--wiki-control-height);
}

.history-comparison-details {
  padding-block: var(--wiki-space-4);
}

.history-comparison-title {
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-size: 1rem;
  font-weight: 700;
}

.history-comparison-description {
  margin-top: var(--wiki-space-1);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
}

.history-diff {
  overflow-x: auto;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius) !important;
  background: var(--wiki-surface-raised);
  direction: ltr;
  text-align: left;

  .d2h-file-wrapper {
    border: 0;
  }

  .d2h-file-header {
    display: none;
  }

  .d2h-wrapper {
    color: rgb(var(--v-theme-on-surface));
    font-family: var(--wiki-font-mono);
  }

  .d2h-code-line,
  .d2h-code-side-line,
  .d2h-code-linenumber,
  .d2h-code-side-linenumber {
    border-color: var(--wiki-surface-border);
    background: var(--wiki-surface-raised);
    color: rgb(var(--v-theme-on-surface));
  }

  .d2h-info {
    background: color-mix(in srgb, rgb(var(--v-theme-info)) 10%, var(--wiki-surface-raised));
    color: rgb(var(--v-theme-on-surface));
  }

  .d2h-del {
    background: color-mix(in srgb, rgb(var(--v-theme-error)) 12%, var(--wiki-surface-raised));
  }

  .d2h-ins {
    background: color-mix(in srgb, rgb(var(--v-theme-success)) 12%, var(--wiki-surface-raised));
  }
}

.history-restore-header {
  border-bottom: 1px solid color-mix(in srgb, rgb(var(--v-theme-warning)) 22%, transparent);
  background: color-mix(in srgb, rgb(var(--v-theme-warning)) 12%, var(--wiki-surface-raised));
  color: rgb(var(--v-theme-on-surface));
}

@media (min-width: 960px) {
  .history-shell-row {
    grid-template-columns: minmax(18rem, 22rem) minmax(0, 1fr);
  }

  .history-trail-panel {
    position: sticky;
    top: calc(var(--v-layout-top, var(--wiki-grid-size, 64px)) + var(--wiki-space-4));
    max-height: calc(100dvh - var(--v-layout-top, var(--wiki-grid-size, 64px)) - var(--v-layout-bottom, 0px) - var(--wiki-space-6) - var(--wiki-space-6));
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: var(--wiki-surface-border-strong) transparent;
  }
}

@media (max-width: 959.98px) {
  .history-toolbar {
    min-height: calc(var(--wiki-control-height) + var(--wiki-space-8)) !important;
    padding-inline: var(--wiki-space-3);
  }

  .history-toolbar-copy {
    max-width: calc(100vw - 5.75rem);
  }

  .history-live-action {
    min-width: var(--wiki-control-height);
    min-height: var(--wiki-control-height);
  }

  .history-shell {
    padding: var(--wiki-space-4) var(--wiki-space-3) var(--wiki-space-10) !important;
  }

  .history-trail-panel {
    overflow: visible;
  }
}

@media (max-width: 599px) {
  .history-toolbar-title {
    font-size: .875rem;
  }

  .history-shell {
    padding-inline: var(--wiki-space-2) !important;
  }

  .history-comparison-surface > .v-card-text {
    padding: var(--wiki-space-3);
  }

  .history-comparison-header {
    flex-direction: column;
    gap: var(--wiki-space-3);
  }

  .history-comparison-controls {
    width: 100%;

    .history-view-choice {
      flex: 1 1 50%;
    }
  }

  .history-revision-row {
    display: block;
  }

  .history-revision-main {
    padding-inline-end: var(--wiki-space-3);
  }

  .history-revision-actions {
    justify-content: flex-end;
    padding-top: 0;
    border-top: 1px solid var(--wiki-surface-border);
  }
}

@media (forced-colors: active) {
  .history-trail-panel,
  .history-revision-list,
  .history-revision-row,
  .history-comparison-surface,
  .history-diff,
  .history-promptmenu,
  .history-restore-dialog {
    border-color: CanvasText;
    box-shadow: none;
  }

  .history-revision-row::before {
    background: CanvasText;
  }

  .history-refresh-error {
    border-color: CanvasText;
    background: Canvas;
    color: CanvasText;
  }
}

@media (prefers-reduced-motion: reduce) {
  .history * {
    transition: none !important;
    scroll-behavior: auto !important;
  }
}

@media print {
  .history-trail-panel {
    position: static !important;
    max-height: none !important;
    overflow: visible !important;
    border: 0;
    background: transparent;
    box-shadow: none;
  }

  .history-live-action,
  .history-comparison-controls,
  .history-revision-actions,
  .history-pagination {
    display: none !important;
  }

  .history-comparison-surface {
    border: 0;
    box-shadow: none;
  }

  .history-diff {
    overflow: visible !important;
  }
}
</style>
