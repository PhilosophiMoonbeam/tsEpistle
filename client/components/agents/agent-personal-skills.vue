<template>
  <v-dialog v-model="open" max-width="72rem" scrollable :fullscreen="smAndDown" @update:model-value="value => { if (!value && isDirty) { open = true; requestClose() } }">
    <v-card class="personal-skills">
      <header class="personal-skills__header">
        <span class="personal-skills__mark" aria-hidden="true"><v-icon icon="mdi-account-star-outline" size="23" /></span>
        <div class="personal-skills__heading">
          <div class="personal-skills__eyebrow">Personal customization</div>
          <h2>My skill library</h2>
          <p>Curate instructions for your own Agent experience without changing organization policy.</p>
        </div>
        <div class="personal-skills__header-state">
          <v-chip size="small" variant="tonal" prepend-icon="mdi-account-lock-outline">Owner only</v-chip>
          <v-chip v-if="loaded" size="small" variant="outlined">{{ skills.length }} skill{{ skills.length === 1 ? '' : 's' }}</v-chip>
        </div>
        <v-btn icon="mdi-close" variant="text" aria-label="Close personal skills" @click="requestClose" />
      </header>

      <div class="personal-skills__boundary">
        <v-icon icon="mdi-shield-outline" size="19" />
        <span><strong>Personal layer</strong> Your skills are untrusted reference material. They can guide the Agent, but cannot grant permissions or override organization safeguards.</span>
      </div>

      <v-card-text class="personal-skills__body">
        <div class="personal-skills__layout">
          <aside class="personal-inventory" aria-labelledby="personal-inventory-title">
            <div class="personal-inventory__header">
              <div>
                <div class="personal-skills__eyebrow">Your inventory</div>
                <h3 id="personal-inventory-title">Installed skills</h3>
              </div>
              <v-btn color="primary" prepend-icon="mdi-plus" size="small" :disabled="loading || saving" @click="requestNew">New skill</v-btn>
            </div>

            <v-text-field
              v-model="search"
              class="personal-inventory__search"
              label="Search personal skills"
              prepend-inner-icon="mdi-magnify"
              clearable
              hide-details
              density="comfortable"
            />

            <v-alert v-if="error && !loaded" class="personal-inventory__error" type="error" variant="tonal" density="compact">
              {{ error }}
              <template #append><v-btn variant="text" size="small" @click="load()">Retry</v-btn></template>
            </v-alert>

            <div v-if="loading && !loaded" class="personal-inventory__loading" aria-label="Loading personal skills" aria-busy="true">
              <v-skeleton-loader v-for="index in 4" :key="index" type="list-item-avatar-two-line" />
            </div>

            <template v-else-if="loaded">
              <div class="personal-inventory__summary" aria-live="polite">{{ filteredSkills.length }} of {{ skills.length }} shown</div>
              <v-list v-if="filteredSkills.length" class="personal-inventory__list" density="compact" nav aria-label="Personal skills">
                <v-list-item
                  v-for="skill in filteredSkills"
                  :key="skill.id"
                  class="personal-skill-item"
                  :active="editingId === skill.id"
                  :aria-current="editingId === skill.id ? 'true' : undefined"
                  :aria-label="`Edit personal skill ${skill.name}`"
                  rounded="lg"
                  @click="requestEdit(skill)"
                >
                  <template #prepend>
                    <span class="personal-skill-item__icon"><v-icon icon="mdi-file-document-outline" size="18" /></span>
                  </template>
                  <v-list-item-title>{{ skill.name }}</v-list-item-title>
                  <v-list-item-subtitle>{{ skill.description || 'No description in frontmatter' }}</v-list-item-subtitle>
                  <template #append>
                    <span class="personal-skill-item__append">
                      <span class="personal-skill-item__mode" :title="skill.isAgentDiscoverable ? 'Available to the Agent automatically' : 'Only available by explicit invocation'">
                        <v-icon :icon="skill.isAgentDiscoverable ? 'mdi-radar' : 'mdi-hand-back-right-outline'" size="16" />
                        {{ skill.isAgentDiscoverable ? 'Auto' : 'On request' }}
                      </span>
                      <v-icon icon="mdi-pencil-outline" size="16" aria-hidden="true" />
                    </span>
                  </template>
                </v-list-item>
              </v-list>

              <div v-else-if="skills.length" class="personal-inventory__empty">
                <v-icon icon="mdi-text-search" size="24" />
                <strong>No matching personal skills</strong>
                <span>Try another name or description.</span>
                <v-btn size="small" variant="text" @click="search = ''">Clear search</v-btn>
              </div>

              <div v-else class="personal-inventory__empty">
                <v-icon icon="mdi-file-document-plus-outline" size="28" />
                <strong>Your personal layer is empty</strong>
                <span>Create a SKILL.md document for a repeatable workflow or preference.</span>
                <v-btn size="small" color="primary" variant="tonal" prepend-icon="mdi-plus" @click="requestNew">Create first skill</v-btn>
              </div>
            </template>
          </aside>

          <main v-if="loaded" class="personal-editor" aria-labelledby="personal-editor-title">
            <div class="personal-editor__header">
              <div>
                <div class="personal-skills__eyebrow">{{ editingId ? 'Installed personal skill' : 'New personal skill' }}</div>
                <h3 id="personal-editor-title">{{ editingId ? name : 'Create a personal skill' }}</h3>
                <p>{{ editingId ? 'Edit the current personal revision and how the Agent discovers it.' : 'Write reusable instructions scoped only to your account.' }}</p>
              </div>
              <div class="personal-editor__header-actions">
                <v-chip v-if="isDirty" color="warning" size="small" variant="tonal" prepend-icon="mdi-circle-edit-outline">Unsaved</v-chip>
                <v-btn v-if="editingId" color="error" variant="text" prepend-icon="mdi-delete-outline" :disabled="saving" @click="removing = selectedSkill">Remove skill</v-btn>
              </div>
            </div>

            <v-alert v-if="error" class="personal-editor__error" type="error" variant="tonal" closable @click:close="error = ''">{{ error }}</v-alert>
            <v-progress-linear v-if="loading" indeterminate aria-label="Refreshing personal skills" />

            <v-form id="personal-skill-form" class="personal-editor__form" @submit.prevent="save">
              <section class="personal-editor-section" aria-labelledby="personal-skill-details-title">
                <div class="personal-editor-section__heading">
                  <span><v-icon icon="mdi-card-account-details-outline" size="19" /></span>
                  <div><h4 id="personal-skill-details-title">Details & enablement</h4><p>Name the skill and decide whether the Agent may discover it automatically.</p></div>
                </div>
                <div class="personal-editor-section__fields">
                  <v-text-field v-model.trim="name" :rules="[nameRule]" label="Skill name" :disabled="Boolean(editingId) || saving" hint="Lowercase letters, numbers, and single hyphens; the name cannot be changed later." persistent-hint maxlength="64" autocomplete="off" />
                  <div class="personal-discovery">
                    <v-switch v-model="isAgentDiscoverable" label="Load automatically when relevant" color="primary" inset hide-details :disabled="saving" />
                    <p>{{ isAgentDiscoverable ? 'The Agent may select this skill when its description matches your request.' : 'Available only when you invoke it with / or the Skills menu.' }}</p>
                  </div>
                </div>

                <dl v-if="selectedSkill" class="personal-provenance">
                  <div><dt>Scope</dt><dd>Personal · owner only</dd></div>
                  <div><dt>Last revised</dt><dd>{{ formatUpdated(selectedSkill.updatedAt) }}</dd></div>
                  <div><dt>Content fingerprint</dt><dd><code :title="selectedSkill.contentHash">{{ shortHash(selectedSkill.contentHash) }}</code></dd></div>
                </dl>
              </section>

              <section class="personal-editor-section personal-editor-section--code" aria-labelledby="personal-skill-code-title">
                <div class="personal-editor-section__heading">
                  <span><v-icon icon="mdi-code-tags" size="19" /></span>
                  <div><h4 id="personal-skill-code-title">SKILL.md source</h4><p>YAML frontmatter declares provenance; the Markdown body contains the instructions.</p></div>
                  <v-chip size="x-small" variant="outlined">Plain text · 64 KiB</v-chip>
                </div>
                <v-textarea v-model="skillMarkdown" label="Exact personal skill source" hint="Frontmatter must include this exact name and a description. Remote resources, active content, and likely secrets are rejected." persistent-hint rows="18" max-rows="30" counter="65536" maxlength="65536" class="personal-editor__code" :disabled="saving" spellcheck="false" :rules="[markdownRule]" />
              </section>
            </v-form>
          </main>
        </div>
      </v-card-text>

      <v-card-actions class="personal-skills__actions">
        <div class="personal-skills__trust-note"><v-icon icon="mdi-account-lock-outline" size="18" /><span>Personal skills affect only your account. Organization policy always takes precedence.</span></div>
        <v-spacer />
        <v-btn @click="requestClose">Close</v-btn>
        <v-btn color="primary" type="submit" :loading="saving" :disabled="!loaded || !formValid" form="personal-skill-form">{{ editingId ? 'Save revision' : 'Create skill' }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog :model-value="removing !== null" max-width="32rem" @update:model-value="value => { if (!value) removing = null }">
    <v-card class="personal-confirmation">
      <div class="personal-confirmation__header personal-confirmation__header--danger"><span><v-icon icon="mdi-delete-alert-outline" size="21" /></span><div><div class="personal-skills__eyebrow">Destructive action</div><h2>Remove personal skill?</h2></div></div>
      <v-card-text>
        <v-alert class="mb-4" type="warning" variant="tonal" icon="mdi-history">Existing run history remains intact.</v-alert>
        <p><strong>{{ removing?.name }}</strong> will be removed from your personal library and can no longer be loaded automatically or invoked.</p>
      </v-card-text>
      <v-card-actions><v-spacer /><v-btn :disabled="saving" @click="removing = null">Cancel</v-btn><v-btn color="error" prepend-icon="mdi-delete-outline" :loading="saving" :disabled="saving" @click="remove">Remove skill</v-btn></v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog v-model="discardOpen" max-width="28rem">
    <v-card class="personal-confirmation">
      <div class="personal-confirmation__header"><span><v-icon icon="mdi-file-alert-outline" size="21" /></span><div><div class="personal-skills__eyebrow">Unsaved draft</div><h2>Discard changes?</h2></div></div>
      <v-card-text>Your current personal skill revision has changes that have not been saved.</v-card-text>
      <v-card-actions><v-spacer /><v-btn @click="discardOpen = false">Continue editing</v-btn><v-btn color="error" variant="tonal" @click="confirmDiscard">Discard changes</v-btn></v-card-actions>
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
const search = ref('')
const editingId = ref<string | null>(null)
const name = ref('my-skill')
const skillMarkdown = ref('')
const isAgentDiscoverable = ref(true)
const loading = ref(false)
const loaded = ref(false)
const saving = ref(false)
const error = ref('')
const removing = ref<PersonalAgentSkill | null>(null)
const discardOpen = ref(false)
const pendingNavigation = ref<(() => void) | null>(null)
const baseline = ref({ name: '', skillMarkdown: '', isAgentDiscoverable: true })
const selectedSkill = computed(() => skills.value.find(skill => skill.id === editingId.value) ?? null)
const filteredSkills = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return skills.value
    .filter(skill => !query || skill.name.toLocaleLowerCase().includes(query) || skill.description.toLocaleLowerCase().includes(query))
    .sort((left, right) => left.name.localeCompare(right.name))
})
const isDirty = computed(() => name.value !== baseline.value.name || skillMarkdown.value !== baseline.value.skillMarkdown || isAgentDiscoverable.value !== baseline.value.isAgentDiscoverable)
const nameRule = (value: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.trim()) || 'Use lowercase letters, numbers, and single hyphens.'
const markdownRule = (value: string) => value.length <= 65536 || 'SKILL.md must be 65,536 characters or fewer.'
const formValid = computed(() => Boolean(name.value.trim() && skillMarkdown.value.trim()) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name.value.trim()) && skillMarkdown.value.length <= 65536)
const fetcher = window.fetch.bind(window)
const updatedAtFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const formatUpdated = (value: string): string => updatedAtFormatter.format(new Date(value))
const shortHash = (value: string): string => value.slice(0, 12)

