<template>
  <v-dialog :model-value="modelValue" max-width="720" persistent aria-labelledby="page-access-title">
    <v-card class="page-access-dialog"><header><span class="access-kicker">{{ mode === 'owner' ? $t('admin:pageAccess.privateOwnership') : $t('admin:pageAccess.pageVisibility') }}</span><h2 id="page-access-title">{{ mode === 'owner' ? $t('admin:pageAccess.transferPrivateNamespace') : $t('admin:pageAccess.reviewWhoCanReach') }}</h2><p>{{ page.title || page.path }}<br />{{ page.locale }} / {{ page.path }}</p></header>
      <v-card-text><v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
        <template v-if="mode === 'visibility'"><v-radio-group v-model="visibility" :label="$t('admin:pageAccess.pageNamespace')" :disabled="busy"><v-radio :label="$t('admin:pageAccess.workspaceGroupPermissionsPage')" value="public" /><v-radio :label="page.visibility === 'private' ? $t('admin:pageAccess.privateCurrentOwner', { ownerId: page.ownerId, interpolation: { escapeValue: false } }) : $t('admin:pageAccess.privateOwnedYou', { userId, interpolation: { escapeValue: false } })" value="private" /></v-radio-group><p>{{ visibility === 'public' ? $t('admin:pageAccess.movingWorkspaceNamespaceRemoves') : $t('admin:pageAccess.movingPrivateNamespaceChanges') }}</p><p>{{ $t('admin:pageAccess.publicationStateScheduleRemain') }}</p></template>
        <template v-else><p>{{ $t('admin:pageAccess.currentOwnerPagePrivate', { ownerId: page.ownerId, interpolation: { escapeValue: false } }) }}</p><form class="access-search" @submit.prevent="search"><v-text-field v-model="query" :label="$t('admin:pageAccess.findOwnerNameEmail')" variant="outlined" hide-details :disabled="busy" /><v-btn type="submit" variant="outlined" :loading="searching" :disabled="busy || query.trim().length < 2">{{ $t('admin:pageAccess.search') }}</v-btn></form><v-radio-group v-if="users.length" v-model="ownerId" :label="$t('admin:pageAccess.newOwner')" :disabled="busy"><v-radio v-for="user in users" :key="user.id" :value="user.id" :label="`${user.name} · ${user.email} · #${user.id}`" /></v-radio-group><p v-else-if="searched && !searching">{{ $t('admin:pageAccess.noEligibleAccountsMatched') }}</p><small>{{ $t('admin:pageAccess.searchReturnsUpTen') }}</small></template>
        <v-checkbox v-model="confirmed" :disabled="busy || !changed" :label="$t('admin:pageAccess.iHaveReviewedAccess')" hide-details class="mt-4" />
      </v-card-text><v-card-actions><v-spacer /><v-btn :disabled="busy" @click="$emit('update:modelValue', false)">{{ $t('common:actions.cancel') }}</v-btn><v-btn color="primary" variant="flat" :loading="busy" :disabled="busy || !changed || !confirmed" @click="save">{{ mode === 'owner' ? $t('admin:pageAccess.transferOwnership') : $t('admin:pageAccess.changeVisibility') }}</v-btn></v-card-actions>
    </v-card>
  </v-dialog>
</template>
<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import { changePageVisibility, type PageDetails } from '../../helpers/pages-api'
import { searchUsers, type UserSearchRow } from '../../helpers/users-api'
import { transferPageOwner } from '../../helpers/admin-pages'
import { wikiStore } from '@/store/index.ts'
export default defineComponent({
  props: { modelValue: Boolean, page: { type: Object as PropType<PageDetails>, required: true }, mode: { type: String, default: 'visibility' } }, emits: ['update:modelValue', 'busy', 'changed'],
  data: () => ({ visibility: 'public' as 'public' | 'private', confirmed: false, ownerId: null as number | null, query: '', users: [] as UserSearchRow[], searched: false, searching: false, searchGeneration: 0, error: '', busy: false }),
  computed: { userId(): number { return wikiStore.user.id }, changed(): boolean { return this.mode === 'owner' ? Boolean(this.ownerId && this.ownerId !== this.page.ownerId) : this.visibility !== this.page.visibility } },
  methods: {
    async search() { if (this.busy || this.query.trim().length < 2) return; const generation = ++this.searchGeneration; this.searching = true; this.error = ''; this.ownerId = null; try { const users = await searchUsers(window.fetch.bind(window), this.query); if (generation === this.searchGeneration) { this.users = users.filter(user => user.id !== 2 && user.id !== this.page.ownerId); this.searched = true } } catch (error) { if (generation === this.searchGeneration) { this.users = []; this.error = error instanceof Error ? error.message : this.$t('admin:pageAccess.accountSearchFailed') } } finally { if (generation === this.searchGeneration) this.searching = false } },
    async save() { if (this.busy || !this.changed || !this.confirmed) return; this.busy = true; this.error = ''; try { if (this.mode === 'owner') await transferPageOwner(this.page.id, this.page.sourceRevision, this.ownerId!); else await changePageVisibility(window.fetch.bind(window), this.page.id, this.visibility, this.page.sourceRevision, this.visibility === 'public'); this.$emit('update:modelValue', false); this.$emit('changed') } catch (error) { this.error = error instanceof Error ? error.message : this.$t('admin:pageAccess.accessCouldNotChanged') } finally { this.busy = false } }
  },
  watch: { modelValue(open: boolean) { if (open) { this.searchGeneration++; this.searching = false; this.visibility = this.page.visibility; this.ownerId = null; this.query = ''; this.users = []; this.searched = false; this.confirmed = false; this.error = '' } }, busy(value: boolean) { this.$emit('busy', value) }, visibility() { this.confirmed = false }, ownerId() { this.confirmed = false } },
  beforeUnmount() { this.searchGeneration++; this.$emit('busy', false) }
})
</script>
<style scoped lang="scss">
.page-access-dialog header { padding:1.25rem 1.25rem 0; }.access-kicker { font-size:.75rem; font-weight:600; color:var(--wiki-text-muted); }h2 { font:650 1.35rem/1.3 var(--wiki-font-heading); margin:.5rem 0; overflow-wrap:anywhere; }p { line-height:1.6; margin-bottom:1rem; overflow-wrap:anywhere; }.access-search { display:flex; align-items:center; gap:1rem; margin:1rem 0; }small { color:var(--wiki-text-muted); }.v-card-actions { padding:1rem; flex-wrap:wrap; }@media(max-width:600px) { .access-search { flex-direction:column; align-items:stretch; }.v-card-actions :deep(.v-btn) { min-height:44px; } }
</style>
