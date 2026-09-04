<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        admin-hero(
          :title='$t(`admin:storage.title`)'
          :description='$t(`admin:storage.subtitle`)'
          icon='/_assets/svg/icon-cloud-storage.svg'
        )
          template(v-slot:actions)
            v-tooltip(location='top')
              template(v-slot:activator='{ props }')
                v-btn.animated.fadeInDown.wait-p3s(icon, variant="outlined", color='grey', href='https://docs.requarks.io/storage', target='_blank', rel='noopener noreferrer', v-bind='props', aria-label='Storage documentation — opens in a new tab')
                  v-icon mdi-help-circle
              span Storage documentation — opens in a new tab
            v-tooltip(location='top')
              template(v-slot:activator='{ props }')
                v-btn.mx-3.animated.fadeInDown.wait-p2s(icon, variant="outlined", color='grey', @click='refresh', :loading='targetsLoading', :disabled='targetsLoading || saving || runningAction', v-bind='props', aria-label='Refresh storage targets')
                  v-icon mdi-refresh
              span Refresh storage targets
            v-btn.animated.fadeInDown(color='success', @click='save', variant="flat", size="large", :loading='saving', :disabled='saving || targetsLoading || runningAction')
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
                :aria-current='selectedTarget === tgt.key ? "true" : undefined'
                @click='selectedTarget = tgt.key'
                :disabled='!tgt.isAvailable'
              )
                template(v-slot:prepend)
                  v-checkbox-btn(
                    :model-value='tgt.isEnabled'
                    :disabled='saving || targetsLoading || !tgt.isAvailable || (tgt.key === `local` && tgt.isEnabled)'
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
                          v-btn(icon='mdi-information', :color='tgt.status === `warning` ? `warning` : `error`', v-bind='mergeProps(props, tooltipProps)', :aria-label='`View ${tgt.title} ${statusLabel(tgt.status).toLowerCase()} details`')
                        span View {{tgt.title}} {{statusLabel(tgt.status).toLowerCase()}} details
                    v-card(width='450', max-width='calc(100vw - 32px)')
                      v-toolbar(flat, :color='tgt.status === `warning` ? `warning` : `error`', density="compact") {{$t('admin:storage.errorMsg')}}
                      v-card-text(style='overflow-wrap:anywhere; white-space:pre-wrap;') {{tgt.message}}

              v-divider(v-if='n < status.length - 1')
            v-list-item(v-if='status.length < 1')
              em {{$t('admin:storage.noTarget')}}

      v-col(cols='12', lg='9')
        v-card.mb-3.animated.fadeInUp.wait-p1s.operations-ledger(aria-live='polite')
          v-toolbar(flat, color='grey-darken-3', density='compact')
            v-icon.me-2(aria-hidden='true') mdi-clipboard-text-clock-outline
            .text-body-large Latest storage operation
          v-card-text(v-if='lastOperation')
            .d-flex.flex-wrap.align-center.ga-2.mb-4
              v-chip(
                :color='operationOutcomeColor(lastOperation.outcome)'
                :prepend-icon='operationOutcomeIcon(lastOperation.outcome)'
                label
              ) {{ operationOutcomeLabel(lastOperation.outcome) }}
              v-chip(variant='outlined', label) Terminal · {{ actionLabel(lastOperation.handler) }}
              span.text-body-small.text-medium-emphasis {{ lastOperation.targetKey }}
            v-alert(
              :type='operationOutcomeAlertType(lastOperation.outcome)'
              variant='tonal'
              :title='lastOperation.message'
            )
              .text-body-small(v-if='lastOperation.outcome === `partial`') Some items completed, but failed or conflicted items still require attention.
              .text-body-small(v-else-if='lastOperation.outcome === `failed`') The operation did not complete successfully. Review the paths and diagnostics below.
            v-row.mt-3
              v-col(cols='6', sm='4')
                .text-label-small.text-medium-emphasis Total
                .text-title-large {{ lastOperation.total }}
              v-col(cols='6', sm='4')
                .text-label-small.text-medium-emphasis Succeeded
                .text-title-large.text-success {{ lastOperation.succeeded }}
              v-col(cols='6', sm='4')
                .text-label-small.text-medium-emphasis Failed
                .text-title-large(:class='lastOperation.failed ? `text-error` : `text-medium-emphasis`') {{ lastOperation.failed }}
            v-divider.my-4
            .text-label-small.text-medium-emphasis.mb-2 Document formats
            .d-flex.flex-wrap.ga-2
              v-chip(v-for='format in operationFormatRows', :key='format.key', size='small', variant='outlined', label)
                span {{ format.label }}
                strong.ms-2 {{ format.count }}
            v-divider.my-4
            v-row
              v-col(cols='12', sm='6')
                .text-label-small.text-medium-emphasis Started
                time.text-body-medium(:datetime='lastOperation.startedAt') {{ formatOperationTime(lastOperation.startedAt) }}
              v-col(cols='12', sm='6')
                .text-label-small.text-medium-emphasis Completed
                time.text-body-medium(:datetime='lastOperation.completedAt') {{ formatOperationTime(lastOperation.completedAt) }}
            template(v-if='operationIssues.length')
              v-divider.my-4
              .text-title-small.mb-2 Failures, conflicts, and diagnostics
              v-list.operations-ledger-issues(lines='three', density='compact')
                v-list-item(v-for='item in operationIssues', :key='`${item.kind}:${item.path}`')
                  v-list-item-title.operations-ledger-path {{ item.path }}
                  v-list-item-subtitle
                    .d-flex.flex-wrap.ga-2.my-1
                      v-chip(size='x-small', :color='item.outcome === `conflict` ? `warning` : `error`', label) {{ actionLabel(item.outcome) }}
                      v-chip(v-if='item.format', size='x-small', variant='outlined', label) {{ formatLabel(item.format) }}
                      v-chip(size='x-small', variant='outlined', label) {{ item.kind }}
                    .text-body-small(v-if='item.message') {{ item.message }}
                    ul.operations-ledger-diagnostics(v-if='item.diagnostics.length')
                      li(v-for='diagnostic in item.diagnostics', :key='diagnostic') {{ diagnostic }}
          v-card-text.text-medium-emphasis(v-else)
            .text-title-small No storage operation has been reported
            .text-body-medium.mt-1 Run a storage action or wait for status polling to report the latest terminal operation.

        v-card.wiki-form.animated.fadeInUp.wait-p2s
          v-toolbar(color='primary', density="compact", flat)
            .text-body-large {{target.title}}
            v-spacer
            v-switch(
              color="blue-lighten-5"
              label='Active'
              v-model='target.isEnabled'
              :disabled='saving || targetsLoading || !target.isAvailable || (target.key === `local` && target.isEnabled)'
              hide-details
              inset
              )
          div.v-card-info(color='info')
            div
              div {{target.description}}
              span.text-body-small.provider-url: a(:href='target.website', target='_blank', rel='noopener noreferrer', :aria-label='`${target.title} website — opens in a new tab`') {{target.website}}
            v-spacer
            .admin-providerlogo
              img(:src='target.logo', :alt='target.title')
          v-card-text
            v-form(:disabled='saving || targetsLoading')
              i18next.text-body-medium(path='admin:storage.targetState', tag='div', v-if='target.isEnabled')
                v-chip(color='success', size="small", label, place='state') {{$t('admin:storage.targetStateActive')}}
              i18next.text-body-medium(path='admin:storage.targetState', tag='div', v-else)
                v-chip(color='error', size="small", label, place='state') {{$t('admin:storage.targetStateInactive')}}
              v-divider.mt-3
              .text-label-small.my-5 {{$t('admin:storage.targetConfig')}}
              .text-body-medium.ml-3(v-if='!target.config || target.config.length < 1'): em {{$t('admin:storage.noConfigOption')}}
              template(v-else)
                template(v-for='cfg in target.config', :key='cfg.key')
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
                    :model-value='cfg.value.sensitive && !isSecretVisible(cfg.key) ? (cfg.value.value ? `********` : ``) : cfg.value.value'
                    @update:model-value='cfg.value.value = $event'
                    prepend-icon='mdi-cog-box'
                    :hint='cfg.value.hint ? cfg.value.hint : ""'
                    persistent-hint
                    :class='cfg.value.hint ? "mb-2" : ""'
                    :readonly='cfg.value.sensitive && !isSecretVisible(cfg.key)'
                    :autocomplete='cfg.value.sensitive ? `new-password` : undefined'
                    @update:focused='selectStoredSecret($event, cfg.value)'
                  )
                    template(v-slot:append-inner)
                      v-btn(
                        v-if='cfg.value.sensitive'
                        icon
                        variant='text'
                        size='small'
                        :aria-label='`${isSecretVisible(cfg.key) ? "Hide" : "Show"} ${cfg.value.title || cfg.key}`'
                        @click='toggleSecretVisibility(cfg.key)'
                      )
                        v-icon {{ isSecretVisible(cfg.key) ? 'mdi-eye-off' : 'mdi-eye' }}
                  v-text-field(
                    v-else
                    variant="outlined"
                    :label='cfg.value.title'
                    v-model='cfg.value.value'
                    prepend-icon='mdi-cog-box'
                    :hint='cfg.value.hint ? cfg.value.hint : ""'
                    persistent-hint
                    :type='cfg.value.sensitive && !isSecretVisible(cfg.key) ? `password` : `text`'
                    :autocomplete='cfg.value.sensitive ? `new-password` : undefined'
                    :class='cfg.value.hint ? "mb-2" : ""'
                    @update:focused='selectStoredSecret($event, cfg.value)'
                  )
                    template(v-slot:append-inner)
                      v-btn(
                        v-if='cfg.value.sensitive'
                        icon
                        variant='text'
                        size='small'
                        :aria-label='`${isSecretVisible(cfg.key) ? "Hide" : "Show"} ${cfg.value.title || cfg.key}`'
                        @click='toggleSecretVisibility(cfg.key)'
                      )
                        v-icon {{ isSecretVisible(cfg.key) ? 'mdi-eye-off' : 'mdi-eye' }}
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
                v-alert.mb-4(type='info', variant='tonal', icon='mdi-file-document-refresh-outline')
                  .text-title-small Storage document policy
                  .text-body-small.mt-1 Ingress normalizes records in the database while leaving source bytes unchanged. Explicit egress writes canonical OKF documents to the configured target. Utility projection is optional and separate; storage actions never invoke it.
                v-alert(v-if='!target.isEnabled', variant="outlined", color='warning', icon='mdi-alert')
                  .text-body-medium {{$t('admin:storage.actionsInactiveWarn')}}
                v-container.pt-0(fluid)
                  v-row(class='fill-height')
                    v-col(cols='12', lg='6', xl='4', v-for='act of target.actions', :key='act.handler')
                      v-card.radius-7.bg-surface-variant(flat, height='100%')
                        v-card-text
                          .text-body-large {{act.label}}
                          .text-body-medium.mt-4 {{act.hint}}
                          v-btn.mx-0.mt-5(
                            @click='requestAction(target.key, act)'
                            variant='outlined'
                            color='primary'
                            :disabled='runningAction || saving || targetsLoading || !target.isEnabled'
                            :loading='runningActionHandler === act.handler'
                            ) {{$t('admin:storage.actionRun')}}
        v-dialog(v-model='isActionConfirmationShown', persistent, max-width='520', aria-labelledby='storage-action-confirm-title')
          v-card
            v-card-title#storage-action-confirm-title Confirm storage operation
            v-card-text
              .text-title-small {{ pendingAction ? pendingAction.label : '' }}
              .text-body-medium.mt-2 {{ pendingAction ? pendingAction.hint : '' }}
              v-alert.mt-4(
                :type='actionConfirmationAlertType'
                variant='tonal'
                :title='actionConfirmationTitle'
              ) {{ actionConfirmationCopy }}
              .text-body-small.text-medium-emphasis.mt-4 Utility projection remains an optional, separate operation. Confirming here will not invoke any utility.
            v-card-actions
              v-spacer
              v-btn(variant='text', @click='cancelActionConfirmation', :disabled='runningAction') Cancel
              v-btn(
                :color='actionConfirmationColor'
                variant='flat'
                @click='confirmAction'
                :loading='runningAction'
                :disabled='runningAction'
              ) {{ actionConfirmationButton }}
