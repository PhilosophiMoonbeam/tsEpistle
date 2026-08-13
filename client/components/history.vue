<template lang='pug'>
  v-app(:dark='$vuetify.theme.current.dark').history
    nav-header
    v-main
      v-toolbar(color='primary', dark)
        .subheading Viewing history of #[strong /{{path}}]
        template(v-if='$vuetify.display.mdAndUp')
          v-spacer
          .caption.blue--text.text--lighten-3.mr-4 Trail Length: {{total}}
          .caption.blue--text.text--lighten-3 ID: {{pageId}}
          v-btn.ml-4(depressed, color='blue darken-1', @click='goLive') Return to Live Version
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
            v-timeline(
              dense
              )
              v-timeline-item.pb-2(
                v-for='(ph, idx) in fullTrail'
                :key='ph.versionId'
                :small='ph.actionType === `edit`'
                :color='trailColor(ph.actionType)'
                :icon='trailIcon(ph.actionType)'
                )
                v-card.radius-7(flat, :class='trailBgColor(ph.actionType)')
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
                        v-btn.mr-2.radius-4(icon, v-bind='props', small, tile): v-icon mdi-dots-horizontal
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
                      :class='diffSource === ph.versionId ? `pink white--text` : ($vuetify.theme.current.dark ? `grey darken-2` : `grey lighten-2`)'
                      :disabled='(ph.versionId >= diffTarget && diffTarget !== 0) || ph.versionId === 0'
                      ): strong A
                    v-btn.mr-0.radius-4(
                      @click='setDiffTarget(ph.versionId)'
                      icon
                      small
                      depressed
                      tile
                      :class='diffTarget === ph.versionId ? `pink white--text` : ($vuetify.theme.current.dark ? `grey darken-2` : `grey lighten-2`)'
                      :disabled='ph.versionId <= diffSource && ph.versionId !== 0'
                      ): strong B

            v-btn.ma-0.radius-7(
              v-if='total > trail.length'
              block
              color='primary'
              @click='loadMore'
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
                    v-col.text-right.py-3(cols='2', v-if='$vuetify.display.mdAndUp')
                      v-btn.mr-3(:color='$vuetify.theme.current.dark ? `white` : `grey darken-3`', small, dark, outlined, @click='toggleViewMode')
                        v-icon(left) mdi-eye
                        .overline View Mode
                v-card.mt-3(light, v-html='diffHTML', flat)

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
import _ from 'lodash'
import { fetchPageHistory, fetchPageVersion, restorePageVersion, type PageHistoryTrailItem, type PageVersion } from '../helpers/pages-api'
import { getPageDownloadPath, getPageSourcePath } from '../helpers/page-actions'
import { getErrorMessage, loadingStart, loadingStop, setLoading, showNotification } from '../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'

export default {
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
      source: {
        versionId: 0,
        content: '',
        title: '',
        description: ''
      },
      target: {
        versionId: 0,
        content: '',
        title: '',
        description: ''
      },
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

    wikiStore.page.mode = 'history'

    this.cache.push({
      action: 'live',
      authorId: this.authorId,
      authorName: this.authorName,
      content: this.liveContent,
      contentType: '',
      createdAt: this.createdAt,
      description: this.description,
      editor: '',
      isPrivate: false,
      isPublished: this.isPublished,
      locale: this.locale,
      pageId: this.pageId,
      path: this.path,
      publishEndDate: '',
      publishStartDate: '',
      tags: this.tags,
      title: this.title,
      versionId: 0,
      versionDate: this.updatedAt
    })

    this.target = this.cache[0]!

    if (this.effectivePermissions) {
      wikiStore.page.effectivePermissions = JSON.parse(Buffer.from(this.effectivePermissions, 'base64').toString())
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
        console.warn(err)
        return { versionId, content: '', title: '', description: '', path: this.path }
      } finally {
        loadingStop(wikiStore, 'history-version-' + versionId)
      }
    },
    viewSource (versionId: number) {
      window.location.assign(getPageSourcePath(this.locale, this.path, versionId))
    },
    download (versionId: number) {
      window.location.assign(getPageDownloadPath(this.locale, this.path, versionId))
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
        await restorePageVersion(window.fetch.bind(window), this.pageId, this.restoreTarget.versionId)
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
      window.location.assign(`/${this.path}`)
    },
    setDiffSource (versionId: number) {
      this.diffSource = versionId
    },
    setDiffTarget (versionId: number) {
      this.diffTarget = versionId
    },
    async loadMore () {
      this.offsetPage++
      const result = await this.fetchHistoryPage(this.offsetPage)
      this.trail = [...this.trail, ...result.trail]
    },
    async loadHistory () {
      const result = await this.fetchHistoryPage(0)
      this.total = result.total
      this.trail = result.trail
    },
    async fetchHistoryPage (offsetPage: number) {
      setLoading(wikiStore, 'history-trail-refresh', true)
      try {
        return await fetchPageHistory(
          window.fetch.bind(window),
          this.pageId,
          offsetPage,
          this.$vuetify.display.mdAndUp ? 25 : 5
        )
      } finally {
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

  .d2h-file-wrapper {
    border: 1px solid #EEE;
    border-left: none;
  }

  .d2h-file-header {
    display: none;
  }
}

</style>