const templateFor = (skillName: string): string => `---\nname: ${skillName}\ndescription: Explain when the agent should use this skill.\n---\n# Instructions\n\nDescribe the steps, constraints, and expected output.\n`

const setBaseline = (): void => { baseline.value = { name: name.value, skillMarkdown: skillMarkdown.value, isAgentDiscoverable: isAgentDiscoverable.value } }
const applyNew = (): void => {
  editingId.value = null; name.value = 'my-skill'; skillMarkdown.value = templateFor(name.value); isAgentDiscoverable.value = true; error.value = ''; setBaseline()
}
const applyEdit = (skill: PersonalAgentSkill): void => {
  editingId.value = skill.id; name.value = skill.name; skillMarkdown.value = skill.skillMarkdown; isAgentDiscoverable.value = skill.isAgentDiscoverable; error.value = ''; setBaseline()
}
const requestNavigation = (action: () => void): void => {
  if (isDirty.value) { pendingNavigation.value = action; discardOpen.value = true } else action()
}
const requestNew = (): void => requestNavigation(applyNew)
const requestEdit = (skill: PersonalAgentSkill): void => requestNavigation(() => applyEdit(skill))
const requestClose = (): void => requestNavigation(() => { open.value = false })
const confirmDiscard = (): void => {
  discardOpen.value = false
  const action = pendingNavigation.value
  pendingNavigation.value = null
  action?.()
}
const load = async (selectedId?: string): Promise<void> => {
  if (loading.value) return
  loading.value = true; error.value = ''
  try {
    skills.value = await listPersonalAgentSkills(fetcher, props.csrfToken); loaded.value = true
    const selected = skills.value.find(skill => skill.id === selectedId) ?? skills.value.find(skill => skill.id === editingId.value)
    if (selected) applyEdit(selected)
    else applyNew()
  } catch (caught) { error.value = caught instanceof Error ? caught.message : 'Personal skills could not be loaded.' }
  finally { loading.value = false }
}
const save = async (): Promise<void> => {
  if (saving.value || !formValid.value) return
  saving.value = true
  error.value = ''
  try {
    const current = selectedSkill.value
    const saved = current
      ? await updatePersonalAgentSkill(fetcher, props.csrfToken, current.id, { expectedVersionId: current.versionId, skillMarkdown: skillMarkdown.value, isAgentDiscoverable: isAgentDiscoverable.value })
      : await createPersonalAgentSkill(fetcher, props.csrfToken, { name: name.value, skillMarkdown: skillMarkdown.value, isAgentDiscoverable: isAgentDiscoverable.value })
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
.personal-skills {
  --personal-accent: var(--wiki-accent-spectral);

  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius) !important;
  background: var(--wiki-surface-raised) !important;
  color: rgb(var(--v-theme-on-surface));
  box-shadow: var(--wiki-shadow-lg), var(--wiki-shadow-inset) !important;
}

.personal-skills__header {
  display: flex;
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-10));
  align-items: center;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-4) var(--wiki-space-5);
  border-bottom: 1px solid var(--wiki-surface-border);
  background:
    linear-gradient(110deg, color-mix(in srgb, var(--personal-accent) 8%, transparent), transparent 52%),
    var(--wiki-surface-raised);
}

