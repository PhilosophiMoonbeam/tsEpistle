<template>
  <section class="approval-surface" aria-labelledby="approval-title" :aria-busy="loading">
    <h1 id="approval-title" class="approval-surface__heading">Review Wiki change</h1>
    <v-progress-linear v-if="loading" indeterminate color="primary" aria-label="Loading proposal" />
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4" role="alert">{{ error }}</v-alert>
    <v-card v-if="proposal" variant="outlined">
      <v-card-title>Review Wiki change</v-card-title>
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
        </dl>
        <details v-if="proposal.inputHash || proposal.patchHash || proposal.diffHash" class="proposal-verification mb-4">
          <summary>Technical verification</summary>
          <dl class="proposal-facts proposal-facts--technical mt-2">
            <template v-if="proposal.inputHash"><dt>Input hash</dt><dd><code>{{ proposal.inputHash }}</code></dd></template>
            <template v-if="proposal.patchHash"><dt>Patch hash</dt><dd><code>{{ proposal.patchHash }}</code></dd></template>
            <template v-if="proposal.diffHash"><dt>Diff hash</dt><dd><code>{{ proposal.diffHash }}</code></dd></template>
          </dl>
        </details>
        <section v-if="proposal.diff" aria-labelledby="proposal-diff-title">
          <h2 id="proposal-diff-title" class="text-body-large mb-2">Exact proposed diff</h2>
          <pre class="proposal-diff" tabindex="0" aria-label="Exact proposed diff"><template v-for="(line, index) in visibleDiff" :key="index"><ins v-if="line.kind === 'insert'">{{ line.text }}</ins><del v-else-if="line.kind === 'delete'">{{ line.text }}</del><span v-else>{{ line.text }}</span>{{ '\n' }}</template></pre>
          <v-btn v-if="diffLines.length > collapsedLineCount" class="mt-2" variant="text" @click="expanded = !expanded">
            {{ expanded ? 'Show fewer lines' : `Show all ${diffLines.length} lines` }}
          </v-btn>
        </section>
        <v-textarea v-if="proposal.approval.status === 'pending'" v-model="decisionNote" class="mt-4" label="Decision note (optional)" maxlength="4000" rows="2" />
        <v-text-field
          v-if="proposal.risk === 'destructive-write' && proposal.approval.status === 'pending'"
          v-model="confirmationPath"
          label="Type the exact page path to confirm deletion"
          :hint="proposal.confirmationPath ?? ''"
          persistent-hint
          autocomplete="off"
          spellcheck="false"
          autocapitalize="none"
          autocorrect="off"
        />
        <v-alert
          v-if="proposal.approval.status !== 'pending'"
          ref="settledReceipt"
          class="mt-4"
          :type="proposal.approval.status === 'approved' ? 'success' : 'info'"
          variant="tonal"
          role="status"
          aria-live="polite"
          tabindex="-1"
        >Decision saved: this proposal is {{ proposal.approval.status }}. Return to the MCP client to continue.</v-alert>
      </v-card-text>
      <v-card-actions v-if="proposal.approval.status === 'pending'" class="approval-actions">
        <v-btn variant="outlined" :disabled="Boolean(pendingDecision)" :loading="pendingDecision === 'denied'" @click="decide('denied')">Deny</v-btn>
        <v-spacer />
        <v-btn
          :color="proposal.risk === 'destructive-write' ? 'error' : 'primary'"
          :loading="pendingDecision === 'approved'"
          :disabled="Boolean(pendingDecision) || (proposal.risk === 'destructive-write' && confirmationPath !== proposal.confirmationPath)"
          @click="decide('approved')"
        >{{ approveLabel }}</v-btn>
      </v-card-actions>
    </v-card>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { decideAgentProposal, getMcpAgentProposal, type McpAgentProposal } from '../../helpers/agents-api.ts'

