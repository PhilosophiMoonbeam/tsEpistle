<template lang="pug">
v-container.admin-agents(fluid)
  v-row
    v-col(cols='12')
      .admin-header
        img.animated.fadeInUp(src='/_assets/svg/icon-chat-bubble.svg' alt='Agents' style='width: 80px;')
        .admin-header-title
          #admin-title.text-headline-medium.text-primary.animated.fadeInLeft {{$t('admin:agents.title')}}
          .text-body-large.text-grey.animated.fadeInLeft.wait-p2s {{$t('admin:agents.subtitle')}}
      AgentAdmin.animated.fadeInUp.wait-p2s(:csrf-token='csrfToken' embedded)
</template>

<script setup lang="ts">
import AgentAdmin from '../agents/agent-admin.vue'

const csrfToken = siteConfig.agentCsrfToken
</script>

<style scoped>
.admin-agents { max-width: 120rem; }
</style>
