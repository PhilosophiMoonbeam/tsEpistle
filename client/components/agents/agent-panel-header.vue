<template>
  <header class="agent-panel-header" tabindex="-1" :aria-labelledby="headingId" :aria-describedby="$slots.default ? descriptionId : undefined">
    <div class="agent-panel-header__title-row">
      <v-icon :icon="icon" size="20" class="agent-panel-header__icon" aria-hidden="true" />
      <h2 :id="headingId">{{ title }}</h2>
      <!-- One row: optional panel actions, a divider, then Close at the far end. -->
      <div class="agent-panel-header__actions">
        <slot name="actions" />
        <span v-if="$slots.actions" class="agent-panel-header__divider" aria-hidden="true" />
        <v-tooltip location="bottom" :text="busy && busyReason ? busyReason : closeLabel">
          <template #activator="{ props: tooltipProps }">
            <v-btn
              v-bind="tooltipProps"
              class="agent-panel-header__close wiki-close-control"
              icon="mdi-close"
              variant="text"
              :aria-label="closeLabel"
              :aria-disabled="busy ? 'true' : undefined"
              @click="requestClose"
            />
          </template>
        </v-tooltip>
      </div>
    </div>
    <div v-if="$slots.default" :id="descriptionId" class="agent-panel-header__description"><slot /></div>
  </header>
</template>
<script setup lang="ts">
const props = defineProps<{ title: string; icon: string; closeLabel: string; headingId: string; descriptionId: string; busy?: boolean; busyReason?: string }>()
const emit = defineEmits<{ close: [] }>()
const requestClose = (): void => {
  if (!props.busy) emit('close')
}
</script>
<style scoped>
.agent-panel-header { flex: 0 0 auto; padding: 1rem 1.25rem; border-bottom: 1px solid var(--wiki-surface-border); background: var(--wiki-surface-raised); outline: none; }
.agent-panel-header:focus-visible { box-shadow: inset var(--wiki-focus-ring); }
.agent-panel-header__title-row { display: flex; align-items: center; gap: .6rem; min-height: 2.75rem; }
.agent-panel-header__actions { display: flex; flex: 0 0 auto; align-items: center; gap: .25rem; }
.agent-panel-header__actions :deep(.v-btn) { min-width: 2.75rem; width: 2.75rem; height: 2.75rem; border-radius: var(--wiki-control-radius); }
.agent-panel-header__divider { align-self: stretch; width: 1px; margin-inline: .25rem; background: var(--wiki-surface-border); }
.agent-panel-header__close[aria-disabled='true'] { opacity: .6; }
.agent-panel-header__icon { color: var(--wiki-primary-ink); }
.agent-panel-header h2 { flex: 1; min-width: 0; margin: 0; font-family: var(--wiki-font-heading); font-size: 1.125rem; font-weight: 700; line-height: 1.35; overflow-wrap: anywhere; }
.agent-panel-header__description { margin-top: .5rem; color: var(--wiki-text-muted); font-size: .875rem; line-height: 1.5; }
@media(max-width: 599.98px) { .agent-panel-header { padding: max(1rem, env(safe-area-inset-top)) 1rem 1rem; } }
</style>