</template>

<script lang='ts'>
import { mergeProps } from 'vue'
import moment from 'moment'
import momentDurationFormatSetup from 'moment-duration-format'

import DurationPicker from '../common/duration-picker.vue'
import { LoopingRhombusesSpinner } from 'epic-spinners'
import { wikiStore } from '@/store/index.ts'
import { loadingStart, loadingStop, pushGraphError, showNotification, setLoading } from '../../helpers/root-ui-store'
import { executeStorageAction, fetchStorageStatus, fetchStorageTargets, saveStorageTargets } from '../../helpers/storage-api'
import type {
  StorageAction,
  StorageActionFormat,
  StorageActionItem,
  StorageActionOutcome,
  StorageActionSummary,
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

type PendingStorageAction = Pick<StorageAction, 'handler' | 'hint' | 'label'> & {
  targetKey: string
}

const STORAGE_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: 'Synchronizing',
  operational: 'Operational',
  warning: 'Warning',
  error: 'Error'
}

const STORAGE_FORMAT_LABELS = {
  okf: 'OKF',
  legacyV1: 'Legacy v1',
  legacyWiki: 'Legacy Wiki',
  plain: 'Plain Markdown',
  invalid: 'Invalid'
} satisfies Record<StorageActionFormat, string>

const STORAGE_OUTCOME_PRESENTATION = {
  succeeded: {
    label: 'Succeeded',
    color: 'success',
    icon: 'mdi-check-circle-outline',
    notificationIcon: 'check'
  },
  partial: {
    label: 'Partial',
    color: 'warning',
    icon: 'mdi-alert-outline',
    notificationIcon: 'alert'
  },
  failed: {
    label: 'Failed',
    color: 'error',
    icon: 'mdi-close-circle-outline',
    notificationIcon: 'alert'
  }
} as const satisfies Record<StorageActionOutcome, {
  label: string
  color: 'success' | 'warning' | 'error'
  icon: string
  notificationIcon: string
}>

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
      isActionConfirmationShown: false,
      lastOperation: null as StorageActionSummary | null,
      pendingAction: null as PendingStorageAction | null,
      runningAction: false,
      runningActionHandler: '',
      selectedTarget: '',
      target: makeDefaultStorageTarget(),
      targets: [] as NormalizedStorageTarget[],
      status: [] as StorageStatus[],
      saving: false,
      statusRefreshing: false,
      statusRefreshInterval: null as ReturnType<typeof setInterval> | null,
      visibleSecretFields: [] as string[],
      targetsLoading: false
    }
  },
  computed: {
    operationFormatRows(): Array<{ key: StorageActionFormat, label: string, count: number }> {
      if (!this.lastOperation) return []
      return (['okf', 'legacyV1', 'legacyWiki', 'plain', 'invalid'] as StorageActionFormat[]).map(key => ({
        key,
        label: this.formatLabel(key),
        count: this.lastOperation!.formats[key]
      }))
    },
    operationIssues(): StorageActionItem[] {
      if (!this.lastOperation) return []
      return this.lastOperation.items.filter(item =>
        item.outcome !== 'succeeded' || Boolean(item.message) || item.diagnostics.length > 0
      )
    },
    actionConfirmationTitle(): string {
      if (!this.pendingAction) return ''
      if (this.isIngressAction(this.pendingAction.handler)) return 'Import into the database'
      if (this.isPurgeAction(this.pendingAction.handler)) return 'Destructive removal'
      return 'Write to the configured storage target'
    },
    actionConfirmationCopy(): string {
      if (!this.pendingAction) return ''
      if (this.isIngressAction(this.pendingAction.handler)) {
        return 'Ingress normalizes imported records in the database. The source document bytes remain unchanged.'
      }
      if (this.isPurgeAction(this.pendingAction.handler)) {
        return 'This operation can permanently remove stored content. Review the configured target and backup policy before continuing.'
      }
      return 'This is explicit egress. It writes canonical OKF documents to the configured target and may replace existing target files.'
    },
    actionConfirmationAlertType(): 'warning' | 'error' {
      return this.pendingAction && this.isPurgeAction(this.pendingAction.handler) ? 'error' : 'warning'
    },
    actionConfirmationColor(): 'warning' | 'error' {
      return this.actionConfirmationAlertType
    },
    actionConfirmationButton(): string {
      if (!this.pendingAction) return 'Run operation'
      return this.isPurgeAction(this.pendingAction.handler) ? 'Confirm removal' : 'Run operation'
    }
  },
  watch: {
    selectedTarget(newValue: string) {
      this.target = this.targets.find(target => target.key === newValue) || makeDefaultStorageTarget()
      this.visibleSecretFields = []
    },
    targets(targets: NormalizedStorageTarget[]) {
      const nextTarget = targets.find(target => target.key === this.selectedTarget && target.isAvailable) ||
        targets.find(target => target.isEnabled && target.isAvailable) ||
        targets.find(target => target.isAvailable) ||
        targets[0]
      this.selectedTarget = nextTarget?.key || ''
      this.target = nextTarget || makeDefaultStorageTarget()
      this.visibleSecretFields = []
    }
  },
  mounted() {
    this.loadTargets()
    this.loadStatus()
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    this.statusRefreshInterval = setInterval(() => {
      if (!document.hidden) {
        this.loadStatus()
      }
    }, 3000)
  },
  beforeUnmount() {
    if (this.statusRefreshInterval) {
      clearInterval(this.statusRefreshInterval)
      this.statusRefreshInterval = null
    }
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
  },
  methods: {
    mergeProps,
    handleVisibilityChange() {
      if (!document.hidden) {
        this.loadStatus()
      }
    },
    secretFieldKey(configKey: string): string {
      return `${this.target.key}:${configKey}`
    },
    isSecretVisible(configKey: string): boolean {
      return this.visibleSecretFields.includes(this.secretFieldKey(configKey))
    },
    toggleSecretVisibility(configKey: string) {
      const key = this.secretFieldKey(configKey)
      this.visibleSecretFields = this.visibleSecretFields.includes(key)
        ? this.visibleSecretFields.filter(item => item !== key)
        : [...this.visibleSecretFields, key]
    },
    setTargetEnabled(target: NormalizedStorageTarget, value: boolean) {
      if (target.key === 'local' && target.isEnabled && !value) return
      target.isEnabled = value
    },
    statusLabel(status: string) {
      return STORAGE_STATUS_LABELS[status] || 'Unknown'
    },
    normalizeTargets(targets: StorageTarget[]): NormalizedStorageTarget[] {
      return targets.map(target => ({
        ...target,
        config: target.config
          .map(config => ({
            ...config,
            value: JSON.parse(config.value) as StorageConfigValue
          }))
          .sort((left, right) => (left.value.order ?? Number.POSITIVE_INFINITY) - (right.value.order ?? Number.POSITIVE_INFINITY))
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
    async loadTargets(): Promise<boolean> {
      if (this.targetsLoading) return false
      this.targetsLoading = true
      setLoading(wikiStore, 'admin-storage-targets-refresh', true)
      try {
        this.targets = this.normalizeTargets(await fetchStorageTargets(window.fetch.bind(window)))
        return true
      } catch (err) {
        pushGraphError(wikiStore, err)
        return false
      } finally {
        this.targetsLoading = false
        setLoading(wikiStore, 'admin-storage-targets-refresh', false)
      }
    },
    async loadStatus() {
      if (this.statusRefreshing) return
      this.statusRefreshing = true
      setLoading(wikiStore, 'admin-storage-status-refresh', true)
      try {
        const status = await fetchStorageStatus(window.fetch.bind(window))
        this.status = status
        const latestOperation = status.reduce<StorageActionSummary | null>((latest, entry) => {
          if (!entry.lastOperation) return latest
          return !latest || entry.lastOperation.completedAt > latest.completedAt ? entry.lastOperation : latest
        }, null)
        if (latestOperation && (!this.lastOperation || latestOperation.completedAt >= this.lastOperation.completedAt)) {
          this.lastOperation = latestOperation
        }
      } catch (err) {
        pushGraphError(wikiStore, err)
      } finally {
        this.statusRefreshing = false
        setLoading(wikiStore, 'admin-storage-status-refresh', false)
      }
    },
    async refresh() {
      if (this.saving || this.runningAction) return
      if (!await this.loadTargets()) return
      showNotification(wikiStore, {
        message: 'List of storage targets has been refreshed.',
        style: 'success',
        icon: 'cached'
      })
    },
    async save() {
      if (this.saving || this.targetsLoading || this.runningAction) return
      this.saving = true
      loadingStart(wikiStore, 'admin-storage-savetargets')
      try {
        await saveStorageTargets(window.fetch.bind(window), this.storageTargetsPayload())
        this.visibleSecretFields = []
        showNotification(wikiStore, {
          message: 'Storage configuration saved successfully.',
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        pushGraphError(wikiStore, err)
      } finally {
        this.saving = false
        loadingStop(wikiStore, 'admin-storage-savetargets')
      }
    },
    getDefaultSchedule(val: StorageInterval | undefined) {
      if (!val) { return 'N/A' }
      return moment.duration(val).format('y [years], M [months], d [days], h [hours], m [minutes]')
    },
    actionLabel(value: string): string {
      const words = value
        .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
        .replace(/[_-]+/gu, ' ')
        .trim()
      return words ? words.replace(/\b\w/gu, letter => letter.toUpperCase()) : 'Unknown'
    },
    formatLabel(format: StorageActionFormat): string {
      return STORAGE_FORMAT_LABELS[format]
    },
    formatOperationTime(value: string): string {
      return moment.utc(value).format('YYYY-MM-DD HH:mm:ss [UTC]')
    },
    operationOutcomeLabel(outcome: StorageActionOutcome): string {
      return STORAGE_OUTCOME_PRESENTATION[outcome].label
    },
    operationOutcomeColor(outcome: StorageActionOutcome): 'success' | 'warning' | 'error' {
      return STORAGE_OUTCOME_PRESENTATION[outcome].color
    },
    operationOutcomeAlertType(outcome: StorageActionOutcome): 'success' | 'warning' | 'error' {
      return STORAGE_OUTCOME_PRESENTATION[outcome].color
    },
    operationOutcomeIcon(outcome: StorageActionOutcome): string {
      return STORAGE_OUTCOME_PRESENTATION[outcome].icon
    },
    isIngressAction(handler: string): boolean {
      return /import|restore|ingress/iu.test(handler)
    },
    isPurgeAction(handler: string): boolean {
      return /purge|delete|remove/iu.test(handler)
    },
    requiresActionConfirmation(handler: string): boolean {
      return /import|restore|export|dump|backup|syncUntracked|purge|delete|remove|migrate/iu.test(handler)
    },
    async requestAction(targetKey: string, action: StorageAction) {
      if (this.saving || this.targetsLoading || this.runningAction) return
      if (this.requiresActionConfirmation(action.handler)) {
        this.pendingAction = { targetKey, handler: action.handler, label: action.label, hint: action.hint }
        this.isActionConfirmationShown = true
        return
      }
      await this.executeAction(targetKey, action.handler)
    },
    cancelActionConfirmation() {
      if (this.runningAction) return
      this.isActionConfirmationShown = false
      this.pendingAction = null
    },
    async confirmAction() {
      if (!this.pendingAction || this.saving || this.targetsLoading || this.runningAction) return
      const { targetKey, handler } = this.pendingAction
      await this.executeAction(targetKey, handler)
      this.isActionConfirmationShown = false
      this.pendingAction = null
    },
    async executeAction(targetKey: string, handler: string) {
      if (this.saving || this.targetsLoading || this.runningAction) return
      loadingStart(wikiStore, 'admin-storage-executeaction')
      this.runningAction = true
      this.runningActionHandler = handler
      try {
        const result = await executeStorageAction(window.fetch.bind(window), targetKey, handler)
        this.lastOperation = result
        const presentation = STORAGE_OUTCOME_PRESENTATION[result.outcome]
        showNotification(wikiStore, {
          message: result.message,
          style: presentation.color,
          icon: presentation.notificationIcon
        })
      } catch (err) {
        pushGraphError(wikiStore, err)
      } finally {
        await this.loadStatus()
        this.runningAction = false
        this.runningActionHandler = ''
        loadingStop(wikiStore, 'admin-storage-executeaction')
      }
    }
  }
}
</script>

<style lang='scss' scoped>

.operations-ledger-path,
.operations-ledger-diagnostics {
  overflow-wrap: anywhere;
  white-space: normal;
}

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
