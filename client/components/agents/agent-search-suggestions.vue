<template>
  <aside class="agent-search-suggestions" :aria-labelledby="headingId">
    <header>
      <v-icon icon="mdi-google" size="17" aria-hidden="true" />
      <strong :id="headingId">{{ $t('common:agentSearchSuggestions.related') }}</strong>
      <span>{{ $t('common:agentSearchSuggestions.fromGoogle') }}</span>
    </header>
    <iframe
      :srcdoc="isolatedDocument"
      :style="{ height: `${frameHeight}px` }"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerpolicy="no-referrer"
      :title="$t('common:agentSearchSuggestions.googleSuggestions')"
    />
  </aside>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import { useTheme } from 'vuetify'

const props = defineProps<{ suggestions: readonly string[] }>()
const headingId = `${useId()}-search-suggestions-title`
const theme = useTheme()

const isolatedDocument = computed(() => `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root { color-scheme: ${theme.current.value.dark ? 'dark' : 'light'}; font: 14px/1.6 sans-serif; }
body { margin: 0; padding: 12px; color: CanvasText; background: Canvas; }
html { overflow: auto; }
body { overflow-wrap: anywhere; }
a { display: inline-flex; align-items: center; min-height: 44px; color: LinkText; overflow-wrap: anywhere; text-underline-offset: 3px; }
a:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; border-radius: 8px; }
img, video, audio, iframe, object, embed, form, input, button { display: none !important; }
</style>
</head><body>${props.suggestions.join('\n')}</body></html>`)
const frameHeight = computed(() => Math.min(280, 48 + props.suggestions.length * 48))
</script>

<style scoped>
.agent-search-suggestions {
  margin-block-start: var(--wiki-space-3);
  min-width: 0;
  overflow: auto;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-raised);
}
.agent-search-suggestions header {
  display: flex;
  min-height: 44px;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-2) var(--wiki-space-3);
  border-block-end: 1px solid var(--wiki-surface-border);
  color: var(--wiki-text-muted);
  font-size: .85rem;
}
.agent-search-suggestions header strong { color: rgb(var(--v-theme-on-surface)); }
.agent-search-suggestions header span { margin-inline-start: auto; font-size: .8rem; }
.agent-search-suggestions iframe {
  min-width: 0;
  display: block;
  width: 100%;
  border: 0;
  background: var(--wiki-surface-raised);
}
@media (forced-colors: active) {
  .agent-search-suggestions { border-color: CanvasText; background: Canvas; color: CanvasText; }
}
</style>
