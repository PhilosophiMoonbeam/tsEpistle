<template lang="pug">
.theme-color-field
  label.theme-color-field__label(:for='textFieldId') {{ label }}
  .theme-color-field__controls
    input.theme-color-field__swatch(
      :id='swatchId'
      v-model='swatchColor'
      type='color'
      :aria-label='`${label} color picker`'
    )
    v-text-field(
      :id='textFieldId'
      v-model='model'
      density='compact'
      variant='outlined'
      hide-details='auto'
      maxlength='7'
      spellcheck='false'
      :aria-label='`${label} hex color`'
      :rules='colorRules'
      @blur='normalizeColor'
    )
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import { isHexThemeColor } from '../../../shared/theme-colors.ts'

defineProps<{ label: string }>()
const model = defineModel<string>({ required: true })
const id = useId()
const swatchId = `${id}-swatch`
const textFieldId = `${id}-hex`
const colorRules = [(value: string) => isHexThemeColor(value) || 'Use a six-digit hex color, for example #1867C0.']
const swatchColor = computed({
  get: () => isHexThemeColor(model.value) ? model.value : '#000000',
  set: (value: string) => { model.value = value.toUpperCase() }
})

const normalizeColor = (): void => {
  if (isHexThemeColor(model.value)) model.value = model.value.toUpperCase()
}
</script>

<style lang="scss" scoped>
.theme-color-field {
  min-width: 0;

  &__label {
    display: block;
    margin-bottom: 6px;
    color: rgb(var(--v-theme-on-surface));
    font-size: .75rem;
    font-weight: 600;
    letter-spacing: .02em;
  }

  &__controls {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr);
    gap: 8px;
    align-items: start;
  }

  &__swatch {
    width: 44px;
    height: 40px;
    padding: 3px;
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    border-radius: 6px;
    background: rgb(var(--v-theme-surface));
    cursor: pointer;
  }
}
</style>
