<template>
  <v-expansion-panels variant="accordion" class="mb-4">
    <v-expansion-panel>
      <v-expansion-panel-title>
        <span>Session configuration</span>
        <span class="agent-session-settings__profile">{{ profileSummary }}</span>
        <v-chip v-if="profileChanged" size="x-small" color="warning" variant="tonal">Unsaved</v-chip>
      </v-expansion-panel-title>
      <v-expansion-panel-text>
        <v-alert v-if="disabled" type="info" variant="tonal" density="compact" class="mb-3">Configuration cannot change while this session has an active run or open durable goal.</v-alert>
        <template v-if="profiles.length > 1">
          <v-select v-model="profileId" :items="profileItems" label="Provider profile" :disabled="disabled || applying" />
          <v-btn color="primary" variant="tonal" :loading="applying" :disabled="disabled || applying || !profileChanged" @click="applyProfile">Apply provider</v-btn>
          <p v-if="applying" class="agent-session-settings__status" role="status" aria-live="polite">Applying provider profile…</p>
        </template>
      </v-expansion-panel-text>
    </v-expansion-panel>
  </v-expansion-panels>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentProviderProfileView, AgentSessionView } from '../../../shared/agents/contracts.ts'
const props = defineProps<{ session: AgentSessionView; profiles: AgentProviderProfileView[]; disabled: boolean }>()
const emit = defineEmits<{ profile: [profileId: string | null] }>()
const profileId = ref<string | null>(props.session.providerProfileId)
const applying = ref(false)
watch(() => props.session, session => {
  profileId.value = session.providerProfileId
  applying.value = false
})
const defaultProfile = computed(() => props.profiles.find(profile => profile.isGlobalDefault) ?? props.profiles[0])
const effectiveProfile = computed(() => profileId.value
  ? props.profiles.find(profile => profile.id === profileId.value)
  : defaultProfile.value)
const profileSummary = computed(() => effectiveProfile.value
  ? `${effectiveProfile.value.name} · ${effectiveProfile.value.model}`
  : 'Current default')
const profileItems = computed(() => [
  { title: defaultProfile.value ? `Default · ${defaultProfile.value.name} · ${defaultProfile.value.model}` : 'Use current default', value: null },
  ...props.profiles.filter(profile => !profile.isGlobalDefault).map(profile => ({ title: `${profile.name} · ${profile.model}`, value: profile.id }))
])
const profileChanged = computed(() => profileId.value !== props.session.providerProfileId)
const applyProfile = () => {
  if (props.disabled || applying.value || !profileChanged.value) return
  applying.value = true
  emit('profile', profileId.value)
}
</script>
<style scoped>
.agent-session-settings__profile {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: .8rem;
  margin-inline-start: .5rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-session-settings__status {
  color: rgb(var(--v-theme-primary));
  font-size: .8rem;
  margin: .5rem 0 0;
}
@media (max-width: 600px) {
  .agent-session-settings__profile { max-width: 10rem; }
}
</style>
