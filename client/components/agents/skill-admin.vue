<template>
  <section class="skill-governance" :class="{ 'skill-governance--standalone': !embedded }" aria-labelledby="skill-governance-title">
    <header class="skill-governance__header">
      <div class="skill-governance__heading">
        <span class="skill-governance__mark" aria-hidden="true"><v-icon size="22">mdi-shield-book-outline</v-icon></span>
        <div>
          <div class="skill-eyebrow">Organization policy</div>
          <h2 id="skill-governance-title">{{ embedded ? 'Approved skill library' : 'Organization skill governance' }}</h2>
          <p>Publish page-native expertise, approve exact revisions, and govern who can use it.</p>
        </div>
      </div>
      <div class="skill-governance__header-actions">
        <v-chip v-if="loaded" size="small" variant="outlined" prepend-icon="mdi-domain">{{ enabledSkillCount }} enabled</v-chip>
        <v-btn color="primary" prepend-icon="mdi-plus" :disabled="loading || Boolean(actionBusyId)" @click="openCreate">Map organization skill</v-btn>
      </div>
    </header>

    <div class="skill-governance__body">
      <v-alert class="skill-boundary" type="info" variant="tonal" density="compact" icon="mdi-shield-lock-outline">
        Organization skills provide approved instructions and tool guidance. They never bypass page, write, browser, approval, or deployment permissions.
      </v-alert>
      <v-alert v-if="error" class="skill-error" type="error" variant="tonal" closable @click:close="error = ''">
        {{ error }}
        <template #append><v-btn variant="text" size="small" @click="reload">Retry</v-btn></template>
      </v-alert>

      <div class="skill-inventory-toolbar" role="search" aria-label="Search organization skills">
        <v-text-field
          v-model="search"
          class="skill-inventory-toolbar__search"
          label="Search approved skills"
          placeholder="Name, page path, revision, or group"
          prepend-inner-icon="mdi-magnify"
          clearable
          hide-details
          density="comfortable"
        />
        <v-select
          v-model="stateFilter"
          class="skill-inventory-toolbar__filter"
          :items="stateFilters"
          item-title="title"
          item-value="value"
          label="Policy state"
          hide-details
          density="comfortable"
        />
      </div>

      <div v-if="loaded" class="skill-inventory-summary" aria-live="polite">
        <span><strong>{{ filteredSkills.length }}</strong> of {{ skills.length }} organization skills</span>
        <span class="skill-inventory-summary__legend"><v-icon size="16">mdi-check-decagram-outline</v-icon> Exact approved revisions</span>
      </div>

      <div v-if="loading && !loaded" class="skill-loading" aria-label="Loading organization skills" aria-busy="true">
        <v-skeleton-loader v-for="index in 3" :key="index" type="list-item-avatar-three-line" />
      </div>
      <v-progress-linear v-else-if="loading" indeterminate aria-label="Refreshing organization skills" />

      <div v-if="loaded && filteredSkills.length" class="skill-inventory">
        <article v-for="skill in filteredSkills" :key="skill.id" class="skill-record" :aria-busy="actionBusyId.endsWith(skill.id)">
          <div class="skill-record__top">
            <span class="skill-record__mark" aria-hidden="true"><v-icon size="21">mdi-file-certificate-outline</v-icon></span>
            <div class="skill-record__identity">
              <div class="skill-record__title-line">
                <h3>{{ skill.name }}</h3>
                <v-chip :color="skill.status === 'enabled' ? 'success' : undefined" size="x-small" variant="tonal" :prepend-icon="skill.status === 'enabled' ? 'mdi-check-circle-outline' : 'mdi-pause-circle-outline'">
                  {{ skill.status === 'enabled' ? 'Enabled by policy' : 'Disabled by policy' }}
                </v-chip>
              </div>
              <code :title="skill.rootPath">{{ skill.rootPath }}</code>
            </div>
            <v-menu location="bottom end">
              <template #activator="{ props: menuProps }">
                <v-btn v-bind="menuProps" icon="mdi-dots-horizontal" variant="text" density="comfortable" :aria-label="`Policy actions for ${skill.name}`" />
              </template>
              <v-list density="comfortable">
                <v-list-subheader>Organization policy</v-list-subheader>
                <v-list-item prepend-icon="mdi-file-eye-outline" title="Review approved source" :disabled="Boolean(actionBusyId)" @click="openPreview(skill.id)" />
                <v-list-item prepend-icon="mdi-account-multiple-outline" title="Edit audience" :disabled="Boolean(actionBusyId)" @click="openAccess(skill)" />
                <v-divider />
                <v-list-item v-if="skill.status === 'enabled'" prepend-icon="mdi-pause-circle-outline" title="Disable for organization" base-color="warning" :disabled="Boolean(actionBusyId)" @click="setEnabled(skill.id, false)" />
                <v-list-item v-else-if="skill.currentVersionId" prepend-icon="mdi-check-circle-outline" title="Enable for organization" base-color="success" :disabled="Boolean(actionBusyId)" @click="setEnabled(skill.id, true)" />
              </v-list>
            </v-menu>
          </div>
          <v-progress-linear v-if="actionBusyId.endsWith(skill.id)" indeterminate height="2" aria-label="Updating organization skill" />

          <div class="skill-record__trust" :class="{ 'skill-record__trust--warning': skill.drifted || !skill.currentVersionId }">
            <v-icon size="17">{{ skill.drifted ? 'mdi-source-branch-sync' : skill.currentVersionId ? 'mdi-check-decagram-outline' : 'mdi-clock-outline' }}</v-icon>
            <span>
              <strong>{{ skill.drifted ? 'Source drift detected' : skill.currentVersionId ? 'Approved source' : 'Approval required' }}</strong>
              <small>{{ skill.drifted ? 'The last approved revision remains active until a new review.' : skill.currentVersionId ? 'Only the immutable reviewed revision is available.' : 'This skill cannot be enabled before review.' }}</small>
            </span>
          </div>

          <dl class="skill-record__metadata">
            <div>
              <dt>Provenance</dt>
              <dd><code :title="skill.approvedSourceRevision ?? 'Not approved'">{{ skill.approvedSourceRevision ?? 'Not approved' }}</code></dd>
            </div>
            <div>
              <dt>Audience scope</dt>
              <dd :title="skill.exposureMode === 'all_agent_users' ? 'All Agent users' : groupNames(skill.groupIds)">{{ skill.exposureMode === 'all_agent_users' ? 'All Agent users' : groupNames(skill.groupIds) }}</dd>
            </div>
            <div>
              <dt>Effective state</dt>
              <dd>{{ skill.status === 'enabled' && skill.currentVersionId ? 'Available' : 'Unavailable' }}</dd>
            </div>
          </dl>

          <button type="button" class="skill-record__review" :disabled="Boolean(actionBusyId)" @click="openPreview(skill.id)">
            <span><v-icon size="17">mdi-code-tags</v-icon> Details & exact source</span>
            <v-icon size="17">mdi-arrow-right</v-icon>
          </button>
        </article>
      </div>

      <div v-else-if="loaded && skills.length" class="skill-empty skill-empty--search">
        <span><v-icon size="30">mdi-text-search</v-icon></span>
        <h3>No organization skills match</h3>
        <p>Try another name, page path, revision, group, or policy state.</p>
        <v-btn variant="tonal" prepend-icon="mdi-filter-remove-outline" @click="clearFilters">Clear filters</v-btn>
      </div>

      <div v-else-if="loaded" class="skill-empty">
        <span><v-icon size="34">mdi-book-plus-outline</v-icon></span>
        <div class="skill-eyebrow">Organization library</div>
        <h3>Publish the first trusted skill</h3>
        <p>Map a page tree, review its immutable source, then make that expertise available to the right audience.</p>
        <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">Map organization skill</v-btn>
      </div>
    </div>
  </section>

  <v-dialog v-model="createOpen" max-width="46rem" scrollable :fullscreen="smAndDown" aria-labelledby="skill-create-title" :persistent="actionBusyId === 'create'">
    <v-card class="skill-dialog">
      <div class="skill-dialog__header">
        <span><v-icon size="23">mdi-book-plus-outline</v-icon></span>
        <div><div class="skill-eyebrow">Organization policy</div><h2 id="skill-create-title">Map a page-native skill</h2><p>Choose one trusted page tree, then define who receives the approved revision.</p></div>
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" aria-label="Close skill editor" :disabled="actionBusyId === 'create'" @click="createOpen = false" />
      </div>
      <v-card-text class="skill-dialog__body">
        <v-form id="skill-create-form" @submit.prevent="createSkill">
          <section class="skill-form-section">
            <div class="skill-form-section__heading"><span><v-icon size="19">mdi-identifier</v-icon></span><div><h3>Skill identity</h3><p>Use a stable, command-friendly name.</p></div></div>
            <v-text-field v-model="create.name" :rules="createNameRules" label="Skill name" hint="Lowercase letters, numbers, and single hyphens" persistent-hint required autofocus />
          </section>
          <section class="skill-form-section">
            <div class="skill-form-section__heading"><span><v-icon size="19">mdi-file-tree-outline</v-icon></span><div><h3>Knowledge source</h3><p>The root page and optional asset folder bundled into the skill.</p></div></div>
            <div class="skill-form-grid">
              <v-text-field v-model.number="create.rootPageId" label="Root page ID" type="number" min="1" :rules="createRootPageRules" required />
              <v-text-field v-model="create.assetFolderId" label="Asset folder ID (optional)" type="number" min="1" :rules="createAssetFolderRules" />
              <v-text-field v-model="create.rootPath" class="skill-form-grid__wide" label="Root page path" placeholder="handbook/research" hint="The path must identify the selected root page tree." persistent-hint required />
            </div>
          </section>
          <section class="skill-form-section">
            <div class="skill-form-section__heading"><span><v-icon size="19">mdi-account-multiple-outline</v-icon></span><div><h3>Audience policy</h3><p>Skills complement—never replace—each user’s Wiki permissions.</p></div></div>
            <v-select v-model="create.exposureMode" :items="exposureModes" item-title="title" item-value="value" label="Available to" />
            <v-autocomplete v-if="create.exposureMode === 'groups'" v-model="create.groupIds" :items="groups" item-title="name" item-value="id" label="Wiki groups" hint="Select at least one group." persistent-hint multiple chips closable-chips />
          </section>
        </v-form>
      </v-card-text>
      <v-card-actions class="skill-dialog__actions"><v-alert v-if="createError" class="skill-dialog__error" type="error" variant="tonal" density="compact">{{ createError }}</v-alert><v-spacer /><v-btn :disabled="actionBusyId === 'create'" @click="createOpen = false">Cancel</v-btn><v-btn color="primary" prepend-icon="mdi-check" form="skill-create-form" type="submit" :disabled="!createValid || Boolean(actionBusyId)" :loading="actionBusyId === 'create'">Map skill</v-btn></v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog v-model="accessOpen" max-width="40rem" scrollable :fullscreen="smAndDown" aria-labelledby="skill-access-title" :persistent="actionBusyId === 'access'">
    <v-card class="skill-dialog">
      <div class="skill-dialog__header"><span><v-icon size="23">mdi-account-multiple-outline</v-icon></span><div><div class="skill-eyebrow">Audience policy</div><h2 id="skill-access-title">{{ policySkill ? `Access for ${policySkill.name}` : 'Skill access' }}</h2><p>Control who receives this organization-approved expertise.</p></div><v-spacer /><v-btn icon="mdi-close" variant="text" aria-label="Close audience editor" :disabled="actionBusyId === 'access'" @click="accessOpen = false" /></div>
      <v-card-text class="skill-dialog__body"><v-alert v-if="accessError" class="skill-error" type="error" variant="tonal" density="compact">{{ accessError }}</v-alert><v-select v-model="policy.exposureMode" :items="exposureModes" item-title="title" item-value="value" label="Available to" /><v-autocomplete v-if="policy.exposureMode === 'groups'" v-model="policy.groupIds" :items="groups" item-title="name" item-value="id" label="Wiki groups" multiple chips closable-chips hint="Users receive this skill through any selected group." persistent-hint /></v-card-text>
      <v-card-actions class="skill-dialog__actions"><v-spacer /><v-btn :disabled="actionBusyId === 'access'" @click="accessOpen = false">Cancel</v-btn><v-btn color="primary" :loading="actionBusyId === 'access'" :disabled="Boolean(actionBusyId) || !policyDirty || (policy.exposureMode === 'groups' && policy.groupIds.length === 0)" @click="saveAccess">Save audience policy</v-btn></v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog v-model="previewOpen" max-width="70rem" scrollable :fullscreen="smAndDown" aria-labelledby="skill-preview-title" :persistent="actionBusyId === 'approve' || actionBusyId === 'reject'" @after-leave="onPreviewAfterLeave">
    <v-card v-if="preview" class="skill-dialog skill-review">
      <div class="skill-dialog__header"><span><v-icon size="23">mdi-file-eye-outline</v-icon></span><div><div class="skill-eyebrow">Immutable organization source</div><h2 id="skill-preview-title">Review {{ preview.name }}</h2><p>Approve only the exact candidate revision shown below.</p></div><v-spacer /><v-btn icon="mdi-close" variant="text" aria-label="Close skill review" :disabled="actionBusyId === 'approve' || actionBusyId === 'reject'" @click="previewOpen = false" /></div>
      <v-card-text class="skill-dialog__body">
        <v-alert v-if="previewError" class="skill-error" type="error" variant="tonal" density="compact">{{ previewError }}</v-alert>
        <v-alert v-if="preview.previousSkillMarkdown === null" class="skill-boundary" type="info" variant="tonal">This is the first candidate revision. No previously approved source exists.</v-alert>
        <dl class="review-metadata">
          <div><dt>Content hash</dt><dd><code :title="preview.contentHash">{{ preview.contentHash }}</code></dd></div>
          <div><dt>Source revision</dt><dd><code :title="preview.sourceRevision">{{ preview.sourceRevision }}</code></dd></div>
          <div><dt>Source updated</dt><dd>{{ preview.sourceUpdatedAt }}</dd></div>
          <div><dt>Bundle size</dt><dd>{{ preview.totalBytes }} bytes</dd></div>
        </dl>
        <div v-if="preview.previousSkillMarkdown !== null" class="source-heading"><div><span>Change review</span><h3>Candidate compared with approved revision</h3></div><v-chip size="x-small" variant="tonal" color="primary">Line differences</v-chip></div>
        <v-alert v-if="preview.previousSkillMarkdown !== null && reviewLinesTruncated" class="skill-boundary review-diff-notice" type="info" variant="tonal" density="compact">
          Showing the first {{ MAX_REVIEW_LINES }} lines of {{ reviewLineCount }}. Read the complete candidate and approved sources below before deciding.
        </v-alert>
        <div v-if="preview.previousSkillMarkdown !== null" class="review-diff" role="table" aria-label="Skill revision changes">
          <div class="review-diff__header" role="row"><span role="columnheader">Candidate revision</span><span role="columnheader">Previously approved</span></div>
          <div v-for="(line, index) in reviewLines" :key="index" class="review-diff__row" :class="`review-diff__row--${line.kind}`" role="row">
            <code role="cell">{{ line.candidate }}</code><code role="cell">{{ line.previous }}</code>
          </div>
        </div>
        <div class="source-heading"><div><span>Candidate</span><h3>SKILL.md</h3></div><v-chip size="x-small" variant="tonal" color="primary">Exact source</v-chip></div>
        <pre class="source-view" tabindex="0">{{ preview.skillMarkdown }}</pre>
        <template v-if="preview.previousSkillMarkdown !== null">
          <div class="source-heading"><div><span>Previously approved</span><h3>SKILL.md</h3></div></div>
          <pre class="source-view" tabindex="0">{{ preview.previousSkillMarkdown }}</pre>
        </template>
      </v-card-text>
      <v-card-actions class="skill-dialog__actions skill-dialog__actions--review"><v-btn color="error" variant="text" prepend-icon="mdi-close-octagon-outline" :loading="actionBusyId === 'reject'" :disabled="Boolean(actionBusyId)" @click="review(false)">Reject candidate</v-btn><v-spacer /><v-btn :disabled="actionBusyId === 'approve' || actionBusyId === 'reject'" @click="previewOpen = false">Cancel</v-btn><v-btn color="primary" prepend-icon="mdi-check-decagram-outline" :loading="actionBusyId === 'approve'" :disabled="Boolean(actionBusyId)" @click="review(true)">Approve exact revision</v-btn></v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useDisplay } from 'vuetify'
