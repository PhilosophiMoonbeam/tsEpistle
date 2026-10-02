<template lang="pug">
  v-btn.password-visibility-toggle(
    icon
    type='button'
    variant='text'
    size='small'
    :aria-label='label'
    :aria-pressed='visible ? `true` : `false`'
    :disabled='disabled'
    @click='$emit(`update:visible`, !visible)'
  )
    v-icon(:icon='visible ? `mdi-eye-off-outline` : `mdi-eye-outline`' aria-hidden='true')
</template>

<script lang="ts">
import { defineComponent } from 'vue'

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * One show/hide control for every password field.
 * The eye means "show"; the crossed eye means "hide". The label names the field
 * and the pressed state tells assistive technology whether the text is visible.
 * Works without i18n (first-run setup) by falling back to English.
 */
export default defineComponent({
  props: {
    visible: { type: Boolean, default: false },
    field: { type: String, required: true },
    disabled: { type: Boolean, default: false }
  },
  emits: ['update:visible'],
  computed: {
    label (): string {
      const translate = (this as unknown as { $t?: Translate }).$t
      const key = this.visible ? 'common:password.hide' : 'common:password.show'
      const fallback = `${this.visible ? 'Hide' : 'Show'} ${this.field}`
      return typeof translate === 'function' ? translate(key, { field: this.field, defaultValue: fallback }) : fallback
    }
  }
})
</script>

<style lang="scss">
.password-visibility-toggle.v-btn {
  width: 44px !important;
  min-width: 44px !important;
  height: 44px !important;
  min-height: 44px !important;
  padding: 0;
  color: var(--wiki-text-muted);

  &:hover,
  &:focus-visible {
    color: rgb(var(--v-theme-on-surface));
  }
}
</style>
