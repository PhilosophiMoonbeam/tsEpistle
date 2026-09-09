<template>
  <div>
    <v-dialog v-model="isShown" max-width="760" persistent aria-labelledby="api-key-create-title">
      <v-form ref="createForm" @submit.prevent="generate">
        <v-card class="api-key-dialog">
          <header class="key-dialog-heading"><span class="key-kicker">{{ seed ? 'Credential replacement' : 'New integration identity' }}</span><h2 id="api-key-create-title">{{ step === 1 ? 'Name this connection.' : step === 2 ? 'Define its authority.' : 'Review before issuing.' }}</h2><p>{{ seed ? 'The existing key stays valid until you revoke it. Configure and verify the replacement first.' : 'Create a dedicated credential with the access this integration needs.' }}</p></header>
          <ol class="key-progress" aria-label="Key creation steps"><li v-for="(label, index) in ['Identity', 'Access', 'Review']" :key="label" :aria-current="step === index + 1 ? 'step' : undefined" :class="{ current: step === index + 1 }"><span>{{ index + 1 }}</span>{{ label }}</li></ol>
          <v-card-text class="key-dialog-body">
            <v-alert v-if="formError" type="error" variant="tonal" class="mb-4">{{ formError }}</v-alert>
            <section v-show="step === 1" aria-label="Credential identity"><v-text-field ref="keyNameInput" v-model="name" label="Integration name" hint="Use a name that identifies the application, agent or workflow." persistent-hint variant="outlined" :rules="nameRules" :disabled="loading" maxlength="255" autocomplete="off" /><v-select ref="expirationInput" v-model="expiration" :items="expirations" label="Key lifetime" hint="Plan to replace this key before it expires." persistent-hint variant="outlined" :rules="[requiredRule]" :disabled="loading" class="mt-4" /></section>
            <section v-show="step === 2" aria-label="Credential authority">
              <v-radio-group ref="scopeInput" v-model="scope" label="Permission source" :rules="[scopeRule]" :disabled="loading" color="primary"><v-radio value="group" label="Use a group’s permissions" :disabled="!selectableGroups.length" /><v-radio value="full" label="System administrator permissions" :disabled="!createFullAccess" /></v-radio-group>
              <v-alert v-if="scope === 'full'" type="warning" variant="tonal" class="mb-4">This key receives unrestricted system-administrator authority. Choose a scoped group when the integration needs less access.</v-alert>
              <template v-if="scope === 'group'"><v-alert v-if="!selectableGroups.length" type="info" variant="tonal" class="mb-3">No permission groups are currently available for delegation.</v-alert><v-select ref="groupInput" v-model="group" :items="selectableGroups" item-title="name" item-value="id" variant="outlined" color="primary" label="Permission group" :rules="groupRules" :disabled="loading || !selectableGroups.length" />
                <div v-if="selectedGrant" class="grant-preview"><strong>{{ selectedGrant.name }}</strong><p>{{ selectedGrant.permissions.length }} current permissions · {{ selectedGrant.pageRuleCount }} page rules</p><div class="grant-permissions"><code v-for="permission in selectedGrant.permissions" :key="permission">{{ permission }}</code></div><details v-if="selectedGrant.pageRules.length" class="grant-rules"><summary>Review page access rules</summary><ul><li v-for="(rule, index) in selectedGrant.pageRules" :key="index"><strong>{{ rule.deny ? 'Deny' : 'Allow' }} · {{ rule.match }}</strong><code>{{ rule.path || '/' }}</code><small>{{ rule.roles.join(', ') || 'No actions' }} · {{ rule.locales.join(', ') || 'All languages' }}</small></li></ul></details><p class="key-note">This is the group’s current grant. Future group changes apply to the key.</p></div><v-alert v-else-if="group" type="info" variant="tonal">Permission details are unavailable. Reload the API administration page.</v-alert>
              </template>
              <div class="mcp-key-choice"><v-checkbox v-model="mcpAccess" label="Allow this key to connect through MCP" color="primary" hide-details :disabled="loading || (!mcpAccess && (!connections?.mcpEnabled || connections.mcpConfigurationError))" /><p class="key-note">{{ connections?.mcpEnabled ? 'The key will be bound to the configured MCP resource below. REST and GraphQL access also remain available.' : 'MCP must be enabled in the deployment before issuing an MCP-capable key.' }}</p><p v-if="mcpAccess && scope === 'group' && selectedGrant && !selectedGrant.permissions.some(permission => ['use:mcp', 'manage:system'].includes(permission))" class="key-note">This group does not currently grant use:mcp or manage:system. The binding alone will not authorize MCP requests.</p><code v-if="mcpAccess">{{ connections?.mcpResource }}</code></div>
            </section>
            <section v-if="step === 3" aria-label="Credential review"><dl class="key-review"><div><dt>Integration</dt><dd>{{ name.trim() }}</dd></div><div><dt>Lifetime</dt><dd>{{ expirations.find(item => item.value === expiration)?.title }}</dd></div><div><dt>Authority</dt><dd>{{ scope === 'full' ? 'System administrator' : selectableGroups.find(item => item.id === group)?.name || `Group ${group}` }}</dd></div><div><dt>Protocols</dt><dd>{{ mcpAccess ? 'REST v1 · GraphQL · MCP' : 'REST v1 · GraphQL' }}</dd></div><div v-if="mcpAccess"><dt>MCP resource</dt><dd>{{ connections?.mcpResource }}</dd></div></dl><p>After issuing, save the key in your client’s secret storage. This interface will show the complete credential only once.</p></section>
          </v-card-text>
          <v-card-actions class="key-dialog-actions"><v-btn variant="text" :disabled="loading" @click="isShown = false">Cancel</v-btn><v-spacer /><v-btn v-if="step > 1" variant="text" :disabled="loading" @click="step--">Back</v-btn><v-btn v-if="step < 3" color="primary" variant="flat" :disabled="loading" @click="nextStep">Continue</v-btn><v-btn v-else type="submit" color="primary" variant="flat" :loading="loading" :disabled="loading || (scope === 'group' && !selectableGroups.length)">Issue key</v-btn></v-card-actions>
        </v-card>
      </v-form>
    </v-dialog>
    <v-dialog v-model="isCopyKeyDialogShown" max-width="760" persistent aria-labelledby="api-key-copy-title"><v-card class="api-key-dialog"><header class="key-dialog-heading"><span class="key-kicker">Credential issued</span><h2 id="api-key-copy-title">Save your new key.</h2><p>Copy it to your client’s secret storage before continuing. The complete key will not be displayed again here.</p></header><v-card-text><v-textarea ref="keyContentsIpt" readonly no-resize label="Generated API key" :model-value="key" :rows="5" variant="outlined" hide-details class="api-key-value" /><div class="key-copy-actions"><v-btn variant="outlined" prepend-icon="mdi-content-copy" @click="copyKey">{{ copied ? 'Copied' : 'Copy key' }}</v-btn><span v-if="copied" role="status">Key copied.</span></div><v-alert v-if="seed" type="info" variant="tonal" class="mt-4">Configure and verify this replacement, then revoke {{ seed.name }} from the credential register.</v-alert></v-card-text><v-card-actions><v-spacer /><v-btn color="primary" variant="flat" :disabled="loading" @click="finishCopyKey">I’ve saved this key</v-btn></v-card-actions></v-card></v-dialog>
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
  emits: ['update:modelValue', 'sensitive-state', 'retry-connections'],
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
      return (value: unknown) => Boolean(value) || 'This field is required.'
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
      return (value: string | null) => Boolean(value) || 'Choose a permission scope.'
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
          this.name = this.seed ? `${this.seed.name} replacement`.slice(0, 255) : ''
          this.expiration = '90d'
          this.scope = this.seed?.grant.groupId === 1 ? 'full' : 'group'
          this.group = this.seed?.grant.groupId && this.seed.grant.groupId > 2 ? this.seed.grant.groupId : null
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
      if (this.step === 1 && (this.name.trim().length < 2 || this.name.trim().length > 255 || !this.expiration)) { this.formError = 'Enter a name with 2–255 characters and choose a lifetime.'; this.focusFormControl('keyNameInput'); return }
      if (this.step === 2 && (!this.scope || (this.scope === 'full' && !this.createFullAccess) || (this.scope === 'group' && !this.selectableGroups.some(group => group.id === this.group)))) { this.formError = 'Choose an available permission group or administrator access.'; return }
      if (this.step === 2 && this.mcpAccess && (!this.connections?.mcpEnabled || this.connections.mcpConfigurationError)) { this.formError = 'MCP configuration is unavailable. Reload connection details or turn off MCP access.'; return }
      this.step++
    },
    async copyKey () {
      try {
        await navigator.clipboard.writeText(this.key)
        this.copied = true
      } catch {
        const input = this.$refs.keyContentsIpt as { select?: () => void } | undefined
        input?.select?.()
        wikiStore.showNotification({ style: 'red', message: 'Copy failed. Select the key and copy it manually.', icon: 'alert' })
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
      if (this.scope === 'full' && !this.createFullAccess) { this.step = 2; this.formError = 'System administrator delegation is unavailable for your current session.'; return }
      if (this.scope === 'group' && !this.selectableGroups.some(group => group.id === this.group)) { this.step = 2; this.formError = 'Choose an available permission group or administrator access.'; return }
      if (this.mcpAccess && (!this.connections?.mcpEnabled || this.connections.mcpConfigurationError)) { this.step = 2; this.formError = 'MCP configuration is unavailable. Reload connection details or turn off MCP access.'; return }
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
