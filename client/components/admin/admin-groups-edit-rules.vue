<template lang="pug">
  v-card(flat)
    v-card-text(v-if='group.id === 1')
      v-alert.radius-7.mb-0(
        type="warning"
        variant="tonal"
        icon='mdi-lock-outline'
        ) This group has access to everything.
    template(v-else)
      .rules-toolbar
        v-alert.radius-7.text-body-small(
          type="info"
          variant="tonal"
          icon='mdi-information'
          ) Enable the relevant global content permissions (under Permissions) before saving page rules.
        v-btn.mx-2(ref='addRuleButton', variant="flat", color='primary', @click='addRule', :disabled='group.id <= 0')
          v-icon(start) mdi-plus
          | Add Rule
      v-card-text
        .rules
          .text-body-small(v-if='group.pageRules.length === 0')
            em.text-medium-emphasis This group has no page rules yet.
          .rule(v-for='(rule, ruleIndex) of group.pageRules', :key='rule.id')
            v-btn.ma-0.radius-4.rule-deny-btn(
              :color='rule.deny ? "red" : "green"'
              @click='updateRule(rule.id, { deny: !rule.deny })'
              :disabled='group.id <= 0'
              height='48'
              :aria-label='`Deny matching pages for page rule ${ruleIndex + 1}`'
              :aria-pressed='rule.deny'
              )
              v-icon(v-if='rule.deny') mdi-cancel
              v-icon(v-else) mdi-check-circle
              span.ml-1 {{rule.deny ? 'DENY' : 'ALLOW'}}
            v-select.rule-roles(
              :ref='input => setRuleInputRef(rule.id, input)'
              variant="solo"
              :items='roles'
              :model-value='rule.roles'
              @update:model-value='updateRule(rule.id, { roles: $event })'
              label='Roles'
              hide-details
              multiple
              chips
              closable-chips
              :menu-props='{ "maxHeight": 500 }'
              clearable
              density="compact"
              :disabled='group.id <= 0'
              )
              template(v-slot:chip='{ item, index, props }')
                v-chip.text-white.ml-0(v-if='index <= 1', v-bind='props', size="small", label, :color='rule.deny ? `red` : `green`').text-body-small {{ item.title }}
                v-chip.text-white.ml-0(v-if='index === 2', :closable='false', size="small", label, :color='rule.deny ? `red-lighten-2` : `green-lighten-2`').text-body-small + {{ rule.roles.length - 2 }} more

            //- Match
            v-select.rule-match(
              variant="solo"
              :items='matches'
              :model-value='rule.match'
              @update:model-value='updateRule(rule.id, { match: $event })'
              label='Match'
              :disabled='group.id <= 0'
              hide-details
              density="compact"
              )
              template(v-slot:selection='{ item }')
                .text-body-medium {{ item.title }}
            //- Locales
            v-select.rule-locales(
              bg-color="surface-variant"
              variant="solo"
              :items='locales'
              :model-value='rule.locales'
              @update:model-value='updateRule(rule.id, { locales: $event })'
              label='Locale'
              item-value='code'
              item-title='name'
              multiple
              hide-details
              density="compact"
              :menu-props='{ "minWidth": 250 }'
              :disabled='group.id <= 0'
              )
              template(v-slot:selection='{ item, index }')
                v-chip.text-white.ml-0(v-if='rule.locales.length === 1', size="small", label, :color='rule.deny ? `red` : `green`').text-body-small {{ item.code?.toUpperCase() }}
                v-chip.text-white.ml-0(v-else-if='index === 0', size="small", label, :color='rule.deny ? `red` : `green`').text-body-small {{ rule.locales.length }} locales
              template(v-slot:prepend-item)
                v-list-item(@click='updateRule(rule.id, { locales: [] })')
                  template(v-slot:append)
                    v-checkbox(
                      :model-value='rule.locales.length === 0'
                      hide-details
                      color='primary'
                      readonly
                      tabindex='-1'
                    )
                  template(v-slot:prepend)
                    v-icon.mr-2(:color='rule.deny ? `red` : `green`') mdi-earth
                  v-list-item-title.text-body-medium Any Locale
                v-divider

            //- Path
            v-text-field.rule-path(
              variant="solo"
              :model-value='rule.path'
              @update:model-value='updateRule(rule.id, { path: $event })'
              :disabled='group.id <= 0'
              label='Path'
              :prefix='(rule.match !== `END` && rule.match !== `TAG`) ? `/` : null'
              :placeholder='rule.match === `REGEX` ? `Regular Expression` : rule.match === `TAG` ? `Tag` : `Path`'
              :suffix='rule.match === `REGEX` ? `/` : null'
              hide-details
              )
            v-btn.rule-remove(icon, @click='removeRule(rule.id)', size="small", :aria-label='`Remove page rule ${ruleIndex + 1}`', :disabled='group.id <= 0')
              v-icon mdi-close

        v-divider.mt-3
        .text-label-small.py-3 Rule precedence
        .text-body-medium.pl-3 Rules are applied in order of path specificity. A more precise path will always override a less defined path.
        .text-body-medium.pl-3.pt-2 When 2 rules have the same specificity, the priority is given from lowest to highest as follows:
        .text-body-medium.pl-3.pt-1
          ul
            li
              strong Path Starts With...
              em.text-body-small.pl-1 (lowest)
            li
              strong Path Ends With...
            li
              strong Path Matches Regex...
            li
              strong Tag Matches...
            li
              strong Path Is Exactly...
              em.text-body-small.pl-1 (highest)
        .text-body-medium.pl-3.pt-2 When 2 rules have the same path specificity AND the same match type, #[strong.text-red DENY] will always override an #[strong.text-green ALLOW] rule.
        v-divider.mt-3
        .text-label-small.py-3 Regular Expressions
        span Expressions that are deemed unsafe or could result in exponential time processing will be rejected upon saving.

