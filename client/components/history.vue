<template lang='pug'>
  v-app().history
    nav-header
    v-main.history-main
      v-toolbar.history-toolbar(color='surface', flat)
        .history-toolbar-copy
          .history-eyebrow Revision history
          h1.history-toolbar-title Viewing history of #[strong /{{path}}]
          .history-toolbar-meta(v-if='$vuetify.display.mdAndUp')
            span {{total}} revisions
            span Page {{pageId}}
        v-spacer
        v-btn(variant='flat', color='primary', size='small', @click='goLive', aria-label='Return to live version')
          v-icon(v-if='$vuetify.display.smAndDown') mdi-close
          span(v-else) Return to Live Version
      v-container.history-shell(fluid)
        v-row
          v-col(cols='12', md='4')
            v-chip.my-0.ml-6(
              label
              size="small"
              :color='$vuetify.theme.current.dark ? `grey-darken-2` : `grey-lighten-2`'
              :class='$vuetify.theme.current.dark ? `text-grey-lighten-2` : `text-grey-darken-2`'
              )
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
            v-timeline(
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
                v-card.radius-7(
                  flat
                  :class='trailBgColor(ph.actionType)'
                )
                  .history-revision-summary(
                    role='button'
                    tabindex='0'
                    :aria-label='`Compare revision from ${$helpers.formatMoment(ph.versionDate, `LLL`)}`'
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
                      ) Moved from #[strong {{ph.valueBefore}}] to #[strong {{ph.valueAfter}}] by #[strong {{ ph.authorName }}]
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
                    v-menu(location="left")
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
                            v-avatar(size='24'): v-avatar A
                          v-list-item-title Set as Differencing Source
                        v-list-item(@click.stop='setDiffTarget(ph.versionId)', :disabled='ph.versionId <= diffSource && ph.versionId !== 0')
                          template(v-slot:prepend)
                            v-avatar(size='24'): v-avatar B
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
                            v-avatar(size='24'): v-icon(:disabled='ph.versionId === 0') mdi-history
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
                      :disabled='ph.versionId <= diffSource && ph.versionId !== 0'
                    ): strong B

            v-btn.ma-0.radius-7(
              v-if='total > trail.length'
              block
              color='primary'
              @click='loadMore'
              :loading='loadingMore'
              :disabled='loadingMore'
              )
              .text-body-small.text-white Load More...

            v-chip.ma-0(
              v-else
              label
              size="small"
              :color='$vuetify.theme.current.dark ? `grey-darken-2` : `grey-lighten-2`'
              :class='$vuetify.theme.current.dark ? `text-grey-lighten-2` : `text-grey-darken-2`'
              ) End of history trail

          v-col(cols='12', md='8')
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
            v-card.radius-7(v-else-if='trailLoaded' :class='$vuetify.display.mdAndUp ? `mt-8` : ``')
              v-card-text
                v-card.radius-7(flat, :class='$vuetify.theme.current.dark ? `bg-grey-darken-2` : `bg-grey-lighten-4`')
                  v-row.align-center(no-gutters)
                    v-col
                      v-card-text
                        h2.history-comparison-heading(ref='comparisonHeading' tabindex='-1') {{target.title}}
                        .text-body-small {{target.description}}
                        .history-revision-meta
                          span {{ target.versionId === 0 ? 'Live version' : `Revision ${target.versionId}` }}
                          span {{ target.editor || 'unknown editor' }} / {{ target.contentType || 'unknown format' }}
                          span {{ target.visibility }}{{ target.isPublished === false ? ' / unpublished' : '' }}
                          span(v-if='target.tags.length > 0') Tags: {{ target.tags.join(', ') }}
                    v-col.text-right.py-3(cols='auto')
                      v-btn.mr-3(
                        :color='$vuetify.theme.current.dark ? `white` : `grey-darken-3`'
                        size="small"
                        variant="outlined"
                        @click='toggleViewMode'
                        :aria-label='viewMode === `line-by-line` ? `Switch to side-by-side diff` : `Switch to line-by-line diff`'
                        :aria-pressed='viewMode === `side-by-side`'
                      )
                        v-icon(start) mdi-eye
                        span.text-label-small View: {{viewMode === 'line-by-line' ? 'Line by line' : 'Side by side'}}
                v-card.mt-3.history-diff(flat)
                  div(v-html='diffHTML')

    v-dialog(v-model='isRestoreConfirmDialogShown', max-width='650', persistent)
      v-card
        .dialog-header.is-orange {{$t('history:restore.confirmTitle')}}
        v-card-text.pa-4
          i18next(tag='span', path='history:restore.confirmText')
            strong(place='date') {{ $helpers.formatMoment(restoreTarget.versionDate, 'LLL') }}
        v-card-actions
          v-spacer
          v-btn(variant="text", @click='isRestoreConfirmDialogShown = false', :disabled='restoreLoading') {{$t('common:actions.cancel')}}
          v-btn(color="orange-darken-2", @click='restoreConfirm', :loading='restoreLoading') {{$t('history:restore.confirmButton')}}

    page-selector(mode='create', v-model='branchOffOpts.modal', :open-handler='branchOffHandle', :path='branchOffOpts.path', :locale='branchOffOpts.locale')

    nav-footer
    notify
    search-results</template>

