<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        admin-hero(
          :title='$t(`admin:extensions.title`)'
          :description='$t(`admin:extensions.subtitle`)'
          icon='/_assets/svg/icon-installing-updates.svg'
        )
        .pt-3
          v-row
            v-col(xl='6' lg='8' cols='12')
              v-alert.mb-4(type='info', variant="tonal", icon='mdi-information')
                span New extensions cannot be installed at the moment. This feature is coming in a future release.
              v-alert.mb-4(v-if='loadState === `error`', type='error', variant="tonal", icon='mdi-alert')
                span Unable to load extensions.
                v-btn.ml-2(variant="text", size="small", @click='loadExtensions') Retry
              div(v-if='loadState === `loading`', role='status', aria-label='Loading extensions')
                v-skeleton-loader.mb-3(v-for='index in 3', :key='`extension-skeleton-` + index', type='list-item-two-line')
              v-alert.mb-0(v-else-if='loadState === `success` && !extensions.length', type='info', variant="outlined", icon='mdi-puzzle-outline')
                span No extensions are available.
              v-expansion-panels.admin-extensions-exp(v-else-if='extensions.length', variant="popout")
                v-expansion-panel(v-for='ext of extensions', :key='ext.key')
                  v-expansion-panel-title
                    span {{ext.title}}
                    template(v-slot:actions='{ expanded, expandIcon, collapseIcon }')
                      v-chip(label, color='success', size="small", v-if='ext.isInstalled', prepend-icon='mdi-check-circle') Installed
                      v-chip(label, color='warning', size="small", v-else, prepend-icon='mdi-download-circle-outline') Not Installed
                      v-icon.ml-2(:icon='expanded ? collapseIcon : expandIcon', aria-hidden='true')
                  v-expansion-panel-text.pa-0
                    v-card.bg-surface-variant(flat, rounded='0')
                      v-card-text
                        .text-body-medium {{ext.description}}
                        v-divider.my-4
                        .text-body-medium
                          strong.mr-2 This extension is
                          v-chip.mr-2(v-if='ext.isCompatible', label, variant="outlined", size="small", color='success') compatible
                          v-chip.mr-2(v-else, label, size="small", color='error') not compatible
                          strong with your host.
                      v-card-chin
                        v-spacer
                        v-btn(disabled)
                          v-icon(start) mdi-plus
                          span Install
</template>

<script lang='ts'>
import { markRaw } from 'vue'
import { fetchSystemExtensions, type SystemExtension } from '../../helpers/system-api'
import { loadingStart, loadingStop, pushGraphError } from '../../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'

export default {
  data() {
    return {
      extensions: [] as SystemExtension[],
      loadState: 'loading' as 'loading' | 'success' | 'error',
      isUnmounted: false
    }
  },
  methods: {
    async loadExtensions () {
      if (this.isUnmounted) return false
      this.loadState = 'loading'
      this.extensions = []
      loadingStart(wikiStore, 'admin-extensions-refresh')
      try {
        const extensions = await fetchSystemExtensions(window.fetch.bind(window), 'System extensions response is invalid')
        if (this.isUnmounted) {
          return false
        }
        this.extensions = markRaw(extensions)
        this.loadState = 'success'
        return true
      } catch (err) {
        if (this.isUnmounted) {
          return false
        }
        this.loadState = 'error'
        pushGraphError(wikiStore, err)
        return false
      } finally {
        loadingStop(wikiStore, 'admin-extensions-refresh')
      }
    }
  },
  created () {
    this.loadExtensions()
  },
  beforeUnmount () {
    this.isUnmounted = true
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
