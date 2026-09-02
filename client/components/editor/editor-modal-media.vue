<template lang='pug'>
  v-card.editor-modal-media.animated.fadeInLeft(flat, rounded='0', :class='`is-editor-` + editorKey', role='dialog', aria-modal='true', aria-labelledby='editor-media-title', tabindex='-1')
    v-container.pa-3(fluid)
      v-row
        v-col(cols='12', lg='9')
          v-card.radius-7.animated.fadeInLeft.wait-p1s
            v-card-text
              .d-flex
                v-toolbar.radius-7(:color='$vuetify.theme.current.dark ? `teal` : `teal-lighten-5`', density="compact", flat, height='44')
                  .text-body-medium#editor-media-title {{ $t('editor:assets.title') }}
                  v-spacer
                  v-btn.editor-media-icon-button(ref='refreshButton', variant="text", icon, aria-label='Refresh assets', @click='refresh')
                    v-icon(:color='$vuetify.theme.current.dark ? `white` : `teal`') mdi-refresh
                v-dialog(v-model='newFolderDialog', max-width='550')
                  template(v-slot:activator='{ props }')
                    v-btn.ml-3.my-0.mr-0.radius-7(variant="outlined", size="large", color='teal', :icon='$vuetify.display.xsOnly', :class='{ "editor-media-icon-button": $vuetify.display.xsOnly }', aria-label='Create folder', v-bind='props')
                      v-icon(:start='$vuetify.display.mdAndUp') mdi-plus
                      span.hidden-sm-and-down(:class='$vuetify.theme.current.dark ? `text-teal-lighten-3` : ``') {{$t('editor:assets.newFolder')}}
                  v-card
                    .dialog-header.is-short.text-body-large {{$t('editor:assets.newFolder')}}
                    v-card-text.pt-5
                      v-text-field(
                        variant="outlined"
                        prepend-icon='mdi-folder-outline'
                        v-model='newFolderName'
                        :label='$t(`editor:assets.folderName`)'
                        counter='255'
                        @keyup.enter='createFolder'
                        @keyup.esc='newFolderDialog = false'
                        ref='folderNameIpt'
                        )
                      i18next.text-body-small.text-grey-darken-1.pl-5(path='editor:assets.folderNameNamingRules', tag='div')
                        a(place='namingRules', href='https://docs-beta.requarks.io/guide/assets#naming-restrictions', target='_blank') {{$t('editor:assets.folderNameNamingRulesLink')}}
                    div.v-card-chin
                      v-spacer
                      v-btn(variant="text", @click='newFolderDialog = false') {{$t('common:actions.cancel')}}
                      v-btn.px-3(color='primary', @click='createFolder', :disabled='!isFolderNameValid', :loading='newFolderLoading') {{$t('common:actions.create')}}
              v-toolbar(flat, density="compact", :color='$vuetify.theme.current.dark ? `grey-darken-3` : `white`')
                template(v-if='folderTree.length > 0')
                  .text-body-medium
                    span.mr-1 /
                    template(v-for='folder of folderTree', :key='folder.id')
                      span {{folder.name}}
                      span.mx-1 /
                .text-body-medium(v-else) / #[em root]
              template(v-if='folders.length > 0 || currentFolderId > 0')
                v-btn.is-icon.mx-1(:color='$vuetify.theme.current.dark ? `grey-lighten-1` : `grey-darken-2`', variant="outlined", aria-label='Open parent folder', @click='upFolder()', :disabled='currentFolderId === 0')
                  v-icon mdi-folder-upload
                v-btn.btn-normalcase.mx-1(v-for='folder of folders', :key='folder.id', variant="flat",  color="grey-darken-2", @click='downFolder(folder)')
                  v-icon(start) mdi-folder
                  span.text-body-small(style='text-transform: none;') {{ folder.name }}
                v-divider.mt-2
              v-alert.mb-3(v-if='mediaLoadError', type='error', variant='tonal', role='alert')
                .d-flex.align-center
                  span {{mediaLoadError}}
                  v-spacer
                  v-btn(variant='text', size='small', @click='refresh') Retry
              v-data-table(
                :headers='headers'
                v-model:page='pagination'
                :items-per-page='15'
                :loading='loading'
                must-sort,
                :sort-by='mediaSortBy'
                hide-default-footer,
                density="compact"
              )
                template(v-slot:item='props')
                  tr.is-clickable(
                    :key='props.item.id'
                    tabindex='0'
                    :aria-selected='currentFileId === props.item.id'
                    :aria-label='`Select ${props.item.filename}`'
                    @keydown.enter.space.prevent='selectAsset(props.item.id)'
                    @click.left='selectAsset(props.item.id)'
                    @click.right.prevent=''
                  )
                    td.text-body-small(v-if='$vuetify.display.smAndUp') {{ props.item.id }}
                    td
                      .text-body-medium: strong(:class='currentFileId === props.item.id ? `text-teal` : ``') {{ props.item.filename }}
                      .text-body-small.text-grey {{ props.item.description }}
                    td.text-center(v-if='$vuetify.display.lgAndUp')
                      v-chip.ma-0(size="x-small", :color='$vuetify.theme.current.dark ? `grey-darken-4` : `grey-lighten-4`')
                        .text-label-small {{props.item.ext.toUpperCase().substring(1)}}
                    td.text-body-small(v-if='$vuetify.display.mdAndUp') {{ prettyBytes(props.item.fileSize) }}
                    td.text-body-small(v-if='$vuetify.display.mdAndUp') {{ $helpers.formatMoment(props.item.createdAt, 'from') }}
                    td(v-if='$vuetify.display.smAndUp')
                      v-menu(min-width='200')
                        template(v-slot:activator='{ props: menuProps }')
                          v-btn.editor-media-icon-button(icon, v-bind='menuProps', rounded='0', size="small", aria-label='Asset actions')
                            v-icon(color="grey-darken-2") mdi-dots-horizontal
                        v-list(nav, style='border-top: 5px solid #444;')
                          //- v-list-item(@click='', disabled)
                          //-   template(v-slot:prepend)
                          //-     v-avatar(size='24')
                          //-       v-icon(color='teal') mdi-text-short
                          //-   v-list-item-title {{$t('common:actions.properties')}}
                          //- template(v-if='props.item.kind === `IMAGE`')
                          //-   v-list-item(@click='previewDialog = true', disabled)
                          //-     template(v-slot:prepend)
                          //-       v-avatar(size='24')
                          //-         v-icon(color='green') mdi-image-search-outline
                          //-     v-list-item-title {{$t('common:actions.preview')}}
                          //-   v-list-item(@click='', disabled)
                          //-     template(v-slot:prepend)
                          //-       v-avatar(size='24')
                          //-         v-icon(color='indigo') mdi-crop-rotate
                          //-     v-list-item-title {{$t('common:actions.edit')}}
                          //-   v-list-item(@click='', disabled)
                          //-     template(v-slot:prepend)
                          //-       v-avatar(size='24')
                          //-         v-icon(color='purple') mdi-flash-circle
                          //-     v-list-item-title {{$t('common:actions.optimize')}}
                          v-list-item(@click='openRenameDialog(props.item.id)')
                            template(v-slot:prepend)
                              v-avatar(size='24')
                                v-icon(color='orange') mdi-keyboard-outline
                            v-list-item-title {{$t('common:actions.rename')}}
                          //- v-list-item(@click='', disabled)
                          //-   template(v-slot:prepend)
                          //-     v-avatar(size='24')
                          //-       v-icon(color='blue') mdi-file-move
                          //-   v-list-item-title {{$t('common:actions.move')}}
                          v-list-item(@click='openDeleteDialog(props.item.id)')
                            template(v-slot:prepend)
                              v-avatar(size='24')
                                v-icon(color='red') mdi-file-hidden
                            v-list-item-title {{$t('common:actions.delete')}}
                template(v-slot:no-data)
                  v-alert.mt-3.radius-7(v-if='!mediaLoadError', icon='mdi-folder-open-outline', :model-value='true', variant="outlined", color='teal') {{$t('editor:assets.folderEmpty')}}
              .text-center.py-2(v-if='pageTotal > 1')
                v-pagination(v-model='pagination', :length='pageTotal', color='teal')
              .d-flex.mt-3
                v-toolbar.radius-7(flat, :color='$vuetify.theme.current.dark ? `grey-darken-2` : `grey-lighten-4`', density="compact", height='44')
                  .text-body-medium(:class='$vuetify.theme.current.dark ? `text-grey-lighten-1` : `text-grey-darken-1`') {{$t('editor:assets.fileCount', { count: assets.length })}}
                v-btn.ml-3.mr-0.my-0.radius-7(color="red-darken-2", size="large", @click='cancel')
                  v-icon(start) mdi-close
                  span {{$t('common:actions.cancel')}}
                v-btn.ml-3.mr-0.my-0.radius-7(color='teal', size="large", @click='insert', :disabled='!currentFileId')
                  v-icon(start) mdi-playlist-plus
                  span {{$t('common:actions.insert')}}

        v-col(cols='12', lg='3')
          v-card.radius-7.animated.fadeInRight.wait-p3s
            v-alert.mb-0(v-if='isPrivatePage', type='info', variant="outlined", density="compact") Assets are site-wide and cannot be uploaded as private page content.
            v-card-text(v-if='!isPrivatePage')
              .d-flex
                v-toolbar.radius-7(:color='$vuetify.theme.current.dark ? `teal` : `teal-lighten-5`', density="compact", flat, height='44')
                  v-icon.mr-3(:color='$vuetify.theme.current.dark ? `white` : `teal`') mdi-cloud-upload
                  .text-body-medium(:class='$vuetify.theme.current.dark ? `text-white` : `text-teal`') {{$t('editor:assets.uploadAssets')}}
                v-btn.my-0.ml-3.mr-0.radius-7(variant="outlined", size="large", color='teal', aria-label='Browse files', @click='browse', v-if='$vuetify.display.mdAndUp')
                  v-icon(start) mdi-plus-box-multiple
                  span(:class='$vuetify.theme.current.dark ? `text-teal-lighten-3` : ``') {{$t('common:actions.browse')}}
              file-pond.mt-3(
                name='mediaUpload'
                ref='pond'
                :label-idle='$t(`editor:assets.uploadAssetsDropZone`)'
                allow-multiple
                :files='files'
                :max-files='10'
                :server='filePondServerOpts'
                :instant-upload='false'
                :allow-revert='false'
                @processfile='onFileProcessed'
              )
            v-divider(v-if='!isPrivatePage')
            v-card-actions.pa-3(v-if='!isPrivatePage')
              .text-body-small.text-grey-darken-2 Max 10 files, 5 MB each
              v-spacer
              v-btn.px-4(color='teal', @click='upload') {{$t('common:actions.upload')}}


          v-card.mt-3.radius-7.animated.fadeInRight.wait-p4s(v-if='currentAsset && currentAsset.kind === `IMAGE`')
            v-card-text.pb-0
              v-toolbar.radius-7(:color='$vuetify.theme.current.dark ? `teal` : `teal-lighten-5`', density="compact", flat)
                v-icon.mr-3(:color='$vuetify.theme.current.dark ? `white` : `teal`') mdi-format-align-top
                .text-body-medium(:class='$vuetify.theme.current.dark ? `text-white` : `text-teal`') {{$t('editor:assets.imageAlign')}}
              v-select.mt-3(
                v-model='imageAlignment'
                :items='imageAlignments'
                item-title='text'
                item-value='value'
                variant="outlined"
                single-line
                color='teal'
                placeholder='None'
              )

    //- RENAME DIALOG

    v-dialog(v-model='renameDialog', max-width='550', persistent)
      v-card
        .dialog-header.is-short.is-orange
          v-icon.mr-2(color='primary') mdi-keyboard
          span {{$t('editor:assets.renameAsset')}}
        v-card-text.pt-5
          .text-body-medium {{$t('editor:assets.renameAssetSubtitle')}}
          v-text-field(
            variant="outlined"
            single-line
            :counter='255'
            v-model='renameAssetName'
            :label='$t(`common:actions.rename`)'
            :rules='renameAssetRules'
            @keyup.enter='renameAsset'
            :disabled='renameAssetLoading'
          )
        div.v-card-chin
          v-spacer
          v-btn(variant="text", @click='renameDialog = false', :disabled='renameAssetLoading') {{$t('common:actions.cancel')}}
          v-btn.px-3(color="orange-darken-3", @click='renameAsset', :loading='renameAssetLoading', :disabled='!isRenameValid').text-white {{$t('common:actions.rename')}}

    //- DELETE DIALOG

    v-dialog(v-model='deleteDialog', max-width='550', persistent)
      v-card
        .dialog-header.is-short.is-red
          v-icon.mr-2(color='white') mdi-trash-can-outline
          span {{$t('editor:assets.deleteAsset')}}
        v-card-text.pt-5
          .text-body-medium {{$t('editor:assets.deleteAssetConfirm')}}
          .text-body-medium.text-red-darken-2 {{currentAsset?.filename}}?
          .text-body-small.mt-3 {{$t('editor:assets.deleteAssetWarn')}}
        div.v-card-chin
          v-spacer
          v-btn(variant="text", @click='deleteDialog = false', :disabled='deleteAssetLoading') {{$t('common:actions.cancel')}}
          v-btn.px-3(color="red-darken-2", @click='deleteAsset', :loading='deleteAssetLoading').text-white {{$t('common:actions.delete')}}</template>