.personal-skills__mark,
.personal-editor-section__heading > span,
.personal-confirmation__header > span {
  display: grid;
  width: var(--wiki-control-height);
  height: var(--wiki-control-height);
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--personal-accent) 22%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--personal-accent) 10%, var(--wiki-surface-raised));
  color: var(--personal-accent);
  box-shadow: var(--wiki-shadow-inset);
}

.personal-skills__heading {
  min-width: 0;
  flex: 1 1 auto;
}

.personal-skills__eyebrow {
  color: var(--personal-accent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .11em;
  text-transform: uppercase;
}

.personal-skills__heading h2 {
  margin: var(--wiki-space-1) 0;
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-heading);
  font-size: 1.2rem;
  font-weight: 740;
  letter-spacing: -.025em;
  line-height: var(--wiki-leading-heading);
}

.personal-skills__heading p {
  margin: 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
  font-size: .78rem;
  line-height: 1.5;
}

.personal-skills__header-state {
  display: flex;
  flex: 0 0 auto;
  gap: var(--wiki-space-2);
}

.personal-skills__boundary {
  display: flex;
  align-items: center;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-3) var(--wiki-space-5);
  border-bottom: 1px solid var(--wiki-surface-border);
  background: color-mix(in srgb, var(--personal-accent) 6%, var(--wiki-surface-sunken));
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
  font-size: .75rem;
  line-height: 1.5;
}

