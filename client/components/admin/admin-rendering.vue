<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-row()
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-process.svg', alt='Rendering', style='width: 80px;')
          .admin-header-title
            .headline.primary--text.animated.fadeInLeft {{ $t('admin:rendering.title') }}
            .subtitle-1.grey--text.animated.fadeInLeft.wait-p4s {{ $t('admin:rendering.subtitle') }}
          v-spacer
          v-btn.animated.fadeInDown.wait-p3s(icon, outlined, color='grey', href='https://docs.requarks.io/rendering', target='_blank')
            v-icon mdi-help-circle
          v-btn.mx-3.animated.fadeInDown.wait-p2s(icon, outlined, color='grey', @click='refresh')
            v-icon mdi-refresh
          v-btn.animated.fadeInDown(color='success', @click='save', depressed, large)
            v-icon(left) mdi-check
            span {{$t('common:actions.apply')}}

      v-col.animated.fadeInUp(lg='3', cols='12')
        v-toolbar(
          color='blue darken-2'
          dense
          flat
          dark
          )
          .subtitle-1 Pipeline
        v-expansion-panels.adm-rendering-pipeline(
          v-model='selectedCore'
          accordion
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
                color='blue'
                dense
                dark
                flat
                )
                v-spacer
                .body-2 {{core.input}}
                v-icon.mx-2 mdi-arrow-right-circle
                .caption {{core.output}}
                v-spacer
            v-expansion-panel-text
              v-list.py-0(two-line, dense)
                template(v-for='(rdr, n) in core.children', :key='rdr.key')
                  v-list-item(
                    @click='selectRenderer(rdr.key)'
                    :class='currentRenderer.key === rdr.key ? ($vuetify.theme.current.dark ? `grey darken-4-l4` : `blue lighten-5`) : ``'
                    )
                    v-avatar(size='24', tile)
                      v-icon(:color='currentRenderer.key === rdr.key ? "primary" : "grey"') {{rdr.icon}}
                    div.v-list-item-content
                      v-list-item-title {{rdr.title}}
                      v-list-item-subtitle: .caption {{rdr.description}}
                    v-avatar(size='24')
                      status-indicator(v-if='rdr.isEnabled', positive, pulse)
                      status-indicator(v-else, negative, pulse)
                  v-divider.my-0(v-if='n < core.children.length - 1')

      v-col(lg='9', cols='12')
        v-card.wiki-form.animated.fadeInUp
          v-toolbar(
            color='indigo'
            dark
            flat
            dense
            )
            v-icon.mr-2 {{currentRenderer.icon}}
            .subtitle-1 {{currentRenderer.title}}
            v-spacer
            v-switch(
              dark
              color='white'
              label='Enabled'
              v-model='currentRenderer.isEnabled'
              hide-details
              inset
              )
          div.v-card-info(color='blue')
            div
              div {{currentRenderer.description}}
              span.caption: a(href='https://docs.requarks.io/en/rendering', target='_blank') Documentation
          v-card-text.pb-4.pl-4
            .overline.mb-5 Rendering Module Configuration
            .body-2.ml-3(v-if='!currentRenderer.config || currentRenderer.config.length < 1'): em This rendering module has no configuration options you can modify.
            template(v-else, v-for='(cfg, idx) in currentRenderer.config', :key='cfg.key')
              v-select(
                v-if='cfg.value.type === "string" && cfg.value.enum'
                outlined
                :items='cfg.value.enum'
                :label='cfg.value.title'
                v-model='cfg.value.value'
                :hint='cfg.value.hint ? cfg.value.hint : ""'
                persistent-hint
                :class='cfg.value.hint ? "mb-2" : ""'
                color='indigo'
              )
              v-switch(
                v-else-if='cfg.value.type === "boolean"'
                :label='cfg.value.title'
                v-model='cfg.value.value'
                color='indigo'
                :hint='cfg.value.hint ? cfg.value.hint : ""'
                persistent-hint
                inset
                )
              v-text-field(
                v-else
                outlined
                :label='cfg.value.title'
                v-model='cfg.value.value'
                :hint='cfg.value.hint ? cfg.value.hint : ""'
                persistent-hint
                :class='cfg.value.hint ? "mb-2" : ""'
                color='indigo'
                )
              v-divider.my-5(v-if='idx < currentRenderer.config.length - 1')
          div.v-card-chin
            v-spacer
            .caption.pr-3.grey--text Module: {{ currentRenderer.key }}
