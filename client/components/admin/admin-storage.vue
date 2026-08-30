<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-cloud-storage.svg', alt='', aria-hidden='true', style='width: 80px;')
          .admin-header-title
            .text-headline-medium.text-primary.animated.fadeInLeft {{$t('admin:storage.title')}}
            .text-body-large.text-grey.animated.fadeInLeft.wait-p4s {{$t('admin:storage.subtitle')}}
          v-spacer
          v-tooltip(location='top')
            template(v-slot:activator='{ props }')
              v-btn.animated.fadeInDown.wait-p3s(icon, variant="outlined", color='grey', href='https://docs.requarks.io/storage', target='_blank', v-bind='props', aria-label='Storage documentation — opens in a new tab')
                v-icon mdi-help-circle
            span Storage documentation — opens in a new tab
          v-tooltip(location='top')
            template(v-slot:activator='{ props }')
              v-btn.mx-3.animated.fadeInDown.wait-p2s(icon, variant="outlined", color='grey', @click='refresh', v-bind='props', aria-label='Refresh storage targets')
                v-icon mdi-refresh
            span Refresh storage targets
          v-btn.animated.fadeInDown(color='success', @click='save', variant="flat", size="large")
            v-icon(start) mdi-check
            span {{$t('common:actions.apply')}}

      v-col(lg='3', cols='12')
        v-card.animated.fadeInUp
          v-toolbar(flat, color='primary', density="compact")
            .text-body-large {{$t('admin:storage.targets')}}
          v-list(lines="two", density="compact").py-0
            template(v-for='(tgt, idx) in targets', :key='tgt.key')
              v-list-item(
                :active='selectedTarget === tgt.key'
                :aria-current='selectedTarget === tgt.key ? "page" : undefined'
                @click='selectedTarget = tgt.key'
                :disabled='!tgt.isAvailable'
              )
                template(v-slot:prepend)
                  v-checkbox-btn(
                    :model-value='tgt.isEnabled'
                    :disabled='!tgt.isAvailable || (tgt.key === `local` && tgt.isEnabled)'
                    :aria-label='`${tgt.isEnabled ? "Disable" : "Enable"} ${tgt.title}`'
                    @click.stop
                    @update:model-value='setTargetEnabled(tgt, $event)'
                  )
                v-list-item-title.text-body-medium(:class='!tgt.isAvailable ? `text-grey` : (selectedTarget === tgt.key ? `text-primary` : ``)') {{ tgt.title }}
                v-list-item-subtitle: .text-body-small(:class='!tgt.isAvailable ? `text-grey-lighten-1` : (selectedTarget === tgt.key ? `text-primary` : ``)') {{ tgt.description }}
                template(v-slot:append)
                  v-avatar(v-if='selectedTarget === tgt.key', size='24')
                    v-icon.animated.fadeInLeft(color='primary', size="large") mdi-chevron-right
              v-divider(v-if='idx < targets.length - 1')

        v-card.mt-3.animated.fadeInUp.wait-p2s
          v-toolbar(flat, color='grey-darken-3', density="compact")
            .text-body-large {{$t('admin:storage.status')}}
            v-spacer
            looping-rhombuses-spinner(
              v-if='statusRefreshing'
              :animation-duration='5000'
              :rhombus-size='10'
              color='#FFF'
              aria-label='Refreshing status'
            )
            span.text-body-small(v-if='statusRefreshing') Refreshing status
          v-list.py-0(lines="two", density="compact", aria-live='polite', :aria-busy='statusRefreshing')
            template(v-for='(tgt, n) in status', :key='tgt.key')
              v-list-item
                template(v-slot:prepend)
                  v-avatar(v-if='tgt.status === `pending`', color='info')
                    v-icon(color='white') mdi-clock-outline
                  v-avatar(v-else-if='tgt.status === `operational`', color='success')
                    v-icon(color='white') mdi-check-circle
                  v-avatar(v-else-if='tgt.status === `warning`', color='warning')
                    v-icon(color='white') mdi-alert
                  v-avatar(v-else, color='error')
                    v-icon(color='white') mdi-close-circle-outline
                template(v-if='tgt.status === `pending`')
                  v-list-item-title.text-body-medium
                    span {{tgt.title}}
                    v-chip.ml-2(size='x-small', color='info', label) {{statusLabel(tgt.status)}}
                  v-list-item-subtitle.text-body-small {{$t('admin:storage.lastSyncAttempt', { time: $helpers.formatMoment(tgt.lastAttempt, 'from') })}}
                template(v-else-if='tgt.status === `operational`')
                  v-list-item-title.text-body-medium
                    span {{tgt.title}}
                    v-chip.ml-2(size='x-small', color='success', label) {{statusLabel(tgt.status)}}
                  v-list-item-subtitle.text-body-small {{$t('admin:storage.lastSync', { time: $helpers.formatMoment(tgt.lastAttempt, 'from') })}}
                template(v-else-if='tgt.status === `warning`')
                  v-list-item-title.text-body-medium
                    span {{tgt.title}}
                    v-chip.ml-2(size='x-small', color='warning', label) {{statusLabel(tgt.status)}}
                  v-list-item-subtitle.text-body-small {{$t('admin:storage.lastSyncAttempt', { time: $helpers.formatMoment(tgt.lastAttempt, 'from') })}}
                template(v-else)
                  v-list-item-title.text-body-medium
                    span {{tgt.title}}
                    v-chip.ml-2(size='x-small', color='error', label) {{statusLabel(tgt.status)}}
                  v-list-item-subtitle.text-body-small {{$t('admin:storage.lastSyncAttempt', { time: $helpers.formatMoment(tgt.lastAttempt, 'from') })}}
                template(v-slot:append)
                  v-progress-circular(v-if='tgt.status === `pending`', indeterminate, :size='20', :width='2', color='info', :aria-label='`Synchronizing ${tgt.title}`')
                  v-menu(v-else-if='tgt.status !== `operational`')
                    template(v-slot:activator='{ props }')
                      v-tooltip(location='top')
                        template(v-slot:activator='{ props: tooltipProps }')
                          v-btn(icon, v-bind='{ ...props, ...tooltipProps }', :aria-label='`View ${tgt.title} ${statusLabel(tgt.status).toLowerCase()} details`')
                            v-icon(:color='tgt.status === `warning` ? `warning` : `error`') mdi-information
                        span View {{tgt.title}} {{statusLabel(tgt.status).toLowerCase()}} details
                    v-card(width='450', max-width='calc(100vw - 32px)')
                      v-toolbar(flat, :color='tgt.status === `warning` ? `warning` : `error`', density="compact") {{$t('admin:storage.errorMsg')}}
                      v-card-text(style='overflow-wrap:anywhere; white-space:pre-wrap;') {{tgt.message}}

              v-divider(v-if='n < status.length - 1')
            v-list-item(v-if='status.length < 1')
              em {{$t('admin:storage.noTarget')}}

      v-col(cols='12', lg='9')
        v-card.wiki-form.animated.fadeInUp.wait-p2s
          v-toolbar(color='primary', density="compact", flat)
            .text-body-large {{target.title}}
            v-spacer
            v-switch(
              color="blue-lighten-5"
              label='Active'
              v-model='target.isEnabled'
              hide-details
              inset
              )
          div.v-card-info(color='info')
            div
              div {{target.description}}
              span.text-body-small.provider-url: a(:href='target.website') {{target.website}}
            v-spacer
            .admin-providerlogo
              img(:src='target.logo', :alt='target.title')
          v-card-text
            v-form
              i18next.text-body-medium(path='admin:storage.targetState', tag='div', v-if='target.isEnabled')
                v-chip(color='success', size="small", label, place='state') {{$t('admin:storage.targetStateActive')}}
              i18next.text-body-medium(path='admin:storage.targetState', tag='div', v-else)
                v-chip(color='error', size="small", label, place='state') {{$t('admin:storage.targetStateInactive')}}
              v-divider.mt-3
              .text-label-small.my-5 {{$t('admin:storage.targetConfig')}}
              .text-body-medium.ml-3(v-if='!target.config || target.config.length < 1'): em {{$t('admin:storage.noConfigOption')}}
              template(v-else, v-for='cfg in target.config', :key='cfg.key')
                v-select(
                  v-if='cfg.value.type === "string" && cfg.value.enum'
                  variant="outlined"
                  :items='cfg.value.enum'
                  :label='cfg.value.title'
                  v-model='cfg.value.value'
                  prepend-icon='mdi-cog-box'
                  :hint='cfg.value.hint ? cfg.value.hint : ""'
                  persistent-hint
                  :class='cfg.value.hint ? "mb-2" : ""'
                )
                v-switch.mb-3(
                  v-else-if='cfg.value.type === "boolean"'
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
                  variant="outlined"
                  :label='cfg.value.title'
                  v-model='cfg.value.value'
                  prepend-icon='mdi-cog-box'
                  :hint='cfg.value.hint ? cfg.value.hint : ""'
                  persistent-hint
                  :class='cfg.value.hint ? "mb-2" : ""'
                  @update:focused='selectStoredSecret($event, cfg.value)'
                  )
                v-text-field(
                  v-else
                  variant="outlined"
                  :label='cfg.value.title'
                  v-model='cfg.value.value'
                  prepend-icon='mdi-cog-box'
                  :hint='cfg.value.hint ? cfg.value.hint : ""'
                  persistent-hint
                  :class='cfg.value.hint ? "mb-2" : ""'
                  @update:focused='selectStoredSecret($event, cfg.value)'
                  )
              v-divider.mt-3
              .text-label-small.my-5 {{$t('admin:storage.syncDirection')}}
              .text-body-medium.ml-3 {{$t('admin:storage.syncDirectionSubtitle')}}
              .pr-3.pt-3
                v-radio-group.ml-3.py-0(v-model='target.mode')
                  v-radio(
                    :label='$t(`admin:storage.syncDirBi`)'
                    color='primary'
                    value='sync'
                    :disabled='target.supportedModes.indexOf(`sync`) < 0'
                  )
                  v-radio(
                    :label='$t(`admin:storage.syncDirPush`)'
                    color='primary'
                    value='push'
                    :disabled='target.supportedModes.indexOf(`push`) < 0'
                  )
                  v-radio(
                    :label='$t(`admin:storage.syncDirPull`)'
                    color='primary'
                    value='pull'
                    :disabled='target.supportedModes.indexOf(`pull`) < 0'
                  )
              .text-body-medium.ml-3
                strong {{$t('admin:storage.syncDirBi')}} #[em.text-red-lighten-2(v-if='target.supportedModes.indexOf(`sync`) < 0') {{$t('admin:storage.unsupported')}}]
                .pb-3 {{$t('admin:storage.syncDirBiHint')}}
                strong {{$t('admin:storage.syncDirPush')}} #[em.text-red-lighten-2(v-if='target.supportedModes.indexOf(`push`) < 0') {{$t('admin:storage.unsupported')}}]
                .pb-3 {{$t('admin:storage.syncDirPushHint')}}
                strong {{$t('admin:storage.syncDirPull')}} #[em.text-red-lighten-2(v-if='target.supportedModes.indexOf(`pull`) < 0') {{$t('admin:storage.unsupported')}}]
                .pb-3 {{$t('admin:storage.syncDirPullHint')}}

              template(v-if='target.hasSchedule')
                v-divider.mt-3
                .text-label-small.my-5 {{$t('admin:storage.syncSchedule')}}
                .text-body-medium.ml-3 {{$t('admin:storage.syncScheduleHint')}}
                .pa-3
                  duration-picker(v-model='target.syncInterval')
                  i18next.text-body-small.mt-3(path='admin:storage.syncScheduleCurrent', tag='div')
                    strong(place='schedule') {{getDefaultSchedule(target.syncInterval)}}
                  i18next.text-body-small(path='admin:storage.syncScheduleDefault', tag='div')
                    strong(place='schedule') {{getDefaultSchedule(target.syncIntervalDefault)}}

              template(v-if='target.actions && target.actions.length > 0')
                v-divider.mt-3
                .text-label-small.my-5 {{$t('admin:storage.actions')}}
                v-alert(v-if='!target.isEnabled', variant="outlined", color='warning', icon='mdi-alert')
                  .text-body-medium {{$t('admin:storage.actionsInactiveWarn')}}
                v-container.pt-0(fluid)
                  v-row(class='fill-height')
                    v-col(cols='12', lg='6', xl='4', v-for='act of target.actions', :key='act.handler')
                      v-card.radius-7(flat, :class='$vuetify.theme.current.dark ? `bg-grey-darken-3` : `bg-grey-lighten-3`', height='100%')
                        v-card-text
                          .text-body-large {{act.label}}
                          .text-body-medium.mt-4 {{act.hint}}
                          v-btn.mx-0.mt-5(
                            @click='executeAction(target.key, act.handler)'
                            variant="outlined"
                            :color='$vuetify.theme.current.dark ? `primary` : `primary`'
                            :disabled='runningAction || !target.isEnabled'
                            :loading='runningActionHandler === act.handler'
                            ) {{$t('admin:storage.actionRun')}}
