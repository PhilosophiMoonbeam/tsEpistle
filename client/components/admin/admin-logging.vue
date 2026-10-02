<template>
  <v-container fluid class="logging-workspace">
    <div :inert="dialogOpen || undefined">
      <admin-hero
        :title="$t('admin:logging.title')"
        :description="$t('admin:logging.configureLogDeliveryTune')"
        icon="mdi-text-box-search-outline"
      >
        <template #actions>
          <v-btn variant="text" prepend-icon="mdi-refresh" :disabled="busy" @click="reload">{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ $t('admin:logging.reloadSavedLoggingSettings') }}</v-tooltip></v-btn>
          <v-btn v-if="dirty" variant="text" :disabled="busy" @click="askDiscard(reset)">{{ $t('admin:logging.resetDraft') }}</v-btn>
          <v-btn color="primary" :disabled="locked || !dirty || issues.length > 0" @click="openReview">{{ $t('admin:logging.reviewChanges') }}</v-btn>
        </template>
      </admin-hero>

      <async-state
        v-if="loading && !saved"
        state="loading"
        :title="$t('admin:logging.loadingLogging')"
        :message="$t('admin:logging.readingSavedDestinationsProcesss')"
      />
      <async-state
        v-else-if="error && !saved"
        state="error"
        :title="$t('admin:logging.loggingCouldNotLoaded')"
        :message="error"
        :retry-label="$t('admin:logging.tryAgain')"
        @retry="load"
      />
      <v-alert v-else-if="error" type="error" variant="tonal" class="mb-5">{{ error }}</v-alert>
      <v-alert v-if="notice" type="info" variant="tonal" class="mb-5" aria-live="polite">{{ notice }}</v-alert>
      <v-alert v-if="stale" type="warning" variant="tonal" class="mb-5">
        {{ $t('admin:logging.savedSettingsChangedAction') }}
      </v-alert>

      <template v-if="saved && consolePolicy">
        <div class="logging-state-line">
          <span>
            <i :class="{ 'is-draft': dirty }" />
            {{ dirty ? $t('admin:logging.unsavedLoggingDraft') : $t('admin:logging.showingSavedSettings') }}
          </span>
          <span>{{ $t('admin:logging.observed', { observedAt: dateTime(saved.observedAt), interpolation: { escapeValue: false } }) }}</span>
        </div>
        <nav class="logging-tabs" :aria-label="$t('admin:logging.loggingSections')">
          <button
            v-for="item in sections"
            :key="item.key"
            type="button"
            :aria-current="section === item.key ? 'page' : undefined"
            :disabled="busy"
            @click="selectSection(item.key)"
          >
            {{ item.title }}
          </button>
        </nav>

        <div class="logging-layout" :class="{ 'logging-layout-wide': section === 'trail' }">
          <section class="logging-main">
            <template v-if="section === 'destinations'">
              <header class="logging-heading">
                <span class="logging-kicker">{{ $t('admin:logging.n01IntentionalDelivery') }}</span>
                <h2>{{ $t('admin:logging.chooseWhereRecordsCan') }}</h2>
                <p>
                  {{ $t('admin:logging.onlyDestinationsActiveTransport') }}
                </p>
              </header>
              <section class="logging-panel logging-destination-layout">
                <aside class="logging-catalogue" :aria-label="$t('admin:logging.loggingDestinations')">
                  <v-text-field
                    v-model="catalogueQuery"
                    :label="$t('admin:logging.findDestination')"
                    prepend-inner-icon="mdi-magnify"
                    variant="outlined"
                    density="compact"
                    hide-details
                  />
                  <button
                    v-if="legacyDestinationCount"
                    type="button"
                    class="logging-legacy-toggle"
                    :aria-expanded="showLegacy"
                    :disabled="busy"
                    @click="showLegacy = !showLegacy"
                  >
                    {{ showLegacy ? $t('admin:logging.hideLegacyDestinations') : $t('admin:logging.showLegacyDestinations', { legacyDestinationCount, interpolation: { escapeValue: false } }) }}
                  </button>
                  <div v-if="filteredDestinations.length" class="logging-destination-list">
                    <button
                      v-for="destination in filteredDestinations"
                      :key="destination.key"
                      type="button"
                      :aria-current="destination.key === selectedDestinationKey ? 'page' : undefined"
                      :disabled="busy"
                      @click="selectDestination(destination.key)"
                    >
                      <span>
                        <strong>{{ destination.title }}</strong>
                        <small>
                          {{ destination.availability === 'available' ? $t('admin:logging.saved', { isEnabled: destination.isEnabled ? 'Enabled' : 'Disabled', interpolation: { escapeValue: false } }) : $t('admin:logging.unavailable') }}
                        </small>
                      </span>
                      <v-icon size="16" aria-hidden="true">mdi-chevron-right</v-icon>
                    </button>
                  </div>
                  <div v-else class="logging-empty">
                    <v-icon>mdi-magnify</v-icon>
                    <h3>{{ $t('admin:logging.noMatchingDestination') }}</h3>
                    <p>{{ $t('admin:logging.tryProviderNameClear') }}</p>
                  </div>
                </aside>
                <article v-if="selectedDestination && selectedDraft" class="logging-destination-detail">
                  <div class="logging-provider-head">
                    <v-icon class="logging-provider-icon" size="48" aria-hidden="true">mdi-domain</v-icon>
                    <div>
                      <span class="logging-kicker">
                        {{ selectedDestination.availability === 'available' ? $t('admin:logging.availableDestination') : $t('admin:logging.legacyDestination') }}
                      </span>
                      <h3>{{ selectedDestination.title }}</h3>
                      <p>{{ selectedDestination.description || $t('admin:logging.noProviderDescriptionAvailable') }}</p>
                      <a v-if="selectedDestination.website" :href="selectedDestination.website" target="_blank" rel="noopener noreferrer">
                        {{ $t('admin:logging.providerWebsite') }}
                        <span class="sr-only">{{ $t('admin:logging.opensNewTab') }}</span>
                        <v-icon size="14" aria-hidden="true">mdi-open-in-new</v-icon>
                      </a>
                    </div>
                  </div>
                  <v-alert :type="destinationRuntimeTone(selectedDestination.runtime.state)" variant="tonal" class="mt-5">
                    <strong class="mr-1">{{ $t('admin:logging.runtimeProcess', { state: destinationRuntimeLabel(selectedDestination.runtime.state), interpolation: { escapeValue: false } }) }}</strong>
                    <span v-if="selectedDestination.runtime.message">{{ selectedDestination.runtime.message }}</span>
                    <span v-else>{{ $t('admin:logging.savedPolicy', { isEnabled: selectedDestination.isEnabled ? 'enabled' : 'disabled', interpolation: { escapeValue: false } }) }}</span>
                  </v-alert>
                  <v-alert v-if="selectedDestination.availability === 'unavailable'" type="warning" variant="tonal" class="mt-5">
                    {{ $t('admin:logging.historicConfigurationRemainsUntouched', { availabilityReason: selectedDestination.availabilityReason, interpolation: { escapeValue: false } }) }}
                    <v-btn
                      v-if="selectedDraft.isEnabled"
                      class="mt-3"
                      color="warning"
                      variant="outlined"
                      :disabled="locked"
                      @click="selectedDraft.isEnabled = false"
                    >
                      {{ $t('admin:logging.disableUnsupportedDestination') }}
                    </v-btn>
                  </v-alert>
                  <template v-else>
                    <div class="logging-section-head mt-6">
                      <div>
                        <h4>{{ $t('admin:logging.deliveryPolicy') }}</h4>
                        <p>{{ $t('admin:logging.enableOnlyAfterRequired') }}</p>
                      </div>
                      <v-switch v-model="selectedDraft.isEnabled" :label="$t('admin:logging.destinationEnabled')" color="primary" inset hide-details :disabled="locked" />
                    </div>
                    <v-select
                      v-model="selectedDraft.level"
                      :items="levels"
                      :label="$t('admin:logging.minimumLevel2')"
                      variant="outlined"
                      :disabled="locked"
                      persistent-hint
                      :hint="$t('admin:logging.onlyRecordsSeverityAbove')"
                    />
                    <template v-for="field in selectedDestination.fields" :key="field.key">
                      <logging-secret-field
                        v-if="field.sensitive"
                        v-model="secretChanges[secretKey(selectedDestination.key, field.key)]"
                        :stored="selectedDestination.secrets[field.key] === true"
                        :label="field.title"
                        :hint="field.hint"
                        :disabled="locked"
                      />
                      <v-select
                        v-else-if="field.enum"
                        :model-value="enumConfigValue(selectedDraft, field.key)"
                        :items="field.enum"
                        :label="field.title"
                        :hint="field.hint || undefined"
                        persistent-hint
                        variant="outlined"
                        :disabled="locked"
                        @update:model-value="updateEnumConfig(selectedDraft, field.key, $event)"
                      />
                      <v-switch
                        v-else-if="field.type === 'boolean'"
                        :model-value="selectedDraft.config[field.key]"
                        :label="field.title"
                        :hint="field.hint || undefined"
                        persistent-hint
                        color="primary"
                        inset
                        :disabled="locked"
                        @update:model-value="updateConfig(selectedDraft, field.key, $event === true)"
                      />
                      <v-text-field
                        v-else
                        :model-value="selectedDraft.config[field.key]"
                        :label="field.title"
                        :hint="field.hint || undefined"
                        persistent-hint
                        :type="field.type === 'number' ? 'number' : 'text'"
                        variant="outlined"
                        :disabled="locked"
                        @update:model-value="updateConfig(selectedDraft, field.key, field.type === 'number' ? Number($event) : String($event))"
                      />
                    </template>
                    <p class="logging-note">
                      {{ $t('admin:logging.noTestEventSent') }}
                    </p>
                  </template>
                </article>
                <div v-else class="logging-empty">
                  <v-icon>mdi-text-box-search-outline</v-icon>
                  <h3>{{ $t('admin:logging.selectDestination') }}</h3>
                  <p>{{ $t('admin:logging.chooseVisibleProviderInspect') }}</p>
                </div>
              </section>
            </template>

            <template v-else-if="section === 'console'">
              <header class="logging-heading">
                <span class="logging-kicker">{{ $t('admin:logging.n02LocalRecord') }}</span>
                <h2>{{ $t('admin:logging.keepConsoleLegible') }}</h2>
                <p>
                  {{ $t('admin:logging.consoleAlwaysLocalProcess') }}
                </p>
              </header>
              <section class="logging-panel">
                <div class="logging-section-head">
                  <div>
                    <h3>{{ $t('admin:logging.consolePolicy') }}</h3>
                    <p>{{ $t('admin:logging.controlsMinimumLevelPresentation') }}</p>
                  </div>
                </div>
                <div class="logging-fields">
                  <v-select v-model="consolePolicy.level" :items="levels" :label="$t('admin:logging.minimumLevel2')" variant="outlined" :disabled="locked" />
                  <v-select v-model="consolePolicy.format" :items="formats" :label="$t('admin:logging.outputFormat')" variant="outlined" :disabled="locked" />
                </div>
                <v-alert v-if="consolePolicy.format === 'json'" type="info" variant="tonal" class="mt-3">
                  {{ $t('admin:logging.jsonIntendedCollectorStructured') }}
                </v-alert>
              </section>
              <section class="logging-panel">
                <div class="logging-section-head">
                  <div>
                    <h3>{{ $t('admin:logging.applicationSequence') }}</h3>
                    <p>{{ $t('admin:logging.savePersistsPolicyReviewed') }}</p>
                  </div>
                </div>
                <ol class="logging-steps">
                  <li>
                    <b>1</b>
                    <span>
                      {{ $t('admin:logging.reviewSave') }}
                      <br />
                      <small>{{ $t('admin:logging.atomicDatabaseRecord') }}</small>
                    </span>
                  </li>
                  <li>
                    <b>2</b>
                    <span>
                      {{ $t('admin:logging.reloadSavedPolicy') }}
                      <br />
                      <small>{{ $t('admin:logging.freshAuthorityFingerprint') }}</small>
                    </span>
                  </li>
                  <li>
                    <b>3</b>
                    <span>
                      {{ $t('admin:logging.applyProcess') }}
                      <br />
                      <small>{{ $t('admin:logging.observeLocalRuntimeOnly') }}</small>
                    </span>
                  </li>
                </ol>
              </section>
            </template>

            <template v-else>
              <header class="logging-heading">
                <span class="logging-kicker">{{ $t('admin:logging.n03EphemeralTroubleshooting') }}</span>
                <h2>{{ $t('admin:logging.watchLiveTrail') }}</h2>
                <p>
                  {{ $t('admin:logging.useShortLivedPrivileged') }}
                </p>
              </header>
              <logging-console :active="section === 'trail'" :limits="saved.liveTrail" />
            </template>
          </section>

          <aside v-if="section !== 'trail'" class="logging-aside">
            <section class="logging-aside-card">
              <span class="logging-kicker">{{ $t('admin:logging.currentProcess') }}</span>
              <h3>{{ saved.runtime.settingsCurrent ? $t('admin:logging.savedSettingsApplied') : $t('admin:logging.reconciliationNeeded') }}</h3>
              <p>{{ runtimeDescription }}</p>
              <dl>
                <div>
                  <dt>{{ $t('admin:logging.savedLevel') }}</dt>
                  <dd>{{ saved.console.level }}</dd>
                </div>
                <div>
                  <dt>{{ $t('admin:logging.processLevel') }}</dt>
                  <dd>{{ saved.runtime.console.level || $t('admin:logging.notObserved') }}</dd>
                </div>
                <div>
                  <dt>{{ $t('admin:logging.format') }}</dt>
                  <dd>{{ saved.runtime.console.format || $t('admin:logging.notObserved') }}</dd>
                </div>
                <div>
                  <dt>{{ $t('admin:logging.observation') }}</dt>
                  <dd>{{ saved.runtime.observedAt ? dateTime(saved.runtime.observedAt) : $t('admin:logging.notYetReconciled') }}</dd>
                </div>
              </dl>
              <v-btn
                v-if="!dirty && !stale && !saved.runtime.settingsCurrent"
                block
                variant="outlined"
                :loading="applying"
                :disabled="busy"
                @click="applySaved"
              >
                {{ $t('admin:logging.applySavedSettings') }}
              </v-btn>
              <p v-else-if="dirty" class="logging-aside-note">{{ $t('admin:logging.saveReviewedDraftBefore') }}</p>
            </section>
            <section class="logging-aside-note">
              <v-icon size="18" aria-hidden="true">mdi-shield-lock-outline</v-icon>
              <div>
                <strong>{{ $t('admin:logging.secretsStayPrivate') }}</strong>
                <p>{{ $t('admin:logging.storedCredentialsRepresentedOnly') }}</p>
              </div>
            </section>
            <details class="logging-history">
              <summary>{{ $t('admin:logging.recentReviewedChanges', { historyCount: saved.history.length, interpolation: { escapeValue: false } }) }}</summary>
              <div v-if="saved.history.length">
                <article v-for="entry in saved.history" :key="entry.id">
                  <strong>{{ dateTime(entry.createdAt) }}</strong>
                  <p>{{ entry.reason }}</p>
                  <small>{{ entry.changed.join(' · ') }}</small>
                </article>
              </div>
              <p v-else>{{ $t('admin:logging.noReviewedLoggingChanges') }}</p>
            </details>
          </aside>
        </div>
      </template>
    </div>

    <v-dialog v-model="reviewOpen" max-width="680" persistent aria-labelledby="logging-review-title">
      <v-card class="logging-review-card">
        <v-card-title id="logging-review-title">{{ $t('admin:logging.reviewLoggingChanges') }}</v-card-title>
        <v-card-text>
          <p>{{ $t('admin:logging.changesWrittenAtomicallyReason') }}</p>
          <ul class="logging-change-list">
            <li v-for="change in changes" :key="change">{{ change }}</li>
          </ul>
          <v-textarea
            v-model="reason"
            :label="$t('admin:logging.reasonChange')"
            variant="outlined"
            :counter="1000"
            :disabled="saving"
            :error-messages="reasonError ? [reasonError] : []"
          />
          <v-alert v-if="issues.length" type="warning" variant="tonal">{{ issues.join(' ') }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="saving" @click="reviewOpen = false">{{ $t('admin:logging.backDraft') }}</v-btn>
          <v-btn color="primary" :loading="saving" :disabled="issues.length > 0" @click="save">{{ $t('admin:logging.saveReviewedSettings') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { confirmDiscard } from '../common/confirm-dialog.ts'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import AsyncState from '@/components/common/async-state.vue'
import LoggingConsole from './admin-logging-console.vue'
import LoggingSecretField from './logging-secret-field.vue'
import { applyLoggingWorkspace, fetchLoggingWorkspace, saveLoggingWorkspace } from '../../helpers/logging-workspace-api.ts'
import type {
  LoggingDestination,
  LoggingDestinationDraft,
  LoggingDestinationField,
  LoggingSecretChange,
  LoggingWorkspace
} from '../../../shared/logging-workspace.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const route = useRoute()
const router = useRouter()
const sections = [
  { key: 'destinations', title: t('admin:logging.destinations') },
  { key: 'console', title: t('admin:logging.console') },
  { key: 'trail', title: t('admin:logging.liveTrail') }
] as const
const levels = ['error', 'warn', 'info', 'verbose', 'debug', 'silly']
const formats = [
  { title: 'Human-readable', value: 'default' },
  { title: 'JSON', value: 'json' }
]
const saved = ref<LoggingWorkspace | null>(null)
const consolePolicy = ref<LoggingWorkspace['console'] | null>(null)
const destinations = ref<LoggingDestinationDraft[]>([])
const secretChanges = ref<Record<string, LoggingSecretChange>>({})
const catalogueQuery = ref('')
const showLegacy = ref(false)
const legacyDestinationCount = computed(
  () => saved.value?.destinations.filter((item) => item.availability === 'unavailable' && !item.isEnabled).length || 0
)
const loading = ref(false)
const saving = ref(false)
const applying = ref(false)
const error = ref('')
const notice = ref('')
const stale = ref(false)
const reviewOpen = ref(false)
const reason = ref('')
const reasonError = ref('')
let loadSequence = 0

const section = computed(() =>
  sections.some((item) => item.key === route.query.section) ? (route.query.section as (typeof sections)[number]['key']) : 'destinations'
)
const busy = computed(() => loading.value || saving.value || applying.value)
const dialogOpen = computed(() => reviewOpen.value)
const destinationFor = (key: string) => saved.value?.destinations.find((destination) => destination.key === key)
const filteredDestinations = computed(() => {
  const query = catalogueQuery.value.trim().toLocaleLowerCase()
  return [...(saved.value?.destinations ?? [])]
    .filter((destination) =>
      query
        ? `${destination.key} ${destination.title} ${destination.description ?? ''}`.toLocaleLowerCase().includes(query)
        : showLegacy.value || destination.availability === 'available' || destination.isEnabled || destination.key === route.query.destination
    )
    .sort(
      (left, right) => Number(right.availability === 'available') - Number(left.availability === 'available') || left.title.localeCompare(right.title)
    )
})
const selectedDestinationKey = computed(() => {
  const requested = typeof route.query.destination === 'string' ? route.query.destination : ''
  if (destinationFor(requested)) return requested
  return filteredDestinations.value[0]?.key ?? saved.value?.destinations[0]?.key ?? ''
})
const selectedDestination = computed(() => destinationFor(selectedDestinationKey.value) ?? null)
const selectedDraft = computed(() => destinations.value.find((destination) => destination.key === selectedDestinationKey.value) ?? null)
const secretKey = (destination: string, field: string) => `${destination}:${field}`
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const defaultValue = (field: LoggingDestinationField): string | number | boolean =>
  field.type === 'number' ? 0 : field.type === 'boolean' ? false : ''
const enumConfigValue = (draft: LoggingDestinationDraft, key: string): string => {
  const value = draft.config[key]
  return typeof value === 'string' ? value : ''
}
const draftDestination = (destination: LoggingDestination): LoggingDestinationDraft => ({
  key: destination.key,
  isEnabled: destination.isEnabled,
  level: destination.level,
  config: Object.fromEntries(
    destination.fields.filter((field) => !field.sensitive).map((field) => [field.key, destination.config[field.key] ?? defaultValue(field)])
  ),
  secrets: Object.fromEntries(destination.fields.filter((field) => field.sensitive).map((field) => [field.key, { action: 'keep' }]))
})
const draftPayload = () => ({
  console: consolePolicy.value ? clone(consolePolicy.value) : null,
  destinations: destinations.value.map((destination) => ({
    ...clone(destination),
    secrets: Object.fromEntries(
      Object.keys(destination.secrets).map((key) => [key, clone(secretChanges.value[secretKey(destination.key, key)] ?? { action: 'keep' })])
    )
  }))
})
const baselinePayload = () =>
  saved.value
    ? {
        console: saved.value.console,
        destinations: saved.value.destinations.map(draftDestination)
      }
    : null
const dirty = computed(() => saved.value !== null && JSON.stringify(draftPayload()) !== JSON.stringify(baselinePayload()))
const issues = computed(() => {
  if (!saved.value) return []
  const result: string[] = []
  for (const destination of destinations.value) {
    const savedDestination = destinationFor(destination.key)
    if (!savedDestination) continue
    for (const field of savedDestination.fields) {
      if (!field.sensitive) continue
      const action = secretChanges.value[secretKey(destination.key, field.key)] ?? { action: 'keep' }
      if (action.action === 'replace' && action.value.trim().length === 0)
        result.push(t('admin:logging.enterNonblankReplacementValue', { title: savedDestination.title, title2: field.title, interpolation: { escapeValue: false } }))
    }
    if (!destination.isEnabled || destination.key !== 'sentry') continue
    const action = secretChanges.value[secretKey(destination.key, 'key')] ?? { action: 'keep' }
    if (
      action.action === 'clear' ||
      (action.action === 'keep' && !savedDestination.secrets.key) ||
      (action.action === 'replace' && !action.value.trim())
    )
      result.push(t('admin:logging.sentryDsnRequiredWhile'))
  }
  return result
})
const changes = computed(() => {
  if (!saved.value || !consolePolicy.value) return []
  const result: string[] = []
  if (consolePolicy.value.level !== saved.value.console.level)
    result.push(t('admin:logging.consoleMinimumLevel', { level: saved.value.console.level, level2: consolePolicy.value.level, interpolation: { escapeValue: false } }))
  if (consolePolicy.value.format !== saved.value.console.format)
    result.push(t('admin:logging.consoleFormat', { format: saved.value.console.format, format2: consolePolicy.value.format, interpolation: { escapeValue: false } }))
  for (const destination of destinations.value) {
    const original = destinationFor(destination.key)
    if (!original) continue
    if (destination.isEnabled !== original.isEnabled) result.push(`${original.title}: ${destination.isEnabled ? 'enabled' : 'disabled'}`)
    if (destination.level !== original.level) result.push(t('admin:logging.minimumLevel', { title: original.title, level: original.level, level2: destination.level, interpolation: { escapeValue: false } }))
    for (const [key, value] of Object.entries(destination.config))
      if (JSON.stringify(value) !== JSON.stringify(original.config[key])) result.push(t('admin:logging.changed', { title: original.title, key, interpolation: { escapeValue: false } }))
    for (const [key, action] of Object.entries(destination.secrets)) {
      const selected = secretChanges.value[secretKey(destination.key, key)] ?? action
      if (selected.action !== 'keep') result.push(`${original.title}: ${key} ${selected.action === 'clear' ? 'cleared' : 'replaced'}`)
    }
  }
  return result
})
const locked = computed(() => busy.value || stale.value || !saved.value || !consolePolicy.value)
const runtimeDescription = computed(() => {
  if (!saved.value) return ''
  if (saved.value.runtime.settingsCurrent)
    return t('admin:logging.savedPolicyHasBeen')
  return (
    saved.value.runtime.message || t('admin:logging.savedLoggingPolicyDiffers')
  )
})

const destinationRuntimeLabel = (state: LoggingDestination['runtime']['state']): string => {
  switch (state) {
    case 'active':
      return t('admin:logging.active')
    case 'inactive':
      return t('admin:logging.inactive')
    case 'unavailable':
      return t('admin:logging.unavailable')
    case 'failed':
      return t('admin:logging.failed')
    default:
      return t('admin:logging.notApplied')
  }
}
const destinationRuntimeTone = (state: LoggingDestination['runtime']['state']): 'success' | 'info' | 'warning' | 'error' => {
  switch (state) {
    case 'active':
      return 'success'
    case 'failed':
      return 'error'
    case 'unavailable':
      return 'warning'
    default:
      return 'info'
  }
}

const dateTime = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
const reset = () => {
  if (!saved.value) return
  consolePolicy.value = clone(saved.value.console)
  destinations.value = saved.value.destinations.map(draftDestination)
  secretChanges.value = Object.fromEntries(
    saved.value.destinations.flatMap((destination) =>
      destination.fields
        .filter((field) => field.sensitive)
        .map((field) => [secretKey(destination.key, field.key), { action: 'keep' } satisfies LoggingSecretChange])
    )
  )
  reason.value = ''
  reasonError.value = ''
}
const load = async (): Promise<boolean> => {
  const sequence = ++loadSequence
  loading.value = true
  error.value = ''
  try {
    const workspace = await fetchLoggingWorkspace()
    if (sequence !== loadSequence) return false
    saved.value = workspace
    reset()
    stale.value = false
    return true
  } catch (caught) {
    if (sequence !== loadSequence) return false
    error.value = caught instanceof Error ? caught.message : t('admin:logging.loggingSettingsCouldNot')
    return false
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}
const reload = () =>
  askDiscard(() => {
    void load()
  })
const askDiscard = async (next: () => void) => {
  if (!dirty.value) {
    next()
    return
  }
  if (!(await confirmDiscard(t('admin:logging.discardLoggingDraft'), t('admin:logging.unsavedDestinationConsoleSecret'), t('admin:logging.discardDraft')))) return
  reset()
  next()
}
const selectSection = (key: (typeof sections)[number]['key']) => {
  void router.replace({ query: { ...route.query, section: key } })
}
const selectDestination = (key: string) => {
  void router.replace({ query: { ...route.query, section: 'destinations', destination: key } })
}
const updateConfig = (draft: LoggingDestinationDraft, key: string, value: string | number | boolean) => {
  draft.config[key] = value
}
const updateEnumConfig = (draft: LoggingDestinationDraft, key: string, value: unknown) => {
  if (typeof value === 'string') updateConfig(draft, key, value)
}
const openReview = () => {
  reasonError.value = ''
  reviewOpen.value = true
}
const requiresRecovery = (status: unknown): boolean =>
  status === undefined || status === 401 || status === 403 || status === 409 || (typeof status === 'number' && status >= 500 && status <= 599)
const save = async () => {
  if (!saved.value || !consolePolicy.value || issues.value.length) return
  const trimmed = reason.value.trim()
  if (trimmed.length < 3) {
    reasonError.value = t('admin:logging.provideBriefReasonLeast')
    return
  }
  saving.value = true
  reasonError.value = ''
  try {
    const result = await saveLoggingWorkspace({ fingerprint: saved.value.fingerprint, reason: trimmed, ...draftPayload() })
    reviewOpen.value = false
    notice.value = t('admin:logging.loggingSettingsWereSaved', { revision: result.revision, interpolation: { escapeValue: false } })
    stale.value = true
    await load()
  } catch (caught) {
    const status = typeof caught === 'object' && caught !== null && 'status' in caught ? (caught as { status?: unknown }).status : undefined
    if (requiresRecovery(status)) stale.value = true
    reasonError.value = caught instanceof Error ? caught.message : t('admin:logging.saveOutcomeUnconfirmedReload')
  } finally {
    saving.value = false
  }
}
const applySaved = async () => {
  if (!saved.value || dirty.value || stale.value) return
  applying.value = true
  try {
    const result = await applyLoggingWorkspace(saved.value.fingerprint)
    notice.value = result.applied
      ? t('admin:logging.savedLoggingSettingsWere')
      : t('admin:logging.savedSettingsWereRead')
    stale.value = true
    await load()
  } catch (caught) {
    const status = typeof caught === 'object' && caught !== null && 'status' in caught ? (caught as { status?: unknown }).status : undefined
    if (requiresRecovery(status)) stale.value = true
    error.value = caught instanceof Error ? caught.message : t('admin:logging.applicationOutcomeUnconfirmedReload')
  } finally {
    applying.value = false
  }
}

onMounted(() => {
  void load()
})
onBeforeUnmount(() => {
  loadSequence += 1
})
onBeforeRouteLeave(async () => {
  if (!dirty.value) return true
  return confirmDiscard(t('admin:logging.discardLoggingDraft'), t('admin:logging.unsavedDestinationConsoleSecret'), t('admin:logging.discardDraft'))
})
</script>

<style lang="scss" src="./logging-workspace.scss"></style>
