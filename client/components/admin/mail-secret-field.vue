<template>
  <section class="mail-secret">
    <div class="mail-secret-head">
      <div>
        <strong>{{ label }}</strong>
        <p>
          {{
            model.action === 'keep'
              ? stored
                ? $t('admin:mailSecretField.savedSecurelyValueNever')
                : $t('admin:mailSecretField.noCredentialSaved')
              : model.action === 'clear'
                ? $t('admin:mailSecretField.credentialWillRemovedWhen')
                : $t('admin:mailSecretField.replacementStaysDraftUntil')
          }}
        </p>
      </div>
      <v-select
        :model-value="model.action"
        :items="actions"
        :label="$t('admin:mailSecretField.action', { label, interpolation: { escapeValue: false } })"
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
      :label="$t('admin:mailSecretField.replacement', { label: label.toLowerCase(), interpolation: { escapeValue: false } })"
      variant="outlined"
      rows="5"
      autocomplete="off"
      :spellcheck="false"
      :maxlength="65536"
      :disabled="disabled"
      persistent-hint
      :hint="$t('admin:mailSecretField.unencryptedRsaPrivateKey')"
      @update:model-value="replace"
    />
    <v-text-field
      v-else-if="model.action === 'replace'"
      :model-value="model.value"
      :label="$t('admin:mailSecretField.replacement', { label: label.toLowerCase(), interpolation: { escapeValue: false } })"
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
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
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
  { title: t('admin:mailSecretField.keepSaved'), value: 'keep' },
  { title: t('admin:mailSecretField.replace'), value: 'replace' },
  { title: t('admin:mailSecretField.clearSave'), value: 'clear' }
]
const changeAction = (action: Secret['action']) => {
  model.value = action === 'replace' ? { action, value: '' } : { action }
}
const replace = (value: string) => {
  model.value = { action: 'replace', value }
}
</script>
