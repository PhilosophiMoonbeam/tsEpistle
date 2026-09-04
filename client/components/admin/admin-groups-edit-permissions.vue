<template lang="pug">
  v-card(flat)
    v-container.px-3.pb-3.pt-3(fluid)
      v-row
        v-col(cols='12', v-if='group.isSystem')
          v-alert.radius-7.mb-0(
            type="warning"
            variant="tonal"
            icon='mdi-lock-outline'
            ) This is a system group. Some permissions cannot be modified.
        v-col(cols='12', lg='6', xl='4', v-for='pmGroup in permissions', :key='pmGroup.category')
          v-card.bg-surface-variant(flat, role='group', :aria-labelledby='categoryId(pmGroup.category)')
            .text-label-small.px-5.pt-5.pb-3.text-medium-emphasis(:id='categoryId(pmGroup.category)') {{pmGroup.category}}
            v-card-text.pt-0
              template(v-for='(pm, idx) in pmGroup.items', :key='pm.permission')
                v-checkbox.pt-0(
                  :id='permissionId(pm.permission)'
                  style='justify-content: space-between;'
                  :label='pm.permission'
                  :hint='pm.hint'
                  persistent-hint
                  color='primary'
                  :model-value='isPermissionEnabled(pm.permission)'
                  @update:model-value='togglePermission(pm.permission, $event === true)'
                  :aria-describedby='permissionDescriptionIds(pm.permission, pm.warning || pm.disabled)'
                  :disabled='(group.isSystem && pm.restrictedForSystem) || group.id === 1 || pm.disabled'
                )
                .text-body-small.text-warning(v-if='pm.warning || pm.disabled', :id='riskId(pm.permission)') {{pm.disabled ? 'Reserved for root administrators.' : 'High-impact permission. Review before granting.'}}
                v-divider.mt-3(v-if='idx < pmGroup.items.length - 1')
</template>

<script lang='ts'>
import { markRaw, type PropType } from 'vue'

import { createEmptyGroupEditorState, type GroupEditorState } from '../../helpers/groups-api'

