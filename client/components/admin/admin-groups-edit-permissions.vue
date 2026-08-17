<template lang="pug">
  v-card(flat)
    v-container.px-3.pb-3.pt-3(fluid)
      v-row
        v-col(cols='12', v-if='group.isSystem')
          v-alert.radius-7.mb-0(
            color="orange-darken-2"
            :class='$vuetify.theme.current.dark ? "bg-grey-darken-4" : "bg-orange-lighten-5"'
            variant="outlined"
            :value='true'
            icon='mdi-lock-outline'
            ) This is a system group. Some permissions cannot be modified.
        v-col(cols='12', md='6', lg='4', v-for='pmGroup in permissions', :key='pmGroup.category')
          v-card.md2(flat, :class='$vuetify.theme.current.dark ? "bg-grey-darken-3-d5" : "bg-grey-lighten-5"')
            .text-label-small.px-5.pt-5.pb-3.text-grey-darken-2 {{pmGroup.category}}
            v-card-text.pt-0
              template(v-for='(pm, idx) in pmGroup.items', :key='pm.permission')
                v-checkbox.pt-0(
                  style='justify-content: space-between;'
                  :label='pm.permission'
                  :hint='pm.hint'
                  persistent-hint
                  color='primary'
                  v-model='group.permissions'
                  :value='pm.permission'
                  :append-icon='pm.warning ? "mdi-alert" : null',
                  :disabled='(group.isSystem && pm.restrictedForSystem) || group.id === 1 || pm.disabled'
                )
                v-divider.mt-3(v-if='idx < pmGroup.items.length - 1')</template>

<script lang='ts'>
import type { PropType } from 'vue'

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
      permissions: [
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
              warning: false,
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
              hint: 'Can use the isolated Wiki agent application and own private agent sessions',
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
              hint: 'Can use the dedicated MCP endpoint through API keys issued for this group',
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
      ]
    }
  },
  computed: {
    group: {
      get(): GroupEditorState { return this.modelValue },
      set(val: GroupEditorState) { this.$emit('update:modelValue', val) }
    }
  }
}
</script>
