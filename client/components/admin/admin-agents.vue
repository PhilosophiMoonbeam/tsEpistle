<template lang="pug">
v-container.admin-agents(fluid)
  AgentAdmin(v-if='agentsEnabled' :csrf-token='csrfToken' embedded)
  section.admin-agents__disabled(v-else aria-labelledby='agents-disabled-title')
    AdminHero(
      title='Agents are not enabled'
      description='This deployment has the Agent feature turned off. Provider profiles and browser targets remain unavailable until an operator enables the Agent feature and restarts Wiki.'
      icon='mdi-robot-off-outline'
      eyebrow='Deployment feature control'
      heading-id='agents-disabled-title'
    )
      template(#status)
        v-chip(color='warning' variant='tonal' size='small' prepend-icon='mdi-pause-circle-outline') Feature disabled
    v-alert.admin-agents__disabled-note(type='info' variant='tonal' density='compact' icon='mdi-cog-refresh-outline') Enable the Agent deployment setting through the normal configuration rollout. This page cannot override a deployment kill switch.
</template>

<script setup lang="ts">
import AgentAdmin from '../agents/agent-admin.vue'

const csrfToken = siteConfig.agentCsrfToken
const agentsEnabled = siteConfig.agentsEnabled
</script>

<style lang="scss" scoped>
.admin-agents.v-container {
  width: min(100%, var(--wiki-shell-max)) !important;
  max-width: var(--wiki-shell-max);
  margin-inline: auto;
  padding: var(--wiki-space-5) var(--wiki-page-gutter) calc(var(--wiki-footer-height) + var(--wiki-space-8)) !important;
}

@media (max-width: 959px) {
  .admin-agents.v-container {
    padding-block: var(--wiki-space-4) calc(var(--wiki-footer-height) + var(--wiki-space-8)) !important;
  }
}

.admin-agents__disabled-note {
  max-width: 70ch;
}
</style>
