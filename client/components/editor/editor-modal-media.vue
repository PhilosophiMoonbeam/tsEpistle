<template lang='pug'>
  v-card.editor-modal-media.animated.fadeInLeft(flat, rounded='0', :class='`is-editor-` + editorKey')
    v-container.pa-3(fluid)
      v-row
        v-col(cols='12', lg='9')
          v-card.radius-7.animated.fadeInLeft.wait-p1s
            v-card-text
              .d-flex
                v-toolbar.radius-7(:color='$vuetify.theme.current.dark ? `teal` : `teal-lighten-5`', density="compact", flat, height='44')
                  .text-body-medium(:class='$vuetify.theme.current.dark ? `text-white` : `text-teal`') {{$t('editor:assets.title')}}
                  v-spacer
                  v-btn(variant="text", icon, @click='refresh')
                    v-icon(:color='$vuetify.theme.current.dark ? `white` : `teal`') mdi-refresh
                v-dialog(v-model='newFolderDialog', max-width='550')
                  template(v-slot:activator='{ props }')
                    v-btn.ml-3.my-0.mr-0.radius-7(variant="outlined", size="large", color='teal', :icon='$vuetify.display.xsOnly', v-bind='props')
                      v-icon(:start='$vuetify.display.mdAndUp') mdi-plus
                      span.hidden-sm-and-down(:class='$vuetify.theme.current.dark ? `text-teal-lighten-3` : ``') {{$t('editor:assets.newFolder')}}
                  v-card
                    .dialog-header.is-short.text-body-large {{$t('editor:assets.newFolder')}}
                    v-card-text.pt-5
                      v-text-field.md2(
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
                v-btn.is-icon.mx-1(:color='$vuetify.theme.current.dark ? `grey-lighten-1` : `grey-darken-2`', variant="outlined", @click='upFolder()', :disabled='currentFolderId === 0')
                  v-icon mdi-folder-upload
                v-btn.btn-normalcase.mx-1(v-for='folder of folders', :key='folder.id', variant="flat",  color="grey-darken-2", @click='downFolder(folder)')
                  v-icon(start) mdi-folder
                  span.text-body-small(style='text-transform: none;') {{ folder.name }}
                v-divider.mt-2
              v-data-table(
                :items='assets'
                :headers='headers'
                v-model:page='pagination'
                :items-per-page='15'
                :loading='loading'
                must-sort,
                :sort-by="[{ key: 'id', order: 'desc' }]"
                hide-default-footer,
                density="compact"
              )
                template(v-slot:item='props')
                  tr.is-clickable(
                    @click.left='currentFileId = props.item.id'
                    @click.right.prevent=''
                    :class='currentFileId === props.item.id ? ($vuetify.theme.current.dark ? `bg-grey-darken-3-d5` : `bg-teal-lighten-5`) : ``'
                    )
                    td.text-body-small(v-if='$vuetify.display.smAndUp') {{ props.item.id }}
                    td
                      .text-body-medium: strong(:class='currentFileId === props.item.id ? `text-teal` : ``') {{ props.item.filename }}
                      .text-body-small.text-grey {{ props.item.description }}
                    td.text-xs-center(v-if='$vuetify.display.lgAndUp')
                      v-chip.ma-0(size="x-small", :color='$vuetify.theme.current.dark ? `grey-darken-4` : `grey-lighten-4`')
                        .text-label-small {{props.item.ext.toUpperCase().substring(1)}}
                    td.text-body-small(v-if='$vuetify.display.mdAndUp') {{ prettyBytes(props.item.fileSize) }}
                    td.text-body-small(v-if='$vuetify.display.mdAndUp') {{ $helpers.formatMoment(props.item.createdAt, 'from') }}
                    td(v-if='$vuetify.display.smAndUp')
                      v-menu(min-width='200')
                        template(v-slot:activator='{ props }')
                          v-btn(icon, v-bind='props', rounded='0', size="small", @click.left='currentFileId = props.item.id')
                            v-icon(color="grey-darken-2") mdi-dots-horizontal
                        v-list(nav, style='border-top: 5px solid #444;')
                          //- v-list-item(@click='', disabled)
                          //-   v-list-item-avatar(size='24')
                          //-     v-icon(color='teal') mdi-text-short
                          //-   v-list-item-content {{$t('common:actions.properties')}}
                          //- template(v-if='props.item.kind === `IMAGE`')
                          //-   v-list-item(@click='previewDialog = true', disabled)
                          //-     v-list-item-avatar(size='24')
                          //-       v-icon(color='green') mdi-image-search-outline
                          //-     v-list-item-content {{$t('common:actions.preview')}}
                          //-   v-list-item(@click='', disabled)
                          //-     v-list-item-avatar(size='24')
                          //-       v-icon(color='indigo') mdi-crop-rotate
                          //-     v-list-item-content {{$t('common:actions.edit')}}
                          //-   v-list-item(@click='', disabled)
                          //-     v-list-item-avatar(size='24')
                          //-       v-icon(color='purple') mdi-flash-circle
                          //-     v-list-item-content {{$t('common:actions.optimize')}}
                          v-list-item(@click='openRenameDialog')
                            template(v-slot:prepend)
                              v-avatar(size='24')
                                v-icon(color='orange') mdi-keyboard-outline
                            v-list-item-title {{$t('common:actions.rename')}}
                          //- v-list-item(@click='', disabled)
                          //-   v-list-item-avatar(size='24')
                          //-     v-icon(color='blue') mdi-file-move
                          //-   v-list-item-content {{$t('common:actions.move')}}
                          v-list-item(@click='deleteDialog = true')
                            template(v-slot:prepend)
                              v-avatar(size='24')
                                v-icon(color='red') mdi-file-hidden
                            v-list-item-title {{$t('common:actions.delete')}}
                template(v-slot:no-data)
                  v-alert.mt-3.radius-7(icon='mdi-folder-open-outline', :model-value='true', variant="outlined", color='teal') {{$t('editor:assets.folderEmpty')}}
              .text-xs-center.py-2(v-if='this.pageTotal > 1')
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
                v-btn.my-0.ml-3.mr-0.radius-7(variant="outlined", size="large", color='teal', @click='browse', v-if='$vuetify.display.mdAndUp')
                  v-icon(start) mdi-plus-box-multiple
                  span(:class='$vuetify.theme.current.dark ? `text-teal-lighten-3` : ``') {{$t('common:actions.browse')}}
              file-pond.mt-3(
                name='mediaUpload'
                ref='pond'
                :label-idle='$t(`editor:assets.uploadAssetsDropZone`)'
                allow-multiple='true'
                :files='files'
                max-files='10'
                :server='filePondServerOpts'
                :instant-upload='false'
                :allow-revert='false'
                @processfile='onFileProcessed'
              )
            v-divider(v-if='!isPrivatePage')
            v-card-actions.pa-3(v-if='!isPrivatePage')
              .text-body-small.text-grey.text-darken-2 Max 10 files, 5 MB each
              v-spacer
              v-btn.px-4(color='teal', @click='upload') {{$t('common:actions.upload')}}


          v-card.mt-3.radius-7.animated.fadeInRight.wait-p4s
            v-card-text.pb-0
              v-toolbar.radius-7(:color='$vuetify.theme.current.dark ? `teal` : `teal-lighten-5`', density="compact", flat)
                v-icon.mr-3(:color='$vuetify.theme.current.dark ? `white` : `teal`') mdi-format-align-top
                .text-body-medium(:class='$vuetify.theme.current.dark ? `text-white` : `text-teal`') {{$t('editor:assets.imageAlign')}}
              v-select.mt-3(
                v-model='imageAlignment'
                :items='imageAlignments'
                variant="outlined"
                single-line
                color='teal'
                placeholder='None'
              )

    //- RENAME DIALOG

    v-dialog(v-model='renameDialog', max-width='550', persistent)
      v-card
        .dialog-header.is-short.is-orange
          v-icon.mr-2(color='white') mdi-keyboard
          span {{$t('editor:assets.renameAsset')}}
        v-card-text.pt-5
          .text-body-medium {{$t('editor:assets.renameAssetSubtitle')}}
          v-text-field(
            variant="outlined"
            single-line
            :counter='255'
            v-model='renameAssetName'
            @keyup.enter='renameAsset'
            :disabled='renameAssetLoading'
          )
        div.v-card-chin
          v-spacer
          v-btn(variant="text", @click='renameDialog = false', :disabled='renameAssetLoading') {{$t('common:actions.cancel')}}
          v-btn.px-3(color="orange-darken-3", @click='renameAsset', :loading='renameAssetLoading').text-white {{$t('common:actions.rename')}}

    //- DELETE DIALOG

    v-dialog(v-model='deleteDialog', max-width='550', persistent)
      v-card
        .dialog-header.is-short.is-red
          v-icon.mr-2(color='white') mdi-trash-can-outline
          span {{$t('editor:assets.deleteAsset')}}
        v-card-text.pt-5
          .text-body-medium {{$t('editor:assets.deleteAssetConfirm')}}
          .text-body-medium.text-red-darken-2 {{currentAsset.filename}}?
          .text-body-small.mt-3 {{$t('editor:assets.deleteAssetWarn')}}
        div.v-card-chin
          v-spacer
          v-btn(variant="text", @click='deleteDialog = false', :disabled='deleteAssetLoading') {{$t('common:actions.cancel')}}
          v-btn.px-3(color="red-darken-2", @click='deleteAsset', :loading='deleteAssetLoading').text-white {{$t('common:actions.delete')}}</template>

<script lang='ts'>
import { defineComponent, type Component } from 'vue'
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'
import Cookies from 'js-cookie'
import vueFilePond from 'vue-filepond'
import 'filepond/dist/filepond.min.css'
import { createAssetFolder, deleteAsset as deleteAssetRequest, fetchAssetFolders, fetchAssets, renameAsset as renameAssetRequest, type Asset, type AssetFolder } from '../../helpers/assets-api'
import { emitEditorInsert } from '../../helpers/editor-insert-events'

const FilePond = vueFilePond() as unknown as Component
const localeSegmentRegex = /^[A-Z]{2}(-[A-Z]{2})?$/i
const disallowedFolderChars = /[A-Z()=.!@#$%?&*+`~<>,;:\\/[\]¬{| ]/

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

export default defineComponent({
  emits: ['update:modelValue'],
  components: {
    FilePond
  },
  props: {
    modelValue: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      folders: [] as AssetFolder[],
      files: [] as FilePondFile[],
      assets: [] as Asset[],
      pagination: 1,
      remoteImageUrl: '',
      imageAlignments: [
        { text: 'None', value: '' },
        { text: 'Left', value: 'left' },
        { text: 'Centered', value: 'center' },
        { text: 'Right', value: 'right' },
        { text: 'Absolute Top Right', value: 'abstopright' }
      ],
      imageAlignment: '',
      loading: false,
      newFolderDialog: false,
      newFolderName: '',
      newFolderLoading: false,
      previewDialog: false,
      renameDialog: false,
      renameAssetName: '',
      renameAssetLoading: false,
      deleteDialog: false,
      deleteAssetLoading: false
    }
  },
  computed: {
    isShown: {
      get() { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    },
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
          ;(this.$refs.folderNameIpt as { focus: () => void }).focus()
        })
      }
    },
    currentFolderId () {
      this.loadMedia()
    }
  },
  mounted() {
    this.loadMedia()
  },
  methods: {
    prettyBytes(num: number) {
      if (typeof num !== 'number' || isNaN(num)) {
        throw new TypeError('Expected a number')
      }

      const exponent = Math.min(Math.floor(Math.log(Math.abs(num)) / Math.log(1000)), 8)
      const neg = num < 0
      const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']

      if (neg) {
        num = -num
      }
      if (num < 1) {
        return (neg ? '-' : '') + num + ' B'
      }
      const scaled = Number((num / Math.pow(1000, exponent)).toFixed(2))
      const unit = units[exponent]!

      return (neg ? '-' : '') + scaled + ' ' + unit
    },
    async refresh() {
      await this.loadMedia()
      wikiStore.showNotification({
        message: this.$t('editor:assets.refreshSuccess'),
        style: 'success',
        icon: 'check'
      })
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
      for (let file of files) {
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
      _.delay(() => {
        ;(this.$refs.pond as FilePondRef).removeFile(file.id)
      }, 5000)

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
      wikiStore.startLoading('editor-media-createfolder')
      this.newFolderLoading = true
      try {
        await createAssetFolder(window.fetch.bind(window), this.currentFolderId, this.newFolderName)
        await this.loadMedia()
        wikiStore.showNotification({
          message: this.$t('editor:assets.folderCreateSuccess'),
          style: 'success',
          icon: 'check'
        })
        this.newFolderDialog = false
        this.newFolderName = ''
      } catch (err) {
        wikiStore.showError(err)
      }
      this.newFolderLoading = false
      wikiStore.stopLoading('editor-media-createfolder')
    },
    openRenameDialog() {
      if (!this.currentAsset) throw new Error('No asset selected for renaming.')
      this.renameAssetName = this.currentAsset.filename
      this.renameDialog = true
    },
    async renameAsset() {
      wikiStore.startLoading('editor-media-renameasset')
      this.renameAssetLoading = true
      try {
        if (this.currentFileId === null) throw new Error('No asset selected for renaming.')
        await renameAssetRequest(window.fetch.bind(window), this.currentFileId, this.renameAssetName)
        await this.loadMedia()
        wikiStore.showNotification({
          message: this.$t('editor:assets.renameSuccess'),
          style: 'success',
          icon: 'check'
        })
        this.renameDialog = false
        this.renameAssetName = ''
      } catch (err) {
        wikiStore.showError(err)
      }
      this.renameAssetLoading = false
      wikiStore.stopLoading('editor-media-renameasset')
    },
    async deleteAsset() {
      wikiStore.startLoading('editor-media-deleteasset')
      this.deleteAssetLoading = true
      try {
        if (this.currentFileId === null) throw new Error('No asset selected for deletion.')
        await deleteAssetRequest(window.fetch.bind(window), this.currentFileId)
        this.currentFileId = null
        await this.loadMedia()
        wikiStore.showNotification({
          message: this.$t('editor:assets.deleteSuccess'),
          style: 'success',
          icon: 'check'
        })
        this.deleteDialog = false
      } catch (err) {
        wikiStore.showError(err)
      }
      this.deleteAssetLoading = false
      wikiStore.stopLoading('editor-media-deleteasset')
    },
    async loadMedia () {
      this.loading = true
      wikiStore.startLoading('editor-media-list-refresh')
      wikiStore.startLoading('editor-media-folders-list-refresh')
      try {
        const [folders, assets] = await Promise.all([
          fetchAssetFolders(window.fetch.bind(window), this.currentFolderId),
          fetchAssets(window.fetch.bind(window), this.currentFolderId)
        ])
        this.folders = folders
        this.assets = assets
      } finally {
        this.loading = false
        wikiStore.stopLoading('editor-media-list-refresh')
        wikiStore.stopLoading('editor-media-folders-list-refresh')
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
  position: fixed !important;
  top: 112px;
  left: 64px;
  z-index: 10;
  width: calc(100vw - 64px - 17px);
  height: calc(100vh - 112px - 24px);
  background-color: rgba(darken(mc('grey', '900'), 3%), .9) !important;
  overflow: auto;

  @include until($tablet) {
    left: 40px;
    width: calc(100vw - 40px);
    height: calc(100vh - 112px - 24px);
  }

  &.is-editor-ckeditor {
    top: 64px;
    left: 0;
    width: 100%;
    height: calc(100vh - 64px - 26px);

    @include until($tablet) {
      top: 56px;
      left: 0;
      width: 100%;
      height: calc(100vh - 56px - 24px);
    }
  }

  &.is-editor-code {
    top: 64px;
    height: calc(100vh - 64px - 26px);

    @include until($tablet) {
      top: 56px;
      height: calc(100vh - 56px - 24px);
    }
  }

  &.is-editor-common {
    top: 64px;
    left: 0;
    width: 100%;
    height: calc(100vh - 64px);

    @include until($tablet) {
      top: 56px;
      left: 0;
      width: 100%;
      height: calc(100vh - 56px);
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

  .v-btn--icon {
    padding: 0 20px;
  }
}
</style>
