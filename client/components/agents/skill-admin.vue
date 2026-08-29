<template>
  <section class="skill-panel" :class="{ 'skill-panel--standalone': !embedded }">
    <div class="skill-panel__header">
      <div class="skill-panel__heading">
        <span class="skill-panel__icon"><v-icon size="22">mdi-book-open-variant-outline</v-icon></span>
        <div>
          <div class="skill-panel__eyebrow">Curated expertise</div>
          <h2>{{ embedded ? 'Approved skills' : 'Agent skills' }}</h2>
          <p>Map page-native guidance, approve exact revisions, and choose who receives each skill.</p>
        </div>
      </div>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">Map skill</v-btn>
    </div>

    <div class="skill-panel__body">
      <v-alert class="mb-4" type="info" variant="tonal" density="compact">Skills add group-scoped instructions and tool guidance; they never bypass page, write, browser, approval, or deployment permissions.</v-alert>
      <v-alert v-if="error" class="mb-4" type="error" variant="tonal" closable @click:close="error = ''">{{ error }}</v-alert>
      <v-progress-linear v-if="loading" indeterminate aria-label="Loading skills" />

      <div v-else-if="skills.length" class="skill-grid">
        <article v-for="skill in skills" :key="skill.id" class="skill-card">
          <div class="skill-card__top">
            <span class="skill-card__mark"><v-icon size="22">mdi-puzzle-outline</v-icon></span>
            <div class="skill-card__identity">
              <div><h3>{{ skill.name }}</h3><v-chip :color="skill.status === 'enabled' ? 'success' : undefined" size="x-small" variant="tonal">{{ skill.status }}</v-chip></div>
              <code>{{ skill.rootPath }}</code>
            </div>
            <v-menu>
              <template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" icon="mdi-dots-horizontal" variant="text" density="comfortable" :aria-label="`Actions for ${skill.name}`" /></template>
              <v-list density="comfortable">
                <v-list-item prepend-icon="mdi-file-eye-outline" title="Review revision" @click="openPreview(skill.id)" />
                <v-list-item prepend-icon="mdi-account-multiple-outline" title="Edit access" @click="openAccess(skill)" />
                <v-list-item v-if="skill.status === 'enabled'" prepend-icon="mdi-cancel" title="Revoke skill" base-color="warning" @click="setEnabled(skill.id, false)" />
                <v-list-item v-else-if="skill.currentVersionId" prepend-icon="mdi-check-circle-outline" title="Enable skill" base-color="success" @click="setEnabled(skill.id, true)" />
              </v-list>
            </v-menu>
          </div>
          <div class="skill-card__state">
            <span :class="['skill-state', skill.drifted ? 'skill-state--warning' : skill.currentVersionId ? 'skill-state--success' : '']"><v-icon size="15">{{ skill.drifted ? 'mdi-alert-circle' : skill.currentVersionId ? 'mdi-check-circle' : 'mdi-clock-outline' }}</v-icon>{{ skill.drifted ? 'Source changed' : skill.currentVersionId ? 'Revision approved' : 'Awaiting approval' }}</span>
          </div>
          <dl class="skill-card__meta">
            <div><dt>Revision</dt><dd><code>{{ skill.approvedSourceRevision ?? 'Not approved' }}</code></dd></div>
            <div><dt>Available to</dt><dd>{{ skill.exposureMode === 'all_agent_users' ? 'Everyone' : groupNames(skill.groupIds) }}</dd></div>
          </dl>
          <button type="button" class="skill-card__review" @click="openPreview(skill.id)">Review exact revision <v-icon size="17">mdi-arrow-right</v-icon></button>
        </article>
      </div>

      <div v-else-if="!loading" class="skill-empty">
        <span><v-icon size="34">mdi-book-plus-outline</v-icon></span>
        <h3>Turn trusted pages into Agent skills</h3>
        <p>Map a page tree, review its immutable revision, then make that expertise available to the right audience.</p>
        <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">Map skill</v-btn>
      </div>
    </div>
  </section>

  <v-dialog v-model="createOpen" max-width="46rem" scrollable :fullscreen="smAndDown">
    <v-card class="skill-dialog">
      <div class="skill-dialog__header">
        <span><v-icon size="23">mdi-book-plus-outline</v-icon></span>
        <div><div class="skill-panel__eyebrow">New knowledge mapping</div><h2>Map a page-native skill</h2><p>Point the Agent at one trusted page tree and define its audience.</p></div>
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" aria-label="Close skill editor" @click="createOpen = false" />
      </div>
      <v-card-text class="skill-dialog__body">
        <v-form id="skill-create-form" @submit.prevent="createSkill">
          <section class="skill-form-section">
            <div class="skill-form-section__heading"><span><v-icon size="19">mdi-identifier</v-icon></span><div><h3>Skill identity</h3><p>Use a stable, command-friendly name.</p></div></div>
            <v-text-field v-model="create.name" label="Skill name" hint="Lowercase letters, numbers, and hyphens" persistent-hint required autofocus />
          </section>
          <section class="skill-form-section">
            <div class="skill-form-section__heading"><span><v-icon size="19">mdi-file-tree-outline</v-icon></span><div><h3>Knowledge source</h3><p>The root page and optional asset folder bundled into the skill.</p></div></div>
            <div class="skill-form-grid">
              <v-text-field v-model.number="create.rootPageId" label="Root page ID" type="number" min="1" required />
              <v-text-field v-model="create.assetFolderId" label="Asset folder ID (optional)" type="number" min="1" />
              <v-text-field class="skill-form-grid__wide" v-model="create.rootPath" label="Root page path" placeholder="handbook/research" required />
            </div>
          </section>
          <section class="skill-form-section">
            <div class="skill-form-section__heading"><span><v-icon size="19">mdi-account-multiple-outline</v-icon></span><div><h3>Audience</h3><p>Skills complement—never replace—each user’s Wiki permissions.</p></div></div>
            <v-select v-model="create.exposureMode" :items="exposureModes" item-title="title" item-value="value" label="Available to" />
            <v-autocomplete v-if="create.exposureMode === 'groups'" v-model="create.groupIds" :items="groups" item-title="name" item-value="id" label="Wiki groups" multiple chips closable-chips />
          </section>
        </v-form>
      </v-card-text>
      <v-card-actions class="skill-dialog__actions"><v-spacer /><v-btn @click="createOpen = false">Cancel</v-btn><v-btn color="primary" prepend-icon="mdi-check" form="skill-create-form" type="submit">Map skill</v-btn></v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog v-model="accessOpen" max-width="40rem" scrollable>
    <v-card class="skill-dialog">
      <div class="skill-dialog__header"><span><v-icon size="23">mdi-account-multiple-outline</v-icon></span><div><h2>{{ policySkill ? `Access for ${policySkill.name}` : 'Skill access' }}</h2><p>Control who receives this approved expertise.</p></div></div>
      <v-card-text class="skill-dialog__body"><v-select v-model="policy.exposureMode" :items="exposureModes" label="Available to" /><v-autocomplete v-if="policy.exposureMode === 'groups'" v-model="policy.groupIds" :items="groups" item-title="name" item-value="id" label="Wiki groups" multiple chips closable-chips hint="Users receive this skill through any selected group." persistent-hint /></v-card-text>
      <v-card-actions class="skill-dialog__actions"><v-spacer /><v-btn @click="accessOpen = false">Cancel</v-btn><v-btn color="primary" :disabled="policy.exposureMode === 'groups' && policy.groupIds.length === 0" @click="saveAccess">Save access</v-btn></v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog v-model="previewOpen" max-width="70rem" scrollable :fullscreen="smAndDown">
    <v-card v-if="preview" class="skill-dialog skill-review">
      <div class="skill-dialog__header"><span><v-icon size="23">mdi-file-eye-outline</v-icon></span><div><div class="skill-panel__eyebrow">Immutable revision</div><h2>Review {{ preview.name }}</h2><p>Approve only the exact source revision shown below.</p></div><v-spacer /><v-btn icon="mdi-close" variant="text" aria-label="Close skill review" @click="previewOpen = false" /></div>
      <v-card-text class="skill-dialog__body">
        <v-alert v-if="preview.previousSkillMarkdown === null" class="mb-4" type="info" variant="tonal">This is the first approved revision.</v-alert>
        <dl class="review-metadata">
          <div><dt>Content hash</dt><dd><code>{{ preview.contentHash }}</code></dd></div>
          <div><dt>Source revision</dt><dd><code>{{ preview.sourceRevision }}</code></dd></div>
          <div><dt>Source updated</dt><dd>{{ preview.sourceUpdatedAt }}</dd></div>
          <div><dt>Bundle size</dt><dd>{{ preview.totalBytes }} bytes</dd></div>
        </dl>
        <div class="source-heading"><div><span>Candidate</span><h3>SKILL.md</h3></div><v-chip size="x-small" variant="tonal" color="primary">Exact source</v-chip></div>
        <pre class="source-view" tabindex="0">{{ preview.skillMarkdown }}</pre>
        <template v-if="preview.previousSkillMarkdown !== null">
          <div class="source-heading"><div><span>Previously approved</span><h3>SKILL.md</h3></div></div>
          <pre class="source-view" tabindex="0">{{ preview.previousSkillMarkdown }}</pre>
        </template>
      </v-card-text>
      <v-card-actions class="skill-dialog__actions"><v-btn color="error" variant="text" @click="review(false)">Reject revision</v-btn><v-spacer /><v-btn @click="previewOpen = false">Cancel</v-btn><v-btn color="primary" prepend-icon="mdi-check-decagram-outline" @click="review(true)">Approve exact revision</v-btn></v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useDisplay } from 'vuetify'
