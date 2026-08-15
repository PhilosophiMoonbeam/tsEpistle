<template lang="pug">
  v-card(flat)
    v-card-text(v-if='group.id === 1')
      v-alert.radius-7.mb-0(
        :class='$vuetify.theme.current.dark ? "grey darken-4" : "orange lighten-5"'
        color='orange darken-2'
        outlined
        icon='mdi-lock-outline'
        ) This group has access to everything.
    template(v-else)
      v-card-title(:class='$vuetify.theme.current.dark ? `grey darken-3-d5` : ``')
        v-alert.radius-7.caption(
          :class='$vuetify.theme.current.dark ? `grey darken-3-d3` : `grey lighten-4`'
          color='grey'
          outlined
          icon='mdi-information'
          ) You must enable global content permissions (under Permissions tab) for page rules to have any effect.
        v-spacer
        v-btn.mx-2(depressed, color='primary', @click='addRule')
          v-icon(left) mdi-plus
          | Add Rule
      v-card-text(:class='$vuetify.theme.current.dark ? `grey darken-4-l5` : `white`')
        .rules
          .caption(v-if='group.pageRules.length === 0')
            em(:class='$vuetify.theme.current.dark ? `grey--text` : `blue-grey--text`') This group has no page rules yet.
          .rule(v-for='rule of group.pageRules', :key='rule.id')
            v-btn.ma-0.radius-4.rule-deny-btn(
              solo
              :color='rule.deny ? "red" : "green"'
              dark
              @click='rule.deny = !rule.deny'
              height='48'
              )
              v-icon(v-if='rule.deny') mdi-cancel
              v-icon(v-else) mdi-check-circle
            //- Roles
            v-select.ml-1(
              solo
              :items='roles'
              item-title='text'
              item-value='value'
              v-model='rule.roles'
              placeholder='Select Role(s)...'
              hide-details
              multiple
              chips
              closable-chips
              height='48px'
              style='flex: 0 1 440px;'
              :menu-props='{ "maxHeight": 500 }'
              clearable
              dense
              )
              template(v-slot:selection='{ item, index }')
                v-chip.white--text.ml-0(v-if='index <= 1', small, label, :color='rule.deny ? `red` : `green`').caption {{ item.raw.value }}
                v-chip.white--text.ml-0(v-if='index === 2', small, label, :color='rule.deny ? `red lighten-2` : `green lighten-2`').caption + {{ rule.roles.length - 2 }} more

            //- Match
            v-select.ml-1.mr-1(
              solo
              :items='matches'
              v-model='rule.match'
              item-title='text'
              item-value='value'
              placeholder='Match...'
              hide-details
              height='48px'
              style='flex: 0 1 250px;'
              dense
              )
              template(v-slot:selection='{ item }')
                .body-2 {{item.raw.text}}
            //- Locales
            v-select.mr-1(
              :background-color='$vuetify.theme.current.dark ? `grey darken-3-d5` : `blue-grey lighten-5`'
              solo
              :items='locales'
              v-model='rule.locales'
              placeholder='Any Locale'
              item-value='code'
              item-title='name'
              multiple
              hide-details
              height='48px'
              dense
              :menu-props='{ "minWidth": 250 }'
              style='flex: 0 1 150px;'
              )
              template(v-slot:selection='{ item, index }')
                v-chip.white--text.ml-0(v-if='rule.locales.length === 1', small, label, :color='rule.deny ? `red` : `green`').caption {{ item.raw.code.toUpperCase() }}
                v-chip.white--text.ml-0(v-else-if='index === 0', small, label, :color='rule.deny ? `red` : `green`').caption {{ rule.locales.length }} locales
              template(v-slot:prepend-item)
                v-list-item(@click='rule.locales = []')
                  div.v-list-item-action(style='min-width: 30px;')
                    v-checkbox(
                      :model-value='rule.locales.length === 0'
                      hide-details
                      color='primary'
                      readonly
                    )
                  v-icon.mr-2(:color='rule.deny ? `red` : `green`') mdi-earth
                  div.v-list-item-content
                    v-list-item-title.body-2 Any Locale
                v-divider

            //- Path
            v-text-field(
              solo
              v-model='rule.path'
              label='Path'
              :prefix='(rule.match !== `END` && rule.match !== `TAG`) ? `/` : null'
              :placeholder='rule.match === `REGEX` ? `Regular Expression` : rule.match === `TAG` ? `Tag` : `Path`'
              :suffix='rule.match === `REGEX` ? `/` : null'
              hide-details
              :color='$vuetify.theme.current.dark ? `grey` : `blue-grey`'
              )

            v-btn.ml-2(icon, @click='removeRule(rule.id)', small)
              v-icon(:color='$vuetify.theme.current.dark ? `grey` : `blue-grey`') mdi-close

        v-divider.mt-3
        .overline.py-3 Rules Order
        .body-2.pl-3 Rules are applied in order of path specificity. A more precise path will always override a less defined path.
        .body-2.pl-5 For example, #[span.teal--text /geography/countries] will override #[span.teal--text /geography].
        .body-2.pl-3.pt-2 When 2 rules have the same specificity, the priority is given from lowest to highest as follows:
        .body-2.pl-3.pt-1
          ul
            li
              strong Path Starts With...
              em.caption.pl-1 (lowest)
            li
              strong Path Ends With...
            li
              strong Path Matches Regex...
            li
              strong Tag Matches...
            li
              strong Path Is Exactly...
              em.caption.pl-1 (highest)
        .body-2.pl-3.pt-2 When 2 rules have the same path specificity AND the same match type, #[strong.red--text DENY] will always override an #[strong.green--text ALLOW] rule.
        v-divider.mt-3
        .overline.py-3 Regular Expressions
        span Expressions that are deemed unsafe or could result in exponential time processing will be rejected upon saving.