.personal-skills__boundary .v-icon {
  flex: 0 0 auto;
  color: var(--personal-accent);
}

.personal-skills__boundary strong {
  color: rgb(var(--v-theme-on-surface));
}

.personal-skills__body {
  padding: 0 !important;
}

.personal-skills__layout {
  display: grid;
  min-height: min(40rem, 72dvh);
  grid-template-columns: minmax(18rem, 21rem) minmax(0, 1fr);
}

.personal-inventory {
  display: flex;
  min-width: 0;
  flex-direction: column;
  padding: var(--wiki-space-4);
  border-inline-end: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-sunken);
}

.personal-inventory__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--wiki-space-3);
  margin-bottom: var(--wiki-space-3);
}

.personal-inventory__header h3 {
  margin: var(--wiki-space-1) 0 0;
  font-family: var(--wiki-font-heading);
  font-size: .95rem;
  font-weight: 720;
}

.personal-inventory__search {
  margin-bottom: var(--wiki-space-2);
}

.personal-inventory__search :deep(.v-field) {
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-inset);
}

.personal-inventory__error {
  margin-top: var(--wiki-space-3);
}

.personal-inventory__loading {
  display: grid;
  gap: var(--wiki-space-2);
  margin-top: var(--wiki-space-2);
}

.personal-inventory__summary {
  padding: var(--wiki-space-2) var(--wiki-space-2) var(--wiki-space-1);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  font-size: var(--wiki-label-size);
  font-variant-numeric: tabular-nums;
  font-weight: var(--wiki-label-weight);
  letter-spacing: .04em;
  text-transform: uppercase;
}