import { z } from 'zod'
const props = withDefaults(defineProps<{ csrfToken: string; embedded?: boolean }>(), { embedded: false })
const { smAndDown } = useDisplay()

const SkillSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  rootPageId: z.number(),
  rootPath: z.string(),
  assetFolderId: z.number().nullable(),
  status: z.enum(['enabled', 'disabled']),
  exposureMode: z.enum(['all_agent_users', 'groups']),
  currentVersionId: z.uuid().nullable(),
  currentContentHash: z.string().nullable(),
  approvedSourceRevision: z.string().nullable(),
  liveSourceRevision: z.string(),
  drifted: z.boolean(),
  groupIds: z.array(z.number())
})
const GroupSchema = z.object({ id: z.number().int().positive(), name: z.string(), isSystem: z.boolean() })
const PreviewSchema = z.object({
  skillId: z.uuid(),
  name: z.string(),
  contentHash: z.string(),
  sourceRevision: z.string(),
  sourceUpdatedAt: z.string(),
  frontmatter: z.unknown(),
  manifestJson: z.string(),
  totalBytes: z.number(),
  skillMarkdown: z.string(),
  previousSkillMarkdown: z.string().nullable()
})
type Skill = z.infer<typeof SkillSchema>
type Preview = z.infer<typeof PreviewSchema>

