<template>
  <article
    v-if="approvalPending"
    :id="`agent-approval-${proposal.id}`"
    class="agent-approval agent-approval--pending"
    tabindex="-1"
    :aria-labelledby="`agent-approval-title-${proposal.id}`"
  >
    <div class="agent-approval__identity text-body-small text-medium-emphasis">
      <v-icon icon="mdi-shield-alert-outline" color="warning" size="18" />
      <span>Wiki Agent · Approval required</span>
    </div>
    <h3 :id="`agent-approval-title-${proposal.id}`" class="text-title-medium mt-2">{{ approvalTitle }}</h3>
    <p class="text-body-medium mt-2 mb-3">{{ proposal.summary }}</p>
    <div class="d-flex flex-wrap ga-2 mb-3">
      <v-chip
        :color="proposal.risk === 'destructive-write' ? 'error' : 'warning'"
        size="small"
        variant="tonal"
        :prepend-icon="proposal.risk === 'destructive-write' ? 'mdi-alert-octagon-outline' : 'mdi-shield-outline'"
      >{{ proposal.risk === 'destructive-write' ? 'High risk' : 'Review required' }}</v-chip>
      <v-chip size="small" variant="outlined" prepend-icon="mdi-clock-outline">{{ expiryLabel }}</v-chip>
    </div>
    <dl class="proposal-metadata mb-3">
      <template v-if="proposal.target">
        <dt>Page</dt><dd>{{ proposal.target.locale }}/{{ proposal.target.path }}</dd>
      </template>
      <dt>Action</dt><dd>{{ tool.title }}</dd>
    </dl>
    <details v-if="diffLines.length" class="proposal-review mb-4">
      <summary>
        <v-icon icon="mdi-file-compare-outline" size="18" />
        <span>Review proposed changes</span>
      </summary>
      <div class="proposal-diff mt-3">
        <pre :aria-label="`Proposed changes for ${proposal.target?.path || proposal.actionName}`"><template v-for="(line, index) in visibleDiff" :key="index"><ins v-if="line.kind === 'insert'">{{ line.text }}</ins><del v-else-if="line.kind === 'delete'">{{ line.text }}</del><span v-else>{{ line.text }}</span>{{ '\n' }}</template></pre>
        <v-btn v-if="diffLines.length > collapsedLineCount" size="small" variant="text" @click="expanded = !expanded">
          {{ expanded ? 'Show less' : `Show full comparison (${diffLines.length} lines)` }}
        </v-btn>
      </div>
    </details>
    <v-text-field
      v-if="proposal.risk === 'destructive-write'"
      v-model="confirmationPath"
      class="mb-2"
      label="Type the exact page path to confirm deletion"
      :hint="proposal.target?.path || ''"
      persistent-hint
      autocomplete="off"
      spellcheck="false"
    />
    <div class="agent-approval__actions">
      <v-btn
        color="primary"
        :loading="busy"
        :disabled="busy || (proposal.risk === 'destructive-write' && confirmationPath !== proposal.target?.path)"
        @click="decide('approved')"
      >Approve changes</v-btn>
      <v-btn variant="outlined" :disabled="busy" @click="decide('denied')">Deny</v-btn>
    </div>
  </article>
  <details
    v-else
    :id="`agent-approval-${proposal.id}`"
    class="agent-approval-receipt"
  >
    <summary>
      <v-icon :icon="receiptIcon" :color="receiptColor" size="19" />
      <span>
        <strong>{{ receiptLabel }}</strong>
        <small v-if="proposal.target">{{ proposal.target.locale }}/{{ proposal.target.path }}</small>
      </span>
    </summary>
    <div class="agent-approval-receipt__details">
      <p>{{ proposal.summary }}</p>
      <dl class="proposal-metadata">
        <dt>Action</dt><dd>{{ proposal.actionName }}</dd>
        <template v-if="proposal.target"><dt>Page</dt><dd>{{ proposal.target.locale }}/{{ proposal.target.path }}</dd></template>
        <dt>Decision</dt><dd>{{ proposal.approval?.status ?? proposal.status }}</dd>
      </dl>
      <div v-if="diffLines.length" class="proposal-diff mt-3">
        <pre :aria-label="`Proposed changes for ${proposal.target?.path || proposal.actionName}`"><template v-for="(line, index) in visibleDiff" :key="index"><ins v-if="line.kind === 'insert'">{{ line.text }}</ins><del v-else-if="line.kind === 'delete'">{{ line.text }}</del><span v-else>{{ line.text }}</span>{{ '\n' }}</template></pre>
        <v-btn v-if="diffLines.length > collapsedLineCount" size="small" variant="text" @click="expanded = !expanded">
          {{ expanded ? 'Show less' : `Show full comparison (${diffLines.length} lines)` }}
        </v-btn>
      </div>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentProposalView, AgentToolCallView } from '../../../shared/agents/contracts.ts'
import { agentApprovalTitle, agentProposalReceiptLabel } from './agent-thread-presentation.ts'