export default {
  emits: ['update:modelValue'],
  props: {
    modelValue: {
      type: Object as PropType<GroupEditorState>,
      default: createEmptyGroupEditorState
    }
  },
  data() {
    return {
      permissions: markRaw([
        {
          category: 'Content',
          items: [
            {
              permission: 'read:pages',
              hint: 'Can view pages, as specified in the Page Rules',
              warning: false,
              restrictedForSystem: false,
              disabled: false
            },
            {
              permission: 'write:pages',
              hint: 'Can create / edit pages, as specified in the Page Rules',
              warning: false,
              restrictedForSystem: true,
              disabled: false
            },
            {
              permission: 'manage:pages',
              hint: 'Can move existing pages as specified in the Page Rules',
              warning: false,
              restrictedForSystem: true,
              disabled: false
            },
            {
              permission: 'delete:pages',
              hint: 'Can delete existing pages, as specified in the Page Rules',
              warning: false,
              restrictedForSystem: true,
              disabled: false
            },
            {
              permission: 'write:styles',
              hint: 'Can insert CSS styles in pages, as specified in the Page Rules',
              warning: false,
              restrictedForSystem: true,
              disabled: false
            },
            {
              permission: 'write:scripts',
              hint: 'Can insert JavaScript in pages, as specified in the Page Rules',
              warning: true,
              restrictedForSystem: true,
              disabled: false
            },
            {
              permission: 'read:source',
              hint: 'Can view pages source, as specified in the Page Rules',
              warning: false,
              restrictedForSystem: false,
              disabled: false
            },
            {
              permission: 'read:history',
              hint: 'Can view pages history, as specified in the Page Rules',
              warning: false,
              restrictedForSystem: false,
              disabled: false
            },
            {
              permission: 'read:assets',
              hint: 'Can view / use assets (such as images and files), as specified in the Page Rules',
              warning: false,
              restrictedForSystem: false,
              disabled: false
            },
            {
              permission: 'write:assets',
              hint: 'Can upload new assets (such as images and files), as specified in the Page Rules',
              warning: false,
              restrictedForSystem: true,
              disabled: false
            },
            {
              permission: 'manage:assets',
              hint: 'Can edit and delete existing assets (such as images and files), as specified in the Page Rules',
              warning: false,
              restrictedForSystem: true,
              disabled: false
            },
            {
              permission: 'read:comments',
              hint: 'Can view comments, as specified in the Page Rules',
              warning: false,
              restrictedForSystem: false,
              disabled: false
            },
            {
              permission: 'write:comments',
              hint: 'Can post new comments, as specified in the Page Rules',
              warning: false,
              restrictedForSystem: false,
              disabled: false
            },
            {
              permission: 'manage:comments',
              hint: 'Can edit and delete existing comments, as specified in the Page Rules',
              warning: false,
              restrictedForSystem: true,
              disabled: false
            }
          ]
        },
        {
          category: 'Agents',
          items: [
            {
              permission: 'use:agents',
              hint: 'Can use the inline Wiki agent and own private agent sessions',
              warning: true,
              restrictedForSystem: true,
              disabled: false
            },
            {
              permission: 'use:agent-browser',
              hint: 'Can use enabled open-world browser actions; also requires use:agents',
              warning: true,
              restrictedForSystem: true,
              disabled: false
            },
            {
              permission: 'use:mcp',
              hint: 'Can use the MCP endpoint at /mcp on this Wiki through API keys issued for this group',
              warning: true,
              restrictedForSystem: true,
              disabled: false
            }
          ]
        },
        {
          category: 'Users',
          items: [
            {
              permission: 'write:users',
              hint: 'Can create or authorize new users, but not modify existing ones. Can only assign to non-administrative groups',
              warning: false,
              restrictedForSystem: true,
              disabled: false
            },
            {
              permission: 'manage:users',
              hint: 'Can create, authorize and modify ANY users. Can only assign to non-administrative groups',
              warning: false,
              restrictedForSystem: true,
              disabled: false
            },
            {
              permission: 'write:groups',
              hint: 'Can manage groups and set CONTENT permissions / page rules. Can only assign users to non-administrative groups',
              warning: false,
              restrictedForSystem: true,
              disabled: false
            },
            {
              permission: 'manage:groups',
              hint: 'Can manage groups and set ANY permissions (but not manage:system) / page rules. Can assign users to ANY groups (except groups with the manage:system permission)',
              warning: true,
              restrictedForSystem: true,
              disabled: false
            }
          ]
        },
        {
          category: 'Administration',
          items: [
            {
              permission: 'manage:navigation',
              hint: 'Can manage the site navigation',
              warning: false,
              restrictedForSystem: true,
              disabled: false
            },
            {
              permission: 'manage:theme',
              hint: 'Can manage and modify themes',
              warning: false,
              restrictedForSystem: true,
              disabled: false
            },
            {
              permission: 'manage:api',
              hint: 'Can generate and revoke API keys',
              warning: true,
              restrictedForSystem: true,
              disabled: false
            },
            {
              permission: 'manage:system',
              hint: 'Can manage and access everything. Root administrator',
              warning: true,
              restrictedForSystem: true,
              disabled: true

            }
          ]
        }
      ])
    }
  },
  computed: {
    group: {
      get(): GroupEditorState { return this.modelValue },
      set(val: GroupEditorState) { this.$emit('update:modelValue', val) }
    }
  },
  methods: {
    permissionId (permission: string): string {
      return `permission-${permission.replace(/[^a-z0-9]+/g, '-')}`
    },
    permissionDescriptionIds (permission: string, hasRisk: boolean): string {
      const messagesId = `${this.permissionId(permission)}-messages`
      return hasRisk ? `${messagesId} ${this.riskId(permission)}` : messagesId
    },
    categoryId (category: string): string {
      return `permission-category-${category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    },
    riskId (permission: string): string {
      return `permission-risk-${permission.replace(/[^a-z0-9]+/g, '-')}`
    },
    isPermissionEnabled (permission: string): boolean {
      return this.group.permissions.includes(permission)
    },
    togglePermission (permission: string, enabled: boolean) {
      const permissions = new Set(this.group.permissions)
      if (enabled) {
        permissions.add(permission)
        if (permission === 'use:agent-browser') permissions.add('use:agents')
      } else {
        permissions.delete(permission)
        if (permission === 'use:agents') permissions.delete('use:agent-browser')
      }
      this.group = { ...this.group, permissions: Array.from(permissions) }
    }
  }
}
</script>
