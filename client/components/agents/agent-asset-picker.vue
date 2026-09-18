<template>
  <v-dialog :model-value="true" max-width="600" content-class="agent-owned-overlay agent-asset-picker-overlay" aria-label="Browse Wiki assets" :z-index="2800" @update:model-value="close" @after-enter="searchInput?.focus()">
    <section class="agent-asset-picker">
      <header class="agent-asset-picker__header">
        <div><h2>Browse Wiki assets</h2><p>A private copy stays with this conversation.</p></div>
        <v-btn icon="mdi-close" variant="text" size="small" aria-label="Close asset picker" @click="close" />
      </header>
      <nav class="agent-asset-picker__breadcrumbs" aria-label="Asset folders">
        <button type="button" :disabled="busy || !trail.length" @click="navigate(-1)">Wiki assets</button>
        <template v-for="(folder, index) in trail" :key="folder.id"><span aria-hidden="true">/</span><button type="button" :disabled="busy || index === trail.length - 1" :aria-current="index === trail.length - 1 ? 'page' : undefined" @click="navigate(index)">{{ folder.name }}</button></template>
      </nav>
      <label class="agent-asset-picker__search"><v-icon icon="mdi-magnify" size="20" aria-hidden="true" /><input ref="searchInput" v-model="query" type="search" aria-label="Search filenames in this folder" placeholder="Search this folder" :disabled="busy" /></label>
      <div class="agent-asset-picker__body" :aria-busy="loading || busy">
        <p v-if="loading" class="agent-asset-picker__state" role="status">Loading Wiki assets…</p>
        <div v-else-if="error" class="agent-asset-picker__state" role="alert"><p>{{ error }}</p><v-btn variant="text" size="small" @click="load">Try again</v-btn></div>
        <template v-else>
          <ul class="agent-asset-picker__items" aria-label="Files and folders">
            <li v-for="folder in folders" :key="`folder-${folder.id}`"><button class="agent-asset-picker__row" type="button" :disabled="busy" @click="openFolder(folder)"><v-icon icon="mdi-folder-outline" aria-hidden="true" /><span class="agent-asset-picker__name">{{ folder.name }}</span><v-icon icon="mdi-chevron-right" size="18" aria-hidden="true" /></button></li>
            <li v-for="asset in visibleAssets" :key="asset.id"><button class="agent-asset-picker__row" type="button" :disabled="busy || Boolean(unavailable(asset))" :aria-label="`Attach ${asset.filename}`" @click="select(asset)"><v-icon :icon="mimeType(asset) === 'application/pdf' ? 'mdi-file-pdf-box' : 'mdi-image-outline'" aria-hidden="true" /><span class="agent-asset-picker__name">{{ asset.filename }}<small v-if="unavailable(asset)">{{ unavailable(asset) }}</small></span><span class="agent-asset-picker__size">{{ formatSize(asset.fileSize) }}</span></button></li>
          </ul>
          <p v-if="!visibleAssets.length" class="agent-asset-picker__state" role="status">{{ query.trim() ? 'No matching images or PDFs in this folder.' : 'No supported images or PDFs in this folder.' }}</p>
        </template>
      </div>
      <footer class="agent-asset-picker__footer"><span v-if="busy" role="status">Attaching a private copy…</span><span v-else>{{ imageOnly ? 'PNG, JPEG or WebP · up to 10 MB' : 'Images up to 10 MB · PDFs up to 250 MB' }}</span><v-btn variant="text" size="small" @click="close">Cancel</v-btn></footer>
      <p v-if="attachmentError" class="agent-asset-picker__error" role="alert">{{ attachmentError }}</p>
    </section>
  </v-dialog>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'
import { fetchAssets, fetchAssetFolders, type Asset, type AssetFolder } from '../../helpers/assets-api.ts'
import { validateAgentAttachment } from '../../helpers/agent-media.ts'
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
  if (props.imageOnly && type === 'application/pdf') return 'Images only in image mode'
  if (!Number.isSafeInteger(asset.fileSize) || asset.fileSize < 0) return 'This file is unavailable'
  return validateAgentAttachment({ type, size: asset.fileSize })
}
const formatSize = (size: number): string => size < 1024 * 1024 ? `${Math.max(1, Math.ceil(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`
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
    error.value = denied ? 'You don’t have access to browse Wiki assets. You can upload a file instead.' : 'Wiki assets could not be loaded. Please try again.'
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
.agent-asset-picker__breadcrumbs button { white-space: nowrap; color: rgb(var(--v-theme-primary)); }
.agent-asset-picker__breadcrumbs button:disabled { color: inherit; opacity: .65; }
.agent-asset-picker__search { display: flex; align-items: center; gap: 8px; margin: 0 20px 12px; border: 1px solid var(--wiki-surface-border); border-radius: 10px; padding: 9px 12px; }
.agent-asset-picker__search input { width: 100%; min-width: 0; outline: none; font-size: .875rem; }
.agent-asset-picker__search:focus-within { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 2px; }
.agent-asset-picker__body { min-height: 170px; overflow-y: auto; padding: 0 12px; }
.agent-asset-picker__items { list-style: none; padding: 0; margin: 0; }
.agent-asset-picker__row { width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px 8px; text-align: start; border-radius: 9px; }
.agent-asset-picker__row:hover:not(:disabled) { background: rgb(var(--v-theme-primary) / .08); }
.agent-asset-picker__row:disabled { opacity: .5; }
.agent-asset-picker__name { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: .875rem; }
.agent-asset-picker__name small { display: block; margin-top: 2px; font-size: .73rem; }
.agent-asset-picker__size { white-space: nowrap; opacity: .6; font-size: .75rem; }
.agent-asset-picker__state { text-align: center; padding: 25px 12px; font-size: .85rem; opacity: .75; }
.agent-asset-picker__footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-top: 1px solid var(--wiki-surface-border); padding: 12px 20px; font-size: .75rem; }
.agent-asset-picker__error { color: rgb(var(--v-theme-error)); padding: 0 20px 16px; font-size: .8rem; margin: 0; }
.agent-asset-picker button:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: -2px; }
@media (prefers-reduced-transparency: reduce) { .agent-asset-picker { background: var(--wiki-surface-raised, rgb(var(--v-theme-surface))); backdrop-filter: none; } }
@media (max-width: 480px) { .agent-asset-picker__header { padding: 16px 16px 12px; } .agent-asset-picker__footer { padding: 12px 16px; } }
</style>
