<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-row()
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-cloud-storage.svg', alt='Storage', style='width: 80px;')
          .admin-header-title
            .headline.primary--text.animated.fadeInLeft {{$t('admin:storage.title')}}
            .subtitle-1.grey--text.animated.fadeInLeft.wait-p4s {{$t('admin:storage.subtitle')}}
          v-spacer
          v-btn.animated.fadeInDown.wait-p3s(icon, outlined, color='grey', href='https://docs.requarks.io/storage', target='_blank')
            v-icon mdi-help-circle
          v-btn.mx-3.animated.fadeInDown.wait-p2s(icon, outlined, color='grey', @click='refresh')
            v-icon mdi-refresh
          v-btn.animated.fadeInDown(color='success', @click='save', depressed, large)
            v-icon(left) mdi-check
            span {{$t('common:actions.apply')}}

      v-col(lg='3', cols='12')
        v-card.animated.fadeInUp
          v-toolbar(flat, color='primary', dark, dense)
            .subtitle-1 {{$t('admin:storage.targets')}}
          v-list(two-line, dense).py-0
            template(v-for='(tgt, idx) in targets', :key='tgt.key')
              v-list-item(@click='selectedTarget = tgt.key', :disabled='!tgt.isAvailable')
                v-avatar(size='24')
                  v-icon(color='grey', v-if='!tgt.isAvailable') mdi-minus-box-outline
                  v-icon(color='primary', v-else-if='tgt.isEnabled', v-ripple, @click='tgt.key !== `local` && (tgt.isEnabled = false)') mdi-checkbox-marked-outline
                  v-icon(color='grey', v-else, v-ripple, @click='tgt.isEnabled = true') mdi-checkbox-blank-outline
                div.v-list-item-content
                  v-list-item-title.body-2(:class='!tgt.isAvailable ? `grey--text` : (selectedTarget === tgt.key ? `primary--text` : ``)') {{ tgt.title }}
                  v-list-item-subtitle: .caption(:class='!tgt.isAvailable ? `grey--text text--lighten-1` : (selectedTarget === tgt.key ? `blue--text ` : ``)') {{ tgt.description }}
                v-avatar(v-if='selectedTarget === tgt.key', size='24')
                  v-icon.animated.fadeInLeft(color='primary', large) mdi-chevron-right
              v-divider(v-if='idx < targets.length - 1')

        v-card.mt-3.animated.fadeInUp.wait-p2s
          v-toolbar(flat, :color='$vuetify.theme.current.dark ? `grey darken-3-l5` : `grey darken-3`', dark, dense)
            .subtitle-1 {{$t('admin:storage.status')}}
            v-spacer
            looping-rhombuses-spinner(
              :animation-duration='5000'
              :rhombus-size='10'
              color='#FFF'
            )
          v-list.py-0(two-line, dense)
            template(v-for='(tgt, n) in status', :key='tgt.key')
              v-list-item
                template(v-if='tgt.status === `pending`')
                  v-avatar(color='purple')
                    v-icon(color='white') mdi-clock-outline
                  div.v-list-item-content
                    v-list-item-title.body-2 {{tgt.title}}
                    v-list-item-subtitle.purple--text.caption {{tgt.status}}
                  div.v-list-item-action
                    v-progress-circular(indeterminate, :size='20', :width='2', color='purple', :aria-label='`Synchronizing ${tgt.title}`')
                template(v-else-if='tgt.status === `operational`')
                  v-avatar(color='green')
                    v-icon(color='white') mdi-check-circle
                  div.v-list-item-content
                    v-list-item-title.body-2 {{tgt.title}}
                    v-list-item-subtitle.green--text.caption {{$t('admin:storage.lastSync', { time: $helpers.formatMoment(tgt.lastAttempt, 'from') })}}
                template(v-else)
                  v-avatar(color='red')
                    v-icon(color='white') mdi-close-circle-outline
                  div.v-list-item-content
                    v-list-item-title.body-2 {{tgt.title}}
                    v-list-item-subtitle.red--text.caption {{$t('admin:storage.lastSyncAttempt', { time: $helpers.formatMoment(tgt.lastAttempt, 'from') })}}
                  div.v-list-item-action
                    v-menu
                      template(v-slot:activator='{ props }')
                        v-btn(icon, v-bind='props')
                          v-icon(color='red') mdi-information
                      v-card(width='450')
                        v-toolbar(flat, color='red', dark, dense) {{$t('admin:storage.errorMsg')}}
                        v-card-text {{tgt.message}}

              v-divider(v-if='n < status.length - 1')
            v-list-item(v-if='status.length < 1')
              em {{$t('admin:storage.noTarget')}}

      v-col(cols='12', lg='9')
        v-card.wiki-form.animated.fadeInUp.wait-p2s
          v-toolbar(color='primary', dense, flat, dark)
            .subtitle-1 {{target.title}}
            v-spacer
            v-switch(
              dark
              color='blue lighten-5'
              label='Active'
              v-model='target.isEnabled'
              hide-details
              inset
              )
          div.v-card-info(color='blue')
            div
              div {{target.description}}
              span.caption: a(:href='target.website') {{target.website}}
            v-spacer
            .admin-providerlogo
              img(:src='target.logo', :alt='target.title')
          v-card-text
            v-form
              i18next.body-2(path='admin:storage.targetState', tag='div', v-if='target.isEnabled')
                v-chip(color='green', small, dark, label, place='state') {{$t('admin:storage.targetStateActive')}}
              i18next.body-2(path='admin:storage.targetState', tag='div', v-else)
                v-chip(color='red', small, dark, label, place='state') {{$t('admin:storage.targetStateInactive')}}
              v-divider.mt-3
              .overline.my-5 {{$t('admin:storage.targetConfig')}}
              .body-2.ml-3(v-if='!target.config || target.config.length < 1'): em {{$t('admin:storage.noConfigOption')}}
              template(v-else, v-for='cfg in target.config', :key='cfg.key')
                v-select(
                  v-if='cfg.value.type === "string" && cfg.value.enum'
                  outlined
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
                  outlined
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
                  :label='cfg.value.title'
                  v-model='cfg.value.value'
                  prepend-icon='mdi-cog-box'
                  :hint='cfg.value.hint ? cfg.value.hint : ""'
                  persistent-hint
                  :class='cfg.value.hint ? "mb-2" : ""'
                  )
              v-divider.mt-3
              .overline.my-5 {{$t('admin:storage.syncDirection')}}
              .body-2.ml-3 {{$t('admin:storage.syncDirectionSubtitle')}}
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
              .body-2.ml-3
                strong {{$t('admin:storage.syncDirBi')}} #[em.red--text.text--lighten-2(v-if='target.supportedModes.indexOf(`sync`) < 0') {{$t('admin:storage.unsupported')}}]
                .pb-3 {{$t('admin:storage.syncDirBiHint')}}
                strong {{$t('admin:storage.syncDirPush')}} #[em.red--text.text--lighten-2(v-if='target.supportedModes.indexOf(`push`) < 0') {{$t('admin:storage.unsupported')}}]
                .pb-3 {{$t('admin:storage.syncDirPushHint')}}
                strong {{$t('admin:storage.syncDirPull')}} #[em.red--text.text--lighten-2(v-if='target.supportedModes.indexOf(`pull`) < 0') {{$t('admin:storage.unsupported')}}]
                .pb-3 {{$t('admin:storage.syncDirPullHint')}}

              template(v-if='target.hasSchedule')
                v-divider.mt-3
                .overline.my-5 {{$t('admin:storage.syncSchedule')}}
                .body-2.ml-3 {{$t('admin:storage.syncScheduleHint')}}
                .pa-3
                  duration-picker(v-model='target.syncInterval')
                  i18next.caption.mt-3(path='admin:storage.syncScheduleCurrent', tag='div')
                    strong(place='schedule') {{getDefaultSchedule(target.syncInterval)}}
                  i18next.caption(path='admin:storage.syncScheduleDefault', tag='div')
                    strong(place='schedule') {{getDefaultSchedule(target.syncIntervalDefault)}}

              template(v-if='target.actions && target.actions.length > 0')
                v-divider.mt-3
                .overline.my-5 {{$t('admin:storage.actions')}}
                v-alert(outlined, :value='!target.isEnabled', color='red', icon='mdi-alert')
                  .body-2 {{$t('admin:storage.actionsInactiveWarn')}}
                v-container.pt-0(grid-list-xl, fluid)
                  v-row(, class='fill-height')
                    v-col(cols='12', lg='6', xl='4', v-for='act of target.actions', :key='act.handler')
                      v-card.radius-7.grey(flat, :class='$vuetify.theme.current.dark ? `darken-3-d5` : `lighten-3`', height='100%')
                        v-card-text
                          .subtitle-1(v-html='act.label')
                          .body-2.mt-4(v-html='act.hint')
                          v-btn.mx-0.mt-5(
                            @click='executeAction(target.key, act.handler)'
                            outlined
                            :color='$vuetify.theme.current.dark ? `blue` : `primary`'
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
import { loadingStart, loadingStop, showNotification, setLoading } from '../../helpers/root-ui-store'
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
    async loadTargets() {
      setLoading(wikiStore, 'admin-storage-targets-refresh', true)
      try {
        this.targets = this.normalizeTargets(await fetchStorageTargets(window.fetch.bind(window)))
      } finally {
        setLoading(wikiStore, 'admin-storage-targets-refresh', false)
      }
    },
    async loadStatus() {
      setLoading(wikiStore, 'admin-storage-status-refresh', true)
      try {
        this.status = await fetchStorageStatus(window.fetch.bind(window))
      } finally {
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
      await saveStorageTargets(window.fetch.bind(window), this.storageTargetsPayload())
      showNotification(wikiStore, {
        message: 'Storage configuration saved successfully.',
        style: 'success',
        icon: 'check'
      })
      loadingStop(wikiStore, 'admin-storage-savetargets')
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
        await executeStorageAction(window.fetch.bind(window), targetKey, handler)
        showNotification(wikiStore, {
          message: 'Action completed.',
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        console.warn(err)
      }
      this.runningAction = false
      this.runningActionHandler = ''
      loadingStop(wikiStore, 'admin-storage-executeaction')
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
