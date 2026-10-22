<template lang="pug">
nav.editor-contents-pane(:aria-label='$t(`editor:contents.title`, { defaultValue: `Contents` })')
  .editor-contents-pane-header
    strong {{ $t('editor:contents.title', { defaultValue: 'Contents' }) }}
    v-btn(size='small', icon='mdi-close', variant='text', :aria-label='$t(`editor:contents.close`, { defaultValue: `Close contents` })', @click='$emit(`close`)')
  .editor-contents-pane-controls
    button(type='button', @click='$emit(`jump`, 0)') {{ $t('editor:contents.top', { defaultValue: 'Top' }) }}
    button(type='button', @click='$emit(`jump`, Math.max(0, lineCount - 1))') {{ $t('editor:contents.end', { defaultValue: 'End' }) }}
    label
      span {{ $t('editor:contents.depth', { defaultValue: 'Heading depth' }) }}
      select(v-model.number='depth')
        option(v-for='level in 6', :key='level', :value='level') {{ level }}
  .editor-contents-pane-list(:aria-busy='busy')
    p(v-if='!headings.length') {{ $t('editor:contents.empty', { defaultValue: 'No headings yet' }) }}
    ol(v-else)
      li(v-for='heading in visibleHeadings', :key='heading.line')
        button(type='button', :disabled='busy', :aria-current='heading.line === currentHeading ? `location` : undefined', :style='{ paddingInlineStart: `${0.5 + (heading.level - 1) * 0.65}rem` }', @click='$emit(`jump`, heading.line)') {{ heading.title || $t('editor:contents.untitled', { defaultValue: 'Untitled heading' }) }}
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SourceHeading } from './common/source-outline'
const props = defineProps<{ headings: SourceHeading[]; currentLine: number; lineCount: number; busy?: boolean }>()
defineEmits<{ jump: [line: number]; close: [] }>()
const depth = ref(6)
const visibleHeadings = computed(() => props.headings.filter(heading => heading.level <= depth.value))
const currentHeading = computed(() => {
  let line = -1
  for (const heading of visibleHeadings.value) {
    if (heading.line > props.currentLine) break
    line = heading.line
  }
  return line
})
</script>

<style scoped lang="scss">
.editor-contents-pane {
  display: flex;
  flex-direction: column;
  flex: 0 0 clamp(10rem, 18vw, 16rem);
  max-width: 35vw;
  min-height: 0;
  overflow: hidden;
  border-inline-end: 1px solid rgba(var(--v-theme-on-surface), .12);
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
  font-size: .85rem;
}
.editor-contents-pane-header { display: flex; align-items: center; justify-content: space-between; padding: .4rem .75rem; }
.editor-contents-pane-controls { display: flex; flex-wrap: wrap; gap: .5rem; padding: .5rem; }
.editor-contents-pane-controls label { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.editor-contents-pane-controls select { border: 1px solid currentColor; border-radius: .25rem; padding: .1rem .3rem; }
.editor-contents-pane-list { overflow: auto; min-height: 0; overscroll-behavior: contain; }
ol { list-style: none; margin: 0; padding: 0; }
p { padding: .75rem; color: var(--wiki-text-muted); }
button { text-align: start; border-radius: .25rem; padding: .35rem .5rem; }
li button { width: 100%; overflow-wrap: anywhere; }
button:hover, button[aria-current] { background: rgba(var(--v-theme-primary), .12); }
button[aria-current] { color: var(--wiki-accent-ink); font-weight: 600; }
button:focus-visible, select:focus-visible { outline: 2px solid var(--wiki-accent-ink); outline-offset: -2px; }
button:disabled { opacity: .6; }
@media (max-width: 600px) {
  .editor-contents-pane { flex-basis: 9rem; max-width: 35vw; }
}
</style>
