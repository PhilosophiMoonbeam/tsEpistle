<template lang='pug'>
  v-app(:dark='$vuetify.theme.current.dark').history
    nav-header
    v-main
      v-toolbar.history-toolbar(color='primary', dark)
        .subheading.history-toolbar-title Viewing history of #[strong /{{path}}]
        v-spacer
        .caption.blue--text.text--lighten-3.mr-4(v-if='$vuetify.display.mdAndUp') Trail Length: {{total}}
        .caption.blue--text.text--lighten-3.mr-4(v-if='$vuetify.display.mdAndUp') ID: {{pageId}}
        v-btn(depressed, color='blue darken-1', @click='goLive', aria-label='Return to live version')
          v-icon(v-if='$vuetify.display.smAndDown') mdi-close
          span(v-else) Return to Live Version
      v-container(fluid, grid-list-xl)
        v-row()
          v-col(cols='12', md='4')
            v-chip.my-0.ml-6(
              label
              small
              :color='$vuetify.theme.current.dark ? `grey darken-2` : `grey lighten-2`'
              :class='$vuetify.theme.current.dark ? `grey--text text--lighten-2` : `grey--text text--darken-2`'
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
              dense
              )
              v-timeline-item.pb-2(
                v-for='(ph, idx) in fullTrail'
                :key='ph.versionId'
                :small='ph.actionType === `edit`'
                :color='trailColor(ph.actionType)'
                :icon='trailIcon(ph.actionType)'
                )
                v-card.radius-7(
                  flat
                  :class='trailBgColor(ph.actionType)'
                  role='button'
                  tabindex='0'
                  :aria-label='`Compare revision from ${$helpers.formatMoment(ph.versionDate, `LLL`)}`'
                  @click='selectVersion(idx)'
                  @keydown.enter.prevent='selectVersion(idx)'
                  @keydown.space.prevent='selectVersion(idx)'
                )
                  v-toolbar(flat, :color='trailBgColor(ph.actionType)', height='40')
                    .caption(:title='$helpers.formatMoment(ph.versionDate, `LLL`)') {{ $helpers.formatMoment(ph.versionDate, 'll') }}
                    v-divider.mx-3(vertical)
                    .caption(v-if='ph.actionType === `edit`') Edited by #[strong {{ ph.authorName }}]
                    .caption(v-else-if='ph.actionType === `move`') Moved from #[strong {{ph.valueBefore}}] to #[strong {{ph.valueAfter}}] by #[strong {{ ph.authorName }}]
                    .caption(v-else-if='ph.actionType === `initial`') Created by #[strong {{ ph.authorName }}]
                    .caption(v-else-if='ph.actionType === `live`') Last Edited by #[strong {{ ph.authorName }}]
                    .caption(v-else) Unknown Action by #[strong {{ ph.authorName }}]
                    v-spacer
                    v-menu(offset-x, left)
                      template(v-slot:activator='{ props }')
                        v-btn.mr-2.radius-4(icon, v-bind='props', small, tile, :aria-label='`Actions for revision ${ph.versionId || `live`}`'): v-icon mdi-dots-horizontal
                      v-list(dense, nav).history-promptmenu
                        v-list-item(@click='setDiffSource(ph.versionId)', :disabled='(ph.versionId >= diffTarget && diffTarget !== 0) || ph.versionId === 0')
                          v-avatar(size='24'): v-avatar A
                          v-list-item-title Set as Differencing Source
                        v-list-item(@click='setDiffTarget(ph.versionId)', :disabled='ph.versionId <= diffSource && ph.versionId !== 0')
                          v-avatar(size='24'): v-avatar B
                          v-list-item-title Set as Differencing Target
                        v-list-item(@click='viewSource(ph.versionId)')
                          v-avatar(size='24'): v-icon mdi-code-tags
                          v-list-item-title View Source
                        v-list-item(@click='download(ph.versionId)')
                          v-avatar(size='24'): v-icon mdi-cloud-download-outline
                          v-list-item-title Download Version
                        v-list-item(@click='restore(ph.versionId, ph.versionDate)', :disabled='ph.versionId === 0')
                          v-avatar(size='24'): v-icon(:disabled='ph.versionId === 0') mdi-history
                          v-list-item-title Restore
                        v-list-item(@click='branchOff(ph.versionId)')
                          v-avatar(size='24'): v-icon mdi-source-branch
                          v-list-item-title Branch off from here
                    v-btn.mr-2.radius-4(
                      @click='setDiffSource(ph.versionId)'
                      icon
                      small
                      depressed
                      tile
                      :aria-label='`Set revision ${ph.versionId} as differencing source`'
                      :class='diffSource === ph.versionId ? `pink white--text` : ($vuetify.theme.current.dark ? `grey darken-2` : `grey lighten-2`)'
                      :disabled='(ph.versionId >= diffTarget && diffTarget !== 0) || ph.versionId === 0'
                      ): strong A
                    v-btn.mr-0.radius-4(
                      @click='setDiffTarget(ph.versionId)'
                      icon
                      small
                      depressed
                      tile
                      :aria-label='`Set revision ${ph.versionId || `live`} as differencing target`'
                      :class='diffTarget === ph.versionId ? `pink white--text` : ($vuetify.theme.current.dark ? `grey darken-2` : `grey lighten-2`)'
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
              .caption.white--text Load More...

            v-chip.ma-0(
              v-else
              label
              small
              :color='$vuetify.theme.current.dark ? `grey darken-2` : `grey lighten-2`'
              :class='$vuetify.theme.current.dark ? `grey--text text--lighten-2` : `grey--text text--darken-2`'
              ) End of history trail

          v-col(cols='12', md='8')
            v-card.radius-7(:class='$vuetify.display.mdAndUp ? `mt-8` : ``')
              v-card-text
                v-card.grey.radius-7(flat, :class='$vuetify.theme.current.dark ? `darken-2` : `lighten-4`')
                  v-row(no-gutters, align='center')
                    v-col
                      v-card-text
                        .subheading {{target.title}}
                        .caption {{target.description}}
                        .history-revision-meta
                          span {{ target.versionId === 0 ? 'Live version' : `Revision ${target.versionId}` }}
                          span {{ target.editor || 'unknown editor' }} / {{ target.contentType || 'unknown format' }}
                          span {{ target.visibility }}{{ target.isPublished === false ? ' / unpublished' : '' }}
                          span(v-if='target.tags.length > 0') Tags: {{ target.tags.join(', ') }}
                    v-col.text-right.py-3(cols='auto')
                      v-btn.mr-3(:color='$vuetify.theme.current.dark ? `white` : `grey darken-3`', small, dark, outlined, @click='toggleViewMode', aria-label='Toggle diff view mode')
                        v-icon(left) mdi-eye
                        span(v-if='$vuetify.display.mdAndUp').overline View Mode
                v-card.mt-3.history-diff(light, v-html='diffHTML', flat)

    v-dialog(v-model='isRestoreConfirmDialogShown', max-width='650', persistent)
      v-card
        .dialog-header.is-orange {{$t('history:restore.confirmTitle')}}
        v-card-text.pa-4
          i18next(tag='span', path='history:restore.confirmText')
            strong(place='date') {{ $helpers.formatMoment(restoreTarget.versionDate, 'LLL') }}
        v-card-actions
          v-spacer
          v-btn(text, @click='isRestoreConfirmDialogShown = false', :disabled='restoreLoading') {{$t('common:actions.cancel')}}
          v-btn(color='orange darken-2', dark, @click='restoreConfirm', :loading='restoreLoading') {{$t('history:restore.confirmButton')}}

    page-selector(mode='create', v-model='branchOffOpts.modal', :open-handler='branchOffHandle', :path='branchOffOpts.path', :locale='branchOffOpts.locale')

    nav-footer
    notify
    search-results
</template>

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
      trailLoading: false,
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
        await restorePageVersion(window.fetch.bind(window), this.pageId, this.restoreTarget.versionId, this.updatedAt)
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
          return 'purple'
        case 'initial':
          return 'teal'
        case 'live':
          return 'orange'
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
          return this.$vuetify.theme.current.dark ? 'purple' : 'purple lighten-5'
        case 'initial':
          return this.$vuetify.theme.current.dark ? 'teal darken-3' : 'teal lighten-5'
        case 'live':
          return this.$vuetify.theme.current.dark ? 'orange darken-3' : 'orange lighten-5'
        default:
          return this.$vuetify.theme.current.dark ? 'grey darken-3' : 'grey lighten-4'
      }
    }
  }

}
</script>

<style lang='scss'>

.history {
  &-promptmenu {
    border-top: 5px solid mc('blue', '700');
  }

  &-toolbar-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &-revision-meta {
    display: flex;
    flex-wrap: wrap;
    gap: .25rem 1rem;
    margin-top: .5rem;
    font-size: .75rem;
    opacity: .75;
  }

  @media (max-width: 959.98px) {
    &-toolbar {
      padding-inline: .5rem;
    }

    &-diff {
      overflow-x: auto;
    }

    .d2h-file-side-diff {
      min-width: 32rem;
    }
  }

  .d2h-file-wrapper {
    border: 1px solid #EEE;
    border-left: none;
  }

  .d2h-file-header {
    display: none;
  }
}

</style>
