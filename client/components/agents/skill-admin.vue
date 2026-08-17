<template>
  <v-sheet class="pa-6" rounded="lg" border>
    <div class="d-flex flex-wrap align-center ga-3 mb-5">
      <div>
        <h1 class="text-headline-large">Approved skills</h1>
        <p class="text-body-medium">Page-native skills stay disabled until an exact source revision is approved.</p>
      </div>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="createOpen = true">Map skill</v-btn>
    </div>

    <v-alert v-if="error" class="mb-4" type="error" variant="tonal" closable @click:close="error = ''">{{ error }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate aria-label="Loading skills" />
    <v-table v-else>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Root page</th>
          <th scope="col">State</th>
          <th scope="col">Revision</th>
          <th scope="col"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="skill in skills" :key="skill.id">
          <td>{{ skill.name }}</td>
          <td><code>{{ skill.rootPath }}</code></td>
          <td>
            <v-chip :color="skill.status === 'enabled' ? 'success' : undefined" size="small">{{ skill.status }}</v-chip>
            <v-chip v-if="skill.drifted" class="ml-2" color="warning" size="small">source changed</v-chip>
          </td>
          <td><code>{{ skill.approvedSourceRevision ?? 'not approved' }}</code></td>
          <td class="text-right">
            <v-btn size="small" variant="text" @click="openPreview(skill.id)">Review</v-btn>
            <v-btn v-if="skill.status === 'enabled'" size="small" variant="text" color="warning" @click="setEnabled(skill.id, false)">Revoke</v-btn>
            <v-btn v-else-if="skill.currentVersionId" size="small" variant="text" color="success" @click="setEnabled(skill.id, true)">Enable</v-btn>
          </td>
        </tr>
        <tr v-if="skills.length === 0">
          <td colspan="5" class="text-center text-medium-emphasis py-8">No skills are mapped.</td>
        </tr>
      </tbody>
    </v-table>
  </v-sheet>

  <v-dialog v-model="createOpen" max-width="42rem">
    <v-card title="Map a page-native skill">
      <v-card-text>
        <v-form id="skill-create-form" @submit.prevent="createSkill">
          <v-text-field v-model="create.name" label="Skill name" hint="Lowercase letters, numbers, and hyphens" required />
          <v-text-field v-model.number="create.rootPageId" label="Root page ID" type="number" min="1" required />
          <v-text-field v-model="create.rootPath" label="Root page path" required />
          <v-text-field v-model="create.assetFolderId" label="Asset folder ID (optional)" type="number" min="1" />
          <v-select v-model="create.exposureMode" :items="exposureModes" item-title="title" item-value="value" label="Exposure" />
          <v-text-field v-if="create.exposureMode === 'groups'" v-model="create.groupIds" label="Group IDs" hint="Comma-separated" />
        </v-form>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="createOpen = false">Cancel</v-btn>
        <v-btn color="primary" form="skill-create-form" type="submit">Map skill</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog v-model="previewOpen" max-width="64rem" scrollable>
    <v-card v-if="preview" title="Review immutable skill revision">
      <v-card-text>
        <v-alert v-if="preview.previousSkillMarkdown === null" class="mb-4" type="info" variant="tonal">This is the first approved revision.</v-alert>
        <dl class="review-metadata mb-5">
          <dt>Content hash</dt><dd><code>{{ preview.contentHash }}</code></dd>
          <dt>Source revision</dt><dd><code>{{ preview.sourceRevision }}</code></dd>
          <dt>Source updated</dt><dd>{{ preview.sourceUpdatedAt }}</dd>
          <dt>Bundle bytes</dt><dd>{{ preview.totalBytes }}</dd>
        </dl>
        <h2 class="text-headline-small mb-2">Candidate SKILL.md</h2>
        <pre class="source-view mb-5" tabindex="0">{{ preview.skillMarkdown }}</pre>
        <template v-if="preview.previousSkillMarkdown !== null">
          <h2 class="text-headline-small mb-2">Previously approved SKILL.md</h2>
          <pre class="source-view" tabindex="0">{{ preview.previousSkillMarkdown }}</pre>
        </template>
      </v-card-text>
      <v-card-actions>
        <v-btn color="error" variant="text" @click="review(false)">Reject revision</v-btn>
        <v-spacer />
        <v-btn @click="previewOpen = false">Cancel</v-btn>
        <v-btn color="primary" @click="review(true)">Approve exact revision</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { z } from 'zod'
const props = defineProps<{ csrfToken: string }>()

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
const preview = ref<Preview | null>(null)
const loading = ref(true)
const error = ref('')
const createOpen = ref(false)
const previewOpen = ref(false)
const create = reactive({
  name: '',
  rootPageId: 0,
  rootPath: '',
  assetFolderId: '',
  exposureMode: 'all_agent_users' as 'all_agent_users' | 'groups',
  groupIds: ''
})
const exposureModes = [
  { title: 'All agent users', value: 'all_agent_users' },
  { title: 'Selected groups', value: 'groups' }
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
    const message = await response.json().then(value => z.object({ message: z.string().optional() }).passthrough().parse(value).message).catch(() => undefined)
    throw new Error(message ?? `Request failed with status ${response.status}`)
  }
  return response.status === 204 ? null : response.json()
}

const reload = async (): Promise<void> => {
  loading.value = true
  error.value = ''
  try {
    const result = z.object({ skills: z.array(SkillSchema) }).parse(await request('/_api/agents/admin/skills'))
    skills.value = result.skills
  } catch (requestError: unknown) {
    error.value = requestError instanceof Error ? requestError.message : 'Unable to load skills'
  } finally {
    loading.value = false
  }
}

const createSkill = async (): Promise<void> => {
  error.value = ''
  const groupIds = create.exposureMode === 'groups'
    ? create.groupIds.split(',').map(value => Number(value.trim())).filter(Number.isSafeInteger)
    : []
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
.review-metadata {
  display: grid;
  gap: 0.5rem 1rem;
  grid-template-columns: max-content minmax(0, 1fr);
}
.review-metadata dt { font-weight: 600; }
.review-metadata dd { margin: 0; overflow-wrap: anywhere; }
.source-view {
  background: rgb(var(--v-theme-surface-variant));
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.25rem;
  max-height: 24rem;
  overflow: auto;
  padding: 1rem;
  white-space: pre-wrap;
}
.sr-only {
  height: 1px;
  margin: -1px;
  overflow: hidden;
  position: absolute;
  width: 1px;
  clip: rect(0, 0, 0, 0);
}
</style>
