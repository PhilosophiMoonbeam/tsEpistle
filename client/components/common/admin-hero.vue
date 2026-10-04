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
  align-items: center;
  flex-wrap: wrap;
  gap: 1rem 1.5rem;
  margin-block-end: 1.25rem;
  padding-block: .25rem 1.5rem;
  border-bottom: 1px solid var(--wiki-surface-border);
  color: rgb(var(--v-theme-on-surface));
}
.admin-hero__main { display: flex; min-width: 0; flex: 1 1 28rem; align-items: flex-start; gap: 1rem; }
.admin-hero__mark {
  display: grid;
  width: 2.75rem;
  height: 2.75rem;
  flex: 0 0 2.75rem;
  place-items: center;
  margin-top: .15rem;
  border: 1px solid var(--wiki-surface-border);
  border-radius: .65rem;
  background: var(--wiki-surface-raised);
  color: var(--wiki-accent-ink);
  > img { width: 100%; height: 100%; padding: .5rem; object-fit: contain; }
  > .v-icon { font-size: 1.4rem; }
}
.admin-hero__copy { min-width: 0; }
.admin-hero__eyebrow { margin-block-end: .5rem; color: var(--wiki-accent-ink); font-size: .68rem; font-weight: 650; letter-spacing: .12em; text-transform: uppercase; }
.admin-hero__title {
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-display);
  font-size: clamp(1.85rem, 2.4vw, 2.65rem) !important;
  font-weight: 550;
  letter-spacing: -.035em !important;
  line-height: 1.15;
  overflow-wrap: anywhere;
}
.admin-hero__description { max-width: 65ch; margin-block: .6rem 0; color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent); font-size: .88rem !important; line-height: 1.55; }
.admin-hero__extra { margin-block-start: 1rem; }
.admin-hero__status, .admin-hero__actions { display: flex; min-width: 0; align-items: center; flex-wrap: wrap; gap: .6rem; }
.admin-hero__actions { justify-content: flex-end; }
@media (max-width: 699px) {
  .admin-hero { align-items: stretch; padding-bottom: 1rem; }
  .admin-hero__main, .admin-hero__status, .admin-hero__actions { flex: 1 1 100%; }
  .admin-hero__main { gap: .75rem; }
  .admin-hero__actions { justify-content: flex-start; }
  .admin-hero__mark { width: 2.25rem; height: 2.25rem; flex-basis: 2.25rem; }
}
@media (forced-colors: active) {
  .admin-hero, .admin-hero__mark { border-color: CanvasText; background: Canvas; }
}
</style>
