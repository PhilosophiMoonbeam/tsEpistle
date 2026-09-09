<template>
  <section class="logging-secret">
    <div class="logging-secret-head">
      <div>
        <strong>{{ label }}</strong>
        <p v-if="hint">{{ hint }}</p>
        <p v-else>{{ stored ? 'A value is stored. It is never displayed here.' : 'No value is stored.' }}</p>
      </div>
      <v-select
        :model-value="model.action"
        :items="actions"
        :label="`${label} action`"
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
      :label="`New ${label}`"
      type="password"
      autocomplete="new-password"
      variant="outlined"
      :disabled="disabled"
      :hint="`Replacing ${stored ? 'the stored value' : 'an empty value'} takes effect only after reviewed settings are saved.`"
      persistent-hint
      @update:model-value="replace"
    />
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { LoggingSecretChange } from '../../../shared/logging-workspace.ts'

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
  { title: stored ? 'Keep stored value' : 'Keep empty', value: 'keep' },
  { title: 'Replace', value: 'replace' },
  ...(stored ? [{ title: 'Clear stored value', value: 'clear' }] : [])
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
