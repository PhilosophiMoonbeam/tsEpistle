<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-row()
      v-col(cols='12')
        .admin-header
          img(src='/_assets/svg/icon-console.svg', alt='Developer Tools', style='width: 80px;')
          .admin-header-title
            .headline.primary--text Developer Tools
            .subtitle-1.grey--text Flags
          v-spacer
          v-btn(color='success', depressed, @click='save', large, :disabled='!flagsLoaded')
            v-icon(left) mdi-check
            span {{$t('common:actions.apply')}}

        v-card.mt-3(:class='$vuetify.theme.current.dark ? `grey darken-3-d5` : `white grey--text text--darken-3`')
          v-alert(color='red', :value='true', icon='mdi-alert', dark, prominent)
            span Do NOT enable these flags unless you know what you're doing!
            .caption Doing so may result in data loss or broken installation!
          v-card-text
            v-switch.mt-3(
              color='primary'
              hint='Log detailed debug info on LDAP/AD login attempts.'
              persistent-hint
              label='LDAP Debug'
              v-model='flags.ldapdebug'
              inset
            )
            v-divider.mt-3
            v-switch.mt-3(
              color='red'
              hint='Log all queries made to the database to console.'
              persistent-hint
              label='SQL Query Logging'
              v-model='flags.sqllog'
              inset
            )
</template>

<script lang='ts'>
import { fetchSystemFlags, updateSystemFlags, type SystemFlags } from '../../helpers/system-api'
import { getErrorMessage, loadingStart, loadingStop, showNotification } from '../../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'

export default {
  data() {
    return {
      flags: {
        sqllog: false
      } as SystemFlags,
      flagsLoaded: false
    }
  },
  async mounted() {
    loadingStart(wikiStore, 'admin-dev-flags-refresh')
    try {
      this.flags = await fetchSystemFlags(window.fetch.bind(window), 'System flags response is invalid')
      this.flagsLoaded = true
    } catch (err) {
      showNotification(wikiStore, {
        style: 'red',
        message: getErrorMessage(err),
        icon: 'alert'
      })
    }
    loadingStop(wikiStore, 'admin-dev-flags-refresh')
  },
  methods: {
    async save() {
      if (!this.flagsLoaded) {
        return
      }
      loadingStart(wikiStore, 'admin-dev-flags-update')
      try {
        await updateSystemFlags(window.fetch.bind(window), this.flags, 'System flags update failed')
        showNotification(wikiStore, {
          style: 'success',
          message: 'Flags applied successfully.',
          icon: 'check'
        })
      } catch (err) {
        showNotification(wikiStore, {
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      }
      loadingStop(wikiStore, 'admin-dev-flags-update')
    }
  }
}
</script>

<style lang='scss'>

</style>
