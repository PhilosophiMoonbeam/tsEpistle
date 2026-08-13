<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-installing-updates.svg', alt='Extensions', style='width: 80px;')
          .admin-header-title
            .headline.primary--text.animated.fadeInLeft {{ $t('admin:extensions.title') }}
            .subtitle-1.grey--text.animated.fadeInLeft {{ $t('admin:extensions.subtitle') }}
        v-form.pt-3
          v-row
            v-col(xl='6' lg='8' cols='12')
              v-alert.mb-4(outlined, color='error', icon='mdi-alert')
                span New extensions cannot be installed at the moment. This feature is coming in a future release.
              v-expansion-panels.admin-extensions-exp(hover, popout)
                v-expansion-panel(v-for='ext of extensions', :key='`ext-` + ext.key')
                  v-expansion-panel-title(disable-icon-rotate)
                    span {{ext.title}}
                    template(v-slot:actions)
                      v-chip(label, color='success', small, v-if='ext.isInstalled') Installed
                      v-chip(label, color='warning', small, v-else) Not Installed
                  v-expansion-panel-text.pa-0
                    v-card(flat, :class='$vuetify.theme.current.dark ? `grey darken-3` : `grey lighten-5`', tile)
                      v-card-text
                        .body-2 {{ext.description}}
                        v-divider.my-4
                        .body-2
                          strong.mr-2 This extension is
                          v-chip.mr-2(v-if='ext.isCompatible', label, outlined, small, color='success') compatible
                          v-chip.mr-2(v-else, label, small, color='error') not compatible
                          strong with your host.
                      div.v-card-chin
                        v-spacer
                        v-btn(disabled)
                          v-icon(left) mdi-plus
                          span Install
</template>

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
  .v-expansion-panel-content__wrap {
    padding: 0;
  }
}
</style>
