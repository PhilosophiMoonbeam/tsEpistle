<template>
  <v-sheet class="pa-6" rounded="lg" border>
    <div class="d-flex flex-wrap align-center ga-3 mb-5">
      <div>
        <h1 class="text-headline-large">Approved skills</h1>
        <p class="text-body-medium">Approved skills augment the Agent for everyone or selected Wiki groups. Exact page revisions stay disabled until approved.</p>
      </div>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="createOpen = true">Map skill</v-btn>
    </div>
    <v-alert class="mb-4" type="info" variant="tonal">Agent tools are admitted from each user’s Wiki group permissions and deployment policy. Skills add group-scoped instructions and tool guidance; they never bypass page, write, browser, or approval permissions.</v-alert>

    <v-alert v-if="error" class="mb-4" type="error" variant="tonal" closable @click:close="error = ''">{{ error }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate aria-label="Loading skills" />
    <v-table v-else>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Root page</th>
          <th scope="col">State</th>
          <th scope="col">Revision</th>
          <th scope="col">Audience</th>
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
          <td>{{ skill.exposureMode === 'all_agent_users' ? 'Everyone' : groupNames(skill.groupIds) }}</td>
          <td class="text-right">
            <v-btn size="small" variant="text" @click="openPreview(skill.id)">Review</v-btn>
            <v-btn size="small" variant="text" @click="openAccess(skill)">Access</v-btn>
            <v-btn v-if="skill.status === 'enabled'" size="small" variant="text" color="warning" @click="setEnabled(skill.id, false)">Revoke</v-btn>
            <v-btn v-else-if="skill.currentVersionId" size="small" variant="text" color="success" @click="setEnabled(skill.id, true)">Enable</v-btn>
          </td>
        </tr>
        <tr v-if="skills.length === 0">
          <td colspan="6" class="text-center text-medium-emphasis py-8">No skills are mapped.</td>
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
          <v-select v-model="create.exposureMode" :items="exposureModes" item-title="title" item-value="value" label="Available to" />
          <v-autocomplete v-if="create.exposureMode === 'groups'" v-model="create.groupIds" :items="groups" item-title="name" item-value="id" label="Wiki groups" multiple chips closable-chips />
        </v-form>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="createOpen = false">Cancel</v-btn>
        <v-btn color="primary" form="skill-create-form" type="submit">Map skill</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
  <v-dialog v-model="accessOpen" max-width="36rem" scrollable>
    <v-card :title="policySkill ? `Access for ${policySkill.name}` : 'Skill access'">
      <v-card-text>
        <v-select v-model="policy.exposureMode" :items="exposureModes" label="Available to" />
        <v-autocomplete v-if="policy.exposureMode === 'groups'" v-model="policy.groupIds" :items="groups" item-title="name" item-value="id" label="Wiki groups" multiple chips closable-chips hint="Users receive this skill through any selected group." persistent-hint />
      </v-card-text>
      <v-card-actions><v-spacer/><v-btn @click="accessOpen = false">Cancel</v-btn><v-btn color="primary" :disabled="policy.exposureMode === 'groups' && policy.groupIds.length === 0" @click="saveAccess">Save access</v-btn></v-card-actions>
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
      request('/api/groups')
    ])
    skills.value = z.object({ skills: z.array(SkillSchema) }).parse(result).skills
    groups.value = z.array(GroupSchema).parse(groupResult)
  } catch (requestError: unknown) {
    error.value = requestError instanceof Error ? requestError.message : 'Unable to load skills'
  } finally {
    loading.value = false
  }
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
