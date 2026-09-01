<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        admin-hero(
          title='Developer Tools'
          description='Diagnostic flags for temporary developer logging'
          icon='/_assets/svg/icon-console.svg'
        )
          template(v-slot:actions)
            v-btn(color='success', variant="flat", @click='save', size="small", :disabled='!flagsLoaded || loading || saving', :loading='saving')
              v-icon(start) mdi-check
              span {{$t('common:actions.apply')}}

        v-card.mt-3
          v-card-title.text-title-medium Developer diagnostics
          v-alert(color='warning', variant='tonal', icon='mdi-alert', class='mx-4 mt-2')
            .text-title-small.font-weight-medium Use only when troubleshooting
            .text-body-small These flags increase diagnostic output and may affect performance or expose sensitive details.
          v-card-text
            async-state(
              v-if='loading'
              state='loading'
              title='Loading developer flags'
              message='Fetching the current diagnostic settings.'
            )
            async-state(
              v-else-if='errorMessage'
              state='error'
              title='Developer flags could not be loaded'
              :message='errorMessage'
              retry-label='Try again'
              @retry='loadFlags'
            )
            template(v-else-if='flagsLoaded')
              .flag-row(:class='{ "flag-row--enabled": flags.ldapdebug }')
                v-switch(
                  color='warning'
                  hint='Log detailed debug info on LDAP/AD login attempts.'
                  persistent-hint
                  label='LDAP Debug'
                  v-model='flags.ldapdebug'
                  :disabled='loading || saving'
                  inset
                  hide-details='auto'
                )
                v-chip(size='small', variant='tonal', :color='flags.ldapdebug ? `warning` : `grey`') {{ flags.ldapdebug ? 'Enabled' : 'Off' }}
              v-divider.my-3
              .flag-row(:class='{ "flag-row--enabled": flags.sqllog }')
                v-switch(
                  color='warning'
                  hint='Log all queries made to the database to console.'
                  persistent-hint
                  label='SQL Query Logging'
                  v-model='flags.sqllog'
                  :disabled='loading || saving'
                  inset
                  hide-details='auto'
                )
                v-chip(size='small', variant='tonal', :color='flags.sqllog ? `warning` : `grey`') {{ flags.sqllog ? 'Enabled' : 'Off' }}</template>

<script lang='ts'>
import AsyncState from '@/components/common/async-state.vue'
import { fetchSystemFlags, updateSystemFlags, type SystemFlags } from '../../helpers/system-api'
import { getErrorMessage, loadingStart, loadingStop, showNotification } from '../../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'

export default {
  components: {
    AsyncState
  },
  data() {
    return {
      flags: {
        sqllog: false
      } as SystemFlags,
      flagsLoaded: false,
      loading: false,
      saving: false,
      errorMessage: ''
    }
  },
  mounted() {
    this.loadFlags()
  },
  methods: {
    async loadFlags() {
      if (this.loading || this.saving) {
        return false
      }
      this.loading = true
      this.errorMessage = ''
      this.flagsLoaded = false
      loadingStart(wikiStore, 'admin-dev-flags-refresh')
      try {
        this.flags = await fetchSystemFlags(window.fetch.bind(window), 'System flags response is invalid')
        this.flagsLoaded = true
        return true
      } catch (err) {
        this.errorMessage = getErrorMessage(err)
        showNotification(wikiStore, {
          style: 'red',
          message: this.errorMessage,
          icon: 'alert'
        })
        return false
      } finally {
        this.loading = false
        loadingStop(wikiStore, 'admin-dev-flags-refresh')
      }
    },
    async save() {
      if (!this.flagsLoaded || this.loading || this.saving) {
        return
      }
      this.saving = true
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
      } finally {
        this.saving = false
        loadingStop(wikiStore, 'admin-dev-flags-update')
      }
    }
  }
}
</script>

<style lang='scss'>
.flag-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  min-width: 0;
  padding: .25rem .5rem;
  border-radius: .5rem;
}

.flag-row--enabled {
  background: color-mix(in srgb, rgb(var(--v-theme-warning)) 8%, transparent);
}

.flag-row .v-switch {
  min-width: 0;
}

@media (max-width: 599.98px) {
  .flag-row {
    align-items: stretch;
    flex-direction: column;
    gap: .25rem;
  }
}
</style>
