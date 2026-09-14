<template>
  <v-dialog :model-value="modelValue" max-width="820" :persistent="saving" aria-label="Create an account" @update:model-value="value => !value && close()">
    <v-card class="account-create-dialog">
      <v-card-title><span class="account-create-kicker">People & access · {{ reviewing ? 'Review' : 'New account' }}</span><h2>{{ reviewing ? 'Ready to welcome someone?' : 'A place in your workspace.' }}</h2></v-card-title>
      <v-card-text>
        <async-state v-if="loading" state="loading" title="Loading account creation options" />
        <async-state v-else-if="loadError" state="error" title="Creation options are unavailable" :message="loadError" retry-label="Try again" @retry="loadOptions" />
        <template v-else-if="options">
          <template v-if="!reviewing">
            <p class="account-create-intro">Create a person’s account and choose the groups that give them access. Their sign-in provider keeps responsibility for authentication.</p>
            <div class="account-create-fields"><v-text-field v-model="profile.name" label="Display name" autocomplete="off" variant="outlined" maxlength="255" :disabled="saving" /><v-text-field v-model="profile.email" label="Email address" type="email" autocomplete="off" variant="outlined" maxlength="255" :disabled="saving" /><v-select v-model="providerKey" label="Sign-in provider" :items="providers" item-title="title" item-value="key" variant="outlined" :disabled="saving" /><v-text-field v-model="profile.timezone" label="Time zone" variant="outlined" hint="Leave blank to use the current workspace default, or enter an IANA time zone such as Europe/London." persistent-hint :disabled="saving" /></div>
            <div class="account-create-provider"><v-icon :icon="local ? 'mdi-key-outline' : 'mdi-domain'" /><div><strong>{{ local ? 'A temporary password for the first sign-in' : 'Authentication stays with ' + (provider?.title || 'the identity provider') }}</strong><p>{{ local ? 'Share the temporary password with the person through an appropriate private channel. It is never included in a welcome email.' : 'This pre-creates a matching account. It does not create an identity or password in the external service.' }}</p></div></div>
            <template v-if="local"><v-text-field v-model="password" label="Temporary password" :type="showPassword ? 'text' : 'password'" autocomplete="new-password" variant="outlined" :hint="passwordHint" persistent-hint :disabled="saving"><template #append-inner><v-btn variant="text" :icon="showPassword ? 'mdi-eye-off-outline' : 'mdi-eye-outline'" :aria-label="showPassword ? 'Hide temporary password' : 'Show temporary password'" size="small" @click="showPassword = !showPassword" /></template></v-text-field><v-checkbox v-model="mustChangePassword" label="Require a new password at first sign-in" hide-details :disabled="saving" /></template>
            <div class="account-create-section"><h3>Membership</h3><p>Choose only the access this person needs. Permissions from selected groups are combined.</p><div class="account-create-groups"><label v-for="group in assignableGroups" :key="group.id" :class="{ selected: profile.groups.includes(group.id) }"><input v-model="profile.groups" type="checkbox" :value="group.id" :disabled="saving" /><span><strong>{{ group.name }}</strong><small>{{ group.permissions.length }} {{ group.permissions.length === 1 ? 'permission' : 'permissions' }}{{ group.isSystem ? ' · System group' : '' }}</small></span></label></div><p v-if="!profile.groups.length" class="account-create-hint">No groups selected. The account will have no group-granted permissions.</p><details v-if="selectedPermissions.length" class="account-create-permissions"><summary>Combined permissions · {{ selectedPermissions.length }}</summary><ul><li v-for="permission in selectedPermissions" :key="permission">{{ permission }}</li></ul></details></div>
            <div class="account-create-section"><h3>Email ownership</h3><v-checkbox v-model="isVerified" label="I have confirmed this person’s email address" hide-details :disabled="saving" /><p class="account-create-hint">Otherwise the account remains unverified. You can verify it later from its account workspace; this form does not send a verification link.</p></div>
            <v-alert v-if="attempted && issues.length" type="error" variant="tonal" class="mt-4"><ul><li v-for="issue in issues" :key="issue">{{ issue }}</li></ul></v-alert>
          </template>
          <template v-else>
            <div class="account-create-identity"><span aria-hidden="true">{{ profile.name.trim().slice(0,1).toUpperCase() }}</span><div><h3>{{ profile.name }}</h3><p>{{ profile.email }}</p></div></div>
            <dl class="account-create-summary"><div><dt>Sign-in provider</dt><dd>{{ provider?.title }}</dd></div><div><dt>Membership</dt><dd>{{ selectedGroups.map(group => group.name).join(', ') || 'No groups' }}</dd></div><div><dt>Email ownership</dt><dd>{{ isVerified ? 'Confirmed by you' : 'Unverified' }}</dd></div><div v-if="local"><dt>First sign-in</dt><dd>{{ mustChangePassword ? 'Must choose a new password' : 'Uses the supplied password' }}</dd></div><div><dt>Email delivery</dt><dd>No email is sent during creation</dd></div></dl>
            <p class="account-create-hint">The account will be active. Unverified status and the selected provider’s policies may still prevent sign-in. Welcome email can be sent explicitly from the account workspace.</p>
            <v-textarea v-model="reason" label="Administrative reason" variant="outlined" rows="2" maxlength="1000" hint="3–1,000 characters, retained in account history. Do not include passwords." persistent-hint :disabled="saving" />
          </template>
          <v-alert v-if="saveError" type="error" variant="tonal" class="mt-4">{{ saveError }}<v-btn v-if="conflict" variant="text" :disabled="saving" @click="reloadOptions">Reload creation options</v-btn></v-alert>
        </template>
      </v-card-text>
      <v-card-actions><v-btn variant="text" :disabled="saving" @click="reviewing ? reviewing = false : close()">{{ reviewing ? 'Keep editing' : 'Cancel' }}</v-btn><v-spacer /><v-btn v-if="options && !loading && !loadError" color="primary" variant="flat" :loading="saving" :disabled="reviewing && (reason.trim().length < 3 || conflict)" @click="reviewing ? save() : review()">{{ reviewing ? 'Create account' : 'Review account' }}</v-btn></v-card-actions>
    </v-card>
  </v-dialog>
