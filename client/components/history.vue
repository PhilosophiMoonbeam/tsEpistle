<template lang='pug'>
  v-app().history
    nav-header
    v-main.history-main
      v-toolbar.history-toolbar(color='surface', flat)
        .history-toolbar-copy
          .history-eyebrow Revision history
          h1.history-toolbar-title Viewing history of #[strong.history-path-fragment /{{path}}]
          .history-toolbar-meta(v-if='$vuetify.display.mdAndUp')
            span {{total}} revisions
            span Page {{pageId}}
        v-spacer
        v-btn.history-live-action(variant='flat', color='primary', size='small', @click='goLive', aria-label='Return to live version')
          v-icon(v-if='$vuetify.display.smAndDown') mdi-close
          span(v-else) Return to Live Version
      v-container.history-shell(fluid)
        v-row
          v-col.history-trail-column(cols='12', md='4')
            v-chip.history-live-chip.my-0(
              label
              size="small"
              color='primary'
              variant='tonal'
              )
              v-icon(start, size='small') mdi-access-point
              span Live
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
              retry-label='Try again'
              @retry='loadHistory'
            )
            v-timeline.history-timeline(
              v-else
              density="compact"
              )
              v-timeline-item.pb-2(
                v-for='(ph, idx) in fullTrail'
                :key='ph.versionId'
                :size="ph.actionType === `edit` ? 'small' : undefined"
                :dot-color='trailColor(ph.actionType)'
                :icon='trailIcon(ph.actionType)'
                )
                v-card.history-revision-card.radius-7(
                  flat
                  :class='trailBgColor(ph.actionType)'
                )
                  .history-revision-summary(
                    role='button'
                    :tabindex='canSelectVersion(idx) ? 0 : -1'
                    :aria-disabled='!canSelectVersion(idx)'
                    :aria-label='canSelectVersion(idx) ? `Compare revision from ${$helpers.formatMoment(ph.versionDate, `LLL`)}` : `Revision from ${$helpers.formatMoment(ph.versionDate, `LLL`)} has no earlier comparison source`'
                    @click='selectVersion(idx)'
                    @keydown.enter.prevent='selectVersion(idx)'
                    @keydown.space.prevent='selectVersion(idx)'
                  )
                    .history-revision-copy
                      .text-body-small(:title='$helpers.formatMoment(ph.versionDate, `LLL`)') {{ $helpers.formatMoment(ph.versionDate, 'll') }}
                      v-divider.mx-3(vertical)
                      .text-body-small.history-revision-description(
                        v-if='ph.actionType === `edit`'
                        :title='`Edited by ${ph.authorName}`'
                      ) Edited by #[strong {{ ph.authorName }}]
                      .text-body-small.history-revision-description(
                        v-else-if='ph.actionType === `move`'
                        :title='`Moved from ${ph.valueBefore} to ${ph.valueAfter} by ${ph.authorName}`'
                      ) Moved from #[strong.history-path-fragment {{ph.valueBefore}}] to #[strong.history-path-fragment {{ph.valueAfter}}] by #[strong {{ ph.authorName }}]
                      .text-body-small.history-revision-description(
                        v-else-if='ph.actionType === `initial`'
                        :title='`Created by ${ph.authorName}`'
                      ) Created by #[strong {{ ph.authorName }}]
                      .text-body-small.history-revision-description(
                        v-else-if='ph.actionType === `live`'
                        :title='`Last Edited by ${ph.authorName}`'
                      ) Last Edited by #[strong {{ ph.authorName }}]
                      .text-body-small.history-revision-description(
                        v-else
                        :title='`Unknown Action by ${ph.authorName}`'
                      ) Unknown Action by #[strong {{ ph.authorName }}]
                  .history-revision-actions
                    v-menu(location="start")
                      template(v-slot:activator='{ props }')
                        v-btn(
                          v-bind='props'
                          icon
                          size="small"
                          rounded='0'
                          :aria-label='`Actions for revision ${ph.versionId || `live`}`'
                          @click.stop
                        ): v-icon mdi-dots-horizontal
                      v-list(density="compact" nav).history-promptmenu
                        v-list-item(@click.stop='setDiffSource(ph.versionId)', :disabled='(ph.versionId >= diffTarget && diffTarget !== 0) || ph.versionId === 0')
                          template(v-slot:prepend)
                            v-avatar(size='24'): strong A
                          v-list-item-title Set as Differencing Source
                        v-list-item(@click.stop='setDiffTarget(ph.versionId)', :disabled='ph.versionId <= diffSource && ph.versionId !== 0')
                          template(v-slot:prepend)
                            v-avatar(size='24'): strong B
                          v-list-item-title Set as Differencing Target
                        v-list-item(@click.stop='viewSource(ph.versionId)')
                          template(v-slot:prepend)
                            v-avatar(size='24'): v-icon mdi-code-tags
                          v-list-item-title View Source
                        v-list-item(@click.stop='download(ph.versionId)')
                          template(v-slot:prepend)
                            v-avatar(size='24'): v-icon mdi-cloud-download-outline
                          v-list-item-title Download Version
                        v-list-item(@click.stop='restore(ph.versionId, ph.versionDate)', :disabled='ph.versionId === 0')
                          template(v-slot:prepend)
                            v-avatar(size='24'): v-icon mdi-history
                          v-list-item-title Restore
                        v-list-item(@click.stop='branchOff(ph.versionId)')
                          template(v-slot:prepend)
                            v-avatar(size='24'): v-icon mdi-source-branch
                          v-list-item-title Branch off from here
                    v-btn(
                      @click.stop='setDiffSource(ph.versionId)'
                      icon
                      size="small"
                      variant="flat"
                      rounded='0'
                      :aria-label='`Set revision ${ph.versionId} as differencing source`'
                      :aria-pressed='diffSource === ph.versionId'
                      :class='diffSource === ph.versionId ? `history-diff-active` : `history-diff-inactive`'
                      :disabled='(ph.versionId >= diffTarget && diffTarget !== 0) || ph.versionId === 0'
                    ): strong A
                    v-btn(
                      @click.stop='setDiffTarget(ph.versionId)'
                      icon
                      size="small"
                      variant="flat"
                      rounded='0'
                      :aria-label='`Set revision ${ph.versionId || `live`} as differencing target`'
                      :class='diffTarget === ph.versionId ? `history-diff-active` : `history-diff-inactive`'
                      :aria-pressed='diffTarget === ph.versionId'
                      :disabled='ph.versionId <= diffSource && ph.versionId !== 0'
                    ): strong B

            v-btn.history-load-more.ma-0.radius-7(
              v-if='total > trail.length'
              block
              color='primary'
              variant='tonal'
              @click='loadMore'
              :loading='loadingMore'
              :disabled='loadingMore'
              )
              .text-body-small Load More...

            v-chip.history-end-chip.ma-0(
              v-else-if='trailLoaded'
              label
              size="small"
              variant='outlined'
              )
              v-icon(start, size='small') mdi-archive-check-outline
              span End of history trail

          v-col.history-comparison-column(cols='12', md='8')
            async-state(
              v-if='trailLoading && !trailLoaded'
              state='loading'
              title='Loading page history'
              message='Fetching revision metadata.'
            )
            async-state(
              v-else-if='trailError && !trailLoaded'
              state='error'
              title='Page history could not be loaded'
              :message='trailError'
              retry-label='Try again'
              @retry='loadHistory'
            )
            v-card.history-comparison-card.radius-7(v-else-if='trailLoaded' :class='$vuetify.display.mdAndUp ? `mt-8` : ``')
              v-card-text
                v-card.history-comparison-frame.radius-7(flat)
                  v-row.history-comparison-summary.align-center(:gap='0')
                    v-col
                      v-card-text
                        h2#history-comparison-heading.history-comparison-heading(ref='comparisonHeading' tabindex='-1') {{target.title}}
                        .text-body-small.history-comparison-description {{target.description}}
                        .history-revision-meta
                          span {{ target.versionId === 0 ? 'Live version' : `Revision ${target.versionId}` }}
                          span {{ target.editor || 'unknown editor' }} / {{ target.contentType || 'unknown format' }}
                          span {{ target.visibility }}{{ target.isPublished === false ? ' / unpublished' : '' }}
                          span(v-if='target.tags.length > 0') Tags: {{ target.tags.join(', ') }}
                    v-col.history-comparison-controls.text-end.py-3(cols='auto')
                      v-btn.history-view-toggle.me-3(
                        color='primary'
                        size="small"
                        variant="outlined"
                        @click='toggleViewMode'
                        :aria-label='viewMode === `line-by-line` ? `Switch to side-by-side diff` : `Switch to line-by-line diff`'
                        :aria-pressed='viewMode === `side-by-side`'
                      )
                        v-icon(start) mdi-eye
                        span.text-label-small View: {{viewMode === 'line-by-line' ? 'Line by line' : 'Side by side'}}
                v-card.mt-3.history-diff(flat dir='ltr' aria-labelledby='history-comparison-heading')
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
          v-btn(variant="text", @click='isRestoreConfirmDialogShown = false', :disabled='restoreLoading') {{$t('common:actions.cancel')}}
          v-btn(color="warning", variant='flat', @click='restoreConfirm', :loading='restoreLoading') {{$t('history:restore.confirmButton')}}

    page-selector(mode='create', v-model='branchOffOpts.modal', :open-handler='branchOffHandle', :path='branchOffOpts.path', :locale='branchOffOpts.locale')

    nav-footer
    notify
    search-results</template>

