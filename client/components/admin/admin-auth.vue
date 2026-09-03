<template lang='pug'>
  v-container(fluid)
    admin-hero(
      icon='/_assets/svg/icon-unlock.svg'
      :title='$t(`admin:auth.title`)'
      :description='$t(`admin:auth.subtitle`)'
    )
      template(v-slot:status)
        v-chip(v-if='dirty', color='warning', variant='tonal', size='small') Unsaved changes
      template(v-slot:actions)
        v-btn(
          icon
          variant="outlined"
          color='grey'
          href='https://docs.requarks.io/auth'
          target='_blank'
          rel='noopener noreferrer'
          :aria-label='$t(`admin:auth.configReference`)'
          title='Open authentication documentation'
        )
          v-icon mdi-help-circle
        v-btn(
          icon
          variant="outlined"
          color='grey'
          @click='refresh'
          :aria-label='$t(`common:actions.refresh`)'
          title='Refresh authentication settings'
          :loading='initialLoading'
          :disabled='initialLoading || saving'
        )
          v-icon mdi-refresh
        v-btn(
          type='button'
          color='success'
          :loading='saving'
          :disabled='!loaded || initialLoading || saving || !dirty'
          @click='save'
        )
          v-icon(start) mdi-check
          span {{$t('common:actions.apply')}}
    v-alert(v-if='initialLoading', type='info', variant='tonal', class='mb-4', role='status') Loading authentication settings…
    v-row
      v-col(lg='3', cols='12')
        v-card.animated.fadeInUp(v-if='loaded && !initialLoading')
          v-toolbar(flat, color='teal', density="compact")
            .text-body-large {{$t('admin:auth.activeStrategies')}}
          v-list(lines="two", density="compact", :aria-label='$t(`admin:auth.activeStrategies`)').py-0
            draggable(
              v-model='activeStrategies'
              handle='.is-handle:not(:disabled)'
              )
              transition-group
                v-list-item(
                  v-for='(str, idx) in activeStrategies'
                  :key='str.key'
                  :aria-current='selectedStrategy === str.key ? `true` : undefined'
                  link
                  @click='selectedStrategy = str.key'
                )
                  template(v-slot:prepend)
                    v-btn.is-handle(
                      icon
                      size='small'
                      variant='text'
                      :aria-label='`Move ${str.displayName} (position ${idx + 1})`'
                      :disabled='saving'
                      @click.stop='selectedStrategy = str.key'
                    )
                      v-icon(:color='selectedStrategy === str.key ? `teal` : `grey`') mdi-drag-horizontal
                    .d-flex.flex-column
                      v-btn(size='x-small', icon, variant='text', :disabled='saving || idx === 0', :aria-label='`Move ${str.displayName} up`', @click.stop='moveStrategy(idx, -1)')
                        v-icon(size='16') mdi-chevron-up
                      v-btn(size='x-small', icon, variant='text', :disabled='saving || idx === activeStrategies.length - 1', :aria-label='`Move ${str.displayName} down`', @click.stop='moveStrategy(idx, 1)')
                        v-icon(size='16') mdi-chevron-down
                  v-list-item-title.text-body-medium(:class='selectedStrategy === str.key ? `text-teal` : ``') {{ str.displayName }}
                  v-list-item-subtitle: .text-body-small(:class='selectedStrategy === str.key ? `text-teal ` : ``') {{ str.strategy.title }}
                  template(v-slot:append)
                    v-avatar(v-if='selectedStrategy === str.key', size='24')
                      v-icon.animated.fadeInLeft(color='teal', size="large") mdi-chevron-right
          div.v-card-chin
            v-menu(location="bottom", min-width='250px', max-width='550px', max-height='50vh', style='flex: 1 1;')
              template(v-slot:activator='{ props }')
                v-btn(v-bind='props', color='primary', variant="flat", block, :disabled='saving')
                  v-icon(start) mdi-plus
                  span {{$t('admin:auth.addStrategy')}}
              v-list(density="compact")
                template(v-for='(str, idx) of strategies', :key='str.key')
                  v-list-item(
                    :disabled='str.isDisabled'
                    link
                    @click='addStrategy(str)'
                    )
                    template(v-slot:prepend)
                      v-avatar(size='48', rounded='0', style='height: 24px')
                        v-img(:src='str.logo', width='48px', height='24px', alt='', :style='str.isDisabled ? `opacity: .25;` : ``')
                    v-list-item-title {{str.title}}
                    v-list-item-subtitle: .text-body-small(:style='str.isDisabled ? `opacity: .4;` : ``') {{str.description}}
                  v-divider(v-if='idx < strategies.length - 1')

      v-col(cols='12', lg='9')
        v-card.animated.fadeInUp.wait-p2s(v-if='loaded && !initialLoading && strategy.key')
          v-toolbar(color='primary', density="compact", flat)
            .text-body-large {{strategy.displayName}} #[em ({{strategy.strategy.title}})]
            v-spacer
            v-btn(size="small", variant="outlined", color='error', :disabled='strategy.key === `local` || saving', @click='deleteStrategy()')
              v-icon(start) mdi-delete
              span Remove strategy
          div.v-card-info(color='info')
            div
              span {{strategy.strategy.description}}
              .text-body-small: a(:href='strategy.strategy.website') {{strategy.strategy.website}}
            v-spacer
            .admin-providerlogo
              img(:src='strategy.strategy.logo', :alt='strategy.strategy.title')
          v-card-text
            v-row
              v-col(cols='12', sm='8')
                v-text-field(
                  ref='displayNameInput'
                  variant="outlined"
                  :label='$t(`admin:auth.displayName`)'
                  v-model='strategy.displayName'
                  :rules='displayNameRules'
                  maxlength='255'
                  prepend-icon='mdi-format-title'
                  :hint='$t(`admin:auth.displayNameHint`)'
                  persistent-hint
                  :disabled='saving'
                )
              v-col(cols='12', sm='4')
                v-switch.mt-1(
                  :label='$t(`admin:auth.strategyIsEnabled`)'
                  v-model='strategy.isEnabled'
                  color='primary'
                  prepend-icon='mdi-power'
                  :hint='$t(`admin:auth.strategyIsEnabledHint`)'
                  persistent-hint
                  inset
                  :disabled='strategy.key === `local` || saving'
                )
            template(v-if='strategy.config && strategy.config.length > 0')
              v-divider
              .text-label-small.my-5 {{$t('admin:auth.strategyConfiguration')}}
              .pr-3
                template(v-for='cfg in strategy.config', :key='cfg.key')
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
                    :style='cfg.value.maxWidth > 0 ? `max-width:` + cfg.value.maxWidth + `px;` : ``'
                    :disabled='saving'
                  )
                  v-switch.mb-6(
                    v-else-if='cfg.value.type === "boolean"'
                    :label='cfg.value.title'
                    :model-value='cfg.value.value === true'
                    @update:model-value='cfg.value.value = $event === true'
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
                    :model-value='cfg.value.sensitive && !isSecretRevealed(cfg.key) && cfg.value.value !== "********" ? "********" : cfg.value.value'
                    :append-inner-icon='cfg.value.sensitive ? (isSecretRevealed(cfg.key) ? "mdi-eye-off" : "mdi-eye") : undefined'
                    @update:model-value='updateSecret(cfg.key, $event, cfg.value)'
                    @click:append-inner='cfg.value.sensitive && toggleSecret(cfg.key)'
                    prepend-icon='mdi-cog-box'
                    :hint='cfg.value.sensitive ? "Stored secret is masked; reveal to replace." : (cfg.value.hint ? cfg.value.hint : "")'
                    persistent-hint
                    :class='cfg.value.hint ? "mb-2" : ""'
                    @update:focused='selectStoredSecret($event, cfg.value)'
                    :disabled='saving'
                  )
                  v-text-field.mb-3(
                    v-else
                    variant="outlined"
                    :label='cfg.value.title'
                    v-model='cfg.value.value'
                    :type='cfg.value.sensitive && !isSecretRevealed(cfg.key) ? "password" : "text"'
                    :autocomplete='cfg.value.sensitive ? "new-password" : undefined'
                    :append-inner-icon='cfg.value.sensitive ? (isSecretRevealed(cfg.key) ? "mdi-eye-off" : "mdi-eye") : undefined'
                    @click:append-inner='cfg.value.sensitive && toggleSecret(cfg.key)'
                    prepend-icon='mdi-cog-box'
                    :hint='cfg.value.sensitive ? "Stored secret is masked; leave unchanged or reveal to replace." : (cfg.value.hint ? cfg.value.hint : "")'
                    persistent-hint
                    :class='cfg.value.hint ? "mb-2" : ""'
                    :style='cfg.value.maxWidth > 0 ? `max-width:` + cfg.value.maxWidth + `px;` : ``'
                    @update:focused='selectStoredSecret($event, cfg.value)'
                    :disabled='saving'
                  )
            v-divider
            .text-label-small.my-5 {{$t('admin:auth.registration')}}
            .pr-3
              v-switch.ml-3(
                v-model='strategy.selfRegistration'
                :label='$t(`admin:auth.selfRegistration`)'
                color='primary'
                :hint='$t(`admin:auth.selfRegistrationHint`)'
                persistent-hint
                inset
                :disabled='saving'
              )
              v-combobox.ml-3.mt-5(
                :label='$t(`admin:auth.domainsWhitelist`)'
                v-model='strategy.domainWhitelist'
                prepend-icon='mdi-email-check-outline'
                variant="outlined"
                :disabled='saving || !strategy.selfRegistration'
                :hint='$t(`admin:auth.domainsWhitelistHint`)'
                persistent-hint
                closable-chips
                clearable
                multiple
                chips
                )
              v-autocomplete.mt-3.ml-3(
                variant="outlined"
                :disabled='saving || !strategy.selfRegistration'
                :items='groups'
                item-title='name'
                item-value='id'
                :label='$t(`admin:auth.autoEnrollGroups`)'
                v-model='strategy.autoEnrollGroups'
                prepend-icon='mdi-account-group'
                :hint='$t(`admin:auth.autoEnrollGroupsHint`)'
                persistent-hint
                closable-chips
                clearable
                multiple
                chips
                )

        v-card.mt-4.wiki-form.animated.fadeInUp.wait-p4s(v-if='strategy.key && selectedStrategy !== `local`')
          v-toolbar(color='primary', density="compact", flat)
            .text-body-large {{$t('admin:auth.configReference')}}
          v-card-text
            .text-body-medium {{$t('admin:auth.configReferenceSubtitle')}}
            v-alert.mt-3.radius-7(v-if='host.length < 8', color='red', variant="outlined", :model-value='true', icon='mdi-alert')
              i18next(path='admin:auth.siteUrlNotSetup', tag='span')
                strong(place='siteUrl') {{$t('admin:general.siteUrl')}}
                strong(place='general') {{$t('admin:general.title')}}
            .pa-3.mt-3.radius-7.bg-surface-variant(v-else)
              .text-body-medium: strong {{$t('admin:auth.allowedWebOrigins')}}
              .text-body-medium {{host}}
              v-divider.my-3
              .text-body-medium: strong {{$t('admin:auth.callbackUrl')}}
              .text-body-medium {{host}}/login/{{strategy.key}}/callback
              v-divider.my-3
              .text-body-medium: strong {{$t('admin:auth.loginUrl')}}
              .text-body-medium {{host}}/login
              v-divider.my-3
              .text-body-medium: strong {{$t('admin:auth.logoutUrl')}}
              .text-body-medium {{host}}
              v-divider.my-3
              .text-body-medium: strong {{$t('admin:auth.tokenEndpointAuthMethod')}}
              .text-body-medium HTTP-POST</template>