import { z } from 'zod'
import { sameOriginJsonFetch } from '../../helpers/json-transport.ts'
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
const search = ref('')
const stateFilter = ref<'all' | 'enabled' | 'disabled' | 'review'>('all')
const loading = ref(false)
const loaded = ref(false)
const actionBusyId = ref('')
const error = ref('')
let reloadController: AbortController | null = null
let reloadGeneration = 0
let disposed = false
let previewController: AbortController | null = null
const createError = ref('')
const accessError = ref('')
const previewError = ref('')
const createOpen = ref(false)
const accessOpen = ref(false)
const previewOpen = ref(false)
const policySkill = ref<Skill | null>(null)
const policy = reactive({
  exposureMode: 'all_agent_users' as 'all_agent_users' | 'groups',
  groupIds: [] as number[]
})
const create = reactive({
  name: '',
  rootPageId: 0,
  rootPath: '',
  assetFolderId: '',
  exposureMode: 'all_agent_users' as 'all_agent_users' | 'groups',
  groupIds: [] as number[]
})
const MAX_REVIEW_LINES = 500
const reviewSourceLines = computed(() => ({
  candidate: preview.value?.skillMarkdown.split('\n') ?? [],
  previous: preview.value?.previousSkillMarkdown?.split('\n') ?? []
}))
const reviewLineCount = computed(() => Math.max(reviewSourceLines.value.candidate.length, reviewSourceLines.value.previous.length))
const reviewLinesTruncated = computed(() => reviewLineCount.value > MAX_REVIEW_LINES)
const reviewLines = computed(() => {
  const { candidate, previous } = reviewSourceLines.value
  const length = Math.min(Math.max(candidate.length, previous.length), MAX_REVIEW_LINES)
  return Array.from({ length }, (_, index) => {
    const candidateLine = candidate[index] ?? ''
    const previousLine = previous[index] ?? ''
    return { candidate: candidateLine, previous: previousLine, kind: candidateLine === previousLine ? 'same' : !previousLine ? 'added' : !candidateLine ? 'removed' : 'changed' }
  })
})
const exposureModes = [
  { title: 'Everyone (default)', value: 'all_agent_users' },
  { title: 'Selected Wiki groups', value: 'groups' }
]
const stateFilters = [
  { title: 'All policy states', value: 'all' },
  { title: 'Enabled', value: 'enabled' },
  { title: 'Disabled', value: 'disabled' },
  { title: 'Needs review', value: 'review' }
]
const createNameValid = computed(() => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(create.name.trim()))
const createRootPageValid = computed(() => Number.isInteger(create.rootPageId) && create.rootPageId > 0)
const createAssetFolderValid = computed(() => create.assetFolderId === '' || (Number.isInteger(Number(create.assetFolderId)) && Number(create.assetFolderId) > 0))
const createNameRules = [(): true | string => createNameValid.value || 'Use lowercase letters, numbers, and single hyphens.']
const createRootPageRules = [(): true | string => createRootPageValid.value || 'Enter a positive whole number.']
const createAssetFolderRules = [(): true | string => createAssetFolderValid.value || 'Enter a positive whole number or leave this blank.']
const createValid = computed(() => createNameValid.value && createRootPageValid.value && createAssetFolderValid.value && Boolean(create.rootPath.trim()) && (create.exposureMode !== 'groups' || create.groupIds.length > 0))