<script lang='ts'>
import { markRaw } from 'vue'
import * as Diff2Html from 'diff2html'
import { createPatch } from 'diff'
import AsyncState from '@/components/common/async-state.vue'
import { fetchPageHistory, fetchPageVersion, restorePageVersion, type PageHistoryTrailItem, type PageVersion } from '../helpers/pages-api'
import { getPageDownloadPath, getPageSourcePath } from '../helpers/page-actions'
import { getErrorMessage, loadingStart, loadingStop, setLoading, showNotification } from '../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'
import { decodeBase64Json } from '../helpers/base64'

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
      trail: [] as PageHistoryTrailItem[],
      diffSource: 0,
      diffTarget: 0,
      offsetPage: 0,
      total: 0,
      viewMode: 'line-by-line' as 'line-by-line' | 'side-by-side',
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
      trailLoading: true,
      trailLoaded: false,
      loadingMore: false,
      restoreLoading: false,
      restoreRedirectTimer: null as number | null,
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
      // -> Check for move between latest and live
      const prevPage = this.cache.find(page => page.versionId === (this.trail[0]?.versionId ?? -1))
      if (prevPage && this.path !== prevPage.path) {
        liveTrailItem.actionType = 'move'
        liveTrailItem.valueBefore = prevPage.path
        liveTrailItem.valueAfter = this.path
      }
      // -> Combine trail with live
      return [
        liveTrailItem,
        ...this.trail
      ]
    },
    diffs () {
      return createPatch(`/${this.path}`, this.source.content, this.target.content)
    },
    diffHTML () {
      return Diff2Html.html(this.diffs, {
        drawFileList: false,
        matching: 'lines',
        outputFormat: this.viewMode
      })
    }
  },
  watch: {
    trail (newValue: PageHistoryTrailItem[], oldValue: PageHistoryTrailItem[]) {
      if (newValue.length > 0 && oldValue.length === 0) {
        this.diffTarget = 0
        this.diffSource = newValue[0]!.versionId
      }
    },
    async diffSource (
      newValue: number,
      _oldValue: number,
      onCleanup: (cleanup: () => void) => void
    ) {
      if (newValue === this.source.versionId) return

      if (newValue === -1) {
        this.source = {
          ...emptyPageVersion(-1),
          path: this.path,
          locale: this.locale
        }
        return
      }

      let cancelled = false
      onCleanup(() => {
        cancelled = true
      })
      const page = this.cache.find(page => page.versionId === newValue) ?? await this.loadVersion(newValue)
      if (!cancelled && this.diffSource === newValue) {
        this.source = page
      }
    },
    async diffTarget (
      newValue: number,
      _oldValue: number,
      onCleanup: (cleanup: () => void) => void
    ) {
      if (newValue === this.target.versionId) return

      let cancelled = false
      onCleanup(() => {
        cancelled = true
      })
      const page = this.cache.find(page => page.versionId === newValue) ?? await this.loadVersion(newValue)
      if (!cancelled && this.diffTarget === newValue) {
        this.target = page
      }
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
  mounted() {
    void this.loadHistory()
  },
  beforeUnmount() {
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
    async loadVersion (versionId: number): Promise<PageVersion> {
      loadingStart(wikiStore, 'history-version-' + versionId)
      try {
        const page = await fetchPageVersion(this.fetchWithAbort, this.pageId, versionId)
        if (this.requestsAbortController.signal.aborted) {
          return { ...emptyPageVersion(versionId), path: this.path, locale: this.locale }
        }
        this.cache.push(page)
        return page
      } catch (err) {
        if (!this.requestsAbortController.signal.aborted) {
          showNotification(wikiStore, {
            style: 'red',
            message: getErrorMessage(err),
            icon: 'alert'
          })
        }
        return { ...emptyPageVersion(versionId), path: this.path, locale: this.locale }
      } finally {
        loadingStop(wikiStore, 'history-version-' + versionId)
      }
    },
    viewSource (versionId: number) {
      window.location.assign(getPageSourcePath(this.locale, this.path, versionId, this.visibility === 'private' ? 'private' : 'public'))
    },
    download (versionId: number) {
      window.location.assign(getPageDownloadPath(this.locale, this.path, versionId, this.visibility === 'private' ? 'private' : 'public'))
    },
    restore (versionId: number, versionDate: string) {
      this.restoreTarget = {
        versionId,
        versionDate
      }
      this.isRestoreConfirmDialogShown = true
    },
    async restoreConfirm () {
      this.restoreLoading = true
      loadingStart(wikiStore, 'history-restore')
      try {
        await restorePageVersion(this.fetchWithAbort, this.pageId, this.restoreTarget.versionId, this.sourceRevision)
        if (this.requestsAbortController.signal.aborted) return
        showNotification(wikiStore, {
          style: 'success',
          message: this.$t('history:restore.success'),
          icon: 'check'
        })
        this.isRestoreConfirmDialogShown = false
        this.restoreRedirectTimer = window.setTimeout(() => {
          window.location.assign(`/${this.locale}/${this.path}`)
        }, 1000)
      } catch (err) {
        if (!this.requestsAbortController.signal.aborted) {
          showNotification(wikiStore, {
            style: 'red',
            message: getErrorMessage(err),
            icon: 'alert'
          })
        }
      } finally {
        loadingStop(wikiStore, 'history-restore')
        this.restoreLoading = false
      }
    },
    branchOff (versionId: number) {
      const pathParts = this.path.split('/')
      this.branchOffOpts = {
        versionId: versionId,
        locale: this.locale,
        path: (pathParts.length > 1) ? pathParts.slice(0, -1).join('/') + `/new-page` : `new-page`,
        modal: true
      }
    },
    branchOffHandle ({ locale, path }: { locale: string, path: string }) {
      window.location.assign(`/e/${locale}/${path}?from=${this.pageId},${this.branchOffOpts.versionId}`)
    },
    toggleViewMode () {
      this.viewMode = (this.viewMode === 'line-by-line') ? 'side-by-side' : 'line-by-line'
    },
    goLive () {
      const privatePrefix = this.visibility === 'private' ? '/_private' : ''
      window.location.assign(`${privatePrefix}/${this.locale}/${this.path}`)
    },
    canSelectVersion (index: number) {
      const target = this.fullTrail[index]
      const source = this.fullTrail[index + 1]
      return Boolean(
        target && (
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
      if (this.$vuetify.display.smAndDown) {
        this.$nextTick(() => {
          const heading = this.$refs.comparisonHeading as HTMLElement | undefined
          heading?.scrollIntoView({
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
            block: 'start'
          })
          heading?.focus({ preventScroll: true })
        })
      }
    },
    setDiffSource (versionId: number) {
      this.diffSource = versionId
    },
    setDiffTarget (versionId: number) {
      this.diffTarget = versionId
    },
    async loadMore () {
      const nextOffsetPage = this.offsetPage + 1
      const result = await this.fetchHistoryPage(nextOffsetPage)
      if (!result) return
      this.offsetPage = nextOffsetPage
      this.trail = [...this.trail, ...result.trail]
    },
    async loadHistory () {
      const result = await this.fetchHistoryPage(0)
      if (!result) return
      this.offsetPage = 0
      this.total = result.total
      this.trail = result.trail
      this.trailLoaded = true
    },
    async fetchHistoryPage (offsetPage: number): Promise<{ trail: PageHistoryTrailItem[], total: number } | null> {
      this.trailError = ''
      this.trailLoading = offsetPage === 0
      this.loadingMore = offsetPage > 0
      setLoading(wikiStore, 'history-trail-refresh', true)
      try {
        const result = await fetchPageHistory(
          this.fetchWithAbort,
          this.pageId,
          offsetPage,
          this.$vuetify.display.mdAndUp ? 25 : 5
        )
        return this.requestsAbortController.signal.aborted ? null : result
      } catch (error) {
        if (!this.requestsAbortController.signal.aborted) {
          this.trailError = getErrorMessage(error)
        }
        return null
      } finally {
        this.trailLoading = false
        this.loadingMore = false
        setLoading(wikiStore, 'history-trail-refresh', false)
      }
    },
    trailColor (actionType: string) {
      switch (actionType) {
        case 'edit':
          return 'primary'
        case 'move':
          return 'info'
        case 'initial':
          return 'success'
        case 'live':
          return 'warning'
        default:
          return 'grey'
      }
    },
    trailIcon (actionType: string) {
      switch (actionType) {
        case 'edit':
          return '' // 'mdi-pencil'
        case 'move':
          return 'mdi-forward'
        case 'initial':
          return 'mdi-plus'
        case 'live':
          return 'mdi-atom-variant'
        default:
          return 'mdi-alert'
      }
    },
    trailBgColor (actionType: string) {
      switch (actionType) {
        case 'move':
          return 'history-trail-move'
        case 'initial':
          return 'history-trail-initial'
        case 'live':
          return 'history-trail-live'
        default:
          return 'history-trail-default'
      }
    },
  }

}
</script>

<style lang='scss'>
.history-main {
  background:
    radial-gradient(circle at 88% 0, color-mix(in srgb, var(--wiki-ambient-accent) 8%, transparent), transparent 34rem),
    rgb(var(--v-theme-background));
}

.history-toolbar {
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-10)) !important;
  padding-inline: var(--wiki-page-gutter);
  border-bottom: 1px solid var(--wiki-surface-border) !important;
  background: var(--wiki-surface-raised) !important;
  box-shadow: var(--wiki-shadow-xs);
}

.history-toolbar-copy {
  min-width: 0;
  padding-block: var(--wiki-space-3);
}

.history-eyebrow {
  color: var(--wiki-accent-warm);
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
.history-view-toggle,
.history-load-more {
  border-radius: var(--wiki-control-radius);
  font-weight: 650;
  text-transform: none;
}

.history-shell {
  width: min(100%, var(--wiki-content-max));
  margin: 0 auto;
  padding: var(--wiki-space-6) var(--wiki-page-gutter) var(--wiki-space-12) !important;
}

.history-trail-column,
.history-comparison-column {
  min-width: 0;
}

.history-live-chip {
  position: relative;
  z-index: 1;
  margin-inline-start: var(--wiki-space-6);
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 24%, transparent);
  font-weight: 650;
}

.history-timeline {
  .v-timeline-divider__dot {
    border: 1px solid var(--wiki-surface-border);
    box-shadow: var(--wiki-shadow-xs);
  }

  .v-timeline-item__body {
    min-width: 0;
  }
}

.history-revision-card {
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius) !important;
  box-shadow: var(--wiki-shadow-xs);
  transition:
    border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    box-shadow var(--wiki-motion-fast) var(--wiki-motion-ease),
    transform var(--wiki-motion-fast) var(--wiki-motion-ease-out);

  &:hover,
  &:focus-within {
    border-color: var(--wiki-surface-border-strong);
    box-shadow: var(--wiki-shadow-sm);
    transform: translateY(calc(var(--wiki-space-1) * -.25));
  }
}

