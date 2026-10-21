<template>
  <fieldset class="oauth-settings" :disabled="disabled">
    <legend>{{ t('configuration') }}</legend>
    <p>{{ t('setupHelp') }}</p>
    <v-select v-model="draft.preset" :items="presetOptions" :label="t('preset')" :disabled="disabled" @update:model-value="changePreset" />
    <template v-if="draft.preset === 'google-workspace'">
      <p>{{ t('googlePresetHelp') }}</p>
      <v-select :model-value="endpointUrl" :items="GOOGLE_WORKSPACE_MCP_SERVICES" item-title="label" item-value="endpointUrl" :label="t('service')" :disabled="disabled" @update:model-value="selectService" />
    </template>
    <template v-else>
      <v-text-field v-model="draft.issuer" :label="t('issuerOverride')" :hint="t('issuerHelp')" persistent-hint autocomplete="off" :disabled="disabled" />
      <v-select v-model="draft.registrationMode" :items="registrationOptions" :label="t('registrationMode')" :disabled="disabled" @update:model-value="changeRegistration" />
      <p>{{ t(draft.registrationMode === 'automatic' ? 'automaticHelp' : 'preregisteredHelp') }}</p>
      <template v-if="draft.registrationMode === 'preregistered'">
        <v-text-field v-model="draft.clientId" :label="t('clientId')" autocomplete="off" :disabled="disabled" />
        <v-select v-model="draft.tokenEndpointAuthMethod" :items="authMethods" :label="t('tokenEndpointAuthMethod')" :disabled="disabled" @update:model-value="changeAuthMethod" />
        <v-text-field v-if="draft.tokenEndpointAuthMethod !== 'none'" v-model="draft.clientSecret" type="password" autocomplete="new-password" :label="t('clientSecret')" :hint="t(clientSecretConfigured ? 'retainClientSecret' : 'newClientSecret')" persistent-hint :disabled="disabled || draft.clearClientSecret" />
        <v-checkbox v-if="clientSecretConfigured || draft.tokenEndpointAuthMethod !== 'none'" v-model="draft.clearClientSecret" :label="t('clearClientSecret')" :disabled="disabled" @update:model-value="value => { if (value) draft.clientSecret = '' }" />
      </template>
    </template>
    <v-textarea v-model="draft.scopes" :label="t('requestedScopes')" :hint="t('scopesHelp')" persistent-hint rows="3" auto-grow :disabled="disabled || draft.preset === 'google-workspace'" />
    <p>{{ t('saveConfigurationHelp') }}</p>
  </fieldset>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { GOOGLE_WORKSPACE_MCP_SERVICES } from '../../../shared/agents/external-mcp.ts'
import { createExternalMcpOAuthDraft, type ExternalMcpOAuthDraft } from '../../helpers/external-mcp-oauth-form.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const draft = defineModel<ExternalMcpOAuthDraft>({ required: true })
const endpointUrl = defineModel<string>('endpointUrl', { required: true })
defineProps<{ disabled?: boolean; clientSecretConfigured?: boolean }>()
const t = useTranslate('profile:externalMcpOAuth')
const presetOptions = computed(() => [{ value: '', title: t('genericPreset') }, { value: 'google-workspace', title: t('googlePreset') }])
const registrationOptions = computed(() => [{ value: 'automatic', title: t('automatic') }, { value: 'preregistered', title: t('preregistered') }])
const authMethods = computed(() => ['none', 'client_secret_post', 'client_secret_basic'].map(value => ({ value, title: t(`authMethod_${value}`) })))
function selectService(value: string) {
  endpointUrl.value = value
  draft.value.scopes = GOOGLE_WORKSPACE_MCP_SERVICES.find(service => service.endpointUrl === value)?.scopes.join('\n') ?? ''
}
function changePreset(value: ExternalMcpOAuthDraft['preset']) {
  draft.value = { ...createExternalMcpOAuthDraft(), preset: value }
  if (value === 'google-workspace') selectService(GOOGLE_WORKSPACE_MCP_SERVICES.find(service => service.endpointUrl === endpointUrl.value)?.endpointUrl ?? GOOGLE_WORKSPACE_MCP_SERVICES[0]!.endpointUrl)
}
function changeRegistration(value: ExternalMcpOAuthDraft['registrationMode']) {
  draft.value.clientSecret = ''
  draft.value.clearClientSecret = value === 'automatic'
  if (value === 'automatic') { draft.value.clientId = ''; draft.value.tokenEndpointAuthMethod = 'none' }
}
function changeAuthMethod(value: ExternalMcpOAuthDraft['tokenEndpointAuthMethod']) {
  draft.value.clientSecret = ''
  draft.value.clearClientSecret = value === 'none'
}
</script>

<style scoped>
.oauth-settings { min-width: 0; margin-block: 1rem; padding: 1rem; border: 1px solid rgb(var(--v-theme-outline-variant)); border-radius: .5rem; }
.oauth-settings legend { padding-inline: .25rem; font-weight: 600; }
.oauth-settings p { margin-block: .5rem 1rem; overflow-wrap: anywhere; }
</style>
