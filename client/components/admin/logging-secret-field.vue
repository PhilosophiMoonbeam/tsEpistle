<template>
  <section class="logging-secret">
    <div class="logging-secret-head">
      <div>
        <strong>{{ label }}</strong>
        <p v-if="hint">{{ hint }}</p>
        <p v-else>{{ stored ? $t('admin:loggingSecretField.valueStoredNeverDisplayed') : $t('admin:loggingSecretField.noValueStored') }}</p>
      </div>
      <v-select
        :model-value="model.action"
        :items="actions"
        :label="$t('admin:loggingSecretField.action', { label, interpolation: { escapeValue: false } })"
        variant="outlined"
        density="compact"
        hide-details
        :disabled="disabled"
        @update:model-value="setAction"
      />
    </div>
    <v-text-field
      v-if="model.action === 'replace'"
      :model-value="model.value"
      :label="$t('admin:loggingSecretField.new', { label, interpolation: { escapeValue: false } })"
      type="password"
      autocomplete="new-password"
      variant="outlined"
      :disabled="disabled"
      :hint="$t('admin:loggingSecretField.replacingTakesEffectOnly', { value: stored ? 'the stored value' : 'an empty value', interpolation: { escapeValue: false } })"
      persistent-hint
      @update:model-value="replace"
    />
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { LoggingSecretChange } from '../../../shared/logging-workspace.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()

const {
  stored,
  label,
  hint = null,
  disabled = false
} = defineProps<{
  stored: boolean
  label: string
  hint?: string | null
  disabled?: boolean
}>()
const model = defineModel<LoggingSecretChange>({ required: true })
const actions = computed(() => [
  { title: stored ? t('admin:loggingSecretField.keepStoredValue') : t('admin:loggingSecretField.keepEmpty'), value: 'keep' },
  { title: t('admin:loggingSecretField.replace'), value: 'replace' },
  ...(stored ? [{ title: t('admin:loggingSecretField.clearStoredValue'), value: 'clear' }] : [])
])
const setAction = (value: unknown) => {
  if (value === 'replace') {
    model.value = model.value.action === 'replace' ? model.value : { action: 'replace', value: '' }
    return
  }
  if (value === 'clear') {
    model.value = { action: 'clear' }
    return
  }
  model.value = { action: 'keep' }
}
const replace = (value: unknown) => {
  model.value = { action: 'replace', value: typeof value === 'string' ? value : '' }
}
</script>