</template>

<script lang='ts'>
import { markRaw, type PropType } from 'vue'

import { customAlphabet } from 'nanoid/non-secure'

import { createEmptyGroupEditorState, type GroupEditorState, type GroupPageRule } from '../../helpers/groups-api'

/* global siteLangs */

const nanoid = customAlphabet('1234567890abcdef', 10)

type FocusableInput = {
  focus?: () => void
}

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
      roles: markRaw([
        { title: 'Read Pages', value: 'read:pages' },
        { title: 'Create + Edit Pages', value: 'write:pages' },
        { title: 'Rename / Move Pages', value: 'manage:pages' },
        { title: 'Delete Pages', value: 'delete:pages' },
        { title: 'View Pages Source', value: 'read:source' },
        { title: 'View Pages History', value: 'read:history' },
        { title: 'Read / Use Assets', value: 'read:assets' },
        { title: 'Upload Assets', value: 'write:assets' },
        { title: 'Edit + Delete Assets', value: 'manage:assets' },
        { title: 'Edit Scripts', value: 'write:scripts' },
        { title: 'Edit Styles', value: 'write:styles' },
        { title: 'Read Comments', value: 'read:comments' },
        { title: 'Create Comments', value: 'write:comments' },
        { title: 'Edit + Delete Comments', value: 'manage:comments' }
      ]),
      matches: markRaw([
        { title: 'Path Starts With...', value: 'START' },
        { title: 'Path is Exactly...', value: 'EXACT' },
        { title: 'Path Ends With...', value: 'END' },
        { title: 'Path Matches Regex...', value: 'REGEX' },
        { title: 'Tag Matches...', value: 'TAG' }
      ]),
      ruleInputRefs: markRaw(new Map<string, FocusableInput>())
    }
  },
  computed: {
    group: {
      get(): GroupEditorState { return this.modelValue },
      set(val: GroupEditorState) { this.$emit('update:modelValue', val) }
    },
    locales(): typeof siteLangs { return siteLangs }
  },
  methods: {
    addRule() {
      if (this.group.id <= 0) return
      const ruleId = nanoid()
      this.group = {
        ...this.group,
        pageRules: [
          ...this.group.pageRules,
          {
            id: ruleId,
            path: '',
            roles: [],
            match: 'START',
            deny: false,
            locales: []
          }
        ]
      }
      this.focusRuleInput(ruleId)
    },
    setRuleInputRef(ruleId: string, input: FocusableInput | null) {
      if (input) {
        this.ruleInputRefs.set(ruleId, input)
      } else {
        this.ruleInputRefs.delete(ruleId)
      }
    },
    focusRuleInput(ruleId?: string) {
      this.$nextTick(() => {
        if (ruleId) {
          this.ruleInputRefs.get(ruleId)?.focus?.()
        } else {
          ;(this.$refs.addRuleButton as FocusableInput | undefined)?.focus?.()
        }
      })
    },
    updateRule(ruleId: string, patch: Partial<Omit<GroupPageRule, 'id'>>) {
      this.group = {
        ...this.group,
        pageRules: this.group.pageRules.map(rule => rule.id === ruleId ? { ...rule, ...patch } : rule)
      }
    },
    removeRule(ruleId: string) {
      if (this.group.id <= 0) return
      const removedIndex = this.group.pageRules.findIndex(rule => rule.id === ruleId)
      if (removedIndex < 0) return
      const pageRules = this.group.pageRules.filter(rule => rule.id !== ruleId)
      const nextRuleId = pageRules[Math.min(removedIndex, pageRules.length - 1)]?.id
      this.group = {
        ...this.group,
        pageRules
      }
      this.focusRuleInput(nextRuleId)
    }
  }
}
</script>
<style lang="scss" scoped>
.rules-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: .75rem;
  padding: 1rem;

  .v-alert {
    flex: 1 1 320px;
    min-width: 0;
  }
}

.rules {
  background-color: rgb(var(--v-theme-surface));
  border-radius: var(--wiki-panel-radius);
  padding: 1rem;
  position: relative;
}

.rule {
  display: grid;
  grid-template-columns: auto minmax(180px, 2fr) minmax(150px, 1.25fr) minmax(120px, .75fr) minmax(150px, 1fr) auto;
  gap: .5rem;
  background-color: color-mix(in srgb, rgb(var(--v-theme-surface)) 92%, rgb(var(--v-theme-primary)));
  border-radius: var(--wiki-panel-radius);
  padding: .5rem;
  align-items: center;

  &-enter-active, &-leave-active {
    transition: opacity .5s ease;
  }
  &-enter-from, &-leave-to {
    opacity: 0;
  }

  & + .rule {
    margin-top: .5rem;
    position: relative;
  }
}

@media (max-width: 900px) {
  .rule {
    grid-template-columns: auto 1fr auto;

    .rule-roles,
    .rule-match,
    .rule-locales,
    .rule-path {
      grid-column: 1 / -1;
      width: 100%;
      min-width: 0;
    }
  }
}

@media (max-width: 600px) {
  .rules-toolbar {
    align-items: stretch;
    flex-direction: column;

    .v-btn {
      width: 100%;
      margin: 0 !important;
    }
  }

  .rules {
    padding: .5rem;
  }
}
</style>
