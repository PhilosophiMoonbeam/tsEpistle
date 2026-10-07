<template>
  <section aria-labelledby="group-permissions-heading"><div class="group-heading"><div><span class="group-kicker">{{ $t('admin:groupsEditPermissions.whatGroupCanDo') }}</span><h2 id="group-permissions-heading">{{ $t('admin:groupsEditPermissions.permissions') }}</h2><p>{{ $t('admin:groupsEditPermissions.globalPermissionsGrantCapabilities') }}</p></div><span class="group-pill">{{ $t('admin:groupsEditPermissions.selected', { permissionsCount: modelValue.permissions.length, interpolation: { escapeValue: false } }) }}</span></div>
    <div class="group-permission-toolbar"><v-text-field v-model="search" :label="$t('admin:groupsEditPermissions.findPermission')" variant="outlined" density="comfortable" hide-details clearable prepend-inner-icon="mdi-magnify" /><v-select v-model="category" :items="categories" :label="$t('admin:groupsEditPermissions.permissionCategory')" variant="outlined" density="comfortable" hide-details /></div>
    <v-alert v-if="modelValue.permissions.includes('manage:system')" type="warning" variant="tonal" class="mb-5">{{ $t('admin:groupsEditPermissions.fullSystemAdministrationGrants') }}</v-alert>
    <div v-if="visible.length" class="group-permission-grid"><label v-for="permission in visible" :key="permission.key" class="group-permission" :class="{ 'is-selected': modelValue.permissions.includes(permission.key), 'is-unavailable': disabled || !allowed.includes(permission.key) }"><input type="checkbox" :checked="modelValue.permissions.includes(permission.key)" :disabled="disabled || !allowed.includes(permission.key)" :aria-describedby="'permission-help-' + permission.key.replace(':','-')" @change="toggle(permission.key, ($event.target as HTMLInputElement).checked)" /><span><strong>{{ permission.title }}</strong><code>{{ permission.key }}</code><span :id="'permission-help-' + permission.key.replace(':','-')" class="group-permission-description">{{ permission.description }}</span><small v-if="permission.tier === 'system'">{{ $t('admin:groupsEditPermissions.fullSystemAuthorityRequired') }}</small><small v-else-if="permission.tier === 'administrative'">{{ $t('admin:groupsEditPermissions.administrativeCapability') }}</small><small v-else-if="!permission.pageScoped">{{ $t('admin:groupsEditPermissions.workspaceCapability') }}</small></span></label></div>
    <async-state v-else state="empty" :title="$t('admin:groupsEditPermissions.noMatchingPermissions')" :message="$t('admin:groupsEditPermissions.tryAnotherCategoryDifferent')" />
    <section v-if="unknown.length" class="group-surface mt-5"><h3 class="text-title-small">{{ $t('admin:groupsEditPermissions.otherSavedPermissions') }}</h3><p class="group-note mt-2">{{ $t('admin:groupsEditPermissions.theseValuesOutsideCurrent') }}</p><div v-for="permission in unknown" :key="permission" class="group-actions mt-3"><code>{{ permission }}</code><v-btn variant="text" size="small" :disabled="disabled" @click="toggle(permission, false)">{{ $t('admin:groupsEditPermissions.remove') }}</v-btn></div></section>
  </section>
</template>
<script lang="ts">
import { type PropType } from 'vue'
import AsyncState from '@/components/common/async-state.vue'
import { groupPermissions, type GroupPolicyDraft } from '../../../shared/group-policy.ts'
export default {
  components: { AsyncState }, props: { modelValue: { type: Object as PropType<GroupPolicyDraft>, required: true }, allowed: { type: Array as PropType<string[]>, required: true }, disabled: Boolean }, emits: ['update:modelValue'],
  data() { return { search: '', category: '', categories: [{ title: this.$t('admin:groupsEditPermissions.allCategories'), value: '' }, ...[...new Set(groupPermissions.map(p => p.category))].map(category => ({ title: category, value: category }))] } },
  computed: { visible() { const query = (this.search || '').toLowerCase(); return groupPermissions.filter(p => (!this.category || p.category === this.category) && `${p.title} ${p.key} ${p.description}`.toLowerCase().includes(query)) }, unknown() { return this.modelValue.permissions.filter(key => !groupPermissions.some(p => p.key === key)) } },
  methods: { toggle(key: string, enabled: boolean) { if (this.disabled || (enabled && !this.allowed.includes(key))) return; const permissions = new Set(this.modelValue.permissions); if (enabled) { permissions.add(key); if (key === 'use:agent-browser') permissions.add('use:agents') } else { permissions.delete(key); if (key === 'use:agents') permissions.delete('use:agent-browser') } this.$emit('update:modelValue', { ...this.modelValue, permissions: [...permissions].sort() }) } }
}
</script>
<style lang="scss" scoped>
.group-permission.is-selected {
  border-color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), .07);
}
</style>