</template>

<script lang='ts'>
import _ from 'lodash'
import moment from 'moment'
import momentDurationFormatSetup from 'moment-duration-format'

import DurationPicker from '../common/duration-picker.vue'
import { LoopingRhombusesSpinner } from 'epic-spinners'
import { wikiStore } from '@/store/index.ts'
import { loadingStart, loadingStop, pushGraphError, showNotification, setLoading } from '../../helpers/root-ui-store'
import { executeStorageAction, fetchStorageStatus, fetchStorageTargets, saveStorageTargets } from '../../helpers/storage-api'
import type {
  StorageConfigEntry,
  StorageInterval,
  StorageStatus,
  StorageTarget,
  StorageTargetUpdate
} from '../../helpers/storage-api'

momentDurationFormatSetup(moment)

type StorageConfigValue = {
  enum?: unknown[]
  hint?: string
  multiline?: boolean
  order?: number
  title?: string
  sensitive?: boolean
  type: string
  value: unknown
}

type NormalizedStorageConfig = {
  key: string
  value: StorageConfigValue
  [key: string]: unknown
}

type NormalizedStorageTarget = Omit<StorageTarget, 'config'> & {
  config: NormalizedStorageConfig[]
}

const makeDefaultStorageTarget = (): NormalizedStorageTarget => ({
  actions: [],
  config: [],
  description: '',
  hasSchedule: false,
  isAvailable: false,
  isEnabled: false,
  key: '',
  logo: '',
  mode: '',
  supportedModes: [],
  syncInterval: '',
  syncIntervalDefault: null,
  title: '',
  website: ''
})

