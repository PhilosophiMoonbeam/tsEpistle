<template lang='pug'>
  v-app.history
    nav-header
    v-main.history-main
      header.history-toolbar
        .history-toolbar-copy
          h1.history-toolbar-title {{ title }}
          .history-toolbar-meta
            span {{ $t('history:pageHistory') }}
            span.history-path-fragment(dir='ltr') /{{ path }}
            span(v-if='trailLoaded') {{ $t('history:revisionCount', { count: total }) }}
        v-btn.history-live-action(
          variant='flat'
          color='primary'
          size='small'
          prepend-icon='mdi-arrow-left'
          @click='goLive'
        ) {{ $t('history:backToPage') }}
      v-container.history-shell(fluid)
        v-row.history-shell-row
          v-col.history-trail-column(cols='12')
            .history-trail-panel(ref='trailContainer', tabindex='0', role='region', :aria-label='$t(`history:regionLabel`)', @scroll.passive='onTrailScroll')
              .history-refreshing(v-if='trailLoading && trail.length > 0', role='status', aria-live='polite')
                v-progress-circular(indeterminate, size='16', width='2', color='primary', aria-hidden='true')
                span {{ $t('history:refreshing') }}
              async-state(
                v-if='trailLoading && trail.length === 0'
                state='loading'
                :title='$t(`history:loadingTitle`)'
                :message='$t(`history:loadingMessage`)'
              )
              async-state(
                v-else-if='trailError && trail.length === 0'
                state='error'
                :title='$t(`history:loadErrorTitle`)'
                :message='trailError'
                :retry-label='$t(`history:retry`)'
                @retry='loadHistory'
              )
              async-state(
                v-else-if='trailLoaded && trail.length === 0'
                state='empty'
                :title='$t(`history:emptyTitle`)'
                :message='$t(`history:emptyMessage`)'
              )
              template(v-else)
                .history-refresh-error(v-if='trailError', role='alert')
                  v-icon(size='small', aria-hidden='true') mdi-alert-circle-outline
                  span {{ trailError }}
                  v-btn(size='small', variant='text', color='primary', @click='loadHistory') {{ $t('history:retry') }}
                ol.history-revision-list(v-if='trail.length > 0', :aria-label='$t(`history:listLabel`)')
                  li.history-revision-row(
                    v-for='row in trailRows'
                    :key='row.item.versionId'
                    :class='{ "history-revision-row--target": diffTarget === row.item.versionId, "history-revision-row--source": diffSource === row.item.versionId }'
                  )
                    .history-revision-main(
                      role='button'
                      :tabindex='row.selectable ? 0 : -1'
                      :aria-disabled='!row.selectable'
                      :aria-current='diffTarget === row.item.versionId ? `true` : undefined'
                      :aria-label='row.label'
                      @click='selectVersion(row.index)'
                      @keydown.enter.prevent='selectVersion(row.index)'
                      @keydown.space.prevent='selectVersion(row.index)'
                    )
                      .history-revision-heading
                        time.history-revision-date(v-if='row.time', :datetime='row.time.iso') {{ row.time.short }}
                          v-tooltip(activator='parent', location='top', :open-delay='400') {{ row.time.full }}
                        span.history-revision-badge.history-revision-badge--current(v-if='row.item.versionId === 0') {{ $t('history:current') }}
                        span.history-revision-badge.history-revision-badge--newer(v-if='diffTarget === row.item.versionId') {{ $t('history:newer') }}
                        span.history-revision-badge(v-if='diffSource === row.item.versionId') {{ $t('history:older') }}
                      .history-revision-action
                        template(v-for='(part, partIndex) in row.parts', :key='partIndex')
                          bdi.history-revision-value(v-if='part.value', :class='{ "history-path-fragment": part.value !== `author` }') {{ part.text }}
                          template(v-else) {{ part.text }}
                      .history-revision-hint(v-if='!row.selectable') {{ $t('history:loadOlderToCompare') }}
                    .history-revision-actions
                      v-btn.history-compare-button(
                        v-if='row.canCompare'
                        size='small'
                        variant='text'
                        prepend-icon='mdi-compare-horizontal'
                        :aria-label='$t(`history:compareLabel`, { revision: row.name })'
                        @click.stop='setDiffSource(row.item.versionId)'
                      ) {{ $t('history:compare') }}
                      v-menu(location='bottom end')
                        template(v-slot:activator='{ props }')
                          v-btn.history-more-button(
                            v-bind='props'
                            icon='mdi-dots-horizontal'
                            size='small'
                            variant='text'
                            :aria-label='$t(`history:moreActions`, { revision: row.name })'
                            @click.stop
                          )
                        v-list.history-promptmenu(density='compact', nav)
                          v-list-item(prepend-icon='mdi-code-tags', :title='$t(`history:menu.viewSource`)', @click='viewSource(row.item.versionId)')
                          v-list-item(prepend-icon='mdi-download-outline', :title='$t(`history:menu.download`)', @click='download(row.item.versionId)')
                          v-list-item(v-if='row.item.versionId !== 0', prepend-icon='mdi-history', :title='$t(`history:menu.restore`)', @click='restore(row.item.versionId, row.item.versionDate)')
                          v-list-item(prepend-icon='mdi-source-branch', :title='$t(`history:menu.branch`)', @click='branchOff(row.item.versionId)')
                .history-pagination(v-if='trailLoaded && trail.length > 0')
                  v-btn.history-load-more(
                    v-if='total > trail.length && !paginationError'
                    block
                    color='primary'
                    variant='tonal'
                    @click='loadMore'
                    :loading='loadingMore'
                    :disabled='loadingMore || trailLoading'
                  ) {{ $t('history:loadOlder') }}
                  async-state(
                    v-if='paginationError'
                    state='error'
                    :title='$t(`history:olderErrorTitle`)'
                    :message='paginationError'
                    :retry-label='$t(`history:retry`)'
                    @retry='loadMore'
                  )
                  .history-end-state(v-else-if='total <= trail.length', role='status')
                    span {{ $t('history:firstRevision') }}
          v-col.history-comparison-column(cols='12')
            section.history-comparison-surface(v-if='trailLoaded && trail.length > 0', aria-labelledby='history-comparison-heading')
              .history-comparison-header
                .history-comparison-heading-copy
                  h2#history-comparison-heading.history-comparison-heading(ref='comparisonHeading', tabindex='-1') {{ $t('history:comparison.heading') }}
                  .history-comparison-range(aria-live='polite')
                    span.history-comparison-range-item
                      span.history-comparison-side {{ $t('history:older') }}
                      strong {{ sourceSelectionLabel }}
                    v-icon(size='small', aria-hidden='true') mdi-arrow-right
                    span.history-comparison-range-item
                      span.history-comparison-side {{ $t('history:newer') }}
                      strong {{ targetSelectionLabel }}
                .history-comparison-controls(role='group', :aria-label='$t(`history:comparison.formatLabel`)')
                  v-btn.history-view-choice(
                    size='small'
                    :variant='viewMode === `line-by-line` ? `flat` : `text`'
                    :color='viewMode === `line-by-line` ? `primary` : undefined'
                    :aria-pressed='viewMode === `line-by-line`'
                    @click='setViewMode(`line-by-line`)'
                  ) {{ $t('history:comparison.unified') }}
                  v-btn.history-view-choice(
                    size='small'
                    :variant='viewMode === `side-by-side` ? `flat` : `text`'
                    :color='viewMode === `side-by-side` ? `primary` : undefined'
                    :aria-pressed='viewMode === `side-by-side`'
                    @click='setViewMode(`side-by-side`)'
                  ) {{ $t('history:comparison.sideBySide') }}
              .history-comparison-details(v-if='targetReady')
                h3.history-comparison-title {{ target.title }}
                .history-comparison-description(v-if='target.description') {{ target.description }}
                .history-revision-meta
                  span(v-for='item in targetMetadata', :key='item') {{ item }}
              async-state(
                v-if='comparisonLoading'
                state='loading'
                :title='$t(`history:comparison.loadingTitle`)'
                :message='$t(`history:comparison.loadingMessage`)'
              )
              async-state(
                v-else-if='sourceError'
                state='error'
                :title='$t(`history:comparison.olderUnavailable`)'
                :message='sourceError'
                :retry-label='$t(`history:retry`)'
                @retry='retrySource'
              )
              async-state(
                v-else-if='targetError'
                state='error'
                :title='$t(`history:comparison.newerUnavailable`)'
                :message='targetError'
                :retry-label='$t(`history:retry`)'
                @retry='retryTarget'
              )
              template(v-else-if='comparisonRendering')
                async-state(
                  v-if='diffSlow'
                  state='loading'
                  :title='$t(`history:comparison.renderingTitle`)'
                  :message='$t(`history:comparison.renderingMessage`)'
                )
                .history-diff-pending(v-else, aria-hidden='true')
              template(v-else-if='comparisonProblem')
                async-state(
                  state='error'
                  :title='$t(`history:comparison.${comparisonProblem}Title`)'
                  :message='$t(`history:comparison.${comparisonProblem}Message`)'
                  :retry-label='comparisonProblem === `limit` ? undefined : $t(`history:retry`)'
                  @retry='retryComparison'
                )
                .history-problem-actions(v-if='comparisonProblem === `limit`')
                  v-btn(size='small', variant='text', color='primary', prepend-icon='mdi-code-tags', @click='viewSource(diffTarget)') {{ $t('history:comparison.viewNewerSource') }}
              async-state(
                v-else-if='comparisonEmpty'
                state='empty'
                :title='$t(`history:comparison.noChangesTitle`)'
                :message='$t(`history:comparison.noChangesMessage`)'
              )
              .history-diff(v-else-if='diffHTML', dir='ltr')
                div(v-html='diffHTML')
    v-dialog(
      v-model='isRestoreConfirmDialogShown'
      max-width='560'
      persistent
      :aria-label='$t(`history:restore.confirmTitle`)'
    )
      v-card.history-restore-dialog
        v-card-title.history-restore-header {{ $t('history:restore.confirmTitle') }}
        v-card-text.history-restore-text {{ $t('history:restore.confirmText', { date: restoreDateLabel, interpolation: { escapeValue: false } }) }}
        v-card-actions
          v-spacer
          v-btn(variant='text', @click='isRestoreConfirmDialogShown = false', :disabled='restoreLoading') {{ $t('common:actions.cancel') }}
          v-btn(color='warning', variant='flat', @click='restoreConfirm', :loading='restoreLoading') {{ $t('history:restore.confirmButton') }}
    page-selector(mode='create', v-model='branchOffOpts.modal', :open-handler='branchOffHandle', :path='branchOffOpts.path', :locale='branchOffOpts.locale')
    nav-footer
    notify
    search-results
