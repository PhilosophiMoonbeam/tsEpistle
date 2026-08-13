<template lang="pug">
  v-dialog(
    v-model='dialogOpen'
    max-width='650'
    )
    v-card
      .dialog-header
        span {{$t('common:user.search')}}
        v-spacer
        v-progress-circular(
          indeterminate
          color='white'
          :size='20'
          :width='2'
          v-show='searchLoading'
          )
      v-card-text.pt-5
        v-text-field(
          outlined
          :label='$t(`common:user.searchPlaceholder`)'
          v-model='search'
          prepend-inner-icon='mdi-account-search-outline'
          color='primary'
          ref='searchIpt'
          hide-details
          )
        v-list.grey.mt-3.py-0.radius-7(
          :class='$vuetify.theme.current.dark ? `darken-3-d5` : `lighten-3`'
          two-line
          dense
          )
          template(v-for='(usr, idx) in items', :key='usr.id')
            v-list-item(@click='setUser(usr)')
              v-avatar(size='40', color='primary')
                span.body-1.white--text {{ initials(usr.name) }}
              div.v-list-item-content
                v-list-item-title.body-2 {{usr.name}}
                v-list-item-subtitle {{usr.email}}
              div.v-list-item-action
                v-icon(color='primary') mdi-arrow-right
            v-divider.my-0(v-if='idx < items.length - 1')
      div.v-card-chin
        v-spacer
        v-btn(
          text
          @click='close'
          :disabled='loading'
          ) {{$t('common:actions.cancel')}}
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import _ from 'lodash'

import { searchUsers, type UserSearchRow } from '../../helpers/users-api'
import { wikiStore } from '@/store/index.ts'

export default defineComponent({
  emits: ['select', 'update:modelValue'],
  props: {
    multiple: {
      type: Boolean,
      default: false
    },
    modelValue: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      loading: false,
      searchLoading: false,
      search: '',
      items: [] as UserSearchRow[],
      searchRequestId: 0
    }
  },
  computed: {
    dialogOpen: {
      get(): boolean { return this.modelValue },
      set(value: boolean) { this.$emit('update:modelValue', value) }
    }
  },
  watch: {
    modelValue(newValue: boolean, oldValue: boolean) {
      if (newValue && !oldValue) {
        this.search = ''
        this.items = []
        _.delay(() => { (this.$refs.searchIpt as { focus: () => void }).focus() }, 100)
      }
    },
    search () {
      this.loadUsers()
    }
  },
  methods: {
    initials(val: string): string {
      return val.split(' ').map((value: string) => value.substring(0, 1)).join('')
    },
    async loadUsers (): Promise<UserSearchRow[]> {
      const requestId = ++this.searchRequestId
      const query = this.search

      if (!query || query.trim().length < 2) {
        this.items = []
        this.searchLoading = false
        return []
      }

      this.searchLoading = true
      try {
        const items = await searchUsers(window.fetch.bind(window), query, this.$t('common:error.generic'))
        if (requestId !== this.searchRequestId || query !== this.search) {
          return []
        }
        this.items = items
        return items
      } catch (err) {
        if (requestId !== this.searchRequestId || query !== this.search) {
          return []
        }
        this.items = []
        wikiStore.showError(err)
        return []
      } finally {
        if (requestId === this.searchRequestId) {
          this.searchLoading = false
        }
      }
    },
    close(): void {
      this.$emit('update:modelValue', false)
    },
    setUser(usr: UserSearchRow): void {
      this.$emit('select', usr)
      this.close()
    },
    searchFilter(item: UserSearchRow, queryText: string, itemText: string): boolean {
      return _.includes(_.toLower(item.email), _.toLower(queryText)) || _.includes(_.toLower(item.name), _.toLower(queryText))
    }
  }
})
</script>
