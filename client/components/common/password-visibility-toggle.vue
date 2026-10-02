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
 * It is a toggle button: the name stays "Show <field>" and aria-pressed says
 * whether the text is visible, so screen readers do not hear a changing name
 * and a changing state at once. The icon follows the action: the eye shows,
 * the crossed eye hides. Works without i18n (first-run setup).
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
      const fallback = this.$t('common:passwordVisibilityToggle.show', { field: this.field, interpolation: { escapeValue: false } })
      return typeof translate === 'function' ? translate('common:password.show', { field: this.field, defaultValue: fallback }) : fallback
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
