<template lang='pug'>
  v-card.editor-modal-media.animated.fadeInLeft(flat, rounded='xl', :class='[`is-editor-${editorKey}`, { "is-editor-embedded": embedded, "is-page-branding": isBranding }]', :role='embedded ? undefined : `dialog`', :aria-modal='embedded ? undefined : `true`', aria-labelledby='editor-media-title', tabindex='-1')
    .editor-media-layout
      section.editor-media-browser(aria-labelledby='editor-media-title')
        v-card.editor-media-panel.radius-7.animated.fadeInLeft.wait-p1s
          v-card-text.editor-media-panel-content
            header.editor-media-header
              h2.editor-media-heading#editor-media-title {{ $t('editor:assets.title') }}
              v-btn.editor-media-icon-button(ref='refreshButton', variant="text", icon, aria-label='Refresh assets', @click='refresh')
                v-icon mdi-refresh
              v-dialog(
                v-model='newFolderDialog'
                max-width='550'
                :persistent='newFolderLoading'
                content-class='editor-media-owned-overlay'
                aria-labelledby='editor-media-new-folder-title'
              )
                template(v-slot:activator='{ props }')
                  v-btn.editor-media-new-folder.radius-7(variant="tonal", color='primary', :icon='$vuetify.display.xs', :class='{ "editor-media-icon-button": $vuetify.display.xs }', aria-label='Create folder', v-bind='props')
                    v-icon(:start='$vuetify.display.mdAndUp') mdi-plus
                    span.d-none.d-md-inline {{$t('editor:assets.newFolder')}}
                v-card(:aria-busy='newFolderLoading')
                  .dialog-header.is-short.text-body-large#editor-media-new-folder-title {{$t('editor:assets.newFolder')}}
                  v-card-text.pt-5
                    v-text-field(
                      variant="outlined"
                      prepend-icon='mdi-folder-outline'
                      v-model='newFolderName'
                      :label='$t(`editor:assets.folderName`)'
                      counter='255'
                      maxlength='255'
                      :disabled='newFolderLoading'
                      @keyup.enter='createFolder'
                      ref='folderNameIpt'
                      )
                    i18next.text-body-small.text-grey-darken-1.pl-5(path='editor:assets.folderNameNamingRules', tag='div')
                      a(place='namingRules', href='https://docs-beta.requarks.io/guide/assets#naming-restrictions', target='_blank') {{$t('editor:assets.folderNameNamingRulesLink')}}
                  v-card-chin
                    v-spacer
                    v-btn(variant="text", :disabled='newFolderLoading', @click='newFolderDialog = false') {{$t('common:actions.cancel')}}
                    v-btn.px-3(color='primary', @click='createFolder', :disabled='newFolderLoading || !isFolderNameValid', :loading='newFolderLoading') {{$t('common:actions.create')}}
            .editor-media-path(aria-label='Current folder')
              template(v-if='folderTree.length > 0')
                .text-body-medium
                  span.mr-1 /
                  template(v-for='folder of folderTree', :key='folder.id')
                    span {{folder.name}}
                    span.mx-1 /
              .text-body-medium(v-else) / #[em root]
            .editor-media-folders(v-if='folders.length > 0 || currentFolderId > 0')
              v-btn.editor-media-icon-button(variant="outlined", icon, aria-label='Open parent folder', @click='upFolder()', :disabled='currentFolderId === 0')
                v-icon mdi-folder-upload
              v-btn.editor-media-folder(v-for='folder of folders', :key='folder.id', variant="tonal", color="primary", @click='downFolder(folder)')
                v-icon(start) mdi-folder
                span.text-body-small {{ folder.name }}
            v-alert.editor-media-branding-notice.mb-3(v-if='isBranding', type='info', variant='tonal', density='compact')
              .text-body-small Page branding accepts static PNG, JPEG, and WebP images up to 5 MB. Animated, vector, and other file types cannot be used.
            v-alert.mb-3(v-if='mediaLoadError', type='error', variant='tonal', role='alert')
              .d-flex.align-center
                span {{mediaLoadError}}
                v-spacer
                v-btn(variant='text', size='small', @click='refresh') Retry
            v-data-table.editor-media-table(
              :headers='headers'
              :items='displayedAssets'
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
                  :class='{ "is-stale": !isAssetActionable(props.item.id) }'
                  :tabindex='isAssetActionable(props.item.id) ? 0 : -1'
                  :aria-selected='currentFileId === props.item.id'
                  :aria-disabled='!isAssetActionable(props.item.id)'
                  :aria-label='assetAriaLabel(props.item)'
                  @keydown.enter.space.prevent='isAssetActionable(props.item.id) && selectAsset(props.item.id)'
                  @click.left='isAssetActionable(props.item.id) && selectAsset(props.item.id)'
                  @click.right.prevent=''
                )
                  td.text-body-small(v-if='$vuetify.display.smAndUp') {{ props.item.id }}
                  td.editor-media-filename
                    .text-body-medium: strong(:class='currentFileId === props.item.id ? `text-primary` : ``') {{ props.item.filename }}
                    .text-body-small.text-grey {{ props.item.description }}
                  td.text-center(v-if='$vuetify.display.lgAndUp')
                    v-chip.ma-0(size="x-small", variant="tonal")
                      .text-label-small {{props.item.ext.toUpperCase().substring(1)}}
                  td.text-body-small(v-if='$vuetify.display.mdAndUp') {{ prettyBytes(props.item.fileSize) }}
                  td.text-body-small(v-if='$vuetify.display.mdAndUp') {{ $helpers.formatMoment(props.item.createdAt, 'from') }}
                  td(v-if='$vuetify.display.smAndUp')
                    v-menu(
                      :disabled='!isAssetActionable(props.item.id)'
                      :model-value='actionMenuAssetId === props.item.id'
                      min-width='200'
                      content-class='editor-media-owned-overlay'
                      @update:model-value='setActionMenu(props.item.id, $event)'
                    )
                      template(v-slot:activator='{ props: menuProps }')
                        v-btn.editor-media-icon-button(icon, v-bind='menuProps', rounded='lg', size="small", :disabled='!isAssetActionable(props.item.id)', :aria-label='`Asset actions for ${props.item.filename}`', :data-editor-media-asset-actions='props.item.id')
                          v-icon mdi-dots-horizontal
                      v-list(nav)
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
                        v-list-item(:disabled='!isAssetActionable(props.item.id)', @click='openRenameDialog(props.item.id)')
                          template(v-slot:prepend)
                            v-avatar(size="24")
                              v-icon(color='warning') mdi-keyboard-outline
                          v-list-item-title {{$t('common:actions.rename')}}
                        v-list-item(:disabled='!isAssetActionable(props.item.id)', @click='openMoveDialog(props.item.id)', prepend-icon='mdi-file-move')
                          v-list-item-title {{$t('editor:assets.moveAsset')}}
                        v-list-item(:disabled='!isAssetActionable(props.item.id)', @click='openDeleteDialog(props.item.id)')
                          template(v-slot:prepend)
                            v-avatar(size="24")
                              v-icon(color='red') mdi-file-hidden
                          v-list-item-title {{$t('common:actions.delete')}}
              template(v-slot:no-data)
                v-alert.mt-3.radius-7(v-if='!mediaLoadError', icon='mdi-folder-open-outline', :model-value='true', variant="outlined") {{$t('editor:assets.folderEmpty')}}
            v-alert.mt-3(v-if='isBranding && currentFileId !== null && brandingLoading', type='info', variant='tonal', density='compact')
              .text-body-small Validating the selected image…
            v-alert.mt-3(v-else-if='isBranding && brandingLoadError', type='warning', variant='tonal', density='compact', role='alert')
              .text-body-small {{brandingLoadError}}
            .text-center.py-2(v-if='pageTotal > 1')
              v-pagination(v-model='pagination', :length='pageTotal', color='primary')
            footer.editor-media-footer
              .editor-media-count.text-body-medium.text-medium-emphasis {{$t('editor:assets.fileCount', { count: displayedAssets.length })}}
              .editor-media-actions
                v-btn.radius-7(variant="outlined", @click='cancel')
                  v-icon(start) mdi-close
                  span {{$t('common:actions.cancel')}}
                v-btn.radius-7(v-if='!isBranding', color='primary', @click='insert', :disabled='!currentFileId || !isAssetActionable(currentFileId)')
                  v-icon(start) mdi-playlist-plus
                  span {{$t('common:actions.insert')}}
                v-btn.radius-7(v-else, color='primary', @click='confirmSelection', :disabled='!canConfirmSelection', :loading='brandingLoading')
                  v-icon(start) mdi-image-check-outline
                  span Use image

      aside.editor-media-sidebar
        v-card.editor-media-panel.radius-7.animated.fadeInRight.wait-p3s
          v-alert.mb-0(v-if='isPrivatePage', type='info', variant="outlined", density="compact") Assets are site-wide and cannot be uploaded as private page content.
          v-card-text.editor-media-panel-content(v-if='!isPrivatePage')
            header.editor-media-header.editor-media-upload-header
              h2.editor-media-heading
                v-icon(aria-hidden='true') mdi-cloud-upload-outline
                span {{$t('editor:assets.uploadAssets')}}
              v-btn.editor-media-browse.radius-7(variant="tonal", color='primary', aria-label='Browse files', @click='browse')
                v-icon(start) mdi-plus-box-multiple
                span {{$t('common:actions.browse')}}
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
          .editor-media-upload-footer(v-if='!isPrivatePage')
            .text-body-small.text-medium-emphasis Max 10 files, 5 MB each
            v-btn(color='primary', @click='upload') {{$t('common:actions.upload')}}


        v-card.editor-media-panel.radius-7.animated.fadeInRight.wait-p4s(v-if='!isBranding && currentAsset && currentAsset.kind === `IMAGE`')
          v-card-text.editor-media-panel-content.pb-0
            h2.editor-media-heading
              v-icon(aria-hidden='true') mdi-format-align-top
              span {{$t('editor:assets.imageAlign')}}
            v-select.mt-3(
              v-model='imageAlignment'
              :items='imageAlignments'
              variant="outlined"
              single-line
              color='primary'
              placeholder='None'
            )

    //- RENAME OR MOVE DIALOG

    v-dialog(
      v-model='renameDialog'
      max-width='550'
      :persistent='renameAssetLoading'
      content-class='editor-media-owned-overlay'
      aria-labelledby='editor-media-rename-title'
      @after-leave='restoreMediaDialogFocus'
    )
      v-card(:aria-busy='renameAssetLoading')
        .dialog-header.is-short.is-orange
          v-icon.mr-2(color='primary', aria-hidden='true') mdi-file-move
          span#editor-media-rename-title {{relocationMode === 'move' ? $t('editor:assets.moveAsset') : $t('editor:assets.renameAsset')}}
        v-card-text.pt-5
          .text-body-medium {{relocationMode === 'move' ? $t('editor:assets.moveAssetSubtitle') : $t('editor:assets.renameAssetSubtitle')}}
          v-text-field(
            variant="outlined"
            single-line
            :counter='255'
            maxlength='255'
            v-model='renameAssetName'
            :label='$t(`common:actions.rename`)'
            ref='renameAssetIpt'
            :rules='renameAssetRules'
            @keyup.enter='relocateAsset'
            :disabled='renameAssetLoading'
          )
          v-select(
            v-model='relocationFolderId'
            :items='relocationFolderItems'
            item-title='title'
            item-value='value'
            :label='$t(relocationMode === "move" ? "editor:assets.destinationFolder" : "editor:assets.destinationFolderOptional")'
            variant='outlined'
            :disabled='renameAssetLoading'
          )
          v-alert.mt-2(type='warning', variant='tonal', density='compact', role='alert')
            .text-body-small {{$t('editor:assets.relocationWarning')}}
            .text-caption {{relocationReceipt?.sourcePath ?? relocationSourcePath}} → {{relocationReceipt?.destinationPath ?? relocationDestinationPath}}
          v-alert.mt-2(
            v-if='relocationReceipt'
            :type='relocationStatusType'
            variant='tonal'
            density='compact'
            role='status'
            aria-live='polite'
          )
            .text-body-small {{relocationStatusMessage}}
            .text-caption {{$t('editor:assets.relocationReceipt', { id: relocationReceipt.id })}}
            a.text-caption(
              :href='relocationReceipt.statusUrl'
              target='_blank'
              rel='noopener noreferrer'
              :aria-label='$t(`editor:assets.viewRelocationStatusAria`)'
            ) {{$t('editor:assets.viewRelocationStatus')}}
            ul(v-if='relocationReceipt.effects.length > 0')
              li(v-for='effect in relocationReceipt.effects' :key='effect.id')
                | {{effect.targetKey}}: {{relocationEffectMessage(effect.status)}}
        v-card-chin
          v-spacer
          v-btn(variant="text", @click='renameDialog = false', :disabled='renameAssetLoading') {{$t('common:actions.cancel')}}
          v-btn.px-3(color="warning", variant="flat", @click='relocateAsset', :loading='renameAssetLoading', :disabled='renameAssetLoading || !isRenameValid') {{$t(relocationMode === 'move' ? 'common:actions.move' : 'common:actions.rename')}}
    //- DELETE DIALOG

    v-dialog(
      v-model='deleteDialog'
      max-width='550'
      :persistent='deleteAssetLoading'
      content-class='editor-media-owned-overlay'
      role='alertdialog'
      aria-labelledby='editor-media-delete-title'
      aria-describedby='editor-media-delete-description'
      @after-leave='restoreMediaDialogFocus'
    )
      v-card(:aria-busy='deleteAssetLoading')
        .dialog-header.is-short.is-red
          v-icon.mr-2(color='white', aria-hidden='true') mdi-trash-can-outline
          span#editor-media-delete-title {{$t('editor:assets.deleteAsset')}}
        v-card-text.pt-5#editor-media-delete-description
          .text-body-medium {{$t('editor:assets.deleteAssetConfirm')}}
          .text-body-medium.text-red-darken-2 {{currentAsset?.filename}}?
          .text-body-small.mt-3 {{$t('editor:assets.deleteAssetWarn')}}
        v-card-chin
          v-btn(variant="text", ref='deleteCancelButton', @click='deleteDialog = false', :disabled='deleteAssetLoading') {{$t('common:actions.cancel')}}
          v-btn.px-3(color="red-darken-2", @click='deleteAsset', :loading='deleteAssetLoading', :disabled='deleteAssetLoading').text-white {{$t('common:actions.delete')}}
