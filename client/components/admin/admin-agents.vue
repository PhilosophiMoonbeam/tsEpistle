<template lang="pug">
v-container.admin-agents(fluid)
  AgentAdmin(:csrf-token='csrfToken' embedded)
</template>

<script setup lang="ts">
import AgentAdmin from '../agents/agent-admin.vue'

const csrfToken = siteConfig.agentCsrfToken
</script>

<style lang="scss" scoped>
.admin-agents.v-container {
  width: min(100%, var(--wiki-shell-max)) !important;
  max-width: var(--wiki-shell-max);
  margin-inline: auto;
  padding: var(--wiki-space-5) var(--wiki-page-gutter) var(--wiki-space-12) !important;
}

@media (max-width: 959px) {
  .admin-agents.v-container {
    padding-block: var(--wiki-space-4) var(--wiki-space-10) !important;
  }
}
</style>