<script lang='ts'>
import { defineComponent, markRaw, type Component } from 'vue'
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'
import Cookies from 'js-cookie'
import vueFilePond from 'vue-filepond'
import 'filepond/dist/filepond.min.css'
import { createAssetFolder, deleteAsset as deleteAssetRequest, fetchAssetFolders, fetchAssets, renameAsset as renameAssetRequest, type Asset, type AssetFolder } from '../../helpers/assets-api'
import { emitEditorInsert } from '../../helpers/editor-insert-events'
import { createModalFocusScope, type ModalFocusScope } from '../common/modal-focus-scope'

const FilePond = vueFilePond() as unknown as Component
const localeSegmentRegex = /^[A-Z]{2}(-[A-Z]{2})?$/i
const disallowedFolderChars = /[A-Z()=.!@#$%?&*+`~<>,;:\\/[\]¬{| ]/
const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
const LOG_1000 = Math.log(1000)
const IMAGE_ALIGNMENTS = markRaw([
  { text: 'None', value: '' },
  { text: 'Left', value: 'left' },
  { text: 'Centered', value: 'center' },
  { text: 'Right', value: 'right' },
  { text: 'Absolute Top Right', value: 'abstopright' }
])
const MEDIA_SORT_BY = markRaw([{ key: 'id', order: 'desc' as const }])
const RENAME_ASSET_RULES = markRaw([
  (value: unknown) => !!String(value || '').trim() || 'A filename is required.',
  (value: unknown) => (!String(value || '').includes('/') && !String(value || '').includes(String.fromCharCode(92))) || 'Filename cannot contain slashes.'
])

type FilePondFile = {
  id: string
  setMetadata: (metadata: Record<string, unknown>) => void
}

type FilePondRef = {
  browse: () => void
  getFiles: () => FilePondFile[]
  processFiles: () => Promise<unknown>
  removeFile: (id: string) => void
}

function focusInput (ref: unknown): void {
  const componentRoot = (ref as { $el?: unknown } | null)?.$el
  const root = ref instanceof HTMLElement ? ref : componentRoot instanceof HTMLElement ? componentRoot : null
  root?.querySelector<HTMLInputElement>('input')?.focus()
}

export default defineComponent({
  components: {
    FilePond
  },
  data() {
    return {
      folders: markRaw([] as AssetFolder[]),
      files: [] as FilePondFile[],
      assets: markRaw([] as Asset[]),
      pagination: 1,
      imageAlignments: IMAGE_ALIGNMENTS,
      mediaSortBy: MEDIA_SORT_BY,
      renameAssetRules: RENAME_ASSET_RULES,
      imageAlignment: '',
      loading: false,
      newFolderDialog: false,
      newFolderName: '',
      newFolderLoading: false,
      renameDialog: false,
      deleteDialog: false,
      renameAssetName: '',
      renameAssetLoading: false,
      deleteAssetLoading: false,
      mediaLoadError: '',
      returnFocus: null as HTMLElement | null,
      focusScope: null as ModalFocusScope | null,
      mediaRequest: 0,
      mediaLoadsInFlight: 0,
      mediaAbortController: null as AbortController | null,
      fileRemovalTimers: [] as number[],
      disposed: false
    }
  },
  computed: {
    editorKey() {
      return wikiStore.editor.editorKey
    },
    activeModal: {
      get() {
        return wikiStore.editor.activeModal
      },
      set(value: string) {
        wikiStore.editor.activeModal = value
      }
    },
    folderTree(): AssetFolder[] {
      return wikiStore.editor.media.folderTree as AssetFolder[]
    },
    currentFolderId: {
      get() {
        return wikiStore.editor.media.currentFolderId
      },
      set(value: number) {
        wikiStore.editor.media.currentFolderId = value
      }
    },
    currentFileId: {
      get() {
        return wikiStore.editor.media.currentFileId
      },
      set(value: number | null) {
        wikiStore.editor.media.currentFileId = value
      }
    },
    pageTotal () {
      if (!this.assets) {
        return 0
      }

      return Math.ceil(this.assets.length / 15)
    },
    headers() {
      return _.compact([
        this.$vuetify.display.smAndUp && { title: this.$t('editor:assets.headerId'), value: 'id', width: 80 },
        { title: this.$t('editor:assets.headerFilename'), value: 'filename' },
        this.$vuetify.display.lgAndUp && { title: this.$t('editor:assets.headerType'), value: 'ext', width: 90 },
        this.$vuetify.display.mdAndUp && { title: this.$t('editor:assets.headerFileSize'), value: 'fileSize', width: 110 },
        this.$vuetify.display.mdAndUp && { title: this.$t('editor:assets.headerAdded'), value: 'createdAt', width: 175 },
        this.$vuetify.display.smAndUp && { title: this.$t('editor:assets.headerActions'), value: '', width: 80, sortable: false, align: 'right' }
      ])
    },
    isFolderNameValid() {
      return this.newFolderName.length > 1 && !localeSegmentRegex.test(this.newFolderName) && !disallowedFolderChars.test(this.newFolderName)
    },
    currentAsset () {
      return _.find(this.assets, ['id', this.currentFileId])
    },
    isRenameValid (): boolean {
      const current = this.currentAsset
      const name = this.renameAssetName.trim()
      return Boolean(current && name && name !== current.filename && !/[\/\\]/.test(name))
    },
    isPrivatePage(): boolean {
      return wikiStore.page.visibility === 'private'
    },
    filePondServerOpts () {
      const jwtToken = Cookies.get('jwt')
      return {
        process: {
          url: '/u',
          headers: {
            'Authorization': `Bearer ${jwtToken}`
          }
        }
      }
    }
  },
  watch: {
    newFolderDialog(newValue: boolean) {
      if (newValue) {
        this.$nextTick(() => {
          if (!this.disposed && this.newFolderDialog) {
            focusInput(this.$refs.folderNameIpt)
          }
        })
      }
    },
    currentFolderId () {
      void this.loadMedia()
    }
  },
  mounted() {
    this.returnFocus = document.activeElement as HTMLElement | null
    this.$nextTick(() => {
      if (this.disposed) return
      const root = this.$el instanceof HTMLElement ? this.$el : null
      if (!root) return
      this.focusScope = markRaw(createModalFocusScope({
        root,
        restoreTarget: () => this.returnFocus,
        onEscape: this.cancel
      }))
      const refreshButton = this.$refs.refreshButton as { $el?: unknown } | undefined
      if (refreshButton?.$el instanceof HTMLElement) refreshButton.$el.focus()
    })
    void this.loadMedia()
  },
  beforeUnmount() {
    this.disposed = true
    this.mediaRequest++
    this.mediaAbortController?.abort()
    this.mediaAbortController = null
    for (const timer of this.fileRemovalTimers) window.clearTimeout(timer)
    this.fileRemovalTimers = []
    this.focusScope?.deactivate()
    this.focusScope = null
  },
  methods: {
    selectAsset(id: number) {
      this.currentFileId = id
    },
    prettyBytes(num: number) {
      if (typeof num !== 'number' || Number.isNaN(num)) {
        throw new TypeError('Expected a number')
      }

      const exponent = Math.min(Math.floor(Math.log(Math.abs(num)) / LOG_1000), BYTE_UNITS.length - 1)
      const neg = num < 0

      if (neg) {
        num = -num
      }
      if (num < 1) {
        return (neg ? '-' : '') + num + ' B'
      }
      const scaled = Number((num / Math.pow(1000, exponent)).toFixed(2))
      const unit = BYTE_UNITS[exponent]!

      return (neg ? '-' : '') + scaled + ' ' + unit
    },
    async refresh() {
      const loaded = await this.loadMedia()
      if (loaded) {
        wikiStore.showNotification({
          message: this.$t('editor:assets.refreshSuccess'),
          style: 'success',
          icon: 'check'
        })
      }
    },
    insert () {
      const asset = _.find(this.assets, ['id', this.currentFileId])
      if (!asset) throw new Error('No asset selected for insertion.')
      const assetPath = (this.folderTree as AssetFolder[]).map((f: AssetFolder) => f.slug).join('/')
      emitEditorInsert({
        kind: asset.kind,
        path: this.currentFolderId > 0 ? `/${assetPath}/${asset.filename}` : `/${asset.filename}`,
        text: asset.filename,
        align: this.imageAlignment
      })
      this.activeModal = ''
    },
    browse () {
      ;(this.$refs.pond as FilePondRef).browse()
    },
    async upload () {
      if (this.isPrivatePage) {
        throw new Error('Assets are site-wide and cannot be uploaded as private page content.')
      }
      const files = (this.$refs.pond as FilePondRef).getFiles()
      if (files.length < 1) {
        return wikiStore.showNotification({
          message: this.$t('editor:assets.noUploadError'),
          style: 'warning',
          icon: 'warning'
        })
      }
      for (const file of files) {
        file.setMetadata({
          folderId: this.currentFolderId
        })
      }
      await (this.$refs.pond as FilePondRef).processFiles()
    },
    async onFileProcessed (err: unknown, file: FilePondFile) {
      if (err) {
        return wikiStore.showNotification({
          message: this.$t('editor:assets.uploadFailed'),
          style: 'error',
          icon: 'error'
        })
      }
      const timer = window.setTimeout(() => {
        this.fileRemovalTimers = this.fileRemovalTimers.filter(value => value !== timer)
        if (!this.disposed) {
          ;(this.$refs.pond as FilePondRef | undefined)?.removeFile(file.id)
        }
      }, 5000)
      this.fileRemovalTimers.push(timer)

      await this.loadMedia()
    },
    downFolder(folder: AssetFolder) {
      wikiStore.pushMediaFolder(folder)
      this.currentFolderId = folder.id
      this.currentFileId = null
    },
    upFolder() {
      wikiStore.popMediaFolder()
      const parentFolder = _.last(this.folderTree as AssetFolder[])
      this.currentFolderId = parentFolder ? parentFolder.id : 0
      this.currentFileId = null
    },
    async createFolder() {
      if (this.newFolderLoading || !this.isFolderNameValid) return
      const folderId = this.currentFolderId
      const folderName = this.newFolderName
      wikiStore.startLoading('editor-media-createfolder')
      this.newFolderLoading = true
      try {
        await createAssetFolder(window.fetch.bind(window), folderId, folderName)
        if (this.disposed) return
        if (this.currentFolderId === folderId) await this.loadMedia()
        if (this.disposed) return
        wikiStore.showNotification({
          message: this.$t('editor:assets.folderCreateSuccess'),
          style: 'success',
          icon: 'check'
        })
        this.newFolderDialog = false
        this.newFolderName = ''
      } catch (err) {
        if (!this.disposed) wikiStore.showError(err)
      } finally {
        if (!this.disposed) this.newFolderLoading = false
        wikiStore.stopLoading('editor-media-createfolder')
      }
    },
    openRenameDialog(id: number) {
      this.currentFileId = id
      if (!this.currentAsset) throw new Error('No asset selected for renaming.')
      this.renameAssetName = this.currentAsset.filename
      this.renameDialog = true
    },
    openDeleteDialog(id: number) {
      this.currentFileId = id
      if (!this.currentAsset) throw new Error('No asset selected for deletion.')
      this.deleteDialog = true
    },
    async renameAsset() {
      if (this.renameAssetLoading || !this.isRenameValid || this.currentFileId === null) return
      const assetId = this.currentFileId
      const assetName = this.renameAssetName
      wikiStore.startLoading('editor-media-renameasset')
      this.renameAssetLoading = true
      try {
        await renameAssetRequest(window.fetch.bind(window), assetId, assetName)
        if (this.disposed) return
        await this.loadMedia()
        if (this.disposed) return
        wikiStore.showNotification({
          message: this.$t('editor:assets.renameSuccess'),
          style: 'success',
          icon: 'check'
        })
        this.renameDialog = false
        this.renameAssetName = ''
      } catch (err) {
        if (!this.disposed) wikiStore.showError(err)
      } finally {
        if (!this.disposed) this.renameAssetLoading = false
        wikiStore.stopLoading('editor-media-renameasset')
      }
    },
    async deleteAsset() {
      if (this.deleteAssetLoading || this.currentFileId === null) return
      const assetId = this.currentFileId
      wikiStore.startLoading('editor-media-deleteasset')
      this.deleteAssetLoading = true
      try {
        await deleteAssetRequest(window.fetch.bind(window), assetId)
        if (this.disposed) return
        if (this.currentFileId === assetId) this.currentFileId = null
        await this.loadMedia()
        if (this.disposed) return
        wikiStore.showNotification({
          message: this.$t('editor:assets.deleteSuccess'),
          style: 'success',
          icon: 'check'
        })
        this.deleteDialog = false
      } catch (err) {
        if (!this.disposed) wikiStore.showError(err)
      } finally {
        if (!this.disposed) this.deleteAssetLoading = false
        wikiStore.stopLoading('editor-media-deleteasset')
      }
    },
    async loadMedia (): Promise<boolean> {
      const request = ++this.mediaRequest
      this.mediaAbortController?.abort()
      const abortController = new AbortController()
      this.mediaAbortController = abortController
      this.loading = true
      this.mediaLoadError = ''
      this.mediaLoadsInFlight++
      if (this.mediaLoadsInFlight === 1) {
        wikiStore.startLoading('editor-media-list-refresh')
        wikiStore.startLoading('editor-media-folders-list-refresh')
      }
      try {
        const folderId = this.currentFolderId
        const fetchWithSignal = (url: string, init?: RequestInit) => window.fetch(url, {
          ...init,
          signal: abortController.signal
        })
        const [folders, assets] = await Promise.all([
          fetchAssetFolders(fetchWithSignal, folderId),
          fetchAssets(fetchWithSignal, folderId)
        ])
        if (this.disposed || request !== this.mediaRequest || folderId !== this.currentFolderId) return false
        this.folders = markRaw(folders)
        this.assets = markRaw(assets)
        if (this.currentFileId !== null && !assets.some(asset => asset.id === this.currentFileId)) {
          this.currentFileId = null
        }
        return true
      } catch (err) {
        if (this.disposed || request !== this.mediaRequest) return false
        this.mediaLoadError = 'Unable to load assets. Try again.'
        wikiStore.showError(err)
        return false
      } finally {
        if (this.mediaAbortController === abortController) {
          this.mediaAbortController = null
        }
        this.mediaLoadsInFlight--
        if (this.mediaLoadsInFlight === 0) {
          wikiStore.stopLoading('editor-media-list-refresh')
          wikiStore.stopLoading('editor-media-folders-list-refresh')
        }
        if (!this.disposed && request === this.mediaRequest) {
          this.loading = false
        }
      }
    },
    cancel () {
      this.activeModal = ''
    }
  }

})
</script>

<style lang='scss'>
.editor-modal-media {
  background: rgb(var(--v-theme-background)) !important;
  color: rgb(var(--v-theme-on-background));
  padding-bottom: env(safe-area-inset-bottom);
  height: calc(100dvh - 112px - 24px);
  left: 64px;
  overflow: auto;
  position: fixed !important;
  top: 112px;
  width: calc(100vw - 64px);
  z-index: 10;

  @include until($tablet) {
    height: calc(100dvh - 56px - 24px);
    left: 0;
    width: 100vw;
  }

  &.is-editor-visual-markdown {
    height: calc(100dvh - 64px - 24px);
    left: 0;
    top: 64px;
    width: 100vw;

    @include until($tablet) {
      height: calc(100dvh - 56px - 24px);
      top: 56px;
    }
  }
  &.is-editor-ckeditor {
    top: 64px;
    left: 0;
    width: 100%;
    height: calc(100dvh - 64px - 26px);

    @include until($tablet) {
      top: 56px;
      left: 0;
      width: 100%;
      height: calc(100dvh - 56px - 24px);
    }
  }

  &.is-editor-code {
    top: 64px;
    height: calc(100dvh - 64px - 24px);

    @include until($tablet) {
      top: 56px;
      height: calc(100dvh - 56px - 24px);
    }
  }

  &.is-editor-common {
    top: 64px;
    left: 0;
    width: 100%;
    height: calc(100dvh - 64px - 24px);

    @include until($tablet) {
      top: 56px;
      left: 0;
      width: 100%;
      height: calc(100dvh - 56px - 24px);
    }
  }

  .v-toolbar {
    background: color-mix(in srgb, rgb(var(--v-theme-surface)) 94%, rgb(var(--v-theme-primary)) 6%) !important;
    border: 1px solid rgba(var(--v-theme-on-surface), .12);
    color: rgb(var(--v-theme-on-surface));
  }
  .v-toolbar {
    .text-white,
    .text-teal,
    .text-teal-lighten-3,
    .v-icon {
      color: rgb(var(--v-theme-on-surface)) !important;
    }
  }

  .v-card {
    background: rgb(var(--v-theme-surface));
    color: rgb(var(--v-theme-on-surface));
  }

  tr.is-clickable {
    cursor: pointer;

    &:focus-visible {
      outline: 2px solid rgba(var(--v-theme-primary), .7);
      outline-offset: -2px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    &,
    * {
      animation: none !important;
      transition: none !important;
    }
  }

  .filepond--root {
    margin-bottom: 0;
  }

  .filepond--drop-label {
    cursor: pointer;

    > label {
      cursor: pointer;
    }
  }

  .filepond--file-action-button.filepond--action-process-item {
    display: none;
  }

  .editor-media-icon-button {
    padding: 0 20px;
  }
}
</style>
