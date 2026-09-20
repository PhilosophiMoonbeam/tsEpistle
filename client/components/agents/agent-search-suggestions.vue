<template>
  <aside class="agent-search-suggestions" :aria-labelledby="headingId">
    <header>
      <v-icon icon="mdi-google" size="17" aria-hidden="true" />
      <strong :id="headingId">Related searches</strong>
      <span>from Google</span>
    </header>
    <iframe
      :srcdoc="isolatedDocument"
      :style="{ height: `${frameHeight}px` }"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerpolicy="no-referrer"
      title="Google Search suggestions"
    />
  </aside>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'

const props = defineProps<{ suggestions: readonly string[] }>()
const headingId = `${useId()}-search-suggestions-title`

const isolatedDocument = computed(() => `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root { color-scheme: light dark; font: 14px/1.45 sans-serif; }
body { margin: 0; padding: 8px; color: CanvasText; background: Canvas; }
a { color: LinkText; overflow-wrap: anywhere; }
img, video, audio, iframe, object, embed, form, input, button { display: none !important; }
</style>
</head><body>${props.suggestions.join('\n')}</body></html>`)
const frameHeight = computed(() => Math.min(280, 48 + props.suggestions.length * 48))
</script>

<style scoped>
.agent-search-suggestions {
  margin-block-start: var(--wiki-space-3);
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
}
.agent-search-suggestions header {
  display: flex;
  min-height: var(--wiki-space-9);
  align-items: center;
  gap: var(--wiki-space-2);
  padding-inline: var(--wiki-space-3);
  border-block-end: 1px solid var(--wiki-surface-border);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
  font-size: .76rem;
}
.agent-search-suggestions header strong { color: rgb(var(--v-theme-on-surface)); }
.agent-search-suggestions header span { margin-inline-start: auto; }
.agent-search-suggestions iframe {
  display: block;
  width: 100%;
  border: 0;
  background: transparent;
}
@media (forced-colors: active) {
  .agent-search-suggestions { border-color: CanvasText; background: Canvas; color: CanvasText; }
}
</style>