const props = defineProps<{ tool: AgentToolCallView; proposal: AgentProposalView; busy?: boolean }>()
const emit = defineEmits<{ decision: [proposalId: string, approvalId: string, decision: 'approved' | 'denied', confirmationPath?: string] }>()
const collapsedLineCount = 80
const expanded = ref(false)
const confirmationPath = ref('')
const approvalPending = computed(() => props.proposal.status === 'pending' && props.proposal.approval?.status === 'pending')
const approvalTitle = computed(() => agentApprovalTitle(props.proposal.actionName))
const receiptLabel = computed(() => agentProposalReceiptLabel(props.proposal.status))
const receiptIcon = computed(() => {
  if (props.proposal.status === 'applied') return 'mdi-check-circle-outline'
  if (props.proposal.status === 'applying' || props.proposal.status === 'approved') return 'mdi-progress-clock'
  if (props.proposal.status === 'denied' || props.proposal.status === 'cancelled') return 'mdi-cancel'
  return 'mdi-alert-circle-outline'
})
const receiptColor = computed(() => {
  if (props.proposal.status === 'applied') return 'success'
  if (props.proposal.status === 'applying' || props.proposal.status === 'approved') return 'primary'
  return props.proposal.status === 'expired' ? 'warning' : 'error'
})
const expiryLabel = computed(() => {
  const milliseconds = new Date(props.proposal.expiresAt).valueOf() - Date.now()
  if (milliseconds <= 0) return 'Expired'
  const minutes = Math.ceil(milliseconds / 60_000)
  return minutes === 1 ? 'Expires in 1 minute' : `Expires in ${minutes} minutes`
})
const diffLines = computed(() => props.proposal.diff ? props.proposal.diff.split('\n').map(text => ({ text, kind: text.startsWith('+') && !text.startsWith('+++') ? 'insert' as const : text.startsWith('-') && !text.startsWith('---') ? 'delete' as const : 'context' as const })) : [])
const visibleDiff = computed(() => expanded.value ? diffLines.value : diffLines.value.slice(0, collapsedLineCount))
watch(() => props.proposal.id, () => { confirmationPath.value = ''; expanded.value = false })
const decide = (decision: 'approved' | 'denied') => {
  const approval = props.proposal.approval
  if (!approval) return
  emit('decision', props.proposal.id, approval.id, decision, props.proposal.risk === 'destructive-write' ? confirmationPath.value : undefined)
}
</script>

<style scoped>
.agent-approval { background: rgb(var(--v-theme-surface)); border: 1px solid rgb(var(--v-theme-warning)); border-inline-start-width: 4px; border-radius: .75rem; margin-bottom: 1rem; max-width: 54rem; padding: 1rem; }
.agent-approval:focus-visible { outline: 3px solid rgb(var(--v-theme-primary)); outline-offset: 2px; }
.agent-approval__identity, .agent-approval__actions { align-items: center; display: flex; flex-wrap: wrap; gap: .5rem; }
.proposal-metadata { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .25rem 1rem; }
.proposal-metadata dt { font-weight: 600; }
.proposal-metadata dd { margin: 0; overflow-wrap: anywhere; }
.proposal-review { border: 1px solid rgb(var(--v-theme-outline-variant)); border-radius: .5rem; padding: .65rem .75rem; }
.proposal-review summary, .agent-approval-receipt summary { align-items: center; cursor: pointer; display: flex; gap: .55rem; list-style: none; }
.proposal-review summary::-webkit-details-marker, .agent-approval-receipt summary::-webkit-details-marker { display: none; }
.proposal-review summary::after, .agent-approval-receipt summary::after { content: '›'; font-size: 1.25rem; margin-inline-start: auto; transform: rotate(90deg); }
.proposal-review[open] summary::after, .agent-approval-receipt[open] summary::after { transform: rotate(270deg); }
.proposal-diff { border: 1px solid rgb(var(--v-theme-outline-variant)); border-radius: .5rem; overflow: hidden; }
.proposal-diff pre { margin: 0; max-height: 30rem; overflow: auto; padding: .75rem; white-space: pre-wrap; word-break: break-word; }
.proposal-diff ins, .proposal-diff del, .proposal-diff span { display: inline; text-decoration: none; }
.proposal-diff ins { background: rgba(46, 160, 67, .22); }
.proposal-diff del { background: rgba(248, 81, 73, .22); }
.agent-approval-receipt { border: 1px solid rgb(var(--v-theme-outline-variant)); border-radius: .75rem; margin: 0 0 1rem; max-width: 54rem; padding: .75rem 1rem; }
.agent-approval-receipt summary span { display: grid; }
.agent-approval-receipt summary small { color: rgb(var(--v-theme-on-surface-variant)); font-weight: 400; overflow-wrap: anywhere; }
.agent-approval-receipt__details { border-top: 1px solid rgb(var(--v-theme-outline-variant)); margin-top: .75rem; padding-top: .75rem; }
@media (max-width: 599.98px) {
  .agent-approval__actions { align-items: stretch; flex-direction: column; }
  .agent-approval__actions :deep(.v-btn) { width: 100%; }
}
@media (forced-colors: active) { .proposal-diff ins { border-inline-start: 3px solid CanvasText; } .proposal-diff del { border-inline-start: 3px double CanvasText; text-decoration: line-through; } }
</style>
