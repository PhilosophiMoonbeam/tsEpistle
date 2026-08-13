<template>
  <div class="vue-scroll" :style="scrollStyle">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { computed, type CSSProperties } from 'vue'

type ScrollOptions = {
  scrollPanel?: {
    scrollingX?: boolean
    scrollingY?: boolean
  }
}

const props = defineProps<{
  ops?: ScrollOptions
}>()

const scrollStyle = computed<CSSProperties>(() => ({
  overflowX: props.ops?.scrollPanel?.scrollingX === false ? 'hidden' : 'auto',
  overflowY: props.ops?.scrollPanel?.scrollingY === false ? 'hidden' : 'auto'
}))
</script>

<style scoped>
.vue-scroll {
  width: 100%;
  height: 100%;
  min-height: 0;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
</style>