<script lang='ts'>
import { markRaw } from 'vue'

import _ from 'lodash'
import { fetchAdminAuthActiveStrategies, fetchAdminAuthStrategies, updateAdminAuthStrategies, type AdminActiveAuthStrategy, type AdminAuthStrategy } from '../../helpers/auth-api'
import { fetchGroupOptions, type GroupOption } from '../../helpers/groups-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { fetchSystemHost } from '../../helpers/system-api'

import draggable from '@/components/common/draggable-list.vue'
import { wikiStore } from '@/store/index.ts'

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const createAbortableFetch = (signal: AbortSignal): FetchImpl => (input, init) => (
  window.fetch(input, { ...init, signal })
)

const createEmptyStrategy = (): AdminActiveAuthStrategy => ({
  key: '',
  strategy: {
    key: '',
    title: '',
    description: '',
    logo: '',
    website: '',
    isAvailable: false,
    isDisabled: true,
    props: []
  },
  config: [],
  order: 0,
  isEnabled: false,
  displayName: '',
  selfRegistration: false,
  domainWhitelist: [],
  autoEnrollGroups: []
})

const EMPTY_STRATEGY = markRaw(createEmptyStrategy())

export default {
  components: {
    draggable
  },
  data() {
    return {
      groups: [] as GroupOption[],
      strategies: [] as AdminAuthStrategy[],
      activeStrategies: [] as AdminActiveAuthStrategy[],
      selectedStrategy: '',
      host: '',
      initialLoading: true,
      loaded: false,
      saving: false,
      persistedStrategies: [] as AdminActiveAuthStrategy[],
      revealedSecrets: {} as Record<string, boolean>,
      loadController: null as AbortController | null,
      saveController: null as AbortController | null,
      isUnmounted: false
    }
  },
  computed: {
    dirty (): boolean {
      return !_.isEqual(this.activeStrategies, this.persistedStrategies)
    },
    displayNameRules (): Array<(value: string) => true | string> {
      return [
        (value: string) => Boolean(value?.trim()) || 'Display name is required.'
      ]
    },
    strategy (): AdminActiveAuthStrategy {
      return _.find(this.activeStrategies, ['key', this.selectedStrategy]) || EMPTY_STRATEGY
    }
  },
  watch: {
    selectedStrategy() {
      this.revealedSecrets = {}
    }
  },
  methods: {
    async loadGroups(fetchImpl: FetchImpl, signal: AbortSignal) {
      wikiStore.startLoading('admin-auth-groups-refresh')
      try {
        const groups = await fetchGroupOptions(fetchImpl, 'Groups response is invalid')
        if (!signal.aborted && !this.isUnmounted) {
          this.groups = groups
        }
      } catch (err) {
        if (!signal.aborted && !this.isUnmounted) {
          wikiStore.showNotification({
            style: 'red',
            message: getErrorMessage(err),
            icon: 'alert'
          })
        }
      } finally {
        wikiStore.stopLoading('admin-auth-groups-refresh')
      }
    },
    async loadHost(fetchImpl: FetchImpl, signal: AbortSignal, { notifyError = true }: { notifyError?: boolean } = {}) {
      wikiStore.startLoading('admin-auth-host-refresh')
      try {
        const response = await fetchSystemHost(fetchImpl, 'Site host response is invalid')
        if (signal.aborted || this.isUnmounted) {
          return
        }
        this.host = response.host
        return response
      } catch (err) {
        if (!signal.aborted && !this.isUnmounted) {
          this.host = ''
          if (notifyError) {
            wikiStore.showNotification({
              style: 'red',
              message: getErrorMessage(err),
              icon: 'alert'
            })
          }
        }
        throw err
      } finally {
        wikiStore.stopLoading('admin-auth-host-refresh')
      }
    },
    async loadStrategies(fetchImpl: FetchImpl, signal: AbortSignal) {
      wikiStore.startLoading('admin-auth-strategies-refresh')
      try {
        const strategies = await fetchAdminAuthStrategies(fetchImpl, 'Authentication strategies response is invalid')
        if (!signal.aborted && !this.isUnmounted) {
          this.strategies = strategies
        }
      } catch (err) {
        if (!signal.aborted && !this.isUnmounted) {
          wikiStore.showNotification({
            style: 'red',
            message: getErrorMessage(err),
            icon: 'alert'
          })
        }
        throw err
      } finally {
        wikiStore.stopLoading('admin-auth-strategies-refresh')
      }
    },
    async loadActiveStrategies(fetchImpl: FetchImpl, signal: AbortSignal) {
      wikiStore.startLoading('admin-auth-activestrategies-refresh')
      try {
        const activeStrategies = await fetchAdminAuthActiveStrategies(fetchImpl, 'Active authentication strategies response is invalid')
        if (!signal.aborted && !this.isUnmounted) {
          this.activeStrategies = activeStrategies
        }
      } catch (err) {
        if (!signal.aborted && !this.isUnmounted) {
          wikiStore.showNotification({
            style: 'red',
            message: getErrorMessage(err),
            icon: 'alert'
          })
        }
        throw err
      } finally {
        wikiStore.stopLoading('admin-auth-activestrategies-refresh')
      }
    },
    async loadInitial() {
      if (this.isUnmounted) return
      this.loadController?.abort()
      const controller = new AbortController()
      this.loadController = controller
      const fetchImpl = createAbortableFetch(controller.signal)
      this.initialLoading = true
      this.revealedSecrets = {}
      this.loaded = false
      try {
        await Promise.all([
          this.loadGroups(fetchImpl, controller.signal),
          this.loadHost(fetchImpl, controller.signal),
          this.loadStrategies(fetchImpl, controller.signal),
          this.loadActiveStrategies(fetchImpl, controller.signal)
        ])
        if (controller.signal.aborted || this.isUnmounted) {
          return
        }
        this.persistedStrategies = _.cloneDeep(this.activeStrategies)
        this.selectedStrategy = this.activeStrategies.find(str => str.key === 'local')?.key || this.activeStrategies[0]?.key || ''
        this.loaded = true
      } catch {
        controller.abort()
        return
      } finally {
        if (this.loadController === controller) {
          this.loadController = null
          if (!this.isUnmounted) {
            this.initialLoading = false
          }
        }
      }
    },
    async refresh() {
      if (this.initialLoading || this.saving) return
      if (this.dirty && !window.confirm('Discard unsaved authentication changes and refresh?')) return
      await this.loadInitial()
      if (!this.isUnmounted && this.loaded) {
        wikiStore.showNotification({
          message: this.$t('admin:auth.refreshSuccess'),
          style: 'success',
          icon: 'cached'
        })
      }
    },
    moveStrategy (index: number, offset: number) {
      const target = index + offset
      if (target < 0 || target >= this.activeStrategies.length) return
      const next = [...this.activeStrategies]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      this.activeStrategies = next
    },
    addStrategy (str: AdminAuthStrategy) {
      const newStr = {
        key: crypto.randomUUID(),
        strategy: str,
        config: str.props.map(c => ({
          key: c.key,
          value: {
            ...c,
            value: c.default
          }
        })),
        order: this.activeStrategies.length,
        isEnabled: true,
        displayName: str.title,
        selfRegistration: false,
        domainWhitelist: [],
        autoEnrollGroups: []
      } satisfies AdminActiveAuthStrategy
      this.activeStrategies = [...this.activeStrategies, newStr]
      this.$nextTick(() => {
        this.selectedStrategy = newStr.key
      })
    },
    deleteStrategy () {
      if (this.strategy.key === 'local') return
      if (!window.confirm(`Remove ${this.strategy.displayName}? This change will be pending until Apply.`)) return
      this.activeStrategies = _.reject(this.activeStrategies, ['key', this.strategy.key])
      this.selectedStrategy = this.activeStrategies[0]?.key || ''
    },
    isSecretRevealed (key: string): boolean {
      return Boolean(this.revealedSecrets[key])
    },
    toggleSecret (key: string) {
      this.revealedSecrets = { ...this.revealedSecrets, [key]: !this.revealedSecrets[key] }
    },
    updateSecret (key: string, value: unknown, config: { value?: unknown }) {
      const item = _.find(this.strategy.config, ['key', key])
      if (item) item.value.value = value
      else config.value = value
    },
    selectStoredSecret(focused: boolean, config: { sensitive?: boolean, value?: unknown }) {
      if (!focused || !config.sensitive || config.value !== '********') return
      const input = document.activeElement
      if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return
      requestAnimationFrame(() => {
        if (document.activeElement === input) input.select()
      })
    },
    async save() {
      if (!this.loaded || this.initialLoading || this.saving || !this.dirty || this.isUnmounted) return
      const invalidStrategy = this.activeStrategies.find(str => !str.displayName.trim())
      if (invalidStrategy) {
        this.selectedStrategy = invalidStrategy.key
        wikiStore.showNotification({
          style: 'red',
          message: 'Every authentication strategy must have a display name.',
          icon: 'alert'
        })
        this.$nextTick(() => {
          ;(this.$refs.displayNameInput as { focus?: () => void } | undefined)?.focus?.()
        })
        return
      }
      for (const strategy of this.activeStrategies) {
        strategy.displayName = strategy.displayName.trim()
        strategy.domainWhitelist = [...new Set(
          strategy.domainWhitelist
            .map(domain => domain.trim().toLowerCase())
            .filter(Boolean)
        )]
      }
      if (!this.dirty) return
      const controller = new AbortController()
      this.saveController = controller
      this.saving = true
      wikiStore.startLoading('admin-auth-savestrategies')
      try {
        await updateAdminAuthStrategies(createAbortableFetch(controller.signal), this.activeStrategies.map((str, idx) => ({
          key: str.key,
          strategyKey: str.strategy.key,
          displayName: str.displayName,
          order: idx,
          isEnabled: str.isEnabled,
          config: str.config.map(cfg => ({ ...cfg, value: JSON.stringify({ v: cfg.value.value }) })),
          selfRegistration: str.selfRegistration,
          domainWhitelist: str.domainWhitelist,
          autoEnrollGroups: str.autoEnrollGroups
        })))
        if (controller.signal.aborted || this.isUnmounted) {
          return
        }
        this.persistedStrategies = _.cloneDeep(this.activeStrategies)
        wikiStore.showNotification({
          message: this.$t('admin:auth.saveSuccess'),
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        if (!controller.signal.aborted && !this.isUnmounted) {
          wikiStore.showError(err)
        }
      } finally {
        if (this.saveController === controller) {
          this.saveController = null
          if (!this.isUnmounted) {
            this.saving = false
          }
        }
        wikiStore.stopLoading('admin-auth-savestrategies')
      }
    }
  },
  created() {
    void this.loadInitial()
  },
  beforeUnmount() {
    this.isUnmounted = true
    this.loadController?.abort()
    this.saveController?.abort()
  },

}
</script>
