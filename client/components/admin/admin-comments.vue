<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-chat-bubble.svg', alt='', style='width: 80px;', width='80', height='80')
          .admin-header-title
            .text-headline-medium.text-primary.animated.fadeInLeft Comment providers
            .text-body-large.text-medium-emphasis.animated.fadeInLeft.wait-p2s Configure page discussion providers
          v-spacer
          v-btn.animated.fadeInDown.wait-p3s(
            icon
            variant="outlined"
            color='grey'
            href='https://docs.requarks.io/comments'
            target='_blank'
            rel='noopener noreferrer'
            aria-label='Comment provider help'
          )
            v-icon mdi-help-circle
          v-btn.mx-3.animated.fadeInDown.wait-p2s(
            icon
            variant="outlined"
            color='grey'
            @click='refresh'
            :loading='refreshing'
            :disabled='refreshing || saving'
            aria-label='Refresh comment providers'
          )
            v-icon mdi-refresh
          v-btn.animated.fadeInDown(
            color='success'
            @click='save'
            variant="flat"
            size="large"
            :loading='saving'
            :disabled='!canSave'
          )
            v-icon(start) mdi-check
            span {{$t('common:actions.apply')}}
      v-col(lg='3', cols='12')
        v-card.animated.fadeInUp
          v-toolbar(flat, color='primary', density="compact")
            .text-body-large {{$t('admin:comments.provider')}}
          async-state(v-if='loading', state='loading', title='Loading comment providers', message='Fetching available discussion providers.')
          async-state(v-else-if='errorMessage', state='error', title='Comment providers could not be loaded', :message='errorMessage', retry-label='Try again', @retry='loadProviders')
          async-state(v-else-if='providers.length < 1', state='empty', title='No comment providers available', message='No discussion provider is configured.')
          template(v-else)
            .text-body-small.text-medium-emphasis.pa-4.pb-2 Choose the provider to activate, then Apply.
            v-list.py-0(lines="two", density="compact", role='radiogroup', aria-label='Comment provider')
              template(v-for='(provider, idx) in providers', :key='provider.key')
                v-list-item(
                  role='radio'
                  :aria-checked='provider.key === selectedProvider'
                  :tabindex='provider.isAvailable ? 0 : -1'
                  @click='selectedProvider = provider.key'
                  :disabled='!provider.isAvailable'
                )
                  template(v-slot:prepend)
                    v-avatar(size='24')
                      v-icon(color='grey', v-if='!provider.isAvailable') mdi-minus-box-outline
                      v-icon(color='primary', v-else-if='provider.key === selectedProvider') mdi-radiobox-marked
                      v-icon(color='grey', v-else) mdi-radiobox-blank
                  v-list-item-title.text-body-medium(:class='!provider.isAvailable ? `text-medium-emphasis` : (selectedProvider === provider.key ? `text-primary` : ``)') {{ provider.title }}
                  v-list-item-subtitle: .text-body-small {{ provider.description }}
                  template(v-slot:append)
                    v-avatar(v-if='selectedProvider === provider.key', size='24')
                      v-icon.animated.fadeInLeft(color='primary', size="large") mdi-chevron-right
                v-divider(v-if='idx < providers.length - 1')

      v-col(cols='12', lg='9')
        v-card.animated.fadeInUp.wait-p2s(v-if='!loading && !errorMessage && provider.key')
          v-toolbar(color='primary', density="compact", flat)
            .text-body-large {{provider.title}}
          v-card-info(color='info')
            div
              div {{provider.description}}
              span.text-body-small: a(:href='provider.website', style='overflow-wrap:anywhere') {{provider.website}}
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
                :disabled='saving'
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
                :disabled='saving'
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
                :style='(cfg.value.maxWidth || 0) > 0 ? `max-width:` + cfg.value.maxWidth + `px;` : ``'
                :disabled='saving'
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
                :disabled='saving'
                )
        async-state(v-else-if='!loading && !errorMessage && providers.length > 0', state='empty', title='Select a comment provider', message='Choose a provider to review its configuration.')

</template>
<script lang='ts'>
import AsyncState from '@/components/common/async-state.vue'
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'
import { fetchCommentProviders, saveCommentProviders, type CommentProvider } from '../../helpers/comments-api'
import { getErrorMessage, loadingStart, loadingStop, showNotification, pushGraphError } from '../../helpers/root-ui-store'
export default {
  components: {
    AsyncState
  },
  data() {
    return {
      providers: [] as CommentProvider[],
      selectedProvider: '',
      provider: {} as Partial<CommentProvider>,
      loading: false,
      errorMessage: '',
      refreshing: false,
      saving: false
    }
  },
  computed: {
    canSave (): boolean {
      return !this.loading && !this.refreshing && !this.saving && this.providers.length > 0 &&
        Boolean(_.find(this.providers, ['key', this.selectedProvider])?.isAvailable)
    }
  },
  watch: {
    selectedProvider(newValue: string) {
      this.provider = _.find(this.providers, ['key', newValue]) || {}
    },
    providers() {
      const selected = _.find(this.providers, provider => provider.isEnabled && provider.isAvailable) ||
        _.find(this.providers, 'isAvailable')
      this.selectedProvider = selected?.key || ''
    }
  },
  created() {
    this.loadProviders().catch(() => {})
  },
  methods: {
    async loadProviders({ notifyError = true }: { notifyError?: boolean } = {}) {
      this.loading = true
      this.errorMessage = ''
      this.refreshing = notifyError
      loadingStart(wikiStore, 'admin-comments-refresh')
      try {
        this.providers = await fetchCommentProviders(window.fetch.bind(window), 'Comment providers response is invalid')
      } catch (err) {
        this.errorMessage = getErrorMessage(err) || this.$t('common:error.unexpected')
        if (notifyError) {
          showNotification(wikiStore, {
            message: this.errorMessage,
            style: 'red',
            icon: 'alert'
          })
        }
        throw err
      } finally {
        this.loading = false
        this.refreshing = false
        loadingStop(wikiStore, 'admin-comments-refresh')
      }
    },
    async refresh() {
      if (this.refreshing || this.saving) return
      try {
        await this.loadProviders()
      } catch {
        return
      }
      showNotification(wikiStore, {
        message: 'Comment providers refreshed.',
        style: 'success',
        icon: 'cached'
      })
    },
    async save() {
      if (!this.canSave) return
      this.saving = true
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
      } finally {
        this.saving = false
        loadingStop(wikiStore, 'admin-comments-saveproviders')
      }
    }
  }
}
</script>
<style lang='scss' scoped>
.admin-providerlogo {
  max-width: min(220px, 35vw);

  img {
    max-width: 100%;
    height: auto;
  }
}

@media (max-width: 599.98px) {
  .admin-providerlogo {
    max-width: 100%;
  }
}
</style>
