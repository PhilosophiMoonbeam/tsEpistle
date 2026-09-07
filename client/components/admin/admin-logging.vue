<template>
  <v-container fluid class="logging-workspace">
    <div :inert="dialogOpen || undefined">
      <admin-hero
        title="Logging"
        description="Configure log delivery, tune console output and follow live events."
        icon="mdi-text-box-search-outline"
      >
        <template #actions>
          <v-btn variant="text" prepend-icon="mdi-refresh" :disabled="busy" @click="reload">Reload workspace</v-btn>
          <v-btn v-if="dirty" variant="text" :disabled="busy" @click="askDiscard(reset)">Reset draft</v-btn>
          <v-btn color="primary" :disabled="locked || !dirty || issues.length > 0" @click="openReview">Review changes</v-btn>
        </template>
      </admin-hero>

      <async-state
        v-if="loading && !saved"
        state="loading"
        title="Loading Logging"
        message="Reading saved destinations and this process's runtime observation."
      />
      <async-state
        v-else-if="error && !saved"
        state="error"
        title="Logging could not be loaded"
        :message="error"
        retry-label="Try again"
        @retry="load"
      />
      <v-alert v-else-if="error" type="error" variant="tonal" class="mb-5">{{ error }}</v-alert>
      <v-alert v-if="notice" type="info" variant="tonal" class="mb-5" aria-live="polite">{{ notice }}</v-alert>
      <v-alert v-if="stale" type="warning" variant="tonal" class="mb-5">
        Saved settings changed, or an action outcome is unconfirmed. Reload and review before another save or application.
      </v-alert>

      <template v-if="saved && consolePolicy">
        <div class="logging-state-line">
          <span>
            <i :class="{ 'is-draft': dirty }" />
            {{ dirty ? 'Unsaved logging draft' : 'Showing saved settings' }}
          </span>
          <span>Observed {{ dateTime(saved.observedAt) }}</span>
        </div>
        <nav class="logging-tabs" aria-label="Logging sections">
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
                <span class="logging-kicker">01 / Intentional delivery</span>
                <h2>Choose where records can go.</h2>
                <p>
                  Only destinations with an active transport in this release can be enabled. A destination being active confirms local initialization,
                  not remote delivery.
                </p>
              </header>
              <section class="logging-panel logging-destination-layout">
                <aside class="logging-catalogue" aria-label="Logging destinations">
                  <v-text-field
                    v-model="catalogueQuery"
                    label="Find a destination"
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
                    {{ showLegacy ? 'Hide legacy destinations' : 'Show legacy destinations (' + legacyDestinationCount + ')' }}
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
                          {{ destination.availability === 'available' ? `Saved: ${destination.isEnabled ? 'Enabled' : 'Disabled'}` : 'Unavailable' }}
                        </small>
                      </span>
                      <v-icon size="16" aria-hidden="true">mdi-chevron-right</v-icon>
                    </button>
                  </div>
                  <div v-else class="logging-empty">
                    <v-icon>mdi-magnify</v-icon>
                    <h3>No matching destination</h3>
                    <p>Try a provider name or clear the search.</p>
                  </div>
                </aside>
                <article v-if="selectedDestination && selectedDraft" class="logging-destination-detail">
                  <div class="logging-provider-head">
                    <v-icon class="logging-provider-icon" size="48" aria-hidden="true">mdi-domain</v-icon>
                    <div>
                      <span class="logging-kicker">
                        {{ selectedDestination.availability === 'available' ? 'Available destination' : 'Legacy destination' }}
                      </span>
                      <h3>{{ selectedDestination.title }}</h3>
                      <p>{{ selectedDestination.description || 'No provider description is available.' }}</p>
                      <a v-if="selectedDestination.website" :href="selectedDestination.website" target="_blank" rel="noopener noreferrer">
                        Provider website
                        <span class="sr-only">opens in a new tab</span>
                        <v-icon size="14" aria-hidden="true">mdi-open-in-new</v-icon>
                      </a>
                    </div>
                  </div>
                  <v-alert :type="destinationRuntimeTone(selectedDestination.runtime.state)" variant="tonal" class="mt-5">
                    <strong class="mr-1">Runtime in this process: {{ destinationRuntimeLabel(selectedDestination.runtime.state) }}.</strong>
                    <span v-if="selectedDestination.runtime.message">{{ selectedDestination.runtime.message }}</span>
                    <span v-else>Saved policy is {{ selectedDestination.isEnabled ? 'enabled' : 'disabled' }}.</span>
                  </v-alert>
                  <v-alert v-if="selectedDestination.availability === 'unavailable'" type="warning" variant="tonal" class="mt-5">
                    {{ selectedDestination.availabilityReason }} Historic configuration remains untouched.
                    <v-btn
                      v-if="selectedDraft.isEnabled"
                      class="mt-3"
                      color="warning"
                      variant="outlined"
                      :disabled="locked"
                      @click="selectedDraft.isEnabled = false"
                    >
                      Disable unsupported destination
                    </v-btn>
                  </v-alert>
                  <template v-else>
                    <div class="logging-section-head mt-6">
                      <div>
                        <h4>Delivery policy</h4>
                        <p>Enable only after the required provider settings are saved.</p>
                      </div>
                      <v-switch v-model="selectedDraft.isEnabled" label="Destination enabled" color="primary" inset hide-details :disabled="locked" />
                    </div>
                    <v-select
                      v-model="selectedDraft.level"
                      :items="levels"
                      label="Minimum level"
                      variant="outlined"
                      :disabled="locked"
                      persistent-hint
                      hint="Only records at this severity or above are routed to this destination."
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
                      No test event is sent from Administration. Runtime status confirms local initialization only; inspect your provider
                      independently for delivery evidence.
                    </p>
                  </template>
                </article>
                <div v-else class="logging-empty">
                  <v-icon>mdi-text-box-search-outline</v-icon>
                  <h3>Select a destination</h3>
                  <p>Choose a visible provider to inspect its saved policy.</p>
                </div>
              </section>
            </template>

            <template v-else-if="section === 'console'">
              <header class="logging-heading">
                <span class="logging-kicker">02 / Local record</span>
                <h2>Keep the console legible.</h2>
                <p>
                  The console is always local to this process. Its policy is saved separately, then applied deliberately without sending a remote test
                  event.
                </p>
              </header>
              <section class="logging-panel">
                <div class="logging-section-head">
                  <div>
                    <h3>Console policy</h3>
                    <p>Controls the minimum level and presentation used by the application console.</p>
                  </div>
                </div>
                <div class="logging-fields">
                  <v-select v-model="consolePolicy.level" :items="levels" label="Minimum level" variant="outlined" :disabled="locked" />
                  <v-select v-model="consolePolicy.format" :items="formats" label="Output format" variant="outlined" :disabled="locked" />
                </div>
                <v-alert v-if="consolePolicy.format === 'json'" type="info" variant="tonal" class="mt-3">
                  JSON is intended for a collector or structured process output. It changes representation, not which remote destinations exist.
                </v-alert>
              </section>
              <section class="logging-panel">
                <div class="logging-section-head">
                  <div>
                    <h3>Application sequence</h3>
                    <p>Save persists the policy and its reviewed reason. Apply reconciles that saved policy in this process.</p>
                  </div>
                </div>
                <ol class="logging-steps">
                  <li>
                    <b>1</b>
                    <span>
                      Review and save
                      <br />
                      <small>Atomic database record</small>
                    </span>
                  </li>
                  <li>
                    <b>2</b>
                    <span>
                      Reload the saved policy
                      <br />
                      <small>Fresh authority and fingerprint</small>
                    </span>
                  </li>
                  <li>
                    <b>3</b>
                    <span>
                      Apply in this process
                      <br />
                      <small>Observe local runtime only</small>
                    </span>
                  </li>
                </ol>
              </section>
            </template>

            <template v-else>
              <header class="logging-heading">
                <span class="logging-kicker">03 / Ephemeral troubleshooting</span>
                <h2>Watch the live trail.</h2>
                <p>
                  Use this short-lived, privileged view while investigating a current issue. It is not a log archive or an assertion of remote
                  delivery.
                </p>
              </header>
              <logging-console :active="section === 'trail'" :limits="saved.liveTrail" />
            </template>
          </section>

          <aside v-if="section !== 'trail'" class="logging-aside">
            <section class="logging-aside-card">
              <span class="logging-kicker">Current process</span>
              <h3>{{ saved.runtime.settingsCurrent ? 'Saved settings applied' : 'Reconciliation needed' }}</h3>
              <p>{{ runtimeDescription }}</p>
              <dl>
                <div>
                  <dt>Saved level</dt>
                  <dd>{{ saved.console.level }}</dd>
                </div>
                <div>
                  <dt>Process level</dt>
                  <dd>{{ saved.runtime.console.level || 'Not observed' }}</dd>
                </div>
                <div>
                  <dt>Format</dt>
                  <dd>{{ saved.runtime.console.format || 'Not observed' }}</dd>
                </div>
                <div>
                  <dt>Observation</dt>
                  <dd>{{ saved.runtime.observedAt ? dateTime(saved.runtime.observedAt) : 'Not yet reconciled' }}</dd>
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
                Apply saved settings
              </v-btn>
              <p v-else-if="dirty" class="logging-aside-note">Save the reviewed draft before applying a new process configuration.</p>
            </section>
            <section class="logging-aside-note">
              <v-icon size="18" aria-hidden="true">mdi-shield-lock-outline</v-icon>
              <div>
                <strong>Secrets stay private</strong>
                <p>Stored credentials are represented only by their presence. Choose Keep, Replace or Clear; a value is never echoed back.</p>
              </div>
            </section>
            <details class="logging-history">
              <summary>Recent reviewed changes ({{ saved.history.length }})</summary>
              <div v-if="saved.history.length">
                <article v-for="entry in saved.history" :key="entry.id">
                  <strong>{{ dateTime(entry.createdAt) }}</strong>
                  <p>{{ entry.reason }}</p>
                  <small>{{ entry.changed.join(' · ') }}</small>
                </article>
              </div>
              <p v-else>No reviewed logging changes have been recorded yet.</p>
            </details>
          </aside>
        </div>
      </template>
    </div>

    <v-dialog v-model="reviewOpen" max-width="680" persistent aria-labelledby="logging-review-title">
      <v-card class="logging-review-card">
        <v-card-title id="logging-review-title">Review logging changes</v-card-title>
        <v-card-text>
          <p>Changes are written atomically with your reason. Saving does not claim that this process or a remote provider has delivered a record.</p>
          <ul class="logging-change-list">
            <li v-for="change in changes" :key="change">{{ change }}</li>
          </ul>
          <v-textarea
            v-model="reason"
            label="Reason for this change"
            variant="outlined"
            :counter="1000"
            :disabled="saving"
            :error-messages="reasonError ? [reasonError] : []"
          />
          <v-alert v-if="issues.length" type="warning" variant="tonal">{{ issues.join(' ') }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="saving" @click="reviewOpen = false">Back to draft</v-btn>
          <v-btn color="primary" :loading="saving" :disabled="issues.length > 0" @click="save">Save reviewed settings</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog :model-value="discardOpen" max-width="470" aria-labelledby="logging-discard-title" @update:model-value="updateDiscardOpen">
      <v-card>
        <v-card-title id="logging-discard-title">Discard logging draft?</v-card-title>
        <v-card-text>Your unsaved destination, console and secret-action changes will be lost.</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="cancelDiscard">Keep editing</v-btn>
          <v-btn color="error" variant="flat" @click="confirmDiscard">Discard draft</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
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
const route = useRoute()
const router = useRouter()
const sections = [
  { key: 'destinations', title: 'Destinations' },
  { key: 'console', title: 'Console' },
  { key: 'trail', title: 'Live trail' }
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
const discardOpen = ref(false)
const reason = ref('')
const reasonError = ref('')
const pendingDiscard = ref<(() => void) | null>(null)
const leavePath = ref<string | null>(null)
let loadSequence = 0

const section = computed(() =>
  sections.some((item) => item.key === route.query.section) ? (route.query.section as (typeof sections)[number]['key']) : 'destinations'
)
const busy = computed(() => loading.value || saving.value || applying.value)
const dialogOpen = computed(() => reviewOpen.value || discardOpen.value)
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
        result.push(`Enter a nonblank replacement value for ${savedDestination.title} ${field.title}.`)
    }
    if (!destination.isEnabled || destination.key !== 'sentry') continue
    const action = secretChanges.value[secretKey(destination.key, 'key')] ?? { action: 'keep' }
    if (
      action.action === 'clear' ||
      (action.action === 'keep' && !savedDestination.secrets.key) ||
      (action.action === 'replace' && !action.value.trim())
    )
      result.push('A Sentry DSN is required while the Sentry destination is enabled.')
  }
  return result
})
const changes = computed(() => {
  if (!saved.value || !consolePolicy.value) return []
  const result: string[] = []
  if (consolePolicy.value.level !== saved.value.console.level)
    result.push(`Console minimum level: ${saved.value.console.level} → ${consolePolicy.value.level}`)
  if (consolePolicy.value.format !== saved.value.console.format)
    result.push(`Console format: ${saved.value.console.format} → ${consolePolicy.value.format}`)
  for (const destination of destinations.value) {
    const original = destinationFor(destination.key)
    if (!original) continue
    if (destination.isEnabled !== original.isEnabled) result.push(`${original.title}: ${destination.isEnabled ? 'enabled' : 'disabled'}`)
    if (destination.level !== original.level) result.push(`${original.title} minimum level: ${original.level} → ${destination.level}`)
    for (const [key, value] of Object.entries(destination.config))
      if (JSON.stringify(value) !== JSON.stringify(original.config[key])) result.push(`${original.title}: ${key} changed`)
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
    return 'The saved policy has been reconciled in this application process. Remote delivery still requires provider-side evidence.'
  return (
    saved.value.runtime.message || 'Saved logging policy differs from this process. Apply the saved settings after checking the runtime observation.'
  )
})

const destinationRuntimeLabel = (state: LoggingDestination['runtime']['state']): string => {
  switch (state) {
    case 'active':
      return 'Active'
    case 'inactive':
      return 'Inactive'
    case 'unavailable':
      return 'Unavailable'
    case 'failed':
      return 'Failed'
    default:
      return 'Not applied'
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
    error.value = caught instanceof Error ? caught.message : 'Logging settings could not be loaded.'
    return false
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}
const reload = () =>
  askDiscard(() => {
    void load()
  })
const askDiscard = (next: () => void) => {
  if (!dirty.value) {
    next()
    return
  }
  pendingDiscard.value = next
  discardOpen.value = true
}
const cancelDiscard = () => {
  pendingDiscard.value = null
  leavePath.value = null
  discardOpen.value = false
}
const updateDiscardOpen = (open: boolean) => {
  if (open) {
    discardOpen.value = true
    return
  }
  cancelDiscard()
}
const confirmDiscard = () => {
  const next = pendingDiscard.value
  const path = leavePath.value
  pendingDiscard.value = null
  leavePath.value = null
  discardOpen.value = false
  reset()
  next?.()
  if (path) void router.push(path)
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
    reasonError.value = 'Provide a brief reason of at least three characters.'
    return
  }
  saving.value = true
  reasonError.value = ''
  try {
    const result = await saveLoggingWorkspace({ fingerprint: saved.value.fingerprint, reason: trimmed, ...draftPayload() })
    reviewOpen.value = false
    notice.value = `Logging settings were saved in revision ${result.revision}. Reloaded settings must be applied separately to reconcile this process.`
    stale.value = true
    await load()
  } catch (caught) {
    const status = typeof caught === 'object' && caught !== null && 'status' in caught ? (caught as { status?: unknown }).status : undefined
    if (requiresRecovery(status)) stale.value = true
    reasonError.value = caught instanceof Error ? caught.message : 'The save outcome is unconfirmed. Reload before repeating it.'
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
      ? 'Saved logging settings were reconciled in this application process. This is not evidence of remote delivery.'
      : 'Saved settings were read, but this process could not fully reconcile them. Inspect the runtime observation before trying again.'
    stale.value = true
    await load()
  } catch (caught) {
    const status = typeof caught === 'object' && caught !== null && 'status' in caught ? (caught as { status?: unknown }).status : undefined
    if (requiresRecovery(status)) stale.value = true
    error.value = caught instanceof Error ? caught.message : 'The application outcome is unconfirmed. Reload before repeating it.'
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
onBeforeRouteLeave((to) => {
  if (!dirty.value) return true
  pendingDiscard.value = null
  leavePath.value = to.fullPath
  discardOpen.value = true
  return false
})
</script>

<style lang="scss" src="./logging-workspace.scss"></style>