</template>
<script lang="ts">
import { passwordPolicyMixin } from '../../helpers/password-policy.ts'
import { newPasswordIssue } from '../../../shared/security-policy.ts'
import AsyncState from '@/components/common/async-state.vue'
import { accountProfileIssues, type AccountCreationOptions, type AccountProfileDraft } from '../../../shared/account-policy.ts'
import { fetchAccountCreationOptions, createAccount, accountRequestStatus } from '../../helpers/account-api.ts'
import { getErrorMessage } from '../../helpers/root-ui-store.ts'
const emptyProfile = (): AccountProfileDraft => ({ name: '', email: '', location: '', jobTitle: '', timezone: '', groups: [] })
export default {
  mixins: [passwordPolicyMixin],
  components: { AsyncState }, props: { modelValue: { type: Boolean, default: false } }, emits: ['update:modelValue', 'created'],
  data() { return { options: null as AccountCreationOptions | null, profile: emptyProfile(), providerKey: 'local', password: '', showPassword: false, mustChangePassword: true, isVerified: false, reason: '', reviewing: false, attempted: false, loading: false, loadError: '', saving: false, saveError: '', conflict: false, sequence: 0, disposed: false } },
  computed: {
    providers() { return (this.options?.providers ?? []).filter(provider => provider.enabled && provider.available) },
    provider() { return this.providers.find(provider => provider.key === this.providerKey) },
    local(): boolean { return this.provider?.localPassword === true },
    assignableGroups() { return (this.options?.groups ?? []).filter(group => group.canAssign) },
    selectedGroups() { return (this.options?.groups ?? []).filter(group => this.profile.groups.includes(group.id)) },
    selectedPermissions() { return [...new Set(this.selectedGroups.flatMap(group => group.permissions))].sort() },
    issues(): string[] { const profile = this.profile.timezone ? this.profile : { ...this.profile, timezone: 'UTC' }; return [...accountProfileIssues(profile), ...(!this.provider ? ['Choose an enabled sign-in provider.'] : []), ...(this.local && (newPasswordIssue(this.password, this.passwordMinimum)) ? [newPasswordIssue(this.password, this.passwordMinimum)!] : []), ...(this.profile.groups.some(id => !this.assignableGroups.some(group => group.id === id)) ? ['Remove unavailable groups before continuing.'] : [])] },
    modified(): boolean { return Boolean(this.profile.name || this.profile.email || this.password || this.profile.groups.length || this.reason) }
  },
  watch: {
    modelValue: { immediate: true, handler(value: boolean) { if (value) { this.profile = emptyProfile(); this.password = ''; this.reason = ''; this.reviewing = false; this.attempted = false; this.isVerified = false; this.mustChangePassword = true; this.saveError = ''; this.conflict = false; void this.loadOptions() } else { this.sequence++; this.password = '' } } },
    providerKey() { this.password = ''; this.showPassword = false }
  },
  methods: {
    async loadOptions() { const sequence = ++this.sequence; this.loading = true; this.loadError = ''; try { const options = await fetchAccountCreationOptions(); if (this.disposed || sequence !== this.sequence) return; this.options = options; if (!this.providers.some(provider => provider.key === this.providerKey)) this.providerKey = this.providers[0]?.key ?? '' } catch (error) { if (!this.disposed && sequence === this.sequence) this.loadError = getErrorMessage(error) } finally { if (!this.disposed && sequence === this.sequence) this.loading = false } },
    async reloadOptions() { this.reviewing = false; this.conflict = false; this.saveError = ''; await this.loadOptions() },
    review() { this.attempted = true; if (!this.issues.length) { this.reviewing = true; this.saveError = '' } },
    async save() { if (!this.options || this.saving || this.issues.length || this.reason.trim().length < 3) return; this.saving = true; this.saveError = ''; try { const result = await createAccount({ fingerprint: this.options.fingerprint, profile: JSON.parse(JSON.stringify(this.profile)) as AccountProfileDraft, providerKey: this.providerKey, ...(this.local ? { password: this.password } : {}), isVerified: this.isVerified, mustChangePassword: this.local && this.mustChangePassword, reason: this.reason.trim() }); this.password = ''; this.profile = emptyProfile(); this.reason = ''; this.$emit('created', result.id); this.$emit('update:modelValue', false) } catch (error) { this.conflict = accountRequestStatus(error) === 409; this.saveError = getErrorMessage(error) + (accountRequestStatus(error) === 0 ? ' The outcome is unconfirmed. Check the directory for this email before creating it again.' : '') } finally { this.saving = false } },
    canLeave(): boolean { return !this.saving && (!this.modelValue || !this.modified || window.confirm('Discard this unsaved account?')) },
    close() { if (this.canLeave()) { this.password = ''; this.$emit('update:modelValue', false) } },
    beforeUnload(event: BeforeUnloadEvent) { if (this.modelValue && (this.modified || this.saving)) { event.preventDefault(); event.returnValue = '' } }
  },
  mounted() { window.addEventListener('beforeunload', this.beforeUnload) },
  beforeUnmount() { this.disposed = true; this.sequence++; this.password = ''; window.removeEventListener('beforeunload', this.beforeUnload) }
}
</script>
<style lang="scss">
.account-create-dialog { --account-line:rgba(var(--v-theme-on-surface),.12); max-height:90dvh; .v-card-title { padding:26px 28px 14px; white-space:normal; h2 { font-size:1.6rem; line-height:1.3; font-weight:500; margin-top:7px; letter-spacing:-.02em; } } .v-card-text { padding:12px 28px 26px; overflow-y:auto; } .v-card-actions { padding:16px 22px; border-top:1px solid var(--account-line); flex-wrap:wrap; } }
.account-create-kicker { font-size:.65rem; letter-spacing:.12em; font-weight:650; text-transform:uppercase; color:rgba(var(--v-theme-on-surface),.64); }
.account-create-intro { color:rgba(var(--v-theme-on-surface),.72); font-size:.87rem; line-height:1.65; margin-bottom:24px; }
.account-create-fields { display:grid; grid-template-columns:1fr 1fr; gap:4px 18px; }
.account-create-provider { display:flex; gap:14px; align-items:flex-start; background:rgba(var(--v-theme-on-surface),.035); padding:17px; border-radius:8px; margin:12px 0 22px; strong { font-size:.84rem; } p { font-size:.77rem; line-height:1.6; color:rgba(var(--v-theme-on-surface),.7); margin:5px 0 0; } }
.account-create-section { margin:26px 0; padding-top:24px; border-top:1px solid var(--account-line); h3 { font-size:1rem; font-weight:600; } >p { margin:7px 0 16px; font-size:.8rem; line-height:1.65; color:rgba(var(--v-theme-on-surface),.7); } }
.account-create-groups { display:grid; grid-template-columns:1fr 1fr; gap:10px; label { display:flex; align-items:flex-start; gap:12px; border:1px solid var(--account-line); padding:14px; border-radius:8px; cursor:pointer; &.selected { border-color:rgba(var(--v-theme-primary),.65); background:rgba(var(--v-theme-primary),.045); } input { margin-top:3px; width:16px; height:16px; accent-color:rgb(var(--v-theme-primary)); } strong,small { display:block; } strong { font-size:.82rem; } small { margin-top:4px; color:rgba(var(--v-theme-on-surface),.66); font-size:.7rem; } } }
.account-create-hint { font-size:.77rem; color:rgba(var(--v-theme-on-surface),.7); line-height:1.65; margin:12px 0 20px; }
.account-create-permissions { margin-top:16px; summary { cursor:pointer; font-size:.78rem; } ul { display:flex; flex-wrap:wrap; gap:7px 16px; padding:15px 0; list-style:none; font-size:.72rem; } }
.account-create-identity { display:flex; gap:16px; align-items:center; margin:8px 0 24px; >span { width:52px; height:52px; border-radius:50%; background:rgba(var(--v-theme-primary),.1); display:grid; place-items:center; font-size:1.2rem; } h3 { font-size:1.2rem; font-weight:550; overflow-wrap:anywhere; } p { margin-top:3px; font-size:.85rem; color:rgba(var(--v-theme-on-surface),.7); overflow-wrap:anywhere; } }
.account-create-summary { display:grid; grid-template-columns:1fr 1fr; gap:20px; padding:22px 0; border-block:1px solid var(--account-line); dt { font-size:.7rem; color:rgba(var(--v-theme-on-surface),.66); margin-bottom:7px; } dd { font-size:.87rem; overflow-wrap:anywhere; } }
@media(max-width:600px) { .account-create-fields,.account-create-groups,.account-create-summary { grid-template-columns:1fr; } .account-create-dialog .v-card-title { padding:22px 20px 12px; h2 { font-size:1.35rem; } } .account-create-dialog .v-card-text { padding:10px 20px 20px; } }
</style>