</template>

<script lang='ts'>
import { defineComponent, markRaw, type Component, type PropType } from 'vue'
import _ from 'lodash'
import { createAssetFolder, deleteAsset as deleteAssetRequest, fetchAssetBranding, fetchAssetFolders, fetchAssetRelocationStatus, fetchAssets, relocateAsset as relocateAssetRequest, type Asset, type AssetFolder, type AssetRelocationInput, type AssetRelocationReceipt } from '../../helpers/assets-api'
import { wikiStore } from '@/store/index.ts'
import vueFilePond from 'vue-filepond'
import 'filepond/dist/filepond.min.css'
import { isRecord } from '../../helpers/type-guards'
import { PageBrandingAssignmentSchema, PageBrandingViewSchema, type PageBrandingAssignment, type PageBrandingView } from '../../../shared/page-branding.ts'
import { emitEditorInsert } from '../../helpers/editor-insert-events'
import { createModalFocusScope, type ModalFocusScope } from '../common/modal-focus-scope'

const FilePond = vueFilePond() as unknown as Component
const localeSegmentRegex = /^[A-Z]{2}(-[A-Z]{2})?$/i
const disallowedFolderChars = /[A-Z()=.!@#$%?&*+`~<>,;:\\/[\]¬{| ]/
const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
const LOG_1000 = Math.log(1000)
const IMAGE_ALIGNMENTS = markRaw([
  { title: 'None', value: '' },
  { title: 'Left', value: 'left' },
  { title: 'Centered', value: 'center' },
  { title: 'Right', value: 'right' },
  { title: 'Absolute Top Right', value: 'abstopright' }
])
const MEDIA_SORT_BY = markRaw([{ key: 'id', order: 'desc' as const }])
const RENAME_ASSET_RULES = markRaw([
  (value: unknown) => !!String(value || '').trim() || 'A filename is required.',
  (value: unknown) => String(value || '').length <= 255 || 'Filename must be 255 characters or fewer.',
  (value: unknown) => (!String(value || '').includes('/') && !String(value || '').includes(String.fromCharCode(92))) || 'Filename cannot contain slashes.'
])

type AssetTableHeader = {
  title: string
  key: string
  value: string
  width?: number
  sortable?: boolean
  align?: 'start' | 'end' | 'center'
}
export type MediaPickerPurpose = 'insert' | 'page-branding'

export type BrandingSelection = {
  assignment: PageBrandingAssignment
  view: PageBrandingView
}

const BRANDING_IMAGE_EXTENSIONS: Record<string, true> = {
  '.png': true,
  '.jpg': true,
  '.jpeg': true,
  '.webp': true
}

function isPageBrandingAsset (asset: Asset): boolean {
  return asset.kind.toUpperCase() === 'IMAGE' && Object.hasOwn(BRANDING_IMAGE_EXTENSIONS, asset.ext.toLowerCase())
}

function parseAssetId (value: unknown): number | null {
  const normalized = typeof value === 'string' ? value.trim() : value
  if (typeof normalized === 'string' && !/^[0-9]+$/.test(normalized)) return null
  const id = typeof normalized === 'number' ? normalized : Number(normalized)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function extractUploadAssetId (response: unknown): number | null {
  let payload = response
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch {
      return parseAssetId(payload)
    }
  }
  if (isRecord(payload)) {
    const nestedAsset = isRecord(payload.asset) ? payload.asset : null
    for (const candidate of [payload.assetId, payload.id, nestedAsset?.assetId, nestedAsset?.id]) {
      const id = parseAssetId(candidate)
      if (id !== null) return id
    }
    return null
  }
  return parseAssetId(payload)
}

function isAbortError (error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

type FilePondFile = {
  id: string
  serverId?: unknown
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
  props: {
    purpose: {
      type: String as PropType<MediaPickerPurpose>,
      default: 'insert'
    },
    embedded: {
      type: Boolean,
      default: false
    }
  },
  emits: {
    'branding-selected': (payload: BrandingSelection) => {
      const assignment = PageBrandingAssignmentSchema.safeParse(payload?.assignment)
      const view = PageBrandingViewSchema.safeParse(payload?.view)
      return assignment.success && view.success && assignment.data.assetId === view.data.assetId
    },
    'branding-cancelled': () => true
  },
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
      actionMenuAssetId: null as number | null,
      renameAssetName: '',
      relocationFolderId: 0,
      relocationMode: 'rename' as 'rename' | 'move',
      relocationReceipt: null as AssetRelocationReceipt | null,
      renameAssetLoading: false,
      deleteAssetLoading: false,
      mediaLoadError: '',
      staleAssetIds: [] as number[],
      brandingView: null as PageBrandingView | null,
      brandingLoading: false,
      brandingLoadError: '',
      brandingRequest: 0,
      brandingAbortController: null as AbortController | null,
      returnFocus: null as HTMLElement | null,
      mediaDialogReturnFocus: null as HTMLElement | null,
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
    isBranding(): boolean {
      return this.purpose === 'page-branding'
    },
    displayedAssets(): Asset[] {
      return this.isBranding ? this.assets.filter(isPageBrandingAsset) : this.assets
    },
    canConfirmSelection(): boolean {
      return this.currentFileId !== null &&
        this.isAssetActionable(this.currentFileId) &&
        !this.brandingLoading &&
        this.brandingView?.assetId === this.currentFileId
    },
    pageTotal () {
      if (!this.displayedAssets) {
        return 0
      }

      return Math.ceil(this.displayedAssets.length / 15)
    },
    headers(): AssetTableHeader[] {
      const headers: AssetTableHeader[] = []
      if (this.$vuetify.display.smAndUp) headers.push({ title: this.$t('editor:assets.headerId'), key: 'id', value: 'id', width: 80 })
      headers.push({ title: this.$t('editor:assets.headerFilename'), key: 'filename', value: 'filename' })
      if (this.$vuetify.display.lgAndUp) headers.push({ title: this.$t('editor:assets.headerType'), key: 'ext', value: 'ext', width: 90 })
      if (this.$vuetify.display.mdAndUp) headers.push({ title: this.$t('editor:assets.headerFileSize'), key: 'fileSize', value: 'fileSize', width: 110 })
      if (this.$vuetify.display.mdAndUp) headers.push({ title: this.$t('editor:assets.headerAdded'), key: 'createdAt', value: 'createdAt', width: 175 })
      if (this.$vuetify.display.smAndUp) {
        headers.push({ title: this.$t('editor:assets.headerActions'), key: 'actions', value: 'actions', width: 80, sortable: false, align: 'end' })
      }
      return headers
    },
    isFolderNameValid() {
      return this.newFolderName.length > 1 && this.newFolderName.length <= 255 && !localeSegmentRegex.test(this.newFolderName) && !disallowedFolderChars.test(this.newFolderName)
    },
    currentAsset () {
      return _.find(this.displayedAssets, ['id', this.currentFileId])
    },
    isRenameValid (): boolean {
      const current = this.currentAsset
      const name = this.renameAssetName.trim()
      const currentFolderId = current?.folderId ?? this.currentFolderId
      return Boolean(current && name && name.length <= 255 && !/[\/\\]/.test(name) && (name !== current.filename || this.relocationFolderId !== currentFolderId))
    },
    relocationFolderItems(): Array<{ title: string; value: number }> {
      const items = [{ title: '/', value: 0 }]
      let path = ''
      for (const folder of this.folderTree) {
        path = path ? `${path}/${folder.name}` : folder.name
        if (folder.id !== this.currentFolderId) items.push({ title: `/${path}`, value: folder.id })
      }
      const currentPath = this.folderTree.map(folder => folder.name).join('/')
      for (const folder of this.folders) {
        if (folder.id === this.currentFolderId) continue
        items.push({ title: currentPath ? `/${currentPath}/${folder.name}` : `/${folder.name}`, value: folder.id })
      }
      return items.filter((item, index, all) => all.findIndex(candidate => candidate.value === item.value) === index)
    },
    relocationSourcePath(): string {
      const folderPath = this.folderTree.map(folder => folder.name).join('/')
      return folderPath ? `${folderPath}/${this.currentAsset?.filename ?? ''}` : this.currentAsset?.filename ?? ''
    },
    relocationDestinationPath(): string {
      const folder = this.relocationFolderItems.find(item => item.value === this.relocationFolderId)
      const folderPath = folder?.title.replace(/^\/|\/$/g, '') ?? ''
      return folderPath ? `${folderPath}/${this.renameAssetName.trim()}` : this.renameAssetName.trim()
    },
    relocationStatusType(): 'info' | 'success' | 'warning' | 'error' {
      switch (this.relocationReceipt?.status) {
        case 'succeeded':
          return 'success'
        case 'failed':
          return 'error'
        case 'superseded':
          return 'warning'
        default:
          return 'info'
      }
    },
    relocationStatusMessage(): string {
      switch (this.relocationReceipt?.status) {
        case 'pending':
          return this.$t('editor:assets.relocationPending')
        case 'leased':
          return this.$t('editor:assets.relocationInProgress')
        case 'failed':
          return this.$t('editor:assets.relocationFailed')
        case 'superseded':
          return this.$t('editor:assets.relocationSuperseded')
        case 'succeeded':
          return this.relocationReceipt?.effects.length === 0
            ? this.$t('editor:assets.relocationSuccessNoTargets')
            : this.$t('editor:assets.relocationSuccess')
        default:
          return this.$t('editor:assets.relocationUnavailable')
      }
    },
    isPrivatePage(): boolean {
      return wikiStore.page.visibility === 'private'
    },
    filePondServerOpts () {
      return {
        process: {
          url: '/u',
          withCredentials: true,
          onload: (response: unknown) => {
            const id = extractUploadAssetId(response)
            return id === null ? '' : String(id)
          }
        }
      }
    }
  },
  watch: {
    purpose(newValue: MediaPickerPurpose, oldValue: MediaPickerPurpose) {
      if (newValue === oldValue) return
      this.invalidateBrandingSelection()
      this.pagination = 1
      if (!this.disposed) void this.loadMedia()
    },
    embedded(newValue: boolean) {
      if (!newValue || !this.focusScope) return
      this.focusScope.deactivate()
      this.focusScope = null
    },
    currentFileId(newValue: number | null) {
      if (this.isBranding && newValue === null) this.invalidateBrandingSelection()
    },
    newFolderDialog(newValue: boolean) {
      if (newValue) {
        this.$nextTick(() => {
          if (!this.disposed && this.newFolderDialog) {
            focusInput(this.$refs.folderNameIpt)
          }
        })
      } else if (!this.newFolderLoading) {
        this.newFolderName = ''
      }
    },
    renameDialog(newValue: boolean) {
      if (!newValue) return
      this.$nextTick(() => {
        if (!this.disposed && this.renameDialog) {
          focusInput(this.$refs.renameAssetIpt)
        }
      })
    },
    deleteDialog(newValue: boolean) {
      if (!newValue) return
      this.$nextTick(() => {
        if (this.disposed || !this.deleteDialog) return
        const button = this.$refs.deleteCancelButton as { $el?: unknown } | undefined
        if (button?.$el instanceof HTMLElement) button.$el.focus()
      })
    },
    currentFolderId () {
      this.actionMenuAssetId = null
      void this.loadMedia()
    }
  },
  mounted() {
    if (!this.embedded) {
      this.returnFocus = document.activeElement as HTMLElement | null
      this.$nextTick(() => {
        if (this.disposed || this.embedded) return
        const root = this.$el instanceof HTMLElement ? this.$el : null
        if (!root) return
        this.focusScope = markRaw(createModalFocusScope({
          root,
          restoreTarget: () => this.returnFocus,
          additionalRoots: this.mediaModalAdditionalRoots,
          onEscape: this.handleMediaEscape
        }))
        const refreshButton = this.$refs.refreshButton as { $el?: unknown } | undefined
        if (refreshButton?.$el instanceof HTMLElement) refreshButton.$el.focus()
      })
    }
    void this.loadMedia()
  },
  beforeUnmount() {
    this.disposed = true
    this.mediaRequest++
    this.mediaAbortController?.abort()
    this.mediaAbortController = null
    this.brandingRequest++
    this.brandingAbortController?.abort()
    this.brandingAbortController = null
    for (const timer of this.fileRemovalTimers) window.clearTimeout(timer)
    this.fileRemovalTimers = []
    this.focusScope?.deactivate()
    this.focusScope = null
  },
  methods: {
    mediaModalAdditionalRoots (): HTMLElement[] {
      return Array.from(document.querySelectorAll<HTMLElement>('.editor-media-owned-overlay'))
    },
    setActionMenu (assetId: number, isOpen: boolean) {
      this.actionMenuAssetId = isOpen && this.isAssetActionable(assetId) ? assetId : null
    },
    invalidateMediaLoad () {
      this.mediaRequest++
      this.mediaAbortController?.abort()
      this.mediaAbortController = null
      this.loading = false
    },
    handleMediaEscape () {
      if (this.actionMenuAssetId !== null) {
        this.actionMenuAssetId = null
        return
      }
      if (this.newFolderDialog) {
        if (!this.newFolderLoading) this.newFolderDialog = false
        return
      }
      if (this.renameDialog) {
        if (!this.renameAssetLoading) this.renameDialog = false
        return
      }
      if (this.deleteDialog) {
        if (!this.deleteAssetLoading) this.deleteDialog = false
        return
      }
      this.cancel()
    },
    rememberMediaDialogFocus (assetId: number) {
      const root = this.$el instanceof HTMLElement ? this.$el : null
      this.mediaDialogReturnFocus = root?.querySelector<HTMLElement>(`[data-editor-media-asset-actions="${assetId}"]`) ?? null
    },
    restoreMediaDialogFocus () {
      const target = this.mediaDialogReturnFocus
      this.mediaDialogReturnFocus = null
      this.$nextTick(() => {
        if (this.disposed || (!this.embedded && this.activeModal !== 'editorModalMedia')) return
        if (target?.isConnected && !target.matches(':disabled')) {
          target.focus({ preventScroll: true })
          return
        }
        const refreshButton = this.$refs.refreshButton as { $el?: unknown } | undefined
        if (refreshButton?.$el instanceof HTMLElement) refreshButton.$el.focus({ preventScroll: true })
      })
    },
    invalidateBrandingSelection () {
      this.brandingRequest++
      this.brandingAbortController?.abort()
      this.brandingAbortController = null
      this.brandingLoading = false
      this.brandingLoadError = ''
      this.brandingView = null
    },
    async loadBrandingDescriptor (id: number): Promise<void> {
      const request = ++this.brandingRequest
      this.brandingAbortController?.abort()
      const abortController = markRaw(new AbortController())
      this.brandingAbortController = abortController
      this.brandingLoading = true
      this.brandingLoadError = ''
      this.brandingView = null
      try {
        const fetchWithSignal = (url: string, init?: RequestInit) => window.fetch(url, {
          ...init,
          signal: abortController.signal
        })
        const view = await fetchAssetBranding(fetchWithSignal, id)
        const result = PageBrandingViewSchema.safeParse(view)
        if (
          this.disposed ||
          request !== this.brandingRequest ||
          this.currentFileId !== id ||
          !result.success ||
          result.data.assetId !== id
        )
          return
        this.brandingView = markRaw(result.data)
      } catch (error) {
        if (
          this.disposed ||
          request !== this.brandingRequest ||
          this.currentFileId !== id ||
          isAbortError(error)
        )
          return
        this.brandingView = null
        this.brandingLoadError = 'This image cannot be used for page branding. Choose a static PNG, JPEG, or WebP image up to 5 MB.'
      } finally {
        if (this.brandingAbortController === abortController) {
          this.brandingAbortController = null
        }
        if (!this.disposed && request === this.brandingRequest) {
          this.brandingLoading = false
        }
      }
    },
    isAssetActionable (id: number | null): boolean {
      return id !== null && !this.staleAssetIds.includes(id)
    },
    assetAriaLabel (asset: Asset): string {
      if (!this.isAssetActionable(asset.id)) return `${asset.filename}, unavailable until assets reload`
      return this.currentFileId === asset.id ? `${asset.filename}, selected` : `Select ${asset.filename}`
    },
    markAssetStale (assetId: number) {
      if (!this.staleAssetIds.includes(assetId)) this.staleAssetIds.push(assetId)
      if (this.actionMenuAssetId === assetId) this.actionMenuAssetId = null
      if (this.currentFileId === assetId) this.currentFileId = null
    },
    confirmSelection () {
      if (!this.isAssetActionable(this.currentFileId)) return
      const assignment = PageBrandingAssignmentSchema.safeParse({ assetId: this.currentFileId })
      const view = PageBrandingViewSchema.safeParse(this.brandingView)
      if (!assignment.success || !view.success || view.data.assetId !== assignment.data.assetId) {
        this.brandingView = null
        this.brandingLoadError = 'Select a supported image before continuing.'
        return
      }
      this.$emit('branding-selected', {
        assignment: assignment.data,
        view: view.data
      })
      if (!this.embedded) this.activeModal = ''
    },
    selectAsset(id: number) {
      if (!this.isAssetActionable(id)) return
      if (this.isBranding && !this.displayedAssets.some(asset => asset.id === id)) return
      this.currentFileId = id
      if (this.isBranding) void this.loadBrandingDescriptor(id)
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
      if (this.isBranding) return
      if (!this.isAssetActionable(this.currentFileId)) return
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
      const processed = await (this.$refs.pond as FilePondRef).processFiles()
      const loaded = await this.loadMedia()
      if (!loaded || this.disposed) return
      const processedFiles = Array.isArray(processed) ? processed : isRecord(processed) ? [processed] : []
      for (const processedFile of processedFiles) {
        const assetId = extractUploadAssetId(isRecord(processedFile) ? processedFile.serverId : undefined)
        if (assetId !== null && this.assets.some(asset => asset.id === assetId)) {
          this.selectAsset(assetId)
          break
        }
      }
    },
    async onFileProcessed (err: unknown, file: FilePondFile) {
      if (err) {
        return wikiStore.showNotification({
          message: this.$t('editor:assets.uploadFailed'),
          style: 'error',
          icon: 'error'
        })
      }
      const assetId = extractUploadAssetId(file.serverId)
      const timer = window.setTimeout(() => {
        this.fileRemovalTimers = this.fileRemovalTimers.filter(value => value !== timer)
        if (!this.disposed) {
          ;(this.$refs.pond as FilePondRef | undefined)?.removeFile(file.id)
        }
      }, 5000)
      this.fileRemovalTimers.push(timer)

      const loaded = await this.loadMedia()
      if (!loaded || this.disposed || assetId === null || !this.assets.some(asset => asset.id === assetId)) return
      this.selectAsset(assetId)
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
    openRelocationDialog(id: number, mode: 'rename' | 'move') {
      if (!this.isAssetActionable(id)) return
      this.rememberMediaDialogFocus(id)
      this.actionMenuAssetId = null
      this.currentFileId = id
      if (!this.currentAsset) throw new Error('No asset selected for relocation.')
      this.relocationMode = mode
      this.renameAssetName = this.currentAsset.filename
      this.relocationFolderId = this.currentAsset.folderId ?? this.currentFolderId
      this.relocationReceipt = null
      this.renameDialog = true
    },
    openRenameDialog(id: number) {
      this.openRelocationDialog(id, 'rename')
    },
    openMoveDialog(id: number) {
      this.openRelocationDialog(id, 'move')
    },
    openDeleteDialog(id: number) {
      if (!this.isAssetActionable(id)) return
      this.rememberMediaDialogFocus(id)
      this.actionMenuAssetId = null
      this.currentFileId = id
      if (!this.currentAsset) throw new Error('No asset selected for deletion.')
      this.deleteDialog = true
    },
    relocationEffectMessage(status: string): string {
      switch (status) {
        case 'pending':
          return this.$t('editor:assets.relocationEffectPending')
        case 'leased':
          return this.$t('editor:assets.relocationEffectInProgress')
        case 'succeeded':
          return this.$t('editor:assets.relocationEffectSucceeded')
        case 'failed':
          return this.$t('editor:assets.relocationEffectFailed')
        case 'superseded':
          return this.$t('editor:assets.relocationEffectSuperseded')
        default:
          return this.$t('editor:assets.relocationEffectUnknown')
      }
    },
    async waitForRelocation(receipt: AssetRelocationReceipt): Promise<AssetRelocationReceipt> {
      let current = receipt
      for (let attempt = 0; attempt < 30 && !['succeeded', 'failed', 'superseded'].includes(current.status); attempt += 1) {
        await new Promise<void>(resolve => window.setTimeout(resolve, 500))
        if (this.disposed) return current
        const next = await fetchAssetRelocationStatus(window.fetch.bind(window), current.statusUrl)
        if (next.id !== receipt.id || next.assetId !== receipt.assetId) throw new Error('Asset relocation status did not match the requested receipt.')
        current = next
      }
      return current
    },
    async refreshAfterRelocation (assetId: number): Promise<boolean> {
      this.markAssetStale(assetId)
      const loaded = await this.loadMedia()
      if (loaded) this.staleAssetIds = this.staleAssetIds.filter(id => id !== assetId)
      return loaded
    },
    async relocateAsset() {
      if (
        this.renameAssetLoading ||
        !this.isRenameValid ||
        this.currentFileId === null ||
        !this.isAssetActionable(this.currentFileId)
      )
        return
      const assetId = this.currentFileId
      const assetName = this.renameAssetName.trim()
      const folderId = this.relocationFolderId
      const currentFolderId = this.currentAsset?.folderId ?? this.currentFolderId
      const input: AssetRelocationInput = { filename: assetName }
      if (folderId !== currentFolderId) input.folderId = folderId
      wikiStore.startLoading('editor-media-relocateasset')
      this.renameAssetLoading = true
      try {
        const receipt = await relocateAssetRequest(window.fetch.bind(window), assetId, input)
        this.relocationReceipt = receipt
        this.invalidateMediaLoad()
        this.markAssetStale(assetId)
        if (this.disposed) return
        wikiStore.showNotification({
          message: this.$t('editor:assets.relocationSubmitted'),
          style: 'info',
          icon: 'clock-outline'
        })
        const finalReceipt = await this.waitForRelocation(receipt)
        if (this.disposed) return
        this.relocationReceipt = finalReceipt
        const isTerminal = ['succeeded', 'failed', 'superseded'].includes(finalReceipt.status)
        const refreshed = isTerminal ? await this.refreshAfterRelocation(assetId) : false
        if (this.disposed) return
        if (finalReceipt.status === 'failed') {
          wikiStore.showNotification({
            message: this.relocationStatusMessage,
            style: 'error',
            icon: 'alert'
          })
          return
        }
        if (finalReceipt.status === 'superseded') {
          wikiStore.showNotification({
            message: this.relocationStatusMessage,
            style: 'warning',
            icon: 'alert'
          })
          return
        }
        if (finalReceipt.status !== 'succeeded') {
          wikiStore.showNotification({
            message: this.$t('editor:assets.relocationPendingRetry'),
            style: 'warning',
            icon: 'clock-outline'
          })
          return
        }
        if (!refreshed) return
        wikiStore.showNotification({
          message: this.relocationStatusMessage,
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        if (!this.disposed) wikiStore.showError(err)
      } finally {
        if (!this.disposed) this.renameAssetLoading = false
        wikiStore.stopLoading('editor-media-relocateasset')
      }
    },
    async deleteAsset() {
      if (this.deleteAssetLoading || this.currentFileId === null || !this.isAssetActionable(this.currentFileId)) return
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
      const abortController = markRaw(new AbortController())
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
        const assetsPromise = this.isBranding
          ? fetchAssets(fetchWithSignal, folderId, 'IMAGE')
          : fetchAssets(fetchWithSignal, folderId)
        const [folders, assets] = await Promise.all([
          fetchAssetFolders(fetchWithSignal, folderId),
          assetsPromise
        ])
        if (this.disposed || request !== this.mediaRequest || folderId !== this.currentFolderId) return false
        const visibleAssets = this.isBranding ? assets.filter(isPageBrandingAsset) : assets
        this.folders = markRaw(folders)
        this.assets = markRaw(visibleAssets)
        this.staleAssetIds = []
        if (this.currentFileId !== null && !visibleAssets.some(asset => asset.id === this.currentFileId)) {
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
      if (this.isBranding) {
        this.invalidateBrandingSelection()
        if (this.currentFileId !== null) this.currentFileId = null
        this.$emit('branding-cancelled')
        if (!this.embedded) this.activeModal = ''
        return
      }
      this.activeModal = ''
    }
  }
})
</script>

<style lang='scss'>
.editor-modal-media {
  --editor-media-bottom-clearance: calc(var(--v-layout-bottom, 0px) + 24px + env(safe-area-inset-bottom));
  background: rgb(var(--v-theme-background)) !important;
  color: rgb(var(--v-theme-on-background));
  padding-bottom: env(safe-area-inset-bottom);
  height: calc(100dvh - 112px - var(--editor-media-bottom-clearance));
  left: 64px;
  overflow: auto;
  position: fixed !important;
  top: 112px;
  width: calc(100vw - 64px);
  z-index: 10;

  @include until($tablet) {
    left: 0;
    width: 100vw;
  }

  &.is-editor-visual-markdown {
    height: calc(100dvh - 64px - var(--editor-media-bottom-clearance));
    left: 0;
    top: 64px;
    width: 100vw;

    @include until($tablet) {
      height: calc(100dvh - 56px - var(--editor-media-bottom-clearance));
      top: 56px;
    }
  }
  &.is-editor-ckeditor {
    top: 64px;
    left: 0;
    width: 100%;
    height: calc(100dvh - 64px - var(--editor-media-bottom-clearance) - 2px);

    @include until($tablet) {
      top: 56px;
      left: 0;
      width: 100%;
      height: calc(100dvh - 56px - var(--editor-media-bottom-clearance));
    }
  }

  &.is-editor-code {
    top: 64px;
    height: calc(100dvh - 64px - var(--editor-media-bottom-clearance));

    @include until($tablet) {
      top: 56px;
      height: calc(100dvh - 56px - var(--editor-media-bottom-clearance));
    }
  }

  &.is-editor-common {
    top: 64px;
    left: 0;
    width: 100%;
    height: calc(100dvh - 64px - var(--editor-media-bottom-clearance));

    @include until($tablet) {
      top: 56px;
      left: 0;
      width: 100%;
      height: calc(100dvh - 56px - var(--editor-media-bottom-clearance));
    }
  }

  .editor-media-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--wiki-space-4);
    align-items: start;
    padding: clamp(.75rem, 1.4vw, 1.5rem);
  }

  @media (min-width: 1100px) {
    .editor-media-layout {
      grid-template-columns: minmax(0, 1fr) clamp(18rem, 28vw, 22rem);
    }
  }

  .editor-media-browser,
  .editor-media-sidebar,
  .editor-media-panel,
  .editor-media-panel-content {
    min-width: 0;
  }

  .editor-media-sidebar {
    display: grid;
    gap: var(--wiki-space-4);
  }

  .editor-media-panel-content {
    padding: clamp(.75rem, 1.4vw, 1.25rem);
  }

  .editor-media-header,
  .editor-media-footer,
  .editor-media-actions,
  .editor-media-upload-footer {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wiki-space-2);
    align-items: center;
  }

  .editor-media-header {
    padding-bottom: var(--wiki-space-3);
    border-bottom: 1px solid rgba(var(--v-theme-on-surface), .12);
  }

  .editor-media-heading {
    display: flex;
    flex: 1 1 8rem;
    gap: var(--wiki-space-2);
    align-items: center;
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
    font-size: 1rem;
    font-weight: 650;
    line-height: 1.4;

    .v-icon {
      flex: none;
      color: rgb(var(--v-theme-primary));
    }
  }

  .editor-media-path {
    padding-block: var(--wiki-space-4);
    overflow-wrap: anywhere;
    color: rgba(var(--v-theme-on-surface), .7);
  }

  .editor-media-folders {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wiki-space-2);
    padding-bottom: var(--wiki-space-4);
  }

  .editor-media-layout .v-btn {
    flex-shrink: 0;
    min-height: 44px;
    max-width: 100%;
  }

  .editor-media-folder {
    height: auto;
    min-width: 0;
    padding-block: var(--wiki-space-2);
    text-align: start;
    text-transform: none;

    .v-btn__content {
      min-width: 0;
      white-space: normal;
      overflow-wrap: anywhere;
    }
  }

  .editor-media-table {
    max-width: 100%;

    .v-table__wrapper {
      overflow-x: auto;
    }

    td {
      padding-block: var(--wiki-space-2);
    }
  }

  .editor-media-filename {
    min-width: 8rem;
    max-width: 24rem;
    overflow-wrap: anywhere;
  }

  .editor-media-footer {
    margin-top: var(--wiki-space-3);
    padding-top: var(--wiki-space-4);
    border-top: 1px solid rgba(var(--v-theme-on-surface), .12);
  }

  .editor-media-count {
    flex: 1 1 8rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .editor-media-actions {
    margin-inline-start: auto;
  }

  .editor-media-upload-footer {
    justify-content: space-between;
    padding: var(--wiki-space-3) clamp(.75rem, 1.4vw, 1.25rem);
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
  tr.is-stale {
    cursor: not-allowed;
    opacity: .62;
  }

  @media (prefers-reduced-motion: reduce) {
    &,
    * {
      animation: none !important;
      transition: none !important;
    }
  }

  .filepond--root {
    min-width: 0;
    margin-bottom: 0;
  }

  .filepond--credits {
    color: rgb(var(--v-theme-on-surface));
    opacity: 1;
  }

  .filepond--panel-root {
    background: color-mix(in srgb, rgb(var(--v-theme-surface-variant)) 35%, rgb(var(--v-theme-surface)));
  }

  .filepond--drop-label {
    color: rgb(var(--v-theme-on-surface));
    min-height: 8rem;
    cursor: pointer;

    > label {
      max-width: 100%;
      padding: var(--wiki-space-4);
      overflow-wrap: anywhere;
      line-height: 1.6;
      cursor: pointer;
    }
  }

  .filepond--file-action-button.filepond--action-process-item {
    display: none;
  }

  .editor-media-icon-button {
    width: 44px;
    min-width: 44px;
    height: 44px;
    padding: 0;
  }
  &.is-editor-embedded {
    position: static !important;
    inset: auto;
    width: auto !important;
    height: auto !important;
    min-height: 0;
    overflow: visible;
    z-index: auto;
    background: transparent !important;
    padding-bottom: 0;
  }
  &.is-editor-embedded.is-page-branding {
    display: flex;
    min-height: 0;
    height: 100% !important;
    max-height: 100%;
    overflow: hidden;

    .editor-media-layout {
      min-height: 0;
      height: 100%;
      flex: 1 1 auto;
      align-items: stretch;
      overflow-y: auto;
    }

    .editor-media-browser {
      display: flex;
      min-height: 0;
      height: 100%;
      max-height: 100%;
      flex-direction: column;
    }

    .editor-media-browser > .editor-media-panel {
      display: flex;
      min-height: 0;
      flex: 1 1 auto;
      flex-direction: column;
    }

    .editor-media-browser > .editor-media-panel > .editor-media-panel-content {
      display: flex;
      min-height: 0;
      flex: 1 1 auto;
      flex-direction: column;
      overflow: hidden;
    }

    .editor-media-browser > .editor-media-panel > .editor-media-panel-content > :not(.editor-media-table) {
      flex: 0 0 auto;
    }

    .editor-media-browser .editor-media-table {
      display: flex;
      min-height: 0;
      flex: 1 1 auto;
      flex-direction: column;
      overflow: hidden;

      .v-table__wrapper {
        min-height: 0;
        flex: 1 1 auto;
        overflow-x: auto;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
      }
    }

    .editor-media-sidebar {
      min-height: 0;
      overflow-y: auto;
    }
  }

}
</style>
