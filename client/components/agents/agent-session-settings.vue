<template>
  <v-expansion-panels variant="accordion" class="mb-4">
    <v-expansion-panel>
      <v-expansion-panel-title>Session configuration</v-expansion-panel-title>
      <v-expansion-panel-text>
        <v-alert v-if="disabled" type="info" variant="tonal" density="compact" class="mb-3">Configuration is pinned for the active run.</v-alert>
        <v-row>
          <v-col cols="12" md="7">
            <v-select v-model="profileId" :items="profileItems" label="Provider profile" :disabled="disabled" />
          </v-col>
          <v-col cols="12" md="5">
            <v-select v-model="mode" :items="modeItems" label="How this session uses the model" :disabled="disabled || modeItems.length === 1" />
          </v-col>
        </v-row>
        <v-alert v-if="mode === 'generation-only'" type="info" variant="tonal" density="compact" class="mb-3">
          Text generation does not receive or call Wiki actions. The result is unverified model text.
        </v-alert>
        <v-btn color="primary" variant="tonal" :disabled="disabled || !profileChanged" @click="applyProfile">Apply provider and mode</v-btn>
        <v-divider class="my-5" />
        <v-select
          v-model="skillVersionIds"
          :items="skillItems"
          label="Approved skills"
          multiple
          chips
          closable-chips
          :disabled="disabled"
          hint="Skills add approved instructions; they do not grant tools or page permissions."
          persistent-hint
        />
        <v-btn class="mt-3" color="primary" variant="tonal" :disabled="disabled || !skillsChanged" @click="applySkills">Apply skills</v-btn>
        <v-list v-if="session.skills.length" class="mt-4" density="compact" aria-label="Pinned skill provenance">
          <v-list-item v-for="skill in session.skills" :key="skill.versionId" :title="skill.name" :subtitle="`${skill.sourcePath} · ${skill.contentHash.slice(0, 12)} · version ${skill.versionId}`">
            <template #append><v-chip :color="skill.drifted ? 'warning' : 'success'" size="small">{{ skill.drifted ? 'New version available' : 'Pinned exact version' }}</v-chip></template>
          </v-list-item>
        </v-list>
      </v-expansion-panel-text>
    </v-expansion-panel>
  </v-expansion-panels>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentProviderProfileView, AgentSessionView } from '../../../shared/agents/contracts.ts'
import type { VisibleAgentSkill } from '../../helpers/agents-api.ts'
const props = defineProps<{ session: AgentSessionView; profiles: AgentProviderProfileView[]; skills: VisibleAgentSkill[]; disabled: boolean }>()
const emit = defineEmits<{ profile: [profileId: string | null, mode: 'agent' | 'generation-only']; skills: [versionIds: string[]] }>()
const profileId = ref<string | null>(props.session.providerProfileId)
const mode = ref<'agent' | 'generation-only'>(props.session.executionMode)
const skillVersionIds = ref(props.session.skills.map(skill => skill.versionId))
watch(() => props.session, session => { profileId.value = session.providerProfileId; mode.value = session.executionMode; skillVersionIds.value = session.skills.map(skill => skill.versionId) })
const profileItems = computed(() => [{ title: 'Use current default', value: null }, ...props.profiles.map(profile => ({ title: `${profile.name} · ${profile.model}`, value: profile.id }))])
const selectedProfile = computed(() => profileId.value === null ? props.profiles.find(profile => profile.isGlobalDefault) : props.profiles.find(profile => profile.id === profileId.value))
const modeItems = computed(() => (selectedProfile.value?.executionModes ?? ['generation-only']).map(value => ({ title: value === 'agent' ? 'Agent — Wiki actions available' : 'Text generation — no Wiki actions', value })))
watch(selectedProfile, profile => { if (profile && !profile.executionModes.includes(mode.value)) mode.value = 'generation-only' })
const skillItems = computed(() => props.skills.map(skill => ({ title: `${skill.name} · ${skill.description}`, value: skill.versionId })))
const profileChanged = computed(() => profileId.value !== props.session.providerProfileId || mode.value !== props.session.executionMode)
const skillsChanged = computed(() => JSON.stringify(skillVersionIds.value) !== JSON.stringify(props.session.skills.map(skill => skill.versionId)))
const applyProfile = () => emit('profile', profileId.value, mode.value)
const applySkills = () => emit('skills', [...skillVersionIds.value])
</script>