</template>

<script lang='ts'>
import type { PropType } from 'vue'

import _ from 'lodash'
import { customAlphabet } from 'nanoid/non-secure'

import { createEmptyGroupEditorState, type GroupEditorState } from '../../helpers/groups-api'

/* global siteLangs */

const nanoid = customAlphabet('1234567890abcdef', 10)

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
      roles: [
        { text: 'Read Pages', value: 'read:pages', icon: 'mdi-file-eye-outline' },
        { text: 'Create + Edit Pages', value: 'write:pages', icon: 'mdi-file-plus-outline' },
        { text: 'Rename / Move Pages', value: 'manage:pages', icon: 'mdi-file-document-edit-outline' },
        { text: 'Delete Pages', value: 'delete:pages', icon: 'mdi-file-remove-outline' },
        { text: 'View Pages Source', value: 'read:source', icon: 'mdi-code-tags' },
        { text: 'View Pages History', value: 'read:history', icon: 'mdi-history' },
        { text: 'Read / Use Assets', value: 'read:assets', icon: 'mdi-image-search-outline' },
        { text: 'Upload Assets', value: 'write:assets', icon: 'mdi-image-plus' },
        { text: 'Edit + Delete Assets', value: 'manage:assets', icon: 'mdi-image-size-select-large' },
        { text: 'Edit Scripts', value: 'write:scripts', icon: 'mdi-language-javascript' },
        { text: 'Edit Styles', value: 'write:styles', icon: 'mdi-language-css3' },
        { text: 'Read Comments', value: 'read:comments', icon: 'mdi-comment-search-outline' },
        { text: 'Create Comments', value: 'write:comments', icon: 'mdi-comment-plus-outline' },
        { text: 'Edit + Delete Comments', value: 'manage:comments', icon: 'mdi-comment-remove-outline' }
      ],
      matches: [
        { text: 'Path Starts With...', value: 'START', icon: '/...' },
        { text: 'Path is Exactly...', value: 'EXACT', icon: '=' },
        { text: 'Path Ends With...', value: 'END', icon: '.../' },
        { text: 'Path Matches Regex...', value: 'REGEX', icon: '$.*' },
        { text: 'Tag Matches...', value: 'TAG', icon: 'T' }
      ]
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
      this.group.pageRules.push({
        id: nanoid(),
        path: '',
        roles: [],
        match: 'START',
        deny: false,
        locales: []
      })
    },
    removeRule(ruleId: string) {
      this.group.pageRules.splice(_.findIndex(this.group.pageRules, ['id', ruleId]), 1)
    }
  }
}
</script>

<style lang="scss">
.rules {
  background-color: mc('blue-grey', '50');
  border-radius: 4px;
  padding: 1rem;
  position: relative;

  @at-root .v-application.theme--dark & {
    background-color: mc('grey', '800');
  }
}

.rule {
  display: flex;
  background-color: mc('blue-grey', '100');
  border-radius: 4px;
  padding: .5rem;
  align-items: center;

  &-enter-active, &-leave-active {
    transition: all .5s ease;
  }
  &-enter, &-leave-to {
    opacity: 0;
  }

  @at-root .v-application.theme--dark & {
    background-color: mc('grey', '700');
  }

  & + .rule {
    margin-top: .5rem;
    position: relative;

    &::before {
      content: '+';
      position: absolute;
      width: 2rem;
      height: 2rem;
      border-radius: 50%;
      display: flex;
      justify-content: center;
      align-items: center;
      font-weight: 600;
      color: mc('blue-grey', '700');
      font-size: 1.25rem;
      background-color: mc('blue-grey', '50');
      left: -2rem;
      top: -1.3rem;

      @at-root .v-application.theme--dark & {
        background-color: mc('grey', '800');
        color: mc('grey', '600');
      }
    }
  }

  .input-group + * {
    margin-left: .5rem;
  }
}
</style>
