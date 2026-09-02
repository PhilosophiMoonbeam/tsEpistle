<template lang='pug'>
  v-container(fluid)
    admin-hero(
      icon='/_assets/svg/icon-chat-bubble.svg'
      title='Comment providers'
      description='Configure page discussion providers'
      heading-id='admin-comments-heading'
    )
      template(v-slot:actions)
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
        v-btn.animated.fadeInDown.wait-p2s(
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
    v-row
      v-col(lg='3', cols='12')
        v-card.animated.fadeInUp
          v-toolbar(flat, color='primary', density="compact")
            .text-body-large {{$t('admin:comments.provider')}}
          async-state(v-if='loading', state='loading', title='Loading comment providers', message='Fetching available discussion providers.')
          async-state(v-else-if='errorMessage', state='error', title='Comment providers could not be loaded', :message='errorMessage', retry-label='Try again', @retry='loadProviders')
          async-state(v-else-if='providers.length < 1', state='empty', title='No comment providers available', message='No discussion provider is configured.')
          template(v-else)
            .text-body-small.text-medium-emphasis.pa-4.pb-2 Choose the provider to activate, then Apply.
            v-list.py-0(lines="two", density="compact", role='radiogroup', aria-label='Comment provider', tabindex='-1')
              template(v-for='(provider, idx) in providers', :key='provider.key')
                v-list-item(
                  role='radio'
                  :aria-checked='provider.key === selectedProvider'
                  :aria-disabled='!provider.isAvailable'
                  :tabindex='provider.isAvailable && provider.key === selectedProvider ? 0 : -1'
                  @click='selectProvider(provider)'
                  @keydown.enter.prevent='selectProvider(provider)'
                  @keydown.space.prevent='selectProvider(provider)'
                  @keydown.right.stop.prevent='selectAdjacentProvider(provider, 1, $event)'
                  @keydown.down.stop.prevent='selectAdjacentProvider(provider, 1, $event)'
                  @keydown.left.stop.prevent='selectAdjacentProvider(provider, -1, $event)'
                  @keydown.up.stop.prevent='selectAdjacentProvider(provider, -1, $event)'
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
import { wikiStore } from '@/store/index.ts'
import { fetchCommentProviders, saveCommentProviders, type CommentProvider } from '../../helpers/comments-api'
import { getErrorMessage, loadingStart, loadingStop, showNotification, pushGraphError } from '../../helpers/root-ui-store'

const createAbortableFetch = (signal: AbortSignal) => (
  input: RequestInfo | URL,
  init?: RequestInit
) => window.fetch(input, { ...init, signal })

export default {
  components: {
    AsyncState
  },
  data() {
    return {
      providers: [] as CommentProvider[],
      selectedProvider: '',
      loading: false,
      errorMessage: '',
      refreshing: false,
      saving: false,
      loadController: null as AbortController | null,
      saveController: null as AbortController | null,
      isUnmounted: false
    }
  },
  computed: {
    provider (): Partial<CommentProvider> {
      return this.providers.find(provider => provider.key === this.selectedProvider) || {}
    },
    canSave (): boolean {
      return !this.loading && !this.refreshing && !this.saving && this.providers.length > 0 &&
        Boolean(this.providers.find(provider => provider.key === this.selectedProvider)?.isAvailable)
    }
  },
  created() {
    this.loadProviders().catch(() => {})
  },
  methods: {
    selectProvider (provider: CommentProvider) {
      if (provider.isAvailable) {
        this.selectedProvider = provider.key
      }
    },
    selectAdjacentProvider (provider: CommentProvider, direction: 1 | -1, event: KeyboardEvent) {
      const availableProviders = this.providers.filter(item => item.isAvailable)
      const currentIndex = availableProviders.findIndex(item => item.key === provider.key)
      if (currentIndex < 0 || availableProviders.length < 2) return
      const nextIndex = (currentIndex + direction + availableProviders.length) % availableProviders.length
      const nextProvider = availableProviders[nextIndex]
      if (!nextProvider) return
      this.selectedProvider = nextProvider.key
      const group = (event.currentTarget as HTMLElement | null)?.closest('[role="radiogroup"]')
      this.$nextTick(() => {
        group?.querySelectorAll<HTMLElement>('[role="radio"][aria-disabled="false"]')[nextIndex]?.focus()
      })
    },
    async loadProviders({ notifyError = true }: { notifyError?: boolean } = {}) {
      this.loadController?.abort()
      const controller = new AbortController()
      this.loadController = controller
      this.loading = true
      this.errorMessage = ''
      this.refreshing = notifyError
      loadingStart(wikiStore, 'admin-comments-refresh')
      try {
        const providers = await fetchCommentProviders(
          createAbortableFetch(controller.signal),
          'Comment providers response is invalid'
        )
        if (controller.signal.aborted) {
          return false
        }
        const selected = providers.find(provider => provider.isEnabled && provider.isAvailable) ||
          providers.find(provider => provider.isAvailable)
        this.providers = providers
        this.selectedProvider = selected?.key || ''
        return true
      } catch (err) {
        if (controller.signal.aborted) {
          return false
        }
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
        if (this.loadController === controller) {
          this.loadController = null
          if (!this.isUnmounted) {
            this.loading = false
            this.refreshing = false
          }
        }
        loadingStop(wikiStore, 'admin-comments-refresh')
      }
    },
    async refresh() {
      if (this.refreshing || this.saving) return
      try {
        const loaded = await this.loadProviders()
        if (!loaded) return
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
      const controller = new AbortController()
      this.saveController = controller
      this.saving = true
      loadingStart(wikiStore, 'admin-comments-saveproviders')
      try {
        await saveCommentProviders(createAbortableFetch(controller.signal), this.providers.map(tgt => ({
          isEnabled: tgt.key === this.selectedProvider,
          key: tgt.key,
          config: tgt.config.map(cfg => ({...cfg, value: JSON.stringify({ v: cfg.value.value })}))
        })), 'Comment providers save response is invalid')
        if (controller.signal.aborted) {
          return
        }
        await this.loadProviders({ notifyError: false })
        if (controller.signal.aborted) {
          return
        }
        showNotification(wikiStore, {
          message: this.$t('admin:comments.configSaveSuccess'),
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        if (!controller.signal.aborted) {
          pushGraphError(wikiStore, err)
        }
      } finally {
        if (this.saveController === controller) {
          this.saveController = null
          if (!this.isUnmounted) {
            this.saving = false
          }
        }
        loadingStop(wikiStore, 'admin-comments-saveproviders')
      }
    }
  },
  beforeUnmount () {
    this.isUnmounted = true
    this.loadController?.abort()
    this.saveController?.abort()
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
