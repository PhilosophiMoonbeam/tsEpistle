<template>
  <v-expansion-panels variant="accordion" class="mb-4">
    <v-expansion-panel>
      <v-expansion-panel-title>Session configuration</v-expansion-panel-title>
      <v-expansion-panel-text>
        <v-alert v-if="disabled" type="info" variant="tonal" density="compact" class="mb-3">Configuration is pinned for the active run.</v-alert>
        <template v-if="profiles.length > 1">
          <v-select v-model="profileId" :items="profileItems" label="Provider profile" :disabled="disabled" />
          <v-btn color="primary" variant="tonal" :disabled="disabled || !profileChanged" @click="applyProfile">Apply provider</v-btn>
          <v-divider class="my-5" />
        </template>
        <template v-if="skillsEnabled">
          <v-select
            v-model="skillVersionIds"
            :items="skillItems"
            label="Pinned skills (always loaded)"
            multiple
            chips
            closable-chips
            :disabled="disabled"
            hint="Pinned skills are always loaded. The agent also sees your visible skill catalog and loads relevant skills before acting. Skills never grant tools or page permissions."
            persistent-hint
          />
          <v-btn class="mt-3" color="primary" variant="tonal" :disabled="disabled || !skillsChanged" @click="applySkills">Apply skills</v-btn>
          <v-list v-if="session.skills.length" class="mt-4" density="compact" aria-label="Pinned skill provenance">
            <v-list-item v-for="skill in session.skills" :key="skill.versionId" :title="skill.name" :subtitle="`${skill.sourcePath} · ${skill.contentHash.slice(0, 12)} · version ${skill.versionId}`">
              <template #append><v-chip :color="skill.drifted ? 'warning' : 'success'" size="small">{{ skill.drifted ? 'New version available' : 'Pinned exact version' }}</v-chip></template>
            </v-list-item>
          </v-list>
        </template>
      </v-expansion-panel-text>
    </v-expansion-panel>
  </v-expansion-panels>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentProviderProfileView, AgentSessionView } from '../../../shared/agents/contracts.ts'
import type { VisibleAgentSkill } from '../../helpers/agents-api.ts'
const props = defineProps<{ session: AgentSessionView; profiles: AgentProviderProfileView[]; skills: VisibleAgentSkill[]; skillsEnabled: boolean; disabled: boolean }>()
const emit = defineEmits<{ profile: [profileId: string | null]; skills: [versionIds: string[]] }>()
const profileId = ref<string | null>(props.session.providerProfileId)
const skillVersionIds = ref(props.session.skills.map(skill => skill.versionId))
watch(() => props.session, session => { profileId.value = session.providerProfileId; skillVersionIds.value = session.skills.map(skill => skill.versionId) })
const defaultProfile = computed(() => props.profiles.find(profile => profile.isGlobalDefault) ?? props.profiles[0])
const profileItems = computed(() => [
  { title: defaultProfile.value ? `Default · ${defaultProfile.value.name} · ${defaultProfile.value.model}` : 'Use current default', value: null },
  ...props.profiles.filter(profile => !profile.isGlobalDefault).map(profile => ({ title: `${profile.name} · ${profile.model}`, value: profile.id }))
])
const skillItems = computed(() => props.skills.map(skill => ({ title: `${skill.name} · ${skill.description}`, value: skill.versionId })))
const profileChanged = computed(() => profileId.value !== props.session.providerProfileId)
const skillsChanged = computed(() => JSON.stringify(skillVersionIds.value) !== JSON.stringify(props.session.skills.map(skill => skill.versionId)))
const applyProfile = () => emit('profile', profileId.value)
const applySkills = () => emit('skills', [...skillVersionIds.value])
</script>
