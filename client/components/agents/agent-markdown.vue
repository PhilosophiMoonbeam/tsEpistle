<template>
  <div class="agent-markdown" v-html="rendered" />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AgentCitation } from '../../../shared/agents/contracts.ts'
import { renderSafeMarkdown } from '../../helpers/safe-markdown.ts'
import { formatAgentCitationMarkers } from './agent-citations.ts'

const props = withDefaults(defineProps<{ content: string, citations?: readonly AgentCitation[] }>(), {
  citations: () => []
})
const rendered = computed(() => {
  const html = renderSafeMarkdown(formatAgentCitationMarkers(props.content, props.citations))
  return html
    .replace(/<pre(?=>|\s)/g, '<pre tabindex="0" aria-label="Scrollable code block"')
    .replace(/<table(?=>|\s)/g, '<table tabindex="0" aria-label="Scrollable table"')
    .replace(/<a(?=[^>]*\btarget=["']_blank["'])([^>]*)>/g, '<a$1><span class="agent-markdown__new-window"> (opens in a new tab)</span>')
})
</script>

<style scoped>
.agent-markdown {
  color: rgb(var(--v-theme-on-surface));
  min-width: 0;
  overflow-wrap: anywhere;
}
.agent-markdown :deep(pre) {
  max-width: 100%;
  overflow: auto;
  padding: .75rem;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 16%, transparent);
  border-radius: .5rem;
  white-space: pre;
}
.agent-markdown :deep(pre:focus-visible),
.agent-markdown :deep(table:focus-visible) {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
.agent-markdown :deep(table) {
  display: block;
  max-width: 100%;
  min-width: 100%;
  overflow-x: auto;
  width: max-content;
}
.agent-markdown :deep(th),
.agent-markdown :deep(td) { min-width: 8rem; }
.agent-markdown :deep(h1) { font-size: 1.35rem; line-height: 1.25; margin: 1.25rem 0 .6rem; }
.agent-markdown :deep(h2) { font-size: 1.2rem; line-height: 1.3; margin: 1.1rem 0 .55rem; }
.agent-markdown :deep(h3) { font-size: 1.08rem; line-height: 1.35; margin: 1rem 0 .5rem; }
.agent-markdown :deep(h4),
.agent-markdown :deep(h5),
.agent-markdown :deep(h6) { font-size: 1rem; line-height: 1.4; margin: .85rem 0 .4rem; }
.agent-markdown :deep(p:last-child) { margin-bottom: 0; }
.agent-markdown :deep(a) { overflow-wrap: anywhere; }
.agent-markdown :deep(.agent-markdown__new-window) {
  block-size: 1px;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  inline-size: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
}
.agent-markdown :deep(a[title^='Citation ']) {
  align-items: center;
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 16%, rgb(var(--v-theme-surface)));
  border-radius: 999px;
  color: rgb(var(--v-theme-on-surface));
  display: inline-flex;
  font-size: .72rem;
  font-weight: 700;
  justify-content: center;
  line-height: 1;
  margin-inline: .18rem .08rem;
  min-height: 1.25rem;
  min-width: 1.25rem;
  padding: .15rem .35rem;
  text-decoration: none;
  vertical-align: .12em;
}
.agent-markdown :deep(a[title^='Citation ']:focus-visible) { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 2px; }
</style>
