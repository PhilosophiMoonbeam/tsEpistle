<template>
  <section class="agent-thread" aria-label="Agent conversation">
    <div class="sr-status" aria-live="polite" aria-atomic="true">{{ liveSummary }}</div>
    <v-alert v-if="!thread.messages.length" type="info" variant="tonal" class="mb-4">
      Ask a question to search and read Wiki pages you are allowed to access.
    </v-alert>
    <article v-for="message in thread.messages" :key="message.id" class="agent-message" :class="`agent-message--${message.role}`">
      <div class="text-body-small text-medium-emphasis mb-1">
        {{ message.role === 'user' ? 'You' : 'Wiki Agent' }} · {{ message.status }}
      </div>
      <AgentMarkdown :content="message.content || (message.status === 'streaming' ? '…' : '')" />
      <nav v-if="message.citations.length" class="mt-3" aria-label="Citations">
        <v-chip
          v-for="citation in message.citations"
          :key="citation.evidenceId"
          class="mr-2 mb-2"
          size="small"
          :href="citation.href || undefined"
          :disabled="!citation.href"
          target="_blank"
          rel="noopener noreferrer"
          prepend-icon="mdi-book-open-page-variant-outline"
        >{{ citation.label }}</v-chip>
      </nav>
    </article>
    <section v-if="thread.tools.length" class="mt-4" aria-label="Agent actions">
      <AgentToolCard
        v-for="tool in thread.tools"
        :key="tool.id"
        :tool="tool"
        :proposal="proposalFor(tool.proposalId)"
        :busy="Boolean(decidingApprovalId && proposalFor(tool.proposalId)?.approval?.id === decidingApprovalId)"
        @decision="(...args) => $emit('decision', ...args)"
      />
    </section>
    <section v-if="thread.artifacts.length" class="artifact-grid mt-4" aria-label="Browser screenshots">
      <figure v-for="artifact in thread.artifacts" :key="artifact.id" class="artifact-card">
        <a
          v-if="artifact.available"
          :href="`/_api/agents/artifacts/${artifact.id}/content`"
          target="_blank"
          rel="noopener noreferrer"
        >
          <img
            :src="`/_api/agents/artifacts/${artifact.id}/content`"
            :alt="`Browser screenshot captured ${artifact.createdAt}`"
            :width="artifact.width"
            :height="artifact.height"
            loading="lazy"
          >
        </a>
        <figcaption class="text-body-small text-medium-emphasis">
          {{ artifact.available ? `Browser screenshot · ${artifact.width}×${artifact.height}` : 'Browser screenshot expired' }}
        </figcaption>
      </figure>
    </section>
    <div v-if="thread.suggestions.length" class="d-flex flex-wrap ga-2 mt-4" aria-label="Follow-up suggestions">
      <v-btn v-for="suggestion in thread.suggestions" :key="suggestion.id" variant="tonal" size="small" @click="$emit('suggest', suggestion.prompt)">{{ suggestion.label }}</v-btn>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AgentProposalView, AgentThreadState } from '../../../shared/agents/contracts.ts'
import AgentMarkdown from './agent-markdown.vue'
import AgentToolCard from './agent-tool-card.vue'
const props = defineProps<{ thread: AgentThreadState; connection: string; decidingApprovalId?: string | null }>()
defineEmits<{ suggest: [prompt: string]; decision: [proposalId: string, approvalId: string, decision: 'approved' | 'denied', confirmationPath?: string] }>()
const proposalFor = (proposalId: string | null): AgentProposalView | undefined => proposalId ? props.thread.proposals.find(proposal => proposal.id === proposalId) : undefined
const liveSummary = computed(() => {
  const run = props.thread.session.currentRun
  if (props.connection === 'reconnecting') return 'Connection interrupted. Reconnecting.'
  if (!run) return 'Agent is ready.'
  if (run.status === 'running') return 'Agent response is in progress.'
  if (run.status === 'awaiting_approval') return 'An action is awaiting approval.'
  return `Agent run ${run.status.replace('_', ' ')}.`
})
</script>

<style scoped>
.agent-thread { min-height: 12rem; }
.agent-message { border-radius: .75rem; margin-bottom: 1rem; max-width: 54rem; padding: 1rem; background: rgb(var(--v-theme-surface-variant)); }
.agent-message--user { margin-inline-start: auto; background: rgb(var(--v-theme-primary)); color: rgb(var(--v-theme-on-primary)); }
.sr-status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.artifact-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(18rem, 100%), 1fr)); }
.artifact-card { margin: 0; }
.artifact-card img { border: 1px solid rgb(var(--v-theme-outline)); border-radius: .5rem; display: block; height: auto; max-width: 100%; }
</style>