.history-trail-move {
  background: color-mix(in srgb, rgb(var(--v-theme-info)) 10%, var(--wiki-surface-raised)) !important;
}

.history-trail-initial {
  background: color-mix(in srgb, rgb(var(--v-theme-success)) 10%, var(--wiki-surface-raised)) !important;
}

.history-trail-live {
  background: color-mix(in srgb, rgb(var(--v-theme-warning)) 10%, var(--wiki-surface-raised)) !important;
}

.history-trail-default {
  background: var(--wiki-surface-raised) !important;
}

.history-revision-summary {
  min-width: 0;
  padding: var(--wiki-space-3);
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

.history-revision-copy {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--wiki-space-1);

  .v-divider {
    border-color: var(--wiki-surface-border);
  }
}

.history-revision-description {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-revision-actions {
  display: flex;
  min-height: var(--wiki-control-height);
  align-items: center;
  justify-content: flex-end;
  gap: var(--wiki-space-1);
  padding: var(--wiki-space-1) var(--wiki-space-2);
  border-top: 1px solid var(--wiki-surface-border);
  background: color-mix(in srgb, var(--wiki-surface-sunken) 70%, transparent);

  .v-btn {
    min-width: var(--wiki-control-height);
    min-height: var(--wiki-control-height);
    flex: 0 0 var(--wiki-control-height);
    border-radius: var(--wiki-radius-xs) !important;
  }
}

.history-diff-active {
  background: var(--wiki-accent-warm) !important;
  color: rgb(var(--v-theme-on-primary)) !important;
}

.history-diff-inactive {
  background: var(--wiki-surface-raised) !important;
  color: rgb(var(--v-theme-on-surface)) !important;
}

.history-promptmenu,
.history-restore-dialog {
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-md);
}

