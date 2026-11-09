<template lang='pug'>
component(:is='embedded ? `div` : mediaDialogComponent', :style='embedded && isBranding ? { height: `100%`, minHeight: `0`, display: `flex`, flexDirection: `column` } : undefined', v-bind='embedded ? {} : { modelValue: true, maxWidth: 1600, maxHeight: `calc(100dvh - 32px)`, "aria-labelledby": `editor-media-title`, activator: returnFocus }', @update:model-value='!$event && handleMediaEscape()')
  v-card.editor-modal-media(ref='mediaContent', flat, rounded='xl', :class='{ "is-editor-embedded": embedded, "is-page-branding": isBranding }', aria-labelledby='editor-media-title', tabindex='-1')
    .editor-media-layout
      section.editor-media-browser(aria-labelledby='editor-media-title')
        v-card.editor-media-panel.radius-7
          v-card-text.editor-media-panel-content
            header.editor-media-header
              h2.editor-media-heading#editor-media-title {{ $t('editor:assets.title') }}
              v-btn.editor-media-icon-button(ref='refreshButton', variant="text", icon, :aria-label='$t(`editor:editorModalMedia.refreshAssets`)', @click='refresh')
                v-icon mdi-refresh
              v-dialog(
                v-model='newFolderDialog'
                max-width='550'
                :persistent='newFolderLoading'
                content-class='editor-media-owned-overlay'
                aria-labelledby='editor-media-new-folder-title'
              )
                template(v-slot:activator='{ props }')
                  v-btn.editor-media-new-folder.radius-7(variant="tonal", color='primary', :icon='$vuetify.display.xs', :class='{ "editor-media-icon-button": $vuetify.display.xs }', :aria-label='$t(`editor:editorModalMedia.createFolder`)', v-bind='props')
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
                  v-card-chin
                    v-spacer
                    v-btn(variant="text", :disabled='newFolderLoading', @click='newFolderDialog = false') {{$t('common:actions.cancel')}}
                    v-btn.px-3(color='primary', @click='createFolder', :disabled='newFolderLoading || !isFolderNameValid', :loading='newFolderLoading') {{$t('common:actions.create')}}
            .editor-media-path(:aria-label='$t(`editor:editorModalMedia.currentFolder`)')
              template(v-if='folderTree.length > 0')
                .text-body-medium
                  span.mr-1 /
                  template(v-for='folder of folderTree', :key='folder.id')
                    span {{folder.name}}
                    span.mx-1 /
              .text-body-medium(v-else) / #[em {{ $t(`editor:editorModalMedia.root`) }}]
            .editor-media-folders(v-if='folders.length > 0 || currentFolderId > 0')
              v-btn.editor-media-icon-button(variant="outlined", icon, :aria-label='$t(`editor:editorModalMedia.openParentFolder`)', @click='upFolder()', :disabled='currentFolderId === 0')
                v-icon mdi-folder-upload
              v-btn.editor-media-folder(v-for='folder of displayedFolders', :key='folder.id', variant="tonal", color="primary", :class='{ "editor-media-drop-target": dragFolderId === folder.id }', @click='downFolder(folder)', @dragover='overAssetFolder($event, folder.id)', @dragleave='dragFolderId = null', @drop='dropAssetOnFolder($event, folder.id)')
                v-icon(start) mdi-folder
                span.text-body-small {{ folder.name }}
            v-alert.editor-media-branding-notice.mb-3(v-if='isBranding', type='info', variant='tonal', density='compact')
              .text-body-small {{ $t(`editor:editorModalMedia.pageBrandingAcceptsStatic`) }}
            .text-body-small(role='status', aria-live='polite') {{ dragStatus }}
            v-alert.mb-3(v-if='mediaLoadError', type='error', variant='tonal', role='alert')
              .d-flex.align-center
                span {{mediaLoadError}}
                v-spacer
                v-btn(variant='text', size='small', @click='refresh') {{ $t(`editor:editorModalMedia.retry`) }}
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
                  :key='`${props.item.id}:${assetUrl(props.item)}`'
                  :class='{ "is-stale": !isAssetActionable(props.item.id) }'
                  :tabindex='isAssetActionable(props.item.id) ? 0 : -1'
                  :aria-current='currentFileId === props.item.id ? `true` : undefined'
                  :aria-disabled='!isAssetActionable(props.item.id)'
                  :aria-label='assetAriaLabel(props.item)'
                  :draggable='canDragAsset(props.item.id)'
                  :data-editor-media-row='props.item.id'
                  @dragstart='startAssetDrag($event, props.item.id)'
                  @dragend='clearAssetDrag'
                  @keydown.enter.space.prevent='isAssetActionable(props.item.id) && selectAsset(props.item.id)'
                  @click.left='isAssetActionable(props.item.id) && selectAsset(props.item.id)'
                )
                  td.editor-media-thumb-cell
                    .editor-media-thumb(aria-hidden='true')
                      img(
                        v-if='props.item.kind === `IMAGE` && failedThumbnailUrls[props.item.id] !== assetUrl(props.item)'
                        :src='assetUrl(props.item)'
                        alt=''
                        width='40'
                        height='40'
                        loading='lazy'
                        decoding='async'
                        @error='markThumbnailFailed(props.item, $event)'
                      )
                      v-icon(v-else, size='22') {{ assetIcon(props.item) }}
                  td.editor-media-filename
                    .text-body-medium: strong(:class='currentFileId === props.item.id ? `text-primary` : ``') {{ props.item.filename }}
                    .text-body-small.text-medium-emphasis {{ props.item.description }}
                  td.text-center(v-if='$vuetify.display.lgAndUp')
                    v-chip.ma-0(size="x-small", variant="tonal")
                      .text-label-small {{props.item.ext.toUpperCase().substring(1)}}
                  td.text-body-small(v-if='$vuetify.display.mdAndUp') {{ prettyBytes(props.item.fileSize) }}
                  td.text-body-small(v-if='$vuetify.display.mdAndUp') {{ $helpers.formatMoment(props.item.createdAt, 'from') }}
                  td.editor-media-actions-cell
                    v-menu(
                      :disabled='!isAssetActionable(props.item.id)'
                      :model-value='actionMenuAssetId === props.item.id'
                      min-width='200'
                      content-class='editor-media-owned-overlay'
                      @update:model-value='setActionMenu(props.item.id, $event)'
                    )
                      template(v-slot:activator='{ props: menuProps }')
                        v-btn.editor-media-icon-button(icon, v-bind='menuProps', rounded='lg', size="small", :disabled='!isAssetActionable(props.item.id)', :aria-label='$t(`editor:editorModalMedia.assetActions`, { filename: props.item.filename, interpolation: { escapeValue: false } })', :data-editor-media-asset-actions='props.item.id')
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
                        //-         v-icon(color='purple') mdi-lightning-bolt-circle
                        //-     v-list-item-title {{$t('common:actions.optimize')}}
                        v-list-item(
                          v-if='!isBranding && isResizableAsset(props.item)'
                          :disabled='!isAssetActionable(props.item.id)'
                          prepend-icon='mdi-image-size-select-large'
                          @click='openResizeDialog(props.item.id)'
                        )
                          v-list-item-title {{ $t(`editor:editorModalMedia.saveResizedCopy`) }}
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
              .text-body-small {{ $t(`editor:editorModalMedia.validatingSelectedImage`) }}
            v-alert.mt-3(v-else-if='isBranding && brandingLoadError', type='warning', variant='tonal', density='compact', role='alert')
              .text-body-small {{brandingLoadError}}
            .text-center.py-2(v-if='pageTotal > 1')
              v-pagination(v-model='pagination', :length='pageTotal', color='primary')
            footer.editor-media-footer
              .editor-media-count.text-body-medium.text-medium-emphasis {{$t('editor:assets.fileCount', { count: displayedAssets.length })}}
              .editor-media-actions(v-if='!isManaging')
                v-btn.radius-7(variant="text", @click='cancel')
                  v-icon(start) mdi-close
                  span {{$t('common:actions.cancel')}}
                v-btn.radius-7(v-if='!isBranding', color='primary', @click='insert', :disabled='!currentFileId || !isAssetActionable(currentFileId) || (currentAsset?.kind === `IMAGE` && !imagePropertiesValid)')
                  v-icon(start) mdi-playlist-plus
                  span {{$t('common:actions.insert')}}
                v-btn.radius-7(v-else, color='primary', @click='confirmSelection', :disabled='!canConfirmSelection', :loading='brandingLoading')
                  v-icon(start) mdi-image-check-outline
                  span {{ $t(`editor:editorModalMedia.useImage`) }}

      aside.editor-media-sidebar
        v-card.editor-media-panel.radius-7
          v-alert.mb-0(v-if='isPrivatePage', type='info', variant="outlined", density="compact") {{ $t(`editor:editorModalMedia.assetsSiteWideCannot`) }}
          v-card-text.editor-media-panel-content(v-if='!isPrivatePage')
            header.editor-media-header.editor-media-upload-header
              h2.editor-media-heading
                v-icon(aria-hidden='true') mdi-cloud-upload-outline
                span {{$t('editor:assets.uploadAssets')}}
            //- A completed /u response releases the canonical asset namespace fence before the next file.
            file-pond.mt-3(
              name='mediaUpload'
              ref='pond'
              :label-idle='$t(`editor:assets.uploadAssetsDropZone`)'
              :credits='false'
              allow-multiple
              :files='files'
              :max-files='10'
              :max-parallel-uploads='1'
              :server='filePondServerOpts'
              :instant-upload='false'
              :allow-revert='false'
              @processfile='onFileProcessed'
              @updatefiles='syncQueuedFiles'
            )
          v-divider(v-if='!isPrivatePage')
          .editor-media-upload-footer(v-if='!isPrivatePage')
            .text-body-small.text-medium-emphasis(:id='`editor-media-upload-hint`')
              div {{ $t('editor:assets.uploadLimits') }}
              div(v-if='queuedFileCount > 0') {{ $t('editor:assets.uploadReady', { count: queuedFileCount }) }}
            //- Staged upload: the primary button states how many dropped files are waiting.
            v-btn.editor-media-upload-action(
              color='primary'
              :variant='queuedFileCount > 0 ? `flat` : `tonal`'
              :data-commitment='queuedFileCount > 0 && !uploading ? `active` : undefined'
              :loading='uploading'
              :disabled='queuedFileCount === 0 || uploading'
              aria-describedby='editor-media-upload-hint'
              @click='upload'
            ) {{ queuedFileCount > 0 ? $t('editor:assets.uploadCount', { count: queuedFileCount }) : $t('common:actions.upload') }}


        v-card.editor-media-panel.radius-7(v-if='!isBranding && !isManaging && currentAsset && currentAsset.kind === `IMAGE`')
          v-card-text.editor-media-panel-content.pb-0
            h2.editor-media-heading
              v-icon(aria-hidden='true') mdi-format-align-top
              span {{$t('editor:assets.imageAlign')}}
            v-select.mt-3(
              v-model='imageAlignment'
              :items='imageAlignments'
              :menu-props='{ contentClass: `editor-media-owned-overlay` }'
              variant="outlined"
              single-line
              color='primary'
              label='Image alignment'
              :placeholder='$t(`editor:editorModalMedia.none`)'
            )
            v-textarea.mt-3(v-model='imageAlt', label='Alternative text', hint='Describe the image, or leave empty for a decorative image.', persistent-hint, counter='2000', maxlength='2000', rows='2', auto-grow, :error-messages='imageAltValid ? [] : [`Use at most 2000 characters without control characters.`]')
            v-text-field.mt-3(v-model='imageWidth', label='Display width', hint='Empty, auto, pixels up to 16384, or up to 100%. This does not resize the asset.', persistent-hint, :error-messages='imageWidthValid ? [] : [`Enter a supported width.`]')
            v-text-field.mt-3(v-model='imageHeight', label='Display height', hint='Empty, auto, pixels up to 16384, or up to 100%.', persistent-hint, :error-messages='imageHeightValid ? [] : [`Enter a supported height.`]')
            fieldset.mt-3.pa-3.rounded
              legend.px-2 Framing
              v-checkbox(:model-value='imageStyles', @update:model-value='imageStyles = $event ?? []', value='border', label='Border', hide-details, density='compact')
              v-checkbox(:model-value='imageStyles', @update:model-value='imageStyles = $event ?? []', value='rounded', label='Rounded corners', hide-details, density='compact')
              v-checkbox(:model-value='imageStyles', @update:model-value='imageStyles = $event ?? []', value='shadow', label='Shadow', hide-details, density='compact')
            v-alert.mt-3(v-if='imageInsertError', type='error', variant='tonal', role='alert') {{ imageInsertError }}
            v-btn.mt-2(
              v-if='isResizableAsset(currentAsset)'
              block
              variant='tonal'
              color='primary'
              prepend-icon='mdi-image-size-select-large'
              @click='openResizeDialog(currentAsset?.id ?? 0)'
            ) {{ $t(`editor:editorModalMedia.saveResizedCopy`) }}

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
    //- IMAGE SAVE-AS RESIZE DIALOG
    v-dialog(
      v-model='resizeDialog'
      max-width='850'
      :persistent='resizeLoading'
      content-class='editor-media-owned-overlay'
      aria-labelledby='editor-media-resize-title'
      @after-leave='restoreMediaDialogFocus'
    )
      v-card(:aria-busy='resizeLoading')
        .dialog-header.is-short.is-orange
          v-icon.mr-2(color='primary', aria-hidden='true') mdi-image-size-select-large
          span#editor-media-resize-title {{ $t(`editor:editorModalMedia.resizeImageSaveNew`) }}
        v-card-text.pt-5
          .text-body-medium {{ $t(`editor:editorModalMedia.createNewAssetOriginal`, { resizeSourceName, interpolation: { escapeValue: false } }) }}
          v-alert.mt-3(type='warning', variant='tonal', density='compact')
            | Save-as leaves the original, existing links, copies and prior versions accessible. Opaque fill only replaces pixels in this new copy; it is not global secret deletion.
          .d-flex.flex-wrap.ga-2.mt-3
            v-btn(variant='tonal', :disabled='resizeLoading || editOperations.length === 0', @click='undoImageEdit') Undo
            v-btn(variant='tonal', :disabled='resizeLoading || editRedo.length === 0', @click='redoImageEdit') Redo
            v-btn(variant='tonal', :disabled='resizeLoading || !isResizeValid || previewLoading', :loading='previewLoading', @click='loadEditPreview') Update preview
          .text-body-small.mt-2(role='status', aria-live='polite') {{ editOperations.length }} / 16 ordered edits. {{ editPreview ? `Current image: ${editPreview.editWidth} × ${editPreview.editHeight} pixels; output ${editPreview.width} × ${editPreview.height}.` : 'Update preview before editing or saving.' }}
          .editor-media-edit-surface.mt-3(v-if='editPreview', @pointerdown='startEditRegion', @pointermove='moveEditRegion', @pointerup='finishEditRegion', @pointercancel='cancelEditRegion', @lostpointercapture='cancelEditRegion')
            img(:src='editPreviewUrl', alt='Server-rendered image copy preview', draggable='false')
            .editor-media-edit-region(v-if='editRegionStyle', :style='editRegionStyle', aria-hidden='true')
          fieldset.mt-3.pa-3(:disabled='resizeLoading || previewLoading || !editPreview')
            legend.px-2 Ordered image edits (before final resize)
            .text-body-small Coordinates use the EXIF-oriented image after preceding edits. Drag on the preview with mouse or touch, or enter pixel values below.
            v-select.mt-2(v-model='editRegionKind', :items='[{ title: "Crop region", value: "crop" }, { title: "Opaque fill region", value: "fill" }]', label='Region operation', variant='outlined')
            .editor-media-resize-dimensions
              v-text-field(v-model.number='editLeft', label='Left (pixels)', type='number', min='0', step='1', variant='outlined')
              v-text-field(v-model.number='editTop', label='Top (pixels)', type='number', min='0', step='1', variant='outlined')
              v-text-field(v-model.number='editWidth', label='Width (pixels)', type='number', min='1', step='1', variant='outlined')
              v-text-field(v-model.number='editHeight', label='Height (pixels)', type='number', min='1', step='1', variant='outlined')
            v-text-field(v-if='editRegionKind === "fill"', v-model='editColor', label='Opaque RGB fill (#RRGGBB)', variant='outlined')
            .d-flex.flex-wrap.ga-2
              v-btn(variant='tonal', :disabled='!editRegionValid || editOperations.length >= 16', @click='applyImageRegion') Apply region
              v-btn(variant='tonal', :disabled='editOperations.length >= 16', @click='appendImageEdit({ type: "rotate", turns: 1 })') Rotate 90°
              v-btn(variant='tonal', :disabled='editOperations.length >= 16', @click='appendImageEdit({ type: "mirror", axis: "horizontal" })') Mirror horizontally
              v-btn(variant='tonal', :disabled='editOperations.length >= 16', @click='appendImageEdit({ type: "mirror", axis: "vertical" })') Mirror vertically
          ol.text-body-small.mt-2(v-if='editOperations.length')
            li(v-for='(operation, index) in editOperations', :key='index') {{ describeImageEdit(operation) }}
          v-checkbox(v-if='editOperations.length > 0', :model-value='editFirstFrameConfirmed', @update:model-value='confirmEditFirstFrame($event)', label='I explicitly allow first-frame conversion if this source is animated.', density='compact', :disabled='resizeLoading')
          .text-body-small.mt-2(v-if='editOperations.some(operation => operation.type === "fill")') Opaque fill uses lossless PNG or WebP (quality setting does not apply). JPEG/GIF are refused; final resizing uses nearest-neighbor pixels to keep replacement coverage opaque.
          v-text-field.mt-4(
            v-model='resizeDestinationName'
            :label='$t(`editor:editorModalMedia.newAssetFilename`)'
            variant='outlined'
            maxlength='255'
            :disabled='resizeLoading'
          )
          v-select(
            v-model='resizeDestinationFolderId'
            :items='resizeFolderItems'
            item-title='title'
            item-value='value'
            :label='$t(`editor:editorModalMedia.destinationFolder`)'
            variant='outlined'
            :disabled='resizeLoading'
          )
          .editor-media-resize-dimensions
            v-text-field(
              v-model.number='resizeWidth'
              :label='$t(`editor:editorModalMedia.maximumWidthPixels`)'
              type='number'
              min='1'
              max='8192'
              step='1'
              variant='outlined'
              :disabled='resizeLoading'
            )
            v-text-field(
              v-model.number='resizeHeight'
              :label='$t(`editor:editorModalMedia.maximumHeightPixels`)'
              type='number'
              min='1'
              max='8192'
              step='1'
              variant='outlined'
              :disabled='resizeLoading'
            )
          v-checkbox(
            :model-value='resizeDistortionUnlocked'
            @update:model-value='resizeDistortionUnlocked = $event ?? resizeDistortionUnlocked'
            :label='$t(`editor:editorModalMedia.unlockAspectRatioStretch`)'
            color='primary'
            density='compact'
            hide-details
            :disabled='resizeLoading'
          )
          v-select(
            v-model='resizeFormat'
            :items='resizeFormats'
            item-title='title'
            item-value='value'
            :label='$t(`editor:editorModalMedia.outputFormat`)'
            variant='outlined'
            :disabled='resizeLoading'
            @update:model-value='onResizeFormatChanged'
          )
          .text-body-small.text-medium-emphasis.mb-1 {{ $t(`editor:editorModalMedia.quality100`, { resizeQuality, interpolation: { escapeValue: false } }) }}
          v-slider(
            v-model='resizeQuality'
            min='1'
            max='100'
            step='1'
            color='primary'
            thumb-label
            :disabled='resizeLoading'
          )
          v-select(
            v-model='resizeAnimationPolicy'
            :items='resizeAnimationPolicies'
            item-title='title'
            item-value='value'
            :label='$t(`editor:editorModalMedia.animationPolicy`)'
            variant='outlined'
            :disabled='resizeLoading'
          )
          v-alert.mt-2(type='info', variant='tonal', density='compact')
            .text-body-small {{resizePreview}}
            .text-body-small {{ $t(`editor:editorModalMedia.animatedInputPreservedOnly`) }}
          v-alert.mt-2(type='warning', variant='tonal', density='compact')
            .text-body-small {{ $t(`editor:editorModalMedia.operationCreatesNewAsset`) }}
          v-alert.mt-2(
            v-if='resizeReceipt'
            type='success'
            variant='tonal'
            density='compact'
            role='status'
            aria-live='polite'
          )
            .text-body-small {{ $t(`editor:editorModalMedia.newAssetId`, { assetId: resizeReceipt.assetId, destinationPath: resizeReceipt.destinationPath, interpolation: { escapeValue: false } }) }}
            .text-caption {{ $t(`editor:editorModalMedia.px2`, { width: resizeReceipt.width, height: resizeReceipt.height, format: resizeReceipt.format.toUpperCase(), fileSize: prettyBytes(resizeReceipt.fileSize), interpolation: { escapeValue: false } }) }}
          v-alert.mt-2(v-if='resizeError', type='error', variant='tonal', density='compact', role='alert')
            .text-body-small {{resizeError}}
        v-card-chin
          v-spacer
          v-btn(variant='text', @click='resizeDialog = false', :disabled='resizeLoading') {{$t('common:actions.cancel')}}
          v-btn.px-3(
            color='primary'
            @click='resizeSelectedAsset'
            :loading='resizeLoading'
            :disabled='resizeLoading || !canSaveEdit || Boolean(resizeReceipt)'
          ) {{ $t(`editor:editorModalMedia.saveCopy`) }}
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
import { VDialog } from 'vuetify/components'
import * as _ from 'lodash-es'
import { createAssetFolder, deleteAsset as deleteAssetRequest, fetchAssetBranding, fetchAssetFolders, fetchAssetRelocationStatus, fetchAssets, relocateAsset as relocateAssetRequest, type Asset, type AssetFolder, type AssetRelocationInput, type AssetRelocationReceipt } from '../../helpers/assets-api'
import { sameOriginJsonFetch } from '../../helpers/json-transport.ts'
import { wikiStore } from '@/store/index.ts'
import vueFilePond from 'vue-filepond'
import 'filepond/dist/filepond.min.css'
import { isRecord } from '../../helpers/type-guards'
import { PageBrandingAssignmentSchema, PageBrandingViewSchema, type PageBrandingAssignment, type PageBrandingView } from '../../../shared/page-branding.ts'
import { emitEditorInsert } from '../../helpers/editor-insert-events'
import { isSafeEditorImageSource, isValidEditorImageAlt, normalizeEditorImageDimension, type EditorImageAlignment, type EditorImageStyle } from '../../helpers/editor-image-properties'