const skills = ref<Skill[]>([])
const groups = ref<z.infer<typeof GroupSchema>[]>([])
const preview = ref<Preview | null>(null)
const loading = ref(true)
const error = ref('')
const createOpen = ref(false)
const accessOpen = ref(false)
const previewOpen = ref(false)
const policySkill = ref<Skill | null>(null)
const policy = reactive({ exposureMode: 'all_agent_users' as 'all_agent_users' | 'groups', groupIds: [] as number[] })
const create = reactive({
  name: '',
  rootPageId: 0,
  rootPath: '',
  assetFolderId: '',
  exposureMode: 'all_agent_users' as 'all_agent_users' | 'groups',
  groupIds: [] as number[]
})
const exposureModes = [
  { title: 'Everyone (default)', value: 'all_agent_users' },
  { title: 'Selected Wiki groups', value: 'groups' }
]

const request = async (url: string, init: RequestInit = {}): Promise<unknown> => {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.method && init.method !== 'GET' ? { 'x-wiki-csrf': props.csrfToken } : {}),
      ...init.headers
    }
  })
  if (!response.ok) {
    const message: { message?: string; error?: string } = await response.json().then(value => z.object({ message: z.string().optional(), error: z.string().optional() }).passthrough().parse(value)).catch(() => ({}))
    throw new Error(message.message ?? message.error ?? `Request failed with status ${response.status}`)
  }
  return response.status === 204 ? null : response.json()
}