<script lang='ts'>
import * as Diff2Html from 'diff2html'
import { createPatch } from 'diff'
import AsyncState from '@/components/common/async-state.vue'
import _ from 'lodash'
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
      restoreLoading: false
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
      const prevPage = _.find(this.cache, ['versionId', _.get(this.trail, '[0].versionId', -1)])
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
    trail (newValue, oldValue) {
      if (newValue && newValue.length > 0) {
        this.diffTarget = 0
        this.diffSource = _.get(_.head(newValue), 'versionId', 0)
      }
    },
    async diffSource (newValue, oldValue) {
      if (this.diffSource !== this.source.versionId) {
        const page = _.find(this.cache, { versionId: newValue })
        if (page) {
          this.source = page
        } else {
          this.source = await this.loadVersion(newValue)
        }
      }
    },
    async diffTarget (newValue, oldValue) {
      if (this.diffTarget !== this.target.versionId) {
        const page = _.find(this.cache, { versionId: newValue })
        if (page) {
          this.target = page
        } else {
          this.target = await this.loadVersion(newValue)
        }
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
    this.loadHistory()
  },
  methods: {
    async loadVersion (versionId: number): Promise<PageVersion> {
      loadingStart(wikiStore, 'history-version-' + versionId)
      try {
        const page = await fetchPageVersion(window.fetch.bind(window), this.pageId, versionId)
        this.cache.push(page)
        return page
      } catch (err) {
        showNotification(wikiStore, {
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
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
        await restorePageVersion(window.fetch.bind(window), this.pageId, this.restoreTarget.versionId, this.sourceRevision)
        showNotification(wikiStore, {
          style: 'success',
          message: this.$t('history:restore.success'),
          icon: 'check'
        })
        this.isRestoreConfirmDialogShown = false
        setTimeout(() => {
          window.location.assign(`/${this.locale}/${this.path}`)
        }, 1000)
      } catch (err) {
        showNotification(wikiStore, {
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      }
      loadingStop(wikiStore, 'history-restore')
      this.restoreLoading = false
    },
    branchOff (versionId: number) {
      const pathParts = this.path.split('/')
      this.branchOffOpts = {
        versionId: versionId,
        locale: this.locale,
        path: (pathParts.length > 1) ? _.initial(pathParts).join('/') + `/new-page` : `new-page`,
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
    selectVersion (index: number) {
      const target = this.fullTrail[index]
      const source = this.fullTrail[index + 1]
      if (!target) return
      this.diffTarget = target.versionId
      if (source && source.versionId > 0) this.diffSource = source.versionId
      if (this.$vuetify.display.smAndDown) {
        this.$nextTick(() => {
          const heading = this.$refs.comparisonHeading as HTMLElement | undefined
          heading?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
        return await fetchPageHistory(
          window.fetch.bind(window),
          this.pageId,
          offsetPage,
          this.$vuetify.display.mdAndUp ? 25 : 5
        )
      } catch (error) {
        this.trailError = getErrorMessage(error)
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
    radial-gradient(circle at 88% 0%, rgba(var(--v-theme-primary), .07), transparent 30rem),
    rgb(var(--v-theme-background));
}

.history-promptmenu {
  border-top: 3px solid rgb(var(--v-theme-primary));
}
.history-trail-move {
  background: color-mix(in srgb, rgb(var(--v-theme-info)) 16%, rgb(var(--v-theme-surface))) !important;
}

.history-trail-initial {
  background: color-mix(in srgb, rgb(var(--v-theme-success)) 16%, rgb(var(--v-theme-surface))) !important;
}

.history-trail-live {
  background: color-mix(in srgb, rgb(var(--v-theme-warning)) 16%, rgb(var(--v-theme-surface))) !important;
}

.history-trail-default {
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 8%, rgb(var(--v-theme-surface))) !important;
}

.history-diff-active {
  background: rgb(var(--v-theme-primary)) !important;
  color: rgb(var(--v-theme-on-primary)) !important;
}

.history-diff-inactive {
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 10%, rgb(var(--v-theme-surface))) !important;
  color: rgb(var(--v-theme-on-surface)) !important;
}

.history-toolbar {
  min-height: 86px !important;
  padding-inline: var(--wiki-page-gutter);
  border-bottom: 1px solid rgba(var(--v-border-color), .11) !important;
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 96%, rgb(var(--v-theme-background))) !important;
}

.history-toolbar-copy {
  min-width: 0;
  padding-block: 14px;
}

.history-eyebrow {
  color: rgb(var(--v-theme-primary));
  font-size: .66rem;
  font-weight: 760;
  letter-spacing: .12em;
  text-transform: uppercase;
}

.history-toolbar-title {
  overflow: hidden;
  margin: 3px 0 0;
  color: rgb(var(--v-theme-on-surface));
  font-size: 1rem;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-toolbar-meta,
.history-revision-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin-top: 5px;
  color: rgb(var(--v-theme-on-surface));
  font-size: .72rem;
  opacity: .62;
}

.history-shell {
  width: min(100%, var(--wiki-content-max));
  margin: 0 auto;
  padding: 24px var(--wiki-page-gutter) 48px !important;
}

.history {
  .v-timeline-item .v-card,
  .history-shell > .v-row > .v-col:last-child > .v-card {
    border: 1px solid rgba(var(--v-border-color), .11);
    border-radius: var(--wiki-panel-radius);
    box-shadow: 0 8px 26px rgba(15, 23, 42, .045);
  }

  &-diff {
    overflow-x: auto;
    border: 1px solid rgba(var(--v-border-color), .1);
    border-radius: var(--wiki-control-radius);
  }

  .d2h-file-wrapper {
    border: 0;
  }

  .d2h-file-header {
    display: none;
  }
}
.history-revision-summary {
  min-width: 0;
  padding: 10px 12px 8px;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid rgb(var(--v-theme-primary));
    outline-offset: -2px;
  }
}

.history-revision-copy {
  display: flex;
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}
.history-revision-description {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-revision-actions {
  display: flex;
  min-height: 40px;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  padding: 4px 8px 6px;
  border-top: 1px solid rgba(var(--v-border-color), .08);

  .v-btn {
    flex: 0 0 44px;
    min-width: 44px;
    min-height: 44px;
  }
}

.history-comparison-heading {
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-size: 1.15rem;
  font-weight: 700;
}

@media (max-width: 959px) {
  .history-toolbar {
    min-height: 76px !important;
    padding-inline: 12px;
  }

  .history-toolbar-copy {
    max-width: calc(100vw - 92px);
  }

  .history-shell {
    padding: 14px 10px 36px !important;
  }

  .history-diff {
    overflow-x: auto;
  }

  .history .d2h-file-side-diff {
    min-width: 32rem;
  }
}
@media (max-width: 599px) {
  .history-revision-description {
    flex: 1 1 10rem;
    overflow-wrap: anywhere;
    white-space: normal;
  }

  .history-revision-actions {
    padding-inline: 6px;
  }
}
</style>
