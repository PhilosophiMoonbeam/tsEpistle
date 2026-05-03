<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-layout(row, wrap)
      v-flex(xs12)
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-search.svg', alt='Search Engine', style='width: 80px;')
          .admin-header-title
            .headline.primary--text.animated.fadeInLeft {{$t('admin:search.title')}}
            .subtitle-1.grey--text.animated.fadeInLeft.wait-p2s {{$t('admin:search.subtitle')}}
          v-spacer
          v-btn.mr-3.animated.fadeInDown.wait-p3s(icon, outlined, color='grey', href='https://docs.requarks.io/search', target='_blank')
            v-icon mdi-help-circle
          v-btn.animated.fadeInDown.wait-p2s(icon, outlined, color='grey', @click='refresh')
            v-icon mdi-refresh
          v-btn.mx-3.animated.fadeInDown.wait-p1s(color='black', dark, depressed, @click='rebuild')
            v-icon(left) mdi-cached
            span {{$t('admin:search.rebuildIndex')}}
          v-btn.animated.fadeInDown(color='success', @click='save', depressed, large)
            v-icon(left) mdi-check
            span {{$t('common:actions.apply')}}

      v-flex(lg3, xs12)
        v-card.animated.fadeInUp
          v-toolbar(flat, color='primary', dark, dense)
            .subtitle-1 {{$t('admin:search.searchEngine')}}
          v-list.py-0(two-line, dense)
            template(v-for='(eng, idx) in engines')
              v-list-item(:key='eng.key', @click='selectedEngine = eng.key', :disabled='!eng.isAvailable')
                v-list-item-avatar(size='24')
                  v-icon(color='grey', v-if='!eng.isAvailable') mdi-minus-box-outline
                  v-icon(color='primary', v-else-if='eng.key === selectedEngine') mdi-checkbox-marked-circle-outline
                  v-icon(color='grey', v-else) mdi-checkbox-blank-circle-outline
                v-list-item-content
                  v-list-item-title.body-2(:class='!eng.isAvailable ? `grey--text` : (selectedEngine === eng.key ? `primary--text` : ``)') {{ eng.title }}
                  v-list-item-subtitle: .caption(:class='!eng.isAvailable ? `grey--text text--lighten-1` : (selectedEngine === eng.key ? `blue--text ` : ``)') {{ eng.description }}
                v-list-item-avatar(v-if='selectedEngine === eng.key', size='24')
                  v-icon.animated.fadeInLeft(color='primary', large) mdi-chevron-right
              v-divider(v-if='idx < engines.length - 1')

      v-flex(lg9, xs12)
        v-card.animated.fadeInUp.wait-p2s
          v-toolbar(color='primary', dense, flat, dark)
            .subtitle-1 {{engine.title}}
          v-card-info(color='blue')
            div
              div {{engine.description}}
              span.caption: a(:href='engine.website') {{engine.website}}
            v-spacer
            .admin-providerlogo
              img(:src='engine.logo', :alt='engine.title')
          v-card-text
            .overline.mb-5 {{$t('admin:search.engineConfig')}}
            .body-2.ml-3(v-if='!engine.config || engine.config.length < 1'): em {{$t('admin:search.engineNoConfig')}}
            template(v-else, v-for='cfg in engine.config')
              v-select(
                v-if='cfg.value.type === "string" && cfg.value.enum'
                outlined
                :items='cfg.value.enum'
                :key='cfg.key'
                :label='cfg.value.title'
                v-model='cfg.value.value'
                prepend-icon='mdi-cog-box'
                :hint='cfg.value.hint ? cfg.value.hint : ""'
                persistent-hint
                :class='cfg.value.hint ? "mb-2" : ""'
              )
              v-switch.mb-3(
                v-else-if='cfg.value.type === "boolean"'
                :key='cfg.key'
                :label='cfg.value.title'
                v-model='cfg.value.value'
                color='primary'
                prepend-icon='mdi-cog-box'
                :hint='cfg.value.hint ? cfg.value.hint : ""'
                persistent-hint
                inset
                )
              v-textarea(
                v-else-if='cfg.value.type === "string" && cfg.value.multiline'
                outlined
                :key='cfg.key'
                :label='cfg.value.title'
                v-model='cfg.value.value'
                prepend-icon='mdi-cog-box'
                :hint='cfg.value.hint ? cfg.value.hint : ""'
                persistent-hint
                :class='cfg.value.hint ? "mb-2" : ""'
                )
              v-text-field(
                v-else
                outlined
                :key='cfg.key'
                :label='cfg.value.title'
                v-model='cfg.value.value'
                prepend-icon='mdi-cog-box'
                :hint='cfg.value.hint ? cfg.value.hint : ""'
                persistent-hint
                :class='cfg.value.hint ? "mb-2" : ""'
                )
</template>

<script>
import _ from 'lodash'

import { fetchSearchEngines, rebuildSearchIndex, saveSearchEngines } from '../../helpers/search-api'
import { loadingStart, loadingStop, showNotification, pushGraphError } from '../../helpers/root-ui-store'

export default {
  data() {
    return {
      engines: [],
      selectedEngine: '',
      engine: {}
    }
  },
  watch: {
    selectedEngine(newValue, oldValue) {
      this.engine = _.find(this.engines, ['key', newValue]) || {}
    },
    engines(newValue, oldValue) {
      this.selectedEngine = _.get(_.find(this.engines, 'isEnabled'), 'key', 'db')
    }
  },
  created() {
    this.loadEngines().catch(() => {})
  },
  methods: {
    async loadEngines({ notifyError = true } = {}) {
      loadingStart(this.$store, 'admin-search-refresh')
      try {
        this.engines = await fetchSearchEngines(window.fetch.bind(window), 'Search engines response is invalid')
      } catch (err) {
        this.engines = []
        if (notifyError) {
          showNotification(this.$store, {
            message: err.message,
            style: 'error',
            icon: 'alert'
          })
        }
        throw err
      } finally {
        loadingStop(this.$store, 'admin-search-refresh')
      }
    },
    async refresh() {
      await this.loadEngines()
      showNotification(this.$store, {
        message: this.$t('admin:search.listRefreshSuccess'),
        style: 'success',
        icon: 'cached'
      })
    },
    async save() {
      loadingStart(this.$store, 'admin-search-saveengines')
      try {
        await saveSearchEngines(window.fetch.bind(window), this.engines.map(tgt => ({
          isEnabled: tgt.key === this.selectedEngine,
          key: tgt.key,
          config: tgt.config.map(cfg => ({...cfg, value: JSON.stringify({ v: cfg.value.value })}))
        })), this.$t('common:error.unexpected'))
        await this.loadEngines({ notifyError: false })
        showNotification(this.$store, {
          message: this.$t('admin:search.configSaveSuccess'),
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        pushGraphError(this.$store, err)
      }
      loadingStop(this.$store, 'admin-search-saveengines')
    },
    async rebuild () {
      loadingStart(this.$store, 'admin-search-rebuildindex')
      try {
        await rebuildSearchIndex(window.fetch.bind(window), this.$t('common:error.unexpected'))
        showNotification(this.$store, {
          message: this.$t('admin:search.indexRebuildSuccess'),
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        pushGraphError(this.$store, err)
      }
      loadingStop(this.$store, 'admin-search-rebuildindex')
    }
  }
}
</script>

<style lang='scss' scoped>

.enginelogo {
  width: 250px;
  height: 85px;
  float:right;
  display: flex;
  justify-content: flex-end;
  align-items: center;

  img {
    max-width: 100%;
    max-height: 50px;
  }
}

</style>
