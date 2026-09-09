<template>
  <section class="mail-secret">
    <div class="mail-secret-head">
      <div>
        <strong>{{ label }}</strong>
        <p>
          {{
            model.action === 'keep'
              ? stored
                ? 'Saved securely. Its value is never returned to this page.'
                : 'No credential saved.'
              : model.action === 'clear'
                ? 'This credential will be removed when you save.'
                : 'The replacement stays in this draft until you save.'
          }}
        </p>
      </div>
      <v-select
        :model-value="model.action"
        :items="actions"
        :label="label + ' action'"
        variant="outlined"
        density="compact"
        hide-details
        :disabled="disabled"
        @update:model-value="changeAction"
      />
    </div>
    <v-textarea
      v-if="multiline && model.action === 'replace'"
      :model-value="model.value"
      :label="'Replacement ' + label.toLowerCase()"
      variant="outlined"
      rows="5"
      autocomplete="off"
      :spellcheck="false"
      :maxlength="65536"
      :disabled="disabled"
      persistent-hint
      hint="Unencrypted RSA private key in PEM format, at least 2048 bits."
      @update:model-value="replace"
    />
    <v-text-field
      v-else-if="model.action === 'replace'"
      :model-value="model.value"
      :label="'Replacement ' + label.toLowerCase()"
      variant="outlined"
      type="password"
      autocomplete="new-password"
      :maxlength="65536"
      :disabled="disabled"
      hide-details
      @update:model-value="replace"
    />
  </section>
</template>
<script setup lang="ts">
import type { MailDraft } from '../../../shared/mail-workspace.ts'
type Secret = MailDraft['secrets']['pass']
const model = defineModel<Secret>({ required: true })
const {
  stored,
  label,
  multiline = false,
  disabled = false
} = defineProps<{
  stored: boolean
  label: string
  multiline?: boolean
  disabled?: boolean
}>()
const actions = [
  { title: 'Keep saved', value: 'keep' },
  { title: 'Replace', value: 'replace' },
  { title: 'Clear on save', value: 'clear' }
]
const changeAction = (action: Secret['action']) => {
  model.value = action === 'replace' ? { action, value: '' } : { action }
}
const replace = (value: string) => {
  model.value = { action: 'replace', value }
}
</script>
