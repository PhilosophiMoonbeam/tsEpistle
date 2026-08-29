<template lang="pug">
v-container.admin-agents(fluid)
  AgentAdmin(:csrf-token='csrfToken' embedded)
</template>

<script setup lang="ts">
import AgentAdmin from '../agents/agent-admin.vue'

const csrfToken = siteConfig.agentCsrfToken
</script>

<style scoped>
.admin-agents {
  max-width: 120rem;
  padding-top: clamp(1rem, 2.5vw, 2rem);
}
</style>
