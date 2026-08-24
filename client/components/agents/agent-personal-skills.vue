<template>
  <v-dialog v-model="open" max-width="68rem" scrollable :fullscreen="smAndDown">
    <v-card class="agent-personal-skills">
      <v-card-title class="d-flex align-center ga-2">
        <v-icon icon="mdi-file-document-edit-outline" />
        <span>My agent skills</span>
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" aria-label="Close personal skills" @click="open = false" />
      </v-card-title>
      <v-divider />
      <v-card-text class="pa-0">
        <v-row no-gutters class="agent-personal-skills__layout">
          <v-col cols="12" md="4" class="agent-personal-skills__list pa-3">
            <v-btn block color="primary" prepend-icon="mdi-plus" class="mb-3" @click="beginNew">New skill</v-btn>
            <v-progress-linear v-if="loading" indeterminate class="mb-2" />
            <v-list v-if="skills.length > 0" density="compact" nav aria-label="Personal skills">
              <v-list-item
                v-for="skill in skills"
                :key="skill.id"
                :active="editingId === skill.id"
                :title="skill.name"
                :subtitle="skill.description"
                prepend-icon="mdi-file-document-outline"
                @click="edit(skill)"
              />
            </v-list>
            <v-alert v-else-if="!loading" type="info" variant="tonal" density="compact">Create a SKILL.md document to give the agent reusable instructions.</v-alert>
          </v-col>
          <v-col cols="12" md="8" class="pa-4">
            <v-alert v-if="error" type="error" variant="tonal" density="compact" closable class="mb-4" @click:close="error = ''">{{ error }}</v-alert>
            <div class="d-flex align-center ga-2 mb-3">
              <h3 class="text-headline-small">{{ editingId ? `Edit ${name}` : 'Create a personal skill' }}</h3>
              <v-spacer />
              <v-btn v-if="editingId" color="error" variant="text" prepend-icon="mdi-delete-outline" @click="removing = selectedSkill">Remove</v-btn>
            </div>
            <v-text-field
              v-model.trim="name"
              label="Skill name"
              :disabled="Boolean(editingId) || saving"
              hint="Lowercase letters, numbers, and single hyphens; the name cannot be changed later."
              persistent-hint
              maxlength="64"
              autocomplete="off"
              class="mb-3"
            />
            <v-textarea
              v-model="skillMarkdown"
              label="SKILL.md"
              hint="YAML frontmatter must include this exact name and a description. Remote resources, active content, and likely secrets are rejected."
              persistent-hint
              rows="18"
              max-rows="30"
              counter="65536"
              class="agent-personal-skills__editor"
              :disabled="saving"
              spellcheck="false"
            />
          </v-col>
        </v-row>
      </v-card-text>
      <v-divider />
      <v-card-actions>
        <span class="text-body-small text-medium-emphasis px-2">Personal skills are untrusted reference material and cannot grant agent permissions.</span>
        <v-spacer />
        <v-btn @click="open = false">Close</v-btn>
        <v-btn color="primary" :loading="saving" :disabled="!name || !skillMarkdown" @click="save">{{ editingId ? 'Save revision' : 'Create skill' }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog :model-value="removing !== null" max-width="32rem" @update:model-value="value => { if (!value) removing = null }">
    <v-card title="Remove personal skill?">
      <v-card-text><strong>{{ removing?.name }}</strong> will no longer be available for new selection. Existing session pins and run history remain intact.</v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="removing = null">Cancel</v-btn>
        <v-btn color="error" :loading="saving" @click="remove">Remove</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useDisplay } from 'vuetify'
import {
  createPersonalAgentSkill,
  listPersonalAgentSkills,
  removePersonalAgentSkill,
  updatePersonalAgentSkill,
  type PersonalAgentSkill
} from '../../helpers/agents-api.ts'

const props = defineProps<{ csrfToken: string }>()
const emit = defineEmits<{ changed: [] }>()
const open = defineModel<boolean>({ required: true })
const { smAndDown } = useDisplay()
const skills = ref<PersonalAgentSkill[]>([])
const editingId = ref<string | null>(null)
const name = ref('my-skill')
const skillMarkdown = ref('')
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const removing = ref<PersonalAgentSkill | null>(null)
const selectedSkill = computed(() => skills.value.find(skill => skill.id === editingId.value) ?? null)
const fetcher = window.fetch.bind(window)

const templateFor = (skillName: string): string => `---\nname: ${skillName}\ndescription: Explain when the agent should use this skill.\n---\n# Instructions\n\nDescribe the steps, constraints, and expected output.\n`

const beginNew = (): void => {
  editingId.value = null
  name.value = 'my-skill'
  skillMarkdown.value = templateFor(name.value)
  error.value = ''
}
const edit = (skill: PersonalAgentSkill): void => {
  editingId.value = skill.id
  name.value = skill.name
  skillMarkdown.value = skill.skillMarkdown
  error.value = ''
}
const load = async (selectedId?: string): Promise<void> => {
  loading.value = true
  error.value = ''
  try {
    skills.value = await listPersonalAgentSkills(fetcher, props.csrfToken)
    const selected = skills.value.find(skill => skill.id === selectedId) ?? skills.value.find(skill => skill.id === editingId.value)
    if (selected) edit(selected)
    else if (!editingId.value) beginNew()
    else beginNew()
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Personal skills could not be loaded.'
  } finally {
    loading.value = false
  }
}
const save = async (): Promise<void> => {
  if (saving.value || !name.value || !skillMarkdown.value) return
  saving.value = true
  error.value = ''
  try {
    const current = selectedSkill.value
    const saved = current
      ? await updatePersonalAgentSkill(fetcher, props.csrfToken, current.id, { expectedVersionId: current.versionId, skillMarkdown: skillMarkdown.value })
      : await createPersonalAgentSkill(fetcher, props.csrfToken, { name: name.value, skillMarkdown: skillMarkdown.value })
    editingId.value = saved.id
    await load(saved.id)
    emit('changed')
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Personal skill could not be saved.'
  } finally {
    saving.value = false
  }
}
const remove = async (): Promise<void> => {
  const skill = removing.value
  if (!skill || saving.value) return
  saving.value = true
  error.value = ''
  try {
    await removePersonalAgentSkill(fetcher, props.csrfToken, skill.id, skill.versionId)
    removing.value = null
    editingId.value = null
    await load()
    emit('changed')
  } catch (caught) {
    removing.value = null
    error.value = caught instanceof Error ? caught.message : 'Personal skill could not be removed.'
  } finally {
    saving.value = false
  }
}

watch(name, (next, previous) => {
  if (editingId.value || next === previous) return
  skillMarkdown.value = skillMarkdown.value.replace(/^name:\s*.*$/m, `name: ${next}`)
})
watch(open, value => { if (value) void load() })
</script>

<style scoped>
.agent-personal-skills__layout { min-height: min(38rem, 75dvh); }
.agent-personal-skills__list {
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 94%, rgb(var(--v-theme-primary)) 6%);
  border-inline-end: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.agent-personal-skills__editor :deep(textarea) { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.5; }
@media (max-width: 959px) {
  .agent-personal-skills__layout { min-height: 0; }
  .agent-personal-skills__list {
    max-height: 14rem;
    overflow-y: auto;
    border-inline-end: 0;
    border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }
}
</style>
