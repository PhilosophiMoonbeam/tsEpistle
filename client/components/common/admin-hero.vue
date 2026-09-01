<template lang='pug'>
  header.admin-hero
    .admin-hero__main
      .admin-hero__mark(v-if='icon' aria-hidden='true')
        v-icon(v-if='usesMdiIcon') {{ icon }}
        img(v-else :src='icon' alt='' draggable='false')
      .admin-hero__copy
        .admin-hero__eyebrow(v-if='eyebrow') {{ eyebrow }}
        h1.admin-hero__title.text-headline-medium(:id='headingId' tabindex='-1') {{ title }}
        p.admin-hero__description.text-body-large(v-if='description') {{ description }}
        .admin-hero__extra(v-if='$slots.extra')
          slot(name='extra')
    .admin-hero__status(v-if='$slots.status')
      slot(name='status')
    .admin-hero__actions(v-if='$slots.actions')
      slot(name='actions')
</template>

<script setup lang='ts'>
import { computed } from 'vue'

type AdminHeroProps = {
  title: string
  description?: string
  icon?: string
  eyebrow?: string
  headingId?: string
}

const props = defineProps<AdminHeroProps>()

defineSlots<{
  status?: () => unknown
  actions?: () => unknown
  extra?: () => unknown
}>()

const usesMdiIcon = computed(() => props.icon?.startsWith('mdi-') ?? false)
</script>

<style lang='scss' scoped>
.admin-hero {
  display: flex;
  overflow: hidden;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--wiki-space-3) var(--wiki-space-4);
  margin-block-end: var(--wiki-space-4);
  padding: var(--wiki-space-4) var(--wiki-space-5);
  border: 1px solid var(--wiki-surface-border);
  border-inline-start: var(--wiki-space-1) solid var(--wiki-accent-warm);
  border-radius: var(--wiki-panel-radius);
  background: linear-gradient(
    110deg,
    color-mix(in srgb, var(--wiki-ambient-accent) 9%, var(--wiki-surface-raised)),
    var(--wiki-surface-raised) 58%
  );
  box-shadow: var(--wiki-shadow-sm), var(--wiki-shadow-inset);
  color: rgb(var(--v-theme-on-surface));
}

.admin-hero__main {
  display: flex;
  min-width: 0;
  flex: 1 1 50%;
  align-items: center;
  gap: var(--wiki-space-4);
}

.admin-hero__mark {
  display: grid;
  width: var(--wiki-grid-size);
  height: var(--wiki-grid-size);
  flex: 0 0 var(--wiki-grid-size);
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--wiki-ambient-accent) 24%, transparent);
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--wiki-ambient-accent) 10%, var(--wiki-surface-raised));
  box-shadow: var(--wiki-shadow-inset);
  color: var(--wiki-accent-warm);
}

.admin-hero__mark > img {
  width: 100%;
  height: 100%;
  padding: var(--wiki-space-2);
  object-fit: contain;
}

.admin-hero__mark > .v-icon {
  font-size: var(--wiki-space-8);
}

.admin-hero__copy {
  min-width: 0;
}

.admin-hero__eyebrow {
  margin-block-end: var(--wiki-space-1);
  color: var(--wiki-accent-warm);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .1em;
  text-transform: uppercase;
}

.admin-hero__title {
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-weight: 720;
  letter-spacing: -.035em;
  line-height: var(--wiki-leading-heading);
}

.admin-hero__title:focus {
  outline: none;
  box-shadow: none;
}

.admin-hero__description {
  max-width: 70ch;
  margin-block: var(--wiki-space-1) 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
  line-height: 1.45;
}

.admin-hero__extra {
  margin-block-start: var(--wiki-space-2);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
}

.admin-hero__status,
.admin-hero__actions {
  display: flex;
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
}

.admin-hero__actions {
  justify-content: flex-end;
}

@media (max-width: 599.98px) {
  .admin-hero {
    align-items: stretch;
    gap: var(--wiki-space-3);
    padding: var(--wiki-space-3);
    border-radius: var(--wiki-control-radius);
  }

  .admin-hero__main,
  .admin-hero__status,
  .admin-hero__actions {
    flex: 1 1 100%;
  }

  .admin-hero__main {
    align-items: flex-start;
    gap: var(--wiki-space-3);
  }

  .admin-hero__actions {
    justify-content: flex-start;
  }
}

@media (forced-colors: active) {
  .admin-hero,
  .admin-hero__mark {
    border-color: CanvasText;
    background: Canvas;
    box-shadow: none;
  }
}
</style>
