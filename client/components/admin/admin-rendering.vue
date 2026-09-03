<template lang='pug'>
  v-container(fluid)
    admin-hero(
      icon='/_assets/svg/icon-process.svg'
      :title='$t(`admin:rendering.title`)'
      :description='$t(`admin:rendering.subtitle`)'
    )
      template(v-slot:actions)
        v-tooltip(location='top')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeInDown.wait-p3s(
              icon
              variant="outlined"
              color='grey'
              href='https://docs.requarks.io/rendering'
              target='_blank'
              rel='noopener'
              v-bind='props'
              aria-label='Rendering documentation — opens in a new tab'
            )
              v-icon mdi-help-circle
          span Rendering documentation — opens in a new tab
        v-tooltip(location='top')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeInDown.wait-p2s(
              icon
              variant="outlined"
              color='grey'
              @click='refresh'
              :loading='renderersLoading'
              :disabled='renderersLoading || saving'
              v-bind='props'
              aria-label='Refresh rendering modules'
            )
              v-icon mdi-refresh
          span Refresh rendering modules
        v-btn.animated.fadeInDown(
          color='success'
          @click='save'
          variant="flat"
          size="large"
          :loading='saving'
          :disabled='!renderersLoaded || renderersLoading || saving'
        )
          v-icon(start) mdi-check
          span {{$t('common:actions.apply')}}
    v-row
      v-col.animated.fadeInUp(lg='3', cols='12')
        v-toolbar(
          color="primary"
          density="compact"
          flat
          )
          .text-body-large Rendering Pipeline
        v-list(v-if='renderersLoading', aria-live='polite')
          v-list-item
            v-progress-circular(indeterminate, size='20', width='2', color='primary', aria-label='Loading rendering modules')
            span.ml-3 Loading rendering modules
        v-alert(v-else-if='renderersLoadError', variant='outlined', color='error', aria-live='polite')
          span Rendering modules could not be loaded.
          v-btn.mt-2(variant='outlined', color='primary', size='small', @click='retryLoad') Retry
        v-alert(v-else-if='renderersLoaded && renderers.length < 1', variant='outlined', color='info') No rendering modules are installed.
        v-expansion-panels.adm-rendering-pipeline(
          v-if='renderersLoaded && !renderersLoading && !renderersLoadError && renderers.length > 0'
          v-model='selectedCore'
          variant="accordion"
          mandatory
          )
          v-expansion-panel(
            v-for='core in renderers'
            :key='core.key'
            )
            v-expansion-panel-title(
              hide-actions
              ripple
            )
              v-toolbar(
                color='primary'
                density="compact"
                flat
                )
                v-spacer
                .text-body-medium {{core.input}}
                v-icon.mx-2 mdi-arrow-right-circle
                .text-body-small {{core.output}}
                v-spacer
            v-expansion-panel-text
              v-list.py-0(lines="two", density="compact", role='listbox', aria-label='Rendering modules')
                template(v-for='(rdr, n) in core.children', :key='rdr.key')
                  v-list-item(
                    @click='selectRenderer(rdr.key)'
                    link
                    role='option'
                    :active='currentRenderer.key === rdr.key'
                    :aria-selected='currentRenderer.key === rdr.key'
                    )
                    template(v-slot:prepend)
                      v-avatar(size='24', rounded='0')
                        v-icon(:color='currentRenderer.key === rdr.key ? "primary" : "grey"') {{rdr.icon}}
                    v-list-item-title {{rdr.title}}
                    v-list-item-subtitle: .text-body-small {{rdr.description}}
                    template(v-slot:append)
                      .d-flex.align-center
                        status-indicator(v-if='rdr.isEnabled', positive, pulse, aria-label='Enabled')
                        status-indicator(v-else, negative, aria-label='Disabled')
                        span.ml-2.text-body-small(:class='rdr.isEnabled ? "text-success" : "text-medium-emphasis"') {{rdr.isEnabled ? 'Enabled' : 'Disabled'}}
                  v-divider.my-0(v-if='n < core.children.length - 1')

      v-col(lg='9', cols='12')
        v-alert(v-if='renderersLoading', variant='outlined', color='info', aria-live='polite')
          v-progress-circular(indeterminate, size='20', width='2', color='primary', aria-label='Loading renderer configuration')
          span.ml-3 Loading renderer configuration
        v-alert(v-else-if='renderersLoadError', variant='outlined', color='error', aria-live='polite')
          span Renderer configuration could not be loaded.
          v-btn.mt-2(variant='outlined', color='primary', size='small', @click='retryLoad') Retry
        v-alert(v-else-if='renderersLoaded && !currentRenderer.key', variant='outlined', color='info') Select a rendering module to configure it.
        v-card.wiki-form.animated.fadeInUp(v-if='currentRenderer.key')
          v-toolbar(
            color='primary'
            flat
            density="compact"
            )
            v-icon.mr-2 {{currentRenderer.icon}}
            .text-body-large {{currentRenderer.title}}
            v-spacer
            v-switch(
              color='primary'
              label='Enabled'
              v-model='currentRenderer.isEnabled'
              hide-details
              inset
              :disabled='renderersLoading || saving'
            )
          div.v-card-info(color='info')
            div
              div {{currentRenderer.description}}
              span.text-body-small: a(href='https://docs.requarks.io/en/rendering', target='_blank', rel='noopener', aria-label='Rendering documentation — opens in a new tab') Documentation
          v-card-text.pb-4.pl-4
            .text-label-small.mb-5 Rendering Module Configuration
            .text-body-medium.ml-3(v-if='!currentRenderer.config || currentRenderer.config.length < 1'): em This rendering module has no configuration options you can modify.
            template(v-else, v-for='cfg in currentRenderer.config', :key='cfg.key')
              v-select(
                v-if='cfg.value.type === "string" && cfg.value.enum'
                variant="outlined"
                :items='cfg.value.enum'
                :label='cfg.value.title'
                v-model='cfg.value.value'
                :hint='cfg.value.hint ? cfg.value.hint : ""'
                persistent-hint
                :class='cfg.value.hint ? "mb-2" : ""'
                color='primary'
                :disabled='renderersLoading || saving'
              )
              v-switch(
                v-else-if='cfg.value.type === "boolean"'
                :label='cfg.value.title'
                v-model='cfg.value.value'
                color='primary'
                :hint='cfg.value.hint ? cfg.value.hint : ""'
                persistent-hint
                inset
                :disabled='renderersLoading || saving'
              )
              v-text-field(
                v-else
                variant="outlined"
                :label='cfg.value.title'
                v-model='cfg.value.value'
                :hint='cfg.value.hint ? cfg.value.hint : ""'
                persistent-hint
                :class='cfg.value.hint ? "mb-2" : ""'
                color='primary'
                :disabled='renderersLoading || saving'
              )
          div.v-card-chin
            v-spacer
            .text-body-small.pr-3.text-grey Module: {{ currentRenderer.key }}</template>

