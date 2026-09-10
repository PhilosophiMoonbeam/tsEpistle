<script setup lang="ts">
const {
  title,
  icon = 'mdi-chip',
  accentColor = '#06b6d4'
} = defineProps<{
  title: string
  icon?: string
  accentColor?: string
}>()
</script>

<template>
  <div
    class="hardware-telemetry-card"
    :style="{
      '--telemetry-accent': accentColor
    }"
  >
    <div class="hardware-telemetry-card__header">
      <div class="hardware-telemetry-card__title-wrap">
        <v-icon
          v-if="icon"
          :icon="icon"
          size="20"
          class="hardware-telemetry-card__icon"
          :style="{ color: accentColor }"
        />
        <h3 class="hardware-telemetry-card__title">{{ title }}</h3>
      </div>
      <div v-if="$slots.actions" class="hardware-telemetry-card__actions">
        <slot name="actions" />
      </div>
    </div>
    <div class="hardware-telemetry-card__body">
      <slot />
    </div>
  </div>
</template>

<style scoped lang="scss">
.hardware-telemetry-card {
  position: relative;
  background: rgba(var(--v-theme-surface), 0.75);
  border: 1px solid rgba(6, 182, 212, 0.25);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-radius: 12px;
  padding: 1.25rem 1.5rem;
  transition: box-shadow 0.3s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.3s ease, transform 0.2s ease;

  &:hover {
    box-shadow: 0 16px 36px -10px rgba(0, 0, 0, 0.3), 0 0 20px -4px rgba(6, 182, 212, 0.2);
    border-color: rgba(6, 182, 212, 0.45);
  }

  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.08);
  }

  &__title-wrap {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  &__icon {
    filter: drop-shadow(0 0 6px rgba(6, 182, 212, 0.35));
    flex-shrink: 0;
  }

  &__title {
    font-size: 0.95rem;
    font-weight: 650;
    letter-spacing: -0.01em;
    color: rgb(var(--v-theme-on-surface));
    margin: 0;
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  &__body {
    position: relative;
  }
}
</style>