const imageInsertionOwner = (): string => JSON.stringify([
  wikiStore.user.authenticated, wikiStore.user.id, wikiStore.offlineIdentityEpoch,
  wikiStore.page.id, wikiStore.page.locale, wikiStore.page.path, wikiStore.editor.editorKey
])

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
type ResizeImageFormat = 'png' | 'jpeg' | 'webp' | 'gif'
type ResizeAnimationPolicy = 'preserve' | 'first-frame'
type ResizeImageRequest = {
  destination: { filename: string; folderId: number }
  width: number
  height: number
  aspectPolicy: 'preserve' | 'stretch'
  format: ResizeImageFormat
  quality: number
  animationPolicy: ResizeAnimationPolicy
  operations?: ImageEditOperation[]
  expectedSourceSha256?: string
  expectedSourceRevision?: string
}
type ImageEditOperation =
  | { type: 'crop'; left: number; top: number; width: number; height: number }
  | { type: 'fill'; left: number; top: number; width: number; height: number; color: string }
  | { type: 'rotate'; turns: 1 | 2 | 3 }
  | { type: 'mirror'; axis: 'horizontal' | 'vertical' }
type ImageEditPreview = { status: 'previewed'; dataUrl: string; sourceSha256: string; sourceRevision: string; width: number; height: number; editWidth: number; editHeight: number; frames: number; format: ResizeImageFormat }
type ResizeImageReceipt = {
  status: 'succeeded'
  assetId: number
  destinationPath: string
  width: number
  height: number
  format: ResizeImageFormat
  frames: number
  fileSize: number
  sourceSha256: string
}

