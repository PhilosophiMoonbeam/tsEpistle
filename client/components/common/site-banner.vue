<template>
  <aside
    v-if="isVisible"
    class="site-banner"
    role="note"
  >
    <v-icon class="site-banner__icon" aria-hidden="true">mdi-alert-decagram-outline</v-icon>
    <div class="site-banner__body">
      <h2 v-if="banner.title" class="site-banner__title">{{ banner.title }}</h2>
      <div v-if="banner.content" class="site-banner__content" v-html="renderedContent" />
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { SiteBannerConfig } from '../../../shared/site-banner.ts'
import { renderSafeMarkdown } from '../../helpers/safe-markdown.ts'

const props = defineProps<{ banner: SiteBannerConfig }>()

const isVisible = computed(() => props.banner.isEnabled && Boolean(props.banner.title || props.banner.content))
const renderedContent = computed(() => renderSafeMarkdown(props.banner.content))
</script>

<style scoped>
.site-banner {
  display: flex;
  gap: 1rem;
  margin-block-end: 1.25rem;
  padding: 1rem 1.25rem;
  border: 1px solid rgba(var(--v-theme-warning), .42);
  border-inline-start-width: .35rem;
  border-radius: .5rem;
  color: rgb(var(--v-theme-on-surface));
  background: rgba(var(--v-theme-warning), .12);
}
.site-banner__icon {
  flex: 0 0 auto;
  margin-block-start: .1rem;
  color: rgb(var(--v-theme-on-surface));
}
.site-banner__body {
  min-width: 0;
}
.site-banner__title {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 600;
  line-height: 1.4;
}
.site-banner__content {
  margin-block-start: .3rem;
  overflow-wrap: anywhere;
}
.site-banner__content :deep(p:last-child),
.site-banner__content :deep(ul:last-child),
.site-banner__content :deep(ol:last-child),
.site-banner__content :deep(blockquote:last-child) {
  margin-block-end: 0;
}
.site-banner__content :deep(pre) {
  max-width: 100%;
  overflow-x: auto;
}
@media print {
  .site-banner {
    break-inside: avoid;
    border-color: #777;
    background: transparent;
  }
}
</style>
