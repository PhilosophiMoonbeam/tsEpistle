<template>
  <v-expansion-panels variant="accordion" class="mb-4">
    <v-expansion-panel>
      <v-expansion-panel-title>Session configuration</v-expansion-panel-title>
      <v-expansion-panel-text>
        <v-alert v-if="disabled" type="info" variant="tonal" density="compact" class="mb-3">Configuration cannot change during the active run.</v-alert>
        <template v-if="profiles.length > 1">
          <v-select v-model="profileId" :items="profileItems" label="Provider profile" :disabled="disabled" />
          <v-btn color="primary" variant="tonal" :disabled="disabled || !profileChanged" @click="applyProfile">Apply provider</v-btn>
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
watch(() => props.session, session => { profileId.value = session.providerProfileId })
const defaultProfile = computed(() => props.profiles.find(profile => profile.isGlobalDefault) ?? props.profiles[0])
const profileItems = computed(() => [
  { title: defaultProfile.value ? `Default · ${defaultProfile.value.name} · ${defaultProfile.value.model}` : 'Use current default', value: null },
  ...props.profiles.filter(profile => !profile.isGlobalDefault).map(profile => ({ title: `${profile.name} · ${profile.model}`, value: profile.id }))
])
const profileChanged = computed(() => profileId.value !== props.session.providerProfileId)
const applyProfile = () => emit('profile', profileId.value)
</script>
