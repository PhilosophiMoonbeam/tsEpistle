<template>
  <aside
    v-if="isVisible"
    class="site-banner"
    role="note"
    :aria-labelledby="banner.title ? bannerTitleId : undefined"
    :aria-label="banner.title ? undefined : 'Site notice'"
  >
    <v-icon class="site-banner__icon" aria-hidden="true">mdi-alert-decagram-outline</v-icon>
    <div class="site-banner__body">
      <h2 v-if="banner.title" :id="bannerTitleId" class="site-banner__title">{{ banner.title }}</h2>
      <div v-if="banner.content" class="site-banner__content" v-html="renderedContent" />
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import type { SiteBannerConfig } from '../../../shared/site-banner.ts'
import { renderSafeMarkdown } from '../../helpers/safe-markdown.ts'

const { banner } = defineProps<{ banner: SiteBannerConfig }>()
const bannerTitleId = useId()

const isVisible = computed(() => banner.isEnabled && Boolean(banner.title || banner.content))
const renderedContent = computed(() => renderSafeMarkdown(banner.content)
  .replace(/<h[1-6](\s[^>]*)?>/g, '<h3$1>')
  .replace(/<\/h[1-6]>/g, '</h3>'))
</script>
<style scoped>
.site-banner {
  display: flex;
  gap: 1rem;
  margin-block-end: 1.25rem;
  padding: 1rem 1.25rem;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-warning)) 42%, transparent);
  border-inline-start-width: .35rem;
  border-radius: var(--wiki-control-radius);
  color: rgb(var(--v-theme-on-surface));
  background: color-mix(in srgb, rgb(var(--v-theme-warning)) 12%, transparent);
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
.site-banner__content :deep(h3) {
  margin-block: 1rem .4rem;
  font-size: 1rem;
  line-height: 1.35;
}
.site-banner__content :deep(p),
.site-banner__content :deep(ul),
.site-banner__content :deep(ol),
.site-banner__content :deep(blockquote),
.site-banner__content :deep(pre),
.site-banner__content :deep(table) {
  margin-block: .55rem;
}
.site-banner__content :deep(ul),
.site-banner__content :deep(ol) {
  padding-inline-start: 1.35rem;
}
.site-banner__content :deep(blockquote) {
  padding-inline: .85rem;
  border-inline-start: .2rem solid color-mix(in srgb, rgb(var(--v-theme-warning)) 60%, transparent);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 82%, transparent);
}
.site-banner__content :deep(a) {
  color: rgb(var(--v-theme-primary));
  text-decoration: underline;
  text-decoration-thickness: .1em;
  text-underline-offset: .15em;
}
.site-banner__content :deep(a:hover) {
  color: rgb(var(--v-theme-secondary));
}
.site-banner__content :deep(code) {
  padding: .1em .3em;
  border-radius: .25rem;
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 10%, transparent);
  font-size: .92em;
}
.site-banner__content :deep(pre) {
  max-width: 100%;
  overflow-x: auto;
  padding: .65rem .8rem;
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 8%, transparent);
}
.site-banner__content :deep(pre code) {
  padding: 0;
  background: transparent;
}
.site-banner__content :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
}
.site-banner__content :deep(th),
.site-banner__content :deep(td) {
  padding: .35rem .55rem;
  border: 1px solid color-mix(in srgb, rgb(var(--v-border-color)) 28%, transparent);
  text-align: start;
}
.site-banner__content :deep(th) {
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 8%, transparent);
}
.site-banner__content :deep(p:last-child),
.site-banner__content :deep(ul:last-child),
.site-banner__content :deep(ol:last-child),
.site-banner__content :deep(blockquote:last-child),
.site-banner__content :deep(pre:last-child),
.site-banner__content :deep(table:last-child) {
  margin-block-end: 0;
}
@media (forced-colors: active) {
  .site-banner {
    border-color: CanvasText;
  }
  .site-banner__icon {
    color: CanvasText;
  }
}
@media print {
  .site-banner {
    break-inside: avoid;
    border-color: CanvasText;
    background: transparent;
  }
}
</style>
