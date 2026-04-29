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
          :class='$vuetify.theme.dark ? `darken-3-d5` : `lighten-3`'
          two-line
          dense
          )
          template(v-for='(usr, idx) in items')
            v-list-item(:key='usr.id', @click='setUser(usr)')
              v-list-item-avatar(size='40', color='primary')
                span.body-1.white--text {{ initials(usr.name) }}
              v-list-item-content
                v-list-item-title.body-2 {{usr.name}}
                v-list-item-subtitle {{usr.email}}
              v-list-item-action
                v-icon(color='primary') mdi-arrow-right
            v-divider.my-0(v-if='idx < items.length - 1')
      v-card-chin
        v-spacer
        v-btn(
          text
          @click='close'
          :disabled='loading'
          ) {{$t('common:actions.cancel')}}
</template>

<script>
import _ from 'lodash'

import { searchUsers } from '../../helpers/users-api'
import { pushGraphError } from '../../helpers/root-ui-store'

export default {
  props: {
    multiple: {
      type: Boolean,
      default: false
    },
    value: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      loading: false,
      searchLoading: false,
      search: '',
      items: [],
      searchRequestId: 0
    }
  },
  computed: {
    dialogOpen: {
      get() { return this.value },
      set(value) { this.$emit('input', value) }
    }
  },
  watch: {
    value(newValue, oldValue) {
      if (newValue && !oldValue) {
        this.search = ''
        this.items = []
        this.selectedItems = null
        _.delay(() => { this.$refs.searchIpt.focus() }, 100)
      }
    },
    search () {
      this.loadUsers()
    }
  },
  methods: {
    initials(val) {
      return val.split(' ').map(v => v.substring(0, 1)).join('')
    },
    async loadUsers () {
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
        pushGraphError(this.$store, err)
        return []
      } finally {
        if (requestId === this.searchRequestId) {
          this.searchLoading = false
        }
      }
    },
    close() {
      this.$emit('input', false)
    },
    setUser(usr) {
      this.$emit('select', usr)
      this.close()
    },
    searchFilter(item, queryText, itemText) {
      return _.includes(_.toLower(item.email), _.toLower(queryText)) || _.includes(_.toLower(item.name), _.toLower(queryText))
    }
  }
}
</script>
