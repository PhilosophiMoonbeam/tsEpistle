<template lang="pug">
  v-dialog(
    v-model='dialogOpen'
    max-width='650'
    aria-labelledby='user-search-dialog-title'
    )
    v-card
      .dialog-header
        span#user-search-dialog-title {{$t('common:user.search')}}
        v-spacer
        v-progress-circular(
          indeterminate
          color='primary'
          :size='20'
          :width='2'
          v-show='searchLoading'
          :aria-label='$t(`common:header.searchLoading`)'
          )
      v-card-text.pt-5
        v-text-field(
          variant="outlined"
          :label='$t(`common:user.searchPlaceholder`)'
          v-model='search'
          prepend-inner-icon='mdi-account-search-outline'
          color='primary'
          ref='searchIpt'
          hide-details
          )
        div.user-search__status(aria-live='polite', aria-atomic='true') {{searchStatus}}
        .user-search__instruction(v-if='search.trim().length < 2')
          v-icon(color='grey', aria-hidden='true') mdi-account-search-outline
          span {{$t(`common:header.searchHint`)}}
        async-state(
          v-else-if='searchLoading && items.length === 0'
          state='loading'
          :title='$t(`common:header.searchLoading`)'
          message='Searching users you can access.'
        )
        async-state(
          v-else-if='searchError'
          state='error'
          title='Search failed'
          :message='searchError'
          :retry-label='$t(`common:actions.refresh`)'
          @retry='retrySearch'
        )
        async-state(
          v-else-if='searchAttempted && items.length === 0'
          state='empty'
          title='No users found'
          message='Try a different name or email address.'
        )
        v-list.user-search__results.mt-3.py-0.radius-7(
          v-else-if='items.length > 0'
          :class='$vuetify.theme.current.dark ? `bg-grey-darken-3` : `bg-grey-lighten-3`'
          lines="two"
          density="compact"
        )
          template(v-for='(usr, idx) in items', :key='usr.id')
            v-list-item(@click='setUser(usr)')
              template(v-slot:prepend)
                v-avatar(size='40', color='primary', aria-hidden='true')
                  span.text-body-large.text-white(aria-hidden='true') {{ initials(usr.name) }}
              v-list-item-title.text-body-medium {{usr.name}}
              v-list-item-subtitle {{usr.email}}
              template(v-slot:append)
                v-icon(color='primary', aria-hidden='true') mdi-arrow-right
            v-divider.my-0(v-if='idx < items.length - 1')
      v-card-chin
        v-spacer
        v-btn(
          variant="text"
          @click='close'
          :disabled='loading'
        ) {{$t('common:actions.cancel')}}
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import _ from 'lodash'

import AsyncState from './async-state.vue'
import { searchUsers, type UserSearchRow } from '../../helpers/users-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
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
  components: {
    AsyncState
  },
  data() {
    return {
      loading: false,
      searchLoading: false,
      search: '',
      items: [] as UserSearchRow[],
      searchRequestId: 0,
      searchAttempted: false,
      searchError: '',
      searchTimer: null as number | null
    }
  },
  computed: {
    dialogOpen: {
      get(): boolean { return this.modelValue },
      set(value: boolean) { this.$emit('update:modelValue', value) }
    },
    searchStatus(): string {
      if (this.searchLoading) return this.$t('common:header.searchLoading')
      if (this.searchError) return 'Search failed'
      if (!this.searchAttempted) return ''
      if (this.items.length === 0) return 'No users found'
      return `${this.items.length} ${this.items.length === 1 ? 'user' : 'users'} found`
    }
  },
  watch: {
    modelValue(newValue: boolean, oldValue: boolean) {
      if (newValue && !oldValue) {
        this.search = ''
        this.items = []
        this.searchAttempted = false
        this.searchError = ''
        this.searchLoading = false
        _.delay(() => { (this.$refs.searchIpt as { focus: () => void }).focus() }, 100)
      } else if (!newValue && oldValue) {
        this.cancelSearch()
      }
    },
    search () {
      this.queueSearch()
    }
  },
  beforeUnmount () {
    this.cancelSearch()
  },
  methods: {
    initials(val: string): string {
      const words = val.trim().split(/\s+/).filter(Boolean)
      if (words.length === 0) return ''
      if (words.length === 1) return words[0].substring(0, 1)
      return `${words[0].substring(0, 1)}${words[words.length - 1].substring(0, 1)}`
    },
    cancelSearch(): void {
      if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
      this.searchTimer = null
      this.searchRequestId += 1
      this.searchLoading = false
    },
    queueSearch(): void {
      if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
      this.searchTimer = null
      this.searchRequestId += 1
      this.searchError = ''
      this.items = []

      const query = this.search
      if (query.trim().length < 2) {
        this.searchAttempted = false
        this.searchLoading = false
        return
      }

      this.searchAttempted = true
      this.searchLoading = true
      const requestId = this.searchRequestId
      this.searchTimer = window.setTimeout(() => {
        this.searchTimer = null
        void this.loadUsers(query, requestId)
      }, 300)
    },
    async loadUsers(query?: string, requestId?: number): Promise<UserSearchRow[]> {
      if (query === undefined) query = this.search
      if (requestId === undefined) requestId = ++this.searchRequestId
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
        this.searchError = getErrorMessage(err) || this.$t('common:error.generic')
        wikiStore.showError(err)
        return []
      } finally {
        if (requestId === this.searchRequestId) {
          this.searchLoading = false
        }
      }
    },
    retrySearch(): void {
      this.queueSearch()
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
<style scoped>
.user-search__status {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.user-search__instruction {
  display: flex;
  min-height: 7rem;
  align-items: center;
  justify-content: center;
  gap: .75rem;
  padding: 1.25rem;
  border: 1px dashed rgba(var(--v-border-color), .18);
  border-radius: var(--wiki-control-radius);
  color: rgba(var(--v-theme-on-surface), .72);
  text-align: center;
}
</style>