.history-promptmenu {
  border-block-start: var(--wiki-space-1) solid var(--wiki-accent-warm);
}

.history-load-more {
  margin-top: var(--wiki-space-2) !important;
}

.history-end-chip {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
}

.history-restore-header {
  border-bottom: 1px solid color-mix(in srgb, rgb(var(--v-theme-warning)) 22%, transparent);
  background: color-mix(in srgb, rgb(var(--v-theme-warning)) 12%, var(--wiki-surface-raised));
  color: rgb(var(--v-theme-on-surface));
}

.history-comparison-card {
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius) !important;
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-md);

  > .v-card-text {
    padding: var(--wiki-space-4);
  }
}

.history-comparison-frame {
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius) !important;
  background: var(--wiki-surface-sunken);
  box-shadow: var(--wiki-shadow-inset);
}

.history-comparison-heading {
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-size: 1.15rem;
  font-weight: 720;
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

@media (max-width: 959px) {
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

  .history-comparison-card {
    margin-top: var(--wiki-space-2);
  }

  .history .d2h-file-side-diff {
    min-width: 32rem;
  }
}

@media (max-width: 599px) {
  .history-toolbar-title {
    font-size: .875rem;
  }

  .history-shell {
    padding-inline: var(--wiki-space-2) !important;
  }

  .history-revision-description {
    flex: 1 1 10rem;
    overflow-wrap: anywhere;
    white-space: normal;
  }

  .history-comparison-card > .v-card-text {
    padding: var(--wiki-space-2);
  }

  .history-comparison-summary {
    align-items: stretch !important;
    flex-direction: column;
  }

  .history-comparison-controls {
    width: 100%;
    padding: 0 var(--wiki-space-4) var(--wiki-space-4) !important;

    .history-view-toggle {
      width: 100%;
      margin: 0 !important;
    }
  }
}

@media (forced-colors: active) {
  .history-revision-card,
  .history-comparison-card,
  .history-comparison-frame,
  .history-diff,
  .history-promptmenu,
  .history-restore-dialog {
    border-color: CanvasText;
  }
}

@media (prefers-reduced-motion: reduce) {
  .history-revision-card {
    transform: none !important;
  }
}
</style>
