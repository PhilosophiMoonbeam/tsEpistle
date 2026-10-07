<template>
  <div>
    <div v-for="field in fields" :key="field.key" class="identity-config-field">
      <template v-if="field.sensitive"
        ><div class="identity-secret-title">
          <h3>{{ field.title }}</h3>
          <span>{{
            configuredSecrets.includes(field.key)
              ? $t('admin:authFields.credentialStored')
              : $t('admin:authFields.noCredentialStored')
          }}</span>
        </div>
        <v-select
          :model-value="modelValue.secrets[field.key]?.action || 'keep'"
          :items="secretActions"
          :label="$t('admin:authFields.action', { title: field.title, interpolation: { escapeValue: false } })"
          variant="outlined"
          :disabled="disabled"
          @update:model-value="secretAction(field.key, $event)"
        /><v-textarea
          v-credential-autofill
          v-if="
            modelValue.secrets[field.key]?.action === 'replace' &&
            field.multiline
          "
          :model-value="secretValue(field.key)"
          :label="$t('admin:authFields.replacement', { title: field.title, interpolation: { escapeValue: false } })"
          autocomplete="off"
          rows="4"
          variant="outlined"
          :disabled="disabled"
          @update:model-value="replaceSecret(field.key, $event)"
        /><v-text-field
          v-credential-autofill
          v-else-if="modelValue.secrets[field.key]?.action === 'replace'"
          :model-value="secretValue(field.key)"
          :label="$t('admin:authFields.replacement', { title: field.title, interpolation: { escapeValue: false } })"
          type="password"
          autocomplete="new-password"
          variant="outlined"
          :disabled="disabled"
          @update:model-value="replaceSecret(field.key, $event)"
        />
        <p class="identity-note">
          {{
            field.hint ||
            $t('admin:authFields.storedCredentialsCannotRevealed')
          }}
        </p></template
      >
      <v-switch
        v-else-if="field.type === 'boolean'"
        :model-value="modelValue.config[field.key]"
        @update:model-value="updateConfig(field.key, $event)"
        :label="field.title"
        color="primary"
        inset
        :disabled="disabled"
        :hint="field.hint"
        persistent-hint
      />
      <v-select
        v-else-if="field.choices.length"
        :model-value="modelValue.config[field.key]"
        @update:model-value="updateConfig(field.key, $event)"
        :items="field.choices"
        :label="field.title"
        variant="outlined"
        :disabled="disabled"
        :hint="field.hint"
        persistent-hint
      />
      <v-textarea
        v-credential-autofill
        v-else-if="field.multiline"
        :model-value="modelValue.config[field.key]"
        @update:model-value="updateConfig(field.key, $event)"
        :label="field.title"
        autocomplete="off"
        rows="4"
        auto-grow
        variant="outlined"
        :disabled="disabled"
        :hint="field.hint"
        persistent-hint
      />
      <v-text-field
        v-credential-autofill
        v-else-if="field.type === 'number'"
        :model-value="modelValue.config[field.key]"
        @update:model-value="updateConfig(field.key, $event === '' || $event == null ? null : Number($event))"
        :label="field.title"
        type="number"
        autocomplete="off"
        variant="outlined"
        :disabled="disabled"
        :hint="field.hint"
        persistent-hint
      />
      <v-text-field
        v-credential-autofill
        v-else
        :model-value="modelValue.config[field.key]"
        @update:model-value="updateConfig(field.key, $event)"
        :label="field.title"
        autocomplete="off"
        variant="outlined"
        :disabled="disabled"
        :hint="field.hint"
        persistent-hint
      />
    </div>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import type {
  AuthenticationField,
  AuthenticationProviderDraft,
  AuthenticationValue
} from '../../../shared/authentication-policy.ts'
import { vCredentialAutofill } from '../../helpers/credential-autofill.ts'
export default {
  directives: { credentialAutofill: vCredentialAutofill },
  props: {
    modelValue: {
      type: Object as PropType<AuthenticationProviderDraft>,
      required: true
    },
    fields: { type: Array as PropType<AuthenticationField[]>, required: true },
    configuredSecrets: { type: Array as PropType<string[]>, default: () => [] },
    disabled: Boolean
  },
  emits: ['update:modelValue'],
  data() {
    return {
      secretActions: [
        { title: this.$t('admin:authFields.keepCurrentValue'), value: 'keep' },
        { title: this.$t('admin:authFields.replaceCredential'), value: 'replace' },
        { title: this.$t('admin:authFields.clearStoredCredential'), value: 'clear' }
      ]
    }
  },
  methods: {
    updateConfig(key: string, value: AuthenticationValue) {
      if (!this.disabled)
        this.$emit('update:modelValue', {
          ...this.modelValue,
          config: { ...this.modelValue.config, [key]: value }
        })
    },
    secretAction(key: string, action: string) {
      if (this.disabled) return
      this.$emit('update:modelValue', {
        ...this.modelValue,
        secrets: {
          ...this.modelValue.secrets,
          [key]:
            action === 'replace'
              ? { action: 'replace', value: '' }
              : { action: action === 'clear' ? 'clear' : 'keep' }
        }
      })
    },
    secretValue(key: string): string {
      const secret = this.modelValue.secrets[key]
      return secret?.action === 'replace' ? secret.value : ''
    },
    replaceSecret(key: string, value: string) {
      if (!this.disabled)
        this.$emit('update:modelValue', {
          ...this.modelValue,
          secrets: {
            ...this.modelValue.secrets,
            [key]: { action: 'replace', value }
          }
        })
    }
  }
}
</script>
