<template>
  <v-card class="mb-3" variant="outlined" :aria-label="`${tool.title}: ${stateLabel}`">
    <v-card-item>
      <template #prepend><v-icon :icon="stateIcon" :color="stateColor" /></template>
      <v-card-title class="text-body-large">{{ tool.title }}</v-card-title>
      <v-card-subtitle>{{ tool.actionName }} · {{ stateLabel }}</v-card-subtitle>
    </v-card-item>
    <v-card-text v-if="tool.summary">{{ tool.summary }}</v-card-text>
    <template v-if="proposal && tool.state === 'awaitingApproval' && proposal.approval?.status === 'pending'">
      <v-card-text>
        <v-alert :type="proposal.risk === 'destructive-write' ? 'error' : 'warning'" variant="tonal" class="mb-3">
          Review the immutable proposal before allowing this action.
        </v-alert>
        <dl class="proposal-metadata mb-3">
          <dt>Action</dt><dd>{{ proposal.actionName }}</dd>
          <dt>Summary</dt><dd>{{ proposal.summary }}</dd>
          <template v-if="proposal.target"><dt>Page</dt><dd>{{ proposal.target.locale }}/{{ proposal.target.path }}</dd></template>
          <dt>Expires</dt><dd>{{ formattedExpiry }}</dd>
        </dl>
        <div v-if="proposal.diff" class="proposal-diff mb-3">
          <pre :aria-label="`Proposed changes for ${proposal.target?.path || proposal.actionName}`"><template v-for="(line, index) in visibleDiff" :key="index"><ins v-if="line.kind === 'insert'">{{ line.text }}</ins><del v-else-if="line.kind === 'delete'">{{ line.text }}</del><span v-else>{{ line.text }}</span>{{ '\n' }}</template></pre>
          <v-btn v-if="diffLines.length > collapsedLineCount" size="small" variant="text" @click="expanded = !expanded">
            {{ expanded ? 'Collapse comparison' : `Show full comparison (${diffLines.length} lines)` }}
          </v-btn>
        </div>
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
        <div class="d-flex flex-wrap ga-2">
          <v-btn
            color="primary"
            :loading="busy"
            :disabled="busy || (proposal.risk === 'destructive-write' && confirmationPath !== proposal.target?.path)"
            @click="decide('approved')"
          >Approve</v-btn>
          <v-btn variant="outlined" :disabled="busy" @click="decide('denied')">Deny</v-btn>
        </div>
      </v-card-text>
    </template>
  </v-card>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentProposalView, AgentToolCallView } from '../../../shared/agents/contracts.ts'

const props = defineProps<{ tool: AgentToolCallView; proposal?: AgentProposalView; busy?: boolean }>()
const emit = defineEmits<{ decision: [proposalId: string, approvalId: string, decision: 'approved' | 'denied', confirmationPath?: string] }>()
const labels: Record<AgentToolCallView['state'], string> = { preparing: 'Preparing', running: 'Running', awaitingApproval: 'Awaiting approval', complete: 'Complete', failed: 'Failed', denied: 'Denied', cancelled: 'Cancelled' }
const icons: Record<AgentToolCallView['state'], string> = { preparing: 'mdi-dots-horizontal', running: 'mdi-progress-clock', awaitingApproval: 'mdi-shield-alert-outline', complete: 'mdi-check-circle-outline', failed: 'mdi-alert-circle-outline', denied: 'mdi-cancel', cancelled: 'mdi-stop-circle-outline' }
const collapsedLineCount = 80
const expanded = ref(false)
const confirmationPath = ref('')
const stateLabel = computed(() => labels[props.tool.state])
const stateIcon = computed(() => icons[props.tool.state])
const stateColor = computed(() => props.tool.state === 'complete' ? 'success' : props.tool.state === 'failed' || props.tool.state === 'denied' ? 'error' : 'primary')
const formattedExpiry = computed(() => props.proposal ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(props.proposal.expiresAt)) : '')
const diffLines = computed(() => (props.proposal?.diff ?? '').split('\n').map(text => ({ text, kind: text.startsWith('+') && !text.startsWith('+++') ? 'insert' as const : text.startsWith('-') && !text.startsWith('---') ? 'delete' as const : 'context' as const })))
const visibleDiff = computed(() => expanded.value ? diffLines.value : diffLines.value.slice(0, collapsedLineCount))
watch(() => props.proposal?.id, () => { confirmationPath.value = ''; expanded.value = false })
const decide = (decision: 'approved' | 'denied') => {
  const approval = props.proposal?.approval
  if (!props.proposal || !approval) return
  emit('decision', props.proposal.id, approval.id, decision, props.proposal.risk === 'destructive-write' ? confirmationPath.value : undefined)
}
</script>

<style scoped>
.proposal-metadata { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .25rem 1rem; }
.proposal-metadata dt { font-weight: 600; }
.proposal-metadata dd { margin: 0; overflow-wrap: anywhere; }
.proposal-diff { border: 1px solid rgb(var(--v-theme-outline-variant)); border-radius: .5rem; overflow: hidden; }
.proposal-diff pre { margin: 0; max-height: 30rem; overflow: auto; padding: .75rem; white-space: pre-wrap; word-break: break-word; }
.proposal-diff ins, .proposal-diff del, .proposal-diff span { display: inline; text-decoration: none; }
.proposal-diff ins { background: rgba(46, 160, 67, .22); }
.proposal-diff del { background: rgba(248, 81, 73, .22); }
@media (forced-colors: active) { .proposal-diff ins { border-inline-start: 3px solid CanvasText; } .proposal-diff del { border-inline-start: 3px double CanvasText; text-decoration: line-through; } }
</style>
