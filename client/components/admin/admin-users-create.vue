<template>
  <v-dialog :model-value="modelValue" max-width="820" :persistent="saving" :aria-label="$t('admin:usersCreate.createAccount2')" @update:model-value="value => !value && close()">
    <v-card class="account-create-dialog">
      <v-card-title><span class="account-create-kicker">{{ $t('admin:usersCreate.peopleAccess', { value: reviewing ? $t('admin:usersCreate.review') : $t('admin:usersCreate.newAccount'), interpolation: { escapeValue: false } }) }}</span><h2>{{ reviewing ? $t('admin:usersCreate.readyWelcomeSomeone') : $t('admin:usersCreate.placeWorkspace') }}</h2></v-card-title>
      <v-card-text>
        <async-state v-if="loading" state="loading" :title="$t('admin:usersCreate.loadingAccountCreationOptions')" />
        <async-state v-else-if="loadError" state="error" :title="$t('admin:usersCreate.creationOptionsUnavailable')" :message="loadError" :retry-label="$t('admin:usersCreate.tryAgain')" @retry="loadOptions" />
        <template v-else-if="options">
          <template v-if="!reviewing">
            <p class="account-create-intro">{{ $t('admin:usersCreate.createPersonsAccountChoose') }}</p>
            <div class="account-create-fields"><v-text-field v-model="profile.name" :label="$t('admin:usersCreate.displayName')" autocomplete="off" variant="outlined" maxlength="255" :disabled="saving" /><v-text-field v-model="profile.email" :label="$t('admin:usersCreate.emailAddress')" type="email" autocomplete="off" variant="outlined" maxlength="255" :disabled="saving" /><v-select v-model="providerKey" :label="$t('admin:usersCreate.signProvider')" :items="providers" item-title="title" item-value="key" variant="outlined" :disabled="saving" /><v-text-field v-model="profile.timezone" :label="$t('admin:usersCreate.timeZone')" variant="outlined" :hint="$t('admin:usersCreate.leaveBlankUseCurrent')" persistent-hint :disabled="saving" /></div>
            <div class="account-create-provider"><v-icon :icon="local ? 'mdi-key-outline' : 'mdi-domain'" /><div><strong>{{ local ? $t('admin:usersCreate.temporaryPasswordFirstSign') : $t('admin:usersCreate.authenticationStays', { title: (provider?.title || 'the identity provider'), interpolation: { escapeValue: false } }) }}</strong><p>{{ local ? $t('admin:usersCreate.shareTemporaryPasswordPerson') : $t('admin:usersCreate.preCreatesMatchingAccount') }}</p></div></div>
            <template v-if="local"><v-text-field v-model="password" :label="$t('admin:usersCreate.temporaryPassword')" :type="showPassword ? 'text' : 'password'" autocomplete="new-password" variant="outlined" :hint="passwordHint" persistent-hint :disabled="saving"><template #append-inner><password-visibility-toggle v-model:visible="showPassword" :field="$t('admin:usersCreate.temporaryPassword2')" /></template></v-text-field><v-checkbox v-model="mustChangePassword" :label="$t('admin:usersCreate.requireNewPasswordFirst')" hide-details :disabled="saving" /></template>
            <div class="account-create-section"><h3>{{ $t('admin:usersCreate.membership') }}</h3><p>{{ $t('admin:usersCreate.chooseOnlyAccessPerson') }}</p><div class="account-create-groups"><label v-for="group in assignableGroups" :key="group.id" :class="{ selected: profile.groups.includes(group.id) }"><input v-model="profile.groups" type="checkbox" :value="group.id" :disabled="saving" /><span><strong>{{ group.name }}</strong><small>{{ $t('admin:usersCreate.permissionsCount', { count: group.permissions.length }) }}{{ group.isSystem ? ` ${$t('admin:usersCreate.systemGroup')}` : '' }}</small></span></label></div><p v-if="!profile.groups.length" class="account-create-hint">{{ $t('admin:usersCreate.noGroupsSelectedAccount') }}</p><details v-if="selectedPermissions.length" class="account-create-permissions"><summary>{{ $t('admin:usersCreate.combinedPermissions', { selectedPermissionsCount: selectedPermissions.length, interpolation: { escapeValue: false } }) }}</summary><ul><li v-for="permission in selectedPermissions" :key="permission">{{ permission }}</li></ul></details></div>
            <div class="account-create-section"><h3>{{ $t('admin:usersCreate.emailOwnership') }}</h3><v-checkbox v-model="isVerified" :label="$t('admin:usersCreate.iHaveConfirmedPersons')" hide-details :disabled="saving" /><p class="account-create-hint">{{ $t('admin:usersCreate.otherwiseAccountRemainsUnverified') }}</p></div>
            <v-alert v-if="attempted && issues.length" type="error" variant="tonal" class="mt-4"><ul><li v-for="issue in issues" :key="issue">{{ issue }}</li></ul></v-alert>
          </template>
          <template v-else>
            <div class="account-create-identity"><span aria-hidden="true">{{ profile.name.trim().slice(0,1).toUpperCase() }}</span><div><h3>{{ profile.name }}</h3><p>{{ profile.email }}</p></div></div>
            <dl class="account-create-summary"><div><dt>{{ $t('admin:usersCreate.signProvider') }}</dt><dd>{{ provider?.title }}</dd></div><div><dt>{{ $t('admin:usersCreate.membership') }}</dt><dd>{{ selectedGroups.map(group => group.name).join(', ') || $t('admin:usersCreate.noGroups') }}</dd></div><div><dt>{{ $t('admin:usersCreate.emailOwnership') }}</dt><dd>{{ isVerified ? $t('admin:usersCreate.confirmedYou') : $t('admin:usersCreate.unverified') }}</dd></div><div v-if="local"><dt>{{ $t('admin:usersCreate.firstSign') }}</dt><dd>{{ mustChangePassword ? $t('admin:usersCreate.mustChooseNewPassword') : $t('admin:usersCreate.usesSuppliedPassword') }}</dd></div><div><dt>{{ $t('admin:usersCreate.emailDelivery') }}</dt><dd>{{ $t('admin:usersCreate.noEmailSentDuring') }}</dd></div></dl>
            <p class="account-create-hint">{{ $t('admin:usersCreate.accountWillActiveUnverified') }}</p>
            <v-textarea v-model="reason" :label="$t('admin:usersCreate.administrativeReason')" variant="outlined" rows="2" maxlength="1000" :hint="$t('admin:usersCreate.n31000Characters')" persistent-hint :disabled="saving" />
          </template>
          <v-alert v-if="saveError" type="error" variant="tonal" class="mt-4">{{ saveError }}<v-btn v-if="conflict" variant="text" :disabled="saving" @click="reloadOptions">{{ $t('admin:usersCreate.reloadCreationOptions') }}</v-btn></v-alert>
        </template>
      </v-card-text>
      <v-card-actions><v-btn variant="text" :disabled="saving" @click="reviewing ? reviewing = false : close()">{{ reviewing ? $t('admin:usersCreate.keepEditing') : $t('common:actions.cancel') }}</v-btn><v-spacer /><v-btn v-if="options && !loading && !loadError" color="primary" variant="flat" :loading="saving" :disabled="reviewing && (reason.trim().length < 3 || conflict)" @click="reviewing ? save() : review()">{{ reviewing ? $t('admin:usersCreate.createAccount') : $t('admin:usersCreate.reviewAccount') }}</v-btn></v-card-actions>
    </v-card>
  </v-dialog>
