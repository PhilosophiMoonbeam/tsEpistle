<template>
  <div>
    <v-dialog v-model="isShown" max-width="760" persistent aria-labelledby="api-key-create-title">
      <v-form ref="createForm" @submit.prevent="generate">
        <v-card class="api-key-dialog">
          <header class="key-dialog-heading"><span class="key-kicker">{{ seed ? $t('admin:apiCreate.credentialReplacement') : $t('admin:apiCreate.newIntegrationIdentity') }}</span><h2 id="api-key-create-title">{{ step === 1 ? $t('admin:apiCreate.nameConnection') : step === 2 ? $t('admin:apiCreate.defineAuthority') : $t('admin:apiCreate.reviewBeforeIssuing') }}</h2><p>{{ seed ? $t('admin:apiCreate.existingKeyStaysValid') : $t('admin:apiCreate.createDedicatedCredentialAccess') }}</p></header>
          <ol class="key-progress" :aria-label="$t('admin:apiCreate.keyCreationSteps')"><li v-for="(label, index) in [$t('admin:apiCreate.stepIdentity'), $t('admin:apiCreate.stepAccess'), $t('admin:apiCreate.stepReview')]" :key="index" :aria-current="step === index + 1 ? 'step' : undefined" :class="{ current: step === index + 1 }"><span>{{ index + 1 }}</span>{{ label }}</li></ol>
          <v-card-text class="key-dialog-body">
            <v-alert v-if="formError" type="error" variant="tonal" class="mb-4">{{ formError }}</v-alert>
            <v-alert v-if="!hasDelegableAuthority" type="warning" variant="tonal" class="mb-3">{{ $t('admin:apiCreate.noDelegableAuthority') }}</v-alert>
            <section v-show="step === 1" :aria-label="$t('admin:apiCreate.credentialIdentity')"><v-text-field ref="keyNameInput" v-model="name" :label="$t('admin:apiCreate.integrationName')" :hint="$t('admin:apiCreate.useNameIdentifiesApplication')" persistent-hint variant="outlined" :rules="nameRules" :disabled="loading" maxlength="255" autocomplete="off" /><v-select ref="expirationInput" v-model="expiration" :items="expirations" :label="$t('admin:apiCreate.keyLifetime')" :hint="$t('admin:apiCreate.planReplaceKeyBefore')" persistent-hint variant="outlined" :rules="[requiredRule]" :disabled="loading" class="mt-4" /></section>
            <section v-show="step === 2" :aria-label="$t('admin:apiCreate.credentialAuthority')">
              <v-alert v-if="hasDelegableAuthority && seed && !seedAuthorityAvailable" type="info" variant="tonal" class="mb-3">{{ $t('admin:apiCreate.replacementAuthorityUnavailable') }}</v-alert>
              <v-radio-group ref="scopeInput" v-model="scope" :label="$t('admin:apiCreate.permissionSource')" :rules="[scopeRule]" :disabled="loading" color="primary"><v-radio value="group" :label="$t('admin:apiCreate.useGroupsPermissions')" :disabled="!selectableGroups.length" /><v-radio v-if="createFullAccess" value="full" :label="$t('admin:apiCreate.systemAdministratorPermissions')" /></v-radio-group>
              <v-alert v-if="scope === 'full' && createFullAccess" type="warning" variant="tonal" class="mb-4">{{ $t('admin:apiCreate.keyReceivesUnrestrictedSystem') }}</v-alert>
              <template v-if="scope === 'group'"><v-alert v-if="!selectableGroups.length" type="info" variant="tonal" class="mb-3">{{ $t('admin:apiCreate.noPermissionGroupsCurrently') }}</v-alert><v-select ref="groupInput" v-model="group" :items="selectableGroups" item-title="name" item-value="id" variant="outlined" color="primary" :label="$t('admin:apiCreate.permissionGroup')" :rules="groupRules" :disabled="loading || !selectableGroups.length" />
                <div v-if="selectedGrant" class="grant-preview"><strong>{{ selectedGrant.name }}</strong><p>{{ $t('admin:apiCreate.currentPermissionsPageRules', { permissionsCount: selectedGrant.permissions.length, pageRuleCount: selectedGrant.pageRuleCount, interpolation: { escapeValue: false } }) }}</p><div class="grant-permissions"><code v-for="permission in selectedGrant.permissions" :key="permission">{{ permission }}</code></div><details v-if="selectedGrant.pageRules.length" class="grant-rules"><summary>{{ $t('admin:apiCreate.reviewPageAccessRules') }}</summary><ul><li v-for="(rule, index) in selectedGrant.pageRules" :key="index"><strong>{{ rule.deny ? $t('admin:apiCreate.deny') : $t('admin:apiCreate.allow') }} · {{ rule.match }}</strong><code>{{ rule.path || '/' }}</code><small>{{ rule.roles.join(', ') || $t('admin:apiCreate.noActions') }} · {{ rule.locales.join(', ') || $t('admin:apiCreate.allLanguages') }}</small></li></ul></details><p class="key-note">{{ $t('admin:apiCreate.groupsCurrentGrantFuture') }}</p></div><v-alert v-else-if="group" type="info" variant="tonal">{{ $t('admin:apiCreate.permissionDetailsUnavailableReload') }}</v-alert>
              </template>
              <div class="mcp-key-choice"><v-checkbox v-model="mcpAccess" :label="$t('admin:apiCreate.allowKeyConnectThrough')" color="primary" hide-details :disabled="loading || (!mcpAccess && (!connections?.mcpEnabled || connections.mcpConfigurationError))" /><p class="key-note">{{ connections?.mcpEnabled ? $t('admin:apiCreate.keyWillBoundConfigured') : $t('admin:apiCreate.mcpMustEnabledDeployment') }}</p><p v-if="mcpAccess && scope === 'group' && selectedGrant && !selectedGrant.permissions.some(permission => ['use:mcp', 'manage:system'].includes(permission))" class="key-note">{{ $t('admin:apiCreate.groupDoesNotCurrently') }}</p><code v-if="mcpAccess">{{ connections?.mcpResource }}</code></div>
            </section>
            <section v-if="step === 3" :aria-label="$t('admin:apiCreate.credentialReview')"><dl class="key-review"><div><dt>{{ $t('admin:apiCreate.integration') }}</dt><dd>{{ name.trim() }}</dd></div><div><dt>{{ $t('admin:apiCreate.lifetime') }}</dt><dd>{{ expirations.find(item => item.value === expiration)?.title }}</dd></div><div><dt>{{ $t('admin:apiCreate.authority') }}</dt><dd>{{ scope === 'full' ? $t('admin:apiCreate.systemAdministrator') : selectableGroups.find(item => item.id === group)?.name || $t('admin:apiCreate.group', { group, interpolation: { escapeValue: false } }) }}</dd></div><div><dt>{{ $t('admin:apiCreate.protocols') }}</dt><dd>{{ mcpAccess ? $t('admin:apiCreate.restV1GraphqlMcp') : $t('admin:apiCreate.restV1Graphql') }}</dd></div><div v-if="mcpAccess"><dt>{{ $t('admin:apiCreate.mcpResource') }}</dt><dd>{{ connections?.mcpResource }}</dd></div></dl><p>{{ $t('admin:apiCreate.afterIssuingSaveKey') }}</p></section>
          </v-card-text>
          <v-card-actions class="key-dialog-actions"><v-btn variant="text" :disabled="loading" @click="isShown = false">{{ $t('common:actions.cancel') }}</v-btn><v-spacer /><v-btn v-if="step > 1" variant="text" :disabled="loading" @click="step--">{{ $t('admin:apiCreate.back') }}</v-btn><v-btn v-if="step < 3" color="primary" variant="flat" :disabled="loading || !hasDelegableAuthority" @click="nextStep">{{ $t('admin:apiCreate.continue') }}</v-btn><v-btn v-else type="submit" color="primary" variant="flat" :loading="loading" :disabled="loading || !hasDelegableAuthority">{{ $t('admin:apiCreate.issueKey') }}</v-btn></v-card-actions>
        </v-card>
      </v-form>
    </v-dialog>
    <v-dialog v-model="isCopyKeyDialogShown" max-width="760" persistent aria-labelledby="api-key-copy-title"><v-card class="api-key-dialog"><header class="key-dialog-heading"><span class="key-kicker">{{ $t('admin:apiCreate.credentialIssued') }}</span><h2 id="api-key-copy-title">{{ $t('admin:apiCreate.saveNewKey') }}</h2><p>{{ $t('admin:apiCreate.copyClientsSecretStorage') }}</p></header><v-card-text><v-textarea ref="keyContentsIpt" readonly no-resize :label="$t('admin:apiCreate.generatedApiKey')" :model-value="key" :rows="5" variant="outlined" hide-details class="api-key-value" /><div class="key-copy-actions"><v-btn variant="outlined" prepend-icon="mdi-content-copy" @click="copyKey">{{ copied ? $t('admin:apiCreate.copied') : $t('admin:apiCreate.copyKey') }}</v-btn><span v-if="copied" role="status">{{ $t('admin:apiCreate.keyCopied') }}</span></div><v-alert v-if="seed" type="info" variant="tonal" class="mt-4">{{ $t('admin:apiCreate.configureVerifyReplacementThen', { name: seed.name, interpolation: { escapeValue: false } }) }}</v-alert></v-card-text><v-card-actions><v-spacer /><v-btn color="primary" variant="flat" :disabled="loading" @click="finishCopyKey">{{ $t('admin:apiCreate.iveSavedKey') }}</v-btn></v-card-actions></v-card></v-dialog>
  </div>
