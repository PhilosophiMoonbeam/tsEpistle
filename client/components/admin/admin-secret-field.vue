<template>
  <section class="admin-secret">
    <div class="admin-secret-head">
      <div class="admin-secret-description">
        <strong>{{ label }}</strong>
        <p>{{ stored ? $t('admin:secretField.storedPrivate') : $t('admin:secretField.notStored') }}</p>
        <p v-if="hint">{{ hint }}</p>
        <p v-if="model.action === 'clear'" role="status">{{ $t('admin:secretField.clearOnReviewedSave') }}</p>
        <p v-else-if="model.action === 'replace'" role="status">{{ $t('admin:secretField.replacementDraft') }}</p>
      </div>
      <v-select
        class="admin-secret-action"
        :model-value="model.action"
        :items="actions"
        :label="$t('admin:secretField.action', { label, interpolation: { escapeValue: false } })"
        variant="outlined"
        density="compact"
        hide-details
        :disabled="disabled"
        @update:model-value="setAction"
      />
    </div>
    <v-textarea
      v-if="multiline && model.action === 'replace'"
      class="admin-secret-replacement"
      :model-value="model.value"
      :label="$t('admin:secretField.replacement', { label, interpolation: { escapeValue: false } })"
      variant="outlined"
      rows="5"
      autocomplete="off"
      :spellcheck="false"
      :maxlength="maxlength"
      :disabled="disabled"
      hide-details
      @update:model-value="replace"
    />
    <v-text-field
      v-else-if="model.action === 'replace'"
      class="admin-secret-replacement"
      :model-value="model.value"
      :label="$t('admin:secretField.replacement', { label, interpolation: { escapeValue: false } })"
      :type="showReplacement ? 'text' : 'password'"
      autocomplete="new-password"
      variant="outlined"
      :maxlength="maxlength"
      :disabled="disabled"
      hide-details
      @update:model-value="replace"
    >
      <template #append-inner>
        <password-visibility-toggle v-model:visible="showReplacement" :field="label" :disabled="disabled" />
      </template>
    </v-text-field>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import PasswordVisibilityToggle from '../common/password-visibility-toggle.vue'
import { useTranslate } from '../../helpers/use-translate.ts'

type SecretChange = { action: 'keep' } | { action: 'clear' } | { action: 'replace'; value: string }

const {
  stored,
  label,
  hint = null,
  disabled = false,
  multiline = false,
  maxlength
} = defineProps<{
  stored: boolean
  label: string
  hint?: string | null
  disabled?: boolean
  multiline?: boolean
  maxlength?: number
}>()
const model = defineModel<SecretChange>({ required: true })
const t = useTranslate()
const showReplacement = ref(false)
const actions = computed(() => [
  { title: stored ? t('admin:secretField.keepStored') : t('admin:secretField.keepEmpty'), value: 'keep' },
  { title: t('admin:secretField.replace'), value: 'replace' },
  { title: t('admin:secretField.clearOnSave'), value: 'clear' }
])
watch([() => model.value.action, () => label, () => multiline], () => {
  showReplacement.value = false
})
const setAction = (action: unknown) => {
  if (disabled) return
  showReplacement.value = false
  if (action === 'replace') {
    model.value = model.value.action === 'replace' ? model.value : { action: 'replace', value: '' }
  } else if (action === 'clear') {
    model.value = { action: 'clear' }
  } else if (action === 'keep') {
    model.value = { action: 'keep' }
  }
}
const replace = (value: unknown) => {
  if (disabled) return
  model.value = { action: 'replace', value: typeof value === 'string' ? value : '' }
}
</script>

<style scoped lang="scss">
.admin-secret {
  min-width: 0;
  margin-bottom: 18px;
  padding: 18px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.13);
  border-radius: 8px;
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.admin-secret-head {
  display: flex;
  align-items: start;
  flex-wrap: wrap;
  gap: 18px;
}
.admin-secret-description {
  flex: 1 1 240px;
  min-width: 0;
  overflow-wrap: anywhere;
  strong {
    font-size: 13px;
  }
  p {
    margin: 5px 0 0;
    color: var(--wiki-text-muted);
    font-size: 12px;
    line-height: 1.65;
  }
}
.admin-secret-action {
  flex: 1 1 180px;
  min-width: 0;
  :deep(.v-select__selection-text) {
    white-space: normal;
    overflow-wrap: anywhere;
  }
}
.admin-secret-replacement {
  min-width: 0;
  margin-top: 20px;
}
@media (max-width: 599px) {
  .admin-secret {
    padding: 14px;
  }
  .admin-secret-head {
    flex-direction: column;
  }
  .admin-secret-description,
  .admin-secret-action {
    flex: auto;
    width: 100%;
  }
}
</style>