</template>

<script lang='ts'>
import { markRaw, onWatcherCleanup } from 'vue'
import AsyncState from '@/components/common/async-state.vue'
import { fetchPageHistory, fetchPageVersion, restorePageVersion, type PageHistoryTrailItem, type PageVersion } from '../helpers/pages-api'
import { getPageDownloadPath, getPageSourcePath } from '../helpers/page-actions'
import { getErrorMessage, loadingStart, loadingStop, setLoading, showNotification } from '../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'
import { decodeBase64Json } from '../helpers/base64'
import { createHistoryDiffRenderer, type HistoryDiffRenderer } from '../helpers/history-diff-client'
import type { HistoryDiffOutcome, HistoryDiffRequest } from '../helpers/history-diff'
import { formatRevisionTime, friendlyEditorName, translatedParts, type RevisionTime, type TranslatedPart } from '../helpers/history-presentation'

const HISTORY_PAGE_SIZE = 25
// Loaded revision contents kept for quick re-selection. The live version, the
// two compared revisions and the newest saved revision are always kept.
const MAX_CACHED_VERSIONS = 12
// Show the "Comparing revisions" state only when a comparison is slow, so a
// fast comparison does not flash a loading card.
const SLOW_COMPARISON_MS = 200

type HistorySide = 'source' | 'target'
type ComparisonProblem = 'limit' | 'failed' | 'timeout'
type HistoryRow = {
  readonly item: PageHistoryTrailItem
  readonly index: number
  readonly name: string
  readonly time: RevisionTime | null
  readonly parts: TranslatedPart[]
  readonly selectable: boolean
  readonly canCompare: boolean
  readonly label: string
}

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
      requestsAbortController: markRaw(new AbortController()),
      diffRenderer: null as HistoryDiffRenderer | null,
      diffOutcome: null as HistoryDiffOutcome | null,
      diffRendering: false,
      diffSlow: false,
      diffRenderId: 0,
      diffSlowTimer: null as number | null
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
    trailIndexById (): Map<number, number> {
      const indexes = new Map<number, number>()
      this.fullTrail.forEach((item, index) => indexes.set(item.versionId, index))
      return indexes
    },
    trailRows (): HistoryRow[] {
      return this.fullTrail.map((item, index) => {
        const selectable = this.canSelectVersion(index)
        return {
          item,
          index,
          name: this.revisionName(item.versionId),
          time: formatRevisionTime(item.versionDate),
          parts: this.revisionActionParts(item),
          selectable,
          canCompare: this.diffSource !== item.versionId && this.canSetDiffSource(item.versionId),
          label: this.revisionAriaLabel(item, index)
        }
      })
    },
    sourceSelectionLabel () {
      if (this.diffSource === -1) return this.$t('history:emptyBaseline')
      return this.revisionName(this.diffSource)
    },
    targetSelectionLabel () {
      return this.revisionName(this.diffTarget)
    },
    targetMetadata (): string[] {
      const items = [this.revisionName(this.target.versionId)]
      const time = formatRevisionTime(this.target.versionDate)
      if (time) items.push(time.short)
      const editor = friendlyEditorName(this.target.editor)
      if (editor) items.push(editor)
      if (this.target.visibility === 'private') items.push(this.$t('history:comparison.private'))
      if (this.target.isPublished === false) items.push(this.$t('history:comparison.unpublished'))
      const tags = Array.isArray(this.target.tags) ? this.target.tags.filter(tag => typeof tag === 'string' && tag) : []
      if (tags.length > 0) items.push(this.$t('history:comparison.tags', { tags: tags.join(', '), interpolation: { escapeValue: false } }))
      return items
    },
    restoreDateLabel (): string {
      return formatRevisionTime(this.restoreTarget.versionDate)?.full ?? ''
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
    comparisonRequest (): HistoryDiffRequest | null {
      if (!this.comparisonReady) return null
      return {
        key: `${this.source.versionId}:${this.target.versionId}`,
        path: this.path,
        source: typeof this.source.content === 'string' ? this.source.content : '',
        target: typeof this.target.content === 'string' ? this.target.content : '',
        format: this.viewMode
      }
    },
    comparisonRequestKey (): string {
      const request = this.comparisonRequest
      return request ? `${request.key}|${request.format}` : ''
    },
    comparisonRendering (): boolean {
      return Boolean(this.comparisonRequest && (this.diffRendering || !this.diffOutcome))
    },
    diffHTML (): string {
      return this.diffOutcome?.status === 'ready' ? this.diffOutcome.html : ''
    },
    comparisonProblem (): ComparisonProblem | '' {
      const status = this.diffOutcome?.status
      return status === 'limit' || status === 'failed' || status === 'timeout' ? status : ''
    },
    comparisonEmpty (): boolean {
      return this.diffOutcome?.status === 'empty'
    }
  },
  watch: {
    trail () {
      this.reconcileSelections()
    },
    comparisonRequestKey () {
      void this.renderComparison()
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
    this.cache.push(markRaw({
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
    }))
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
    this.diffRenderId += 1
    this.clearDiffSlowTimer()
    this.diffRenderer?.dispose()
    this.diffRenderer = null
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
        const stored = markRaw(page)
        this.cache.push(stored)
        this.pruneVersionCache(stored.versionId)
        return stored
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
          showNotification(wikiStore, { style: 'red', message: this.$t('history:olderUnavailableNotice', { message, interpolation: { escapeValue: false } }), icon: 'alert' })
        } else {
          this.targetError = message
          this.targetReady = false
          showNotification(wikiStore, { style: 'red', message: this.$t('history:newerUnavailableNotice', { message, interpolation: { escapeValue: false } }), icon: 'alert' })
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
          window.location.assign(this.livePath())
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
    livePath (): string {
      const privatePrefix = this.visibility === 'private' ? '/_private' : ''
      return `${privatePrefix}/${this.locale}/${this.path}`
    },
    goLive () {
      window.location.assign(this.livePath())
    },
    revisionName (versionId: number): string {
      if (versionId === 0) return this.$t('history:currentVersion')
      return this.$t('history:revisionNumber', { id: versionId })
    },
    revisionActionParts (item: PageHistoryTrailItem): TranslatedPart[] {
      const author = item.authorName || ''
      const translate = (key: string) => (values: Record<string, string>) => this.$t(key, { ...values, interpolation: { escapeValue: false } })
      if (item.actionType === 'move') {
        return translatedParts(translate('history:action.move'), {
          from: `/${item.valueBefore ?? ''}`.replace(/^\/+/, '/'),
          to: `/${item.valueAfter ?? ''}`.replace(/^\/+/, '/'),
          author
        })
      }
      const key = item.actionType === 'edit' || item.actionType === 'initial' || item.actionType === 'live' ? item.actionType : 'other'
      return translatedParts(translate(`history:action.${key}`), { author })
    },
    revisionAriaLabel (item: PageHistoryTrailItem, index: number) {
      const values = {
        revision: this.revisionName(item.versionId),
        date: formatRevisionTime(item.versionDate)?.full ?? '',
        interpolation: { escapeValue: false }
      }
      if (!this.canSelectVersion(index)) return this.$t('history:selectRevisionUnavailable', values)
      return this.$t('history:selectRevision', values)
    },
    pruneVersionCache (keepVersionId: number) {
      const extra = this.cache.length - MAX_CACHED_VERSIONS
      if (extra <= 0) return
      const keep = new Set([0, keepVersionId, this.diffSource, this.diffTarget, this.trail[0]?.versionId ?? 0])
      let remaining = extra
      this.cache = this.cache.filter(item => {
        if (remaining <= 0 || keep.has(item.versionId)) return true
        remaining -= 1
        return false
      })
    },
    getDiffRenderer (): HistoryDiffRenderer {
      this.diffRenderer ??= markRaw(createHistoryDiffRenderer())
      return this.diffRenderer
    },
    clearDiffSlowTimer () {
      if (this.diffSlowTimer !== null) {
        window.clearTimeout(this.diffSlowTimer)
        this.diffSlowTimer = null
      }
    },
    async renderComparison (): Promise<void> {
      const renderId = ++this.diffRenderId
      this.clearDiffSlowTimer()
      this.diffSlow = false
      const request = this.comparisonRequest
      if (this.isUnmounted || !request) {
        this.diffOutcome = null
        this.diffRendering = false
        return
      }
      const renderer = this.getDiffRenderer()
      const cached = renderer.peek(request)
      if (cached) {
        this.diffOutcome = markRaw(cached)
        this.diffRendering = false
        return
      }
      this.diffOutcome = null
      this.diffRendering = true
      this.diffSlowTimer = window.setTimeout(() => {
        this.diffSlowTimer = null
        if (renderId === this.diffRenderId) this.diffSlow = true
      }, SLOW_COMPARISON_MS)
      const outcome = await renderer.render(request)
      if (renderId !== this.diffRenderId || this.isUnmounted) return
      this.clearDiffSlowTimer()
      this.diffOutcome = markRaw(outcome)
      this.diffRendering = false
      this.diffSlow = false
      this.preserveTrailScroll()
    },
    retryComparison () {
      void this.renderComparison()
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
      const sourceIndex = this.trailIndexById.get(versionId)
      const targetIndex = this.trailIndexById.get(this.diffTarget)
      return sourceIndex !== undefined && (this.diffTarget === 0 || targetIndex === undefined || sourceIndex > targetIndex)
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
  display: flex;
  align-items: center;
  gap: var(--wiki-space-4);
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-10));
  padding: var(--wiki-space-3) var(--wiki-page-gutter);
  border-bottom: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-raised);
}

