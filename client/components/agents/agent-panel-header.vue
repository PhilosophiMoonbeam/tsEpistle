<template>
  <header class="agent-panel-header" tabindex="-1" :aria-labelledby="headingId" :aria-describedby="descriptionId">
    <div class="agent-panel-header__title-row">
      <v-icon :icon="icon" size="20" class="agent-panel-header__icon" aria-hidden="true" />
      <h2 :id="headingId">{{ title }}</h2>
      <div class="agent-panel-header__actions">
        <v-btn class="agent-panel-header__close wiki-close-control" :icon="'mdi-close'" variant="text" :aria-label="closeLabel" title="Close" :disabled="busy" @click="emit('close')" />
        <slot name="actions" />
      </div>
    </div>
    <div :id="descriptionId" class="agent-panel-header__description"><slot /></div>
  </header>
</template>
<script setup lang="ts">
defineProps<{ title: string; icon: string; closeLabel: string; headingId: string; descriptionId: string; busy?: boolean }>()
const emit = defineEmits<{ close: [] }>()
</script>
<style scoped>
/* Top padding centers the title row with the agent header controls (64px toolbar). */
.agent-panel-header { flex: 0 0 auto; padding: .5rem 1.25rem 1rem; border-bottom: 1px solid var(--wiki-surface-border); outline: none; }
.agent-panel-header:focus-visible { box-shadow: inset var(--wiki-focus-ring); }
.agent-panel-header__title-row { display: flex; align-items: center; gap: .6rem; }
/* Stacked panel controls (close on top, optional panel action below), sized
   so the header keeps its proportions. */
.agent-panel-header__actions { display: flex; flex-direction: column; align-items: center; gap: .25rem; }
.agent-panel-header__actions :deep(.v-btn) { width: 2rem; min-width: 2rem; height: 2rem; border-radius: 8px; }
.agent-panel-header__actions :deep(.v-btn .v-icon) { font-size: 1.125rem; }
/* The panel close button mirrors the agent header's close control: square,
   the same height, no glow or scale, and a crisp red icon hover. */
.agent-panel-header { --agent-panel-close-hover-tint: #dc2626; }
.v-theme--dark .agent-panel-header { --agent-panel-close-hover-tint: #f87171; }
.agent-panel-header__close { border-radius: 8px; }
.agent-panel-header__close:is(:hover, :active) {
  color: var(--agent-panel-close-hover-tint);
  background-color: transparent;
  transform: none;
  box-shadow: none;
}
.agent-panel-header__icon { color: color-mix(in srgb, rgb(var(--v-theme-primary)) 35%, rgb(var(--v-theme-on-surface))); }
.agent-panel-header h2 { flex: 1; min-width: 0; margin: 0; font-family: var(--wiki-font-display, 'Newsreader', serif); font-size: 1.55rem; font-weight: 500; letter-spacing: -.025em; line-height: 1.2; }
.agent-panel-header__description { margin-top: .5rem; color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent); font-size: .75rem; line-height: 1.5; }
@media(max-width: 599.98px) { .agent-panel-header { padding-top: max(1rem, env(safe-area-inset-top)); } }
</style>