export default {
  components: {
    DurationPicker,
    LoopingRhombusesSpinner
  },
  data() {
    return {
      runningAction: false,
      runningActionHandler: '',
      selectedTarget: '',
      target: makeDefaultStorageTarget(),
      targets: [] as NormalizedStorageTarget[],
      status: [] as StorageStatus[],
      statusRefreshing: false,
      statusRefreshInterval: null as ReturnType<typeof setInterval> | null
    }
  },
  computed: {
    activeTargets() {
      return _.filter(this.targets, 'isEnabled')
    }
  },
  watch: {
    selectedTarget(newValue: string) {
      this.target = _.find(this.targets, ['key', newValue]) || makeDefaultStorageTarget()
    },
    targets() {
      this.selectedTarget = _.get(_.find(this.targets, ['isEnabled', true]), 'key', 'disk')
    }
  },
  mounted() {
    this.loadTargets()
    this.loadStatus()
    this.statusRefreshInterval = setInterval(() => {
      this.loadStatus()
    }, 3000)
  },
  beforeUnmount() {
    if (this.statusRefreshInterval) {
      clearInterval(this.statusRefreshInterval)
      this.statusRefreshInterval = null
    }
  },
  methods: {
    setTargetEnabled(target: NormalizedStorageTarget, value: boolean) {
      if (target.key === 'local' && target.isEnabled && !value) return
      target.isEnabled = value
    },
    statusLabel(status: string) {
      return {
        pending: 'Synchronizing',
        operational: 'Operational',
        warning: 'Warning',
        error: 'Error'
      }[status] || 'Unknown'
    },
    normalizeTargets(targets: StorageTarget[]): NormalizedStorageTarget[] {
      return _.cloneDeep(targets).map(target => ({
        ...target,
        config: _.sortBy(target.config.map(config => ({
          ...config,
          value: JSON.parse(config.value) as StorageConfigValue
        })), [config => config.value.order])
      }))
    },
    storageTargetsPayload(): StorageTargetUpdate[] {
      return this.targets.map(target => ({
        isEnabled: target.isEnabled,
        key: target.key,
        config: target.config.map((config): StorageConfigEntry => ({
          ...config,
          value: JSON.stringify({ v: config.value.value })
        })),
        mode: target.mode,
        syncInterval: target.syncInterval
      }))
    },
    selectStoredSecret(focused: boolean, config: StorageConfigValue) {
      if (!focused || !config.sensitive || config.value !== '********') return
      requestAnimationFrame(() => {
        const input = document.activeElement
        if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
          input.select()
        }
      })
    },
    async loadTargets() {
      setLoading(wikiStore, 'admin-storage-targets-refresh', true)
      try {
        this.targets = this.normalizeTargets(await fetchStorageTargets(window.fetch.bind(window)))
      } catch (err) {
        pushGraphError(wikiStore, err)
      } finally {
        setLoading(wikiStore, 'admin-storage-targets-refresh', false)
      }
    },
    async loadStatus() {
      this.statusRefreshing = true
      setLoading(wikiStore, 'admin-storage-status-refresh', true)
      try {
        this.status = await fetchStorageStatus(window.fetch.bind(window))
      } catch (err) {
        pushGraphError(wikiStore, err)
      } finally {
        this.statusRefreshing = false
        setLoading(wikiStore, 'admin-storage-status-refresh', false)
      }
    },
    async refresh() {
      await this.loadTargets()
      showNotification(wikiStore, {
        message: 'List of storage targets has been refreshed.',
        style: 'success',
        icon: 'cached'
      })
    },
    async save() {
      loadingStart(wikiStore, 'admin-storage-savetargets')
      try {
        await saveStorageTargets(window.fetch.bind(window), this.storageTargetsPayload())
        showNotification(wikiStore, {
          message: 'Storage configuration saved successfully.',
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        pushGraphError(wikiStore, err)
      } finally {
        loadingStop(wikiStore, 'admin-storage-savetargets')
      }
    },
    getDefaultSchedule(val: StorageInterval | undefined) {
      if (!val) { return 'N/A' }
      return moment.duration(val).format('y [years], M [months], d [days], h [hours], m [minutes]')
    },
    async executeAction(targetKey: string, handler: string) {
      loadingStart(wikiStore, 'admin-storage-executeaction')
      this.runningAction = true
      this.runningActionHandler = handler
      try {
        const result = await executeStorageAction(window.fetch.bind(window), targetKey, handler)
        showNotification(wikiStore, {
          message: result.message || 'Action completed.',
          style: 'success',
          icon: 'check'
        })
        await this.loadStatus()
      } catch (err) {
        pushGraphError(wikiStore, err)
      } finally {
        this.runningAction = false
        this.runningActionHandler = ''
        loadingStop(wikiStore, 'admin-storage-executeaction')
      }
    }
  }
}
</script>

<style lang='scss' scoped>

.targetlogo {
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