.history-toolbar-copy {
  min-width: 0;
  flex: 1 1 auto;
}

.history-toolbar-title {
  overflow: hidden;
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-size: 1.125rem;
  font-weight: 650;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-path-fragment {
  font-family: var(--wiki-font-mono);
  direction: ltr;
  unicode-bidi: isolate;
}

.history-toolbar-meta,
.history-revision-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--wiki-space-1) var(--wiki-space-2);
  margin-top: var(--wiki-space-1);
  color: var(--wiki-text-muted);
  font-size: .8125rem;

  > span {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  > span + span::before {
    margin-inline-end: var(--wiki-space-2);
    color: var(--wiki-text-subtle);
    content: '·';
  }
}

.history-live-action {
  flex: 0 0 auto;
}

.history-live-action,
.history-load-more,
.history-view-choice,
.history-compare-button {
  border-radius: var(--wiki-control-radius);
  font-weight: 650;
  letter-spacing: 0;
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
  margin: 0;

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
  padding: var(--wiki-space-2);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
}

.history-trail-panel:focus-visible {
  outline: .125rem solid var(--wiki-focus-color);
  outline-offset: calc(var(--wiki-focus-offset) * -1);
  box-shadow: inset var(--wiki-focus-ring);
}

.history-refreshing,
.history-refresh-error,
.history-end-state {
  display: flex;
  align-items: center;
  gap: var(--wiki-space-2);
  color: var(--wiki-text-muted);
  font-size: .8125rem;
}