.personal-inventory__list {
  overflow-y: auto;
  padding: 0;
  background: transparent;
  scrollbar-color: var(--wiki-surface-border-strong) transparent;
}

.personal-skill-item {
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-3));
  margin-block: var(--wiki-space-1);
  border: 1px solid transparent;
  border-radius: var(--wiki-control-radius) !important;
}

.personal-skill-item:hover {
  border-color: var(--wiki-surface-border);
  background: var(--wiki-surface-raised);
}

.personal-skill-item.v-list-item--active {
  border-color: color-mix(in srgb, var(--personal-accent) 32%, var(--wiki-surface-border));
  background: color-mix(in srgb, var(--personal-accent) 9%, var(--wiki-surface-raised));
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);
}

.personal-skill-item__icon {
  display: grid;
  width: calc(var(--wiki-control-height) - var(--wiki-space-3));
  height: calc(var(--wiki-control-height) - var(--wiki-space-3));
  place-items: center;
  border-radius: var(--wiki-radius-xs);
  background: color-mix(in srgb, var(--personal-accent) 9%, transparent);
  color: var(--personal-accent);
}

.personal-skill-item :deep(.v-list-item-title) {
  font-family: var(--wiki-font-mono);
  font-size: .78rem;
  font-weight: 680;
}

.personal-skill-item :deep(.v-list-item-subtitle) {
  margin-top: var(--wiki-space-1);
  font-size: var(--wiki-label-size);
  line-height: 1.35;
}

.personal-skill-item__append {
  display: inline-flex;
  align-items: center;
  gap: var(--wiki-space-2);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 48%, transparent);
}