</template>

<script lang='ts'>
import _ from 'lodash'
import { DepGraph } from 'dependency-graph'

import StatusIndicator from '@/components/common/status-indicator.vue'
import { wikiStore } from '@/store/index.ts'

import { fetchRenderingRenderers, saveRenderingRenderers, type Renderer } from '../../helpers/rendering-api'
import { getErrorMessage, loadingStart, loadingStop, showNotification } from '../../helpers/root-ui-store'

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
      currentRenderer: createEmptyRenderer()
    }
  },
  watch: {
    renderers(newValue: RendererTree[]) {
      _.delay(() => {
        this.selectedCore = _.findIndex(newValue, ['key', 'markdownCore'])
        this.selectRenderer('markdownCore')
      }, 500)
    }
  },
  created () {
    this.loadRenderers().catch(() => {})
  },
  methods: {
    buildRendererTree (flatRenderers: Renderer[]): RendererTree[] {
      const renderers = _.cloneDeep(flatRenderers)
      // Build tree
      const graph = new DepGraph({ circular: true })
      const rawCores: RendererTree[] = _.filter(renderers, ['dependsOn', null]).map(core => ({
        ...core,
        children: _.concat([_.cloneDeep(core)], _.filter(renderers, ['dependsOn', core.key]))
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
      loadingStart(wikiStore, 'admin-rendering-refresh')
      try {
        const flatRenderers = await fetchRenderingRenderers(window.fetch.bind(window), 'Rendering renderers response is invalid')
        this.renderers = this.buildRendererTree(flatRenderers)
      } catch (err) {
        if (notifyError) {
          showNotification(wikiStore, {
            message: getErrorMessage(err),
            style: 'red',
            icon: 'alert'
          })
        }
        throw err
      } finally {
        loadingStop(wikiStore, 'admin-rendering-refresh')
      }
    },
    selectRenderer (key: string) {
      this.renderers.forEach(rdr => {
        const renderer = _.find(rdr.children, ['key', key])
        if (renderer) {
          this.currentRenderer = renderer
        }
      })
    },
    async refresh () {
      await this.loadRenderers()
      showNotification(wikiStore, {
        message: 'Rendering active configuration has been reloaded.',
        style: 'success',
        icon: 'cached'
      })
    },
    async save () {
      loadingStart(wikiStore, 'admin-rendering-saverenderers')
      try {
        await saveRenderingRenderers(window.fetch.bind(window), this.renderers.reduce<unknown[]>((result, core) => {
          return result.concat(core.children.map(rd => ({
            key: rd.key,
            isEnabled: rd.isEnabled,
            config: rd.config.map(cfg => ({ key: cfg.key, value: JSON.stringify({ v: cfg.value.value }) }))
          })))
        }, []), 'Rendering renderers update failed')
        await this.loadRenderers({ notifyError: false })
        showNotification(wikiStore, {
          message: 'Rendering configuration saved successfully.',
          style: 'success',
          icon: 'check'
        })
      } finally {
        loadingStop(wikiStore, 'admin-rendering-saverenderers')
      }
    }
  }
}
</script>

<style lang='scss'>
.adm-rendering-pipeline {
  .v-expansion-panel--active .v-expansion-panel-header {
    min-height: 0;
  }

  .v-expansion-panel-header {
    padding: 0;
    margin-top: 1px;
  }

  .v-expansion-panel-content__wrap {
    padding: 0;
  }
}
</style>