.history-refreshing {
  padding: var(--wiki-space-1) var(--wiki-space-2) var(--wiki-space-2);
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
  margin: 0;
  padding: 0;
  list-style: none;
}

.history-revision-row {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: var(--wiki-space-1);
  border-radius: var(--wiki-control-radius);
  // Rows far outside the viewport skip layout and paint on long histories.
  content-visibility: auto;
  contain-intrinsic-size: auto 4.5rem;

  & + & {
    margin-top: 1px;
  }

  &::before {
    position: absolute;
    inset-block: var(--wiki-space-2);
    inset-inline-start: 0;
    width: .1875rem;
    border-radius: 999px;
    background: transparent;
    content: '';
  }

  &:hover {
    background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 4%, transparent);
  }

  &--target,
  &--target:hover {
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 9%, transparent);
  }

  &--target::before {
    background: rgb(var(--v-theme-primary));
  }

  &--source::before {
    background: var(--wiki-text-muted);
  }
}

.history-revision-main {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: .125rem;
  padding: var(--wiki-space-2) var(--wiki-space-2) var(--wiki-space-2) var(--wiki-space-3);
  border-radius: var(--wiki-control-radius);
  cursor: pointer;

  &[aria-disabled='true'] {
    cursor: default;
  }

  &:focus-visible {
    outline: .125rem solid var(--wiki-focus-color);
    outline-offset: calc(var(--wiki-focus-offset) * -1);
    box-shadow: inset var(--wiki-focus-ring);
  }
}