const request = async (url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> => {
  const response = await sameOriginJsonFetch(window.fetch.bind(window), url, {
    ...init,
    ...(signal ? { signal } : {}),
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
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
  if (disposed) return
  reloadController?.abort()
  const controller = new AbortController()
  reloadController = controller
  const generation = ++reloadGeneration
  loading.value = true
  error.value = ''
  try {
    const [result, groupResult] = await Promise.all([
      request('/_api/agents/admin/skills', {}, controller.signal),
      request('/_api/groups', {}, controller.signal)
    ])
    if (generation !== reloadGeneration) return
    skills.value = z.object({ skills: z.array(SkillSchema) }).parse(result).skills
    groups.value = z.array(GroupSchema).parse(groupResult)
    loaded.value = true
  } catch (requestError: unknown) {
    if (generation !== reloadGeneration || controller.signal.aborted) return
    error.value = requestError instanceof Error ? requestError.message : 'Unable to load skills'
  } finally {
    if (generation === reloadGeneration) {
      loading.value = false
      if (reloadController === controller) reloadController = null
    }
  }
}
const openCreate = (): void => {
  createError.value = ''
  Object.assign(create, { name: '', rootPageId: 0, rootPath: '', assetFolderId: '', exposureMode: 'all_agent_users', groupIds: [] })
  createOpen.value = true
}
const createSkill = async (): Promise<void> => {
  if (!createValid.value || actionBusyId.value) return
  actionBusyId.value = 'create'; createError.value = ''
  try {
    await request('/_api/agents/admin/skills', { method: 'POST', body: JSON.stringify({ name: create.name.trim(), rootPageId: create.rootPageId, rootPath: create.rootPath.trim(), assetFolderId: create.assetFolderId === '' ? null : Number(create.assetFolderId), exposureMode: create.exposureMode, groupIds: create.exposureMode === 'groups' ? create.groupIds : [] }) })
    createOpen.value = false; await reload()
  } catch (requestError: unknown) { createError.value = requestError instanceof Error ? requestError.message : 'Unable to map skill' }
  finally { actionBusyId.value = '' }
}
const groupsById = computed(() => new Map(groups.value.map(group => [group.id, group.name])))
const groupNames = (groupIds: readonly number[]): string => groupIds.map(id => groupsById.value.get(id) ?? `Group ${id}`).join(', ')
const enabledSkillCount = computed(() => skills.value.filter(skill => skill.status === 'enabled').length)
const compareNames = (left: string, right: string): number => {
  const leftName = left.toLowerCase()
  const rightName = right.toLowerCase()
  if (leftName < rightName) return -1
  if (leftName > rightName) return 1
  return left < right ? -1 : left > right ? 1 : 0
}
const filteredSkills = computed(() => {
  const query = search.value.trim().toLowerCase()
  return skills.value
    .filter(skill => {
      if (stateFilter.value === 'enabled' && skill.status !== 'enabled') return false
      if (stateFilter.value === 'disabled' && skill.status !== 'disabled') return false
      if (stateFilter.value === 'review' && !skill.drifted && skill.currentVersionId) return false
      if (!query) return true
      const audience = skill.exposureMode === 'all_agent_users' ? 'all agent users everyone' : groupNames(skill.groupIds)
      return [skill.name, skill.rootPath, skill.approvedSourceRevision ?? '', skill.liveSourceRevision, audience]
        .some(value => value.toLowerCase().includes(query))
    })
    .sort((left, right) => compareNames(left.name, right.name))
})
const clearFilters = (): void => {
  search.value = ''
  stateFilter.value = 'all'
}
const sameIdSet = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every(id => right.includes(id))
const policyDirty = computed(() => Boolean(policySkill.value) && (
  policy.exposureMode !== policySkill.value?.exposureMode ||
  !sameIdSet(policy.groupIds, policySkill.value?.groupIds ?? [])
))
const openAccess = (skill: Skill): void => { accessError.value = ''; policySkill.value = skill; policy.exposureMode = skill.exposureMode; policy.groupIds = [...skill.groupIds]; accessOpen.value = true }
const saveAccess = async (): Promise<void> => {
  const skill = policySkill.value
  if (!skill || actionBusyId.value || !policyDirty.value || (policy.exposureMode === 'groups' && policy.groupIds.length === 0)) return
  actionBusyId.value = 'access'; accessError.value = ''
  try {
    await request(`/_api/agents/admin/skills/${skill.id}/policy`, { method: 'POST', body: JSON.stringify({ assetFolderId: skill.assetFolderId, exposureMode: policy.exposureMode, groupIds: policy.exposureMode === 'groups' ? policy.groupIds : [] }) })
    accessOpen.value = false; await reload()
  } catch (requestError: unknown) { accessError.value = requestError instanceof Error ? requestError.message : 'Unable to change skill access' }
  finally { actionBusyId.value = '' }
}
const openPreview = async (skillId: string): Promise<void> => {
  if (actionBusyId.value) return
  actionBusyId.value = `preview:${skillId}`; previewError.value = ''
  const controller = new AbortController()
  previewController = controller
  try {
    const result = await request(`/_api/agents/admin/skills/${skillId}/preview`, {}, controller.signal)
    if (disposed) return
    preview.value = PreviewSchema.parse(result)
    previewOpen.value = true
  }
  catch (requestError: unknown) {
    if (disposed || controller.signal.aborted) return
    previewError.value = requestError instanceof Error ? requestError.message : 'Unable to preview skill'
    error.value = previewError.value
  } finally {
    if (previewController === controller) previewController = null
    actionBusyId.value = ''
  }
}
const onPreviewAfterLeave = (): void => {
  if (!previewOpen.value) preview.value = null
}
const review = async (approved: boolean): Promise<void> => {
  if (!preview.value || actionBusyId.value) return
  actionBusyId.value = approved ? 'approve' : 'reject'; previewError.value = ''
  try {
    await request(`/_api/agents/admin/skills/${preview.value.skillId}/${approved ? 'approve' : 'reject'}`, { method: 'POST', body: JSON.stringify({ expectedContentHash: preview.value.contentHash, expectedSourceRevision: preview.value.sourceRevision }) })
    previewOpen.value = false; await reload()
  } catch (requestError: unknown) { previewError.value = requestError instanceof Error ? requestError.message : 'Unable to review skill' }
  finally { actionBusyId.value = '' }
}
const setEnabled = async (skillId: string, enabled: boolean): Promise<void> => {
  if (actionBusyId.value) return
  actionBusyId.value = `enabled:${skillId}`; error.value = ''
  try { await request(`/_api/agents/admin/skills/${skillId}/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }); await reload() }
  catch (requestError: unknown) { error.value = requestError instanceof Error ? requestError.message : 'Unable to change skill state' }
  finally { actionBusyId.value = '' }
}

onMounted(reload)
onBeforeUnmount(() => {
  disposed = true
  reloadGeneration++
  previewController?.abort()
  reloadController?.abort()
})
</script>

<style scoped>
.skill-governance {
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  color: rgb(var(--v-theme-on-surface));
  box-shadow: var(--wiki-shadow-sm), var(--wiki-shadow-inset);
}

.skill-governance--standalone {
  max-width: 76rem;
  margin-inline: auto;
}

.skill-governance__header {
  display: flex;
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-12));
  align-items: center;
  justify-content: space-between;
  gap: var(--wiki-space-5);
  padding: var(--wiki-space-5) var(--wiki-space-6);
  border-bottom: 1px solid var(--wiki-surface-border);
  background:
    linear-gradient(115deg, color-mix(in srgb, var(--wiki-accent-warm) 7%, transparent), transparent 48%),
    var(--wiki-surface-raised);
}

.skill-governance__heading {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--wiki-space-3);
}

.skill-governance__mark,
.skill-record__mark,
.skill-empty > span,
.skill-dialog__header > span,
.skill-form-section__heading > span {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 20%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--wiki-accent-warm) 9%, var(--wiki-surface-raised));
  color: var(--wiki-accent-warm);
  box-shadow: var(--wiki-shadow-inset);
}

.skill-governance__mark {
  width: var(--wiki-control-height);
  height: var(--wiki-control-height);
}

.skill-eyebrow {
  color: var(--wiki-accent-warm);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .11em;
  text-transform: uppercase;
}

.skill-governance__header h2 {
  margin: var(--wiki-space-1) 0;
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-heading);
  font-size: 1.2rem;
  font-weight: 740;
  letter-spacing: -.025em;
  line-height: var(--wiki-leading-heading);
}

.skill-governance__header p,
.skill-dialog__header p {
  margin: 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
  font-size: .78rem;
  line-height: 1.5;
}

.skill-governance__header-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--wiki-space-2);
}

.skill-governance__body {
  padding: var(--wiki-space-5);
}

.skill-boundary,
.skill-error {
  margin-bottom: var(--wiki-space-4);
  border: 1px solid var(--wiki-surface-border);
}

.skill-inventory-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(12rem, .32fr);
  gap: var(--wiki-space-3);
  align-items: center;
  padding: var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
  box-shadow: var(--wiki-shadow-inset);
}

.skill-inventory-toolbar :deep(.v-field) {
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-raised);
}

.skill-inventory-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-3) var(--wiki-space-1);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
  font-size: .75rem;
}

.skill-inventory-summary strong {
  color: rgb(var(--v-theme-on-surface));
  font-variant-numeric: tabular-nums;
}

.skill-inventory-summary__legend {
  display: inline-flex;
  align-items: center;
  gap: var(--wiki-space-1);
  color: color-mix(in srgb, rgb(var(--v-theme-success)) 82%, rgb(var(--v-theme-on-surface)));
}

.skill-loading {
  display: grid;
  gap: var(--wiki-space-3);
  margin-top: var(--wiki-space-4);
}

.skill-inventory {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 28rem), 1fr));
  gap: var(--wiki-space-3);
}
.skill-record {
  display: flex;
  min-width: 0;
  overflow: hidden;
  content-visibility: auto;
  contain-intrinsic-size: auto 22rem;
  flex-direction: column;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  transition:
    border-color var(--wiki-motion-normal) var(--wiki-motion-ease),
    box-shadow var(--wiki-motion-normal) var(--wiki-motion-ease),
    transform var(--wiki-motion-normal) var(--wiki-motion-ease-out);
}

.skill-record:hover,
.skill-record:focus-within {
  border-color: var(--wiki-surface-border-strong);
  box-shadow: var(--wiki-shadow-sm), var(--wiki-shadow-inset);
  transform: translateY(calc(var(--wiki-space-1) * -.25));
}

.skill-record__top {
  display: flex;
  align-items: flex-start;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-4);
}

.skill-record__mark {
  width: calc(var(--wiki-control-height) - var(--wiki-space-1));
  height: calc(var(--wiki-control-height) - var(--wiki-space-1));
}

.skill-record__identity {
  min-width: 0;
  flex: 1 1 auto;
}

.skill-record__title-line {
  display: flex;
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
}

.skill-record__identity h3 {
  overflow: hidden;
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-heading);
  font-size: .95rem;
  font-weight: 720;
  letter-spacing: -.015em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-record__identity > code {
  display: block;
  overflow: hidden;
  max-width: 100%;
  margin-top: var(--wiki-space-1);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  font-family: var(--wiki-font-mono);
  font-size: var(--wiki-label-size);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-record__trust {
  display: flex;
  align-items: flex-start;
  gap: var(--wiki-space-2);
  margin-inline: var(--wiki-space-4);
  padding: var(--wiki-space-3);
  border-inline-start: var(--wiki-space-1) solid rgb(var(--v-theme-success));
  border-radius: var(--wiki-radius-xs);
  background: color-mix(in srgb, rgb(var(--v-theme-success)) 8%, var(--wiki-surface-sunken));
  color: color-mix(in srgb, rgb(var(--v-theme-success)) 78%, rgb(var(--v-theme-on-surface)));
}

.skill-record__trust--warning {
  border-inline-start-color: rgb(var(--v-theme-warning));
  background: color-mix(in srgb, rgb(var(--v-theme-warning)) 9%, var(--wiki-surface-sunken));
  color: color-mix(in srgb, rgb(var(--v-theme-warning)) 76%, rgb(var(--v-theme-on-surface)));
}

.skill-record__trust > span {
  display: grid;
  min-width: 0;
  gap: var(--wiki-space-1);
}

.skill-record__trust strong {
  color: rgb(var(--v-theme-on-surface));
  font-size: .75rem;
  font-weight: 700;
}

.skill-record__trust small {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
  font-size: var(--wiki-label-size);
  line-height: 1.45;
}

.skill-record__metadata {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: var(--wiki-space-4) 0 0;
  border-block: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-sunken);
}

.skill-record__metadata > div {
  min-width: 0;
  padding: var(--wiki-space-3);
}

.skill-record__metadata > div + div {
  border-inline-start: 1px solid var(--wiki-surface-border);
}

.skill-record__metadata dt,
.review-metadata dt {
  margin-bottom: var(--wiki-space-1);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .06em;
  text-transform: uppercase;
}

.skill-record__metadata dd,
.review-metadata dd {
  overflow: hidden;
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-size: .72rem;
  font-weight: 620;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-record__review {
  display: flex;
  width: 100%;
  min-height: var(--wiki-control-height);
  align-items: center;
  justify-content: space-between;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-2) var(--wiki-space-4);
  border: 0;
  background: transparent;
  color: var(--wiki-accent-warm);
  cursor: pointer;
  font: inherit;
  font-size: .72rem;
  font-weight: 680;
  text-align: start;
}

.skill-record__review > span {
  display: inline-flex;
  align-items: center;
  gap: var(--wiki-space-2);
}

.skill-record__review:hover {
  background: color-mix(in srgb, var(--wiki-accent-warm) 6%, transparent);
}

.skill-record__review:focus-visible {
  outline: none;
  box-shadow: inset var(--wiki-focus-ring);
}

.skill-record__review:disabled {
  cursor: not-allowed;
  opacity: .48;
}

.skill-empty {
  display: grid;
  min-height: 20rem;
  place-items: center;
  align-content: center;
  padding: var(--wiki-space-12) var(--wiki-space-6);
  text-align: center;
}

.skill-empty--search {
  min-height: 15rem;
}

.skill-empty > span {
  width: calc(var(--wiki-control-height) + var(--wiki-space-6));
  height: calc(var(--wiki-control-height) + var(--wiki-space-6));
  margin-bottom: var(--wiki-space-4);
  border-radius: var(--wiki-panel-radius);
}

.skill-empty h3 {
  margin: var(--wiki-space-1) 0;
  font-family: var(--wiki-font-heading);
  font-size: 1.05rem;
  font-weight: 720;
}

.skill-empty p {
  max-width: 32rem;
  margin: var(--wiki-space-1) 0 var(--wiki-space-4);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
  font-size: .78rem;
  line-height: 1.55;
}

.skill-dialog {
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius) !important;
  background: var(--wiki-surface-raised) !important;
  color: rgb(var(--v-theme-on-surface));
  box-shadow: var(--wiki-shadow-lg), var(--wiki-shadow-inset) !important;
}

.skill-dialog__header {
  display: flex;
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-10));
  align-items: center;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-4) var(--wiki-space-5);
  border-bottom: 1px solid var(--wiki-surface-border);
  background:
    linear-gradient(110deg, color-mix(in srgb, var(--wiki-accent-warm) 7%, transparent), transparent 55%),
    var(--wiki-surface-raised);
}

.skill-dialog__header > span {
  width: var(--wiki-control-height);
  height: var(--wiki-control-height);
}

.skill-dialog__header > div {
  min-width: 0;
}

.skill-dialog__header h2 {
  margin: var(--wiki-space-1) 0;
  font-family: var(--wiki-font-heading);
  font-size: 1.1rem;
  font-weight: 730;
  letter-spacing: -.025em;
}

.skill-dialog__body {
  padding: var(--wiki-space-5) !important;
}

.skill-dialog__actions {
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-4));
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-3) var(--wiki-space-4) !important;
  border-top: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-sunken);
}

.skill-dialog__error {
  min-width: min(22rem, 100%);
}

.skill-form-section + .skill-form-section {
  margin-top: var(--wiki-space-4);
  padding-top: var(--wiki-space-4);
  border-top: 1px solid var(--wiki-surface-border);
}

.skill-form-section__heading {
  display: flex;
  align-items: flex-start;
  gap: var(--wiki-space-3);
  margin-bottom: var(--wiki-space-4);
}

.skill-form-section__heading > span {
  width: calc(var(--wiki-control-height) - var(--wiki-space-2));
  height: calc(var(--wiki-control-height) - var(--wiki-space-2));
}

.skill-form-section__heading h3 {
  margin: 0;
  font-size: .86rem;
  font-weight: 700;
}

.skill-form-section__heading p {
  margin: var(--wiki-space-1) 0 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-size: .7rem;
}

.skill-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 var(--wiki-space-4);
}

.skill-form-grid__wide {
  grid-column: 1 / -1;
}

.review-metadata {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--wiki-space-2);
  margin: 0 0 var(--wiki-space-6);
}

.review-metadata > div {
  min-width: 0;
  padding: var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
  box-shadow: var(--wiki-shadow-inset);
}

.review-diff {
  overflow: auto;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
}

.review-diff-notice {
  margin-bottom: var(--wiki-space-2);
}

.review-diff__header {
  display: grid;
  min-width: 42rem;
  grid-template-columns: 1fr 1fr;
  border-bottom: 1px solid var(--wiki-surface-border-strong);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .06em;
  text-transform: uppercase;
}

.review-diff__header span {
  padding: var(--wiki-space-2) var(--wiki-space-3);
}

.review-diff__header span + span {
  border-inline-start: 1px solid var(--wiki-surface-border);
}
.review-diff__row {
  display: grid;
  min-width: 42rem;
  grid-template-columns: 1fr 1fr;
}

.review-diff__row code {
  overflow-wrap: anywhere;
  padding: var(--wiki-space-2) var(--wiki-space-3);
  border-bottom: 1px solid var(--wiki-surface-border);
  font-family: var(--wiki-font-mono);
  font-size: .75rem;
  white-space: pre-wrap;
}

.review-diff__row code + code {
  border-inline-start: 1px solid var(--wiki-surface-border);
}

.review-diff__row--added code:first-child {
  background: color-mix(in srgb, rgb(var(--v-theme-success)) 10%, transparent);
}

.review-diff__row--removed code:last-child {
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 10%, transparent);
}

.review-diff__row--changed code {
  background: color-mix(in srgb, rgb(var(--v-theme-warning)) 9%, transparent);
}

.source-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--wiki-space-4);
  margin: var(--wiki-space-5) 0 var(--wiki-space-2);
}

.source-heading span {
  color: var(--wiki-accent-warm);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .08em;
  text-transform: uppercase;
}

.source-heading h3 {
  margin: var(--wiki-space-1) 0 0;
  font-size: .95rem;
}

.source-view {
  max-height: 25rem;
  overflow: auto;
  margin: 0;
  padding: var(--wiki-space-4);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-mono);
  font-size: .75rem;
  line-height: 1.6;
  white-space: pre-wrap;
  scrollbar-color: var(--wiki-surface-border-strong) transparent;
}

.source-view:focus-visible {
  outline: none;
  border-color: var(--wiki-focus-color);
  box-shadow: var(--wiki-focus-ring);
}

code {
  overflow-wrap: anywhere;
  font-family: var(--wiki-font-mono);
}

:global(.skill-dialog .v-messages) {
  opacity: 1 !important;
}

:global(.skill-dialog .v-field-label),
:global(.skill-dialog .v-messages__message) {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 78%, transparent) !important;
  opacity: 1 !important;
}

@media (max-width: 760px) {
  .skill-governance__header {
    align-items: flex-start;
    flex-direction: column;
    padding: var(--wiki-space-4);
  }

  .skill-governance__header-actions {
    width: 100%;
    align-items: stretch;
    flex-direction: column;
  }

  .skill-governance__body {
    padding: var(--wiki-space-4);
  }

  .skill-inventory-toolbar,
  .skill-form-grid,
  .review-metadata {
    grid-template-columns: 1fr;
  }

  .skill-form-grid__wide {
    grid-column: auto;
  }

  .skill-record__metadata {
    grid-template-columns: 1fr;
  }

  .skill-record__metadata > div + div {
    border-block-start: 1px solid var(--wiki-surface-border);
    border-inline-start: 0;
  }

  .skill-inventory-summary {
    align-items: flex-start;
    flex-direction: column;
  }

  .skill-dialog {
    border: 0;
    border-radius: 0 !important;
  }

  .skill-dialog__header p {
    display: none;
  }

  .skill-dialog__actions {
    align-items: stretch;
    flex-wrap: wrap;
  }

  .skill-dialog__actions--review > .v-btn {
    flex: 1 1 auto;
  }

  .skill-dialog__error {
    flex: 1 1 100%;
  }
}

@media (max-width: 480px) {
  .skill-governance__heading,
  .skill-dialog__header {
    align-items: flex-start;
  }

  .skill-governance__mark,
  .skill-dialog__header > span {
    width: calc(var(--wiki-control-height) - var(--wiki-space-1));
    height: calc(var(--wiki-control-height) - var(--wiki-space-1));
  }

  .skill-record__top {
    padding: var(--wiki-space-3);
  }

  .skill-record__trust {
    margin-inline: var(--wiki-space-3);
  }

  .skill-dialog__actions > .v-btn {
    flex: 1 1 100%;
  }
}

@media (forced-colors: active) {
  .skill-governance,
  .skill-record,
  .skill-inventory-toolbar,
  .skill-dialog,
  .review-diff,
  .source-view {
    border: 1px solid CanvasText;
    box-shadow: none;
  }

  .skill-record__trust {
    border-inline-start-color: Highlight;
  }

  .skill-record__review:focus-visible,
  .source-view:focus-visible {
    outline: 2px solid Highlight;
    outline-offset: 2px;
    box-shadow: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .skill-record {
    transition: none;
  }

  .skill-record:hover,
  .skill-record:focus-within {
    transform: none;
  }
}
</style>