.personal-skill-item__mode {
  display: inline-flex;
  align-items: center;
  gap: var(--wiki-space-1);
  padding: var(--wiki-space-1) var(--wiki-space-2);
  border-radius: var(--wiki-radius-pill);
  background: color-mix(in srgb, var(--personal-accent) 8%, transparent);
  color: color-mix(in srgb, var(--personal-accent) 84%, rgb(var(--v-theme-on-surface)));
  font-size: var(--wiki-label-size);
  font-weight: 650;
  white-space: nowrap;
}

.personal-inventory__empty {
  display: grid;
  min-height: 15rem;
  place-items: center;
  align-content: center;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-6) var(--wiki-space-4);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 60%, transparent);
  text-align: center;
}

.personal-inventory__empty .v-icon {
  color: var(--personal-accent);
}

.personal-inventory__empty strong {
  color: rgb(var(--v-theme-on-surface));
  font-size: .85rem;
}

.personal-inventory__empty span {
  max-width: 16rem;
  font-size: .72rem;
  line-height: 1.5;
}

.personal-editor {
  min-width: 0;
  background: var(--wiki-surface-raised);
}

.personal-editor__header {
  display: flex;
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-8));
  align-items: center;
  justify-content: space-between;
  gap: var(--wiki-space-4);
  padding: var(--wiki-space-4) var(--wiki-space-5);
  border-bottom: 1px solid var(--wiki-surface-border);
}

.personal-editor__header h3 {
  margin: var(--wiki-space-1) 0;
  overflow-wrap: anywhere;
  font-family: var(--wiki-font-heading);
  font-size: 1.05rem;
  font-weight: 730;
}

.personal-editor__header p {
  margin: 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-size: .75rem;
}

.personal-editor__header-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--wiki-space-2);
}

.personal-editor__error {
  margin: var(--wiki-space-4) var(--wiki-space-5) 0;
}

.personal-editor__form {
  padding: var(--wiki-space-5);
}

.personal-editor-section + .personal-editor-section {
  margin-top: var(--wiki-space-5);
  padding-top: var(--wiki-space-5);
  border-top: 1px solid var(--wiki-surface-border);
}

.personal-editor-section__heading {
  display: flex;
  align-items: flex-start;
  gap: var(--wiki-space-3);
  margin-bottom: var(--wiki-space-4);
}

.personal-editor-section__heading > span {
  width: calc(var(--wiki-control-height) - var(--wiki-space-2));
  height: calc(var(--wiki-control-height) - var(--wiki-space-2));
}

.personal-editor-section__heading > div {
  min-width: 0;
  flex: 1 1 auto;
}

.personal-editor-section__heading h4 {
  margin: 0;
  font-family: var(--wiki-font-heading);
  font-size: .9rem;
  font-weight: 720;
}

.personal-editor-section__heading p {
  margin: var(--wiki-space-1) 0 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 60%, transparent);
  font-size: .7rem;
  line-height: 1.45;
}

.personal-editor-section__fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(16rem, .8fr);
  gap: var(--wiki-space-4);
  align-items: start;
}

.personal-discovery {
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-6));
  padding: var(--wiki-space-2) var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
  box-shadow: var(--wiki-shadow-inset);
}

.personal-discovery p {
  margin: 0 var(--wiki-space-2) var(--wiki-space-1);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-size: var(--wiki-label-size);
  line-height: 1.45;
}

.personal-provenance {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: var(--wiki-space-4) 0 0;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
  box-shadow: var(--wiki-shadow-inset);
}

.personal-provenance > div {
  min-width: 0;
  padding: var(--wiki-space-3);
}

.personal-provenance > div + div {
  border-inline-start: 1px solid var(--wiki-surface-border);
}

.personal-provenance dt {
  margin-bottom: var(--wiki-space-1);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .055em;
  text-transform: uppercase;
}

