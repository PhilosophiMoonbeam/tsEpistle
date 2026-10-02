<template>
  <section class="artifact-grid" :aria-label="label">
    <figure v-for="artifact in artifacts" :key="artifact.id" class="artifact-card">
      <a
        v-if="artifact.available"
        :href="`/_api/agents/artifacts/${artifact.id}/content`"
        target="_blank"
        rel="noopener noreferrer"
      >
        <img
          :src="`/_api/agents/artifacts/${artifact.id}/content`"
          :alt="capturedLabel(artifact) ? $t('common:agentArtifactGrid.browserScreenshot', { artifact: capturedLabel(artifact), interpolation: { escapeValue: false } }) : $t('common:agentArtifactGrid.browserScreenshot2')"
          :width="artifact.width"
          :height="artifact.height"
          loading="lazy"
        >
      </a>
      <figcaption class="text-body-small text-medium-emphasis">
        {{ artifact.available ? $t('common:agentArtifactGrid.browserScreenshot3', { width: artifact.width, height: artifact.height, interpolation: { escapeValue: false } }) : $t('common:agentArtifactGrid.browserScreenshotExpired') }}
      </figcaption>
    </figure>
  </section>
</template>

<script setup lang="ts">
import type { AgentArtifactView } from '../../../shared/agents/contracts.ts'

const props = defineProps<{
  artifacts: readonly AgentArtifactView[]
  label: string
  /** Formats the capture time for the alt text; an empty result leaves the time out. */
  formatTime: (createdAt: string) => string
}>()
const capturedLabel = (artifact: AgentArtifactView): string => props.formatTime(artifact.createdAt)
</script>

<style scoped>
.artifact-grid {
  display: grid;
  gap: var(--wiki-space-4);
  grid-template-columns: repeat(auto-fit, minmax(min(calc(var(--wiki-space-12) * 6), 100%), 1fr));
  margin-block-start: var(--wiki-space-4);
}

.artifact-card {
  margin: 0;
}

.artifact-card a {
  border-radius: var(--wiki-control-radius);
  display: block;
}

.artifact-card a:focus-visible {
  border-radius: var(--wiki-radius-xs);
  box-shadow: var(--wiki-focus-ring);
  outline: 2px solid var(--wiki-focus-color);
  outline-offset: var(--wiki-focus-offset);
}

.artifact-card img {
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  box-shadow: var(--wiki-shadow-xs);
  display: block;
  height: auto;
  max-width: 100%;
}

.artifact-card figcaption {
  margin-block-start: var(--wiki-space-2);
}

@media (forced-colors: active) {
  .artifact-card img {
    background: Canvas;
    border-color: CanvasText;
    color: CanvasText;
  }
  .artifact-card a:focus-visible {
    outline-color: Highlight;
  }
}
</style>