</template>
<script lang="ts">
import { confirmDiscard } from '../common/confirm-dialog.ts'
import { passwordPolicyMixin } from '../../helpers/password-policy.ts'
import { newPasswordIssue } from '../../../shared/security-policy.ts'
import AsyncState from '@/components/common/async-state.vue'
import PasswordVisibilityToggle from '@/components/common/password-visibility-toggle.vue'
import { accountProfileIssues, type AccountCreationOptions, type AccountProfileDraft } from '../../../shared/account-policy.ts'
import { fetchAccountCreationOptions, createAccount, accountRequestStatus } from '../../helpers/account-api.ts'
import { getErrorMessage } from '../../helpers/root-ui-store.ts'
const emptyProfile = (): AccountProfileDraft => ({ name: '', email: '', location: '', jobTitle: '', timezone: '', groups: [] })
export default {
  mixins: [passwordPolicyMixin],
  components: { AsyncState, PasswordVisibilityToggle }, props: { modelValue: { type: Boolean, default: false } }, emits: ['update:modelValue', 'created'],
  data() { return { options: null as AccountCreationOptions | null, profile: emptyProfile(), providerKey: 'local', password: '', showPassword: false, mustChangePassword: true, isVerified: false, reason: '', reviewing: false, attempted: false, loading: false, loadError: '', saving: false, saveError: '', conflict: false, sequence: 0, disposed: false } },
  computed: {
    providers() { return (this.options?.providers ?? []).filter(provider => provider.enabled && provider.available) },
    provider() { return this.providers.find(provider => provider.key === this.providerKey) },
    local(): boolean { return this.provider?.localPassword === true },
    assignableGroups() { return (this.options?.groups ?? []).filter(group => group.canAssign) },
    selectedGroups() { return (this.options?.groups ?? []).filter(group => this.profile.groups.includes(group.id)) },
    selectedPermissions() { return [...new Set(this.selectedGroups.flatMap(group => group.permissions))].sort() },
    issues(): string[] { const profile = this.profile.timezone ? this.profile : { ...this.profile, timezone: 'UTC' }; return [...accountProfileIssues(profile), ...(!this.provider ? [this.$t('admin:usersCreate.chooseEnabledSignProvider')] : []), ...(this.local && (newPasswordIssue(this.password, this.passwordMinimum)) ? [newPasswordIssue(this.password, this.passwordMinimum)!] : []), ...(this.profile.groups.some(id => !this.assignableGroups.some(group => group.id === id)) ? [this.$t('admin:usersCreate.removeUnavailableGroupsBefore')] : [])] },
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
    async save() { if (!this.options || this.saving || this.issues.length || this.reason.trim().length < 3) return; this.saving = true; this.saveError = ''; try { const result = await createAccount({ fingerprint: this.options.fingerprint, profile: JSON.parse(JSON.stringify(this.profile)) as AccountProfileDraft, providerKey: this.providerKey, ...(this.local ? { password: this.password } : {}), isVerified: this.isVerified, mustChangePassword: this.local && this.mustChangePassword, reason: this.reason.trim() }); this.password = ''; this.profile = emptyProfile(); this.reason = ''; this.$emit('created', result.id); this.$emit('update:modelValue', false) } catch (error) { this.conflict = accountRequestStatus(error) === 409; this.saveError = getErrorMessage(error) + (accountRequestStatus(error) === 0 ? ` ${this.$t('admin:usersCreate.outcomeUnconfirmedCheckDirectory')}` : '') } finally { this.saving = false } },
    async canLeave(): Promise<boolean> { return !this.saving && (!this.modelValue || !this.modified || await confirmDiscard(this.$t('admin:usersCreate.discardUnsavedAccount'))) },
    async close() { if (await this.canLeave()) { this.password = ''; this.$emit('update:modelValue', false) } },
    beforeUnload(event: BeforeUnloadEvent) { if (this.modelValue && (this.modified || this.saving)) { event.preventDefault(); event.returnValue = '' } }
  },
  mounted() { window.addEventListener('beforeunload', this.beforeUnload) },
  beforeUnmount() { this.disposed = true; this.sequence++; this.password = ''; window.removeEventListener('beforeunload', this.beforeUnload) }
}
</script>
<style lang="scss">
.account-create-dialog { --account-line:rgba(var(--v-theme-on-surface),.12); max-height:90dvh; .v-card-title { padding:26px 28px 14px; white-space:normal; h2 { font-size:1.6rem; line-height:1.3; font-weight:500; margin-top:7px; letter-spacing:-.02em; } } .v-card-text { padding:12px 28px 26px; overflow-y:auto; } .v-card-actions { padding:16px 22px; border-top:1px solid var(--account-line); flex-wrap:wrap; } }
.account-create-kicker { font-size:.65rem; letter-spacing:.12em; font-weight:650; text-transform:uppercase; color:var(--wiki-text-muted); }
.account-create-intro { color:rgba(var(--v-theme-on-surface),.72); font-size:.87rem; line-height:1.65; margin-bottom:24px; }
.account-create-fields { display:grid; grid-template-columns:1fr 1fr; gap:4px 18px; }
.account-create-provider { display:flex; gap:14px; align-items:flex-start; background:rgba(var(--v-theme-on-surface),.035); padding:17px; border-radius:8px; margin:12px 0 22px; strong { font-size:.84rem; } p { font-size:.77rem; line-height:1.6; color:var(--wiki-text-muted); margin:5px 0 0; } }
.account-create-section { margin:26px 0; padding-top:24px; border-top:1px solid var(--account-line); h3 { font-size:1rem; font-weight:600; } >p { margin:7px 0 16px; font-size:.8rem; line-height:1.65; color:var(--wiki-text-muted); } }
.account-create-groups { display:grid; grid-template-columns:1fr 1fr; gap:10px; label { display:flex; align-items:flex-start; gap:12px; border:1px solid var(--account-line); padding:14px; border-radius:8px; cursor:pointer; &.selected { border-color:rgba(var(--v-theme-primary),.65); background:rgba(var(--v-theme-primary),.045); } input { margin-top:3px; width:16px; height:16px; accent-color:rgb(var(--v-theme-primary)); } strong,small { display:block; } strong { font-size:.82rem; } small { margin-top:4px; color:var(--wiki-text-muted); font-size:.7rem; } } }
.account-create-hint { font-size:.77rem; color:var(--wiki-text-muted); line-height:1.65; margin:12px 0 20px; }
.account-create-permissions { margin-top:16px; summary { cursor:pointer; font-size:.78rem; } ul { display:flex; flex-wrap:wrap; gap:7px 16px; padding:15px 0; list-style:none; font-size:.72rem; } }
.account-create-identity { display:flex; gap:16px; align-items:center; margin:8px 0 24px; >span { width:52px; height:52px; border-radius:50%; background:rgba(var(--v-theme-primary),.1); display:grid; place-items:center; font-size:1.2rem; } h3 { font-size:1.2rem; font-weight:550; overflow-wrap:anywhere; } p { margin-top:3px; font-size:.85rem; color:var(--wiki-text-muted); overflow-wrap:anywhere; } }
.account-create-summary { display:grid; grid-template-columns:1fr 1fr; gap:20px; padding:22px 0; border-block:1px solid var(--account-line); dt { font-size:.7rem; color:var(--wiki-text-muted); margin-bottom:7px; } dd { font-size:.87rem; overflow-wrap:anywhere; } }
@media(max-width:600px) { .account-create-fields,.account-create-groups,.account-create-summary { grid-template-columns:1fr; } .account-create-dialog .v-card-title { padding:22px 20px 12px; h2 { font-size:1.35rem; } } .account-create-dialog .v-card-text { padding:10px 20px 20px; } }
</style>