const RESIZE_FORMATS: Readonly<Record<ResizeImageFormat, string>> = {
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WebP',
  gif: 'GIF'
}
const RESIZE_EXTENSIONS: Readonly<Record<ResizeImageFormat, string>> = {
  png: '.png',
  jpeg: '.jpg',
  webp: '.webp',
  gif: '.gif'
}
const RESIZE_FORMAT_ITEMS = markRaw(Object.entries(RESIZE_FORMATS).map(([value, title]) => ({ value, title })))
const RESIZE_ANIMATION_POLICIES = markRaw([
  { title: 'Preserve animation', value: 'preserve' },
  { title: 'First frame only (explicit conversion)', value: 'first-frame' }
])
const RESIZABLE_IMAGE_EXTENSIONS: Readonly<Record<string, true>> = {
  '.png': true,
  '.jpg': true,
  '.jpeg': true,
  '.webp': true,
  '.gif': true
}
async function requestImageResize(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  id: number,
  request: ResizeImageRequest
): Promise<ResizeImageReceipt> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/assets/${encodeURIComponent(id)}/resize`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'editor:editorModalMedia.imageResizeFailed')
  }
  if (
    !isRecord(payload) ||
    payload.status !== 'succeeded' ||
    !Number.isSafeInteger(payload.assetId) ||
    typeof payload.destinationPath !== 'string' ||
    !Number.isSafeInteger(payload.width) ||
    !Number.isSafeInteger(payload.height) ||
    !Object.hasOwn(RESIZE_FORMATS, String(payload.format)) ||
    !Number.isSafeInteger(payload.frames) ||
    !Number.isSafeInteger(payload.fileSize) ||
    typeof payload.sourceSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(payload.sourceSha256)
  ) {
    throw new Error('The image resize response did not contain a valid asset receipt.')
  }
  return payload as unknown as ResizeImageReceipt
}
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
export type MediaPickerPurpose = 'insert' | 'page-branding' | 'manage'

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
    const resizeDimensions: { resizeWidth: number | string; resizeHeight: number | string } = {
      resizeWidth: 1200,
      resizeHeight: 900
    }
    return {
      mediaDialogComponent: markRaw(VDialog),
      folders: markRaw([] as AssetFolder[]),
      files: [] as FilePondFile[],
      assets: markRaw([] as Asset[]),
      loadedFolderId: null as number | null,
      loadedFolderPath: '',
      managedMedia: {
        folderTree: [] as AssetFolder[],
        currentFolderId: 0,
        currentFileId: null as number | null
      },
      pagination: 1,
      imageAlignments: IMAGE_ALIGNMENTS.map(item => ({ ...item, title: this.$t(`editor:editorModalMedia.alignment_${item.value || 'none'}`) })),
      mediaSortBy: MEDIA_SORT_BY,
      renameAssetRules: RENAME_ASSET_RULES.map(rule => (value: unknown) => { const message = rule(value); return typeof message === 'string' ? this.$t(message) : message }),
      imageAlignment: '' as EditorImageAlignment,
      imageAlt: '',
      imageWidth: '',
      imageHeight: '',
      imageStyles: [] as EditorImageStyle[],
      imageInsertError: '',
      insertionOwner: imageInsertionOwner(),
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
      relocationContext: null as { assetId: number; sourcePath: string; folderId: number; owner: string } | null,
      dragAssetId: null as number | null,
      dragSourceFolderId: null as number | null,
      dragFolderId: null as number | null,
      dragGhost: null as HTMLElement | null,
      dragStatus: '',
      renameAssetLoading: false,
      deleteAssetLoading: false,
      resizeDialog: false,
      resizeLoading: false,
      resizeAssetId: null as number | null,
      resizeSourceName: '',
      resizeDestinationName: '',
      resizeDestinationFolderId: 0,
      ...resizeDimensions,
      resizeDistortionUnlocked: false,
      resizeFormat: 'webp' as ResizeImageFormat,
      resizeQuality: 85,
      resizeAnimationPolicy: 'preserve' as ResizeAnimationPolicy,
      resizeReceipt: null as ResizeImageReceipt | null,
      resizeError: '',
      editOperations: [] as ImageEditOperation[],
      editRedo: [] as ImageEditOperation[],
      editPreview: null as ImageEditPreview | null,
      editPreviewUrl: '',
      editPreviewKey: '',
      editPreviewRequest: 0,
      editPreviewAbort: null as AbortController | null,
      previewLoading: false,
      editFirstFrameConfirmed: false,
      editRegionKind: 'crop' as 'crop' | 'fill',
      editLeft: 0 as number | string,
      editTop: 0 as number | string,
      editWidth: 1 as number | string,
      editHeight: 1 as number | string,
      editColor: '#000000',
      editPointer: null as { id: number; x: number; y: number; target: HTMLElement } | null,
      resizeFormats: RESIZE_FORMAT_ITEMS.map(item => ({ ...item, title: this.$t(`editor:editorModalMedia.format_${item.value}`) })),
      resizeAnimationPolicies: RESIZE_ANIMATION_POLICIES.map(item => ({ ...item, title: this.$t(`editor:editorModalMedia.animationPolicy_${item.value}`) })),
      mediaLoadError: '',
      staleAssetIds: [] as number[],
      failedThumbnailUrls: {} as Record<number, string>,
      queuedFileCount: 0,
      uploading: false,
      brandingView: null as PageBrandingView | null,
      brandingLoading: false,
      brandingLoadError: '',
      brandingRequest: 0,
      brandingAbortController: null as AbortController | null,
      returnFocus: null as HTMLElement | null,
      mediaDialogReturnFocus: null as HTMLElement | null,
      mediaRequest: 0,
      mediaLoadsInFlight: 0,
      mediaAbortController: null as AbortController | null,
      fileRemovalTimers: [] as number[],
      disposed: false
    }
  },
  computed: {
    editRequestKey(): string {
      return JSON.stringify([this.resizeAssetId, this.resizeDestinationName, this.resizeDestinationFolderId, this.resizeWidth, this.resizeHeight, this.resizeDistortionUnlocked, this.resizeFormat, this.resizeQuality, this.resizeAnimationPolicy, this.editOperations, this.currentInsertionOwner])
    },
    editRegionValid(): boolean {
      const preview = this.editPreview
      const values = [this.editLeft, this.editTop, this.editWidth, this.editHeight]
      const [left, top, width, height] = values.map(Number)
      return Boolean(preview && values.every(value => typeof value === 'number' && Number.isSafeInteger(value)) && left! >= 0 && top! >= 0 && width! > 0 && height! > 0 && left! + width! <= preview.editWidth && top! + height! <= preview.editHeight && (this.editRegionKind !== 'fill' || /^#[0-9a-f]{6}$/i.test(this.editColor)))
    },
    editRegionStyle(): Record<string, string> | null {
      const preview = this.editPreview
      if (!preview || !this.editRegionValid) return null
      return { left: `${Number(this.editLeft) / preview.editWidth * 100}%`, top: `${Number(this.editTop) / preview.editHeight * 100}%`, width: `${Number(this.editWidth) / preview.editWidth * 100}%`, height: `${Number(this.editHeight) / preview.editHeight * 100}%` }
    },
    canSaveEdit(): boolean {
      return this.isResizeValid && this.editPreview !== null && this.editPreviewKey === this.editRequestKey && (this.editOperations.length === 0 || this.editFirstFrameConfirmed)
    },
    currentInsertionOwner(): string {
      return this.isManaging
        ? JSON.stringify([wikiStore.user.authenticated, wikiStore.user.id, wikiStore.offlineIdentityEpoch])
        : imageInsertionOwner()
    },
    imageAltValid(): boolean { return isValidEditorImageAlt(this.imageAlt) },
    imageWidthValid(): boolean { return normalizeEditorImageDimension(this.imageWidth) !== null },
    imageHeightValid(): boolean { return normalizeEditorImageDimension(this.imageHeight) !== null },
    imagePropertiesValid(): boolean { return this.imageAltValid && this.imageWidthValid && this.imageHeightValid },
    activeModal: {
      get() {
        return wikiStore.editor.activeModal
      },
      set(value: string) {
        wikiStore.editor.activeModal = value
      }
    },
    folderTree(): AssetFolder[] {
      return this.isManaging ? this.managedMedia.folderTree : wikiStore.editor.media.folderTree as AssetFolder[]
    },
    currentFolderId: {
      get() {
        return this.isManaging ? this.managedMedia.currentFolderId : wikiStore.editor.media.currentFolderId
      },
      set(value: number) {
        if (this.isManaging) this.managedMedia.currentFolderId = value
        else wikiStore.editor.media.currentFolderId = value
      }
    },
    currentFileId: {
      get() {
        return this.isManaging ? this.managedMedia.currentFileId : wikiStore.editor.media.currentFileId
      },
      set(value: number | null) {
        if (this.isManaging) this.managedMedia.currentFileId = value
        else wikiStore.editor.media.currentFileId = value
      }
    },
    isBranding(): boolean {
      return this.purpose === 'page-branding'
    },
    isManaging(): boolean {
      return this.purpose === 'manage'
    },
    displayedFolders(): AssetFolder[] {
      return this.loadedFolderId === this.currentFolderId ? this.folders : []
    },
    displayedAssets(): Asset[] {
      if (this.loadedFolderId !== this.currentFolderId) return []
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
      // The internal asset ID stays out of the table; a thumbnail helps pick images instead.
      headers.push({ title: this.$t('editor:assets.headerPreview'), key: 'thumbnail', value: 'thumbnail', width: 56, sortable: false })
      headers.push({ title: this.$t('editor:assets.headerFilename'), key: 'filename', value: 'filename' })
      if (this.$vuetify.display.lgAndUp) headers.push({ title: this.$t('editor:assets.headerType'), key: 'ext', value: 'ext', width: 90 })
      if (this.$vuetify.display.mdAndUp) headers.push({ title: this.$t('editor:assets.headerFileSize'), key: 'fileSize', value: 'fileSize', width: 110 })
      if (this.$vuetify.display.mdAndUp) headers.push({ title: this.$t('editor:assets.headerAdded'), key: 'createdAt', value: 'createdAt', width: 175 })
      headers.push({ title: this.$t('editor:assets.headerActions'), key: 'actions', value: 'actions', width: 64, sortable: false, align: 'end' })
      return headers
    },
    isFolderNameValid() {
      return this.newFolderName.length > 1 && this.newFolderName.length <= 255 && !localeSegmentRegex.test(this.newFolderName) && !disallowedFolderChars.test(this.newFolderName)
    },
    currentAsset () {
      return _.find(this.displayedAssets, ['id', this.currentFileId])
    },
    isResizeValid(): boolean {
      const name = this.resizeDestinationName.trim()
      const width = Number(this.resizeWidth)
      const height = Number(this.resizeHeight)
      const quality = Number(this.resizeQuality)
      return Boolean(
        this.resizeAssetId !== null &&
        this.isAssetActionable(this.resizeAssetId) &&
        this.currentAsset?.id === this.resizeAssetId &&
        Number.isSafeInteger(width) &&
        Number.isSafeInteger(height) &&
        width > 0 &&
        height > 0 &&
        width <= 8192 &&
        height <= 8192 &&
        width * height <= 25_000_000 &&
        Number.isSafeInteger(quality) &&
        quality >= 1 &&
        quality <= 100 &&
        name.length > 0 &&
        name.length <= 255 &&
        !/[\/\\]/.test(name) &&
        name.toLowerCase().endsWith(RESIZE_EXTENSIONS[this.resizeFormat])
      )
    },
    resizePreview(): string {
      const dimensions = this.$t('editor:editorModalMedia.px', { resizeWidth: this.resizeWidth, resizeHeight: this.resizeHeight, interpolation: { escapeValue: false } })
      const format = RESIZE_FORMATS[this.resizeFormat]
      return this.resizeDistortionUnlocked
        ? this.$t('editor:editorModalMedia.outputExactlyAspectRatio', { dimensions, format, interpolation: { escapeValue: false } })
        : this.$t('editor:editorModalMedia.outputFittedWithinWhile', { format, dimensions, interpolation: { escapeValue: false } })
    },
    isRenameValid (): boolean {
      const current = this.currentAsset
      const name = this.renameAssetName.trim()
      const currentFolderId = current?.folderId ?? this.currentFolderId
      const context = this.relocationContext
      return Boolean(current && context && !this.relocationReceipt && context.assetId === current.id && context.owner === this.currentInsertionOwner && context.folderId === this.currentFolderId && context.sourcePath === this.assetPath(current) && this.isAssetActionable(current.id) && this.relocationFolderItems.some(folder => folder.value === this.relocationFolderId) && name && name.length <= 255 && !/[\/\\]/.test(name) && (name !== current.filename || this.relocationFolderId !== currentFolderId))
    },
    relocationFolderItems(): Array<{ title: string; value: number; path: string }> {
      return this.resizeFolderItems
    },
    resizeFolderItems(): Array<{ title: string; value: number; path: string }> {
      const items = [{ title: '/', value: 0, path: '' }]
      let title = ''
      let path = ''
      for (const folder of this.folderTree) {
        title = title ? `${title}/${folder.name}` : folder.name
        path = path ? `${path}/${folder.slug}` : folder.slug
        items.push({ title: `/${title}`, value: folder.id, path })
      }
      for (const folder of this.displayedFolders) {
        items.push({
          title: title ? `/${title}/${folder.name}` : `/${folder.name}`,
          value: folder.id,
          path: path ? `${path}/${folder.slug}` : folder.slug
        })
      }
      return items.filter((item, index, all) => all.findIndex(candidate => candidate.value === item.value) === index)
    },
    relocationSourcePath(): string {
      return this.currentAsset ? this.assetPath(this.currentAsset).replace(/^\//, '') : ''
    },
    relocationDestinationPath(): string {
      const folder = this.relocationFolderItems.find(item => item.value === this.relocationFolderId)
      const folderPath = folder?.path ?? ''
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
      return !this.isManaging && wikiStore.page.visibility === 'private'
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
    editRequestKey() { this.retireEditPreview() },
    resizeDialog(value: boolean) { if (!value) this.retireEditPreview() },
    currentInsertionOwner: {
      flush: 'sync',
      handler() {
        this.clearAssetDrag()
        this.retireEditPreview()
        if (this.isBranding) return
        this.renameDialog = false
        this.resizeDialog = false
        this.disposed = true
        this.mediaRequest += 1
        this.mediaAbortController?.abort()
        this.assets = markRaw([])
        this.imageAlt = ''
        this.imageWidth = ''
        this.imageHeight = ''
        this.imageStyles = []
        if (!this.embedded && this.activeModal === 'editorModalMedia') this.cancel()
      }
    },
    purpose(newValue: MediaPickerPurpose, oldValue: MediaPickerPurpose) {
      if (newValue === oldValue) return
      this.invalidateBrandingSelection()
      this.pagination = 1
      if (!this.disposed) void this.loadMedia()
    },
    currentFileId(newValue: number | null) {
      if (newValue !== this.resizeAssetId && !this.resizeLoading) { this.retireEditPreview(); this.resizeDialog = false }
      if (this.relocationContext && newValue !== this.relocationContext.assetId && !this.renameAssetLoading && !this.relocationReceipt) this.renameDialog = false
      if (this.isBranding && newValue === null) this.invalidateBrandingSelection()
      this.imageAlt = this.assets.find(asset => asset.id === newValue)?.filename ?? ''
      this.imageInsertError = ''
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
      this.clearAssetDrag()
      this.retireEditPreview()
      if (!this.renameAssetLoading && !this.relocationReceipt) this.renameDialog = false
      if (!this.resizeLoading) this.resizeDialog = false
      this.actionMenuAssetId = null
      void this.loadMedia()
    }
  },
  beforeMount() {
    if (!this.embedded) this.returnFocus = document.activeElement as HTMLElement | null
  },
  mounted() {
    void this.loadMedia()
    // Embedded branding replaces the focused Properties card without opening a
    // new SDK dialog. Hand off initial focus; the existing VDialog keeps the trap.
    if (this.embedded && this.isBranding) {
      const root = (this.$refs.mediaContent as { $el?: HTMLElement } | undefined)?.$el
      const refreshButton = (this.$refs.refreshButton as { $el?: HTMLElement } | undefined)?.$el
      if (root?.isConnected && !root.contains(document.activeElement)) refreshButton?.focus({ preventScroll: true })
    }
  },
  beforeUnmount() {
    this.clearAssetDrag()
    this.retireEditPreview()
    this.disposed = true
    this.mediaRequest++
    this.mediaAbortController?.abort()
    this.mediaAbortController = null
    this.brandingRequest++
    this.brandingAbortController?.abort()
    this.brandingAbortController = null
    for (const timer of this.fileRemovalTimers) window.clearTimeout(timer)
    this.fileRemovalTimers = []
    if (!this.embedded && this.returnFocus?.isConnected) {
      const target = this.returnFocus
      this.$nextTick(() => target.isConnected && target.focus({ preventScroll: true }))
    }
  },
  methods: {
    retireEditPreview() {
      this.editPreviewRequest++
      this.editPreviewAbort?.abort()
      this.editPreviewAbort = null
      this.previewLoading = false
      this.editPreview = null
      this.editPreviewUrl = ''
      this.editPreviewKey = ''
      this.cancelEditRegion()
    },
    imageEditRequest(): ResizeImageRequest {
      return {
        destination: { filename: this.resizeDestinationName.trim(), folderId: Number(this.resizeDestinationFolderId) },
        width: Number(this.resizeWidth), height: Number(this.resizeHeight),
        aspectPolicy: this.resizeDistortionUnlocked ? 'stretch' : 'preserve',
        format: this.resizeFormat, quality: Number(this.resizeQuality),
        animationPolicy: this.resizeAnimationPolicy, operations: this.editOperations
      }
    },
    async loadEditPreview() {
      if (!this.isResizeValid || this.resizeAssetId === null || this.resizeLoading) return
      this.retireEditPreview()
      const request = this.editPreviewRequest
      const key = this.editRequestKey
      const assetId = this.resizeAssetId
      const controller = markRaw(new AbortController())
      this.editPreviewAbort = controller
      this.previewLoading = true
      this.resizeError = ''
      try {
        const response = await sameOriginJsonFetch(window.fetch.bind(window), `/_api/assets/${assetId}/resize-preview`, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(this.imageEditRequest())
        })
        const payload: unknown = await response.json()
        if (!response.ok) throw new Error(isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'Image preview failed.')
        if (!isRecord(payload) || payload.status !== 'previewed' || typeof payload.dataUrl !== 'string' ||
          payload.dataUrl.length > 35_000_000 || !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(payload.dataUrl) ||
          typeof payload.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(payload.sourceSha256) ||
          ![payload.width, payload.height, payload.editWidth, payload.editHeight, payload.frames].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
          typeof payload.sourceRevision !== 'string' || !/^[0-9a-f]{64}$/.test(payload.sourceRevision) ||
          Number(payload.width) > 8192 || Number(payload.height) > 8192 || Number(payload.width) * Number(payload.height) > 25_000_000 ||
          Number(payload.editWidth) > 10000 || Number(payload.editHeight) > 10000 || !Object.hasOwn(RESIZE_FORMATS, String(payload.format))) {
          throw new Error('Invalid bounded image preview.')
        }
        if (this.disposed || !this.resizeDialog || request !== this.editPreviewRequest || key !== this.editRequestKey || assetId !== this.resizeAssetId) return
        this.editPreview = payload as unknown as ImageEditPreview
        this.editPreviewUrl = payload.dataUrl
        this.editPreviewKey = key
        this.editLeft = 0
        this.editTop = 0
        this.editWidth = Number(payload.editWidth)
        this.editHeight = Number(payload.editHeight)
      } catch (error: unknown) {
        if (!this.disposed && request === this.editPreviewRequest && !isAbortError(error)) this.resizeError = error instanceof Error ? error.message : 'Image preview failed.'
      } finally {
        if (this.editPreviewAbort === controller) this.editPreviewAbort = null
        if (request === this.editPreviewRequest) this.previewLoading = false
      }
    },
    confirmEditFirstFrame(value: boolean | null) {
      this.editFirstFrameConfirmed = value === true
      if (value === true) this.resizeAnimationPolicy = 'first-frame'
    },
    describeImageEdit(operation: ImageEditOperation): string {
      if (operation.type === 'rotate') return `Rotate ${operation.turns * 90}° clockwise`
      if (operation.type === 'mirror') return `Mirror ${operation.axis}`
      return `${operation.type === 'crop' ? 'Crop' : `Opaque fill ${operation.color}`} at (${operation.left}, ${operation.top}), ${operation.width} × ${operation.height}`
    },
    appendImageEdit(operation: ImageEditOperation) {
      if (this.resizeLoading || this.previewLoading || !this.editPreview || this.editOperations.length >= 16) return
      if (operation.type === 'fill' && this.resizeFormat !== 'png' && this.resizeFormat !== 'webp') this.onResizeFormatChanged('png')
      this.editOperations = [...this.editOperations, operation]
      this.editRedo = []
      this.retireEditPreview()
      this.$nextTick(() => { if (this.resizeDialog && !this.disposed) void this.loadEditPreview() })
    },
    applyImageRegion() {
      if (!this.editRegionValid) return
      const region = { left: Number(this.editLeft), top: Number(this.editTop), width: Number(this.editWidth), height: Number(this.editHeight) }
      this.appendImageEdit(this.editRegionKind === 'crop' ? { type: 'crop', ...region } : { type: 'fill', ...region, color: this.editColor })
    },
    undoImageEdit() {
      if (this.resizeLoading) return
      const operation = this.editOperations.at(-1)
      if (!operation) return
      this.editRedo = [...this.editRedo, operation]
      this.editOperations = this.editOperations.slice(0, -1)
      this.retireEditPreview()
      this.$nextTick(() => { if (!this.disposed && this.resizeDialog) void this.loadEditPreview() })
    },
    redoImageEdit() {
      if (this.resizeLoading || this.editOperations.length >= 16) return
      const operation = this.editRedo.at(-1)
      if (!operation) return
      this.editOperations = [...this.editOperations, operation]
      this.editRedo = this.editRedo.slice(0, -1)
      this.retireEditPreview()
      this.$nextTick(() => { if (!this.disposed && this.resizeDialog) void this.loadEditPreview() })
    },
    editPoint(event: PointerEvent, target: HTMLElement): { x: number; y: number } | null {
      const preview = this.editPreview
      const box = target.getBoundingClientRect()
      if (!preview || box.width <= 0 || box.height <= 0) return null
      return { x: Math.max(0, Math.min(preview.editWidth, Math.floor((event.clientX - box.left) / box.width * preview.editWidth))), y: Math.max(0, Math.min(preview.editHeight, Math.floor((event.clientY - box.top) / box.height * preview.editHeight))) }
    },
    startEditRegion(event: PointerEvent) {
      if (this.resizeLoading || this.previewLoading || event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return
      const point = this.editPoint(event, event.currentTarget)
      if (!point) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      this.editPointer = { id: event.pointerId, ...point, target: event.currentTarget }
      this.editLeft = point.x
      this.editTop = point.y
      this.editWidth = 0
      this.editHeight = 0
    },
    moveEditRegion(event: PointerEvent) {
      const pointer = this.editPointer
      if (!pointer || event.pointerId !== pointer.id) return
      const point = this.editPoint(event, pointer.target)
      if (!point) return
      this.editLeft = Math.min(point.x, pointer.x)
      this.editTop = Math.min(point.y, pointer.y)
      this.editWidth = Math.abs(point.x - pointer.x)
      this.editHeight = Math.abs(point.y - pointer.y)
    },
    finishEditRegion(event: PointerEvent) { this.moveEditRegion(event); this.cancelEditRegion() },
    cancelEditRegion() {
      const pointer = this.editPointer
      this.editPointer = null
      if (pointer?.target.hasPointerCapture(pointer.id)) pointer.target.releasePointerCapture(pointer.id)
    },
    canDragAsset(id: number): boolean {
      return !this.disposed && !this.loading && !this.renameDialog && !this.resizeDialog && !this.deleteDialog && this.isAssetActionable(id) &&
        this.assets.some(asset => asset.id === id) && wikiStore.user.permissions.some(permission => permission === 'manage:assets' || permission === 'manage:system')
    },
    clearAssetDrag() {
      if (this.dragAssetId !== null) {
        this.dragStatus = 'Drag ended. No changes until confirmation.'
        this.restoreMediaDialogFocus()
      }
      this.dragGhost?.remove()
      this.dragGhost = null
      this.dragAssetId = null
      this.dragSourceFolderId = null
      this.dragFolderId = null
    },
    startAssetDrag(event: DragEvent, id: number) {
      this.clearAssetDrag()
      if (!this.canDragAsset(id) || !event.dataTransfer) { event.preventDefault(); return }
      const asset = this.assets.find(candidate => candidate.id === id)
      if (!asset) { event.preventDefault(); return }
      const ghost = document.createElement('div')
      ghost.className = 'editor-media-drag-ghost'
      ghost.textContent = asset.filename
      const root = (this.$refs.mediaContent as { $el?: HTMLElement } | undefined)?.$el
      ;(root ?? document.body).append(ghost)
      this.rememberMediaDialogFocus(id)
      this.dragGhost = markRaw(ghost)
      this.dragAssetId = id
      this.dragSourceFolderId = this.currentFolderId
      try {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('application/x-tsepistle-asset', String(id))
        event.dataTransfer.setDragImage(ghost, 12, 12)
        this.dragStatus = `Moving ${asset.filename}: drop on a folder to review, or use the Move action. No changes until confirmation.`
      } catch {
        this.clearAssetDrag()
        event.preventDefault()
      }
    },
    overAssetFolder(event: DragEvent, folderId: number) {
      if (this.dragAssetId === null || !this.canDragAsset(this.dragAssetId) || this.dragSourceFolderId !== this.currentFolderId ||
        !this.displayedFolders.some(folder => folder.id === folderId) || folderId === this.currentFolderId ||
        !event.dataTransfer?.types.includes('application/x-tsepistle-asset')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      this.dragFolderId = folderId
    },
    async dropAssetOnFolder(event: DragEvent, folderId: number) {
      const id = this.dragAssetId
      const folder = this.currentFolderId
      const epoch = this.mediaRequest
      const owner = this.currentInsertionOwner
      const valid = id !== null && this.canDragAsset(id) && this.dragSourceFolderId === folder && folderId !== folder &&
        this.displayedFolders.some(candidate => candidate.id === folderId) && event.dataTransfer?.getData('application/x-tsepistle-asset') === String(id)
      this.clearAssetDrag()
      if (!valid || id === null) return
      event.preventDefault()
      this.dragStatus = 'Checking move destination; no changes have been made.'
      try {
        const response = await sameOriginJsonFetch(window.fetch.bind(window), `/_api/assets/${id}/move-preview`, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId })
        })
        const payload: unknown = await response.json()
        if (!response.ok) throw new Error(isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'This move is unavailable.')
        if (this.disposed || epoch !== this.mediaRequest || owner !== this.currentInsertionOwner || folder !== this.currentFolderId || !this.canDragAsset(id)) return
        const asset = this.assets.find(candidate => candidate.id === id)
        const destination = this.relocationFolderItems.find(candidate => candidate.value === folderId)
        if (!asset || !destination || !isRecord(payload) || payload.sourcePath !== this.assetPath(asset).replace(/^\//, '') ||
          payload.destinationPath !== (destination.path ? `${destination.path}/${asset.filename}` : asset.filename)) throw new Error('The move context changed; refresh and try again.')
        this.openMoveDialog(id)
        this.relocationFolderId = folderId
        this.dragStatus = 'Review the source, destination and publication warnings, then confirm Move. No changes have been made.'
      } catch (error: unknown) {
        if (!this.disposed && epoch === this.mediaRequest && owner === this.currentInsertionOwner) this.dragStatus = error instanceof Error ? error.message : 'This move is unavailable.'
      }
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
      this.clearAssetDrag()
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
      if (this.resizeDialog) {
        if (!this.resizeLoading) this.resizeDialog = false
        return
      }
      this.cancel()
    },
    rememberMediaDialogFocus (assetId: number) {
      const root = (this.$refs.mediaContent as { $el?: HTMLElement } | undefined)?.$el
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
        this.brandingLoadError = this.$t('editor:editorModalMedia.imageCannotUsedPage')
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
      return id !== null && this.loadedFolderId === this.currentFolderId && !this.staleAssetIds.includes(id)
    },
    assetAriaLabel (asset: Asset): string {
      if (!this.isAssetActionable(asset.id)) return this.$t('editor:editorModalMedia.unavailableUntilAssetsReload', { filename: asset.filename, interpolation: { escapeValue: false } })
      return this.currentFileId === asset.id ? this.$t('editor:editorModalMedia.selected', { filename: asset.filename, interpolation: { escapeValue: false } }) : this.$t('editor:editorModalMedia.select', { filename: asset.filename, interpolation: { escapeValue: false } })
    },
    markAssetStale (assetId: number) {
      if (!this.staleAssetIds.includes(assetId)) this.staleAssetIds.push(assetId)
      if (this.actionMenuAssetId === assetId) this.actionMenuAssetId = null
      if (this.currentFileId === assetId) this.currentFileId = null
    },
    confirmSelection () {
      if (!this.isBranding || !this.isAssetActionable(this.currentFileId)) return
      const assignment = PageBrandingAssignmentSchema.safeParse({ assetId: this.currentFileId })
      const view = PageBrandingViewSchema.safeParse(this.brandingView)
      if (!assignment.success || !view.success || view.data.assetId !== assignment.data.assetId) {
        this.brandingView = null
        this.brandingLoadError = this.$t('editor:editorModalMedia.selectSupportedImageBefore')
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
        throw new TypeError(this.$t('editor:editorModalMedia.expectedNumber'))
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
    assetPath (asset: Asset): string {
      return this.loadedFolderPath ? `/${this.loadedFolderPath}/${asset.filename}` : `/${asset.filename}`
    },
    assetUrl (asset: Asset): string {
      return encodeURI(this.assetPath(asset))
    },
    assetIcon (asset: Asset): string {
      if (asset.kind === 'IMAGE') return 'mdi-image-outline'
      const ext = asset.ext.toLowerCase()
      if (ext === '.pdf') return 'mdi-file-pdf-box'
      if (['.mp4', '.webm', '.mov', '.mkv'].includes(ext)) return 'mdi-file-video-outline'
      if (['.mp3', '.wav', '.ogg', '.flac', '.m4a'].includes(ext)) return 'mdi-file-music-outline'
      if (['.zip', '.gz', '.tar', '.7z', '.rar'].includes(ext)) return 'mdi-folder-zip-outline'
      return 'mdi-file-outline'
    },
    markThumbnailFailed (asset: Asset, event: Event) {
      if (this.disposed || this.loadedFolderId !== this.currentFolderId || !this.assets.includes(asset)) return
      const url = this.assetUrl(asset)
      if (!(event.currentTarget instanceof HTMLImageElement) || event.currentTarget.getAttribute('src') !== url) return
      if (this.failedThumbnailUrls[asset.id] !== url) this.failedThumbnailUrls[asset.id] = url
    },
    syncQueuedFiles (files: unknown) {
      this.queuedFileCount = Array.isArray(files) ? files.length : 0
    },
    insert () {
      if (this.isBranding || this.isManaging || this.disposed) return
      if (this.insertionOwner !== this.currentInsertionOwner) return
      if (!this.isAssetActionable(this.currentFileId)) return
      const asset = _.find(this.assets, ['id', this.currentFileId])
      if (!asset) return
      this.imageInsertError = ''
      const path = this.assetPath(asset)
      if (asset.kind === 'IMAGE' && (!this.imagePropertiesValid || !isSafeEditorImageSource(path))) {
        this.imageInsertError = 'The image source or properties are invalid. Correct them before inserting.'
        return
      }
      emitEditorInsert({
        kind: asset.kind,
        path,
        text: asset.kind === 'IMAGE' ? this.imageAlt : asset.filename,
        align: this.imageAlignment,
        ...(asset.kind === 'IMAGE' ? {
          width: normalizeEditorImageDimension(this.imageWidth)!,
          height: normalizeEditorImageDimension(this.imageHeight)!,
          styles: [...this.imageStyles]
        } : {})
      })
      this.activeModal = ''
    },
    async upload () {
      if (this.isPrivatePage) {
        throw new Error(this.$t('editor:editorModalMedia.assetsSiteWideCannot'))
      }
      // A second click while files are processing must not queue another upload.
      if (this.uploading) return
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
      this.uploading = true
      let processed: unknown
      try {
        processed = await (this.$refs.pond as FilePondRef).processFiles()
      } finally {
        this.uploading = false
      }
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
      if (this.isManaging) this.managedMedia.folderTree.push(folder)
      else wikiStore.pushMediaFolder(folder)
      this.currentFolderId = folder.id
      this.currentFileId = null
    },
    upFolder() {
      if (this.isManaging) this.managedMedia.folderTree.pop()
      else wikiStore.popMediaFolder()
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
    isResizableAsset(asset: Asset | undefined): boolean {
      return Boolean(asset &&
        asset.kind.toUpperCase() === 'IMAGE' &&
        Object.hasOwn(RESIZABLE_IMAGE_EXTENSIONS, asset.ext.toLowerCase()))
    },
    openResizeDialog(id: number) {
      if (!this.isAssetActionable(id)) return
      const asset = _.find(this.assets, ['id', id])
      if (!asset || !this.isResizableAsset(asset)) return
      this.rememberMediaDialogFocus(id)
      this.actionMenuAssetId = null
      this.currentFileId = id
      this.resizeAssetId = id
      this.resizeSourceName = asset.filename
      const sourceExtension = asset.ext.toLowerCase()
      this.resizeFormat = sourceExtension === '.png'
        ? 'png'
        : sourceExtension === '.jpg' || sourceExtension === '.jpeg'
          ? 'jpeg'
          : sourceExtension === '.gif'
            ? 'gif'
            : 'webp'
      const basename = asset.filename.slice(0, Math.max(0, asset.filename.length - asset.ext.length))
      this.resizeDestinationName = `${basename}-resized${RESIZE_EXTENSIONS[this.resizeFormat]}`
      this.resizeDestinationFolderId = asset.folderId ?? this.currentFolderId
      this.resizeWidth = 1200
      this.resizeHeight = 900
      this.resizeDistortionUnlocked = false
      this.resizeQuality = 85
      this.resizeAnimationPolicy = 'preserve'
      this.resizeReceipt = null
      this.resizeError = ''
      this.editOperations = []
      this.editRedo = []
      this.editFirstFrameConfirmed = false
      this.retireEditPreview()
      this.resizeDialog = true
    },
    onResizeFormatChanged(format: ResizeImageFormat) {
      if (!Object.hasOwn(RESIZE_EXTENSIONS, format)) return
      this.resizeFormat = format
      const filename = this.resizeDestinationName.trim()
      const dot = filename.lastIndexOf('.')
      const basename = dot > 0 ? filename.slice(0, dot) : filename
      this.resizeDestinationName = `${basename}${RESIZE_EXTENSIONS[format]}`
    },
    openRelocationDialog(id: number, mode: 'rename' | 'move') {
      if (!this.isAssetActionable(id)) return
      this.rememberMediaDialogFocus(id)
      this.actionMenuAssetId = null
      this.currentFileId = id
      if (!this.currentAsset) throw new Error(this.$t('editor:editorModalMedia.noAssetSelectedRelocation'))
      this.relocationMode = mode
      this.renameAssetName = this.currentAsset.filename
      this.relocationFolderId = this.currentAsset.folderId ?? this.currentFolderId
      this.relocationReceipt = null
      this.relocationContext = { assetId: id, sourcePath: this.assetPath(this.currentAsset), folderId: this.currentFolderId, owner: this.currentInsertionOwner }
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
      if (!this.currentAsset) throw new Error(this.$t('editor:editorModalMedia.noAssetSelectedDeletion'))
      this.deleteDialog = true
    },
    async resizeSelectedAsset() {
      if (!this.canSaveEdit || this.resizeLoading || this.resizeAssetId === null) return
      const assetId = this.resizeAssetId
      const destinationFolderId = Number(this.resizeDestinationFolderId)
      const request: ResizeImageRequest = {
        destination: { filename: this.resizeDestinationName.trim(), folderId: destinationFolderId },
        width: Number(this.resizeWidth),
        height: Number(this.resizeHeight),
        aspectPolicy: this.resizeDistortionUnlocked ? 'stretch' : 'preserve',
        format: this.resizeFormat,
        quality: Number(this.resizeQuality),
        animationPolicy: this.resizeAnimationPolicy,
        operations: this.editOperations,
        expectedSourceSha256: this.editPreview?.sourceSha256,
        expectedSourceRevision: this.editPreview?.sourceRevision
      }
      wikiStore.startLoading('editor-media-resizeasset')
      this.resizeLoading = true
      this.resizeError = ''
      try {
        const receipt = await requestImageResize(window.fetch.bind(window), assetId, request)
        if (this.disposed) return
        this.resizeReceipt = receipt
        const refreshed = await this.loadMedia()
        if (this.disposed) return
        if (!refreshed) this.resizeError = this.$t('editor:editorModalMedia.newAssetWasCreated')
        wikiStore.showNotification({
          message: this.$t('editor:editorModalMedia.savedNewAssetOriginal', { destinationPath: receipt.destinationPath, assetId: receipt.assetId, interpolation: { escapeValue: false } }),
          style: 'success',
          icon: 'check'
        })
      } catch (error: unknown) {
        if (this.disposed) return
        this.resizeError = error instanceof Error ? this.$t(error.message) : this.$t('editor:editorModalMedia.imageResizeFailed')
        wikiStore.showError(error)
      } finally {
        if (!this.disposed) this.resizeLoading = false
        wikiStore.stopLoading('editor-media-resizeasset')
      }
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
        if (next.id !== receipt.id || next.assetId !== receipt.assetId) throw new Error(this.$t('editor:editorModalMedia.assetRelocationStatusDid'))
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
      const sourcePath = this.relocationSourcePath
      const destinationPath = this.relocationDestinationPath
      const owner = this.currentInsertionOwner
      const epoch = this.mediaRequest
      wikiStore.startLoading('editor-media-relocateasset')
      this.renameAssetLoading = true
      try {
        if (this.relocationMode === 'move' && folderId !== currentFolderId) {
          const response = await sameOriginJsonFetch(window.fetch.bind(window), `/_api/assets/${assetId}/move-preview`, {
            method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId })
          })
          const payload: unknown = await response.json()
          if (!response.ok) throw new Error(isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'This move is unavailable.')
          const previewDestination = isRecord(payload) && typeof payload.destinationPath === 'string' ? payload.destinationPath : ''
          const slash = previewDestination.lastIndexOf('/')
          const reviewedDestination = slash >= 0 ? `${previewDestination.slice(0, slash + 1)}${assetName}` : assetName
          if (this.disposed || owner !== this.currentInsertionOwner || epoch !== this.mediaRequest ||
            !isRecord(payload) || payload.sourcePath !== sourcePath || reviewedDestination !== destinationPath) {
            this.renameDialog = false
            throw new Error('The source or destination changed. Refresh and review the move again.')
          }
        }
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
      this.clearAssetDrag()
      this.retireEditPreview()
      if (this.renameDialog && !this.renameAssetLoading && !this.relocationReceipt) this.renameDialog = false
      const request = ++this.mediaRequest
      const folderId = this.currentFolderId
      const folderPath = this.folderTree.map(folder => folder.slug).join('/')
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
        // Rows and their paths are published together only for this navigation snapshot.
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
        if (this.disposed || request !== this.mediaRequest || folderId !== this.currentFolderId ||
          folderPath !== this.folderTree.map(folder => folder.slug).join('/')) return false
        const visibleAssets = this.isBranding ? assets.filter(isPageBrandingAsset) : assets
        this.loadedFolderId = folderId
        this.loadedFolderPath = folderPath
        this.folders = markRaw(folders)
        this.assets = markRaw(visibleAssets)
        this.staleAssetIds = []
        if (this.currentFileId !== null && !visibleAssets.some(asset => asset.id === this.currentFileId)) {
          this.currentFileId = null
        }
        return true
      } catch (err) {
        if (this.disposed || request !== this.mediaRequest || folderId !== this.currentFolderId || isAbortError(err)) return false
        this.mediaLoadError = this.$t('editor:editorModalMedia.unableLoadAssetsTry')
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
      if (this.isManaging) return
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
.editor-media-drag-ghost {
  position: fixed;
  top: -100px;
  left: -1000px;
  max-width: 260px;
  padding: 8px 12px;
  border: 1px solid rgb(var(--v-theme-primary));
  border-radius: 8px;
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}
.editor-media-drop-target { outline: 3px solid rgb(var(--v-theme-primary)); outline-offset: 2px; }
.editor-media-edit-surface {
  position: relative;
  width: fit-content;
  max-width: 100%;
  touch-action: none;
  user-select: none;
  img { display: block; max-width: 100%; max-height: 420px; object-fit: contain; }
}
.editor-media-edit-region {
  position: absolute;
  border: 2px solid rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), .15);
  pointer-events: none;
}
.editor-media-owned-overlay .editor-media-resize-dimensions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  @media (max-width: 599px) { grid-template-columns: minmax(0, 1fr); }
}
.editor-modal-media {
  background: var(--wiki-canvas-bg, rgb(var(--v-theme-background))) !important;
  color: rgb(var(--v-theme-on-background));
  padding-bottom: env(safe-area-inset-bottom);
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  overscroll-behavior: contain;
  width: 100%;

  .editor-media-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--wiki-space-4);
    align-items: start;
    padding: clamp(.75rem, 1.4vw, 1.5rem);
  }
  .editor-media-resize-dimensions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--wiki-space-3);

    @include until($tablet) {
      grid-template-columns: minmax(0, 1fr);
    }
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
      color: var(--wiki-primary-ink);
    }
  }

  .editor-media-path {
    padding-block: var(--wiki-space-4);
    overflow-wrap: anywhere;
    color: var(--wiki-text-muted);
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

  .editor-media-thumb-cell {
    width: 56px;
    padding-inline-end: 0 !important;
  }

  .editor-media-thumb {
    align-items: center;
    background: var(--wiki-surface-sunken);
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-radius-xs);
    color: var(--wiki-text-muted);
    display: inline-flex;
    height: 40px;
    justify-content: center;
    overflow: hidden;
    width: 40px;

    img {
      display: block;
      height: 100%;
      object-fit: cover;
      width: 100%;
    }
  }

  .editor-media-actions-cell {
    text-align: end;
    width: 56px;
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
    background: var(--wiki-surface-raised);
    color: rgb(var(--v-theme-on-surface));
  }

  .editor-media-panel {
    background: var(--wiki-surface-gradient);
    border: 1px solid var(--wiki-material-border);
    box-shadow: var(--wiki-specular-border);
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


  .filepond--panel-root {
    background: var(--wiki-surface-sunken);
    background-image: none;
    border: 1px solid var(--wiki-well-border);
    box-shadow: var(--wiki-shadow-inset);
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
    max-height: none;
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

    @media (max-width: 1099px) {
      .editor-media-layout {
        display: flex;
        flex-direction: column;
      }

      .editor-media-browser {
        height: auto;
        min-height: 100%;
        max-height: none;
        flex: 0 0 auto;
      }

      .editor-media-browser > .editor-media-panel,
      .editor-media-browser > .editor-media-panel > .editor-media-panel-content {
        // Wrapped controls contribute their real height instead of squeezing the results away.
        min-height: min-content;
      }

      .editor-media-browser .editor-media-table {
        // Bound the intrinsic table size, while retaining space for its header and a full row.
        height: 8rem;
        min-height: 8rem;
      }

      .editor-media-sidebar {
        flex: 0 0 auto;
      }
    }
  }

}
</style>
