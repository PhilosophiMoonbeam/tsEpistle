<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-installing-updates.svg', alt='Extensions', style='width: 80px;')
          .admin-header-title
            .text-headline-medium.text-primary.animated.fadeInLeft {{ $t('admin:extensions.title') }}
            .text-body-large.text-grey.animated.fadeInLeft {{ $t('admin:extensions.subtitle') }}
        v-form.pt-3
          v-row
            v-col(xl='6' lg='8' cols='12')
              v-alert.mb-4(variant="outlined", color='error', icon='mdi-alert')
                span New extensions cannot be installed at the moment. This feature is coming in a future release.
              v-expansion-panels.admin-extensions-exp(variant="popout")
                v-expansion-panel(v-for='ext of extensions', :key='`ext-` + ext.key')
                  v-expansion-panel-title(disable-icon-rotate)
                    span {{ext.title}}
                    template(v-slot:actions)
                      v-chip(label, color='success', size="small", v-if='ext.isInstalled') Installed
                      v-chip(label, color='warning', size="small", v-else) Not Installed
                  v-expansion-panel-text.pa-0
                    v-card(flat, :class='$vuetify.theme.current.dark ? `bg-grey-darken-3` : `bg-grey-lighten-5`', rounded='0')
                      v-card-text
                        .text-body-medium {{ext.description}}
                        v-divider.my-4
                        .text-body-medium
                          strong.mr-2 This extension is
                          v-chip.mr-2(v-if='ext.isCompatible', label, variant="outlined", size="small", color='success') compatible
                          v-chip.mr-2(v-else, label, size="small", color='error') not compatible
                          strong with your host.
                      div.v-card-chin
                        v-spacer
                        v-btn(disabled)
                          v-icon(start) mdi-plus
                          span Install</template>

<script lang='ts'>
import { fetchSystemExtensions, type SystemExtension } from '../../helpers/system-api'
import { loadingStart, loadingStop, pushGraphError } from '../../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'

export default {
  data() {
    return {
      extensions: [] as SystemExtension[]
    }
  },
  methods: {
    async loadExtensions () {
      loadingStart(wikiStore, 'admin-extensions-refresh')
      try {
        this.extensions = await fetchSystemExtensions(window.fetch.bind(window), 'System extensions response is invalid')
        return true
      } catch (err) {
        this.extensions = []
        pushGraphError(wikiStore, err)
        return false
      } finally {
        loadingStop(wikiStore, 'admin-extensions-refresh')
      }
    }
  },
  created () {
    this.loadExtensions()
  }
}
</script>

<style lang='scss'>
.admin-extensions-exp {
  .v-expansion-panel-text__wrapper {
    padding: 0;
  }
}
</style>