.personal-provenance dd {
  overflow: hidden;
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-size: .72rem;
  font-weight: 620;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.personal-provenance code {
  font-family: var(--wiki-font-mono);
}

.personal-editor__code :deep(.v-field) {
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
  box-shadow: var(--wiki-shadow-inset);
}

.personal-editor__code :deep(textarea) {
  font-family: var(--wiki-font-mono);
  font-size: .78rem;
  line-height: 1.6;
  tab-size: 2;
}

.personal-editor__code :deep(.v-field--focused) {
  border-color: var(--wiki-focus-color);
  box-shadow: var(--wiki-focus-ring), var(--wiki-shadow-inset);
}

.personal-skills__actions {
  display: flex;
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-4));
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-3) var(--wiki-space-4) !important;
  border-top: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-sunken);
}

.personal-skills__trust-note {
  display: flex;
  min-width: 0;
  flex: 1 1 22rem;
  align-items: center;
  gap: var(--wiki-space-2);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
  font-size: .72rem;
}

.personal-skills__trust-note .v-icon {
  flex: 0 0 auto;
  color: var(--personal-accent);
}

.personal-confirmation {
  --personal-accent: var(--wiki-accent-spectral);

  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius) !important;
  background: var(--wiki-surface-raised) !important;
  box-shadow: var(--wiki-shadow-md), var(--wiki-shadow-inset) !important;
}

.personal-confirmation__header {
  display: flex;
  align-items: center;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-4);
  border-bottom: 1px solid var(--wiki-surface-border);
}

.personal-confirmation__header--danger > span {
  border-color: color-mix(in srgb, rgb(var(--v-theme-error)) 28%, var(--wiki-surface-border));
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 10%, var(--wiki-surface-raised));
  color: rgb(var(--v-theme-error));
}

.personal-confirmation__header h2 {
  margin: var(--wiki-space-1) 0 0;
  font-size: 1.05rem;
}

@media (max-width: 839.98px) {
  .personal-skills {
    border: 0;
    border-radius: 0 !important;
  }

  .personal-skills__header {
    padding: var(--wiki-space-4);
  }

  .personal-skills__header-state {
    display: none;
  }

  .personal-skills__boundary {
    padding-inline: var(--wiki-space-4);
  }

  .personal-skills__layout {
    min-height: 0;
    grid-template-columns: 1fr;
  }

  .personal-inventory {
    max-height: 18rem;
    border-block-end: 1px solid var(--wiki-surface-border);
    border-inline-end: 0;
  }

  .personal-inventory__list {
    min-height: 0;
  }

  .personal-inventory__empty {
    min-height: 10rem;
  }

  .personal-editor__header,
  .personal-editor__form {
    padding: var(--wiki-space-4);
  }

  .personal-editor__error {
    margin-inline: var(--wiki-space-4);
  }

  .personal-editor-section__fields,
  .personal-provenance {
    grid-template-columns: 1fr;
  }

  .personal-provenance > div + div {
    border-block-start: 1px solid var(--wiki-surface-border);
    border-inline-start: 0;
  }
}

@media (max-width: 560px) {
  .personal-skills__header {
    align-items: flex-start;
  }

  .personal-skills__heading p,
  .personal-skills__boundary {
    display: none;
  }

  .personal-inventory__header,
  .personal-editor__header {
    align-items: stretch;
    flex-direction: column;
  }

  .personal-editor__header-actions {
    justify-content: space-between;
  }

  .personal-editor-section__heading {
    flex-wrap: wrap;
  }

  .personal-editor-section__heading > .v-chip {
    margin-inline-start: calc(var(--wiki-control-height) - var(--wiki-space-2) + var(--wiki-space-3));
  }

  .personal-skills__actions {
    align-items: stretch;
  }

  .personal-skills__trust-note {
    flex-basis: 100%;
  }

  .personal-skills__actions > .v-btn {
    flex: 1 1 100%;
  }
}

@media (forced-colors: active) {
  .personal-skills,
  .personal-skill-item,
  .personal-discovery,
  .personal-provenance,
  .personal-confirmation,
  .personal-editor__code :deep(.v-field) {
    border: 1px solid CanvasText;
    box-shadow: none;
  }

  .personal-skill-item.v-list-item--active {
    outline: 2px solid Highlight;
    outline-offset: -2px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .personal-skills :deep(*) {
    scroll-behavior: auto !important;
    transition-duration: .01ms !important;
    animation-duration: .01ms !important;
  }
}
</style>
