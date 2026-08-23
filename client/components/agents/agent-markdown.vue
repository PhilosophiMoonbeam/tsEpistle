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
const rendered = computed(() => renderSafeMarkdown(formatAgentCitationMarkers(props.content, props.citations)))
</script>

<style scoped>
.agent-markdown :deep(pre) { overflow-x: auto; padding: .75rem; border: 1px solid rgb(var(--v-theme-outline)); border-radius: .5rem; }
.agent-markdown :deep(p:last-child) { margin-bottom: 0; }
.agent-markdown :deep(a) { overflow-wrap: anywhere; }
.agent-markdown :deep(a[title^='Citation ']) {
  align-items: center;
  background: rgb(var(--v-theme-primary-container));
  border-radius: 999px;
  color: rgb(var(--v-theme-on-primary-container));
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
