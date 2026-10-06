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
      <label class="agent-asset-picker__search"><v-icon icon="mdi-magnify" size="20" aria-hidden="true" /><input ref="searchInput" v-model="query" type="search" :aria-label="$t('common:agentAssetPicker.searchFilenamesFolder')" :placeholder="$t('common:agentAssetPicker.searchFolder')" :disabled="busy" /></label>
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
import { validateAgentAttachment, type AgentGenerationTool } from '../../helpers/agent-media.ts'
import type { AgentMediaCapabilities } from '../../../shared/agents/contracts.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const props = defineProps<{ imageOnly: boolean; busy: boolean; disabled: boolean; attachmentError: string; capabilities?: AgentMediaCapabilities; generationTools?: readonly AgentGenerationTool[] }>()
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
const mimeTypes: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf',
  wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', weba: 'audio/webm'
}
const mimeType = (asset: Asset): string => {
  const type = mimeTypes[asset.ext.replace(/^\./, '').toLowerCase()] ?? ''
  if (type === 'video/mp4' || type === 'video/webm') {
    const allowed = props.capabilities?.inputMimeTypes ?? []
    const audio = type.replace('video/', 'audio/')
    if (!allowed.includes(type) && allowed.includes(audio)) return audio
  }
  return type
}
const visibleAssets = computed(() => assets.value.filter(asset => mimeType(asset) && asset.filename.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())))
const unavailable = (asset: Asset): string | null => {
  const type = mimeType(asset)
  if (props.imageOnly && !type.startsWith('image/')) return t('common:agentAssetPicker.imagesOnlyImageMode')
  if (!Number.isSafeInteger(asset.fileSize) || asset.fileSize < 0) return t('common:agentAssetPicker.fileUnavailable')
  const problem = validateAgentAttachment({ type, size: asset.fileSize }, props.capabilities, props.generationTools)
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
.agent-asset-picker { display: flex; flex-direction: column; max-height: min(680px, calc(100dvh - 48px)); border: 1px solid var(--wiki-surface-border); border-radius: 20px; overflow: hidden; background: color-mix(in srgb, var(--wiki-surface-raised, rgb(var(--v-theme-surface))) 94%, transparent); color: rgb(var(--v-theme-on-surface)); backdrop-filter: blur(20px); box-shadow: 0 20px 70px rgb(0 0 0 / .2); }
.agent-asset-picker__header { display: flex; justify-content: space-between; align-items: start; gap: 12px; padding: 20px 20px 12px; }
.agent-asset-picker__header h2 { font-size: 1.1rem; font-weight: 600; margin: 0 0 4px; }
.agent-asset-picker__header p { margin: 0; font-size: .8rem; opacity: .7; }
.agent-asset-picker__breadcrumbs { display: flex; align-items: center; gap: 7px; overflow-x: auto; padding: 0 20px 12px; font-size: .8rem; }
.agent-asset-picker__breadcrumbs button { white-space: nowrap; color: var(--wiki-primary-ink); }
.agent-asset-picker__breadcrumbs button:disabled { color: inherit; opacity: .65; }
.agent-asset-picker__search { display: flex; align-items: center; gap: 8px; margin: 0 20px 12px; border: 1px solid var(--wiki-surface-border); border-radius: 10px; padding: 9px 12px; }
.agent-asset-picker__search input { appearance: none; border: 0; border-radius: 0; box-shadow: none; background: transparent; color: inherit; width: 100%; min-width: 0; outline: none; font-size: .875rem; }
.agent-asset-picker__search:focus-within { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 2px; }
.agent-asset-picker__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 12px; }
.agent-asset-picker__items { list-style: none; padding: 0; margin: 0; }
.agent-asset-picker__row { width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px 8px; text-align: start; border-radius: 9px; }
.agent-asset-picker__row:hover:not(:disabled) { background: rgb(var(--v-theme-primary) / .08); }
.agent-asset-picker__row:disabled { opacity: .5; }
.agent-asset-picker__name { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: .875rem; }
.agent-asset-picker__name small { display: block; margin-top: 2px; font-size: .73rem; }
.agent-asset-picker__size { white-space: nowrap; opacity: .6; font-size: .75rem; }
.agent-asset-picker__state { text-align: center; padding: 25px 12px; font-size: .85rem; opacity: .75; }
.agent-asset-picker__footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-top: 1px solid var(--wiki-surface-border); padding: 12px 20px; font-size: .75rem; }
.agent-asset-picker__error { color: rgb(var(--v-theme-error)); padding: 12px 8px; font-size: .8rem; margin: 0; overflow-wrap: anywhere; }
.agent-asset-picker__error p { margin: 0; }
.agent-asset-picker__error p + p { margin-top: 6px; }
.agent-asset-picker__header, .agent-asset-picker__breadcrumbs, .agent-asset-picker__search, .agent-asset-picker__footer { flex-shrink: 0; }
.agent-asset-picker button { appearance: none; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.agent-asset-picker button:disabled { cursor: default; }
.agent-asset-picker button:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: -2px; }
@media (prefers-reduced-transparency: reduce) { .agent-asset-picker { background: var(--wiki-surface-raised, rgb(var(--v-theme-surface))); backdrop-filter: none; } }
@media (max-width: 480px) { .agent-asset-picker__header { padding: 16px 16px 12px; } .agent-asset-picker__footer { padding: 12px 16px; } }
</style>
