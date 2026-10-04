<template>
  <v-dialog :model-value="true" max-width="600" content-class="agent-owned-overlay agent-asset-picker-overlay" :aria-label="$t('common:agentAssetPicker.browseWikiAssets')" :z-index="2800" @update:model-value="close" @after-enter="searchInput?.focus()">
    <section class="agent-asset-picker">
      <header class="agent-asset-picker__header">
        <div><h2>{{ $t('common:agentAssetPicker.browseWikiAssets') }}</h2><p>{{ $t('common:agentAssetPicker.privateCopyStaysConversation') }}</p></div>
        <v-btn icon="mdi-close" variant="text" size="small" :aria-label="$t('common:agentAssetPicker.closeAssetPicker')" @click="close" />
      </header>
      <nav class="agent-asset-picker__breadcrumbs" :aria-label="$t('common:agentAssetPicker.assetFolders')">
        <button type="button" :disabled="busy || !trail.length" @click="navigate(-1)">{{ $t('common:agentAssetPicker.wikiAssets') }}</button>
        <template v-for="(folder, index) in trail" :key="folder.id"><span aria-hidden="true">/</span><button type="button" :disabled="busy || index === trail.length - 1" :aria-current="index === trail.length - 1 ? 'page' : undefined" @click="navigate(index)">{{ folder.name }}</button></template>
      </nav>
      <label class="agent-asset-picker__search">
        <span class="agent-asset-picker__search-label">{{ $t('common:agentAssetPicker.searchFilenamesFolder') }}</span>
        <span class="agent-asset-picker__search-field"><v-icon icon="mdi-magnify" size="20" aria-hidden="true" /><input ref="searchInput" v-model="query" type="search" :aria-label="$t('common:agentAssetPicker.searchFilenamesFolder')" :placeholder="$t('common:agentAssetPicker.searchFolder')" :disabled="busy" /></span>
      </label>
      <div class="agent-asset-picker__body" :aria-busy="loading || busy">
        <div v-if="attachmentError" class="agent-asset-picker__error" role="alert"><p>{{ attachmentError }}</p><p>{{ $t('common:agentAssetPicker.attachmentFailureHelp') }}</p></div>
        <p v-if="loading" class="agent-asset-picker__state" role="status">{{ $t('common:agentAssetPicker.loadingWikiAssets') }}</p>
        <div v-else-if="error" class="agent-asset-picker__state" role="alert"><p>{{ error }}</p><v-btn variant="text" size="small" @click="load">{{ $t('common:agentAssetPicker.tryAgain') }}</v-btn></div>
        <template v-else>
          <ul class="agent-asset-picker__items" :aria-label="$t('common:agentAssetPicker.filesFolders')">
            <li v-for="folder in folders" :key="`folder-${folder.id}`"><button class="agent-asset-picker__row" type="button" :disabled="busy" @click="openFolder(folder)"><v-icon icon="mdi-folder-outline" aria-hidden="true" /><span class="agent-asset-picker__name">{{ folder.name }}</span><v-icon icon="mdi-chevron-right" size="18" aria-hidden="true" /></button></li>
            <li v-for="asset in visibleAssets" :key="asset.id"><button class="agent-asset-picker__row" type="button" :disabled="busy || Boolean(unavailable(asset))" :aria-label="assetLabel(asset)" @click="select(asset)"><v-icon :icon="mimeType(asset) === 'application/pdf' ? 'mdi-file-pdf-box' : 'mdi-image-outline'" aria-hidden="true" /><span class="agent-asset-picker__name">{{ asset.filename }}<small v-if="unavailable(asset)">{{ unavailable(asset) }}</small></span><span class="agent-asset-picker__size">{{ formatSize(asset.fileSize) }}</span></button></li>
          </ul>
          <p v-if="!visibleAssets.length" class="agent-asset-picker__state" role="status">{{ query.trim() ? $t('common:agentAssetPicker.noMatchingImagesPdfs') : folders.length ? $t('common:agentAssetPicker.openFolderFindImages') : $t('common:agentAssetPicker.noSupportedImagesPdfs') }}</p>
        </template>
      </div>
      <footer class="agent-asset-picker__footer"><span v-if="busy" role="status">{{ $t('common:agentAssetPicker.attachingPrivateCopy') }}</span><span v-else>{{ imageOnly ? $t('common:agentAssetPicker.pngJpegWebpUp') : $t('common:agentAssetPicker.imagesUp10Mb') }}</span><v-btn variant="text" size="small" @click="close">{{ $t('common:actions.cancel') }}</v-btn></footer>
    </section>
  </v-dialog>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'