<script lang='ts'>
import _ from 'lodash'
import { DepGraph } from 'dependency-graph'

import StatusIndicator from '@/components/common/status-indicator.vue'
import { wikiStore } from '@/store/index.ts'

import { fetchRenderingRenderers, saveRenderingRenderers, type Renderer } from '../../helpers/rendering-api'
import { getErrorMessage, loadingStart, loadingStop, pushGraphError, showNotification } from '../../helpers/root-ui-store'

type RendererTree = Renderer & {
  children: Renderer[]
}

const createEmptyRenderer = (): Renderer => ({
  isEnabled: false,
  key: '',
  title: '',
  description: null,
  icon: null,
  dependsOn: null,
  input: null,
  output: null,
  config: []
})

export default {
  components: {
    StatusIndicator
  },
  data() {
    return {
      selectedCore: -1,
      renderers: [] as RendererTree[],
      currentRenderer: createEmptyRenderer(),
      renderersLoading: false,
      saving: false,
      renderersLoaded: false,
      renderersLoadError: false,
      isDisposed: false
    }
  },
  created () {
    this.loadRenderers().catch(() => {})
  },
  beforeUnmount () {
    this.isDisposed = true
  },
  methods: {
    buildRendererTree (flatRenderers: Renderer[]): RendererTree[] {
      // Build tree
      const graph = new DepGraph({ circular: true })
      const rawCores: RendererTree[] = _.filter(flatRenderers, ['dependsOn', null]).map(core => ({
        ...core,
        children: _.cloneDeep(_.concat([core], _.filter(flatRenderers, ['dependsOn', core.key])))
      }))
      // Build dependency graph
      rawCores.forEach(core => { graph.addNode(core.key) })
      rawCores.forEach(core => {
        rawCores.forEach(coreTarget => {
          if (core.key !== coreTarget.key && core.output === coreTarget.input) {
            graph.addDependency(core.key, coreTarget.key)
          }
        })
      })
      // Reorder cores in reverse dependency order
      const coreKeys = graph.overallOrder() as string[]
      return _.reverse(coreKeys).map(coreKey => _.find(rawCores, ['key', coreKey])!)
    },
    async loadRenderers ({ notifyError = true }: { notifyError?: boolean } = {}) {
      if (this.isDisposed) return false
      this.renderersLoading = true
      this.renderersLoadError = false
      loadingStart(wikiStore, 'admin-rendering-refresh')
      try {
        const flatRenderers = await fetchRenderingRenderers(window.fetch.bind(window), 'Rendering renderers response is invalid')
        if (this.isDisposed) return false
        this.renderers = this.buildRendererTree(flatRenderers)
        this.selectedCore = _.findIndex(this.renderers, ['key', 'markdownCore'])
        this.currentRenderer = createEmptyRenderer()
        if (this.selectedCore >= 0) this.selectRenderer('markdownCore')
        this.renderersLoaded = true
        return true
      } catch (err) {
        if (this.isDisposed) return false
        this.renderers = []
        this.selectedCore = -1
        this.currentRenderer = createEmptyRenderer()
        this.renderersLoaded = false
        this.renderersLoadError = true
        if (notifyError) {
          showNotification(wikiStore, {
            message: getErrorMessage(err),
            style: 'red',
            icon: 'alert'
          })
        }
        throw err
      } finally {
        if (!this.isDisposed) this.renderersLoading = false
        loadingStop(wikiStore, 'admin-rendering-refresh')
      }
    },
    async retryLoad () {
      await this.loadRenderers().catch(() => {})
    },
    selectRenderer (key: string) {
      for (const core of this.renderers) {
        const renderer = core.children.find(renderer => renderer.key === key)
        if (renderer) {
          this.currentRenderer = renderer
          return
        }
      }
    },
    async refresh () {
      if (this.renderersLoading || this.saving) return
      if (!await this.loadRenderers().catch(() => false)) return
      showNotification(wikiStore, {
        message: 'Rendering active configuration has been reloaded.',
        style: 'success',
        icon: 'cached'
      })
    },
    async save () {
      if (!this.renderersLoaded || this.renderersLoading || this.saving) return
      this.saving = true
      loadingStart(wikiStore, 'admin-rendering-saverenderers')
      try {
        if (this.isDisposed) return
        await saveRenderingRenderers(window.fetch.bind(window), this.renderers.reduce<unknown[]>((result, core) => {
          return result.concat(core.children.map(rd => ({
            key: rd.key,
            isEnabled: rd.isEnabled,
            config: rd.config.map(cfg => ({ key: cfg.key, value: JSON.stringify({ v: cfg.value.value }) }))
          })))
        }, []), 'Rendering renderers update failed')
        if (!await this.loadRenderers({ notifyError: false })) return
        showNotification(wikiStore, {
          message: 'Rendering configuration saved successfully.',
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        if (this.isDisposed) return
        pushGraphError(wikiStore, err)
      } finally {
        if (!this.isDisposed) this.saving = false
        loadingStop(wikiStore, 'admin-rendering-saverenderers')
      }
    }
  }
}
</script>

<style lang='scss'>
.adm-rendering-pipeline {
  .v-expansion-panel--active .v-expansion-panel-title {
    min-height: 0;
  }

  .v-expansion-panel-title {
    padding: 0;
    margin-top: 1px;
  }

  .v-expansion-panel-text__wrapper {
    padding: 0;
  }
}
</style>
