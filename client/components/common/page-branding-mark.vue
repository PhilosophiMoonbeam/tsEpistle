<template lang="pug">
span.page-branding-mark(
  v-if='safeBranding && !failed'
  :key='identity'
  aria-hidden='true'
  :style='markStyle'
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
import { computed } from 'vue'
import type { PageBrandingView } from '../../../shared/page-branding.ts'
import {
  normalizePageBrandingView,
  pageBrandingIdentity,
  resolvePageBrandingMarkStyle
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
const markStyle = computed(() => resolvePageBrandingMarkStyle(safeBranding.value))

const imageFailed = (event: Event): void => {
  const branding = safeBranding.value
  const currentIdentity = identity.value
  const image = event.currentTarget
  if (!branding || !currentIdentity || !(image instanceof HTMLImageElement)) return
  if (image.dataset.brandingSource !== currentIdentity) return

  const expectedUrl = new URL(branding.imageUrl, window.location.href).href
  const actualUrl = new URL(image.currentSrc || image.src, window.location.href).href
  if (actualUrl !== expectedUrl) return
  emit('error', currentIdentity)
}
</script>

<style scoped>
.page-branding-mark {
  --page-branding-mark-matte: rgb(var(--v-theme-surface));
  display: inline-flex;
  inline-size: 64px;
  block-size: 64px;
  flex: 0 0 64px;
  align-items: center;
  justify-content: center;
  overflow: visible;
  border-radius: var(--wiki-radius-xs);
  background-color: var(--page-branding-mark-matte);
  pointer-events: none;
  user-select: none;
}

.page-branding-mark__image {
  display: block;
  inline-size: 100%;
  block-size: 100%;
  max-inline-size: 100%;
  max-block-size: 100%;
  object-fit: contain;
}

@media (max-width: 599px) {
  .page-branding-mark {
    inline-size: 40px;
    block-size: 40px;
    flex-basis: 40px;
  }
}

@media (forced-colors: active), print {
  .page-branding-mark {
    display: none !important;
  }
}
</style>
