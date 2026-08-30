<template lang="pug">
v-container.admin-agents(fluid)
  AgentAdmin(v-if='agentsEnabled' :csrf-token='csrfToken' embedded)
  section.admin-agents__disabled(v-else aria-labelledby='agents-disabled-title')
    .admin-agents__disabled-mark
      v-icon(size='28') mdi-robot-off-outline
    .admin-agents__disabled-copy
      .admin-agents__eyebrow Deployment feature control
      h1#agents-disabled-title(tabindex='-1') Agents are not enabled
      p This deployment has the Agent feature turned off. Provider profiles and browser targets remain unavailable until an operator enables the Agent feature and restarts Wiki.
      v-alert(type='info' variant='tonal' density='compact' icon='mdi-cog-refresh-outline') Enable the Agent deployment setting through the normal configuration rollout. This page cannot override a deployment kill switch.
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

.admin-agents__disabled {
  display: grid;
  max-width: 48rem;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--wiki-space-4);
  margin: var(--wiki-space-8) auto 0;
  padding: var(--wiki-space-6);
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-sm), var(--wiki-shadow-inset);
}

.admin-agents__disabled-mark {
  display: grid;
  width: calc(var(--wiki-control-height) + var(--wiki-space-2));
  height: calc(var(--wiki-control-height) + var(--wiki-space-2));
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--wiki-ambient-accent) 28%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--wiki-ambient-accent) 10%, var(--wiki-surface-raised));
  color: var(--wiki-accent-warm);
}

.admin-agents__disabled-copy {
  min-width: 0;
}

.admin-agents__eyebrow {
  color: var(--wiki-accent-warm);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .1em;
  text-transform: uppercase;
}

.admin-agents__disabled h1 {
  margin: var(--wiki-space-1) 0 var(--wiki-space-2);
  font-family: var(--wiki-font-heading);
  font-size: clamp(1.65rem, 4vw, 2.35rem);
  line-height: var(--wiki-leading-heading);
}

.admin-agents__disabled p {
  margin: 0 0 var(--wiki-space-4);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 70%, transparent);
  line-height: 1.55;
}

@media (max-width: 600px) {
  .admin-agents__disabled {
    grid-template-columns: minmax(0, 1fr);
    margin-block-start: var(--wiki-space-3);
    padding: var(--wiki-space-4);
  }
}
</style>
