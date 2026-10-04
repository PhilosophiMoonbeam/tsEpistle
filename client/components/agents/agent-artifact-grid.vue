<template>
  <section class="artifact-grid" :aria-label="label">
    <figure v-for="artifact in artifacts" :key="artifact.id" class="artifact-card" :class="{ 'artifact-card--unavailable': !artifact.available }">
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
          decoding="async"
          fetchpriority="low"
        >
        <span class="artifact-card__new-window"> {{ $t('common:agentThread.opensNewTab') }}</span>
      </a>
      <div v-else class="artifact-card__unavailable">
        <v-icon icon="mdi-image-off-outline" size="32" aria-hidden="true" />
        <strong>{{ $t('common:agentArtifactGrid.browserScreenshotExpired') }}</strong>
      </div>
      <figcaption v-if="artifact.available" class="text-body-small text-medium-emphasis">
        {{ $t('common:agentArtifactGrid.browserScreenshot3', { width: artifact.width, height: artifact.height, interpolation: { escapeValue: false } }) }}
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
.artifact-card__new-window {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.artifact-card__unavailable {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--wiki-space-2);
  min-height: 10rem;
  padding: var(--wiki-space-4);
  border: 1px dashed var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
  color: var(--wiki-text-muted);
  text-align: center;
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
  .artifact-card__unavailable {
    background: Canvas;
    border-color: CanvasText;
    color: CanvasText;
  }
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