.history-revision-heading {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--wiki-space-1) var(--wiki-space-2);
}

.history-revision-date {
  color: rgb(var(--v-theme-on-surface));
  font-size: .8125rem;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  line-height: 1.35;
}

.history-revision-badge {
  padding: 0 .4375rem;
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: 999px;
  color: var(--wiki-text-muted);
  font-size: .6875rem;
  font-weight: 650;
  line-height: 1.125rem;

  &--current {
    border-color: color-mix(in srgb, rgb(var(--v-theme-success)) 45%, transparent);
    background: color-mix(in srgb, rgb(var(--v-theme-success)) 10%, transparent);
    color: rgb(var(--v-theme-on-surface));
  }
}

.history-revision-badge--newer {
  border-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 50%, transparent);
  color: rgb(var(--v-theme-on-surface));
}

.history-revision-action {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--wiki-text-muted);
  font-size: .8125rem;
  line-height: 1.45;
}

.history-revision-value {
  color: rgb(var(--v-theme-on-surface));
  font-weight: 600;
}

.history-revision-hint {
  color: var(--wiki-text-muted);
  font-size: .75rem;
  font-style: italic;
}

.history-revision-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0;
  padding: var(--wiki-space-1) var(--wiki-space-1) 0 0;

  .v-btn {
    min-width: 0;
  }
}

