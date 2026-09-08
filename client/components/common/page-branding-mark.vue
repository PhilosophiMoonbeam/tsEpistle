<template lang="pug">
span.page-branding-mark(
  v-if='safeBranding && !failed'
  :key='identity'
  aria-hidden='true'
)
  img.page-branding-mark__image(
    :data-branding-source='identity'
    :src='safeBranding.imageUrl'
    alt=''
    :width='safeBranding.width'
    :height='safeBranding.height'
    decoding='async'
    draggable='false'
    @error='imageFailed'
  )
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount } from 'vue'
import type { PageBrandingView } from '../../../shared/page-branding.ts'
import {
  normalizePageBrandingView,
  pageBrandingIdentity
} from '../../helpers/page-branding.ts'

const props = withDefaults(defineProps<{
  branding: PageBrandingView | null
  failed?: boolean
}>(), {
  failed: false
})

const emit = defineEmits<{
  (event: 'error', identity: string): void
}>()

const safeBranding = computed(() => normalizePageBrandingView(props.branding))
const identity = computed(() => pageBrandingIdentity(safeBranding.value))

let mounted = true
onBeforeUnmount(() => {
  mounted = false
})

const imageFailed = (event: Event): void => {
  const image = event.currentTarget
  if (!(image instanceof HTMLImageElement)) return

  void nextTick(() => {
    if (!mounted) return

    const branding = safeBranding.value
    const currentIdentity = identity.value
    if (!branding || !currentIdentity) return
    if (image.dataset.brandingSource !== currentIdentity) return

    const expectedUrl = new URL(branding.imageUrl, window.location.href).href
    const actualUrl = new URL(image.currentSrc || image.src, window.location.href).href
    if (actualUrl !== expectedUrl) return
    emit('error', currentIdentity)
  })
}
</script>

<style scoped>
.page-branding-mark {
  display: inline-flex;
  inline-size: var(--page-branding-mark-size, 64px);
  block-size: var(--page-branding-mark-size, 64px);
  flex: 0 0 var(--page-branding-mark-size, 64px);
  align-items: center;
  justify-content: center;
  overflow: visible;
  pointer-events: none;
  position: relative;
  user-select: none;
  z-index: 1;
}

.page-branding-mark__image {
  display: block;
  inline-size: 100%;
  block-size: 100%;
  max-inline-size: 100%;
  max-block-size: 100%;
  object-fit: contain;
  object-position: center;
}

@media (forced-colors: active), print {
  .page-branding-mark {
    display: none !important;
  }
}
</style>
