<template>
  <main class="approval-surface" aria-labelledby="approval-title">
    <v-progress-linear v-if="loading" indeterminate color="primary" aria-label="Loading proposal" />
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-card v-if="proposal" variant="outlined">
      <v-card-title id="approval-title">Review Wiki change</v-card-title>
      <v-card-subtitle>Requested through MCP · {{ actionLabel }}</v-card-subtitle>
      <v-card-text>
        <v-alert v-if="proposal.risk === 'destructive-write'" type="warning" variant="tonal" class="mb-4">
          Destructive action. Deletion cannot be undone from this approval screen.
        </v-alert>
        <dl class="proposal-facts mb-4">
          <dt>Status</dt><dd>{{ proposal.approval.status }}</dd>
          <dt>Summary</dt><dd>{{ proposal.summary }}</dd>
          <dt v-if="proposal.path">Path</dt><dd v-if="proposal.path"><code>{{ proposal.path }}</code></dd>
          <dt v-if="proposal.baseSourceRevision">Base revision</dt><dd v-if="proposal.baseSourceRevision"><code>{{ proposal.baseSourceRevision }}</code></dd>
          <dt>Expires</dt><dd>{{ new Date(proposal.expiresAt).toLocaleString() }}</dd>
          <dt>Input hash</dt><dd><code>{{ proposal.inputHash }}</code></dd>
        </dl>
        <section v-if="proposal.diff" aria-labelledby="proposal-diff-title">
          <h2 id="proposal-diff-title" class="text-body-large mb-2">Exact proposed diff</h2>
          <pre class="proposal-diff" tabindex="0"><template v-for="(line, index) in visibleDiff" :key="index"><ins v-if="line.kind === 'insert'">{{ line.text }}</ins><del v-else-if="line.kind === 'delete'">{{ line.text }}</del><span v-else>{{ line.text }}</span>{{ '\n' }}</template></pre>
          <v-btn v-if="diffLines.length > collapsedLineCount" class="mt-2" variant="text" @click="expanded = !expanded">
            {{ expanded ? 'Show fewer lines' : `Show all ${diffLines.length} lines` }}
          </v-btn>
        </section>
        <v-textarea v-model="decisionNote" class="mt-4" label="Decision note (optional)" maxlength="4000" rows="2" />
        <v-text-field
          v-if="proposal.risk === 'destructive-write' && proposal.approval.status === 'pending'"
          v-model="confirmationPath"
          label="Type the exact page path to confirm deletion"
          :hint="proposal.confirmationPath ?? ''"
          persistent-hint
          autocomplete="off"
        />
        <v-alert v-if="proposal.approval.status !== 'pending'" class="mt-4" :type="proposal.approval.status === 'approved' ? 'success' : 'info'" variant="tonal">
          This proposal is {{ proposal.approval.status }}. Return to the MCP client to continue.
        </v-alert>
      </v-card-text>
      <v-card-actions v-if="proposal.approval.status === 'pending'">
        <v-btn variant="outlined" :disabled="deciding" @click="decide('denied')">Deny</v-btn>
        <v-spacer />
        <v-btn
          color="primary"
          :loading="deciding"
          :disabled="proposal.risk === 'destructive-write' && confirmationPath !== proposal.confirmationPath"
          @click="decide('approved')"
        >Approve exact proposal</v-btn>
      </v-card-actions>
    </v-card>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { decideAgentProposal, getMcpAgentProposal, type McpAgentProposal } from '../../helpers/agents-api.ts'

const props = defineProps<{ csrfToken: string; proposalId: string }>()
const collapsedLineCount = 300
const loading = ref(true)
const deciding = ref(false)
const error = ref('')
const proposal = ref<McpAgentProposal | null>(null)
const expanded = ref(false)
const decisionNote = ref('')
const confirmationPath = ref('')
const actionLabel = computed(() => proposal.value?.actionName.replace('pages.prepare', '') ?? '')
const diffLines = computed(() => (proposal.value?.diff ?? '').split('\n').map(text => ({
  text,
  kind: text.startsWith('+') && !text.startsWith('+++') ? 'insert' : text.startsWith('-') && !text.startsWith('---') ? 'delete' : 'context'
} as const)))
const visibleDiff = computed(() => expanded.value ? diffLines.value : diffLines.value.slice(0, collapsedLineCount))

const load = async (): Promise<void> => {
  if (!props.proposalId) {
    error.value = 'Proposal URL is invalid.'
    loading.value = false
    return
  }
  try {
    proposal.value = await getMcpAgentProposal(window.fetch.bind(window), props.csrfToken, props.proposalId)
  } catch (value) {
    error.value = value instanceof Error ? value.message : 'Proposal could not be loaded.'
  } finally {
    loading.value = false
  }
}

const decide = async (decision: 'approved' | 'denied'): Promise<void> => {
  if (!proposal.value || deciding.value) return
  deciding.value = true
  error.value = ''
  try {
    await decideAgentProposal(window.fetch.bind(window), props.csrfToken, proposal.value.id, proposal.value.approval.id, {
      decision,
      ...(decisionNote.value.trim() ? { decisionNote: decisionNote.value.trim() } : {}),
      ...(decision === 'approved' && proposal.value.confirmationPath ? { confirmationPath: confirmationPath.value } : {})
    })
    await load()
  } catch (value) {
    error.value = value instanceof Error ? value.message : 'Proposal decision failed.'
  } finally {
    deciding.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.approval-surface { margin-inline: auto; max-width: 64rem; }
.proposal-facts { display: grid; grid-template-columns: minmax(8rem, auto) minmax(0, 1fr); gap: .5rem 1rem; }
.proposal-facts dt { font-weight: 600; }
.proposal-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.proposal-diff { max-height: 32rem; overflow: auto; padding: 1rem; border: 1px solid currentColor; border-radius: .25rem; background: rgb(var(--v-theme-surface)); }
.proposal-diff ins, .proposal-diff del, .proposal-diff span { display: inline; text-decoration: none; }
.proposal-diff ins { border-inline-start: 3px solid currentColor; background: rgba(0, 128, 0, .16); }
.proposal-diff del { border-inline-start: 3px double currentColor; background: rgba(180, 0, 0, .16); text-decoration: line-through; }
@media (max-width: 599.98px) { .proposal-facts { grid-template-columns: 1fr; } .proposal-facts dt { margin-top: .5rem; } }
@media (forced-colors: active) { .proposal-diff ins { border-inline-start-style: solid; } .proposal-diff del { border-inline-start-style: double; } }
</style>