.history-compare-button {
  color: var(--wiki-text-muted);
  font-size: .75rem;

  &:hover,
  &:focus-visible {
    color: rgb(var(--v-theme-primary));
  }
}

.history-more-button {
  color: var(--wiki-text-muted);
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
  padding: var(--wiki-space-2) var(--wiki-space-1) var(--wiki-space-1);
}

.history-load-more {
  margin: 0 !important;
}

.history-end-state {
  justify-content: center;
  padding: var(--wiki-space-2) var(--wiki-space-1);
}

.history-comparison-surface {
  overflow: hidden;
  padding: var(--wiki-space-5);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-sm);
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
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-size: 1.125rem;
  font-weight: 700;

  &:focus-visible {
    outline: .125rem solid var(--wiki-focus-color);
    outline-offset: var(--wiki-focus-offset);
  }
}

.history-comparison-range {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--wiki-space-2);
  margin-top: var(--wiki-space-1);
  color: var(--wiki-text-muted);
  font-size: .8125rem;
}

.history-comparison-range-item {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--wiki-space-1);

  strong {
    color: rgb(var(--v-theme-on-surface));
    font-weight: 650;
  }
}

.history-comparison-side {
  color: var(--wiki-text-muted);
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
  font-weight: 650;
}

.history-comparison-description {
  margin-top: var(--wiki-space-1);
  color: var(--wiki-text-muted);
}

