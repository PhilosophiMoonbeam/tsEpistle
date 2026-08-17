<template>
  <div class="agent-markdown" v-html="rendered" />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { renderSafeAgentMarkdown } from '../../helpers/agent-markdown.ts'

const props = defineProps<{ content: string }>()
const rendered = computed(() => renderSafeAgentMarkdown(props.content))
</script>

<style scoped>
.agent-markdown :deep(pre) { overflow-x: auto; padding: .75rem; border: 1px solid rgb(var(--v-theme-outline)); border-radius: .5rem; }
.agent-markdown :deep(p:last-child) { margin-bottom: 0; }
.agent-markdown :deep(a) { overflow-wrap: anywhere; }
</style>