const props = defineProps<{ csrfToken: string; proposalId: string }>()
const collapsedLineCount = 300
const loading = ref(true)
const pendingDecision = ref<'approved' | 'denied' | null>(null)
const error = ref('')
const proposal = ref<McpAgentProposal | null>(null)
const expanded = ref(false)
const decisionNote = ref('')
const confirmationPath = ref('')
const settledReceipt = ref<{ $el: HTMLElement } | null>(null)
const actionLabel = computed(() => proposal.value?.actionName.replace('pages.prepare', '') ?? '')
const approveLabel = computed(() => proposal.value?.risk === 'destructive-write' ? 'Approve page deletion' : 'Approve exact proposal')
const diffLines = computed(() => (proposal.value?.diff ?? '').split('\n').map(text => ({
  text,
  kind: text.startsWith('+') && !text.startsWith('+++') ? 'insert' : text.startsWith('-') && !text.startsWith('---') ? 'delete' : 'context'
} as const)))
const visibleDiff = computed(() => expanded.value ? diffLines.value : diffLines.value.slice(0, collapsedLineCount))

const load = async (): Promise<void> => {
  loading.value = true
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
  if (!proposal.value || pendingDecision.value) return
  pendingDecision.value = decision
  error.value = ''
  try {
    await decideAgentProposal(window.fetch.bind(window), props.csrfToken, proposal.value.id, proposal.value.approval.id, {
      decision,
      ...(decisionNote.value.trim() ? { decisionNote: decisionNote.value.trim() } : {}),
      ...(decision === 'approved' && proposal.value.confirmationPath ? { confirmationPath: confirmationPath.value } : {})
    })
    await load()
    if (proposal.value?.approval.status !== 'pending') {
      await nextTick()
      settledReceipt.value?.$el.focus()
    }
  } catch (value) {
    error.value = value instanceof Error ? value.message : 'Proposal decision failed.'
  } finally {
    pendingDecision.value = null
  }
}

onMounted(load)
</script>

<style scoped>
.approval-surface {
  box-sizing: border-box;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  max-width: 64rem;
  overflow-y: auto;
  padding: clamp(.75rem, 2vw, 1.5rem);
  width: 100%;
}
.approval-surface__heading {
  border: 0;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  height: 1px;
  margin: -1px;
  overflow: hidden;
  padding: 0;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}
.proposal-facts { display: grid; grid-template-columns: minmax(8rem, auto) minmax(0, 1fr); gap: .5rem 1rem; }
.proposal-facts dt { font-weight: 600; }
.proposal-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.proposal-facts--technical { font-size: .82rem; }
.proposal-verification summary { cursor: pointer; font-weight: 600; }
.proposal-diff {
  max-height: 32rem;
  overflow: auto;
  padding: 1rem;
  border: 1px solid currentColor;
  border-radius: .25rem;
  background: rgb(var(--v-theme-surface));
}
.proposal-diff:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 2px; }
.proposal-diff ins, .proposal-diff del, .proposal-diff span { display: inline; text-decoration: none; }
.proposal-diff ins { border-inline-start: 3px solid currentColor; background: color-mix(in srgb, rgb(var(--v-theme-success)) 18%, transparent); }
.proposal-diff del { border-inline-start: 3px double currentColor; background: color-mix(in srgb, rgb(var(--v-theme-error)) 18%, transparent); text-decoration: line-through; }
.approval-actions { gap: .5rem; }
@media (max-width: 599.98px) {
  .proposal-facts { grid-template-columns: 1fr; }
  .proposal-facts dt { margin-top: .5rem; }
  .approval-actions { align-items: stretch; flex-direction: column; }
  .approval-actions .v-spacer { display: none; }
  .approval-actions .v-btn { width: 100%; }
}
@media (forced-colors: active) {
  .proposal-diff ins { border-inline-start-style: solid; }
  .proposal-diff del { border-inline-start-style: double; }
}
</style>