const reload = async (): Promise<void> => {
  loading.value = true
  error.value = ''
  try {
    const [result, groupResult] = await Promise.all([
      request('/_api/agents/admin/skills'),
      request('/_api/groups')
    ])
    skills.value = z.object({ skills: z.array(SkillSchema) }).parse(result).skills
    groups.value = z.array(GroupSchema).parse(groupResult)
  } catch (requestError: unknown) {
    error.value = requestError instanceof Error ? requestError.message : 'Unable to load skills'
  } finally {
    loading.value = false
  }
}
const openCreate = (): void => {
  error.value = ''
  Object.assign(create, {
    name: '',
    rootPageId: 0,
    rootPath: '',
    assetFolderId: '',
    exposureMode: 'all_agent_users',
    groupIds: []
  })
  createOpen.value = true
}

const createSkill = async (): Promise<void> => {
  error.value = ''
  const groupIds = create.exposureMode === 'groups' ? create.groupIds : []
  try {
    await request('/_api/agents/admin/skills', {
      method: 'POST',
      body: JSON.stringify({
        name: create.name,
        rootPageId: create.rootPageId,
        rootPath: create.rootPath,
        assetFolderId: create.assetFolderId === '' ? null : Number(create.assetFolderId),
        exposureMode: create.exposureMode,
        groupIds,
      })
    })
    createOpen.value = false
    await reload()
  } catch (requestError: unknown) {
    error.value = requestError instanceof Error ? requestError.message : 'Unable to map skill'
  }
}
const groupNames = (groupIds: readonly number[]): string => groupIds.map(id => groups.value.find(group => group.id === id)?.name ?? `Group ${id}`).join(', ')
const openAccess = (skill: Skill): void => {
  policySkill.value = skill
  policy.exposureMode = skill.exposureMode
  policy.groupIds = [...skill.groupIds]
  accessOpen.value = true
}
const saveAccess = async (): Promise<void> => {
  const skill = policySkill.value
  if (!skill) return
  error.value = ''
  try {
    await request(`/_api/agents/admin/skills/${skill.id}/policy`, {
      method: 'POST',
      body: JSON.stringify({
        assetFolderId: skill.assetFolderId,
        exposureMode: policy.exposureMode,
        groupIds: policy.exposureMode === 'groups' ? policy.groupIds : []
      })
    })
    accessOpen.value = false
    await reload()
  } catch (requestError: unknown) {
    error.value = requestError instanceof Error ? requestError.message : 'Unable to change skill access'
  }
}


const openPreview = async (skillId: string): Promise<void> => {
  error.value = ''
  try {
    preview.value = PreviewSchema.parse(await request(`/_api/agents/admin/skills/${skillId}/preview`))
    previewOpen.value = true
  } catch (requestError: unknown) {
    error.value = requestError instanceof Error ? requestError.message : 'Unable to preview skill'
  }
}

const review = async (approved: boolean): Promise<void> => {
  if (!preview.value) return
  error.value = ''
  try {
    await request(`/_api/agents/admin/skills/${preview.value.skillId}/${approved ? 'approve' : 'reject'}`, {
      method: 'POST',
      body: JSON.stringify({ expectedContentHash: preview.value.contentHash, expectedSourceRevision: preview.value.sourceRevision })
    })
    previewOpen.value = false
    await reload()
  } catch (requestError: unknown) {
    error.value = requestError instanceof Error ? requestError.message : 'Unable to review skill'
  }
}