.history-diff-pending {
  min-height: 7rem;
}

.history-problem-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--wiki-space-2);
  padding-top: var(--wiki-space-2);
}

.history-diff {
  overflow-x: auto;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius) !important;
  background: var(--wiki-surface-raised);
  direction: ltr;
  text-align: left;

  .d2h-file-wrapper {
    margin: 0;
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

  .d2h-code-linenumber,
  .d2h-code-side-linenumber {
    color: var(--wiki-text-muted);
  }

  .d2h-info {
    background: color-mix(in srgb, rgb(var(--v-theme-info)) 10%, var(--wiki-surface-raised));
    color: var(--wiki-text-muted);
  }

  .d2h-del {
    background: color-mix(in srgb, rgb(var(--v-theme-error)) 12%, var(--wiki-surface-raised));
  }

  .d2h-ins {
    background: color-mix(in srgb, rgb(var(--v-theme-success)) 12%, var(--wiki-surface-raised));
  }

  del,
  .d2h-del .d2h-change {
    background: color-mix(in srgb, rgb(var(--v-theme-error)) 28%, var(--wiki-surface-raised));
  }

  ins,
  .d2h-ins .d2h-change {
    background: color-mix(in srgb, rgb(var(--v-theme-success)) 28%, var(--wiki-surface-raised));
  }

  .d2h-emptyplaceholder,
  .d2h-code-side-emptyplaceholder {
    border-color: var(--wiki-surface-border);
    background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 4%, var(--wiki-surface-raised));
  }
}

.history-restore-header {
  padding: var(--wiki-space-4) var(--wiki-space-5) var(--wiki-space-2);
  color: rgb(var(--v-theme-on-surface));
  font-size: 1.125rem;
  font-weight: 650;
  white-space: normal;
}

.history-restore-text {
  padding-inline: var(--wiki-space-5) !important;
  color: var(--wiki-text-muted);
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
    padding-inline: var(--wiki-space-3);
  }

  .history-shell {
    padding: var(--wiki-space-4) var(--wiki-space-3) var(--wiki-space-10) !important;
  }

  .history-trail-panel {
    overflow: visible;
  }
}

@media (max-width: 599px) {
  .history-toolbar {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--wiki-space-2);
  }

  .history-toolbar-title {
    font-size: 1rem;
    white-space: normal;
  }

  .history-shell {
    padding-inline: var(--wiki-space-2) !important;
  }

  .history-comparison-surface {
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
}

@media (forced-colors: active) {
  .history-trail-panel,
  .history-comparison-surface,
  .history-diff,
  .history-promptmenu,
  .history-restore-dialog,
  .history-revision-badge {
    border-color: CanvasText;
    box-shadow: none;
  }

  .history-revision-row--target,
  .history-revision-row--source {
    outline: 1px solid CanvasText;
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

  .history-revision-row {
    content-visibility: visible;
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