</template>

<script lang='ts'>
import type { PropType } from 'vue'
import type { ApiAssignableGroup, ApiConnectionInfo } from '../../../shared/api-admin.ts'
import type { AdminApiKey } from '../../helpers/auth-api'
import { wikiStore } from '@/store/index.ts'

import { createAdminApiKey } from '../../helpers/auth-api'
import { getErrorMessage } from '../../helpers/root-ui-store'

export default {
  emits: ['update:modelValue', 'sensitive-state'],
  props: {
    assignableGroups: { type: Array as PropType<ApiAssignableGroup[]>, default: () => [] },
    connections: { type: Object as PropType<ApiConnectionInfo | null>, default: null },
    createFullAccess: { type: Boolean, default: false },
    seed: { type: Object as PropType<AdminApiKey | null>, default: null },
    modelValue: {
      type: Boolean,
      default: false
    },
    refreshApiKeys: {
      type: Function,
      default: null
    }
  },
  data() {
    return {
      step: 1,
      formError: '',
      mcpAccess: false,
      loading: false,
      name: '',
      expiration: '90d',
      scope: 'group' as 'full' | 'group' | null,
      group: null as number | null,
      isCopyKeyDialogShown: false,
      key: '',
      copied: false
    }
  },
  computed: {
    selectableGroups (): ApiAssignableGroup[] { return this.assignableGroups },
    selectedGrant () { return this.assignableGroups.find(group => group.id === this.group) },
    hasDelegableAuthority (): boolean { return this.createFullAccess || this.selectableGroups.length > 0 },
    seedAuthorityAvailable (): boolean {
      return !this.seed || (this.seed.grant.groupId === 1 ? this.createFullAccess : this.selectableGroups.some(group => group.id === this.seed?.grant.groupId))
    },
    flowProtected (): boolean { return this.loading || this.isCopyKeyDialogShown },
    isShown: {
      get() { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    },
    expirations() {
      return [
        { value: '30d', title: this.$t('admin:api.expiration30d') },
        { value: '90d', title: this.$t('admin:api.expiration90d') },
        { value: '180d', title: this.$t('admin:api.expiration180d') },
        { value: '1y', title: this.$t('admin:api.expiration1y') },
        { value: '3y', title: this.$t('admin:api.expiration3y') }
      ]
    },
    requiredRule (): (value: unknown) => true | string {
      return (value: unknown) => Boolean(value) || this.$t('admin:apiCreate.fieldRequired')
    },
    nameRules (): Array<(value: string) => true | string> {
      return [
        (value: string) => {
          const length = value?.trim().length ?? 0
          return (length >= 2 && length <= 255) || String(this.$t('admin:api.newKeyNameError'))
        }
      ]
    },
    scopeRule (): (value: string | null) => true | string {
      return (value: string | null) => Boolean(value) || this.$t('admin:apiCreate.choosePermissionScope')
    },
    groupRules (): Array<(value: number | null) => true | string> {
      return [
        (value: number | null) => {
          if (this.scope !== 'group') return true
          if (value === null) return String(this.$t('admin:api.newKeyGroupError'))
          return this.selectableGroups.some(group => group.id === value) || String(this.$t('admin:api.newKeyGuestGroupError'))
        }
      ]
    }
  },
  watch: {
    flowProtected (value: boolean) { this.$emit('sensitive-state', value) },
    modelValue: {
      immediate: true,
      handler (newValue: boolean) {
        if (newValue) {
          this.step = 1; this.formError = ''
          this.name = this.seed ? this.$t('admin:apiCreate.replacement', { name: this.seed.name, interpolation: { escapeValue: false } }).slice(0, 255) : ''
          this.expiration = '90d'
          this.scope = this.seed ? (this.seedAuthorityAvailable ? (this.seed.grant.groupId === 1 ? 'full' : 'group') : null) : 'group'
          this.group = this.seedAuthorityAvailable && this.seed?.grant.groupId && this.seed.grant.groupId > 2 ? this.seed.grant.groupId : null
          this.mcpAccess = Boolean(this.seed?.grant.mcpResource)
          this.$nextTick(() => {
            if (this.modelValue) this.focusFormControl('keyNameInput')
          })
        } else {
          const form = this.$refs.createForm as { resetValidation?: () => void } | undefined
          form?.resetValidation?.()
        }
      }
    },
    isCopyKeyDialogShown (newValue: boolean) {
      if (newValue) this.copied = false
    }
  },
  methods: {
    warnBeforeUnload (event: BeforeUnloadEvent) { if (this.modelValue || this.flowProtected) { event.preventDefault(); event.returnValue = '' } },
    nextStep () {
      this.formError = ''
      if (!this.hasDelegableAuthority) { this.formError = this.$t('admin:apiCreate.noDelegableAuthority'); return }
      if (this.step === 1 && (this.name.trim().length < 2 || this.name.trim().length > 255 || !this.expiration)) { this.formError = this.$t('admin:apiCreate.enterName2255'); this.focusFormControl('keyNameInput'); return }
      if (this.step === 2 && (!this.scope || (this.scope === 'full' && !this.createFullAccess) || (this.scope === 'group' && !this.selectableGroups.some(group => group.id === this.group)))) { this.formError = this.$t('admin:apiCreate.chooseAvailablePermissionGroup'); return }
      if (this.step === 2 && this.mcpAccess && (!this.connections?.mcpEnabled || this.connections.mcpConfigurationError)) { this.formError = this.$t('admin:apiCreate.mcpConfigurationUnavailableReload'); return }
      this.step++
    },
    async copyKey () {
      try {
        await navigator.clipboard.writeText(this.key)
        this.copied = true
      } catch {
        const input = this.$refs.keyContentsIpt as { select?: () => void } | undefined
        input?.select?.()
        wikiStore.showNotification({ style: 'red', message: this.$t('admin:apiCreate.copyFailedSelectKey'), icon: 'alert' })
      }
    },
    finishCopyKey () {
      this.isCopyKeyDialogShown = false
      this.copied = false
      this.key = ''
    },
    focusFormControl (refName: string) {
      const control = this.$refs[refName] as {
        focus?: () => void
        $el?: HTMLElement
      } | undefined
      if (control?.focus) {
        control.focus()
        return
      }
      control?.$el?.querySelector<HTMLElement>('input:not([disabled]), [tabindex]:not([tabindex="-1"])')?.focus()
    },
    async generate () {
      if (this.loading) return
      if (this.step < 3) { this.nextStep(); return }
      if (!this.hasDelegableAuthority || !this.scope) { this.step = 2; this.formError = this.$t('admin:apiCreate.chooseAvailablePermissionGroup'); return }
      if (this.scope === 'full' && !this.createFullAccess) { this.step = 2; this.formError = this.$t('admin:apiCreate.systemAdministratorDelegationUnavailable'); return }
      if (this.scope === 'group' && !this.selectableGroups.some(group => group.id === this.group)) { this.step = 2; this.formError = this.$t('admin:apiCreate.chooseAvailablePermissionGroup'); return }
      if (this.mcpAccess && (!this.connections?.mcpEnabled || this.connections.mcpConfigurationError)) { this.step = 2; this.formError = this.$t('admin:apiCreate.mcpConfigurationUnavailableReload'); return }
      const form = this.$refs.createForm as {
        validate?: () => Promise<{ valid: boolean }>
      } | undefined
      const validation = await form?.validate?.()
      if (!validation?.valid) {
        const normalizedName = this.name.trim()
        let firstInvalid = 'keyNameInput'
        if (normalizedName.length >= 2 && normalizedName.length <= 255) {
          if (!this.expiration) firstInvalid = 'expirationInput'
          else if (!this.scope) firstInvalid = 'scopeInput'
          else if (this.scope === 'full' && !this.createFullAccess) firstInvalid = 'scopeInput'
          else if (this.scope === 'group' && (this.group === null || !this.selectableGroups.some(group => group.id === this.group))) firstInvalid = 'groupInput'
        }
        this.step = ['keyNameInput', 'expirationInput'].includes(firstInvalid) ? 1 : 2
        this.$nextTick(() => this.focusFormControl(firstInvalid))
        return
      }
      this.name = this.name.trim()

      this.loading = true
      wikiStore.startLoading('admin-api-create')

      try {
        const resp = await createAdminApiKey(window.fetch.bind(window), {
          name: this.name,
          expiration: this.expiration,
          fullAccess: this.scope === 'full',
          group: this.scope === 'group' ? this.group : null,
          mcpAccess: this.mcpAccess
        })
        this.key = resp.key
        this.isCopyKeyDialogShown = true
        this.isShown = false
        this.name = ''
        this.expiration = '90d'
        this.scope = 'group'
        this.group = null
        const refreshed = this.refreshApiKeys ? await (this.refreshApiKeys as (notify: boolean) => Promise<boolean>)(false).catch(() => false) : true

        if (refreshed) {
          wikiStore.showNotification({
            style: 'success',
            message: this.$t('admin:api.newKeySuccess'),
            icon: 'check'
          })
        }

      } catch (err) {
        this.formError = getErrorMessage(err)
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-api-create')
        this.loading = false
      }
    }
  },
  mounted () { window.addEventListener('beforeunload', this.warnBeforeUnload) },
  beforeUnmount () { window.removeEventListener('beforeunload', this.warnBeforeUnload); this.key = '' }
}
</script>
<style scoped>
.api-key-dialog { max-height: min(850px, calc(100dvh - 3rem)); display: flex; flex-direction: column; }
.key-dialog-heading { padding: 1.75rem 1.75rem .5rem; }.key-kicker { font-size: .7rem; letter-spacing: .09em; text-transform: uppercase; color: var(--wiki-accent-ink); }.key-dialog-heading h2 { font: 500 clamp(1.6rem, 4vw, 2rem) var(--wiki-font-display); margin-block: .6rem .75rem; }p { font-size: .85rem; line-height: 1.7; margin-bottom: 1rem; }
.key-progress { display: flex; list-style: none; gap: 1.5rem; padding: .75rem 1.75rem 1.25rem; border-bottom: 1px solid var(--wiki-surface-border); }.key-progress li { display: flex; align-items: center; gap: .5rem; font-size: .8rem; }.key-progress span { display: grid; place-items: center; width: 1.6rem; height: 1.6rem; border: 1px solid var(--wiki-surface-border); border-radius: 50%; font-size: .7rem; }.key-progress .current { color: var(--wiki-accent-ink); }.key-progress .current span { border-color: currentColor; }
.key-dialog-body { overflow-y: auto; padding: 1.5rem 1.75rem; }.key-dialog-actions { flex-shrink: 0; padding: 1rem 1.25rem; border-top: 1px solid var(--wiki-surface-border); }.grant-preview { padding: 1rem; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); }.grant-preview strong { font-size: .9rem; }.grant-preview p { margin-block: .4rem; }.grant-permissions { display: flex; flex-wrap: wrap; gap: .4rem; }.grant-permissions code { border: 1px solid var(--wiki-surface-border); padding: .25rem .4rem; border-radius: .3rem; font-size: .72rem; overflow-wrap: anywhere; }.grant-rules { margin-top: 1rem; }.grant-rules summary { cursor: pointer; font-size: .8rem; }.grant-rules ul { list-style: none; padding: 0; }.grant-rules li { display: grid; gap: .3rem; padding-block: .75rem; border-bottom: 1px solid var(--wiki-surface-border); font-size: .75rem; }.grant-rules code { overflow-wrap: anywhere; }.grant-rules small { font-size: .7rem; }
.key-note { font-size: .75rem; }.mcp-key-choice { margin-top: 1.5rem; padding-top: .5rem; border-top: 1px solid var(--wiki-surface-border); }.mcp-key-choice > code { display: block; font-size: .8rem; overflow-wrap: anywhere; }
.key-review { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 1.5rem; margin-bottom: 1.5rem; }.key-review dt { font-size: .7rem; }.key-review dd { font-size: .9rem; margin: .5rem 0 0; overflow-wrap: anywhere; }.key-copy-actions { display: flex; align-items: center; gap: 1rem; margin-top: 1rem; font-size: .8rem; }
@media(max-width: 600px) { .key-dialog-heading { padding: 1.25rem 1rem .5rem; }.key-dialog-body { padding: 1rem; }.key-progress { padding-inline: 1rem; gap: 1rem; }.key-review { grid-template-columns: 1fr; } }
</style>
