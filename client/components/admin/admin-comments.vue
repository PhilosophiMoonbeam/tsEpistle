<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-chat-bubble.svg', alt='Comments', style='width: 80px;')
          .admin-header-title
            .text-headline-medium.text-primary.animated.fadeInLeft {{$t('admin:comments.title')}}
            .text-body-large.text-grey.animated.fadeInLeft.wait-p2s {{$t('admin:comments.subtitle')}}
          v-spacer
          v-btn.animated.fadeInDown.wait-p3s(icon, variant="outlined", color='grey', href='https://docs.requarks.io/comments', target='_blank')
            v-icon mdi-help-circle
          v-btn.mx-3.animated.fadeInDown.wait-p2s(icon, variant="outlined", color='grey', @click='refresh')
            v-icon mdi-refresh
          v-btn.animated.fadeInDown(color='success', @click='save', variant="flat", size="large")
            v-icon(start) mdi-check
            span {{$t('common:actions.apply')}}

      v-col(lg='3', cols='12')
        v-card.animated.fadeInUp
          v-toolbar(flat, color='primary', density="compact")
            .text-body-large {{$t('admin:comments.provider')}}
          v-list.py-0(lines="two", density="compact")
            template(v-for='(provider, idx) in providers', :key='provider.key')
              v-list-item(@click='selectedProvider = provider.key', :disabled='!provider.isAvailable')
                template(v-slot:prepend)
                  v-avatar(size='24')
                    v-icon(color='grey', v-if='!provider.isAvailable') mdi-minus-box-outline
                    v-icon(color='primary', v-else-if='provider.key === selectedProvider') mdi-checkbox-marked-circle-outline
                    v-icon(color='grey', v-else) mdi-checkbox-blank-circle-outline
                v-list-item-title.text-body-medium(:class='!provider.isAvailable ? `text-grey` : (selectedProvider === provider.key ? `text-primary` : ``)') {{ provider.title }}
                v-list-item-subtitle: .text-body-small(:class='!provider.isAvailable ? `text-grey-lighten-1` : (selectedProvider === provider.key ? `text-blue ` : ``)') {{ provider.description }}
                template(v-slot:append)
                  v-avatar(v-if='selectedProvider === provider.key', size='24')
                    v-icon.animated.fadeInLeft(color='primary', size="large") mdi-chevron-right
              v-divider(v-if='idx < providers.length - 1')

      v-col(lg='9', cols='12')
        v-card.animated.fadeInUp.wait-p2s
          v-toolbar(color='primary', density="compact", flat)
            .text-body-large {{provider.title}}
          div.v-card-info(color='info')
            div
              div {{provider.description}}
              span.text-body-small: a(:href='provider.website') {{provider.website}}
            v-spacer
            .admin-providerlogo
              img(:src='provider.logo', :alt='provider.title')
          v-card-text
            .text-label-small.my-5 {{$t('admin:comments.providerConfig')}}
            .text-body-medium.ml-3(v-if='!provider.config || provider.config.length < 1'): em {{$t('admin:comments.providerNoConfig')}}
            template(v-else, v-for='cfg in provider.config', :key='cfg.key')
              v-select.mb-3(
                v-if='cfg.value.type === "string" && cfg.value.enum'
                variant="outlined"
                :items='cfg.value.enum'
                :label='cfg.value.title'
                v-model='cfg.value.value'
                prepend-icon='mdi-cog-box'
                :hint='cfg.value.hint ? cfg.value.hint : ""'
                persistent-hint
                :class='cfg.value.hint ? "mb-2" : ""'
                :style='(cfg.value.maxWidth || 0) > 0 ? `max-width:` + cfg.value.maxWidth + `px;` : ``'
              )
              v-switch.mb-6(
                v-else-if='cfg.value.type === "boolean"'
                :label='cfg.value.title'
                v-model='cfg.value.value'
                color='primary'
                prepend-icon='mdi-cog-box'
                :hint='cfg.value.hint ? cfg.value.hint : ""'
                persistent-hint
                inset
                )
              v-textarea.mb-3(
                v-else-if='cfg.value.type === "string" && cfg.value.multiline'
                variant="outlined"
                :label='cfg.value.title'
                v-model='cfg.value.value'
                prepend-icon='mdi-cog-box'
                :hint='cfg.value.hint ? cfg.value.hint : ""'
                persistent-hint
                :class='cfg.value.hint ? "mb-2" : ""'
                )
              v-text-field.mb-3(
                v-else
                variant="outlined"
                :label='cfg.value.title'
                v-model='cfg.value.value'
                prepend-icon='mdi-cog-box'
                :hint='cfg.value.hint ? cfg.value.hint : ""'
                persistent-hint
                :class='cfg.value.hint ? "mb-2" : ""'
                :style='(cfg.value.maxWidth || 0) > 0 ? `max-width:` + cfg.value.maxWidth + `px;` : ``'
                )</template>

<script lang='ts'>
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'
import { fetchCommentProviders, saveCommentProviders, type CommentProvider } from '../../helpers/comments-api'
import { getErrorMessage, loadingStart, loadingStop, showNotification, pushGraphError } from '../../helpers/root-ui-store'

export default {
  data() {
    return {
      providers: [] as CommentProvider[],
      selectedProvider: '',
      provider: {} as Partial<CommentProvider>
    }
  },
  watch: {
    selectedProvider(newValue: string) {
      this.provider = _.find(this.providers, ['key', newValue]) || {}
    },
    providers() {
      this.selectedProvider = _.get(_.find(this.providers, 'isEnabled'), 'key', 'db')
    }
  },
  created() {
    this.loadProviders().catch(() => {})
  },
  methods: {
    async loadProviders({ notifyError = true }: { notifyError?: boolean } = {}) {
      loadingStart(wikiStore, 'admin-comments-refresh')
      try {
        this.providers = await fetchCommentProviders(window.fetch.bind(window), 'Comment providers response is invalid')
      } catch (err) {
        if (notifyError) {
          showNotification(wikiStore, {
            message: getErrorMessage(err) || this.$t('common:error.unexpected'),
            style: 'red',
            icon: 'alert'
          })
        }
        throw err
      } finally {
        loadingStop(wikiStore, 'admin-comments-refresh')
      }
    },
    async refresh() {
      try {
        await this.loadProviders()
      } catch {
        return
      }
      showNotification(wikiStore, {
        message: this.$t('admin:comments.listRefreshSuccess'),
        style: 'success',
        icon: 'cached'
      })
    },
    async save() {
      loadingStart(wikiStore, 'admin-comments-saveproviders')
      try {
        await saveCommentProviders(window.fetch.bind(window), this.providers.map(tgt => ({
          isEnabled: tgt.key === this.selectedProvider,
          key: tgt.key,
          config: tgt.config.map(cfg => ({...cfg, value: JSON.stringify({ v: cfg.value.value })}))
        })), 'Comment providers save response is invalid')
        await this.loadProviders({ notifyError: false })
        showNotification(wikiStore, {
          message: this.$t('admin:comments.configSaveSuccess'),
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        pushGraphError(wikiStore, err)
      }
      loadingStop(wikiStore, 'admin-comments-saveproviders')
    }
  }
}
</script>