const setEnabled = async (skillId: string, enabled: boolean): Promise<void> => {
  error.value = ''
  try {
    await request(`/_api/agents/admin/skills/${skillId}/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) })
    await reload()
  } catch (requestError: unknown) {
    error.value = requestError instanceof Error ? requestError.message : 'Unable to change skill state'
  }
}

onMounted(reload)
</script>

<style scoped>
.skill-panel {
  overflow: hidden;
  border: 1px solid rgba(var(--v-border-color), .12);
  border-radius: 1.1rem;
  background: rgb(var(--v-theme-surface));
  box-shadow: 0 .7rem 2rem rgba(20, 28, 50, .04);
}

.skill-panel--standalone { max-width: 72rem; margin: 0 auto; }

.skill-panel__header {
  display: flex;
  min-height: 6.25rem;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 1.35rem 1.5rem;
  border-bottom: 1px solid rgba(var(--v-border-color), .1);
}

.skill-panel__heading {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: .9rem;
}

.skill-panel__icon,
.skill-card__mark,
.skill-empty > span,
.skill-dialog__header > span,
.skill-form-section__heading > span {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  border-radius: .8rem;
  background: rgba(139, 92, 246, .1);
  color: #8b5cf6;
}

.skill-panel__icon { width: 2.85rem; height: 2.85rem; }

.skill-panel__eyebrow {
  color: rgb(var(--v-theme-primary));
  font-size: .68rem;
  font-weight: 780;
  letter-spacing: .13em;
  text-transform: uppercase;
}

.skill-panel__header h2 {
  margin: .12rem 0 .15rem;
  font-size: 1.2rem;
  font-weight: 720;
  letter-spacing: -.025em;
}

.skill-panel__header p,
.skill-dialog__header p {
  margin: 0;
  color: rgba(var(--v-theme-on-surface), .62);
  font-size: .78rem;
}

.skill-panel__body { padding: 1.5rem; }

.skill-grid {
  display: grid;
  gap: .85rem;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
}

.skill-card {
  display: flex;
  min-width: 0;
  overflow: hidden;
  flex-direction: column;
  padding: 1.05rem;
  border: 1px solid rgba(var(--v-border-color), .12);
  border-radius: 1rem;
  background:
    radial-gradient(circle at 100% 0, rgba(139, 92, 246, .055), transparent 11rem),
    rgba(var(--v-theme-on-surface), .014);
  transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease;
}

.skill-card:hover {
  border-color: rgba(139, 92, 246, .23);
  box-shadow: 0 .8rem 2rem rgba(20, 28, 50, .065);
  transform: translateY(-.1rem);
}

.skill-card__top {
  display: flex;
  align-items: flex-start;
  gap: .7rem;
}

.skill-card__mark {
  width: 2.65rem;
  height: 2.65rem;
  background: linear-gradient(145deg, rgba(139, 92, 246, .16), rgba(var(--v-theme-primary), .08));
}

.skill-card__identity { min-width: 0; flex: 1 1 auto; }

.skill-card__identity > div {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: .45rem;
}

.skill-card__identity h3 {
  overflow: hidden;
  margin: .1rem 0 .2rem;
  font-size: .95rem;
  font-weight: 720;
  letter-spacing: -.015em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-card__identity > code {
  display: block;
  overflow: hidden;
  max-width: 100%;
  color: rgba(var(--v-theme-on-surface), .58);
  font-size: .68rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-card__state {
  display: flex;
  margin: .9rem 0 .65rem;
}

.skill-state {
  display: inline-flex;
  align-items: center;
  gap: .3rem;
  padding: .28rem .48rem;
  border-radius: 999px;
  background: rgba(var(--v-theme-on-surface), .06);
  color: rgba(var(--v-theme-on-surface), .62);
  font-size: .64rem;
  font-weight: 680;
}

.skill-state--success { background: rgba(var(--v-theme-success), .09); color: rgb(var(--v-theme-success)); }
.skill-state--warning { background: rgba(var(--v-theme-warning), .11); color: rgb(var(--v-theme-warning)); }

.skill-card__meta {
  display: grid;
  gap: .45rem;
  margin: 0;
  padding: .75rem;
  border: 1px solid rgba(var(--v-border-color), .085);
  border-radius: .75rem;
  background: rgba(var(--v-theme-surface), .65);
}

.skill-card__meta > div {
  display: grid;
  align-items: baseline;
  gap: .65rem;
  grid-template-columns: 5.2rem minmax(0, 1fr);
}

.skill-card__meta dt {
  color: rgba(var(--v-theme-on-surface), .58);
  font-size: .64rem;
  font-weight: 700;
  letter-spacing: .06em;
  text-transform: uppercase;
}

.skill-card__meta dd {
  overflow: hidden;
  margin: 0;
  font-size: .7rem;
  font-weight: 620;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-card__review {
  display: flex;
  width: calc(100% + 2.1rem);
  align-items: center;
  justify-content: space-between;
  margin: .95rem -1.05rem -1.05rem;
  padding: .7rem 1.05rem;
  border: 0;
  border-top: 1px solid rgba(var(--v-border-color), .085);
  background: transparent;
  color: rgb(var(--v-theme-primary));
  cursor: pointer;
  font-size: .7rem;
  font-weight: 680;
  text-align: left;
}
.skill-card__review:hover { background: rgba(var(--v-theme-primary), .045); }
.skill-card__review:focus-visible {
  outline: .15rem solid rgba(var(--v-theme-primary), .42);
  outline-offset: -.2rem;
}

.skill-empty {
  display: grid;
  min-height: 22rem;
  place-items: center;
  align-content: center;
  padding: 3rem 1.5rem;
  text-align: center;
}

.skill-empty > span {
  width: 4.5rem;
  height: 4.5rem;
  margin-bottom: 1rem;
  border-radius: 1.35rem;
  background: linear-gradient(145deg, rgba(139, 92, 246, .15), rgba(var(--v-theme-primary), .08));
}

.skill-empty h3 { margin: 0 0 .35rem; font-size: 1.05rem; font-weight: 720; }
.skill-empty p { max-width: 32rem; margin: 0 0 1.15rem; color: rgba(var(--v-theme-on-surface), .6); font-size: .78rem; line-height: 1.55; }

.skill-dialog {
  overflow: hidden;
  border-radius: 1.15rem !important;
  background: rgb(var(--v-theme-surface)) !important;
}

.skill-dialog__header {
  display: flex;
  min-height: 5.8rem;
  align-items: center;
  gap: .8rem;
  padding: 1.05rem 1.2rem;
  border-bottom: 1px solid rgba(var(--v-border-color), .1);
  background:
    radial-gradient(circle at 88% 0, rgba(139, 92, 246, .08), transparent 15rem),
    rgb(var(--v-theme-surface));
}

.skill-dialog__header > span { width: 2.8rem; height: 2.8rem; }
.skill-dialog__header h2 { margin: .1rem 0 .12rem; font-size: 1.1rem; font-weight: 730; letter-spacing: -.025em; }
.skill-dialog__body { padding: 1.4rem !important; }
.skill-dialog__actions { min-height: 4.3rem; padding: .65rem 1rem !important; border-top: 1px solid rgba(var(--v-border-color), .1); }

.skill-form-section + .skill-form-section {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid rgba(var(--v-border-color), .09);
}

.skill-form-section__heading {
  display: flex;
  align-items: flex-start;
  gap: .65rem;
  margin-bottom: .9rem;
}

.skill-form-section__heading > span { width: 2.2rem; height: 2.2rem; }
.skill-form-section__heading h3 { margin: 0; font-size: .86rem; font-weight: 700; }
.skill-form-section__heading p { margin: .1rem 0 0; color: rgba(var(--v-theme-on-surface), .58); font-size: .69rem; }

.skill-form-grid { display: grid; gap: 0 1rem; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.skill-form-grid__wide { grid-column: 1 / -1; }

.review-metadata {
  display: grid;
  gap: .55rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 0 0 1.5rem;
}

.review-metadata > div {
  min-width: 0;
  padding: .75rem;
  border: 1px solid rgba(var(--v-border-color), .09);
  border-radius: .75rem;
  background: rgba(var(--v-theme-on-surface), .018);
}

.review-metadata dt {
  margin-bottom: .15rem;
  color: rgba(var(--v-theme-on-surface), .56);
  font-size: .63rem;
  font-weight: 700;
  letter-spacing: .06em;
  text-transform: uppercase;
}

.review-metadata dd {
  overflow: hidden;
  margin: 0;
  font-size: .72rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  margin: 1.25rem 0 .55rem;
}

.source-heading span {
  color: rgb(var(--v-theme-primary));
  font-size: .61rem;
  font-weight: 740;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.source-heading h3 { margin: .05rem 0 0; font-size: .95rem; }

.source-view {
  max-height: 25rem;
  overflow: auto;
  margin: 0;
  padding: 1rem;
  border: 1px solid rgba(var(--v-border-color), .12);
  border-radius: .8rem;
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 4%, rgb(var(--v-theme-surface)));
  font-size: .72rem;
  line-height: 1.55;
  white-space: pre-wrap;
}

code { overflow-wrap: anywhere; }

@media (max-width: 700px) {
  .skill-panel__header { align-items: flex-start; flex-direction: column; }
  .skill-panel__header > .v-btn { width: 100%; }
  .skill-form-grid,
  .review-metadata { grid-template-columns: 1fr; }
  .skill-form-grid__wide { grid-column: auto; }
  .skill-dialog { border-radius: 0 !important; }
  .skill-dialog__header p { display: none; }
  .skill-dialog__actions { overflow-x: auto; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: .01ms !important;
    animation-duration: .01ms !important;
  }
}
</style>
