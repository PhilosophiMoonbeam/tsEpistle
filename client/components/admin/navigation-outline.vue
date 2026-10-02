<template>
  <component
    :is="disabled ? 'div' : Draggable"
    v-bind="
      disabled
        ? { role: 'list' }
        : { modelValue: items, handle: '.navigation-drag-handle' }
    "
    class="navigation-outline"
    @update:model-value="reorder"
  >
    <div
      v-for="(item, index) in items"
      :key="item.id"
      class="navigation-outline-row"
      :class="{ 'is-selected': item.id === selected }"
      role="listitem"
    >
      <button
        class="navigation-drag-handle"
        type="button"
        :disabled="disabled"
        :aria-label="$t('admin:navigationOutline.reorder', { label: (item.label || 'divider'), interpolation: { escapeValue: false } })"
      >
        <v-icon icon="mdi-drag" size="17" />
      </button>
      <button
        class="navigation-outline-select"
        type="button"
        :disabled="disabled"
        :aria-pressed="item.id === selected"
        @click="emit('select', item.id)"
      >
        <span class="navigation-outline-position">{{
          String(index + 1).padStart(2, "0")
        }}</span>
        <span class="navigation-outline-label"
          ><strong>{{
            item.kind === "divider"
              ? $t('admin:navigationOutline.divider')
              : item.label || $t('admin:navigationOutline.untitled', { kind: item.kind, interpolation: { escapeValue: false } })
          }}</strong
          ><small>{{
            item.kind === "link"
              ? item.target || $t('admin:navigationOutline.chooseDestination')
              : item.kind === "header"
                ? $t('admin:navigationOutline.sectionHeading')
                : $t('admin:navigationOutline.visualSeparator')
          }}</small></span
        >
        <v-icon
          v-if="item.visibilityMode === 'restricted'"
          icon="mdi-account-lock-outline"
          size="15"
          :title="$t('admin:navigationOutline.restrictedAudience')"
        />
      </button>
    </div>
  </component>
</template>
<script setup lang="ts">
import Draggable from "../common/draggable-list.vue";
import type { NavigationItem } from "../../../shared/navigation-policy.ts";
const props = defineProps<{
  items: NavigationItem[];
  selected: string;
  disabled: boolean;
}>();
const emit = defineEmits<{
  select: [id: string];
  reorder: [items: NavigationItem[]];
}>();
function reorder(items: unknown[]) {
  if (!props.disabled) emit("reorder", items as NavigationItem[]);
}
</script>
