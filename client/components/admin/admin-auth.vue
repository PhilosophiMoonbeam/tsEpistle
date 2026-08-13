<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-row()
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-unlock.svg', alt='Authentication', style='width: 80px;')
          .admin-header-title
            .headline.primary--text.animated.fadeInLeft {{ $t('admin:auth.title') }}
            .subtitle-1.grey--text.animated.fadeInLeft.wait-p4s {{ $t('admin:auth.subtitle') }}
          v-spacer
          v-btn.animated.fadeInDown.wait-p3s(icon, outlined, color='grey', href='https://docs.requarks.io/auth', target='_blank')
            v-icon mdi-help-circle
          v-btn.animated.fadeInDown.wait-p2s.mx-3(icon, outlined, color='grey', @click='refresh')
            v-icon mdi-refresh
          v-btn.animated.fadeInDown(color='success', @click='save', depressed, large)
            v-icon(left) mdi-check
            span {{$t('common:actions.apply')}}

      v-col(lg='3', cols='12')
        v-card.animated.fadeInUp
          v-toolbar(flat, color='teal', dark, dense)
            .subtitle-1 {{$t('admin:auth.activeStrategies')}}
          v-list(two-line, dense).py-0
            draggable(
              v-model='activeStrategies'
              handle='.is-handle'
              direction='vertical'
              )
              transition-group
                v-list-item(
                  v-for='(str, idx) in activeStrategies'
                  :key='str.key'
                  @click='selectedStrategy = str.key'
                  :class='selectedStrategy === str.key ? ($vuetify.theme.current.dark ? `grey darken-5` : `teal lighten-5`) : ``'
                  )
                  v-avatar.is-handle(size='24')
                    v-icon(:color='selectedStrategy === str.key ? `teal` : `grey`') mdi-drag-horizontal
                  div.v-list-item-content
                    v-list-item-title.body-2(:class='selectedStrategy === str.key ? `teal--text` : ``') {{ str.displayName }}
                    v-list-item-subtitle: .caption(:class='selectedStrategy === str.key ? `teal--text ` : ``') {{ str.strategy.title }}
                  v-avatar(v-if='selectedStrategy === str.key', size='24')
                    v-icon.animated.fadeInLeft(color='teal', large) mdi-chevron-right
          div.v-card-chin
            v-menu(offset-y, bottom, min-width='250px', max-width='550px', max-height='50vh', style='flex: 1 1;', center)
              template(v-slot:activator='{ props }')
                v-btn(v-bind='props', color='primary', depressed, block)
                  v-icon(left) mdi-plus
                  span {{$t('admin:auth.addStrategy')}}
              v-list(dense)
                template(v-for='(str, idx) of strategies', :key='str.key')
                  v-list-item(
                    :disabled='str.isDisabled'
                    @click='addStrategy(str)'
                    )
                    v-avatar(height='24', width='48', tile)
                      v-img(:src='str.logo', width='48px', height='24px', contain, :style='str.isDisabled ? `opacity: .25;` : ``')
                    div.v-list-item-content
                      v-list-item-title {{str.title}}
                      v-list-item-subtitle: .caption(:style='str.isDisabled ? `opacity: .4;` : ``') {{str.description}}
                  v-divider(v-if='idx < strategies.length - 1')

      v-col(cols='12', lg='9')
        v-card.animated.fadeInUp.wait-p2s
          v-toolbar(color='primary', dense, flat, dark)
            .subtitle-1 {{strategy.displayName}} #[em ({{strategy.strategy.title}})]
            v-spacer
            v-btn(small, outlined, dark, color='white', :disabled='strategy.key === `local`', @click='deleteStrategy()')
              v-icon(left) mdi-close
              span {{$t('common:actions.delete')}}
          div.v-card-info(color='blue')
            div
              span {{strategy.strategy.description}}
              .caption: a(:href='strategy.strategy.website') {{strategy.strategy.website}}
            v-spacer
            .admin-providerlogo
              img(:src='strategy.strategy.logo', :alt='strategy.strategy.title')
          v-card-text
            .row
              .col-8
                v-text-field(
                  outlined
                  :label='$t(`admin:auth.displayName`)'
                  v-model='strategy.displayName'
                  prepend-icon='mdi-format-title'
                  :hint='$t(`admin:auth.displayNameHint`)'
                  persistent-hint
                  )
              .col-4
                v-switch.mt-1(
                  :label='$t(`admin:auth.strategyIsEnabled`)'
                  v-model='strategy.isEnabled'
                  color='primary'
                  prepend-icon='mdi-power'
                  :hint='$t(`admin:auth.strategyIsEnabledHint`)'
                  persistent-hint
                  inset
                  :disabled='strategy.key === `local`'
                  )
            template(v-if='strategy.config && Object.keys(strategy.config).length > 0')
              v-divider
              .overline.my-5 {{$t('admin:auth.strategyConfiguration')}}
              .pr-3
                template(v-for='cfg in strategy.config', :key='cfg.key')
                  v-select.mb-3(
                    v-if='cfg.value.type === "string" && cfg.value.enum'
                    outlined
                    :items='cfg.value.enum'
                    :label='cfg.value.title'
                    v-model='cfg.value.value'
                    prepend-icon='mdi-cog-box'
                    :hint='cfg.value.hint ? cfg.value.hint : ""'
                    persistent-hint
                    :class='cfg.value.hint ? "mb-2" : ""'
                    :style='cfg.value.maxWidth > 0 ? `max-width:` + cfg.value.maxWidth + `px;` : ``'
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
                    outlined
                    :label='cfg.value.title'
                    v-model='cfg.value.value'
                    prepend-icon='mdi-cog-box'
                    :hint='cfg.value.hint ? cfg.value.hint : ""'
                    persistent-hint
                    :class='cfg.value.hint ? "mb-2" : ""'
                    )
                  v-text-field.mb-3(
                    v-else
                    outlined
                    :label='cfg.value.title'
                    v-model='cfg.value.value'
                    prepend-icon='mdi-cog-box'
                    :hint='cfg.value.hint ? cfg.value.hint : ""'
                    persistent-hint
                    :class='cfg.value.hint ? "mb-2" : ""'
                    :style='cfg.value.maxWidth > 0 ? `max-width:` + cfg.value.maxWidth + `px;` : ``'
                    )
            v-divider
            .overline.my-5 {{$t('admin:auth.registration')}}
            .pr-3
              v-switch.ml-3(
                v-model='strategy.selfRegistration'
                :label='$t(`admin:auth.selfRegistration`)'
                color='primary'
                :hint='$t(`admin:auth.selfRegistrationHint`)'
                persistent-hint
                inset
              )
              v-combobox.ml-3.mt-5(
                :label='$t(`admin:auth.domainsWhitelist`)'
                v-model='strategy.domainWhitelist'
                prepend-icon='mdi-email-check-outline'
                outlined
                :disabled='!strategy.selfRegistration'
                :hint='$t(`admin:auth.domainsWhitelistHint`)'
                persistent-hint
                closable-chips
                clearable
                multiple
                chips
                )
              v-autocomplete.mt-3.ml-3(
                outlined
                :disabled='!strategy.selfRegistration'
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

        v-card.mt-4.wiki-form.animated.fadeInUp.wait-p4s(v-if='selectedStrategy !== `local`')
          v-toolbar(color='primary', dense, flat, dark)
            .subtitle-1 {{$t('admin:auth.configReference')}}
          v-card-text
            .body-2 {{$t('admin:auth.configReferenceSubtitle')}}
            v-alert.mt-3.radius-7(v-if='host.length < 8', color='red', outlined, :value='true', icon='mdi-alert')
              i18next(path='admin:auth.siteUrlNotSetup', tag='span')
                strong(place='siteUrl') {{$t('admin:general.siteUrl')}}
                strong(place='general') {{$t('admin:general.title')}}
            .pa-3.mt-3.radius-7.grey(v-else, :class='$vuetify.theme.current.dark ? `darken-3-d5` : `lighten-3`')
              .body-2: strong {{$t('admin:auth.allowedWebOrigins')}}
              .body-2 {{host}}
              v-divider.my-3
              .body-2: strong {{$t('admin:auth.callbackUrl')}}
              .body-2 {{host}}/login/{{strategy.key}}/callback
              v-divider.my-3
              .body-2: strong {{$t('admin:auth.loginUrl')}}
              .body-2 {{host}}/login
              v-divider.my-3
              .body-2: strong {{$t('admin:auth.logoutUrl')}}
              .body-2 {{host}}
              v-divider.my-3
              .body-2: strong {{$t('admin:auth.tokenEndpointAuthMethod')}}
              .body-2 HTTP-POST
</template>

<script lang='ts'>
import _ from 'lodash'
import { fetchAdminAuthActiveStrategies, fetchAdminAuthStrategies, updateAdminAuthStrategies, type AdminActiveAuthStrategy, type AdminAuthStrategy } from '../../helpers/auth-api'
import { fetchGroupOptions, type GroupOption } from '../../helpers/groups-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { fetchSystemHost } from '../../helpers/system-api'

import draggable from '@/components/common/draggable-list.vue'
import { wikiStore } from '@/store/index.ts'

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
      strategy: createEmptyStrategy()
    }
  },
  watch: {
    selectedStrategy(newValue: string) {
      this.strategy = _.find(this.activeStrategies, ['key', newValue]) || createEmptyStrategy()
    },
    activeStrategies() {
      this.selectedStrategy = 'local'
    }
  },
  methods: {
    async loadGroups() {
      wikiStore.startLoading('admin-auth-groups-refresh')
      try {
        this.groups = await fetchGroupOptions(window.fetch.bind(window), 'Groups response is invalid')
      } catch (err) {
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      }
      wikiStore.stopLoading('admin-auth-groups-refresh')
    },
    async loadHost({ notifyError = true }: { notifyError?: boolean } = {}) {
      wikiStore.startLoading('admin-auth-host-refresh')
      try {
        const response = await fetchSystemHost(window.fetch.bind(window), 'Site host response is invalid')
        this.host = response.host
        return response
      } catch (err) {
        this.host = ''
        if (notifyError) {
          wikiStore.showNotification({
            style: 'red',
            message: getErrorMessage(err),
            icon: 'alert'
          })
        }
        throw err
      } finally {
        wikiStore.stopLoading('admin-auth-host-refresh')
      }
    },
    async loadStrategies() {
      wikiStore.startLoading('admin-auth-strategies-refresh')
      try {
        this.strategies = await fetchAdminAuthStrategies(window.fetch.bind(window), 'Authentication strategies response is invalid')
      } catch (err) {
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
        throw err
      } finally {
        wikiStore.stopLoading('admin-auth-strategies-refresh')
      }
    },
    async loadActiveStrategies() {
      wikiStore.startLoading('admin-auth-activestrategies-refresh')
      try {
        this.activeStrategies = await fetchAdminAuthActiveStrategies(window.fetch.bind(window), 'Active authentication strategies response is invalid')
      } catch (err) {
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
        throw err
      } finally {
        wikiStore.stopLoading('admin-auth-activestrategies-refresh')
      }
    },
    async refresh() {
      await this.loadStrategies()
      await this.loadActiveStrategies()
      await this.loadHost()
      wikiStore.showNotification({
        message: this.$t('admin:auth.refreshSuccess'),
        style: 'success',
        icon: 'cached'
      })
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
      this.activeStrategies = _.reject(this.activeStrategies, ['key', this.strategy.key])
    },
    async save() {
      wikiStore.startLoading('admin-auth-savestrategies')
      try {
        await updateAdminAuthStrategies(window.fetch.bind(window), this.activeStrategies.map((str, idx) => ({
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
        wikiStore.showNotification({
          message: this.$t('admin:auth.saveSuccess'),
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
      }
      wikiStore.stopLoading('admin-auth-savestrategies')
    }
  },
  created() {
    this.loadGroups()
    this.loadHost().catch(() => {})
    this.loadStrategies().catch(() => {})
    this.loadActiveStrategies().catch(() => {})
  }

}
</script>