import { fetchAssets, fetchAssetFolders, type Asset, type AssetFolder } from '../../helpers/assets-api.ts'
import { validateAgentAttachment } from '../../helpers/agent-media.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const props = defineProps<{ imageOnly: boolean; busy: boolean; disabled: boolean; attachmentError: string }>()
const emit = defineEmits<{ close: []; select: [asset: Asset] }>()
const searchInput = useTemplateRef<HTMLInputElement>('searchInput')
const trail = ref<AssetFolder[]>([])
const folders = ref<AssetFolder[]>([])
const assets = ref<Asset[]>([])
const query = ref('')
const loading = ref(false)
const error = ref('')
let controller: AbortController | null = null
let disposed = false
const mimeTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' }
const mimeType = (asset: Asset): string => mimeTypes[asset.ext.replace(/^\./, '').toLowerCase()] ?? ''
const visibleAssets = computed(() => assets.value.filter(asset => mimeType(asset) && asset.filename.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())))
const unavailable = (asset: Asset): string | null => {
  const type = mimeType(asset)
  if (props.imageOnly && type === 'application/pdf') return t('common:agentAssetPicker.imagesOnlyImageMode')
  if (!Number.isSafeInteger(asset.fileSize) || asset.fileSize < 0) return t('common:agentAssetPicker.fileUnavailable')
  const problem = validateAgentAttachment({ type, size: asset.fileSize })
  return problem ? t(problem) : null
}
const assetLabel = (asset: Asset): string => {
  const reason = unavailable(asset)
  return reason
    ? t('common:agentAssetPicker.unavailableAsset', { filename: asset.filename, reason, interpolation: { escapeValue: false } })
    : t('common:agentAssetPicker.attach', { filename: asset.filename, interpolation: { escapeValue: false } })
}
const formatSize = (size: number): string => size < 1024 * 1024 ? t('common:agentAssetPicker.kb', { sizeKb: Math.max(1, Math.ceil(size / 1024)), interpolation: { escapeValue: false } }) : t('common:agentAssetPicker.mb', { value: (size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0), interpolation: { escapeValue: false } })
const close = () => { controller?.abort(); emit('close') }
const load = async () => {
  controller?.abort()
  if (disposed || props.disabled) return
  const current = new AbortController()
  controller = current
  loading.value = true
  error.value = ''
  assets.value = []
  folders.value = []
  let denied = false
  const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    const response = await window.fetch(input, { ...init, signal: current.signal })
    if (response.status === 401 || response.status === 403) denied = true
    return response
  }
  try {
    const folderId = trail.value.at(-1)?.id ?? 0
    const [nextAssets, nextFolders] = await Promise.all([fetchAssets(fetcher, folderId), fetchAssetFolders(fetcher, folderId)])
    if (disposed || current.signal.aborted || controller !== current) return
    assets.value = nextAssets
    folders.value = nextFolders
  } catch {
    if (disposed || current.signal.aborted || controller !== current) return
    error.value = denied ? t('common:agentAssetPicker.youDontHaveAccess') : t('common:agentAssetPicker.wikiAssetsCouldNot')
    current.abort()
  } finally { if (controller === current) loading.value = false }
}
const openFolder = (folder: AssetFolder) => {
  if (props.busy || props.disabled) return
  trail.value = [...trail.value, folder]
  query.value = ''
  void load()
}
const navigate = (index: number) => {
  if (props.busy || props.disabled) return
  trail.value = trail.value.slice(0, index + 1)
  query.value = ''
  void load()
}
const select = (asset: Asset) => { if (!props.busy && !props.disabled && !loading.value && !unavailable(asset) && assets.value.some(candidate => candidate.id === asset.id)) emit('select', asset) }
watch(() => props.disabled, disabled => { if (disabled) close() }, { flush: 'sync' })
void load()
onBeforeUnmount(() => { disposed = true; controller?.abort() })
</script>
<style scoped>
.agent-asset-picker {
  display: flex;
  min-width: 0;
  flex-direction: column;
  max-height: min(680px, calc(100dvh - 32px));
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  color: rgb(var(--v-theme-on-surface));
  box-shadow: var(--wiki-shadow-sm);
}

.agent-asset-picker__header {
  display: flex;
  min-width: 0;
  justify-content: space-between;
  align-items: start;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-4);
  border-block-end: 1px solid var(--wiki-surface-border);
}

.agent-asset-picker__header > div { min-width: 0; }
.agent-asset-picker__header h2 { margin: 0 0 var(--wiki-space-1); font-size: 1.125rem; font-weight: 650; overflow-wrap: anywhere; }
.agent-asset-picker__header p { margin: 0; color: var(--wiki-text-muted); font-size: .875rem; line-height: 1.5; }
.agent-asset-picker__header .v-btn { flex: 0 0 auto; min-width: 44px; min-height: 44px; }

