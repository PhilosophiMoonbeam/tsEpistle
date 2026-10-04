<template lang="pug">
v-container.admin-agents(fluid)
  AgentAdmin(v-if='agentsEnabled' :csrf-token='csrfToken' embedded)
  section.admin-agents__disabled(v-else aria-labelledby='agents-disabled-title')
    header.admin-agents__disabled-header
      v-icon(icon='mdi-robot-off-outline' aria-hidden='true')
      div
        h1#agents-disabled-title {{ $t(`admin:agents.agentsNotEnabled`) }}
        p {{ $t(`admin:agents.deploymentHasAgentFeature`) }}
      v-chip(color='warning' variant='tonal' size='small' prepend-icon='mdi-pause-circle-outline') {{ $t(`admin:agents.featureDisabled`) }}
    v-alert.admin-agents__disabled-note(type='info' variant='tonal' density='compact' icon='mdi-cog-refresh-outline') {{ $t(`admin:agents.enableAgentDeploymentSetting`) }}
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

.admin-agents__disabled-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--wiki-space-4);
  padding: var(--wiki-space-4);
  margin-block-end: var(--wiki-space-4);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  h1 { margin: 0; font: 700 1.4rem/1.4 var(--wiki-font-heading); }
  p { margin-block: var(--wiki-space-2) 0; color: var(--wiki-text-muted); }
  > div { min-width: 0; flex: 1 1 18rem; }
}
</style>