.agent-asset-picker__breadcrumbs {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--wiki-space-1);
  padding: var(--wiki-space-2) var(--wiki-space-4);
  background: var(--wiki-surface-sunken);
  font-size: .8125rem;
}

.agent-asset-picker__breadcrumbs button { min-height: 44px; max-width: 100%; padding-inline: var(--wiki-space-1); color: var(--wiki-primary-ink); overflow-wrap: anywhere; text-align: start; }
.agent-asset-picker__breadcrumbs button:disabled { color: var(--wiki-text-muted); }

.agent-asset-picker__search {
  display: grid;
  min-width: 0;
  gap: var(--wiki-space-1);
  margin: var(--wiki-space-3) var(--wiki-space-4);
}

.agent-asset-picker__search-label { color: var(--wiki-text-muted); font-size: var(--wiki-label-size); font-weight: var(--wiki-label-weight); }
.agent-asset-picker__search-field {
  display: flex;
  min-width: 0;
  min-height: 44px;
  align-items: center;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-2) var(--wiki-space-3);
  border: 1px solid var(--wiki-control-edge);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
}

.agent-asset-picker__search input { appearance: none; width: 100%; min-width: 0; border: 0; background: transparent; color: inherit; outline: none; font: inherit; font-size: .875rem; }
.agent-asset-picker__search input::placeholder { color: var(--wiki-text-subtle); opacity: 1; }
.agent-asset-picker__search-field:focus-within { outline: 2px solid var(--wiki-focus-color); outline-offset: 2px; }

.agent-asset-picker__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-inline: var(--wiki-space-3); }
.agent-asset-picker__items { list-style: none; padding: 0; margin: 0; }
.agent-asset-picker__items li + li { border-block-start: 1px solid var(--wiki-surface-border); }
.agent-asset-picker__row {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 56px;
  align-items: center;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-3) var(--wiki-space-2);
  border-radius: var(--wiki-control-radius);
  text-align: start;
}

.agent-asset-picker__row:hover:not(:disabled) { background: var(--wiki-surface-sunken); }
.agent-asset-picker__row:disabled { color: var(--wiki-text-muted); }
.agent-asset-picker__row > .v-icon { flex: 0 0 auto; }
.agent-asset-picker__name { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: .875rem; }
.agent-asset-picker__name small { display: block; margin-block-start: var(--wiki-space-1); color: var(--wiki-text-muted); font-size: var(--wiki-label-size); }
.agent-asset-picker__size { flex: 0 0 auto; color: var(--wiki-text-muted); white-space: nowrap; font-size: var(--wiki-label-size); font-variant-numeric: tabular-nums; }
.agent-asset-picker__state { padding: var(--wiki-space-4) var(--wiki-space-3); color: var(--wiki-text-muted); font-size: .875rem; line-height: 1.5; overflow-wrap: anywhere; }

.agent-asset-picker__footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-3) var(--wiki-space-4);
  border-block-start: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-sunken);
  color: var(--wiki-text-muted);
  font-size: var(--wiki-label-size);
}

.agent-asset-picker__footer .v-btn { min-height: 44px; margin-inline-start: auto; }
.agent-asset-picker__error { margin-block: var(--wiki-space-2); padding: var(--wiki-space-3); border: 1px solid var(--wiki-error-ink); border-radius: var(--wiki-control-radius); background: var(--wiki-surface-sunken); color: var(--wiki-error-ink); font-size: .875rem; overflow-wrap: anywhere; }
.agent-asset-picker__error p { margin: 0; }
.agent-asset-picker__error p + p { margin-block-start: var(--wiki-space-2); }
.agent-asset-picker__header,
.agent-asset-picker__breadcrumbs,
.agent-asset-picker__search,
.agent-asset-picker__footer { flex-shrink: 0; }
.agent-asset-picker button:not(.v-btn) { appearance: none; border: 0; background: transparent; font: inherit; cursor: pointer; }
.agent-asset-picker button:not(.v-btn):disabled { cursor: default; }
.agent-asset-picker button:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: -2px; }

@media (max-width: 480px) {
  .agent-asset-picker__header,
  .agent-asset-picker__footer { padding: var(--wiki-space-3); }
  .agent-asset-picker__breadcrumbs { padding-inline: var(--wiki-space-3); }
  .agent-asset-picker__search { margin-inline: var(--wiki-space-3); }
  .agent-asset-picker__row { gap: var(--wiki-space-2); }
}
</style>
