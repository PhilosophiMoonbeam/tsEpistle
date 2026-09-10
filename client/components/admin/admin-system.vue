<template>
  <v-container fluid class="system-workspace">
    <admin-hero title="System" description="Understand what is running. Find the evidence behind its state." icon="mdi-monitor-dashboard">
      <template #actions>
        <v-btn variant="text" prepend-icon="mdi-refresh" :disabled="loading" :aria-busy="loading" @click="load">Refresh observation</v-btn>
        <v-btn color="primary" prepend-icon="mdi-file-document-outline" :disabled="!snapshot" @click="selectSection('diagnostics')">
          Support report
        </v-btn>
      </template>
    </admin-hero>
    <async-state
      v-if="loading && !snapshot"
      state="loading"
      title="Observing this system"
      message="Reading the running process, database, migrations and background work."
    />
    <async-state
      v-else-if="error && !snapshot"
      state="error"
      title="System observations are unavailable"
      :message="error"
      retry-label="Try again"
      @retry="load"
    />
    <v-alert v-else-if="error" type="warning" variant="tonal" class="mb-5">{{ error }} The previous observation is still shown below.</v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" class="mb-5" role="status">{{ notice }}</v-alert>
    <template v-if="snapshot">
      <div class="system-observed" aria-live="polite">
        <span>
          <i :class="{ 'is-stale': Boolean(error) }" />
          {{ loading ? 'Collecting a fresh observation…' : error ? 'Previous observation' : 'Observed system state' }}
        </span>
        <time :datetime="snapshot.observedAt">{{ dateTime(snapshot.observedAt) }}</time>
      </div>
      <nav class="system-tabs" aria-label="System sections">
        <button
          v-for="tab in sections"
          :key="tab.key"
          type="button"
          :aria-current="section === tab.key ? 'page' : undefined"
          @click="selectSection(tab.key)"
        >
          {{ tab.title }}
        </button>
      </nav>
      <div class="system-layout">
        <section class="system-main">
          <template v-if="section === 'overview'">
            <div class="system-heading">
              <span class="system-kicker">01 / The running workspace</span>
              <h2>
                A clear view
                <br />
                of your wiki
              </h2>
              <p>One application process. A current database observation. Concrete signals for the next decision.</p>
            </div>
            <div class="system-release">
              <div>
                <span class="system-kicker">{{ snapshot.product.name }}</span>
                <h3>{{ snapshot.product.version }}</h3>
                <a :href="snapshot.product.sourceUrl" target="_blank" rel="noopener noreferrer" class="system-mono">
                  {{ snapshot.product.revision.slice(0, 12) }}
                  <v-icon size="14" icon="mdi-arrow-top-right" />
                </a>
              </div>
              <div>
                <span class="system-uptime-label">
                  Process uptime
                  <radar-pulse-beacon state="success" :size="8" class="ms-1" />
                </span>
                <strong>{{ duration(snapshot.runtime.uptimeSeconds) }}</strong>
                <small>Since this process started</small>
              </div>
            </div>
            <hardware-telemetry-card
              title="Hardware Memory Telemetry"
              icon="mdi-chip"
              accent-color="#06b6d4"
              class="my-6"
            >
              <template #actions>
                <v-btn size="small" variant="text" append-icon="mdi-arrow-right" @click="selectSection('runtime')">
                  Runtime details
                </v-btn>
              </template>
              <div class="system-telemetry-row">
                <cybernetic-hardware-gauge
                  :heap-used="snapshot.runtime.heapUsedBytes"
                  :heap-total="snapshot.runtime.heapTotalBytes"
                  :process-rss="snapshot.runtime.processRssBytes"
                  :os-total="snapshot.runtime.systemMemoryBytes"
                />
                <div class="system-metrics system-metrics--telemetry">
                  <div>
                    <span>Process resident memory</span>
                    <strong>{{ bytes(snapshot.runtime.processRssBytes) }}</strong>
                    <small>RSS at observation time</small>
                  </div>
                  <div>
                    <span>JavaScript heap in use</span>
                    <strong>{{ bytes(snapshot.runtime.heapUsedBytes) }}</strong>
                    <small>{{ bytes(snapshot.runtime.heapTotalBytes) }} heap allocated</small>
                  </div>
                </div>
              </div>
            </hardware-telemetry-card>
            <h3 class="system-section-title">Operational signals</h3>
            <div class="system-signals">
              <article v-for="signal in signals" :key="signal.title">
                <v-icon
                  :icon="signal.attention ? 'mdi-alert-circle-outline' : 'mdi-check-circle-outline'"
                  :class="signal.attention ? 'system-warning' : 'system-positive'"
                />
                <div>
                  <h4>{{ signal.title }}</h4>
                  <p>{{ signal.detail }}</p>
                </div>
                <v-btn v-if="signal.section" size="small" variant="text" @click="selectSection(signal.section)">Inspect</v-btn>
              </article>
            </div>
            <div class="system-callout">
              <v-icon icon="mdi-information-outline" />
              <p>
                These observations describe this application and its database. A successful check does not verify the public proxy, an external
                provider or delivery to a recipient.
              </p>
            </div>
          </template>
          <template v-else-if="section === 'runtime'">
            <div class="system-heading">
              <span class="system-kicker">02 / Process &amp; deployment</span>
              <h2>Know the boundaries</h2>
              <p>Separate the process you are observing from its operating system and the infrastructure around it.</p>
            </div>
            <hardware-telemetry-card
              title="Execution Memory & Capacity"
              icon="mdi-memory"
              accent-color="#06b6d4"
              class="mb-6"
            >
              <template #actions>
                <div class="system-telemetry-status">
                  <radar-pulse-beacon state="applied" :size="7" />
                  <span>Telemetry active</span>
                </div>
              </template>
              <div class="system-telemetry-row">
                <cybernetic-hardware-gauge
                  :heap-used="snapshot.runtime.heapUsedBytes"
                  :heap-total="snapshot.runtime.heapTotalBytes"
                  :process-rss="snapshot.runtime.processRssBytes"
                  :os-total="snapshot.runtime.systemMemoryBytes"
                />
                <div class="system-metrics system-metrics--telemetry">
                  <div>
                    <span>Process resident memory</span>
                    <strong>{{ bytes(snapshot.runtime.processRssBytes) }}</strong>
                    <small>RSS at observation time</small>
                  </div>
                  <div>
                    <span>JavaScript heap in use</span>
                    <strong>{{ bytes(snapshot.runtime.heapUsedBytes) }}</strong>
                    <small>{{ bytes(snapshot.runtime.heapTotalBytes) }} heap allocated</small>
                  </div>
                </div>
              </div>
            </hardware-telemetry-card>
            <h3 class="system-section-title">Execution environment</h3>
            <dl class="system-facts">
              <template v-for="fact in runtimeFacts" :key="fact.label">
                <dt>{{ fact.label }}</dt>
                <dd :class="{ 'system-mono': fact.mono }">{{ fact.value }}</dd>
              </template>
            </dl>
            <div class="system-callout">
              <v-icon icon="mdi-memory" />
              <p>
                OS-visible memory and logical CPU counts can describe the host. They are not container limits or current CPU utilization. Available
                parallelism is the runtime's scheduling estimate.
              </p>
            </div>
            <h3 class="system-section-title">Application listeners</h3>
            <dl class="system-facts">
              <dt>HTTP</dt>
              <dd>{{ listener(snapshot.runtime.httpPort) }}</dd>
              <dt>HTTPS</dt>
              <dd>{{ listener(snapshot.runtime.httpsPort) }}</dd>
              <dt>Configured public origin</dt>
              <dd class="system-mono">{{ snapshot.runtime.publicOrigin || 'No valid HTTP(S) origin' }}</dd>
            </dl>
            <p class="system-note">
              An external proxy can terminate HTTPS while the application listens on HTTP. Listener observations do not establish whether that proxy
              is reachable or its certificate is valid.
            </p>
            <v-btn to="/a/ssl" variant="outlined" append-icon="mdi-arrow-right">HTTPS &amp; certificates</v-btn>
          </template>
          <template v-else-if="section === 'background'">
            <div class="system-heading">
              <span class="system-kicker">03 / Work behind the scenes</span>
              <h2>See what is moving</h2>
              <p>Scheduled invocations belong to this process. Durable work is shared through PostgreSQL and can outlive it.</p>
            </div>
            <h3 class="system-section-title">Process scheduler</h3>
            <div v-if="!snapshot.scheduler.jobs.length" class="system-empty">
              <v-icon icon="mdi-calendar-blank-outline" size="32" />
              <h4>No scheduler observations</h4>
              <p>
                {{
                  snapshot.scheduler.started
                    ? 'No active or recently completed tasks were observed.'
                    : 'The scheduler has not started in this process.'
                }}
              </p>
            </div>
            <div v-else class="system-table-wrap" role="region" aria-label="Scheduled task observations" tabindex="0">
              <table>
                <caption class="sr-only">
                  Active tasks, tasks skipped for offline mode, and up to fifty recent completed or stopped tasks in this process.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Task</th>
                    <th scope="col">Now</th>
                    <th scope="col">Last result</th>
                    <th scope="col">Next / last run</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="job in snapshot.scheduler.jobs" :key="job.id">
                    <th scope="row">
                      <span>{{ job.name }}</span>
                      <small>{{ job.worker ? 'Child process' : 'In process' }} · {{ job.repeat ? 'Repeating' : 'Once' }}</small>
                    </th>
                    <td>
                      <span class="system-state">{{ job.state }}</span>
                    </td>
                    <td>
                      <span :class="{ 'system-warning': job.lastOutcome === 'failed' }">{{ job.lastOutcome || 'Not observed' }}</span>
                      <small>
                        <animated-counter :target-value="job.runs" /> runs · <animated-counter :target-value="job.failures" /> failures
                        <span v-if="job.lastDurationMs !== null">· {{ job.lastDurationMs }} ms last run</span>
                      </small>
                    </td>
                    <td>
                      {{ job.nextRunAt ? dateTime(job.nextRunAt) : job.lastStartedAt ? dateTime(job.lastStartedAt) : '—' }}
                      <small>
                        {{
                          job.nextRunAt
                            ? 'Next invocation'
                            : job.lastStartedAt
                              ? 'Last started'
                              : job.state === 'skipped'
                                ? 'Skipped in offline mode'
                                : 'No invocation recorded'
                        }}
                      </small>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="system-note">
              Process observations reset on restart. Repeating tasks schedule their next invocation after the previous one finishes. A successful
              scheduler invocation can still leave failed durable jobs below.
            </p>
            <h3 class="system-section-title">Durable queue</h3>
            <div class="system-queue-counts">
              <div v-for="(value, state) in snapshot.queue.counts" :key="state">
                <strong><animated-counter :target-value="value" /></strong>
                <span>{{ state }}</span>
              </div>
            </div>
            <p class="system-note">
              <animated-counter :target-value="snapshot.queue.due" /> pending jobs are due. Terminal records are normally retained for 30 days after completion; totals
              describe retained jobs, not all-time activity.
            </p>
            <div class="system-section-head">
              <h3>
                Needs attention
                <span><animated-counter :target-value="snapshot.queue.totalAttention" /></span>
              </h3>
              <v-text-field
                v-if="snapshot.queue.attention.length"
                v-model="jobQuery"
                label="Find an attention record"
                prepend-inner-icon="mdi-magnify"
                variant="outlined"
                density="compact"
                hide-details
                class="system-job-search"
              />
            </div>
            <p class="system-note">
              Failed jobs, expired running leases and pending/running job versions unsupported by this process. Showing the latest
              {{ snapshot.queue.attention.length }} of <animated-counter :target-value="snapshot.queue.totalAttention" /> records; categories may overlap.
            </p>
            <div v-if="!attentionRows.length" class="system-empty">
              <v-icon :icon="jobQuery ? 'mdi-filter-outline' : 'mdi-check-circle-outline'" size="32" />
              <h4>{{ jobQuery ? 'No matching attention records' : 'No retained jobs need attention' }}</h4>
              <p>
                {{
                  jobQuery
                    ? 'Search applies to the latest records shown here.'
                    : 'No failed jobs, expired leases or unsupported pending/running versions were observed.'
                }}
              </p>
              <v-btn v-if="jobQuery" variant="text" @click="jobQuery = ''">Clear search</v-btn>
            </div>
            <div v-else class="system-attention">
              <article v-for="job in attentionRows" :key="job.id">
                <div class="system-section-head">
                  <h4>
                    {{ job.type }}
                    <small>v{{ job.version }}</small>
                  </h4>
                  <span class="system-state">{{ reasonLabel(job.reason) }}</span>
                </div>
                <p>{{ job.attempts }} / {{ job.maxAttempts }} attempts · {{ job.state }} · updated {{ dateTime(job.updatedAt) }}</p>
                <code>{{ job.id }}</code>
                <p class="system-note">{{ reasonHelp(job.reason) }}</p>
                <v-btn v-if="systemJobDestination(job.type)" :to="systemJobDestination(job.type)!.path" variant="text" append-icon="mdi-arrow-right">
                  Open {{ systemJobDestination(job.type)!.title }}
                </v-btn>
              </article>
            </div>
          </template>
          <template v-else>
            <div class="system-heading">
              <span class="system-kicker">04 / Evidence you can share</span>
              <h2>A useful support report</h2>
              <p>Inspect a point-in-time report before downloading or copying it. Sharing remains your choice.</p>
            </div>
            <div class="system-section-head">
              <h3>Database &amp; schema</h3>
              <span>{{ snapshot.database.version }}</span>
            </div>
            <p class="system-note">
              The version query completed in {{ snapshot.database.latencyMs }} ms after authorization. Migration names are compared with this build's
              migration inventory; this is not a schema integrity or backup verification.
            </p>
            <div class="system-migration-summary">
              <span><animated-counter :target-value="snapshot.database.migrations.applied.length" /> applied</span>
              <span><animated-counter :target-value="snapshot.database.migrations.pending.length" /> pending</span>
              <span><animated-counter :target-value="snapshot.database.migrations.unknown.length" /> absent from build</span>
            </div>
            <details class="system-details">
              <summary>Inspect migration inventory</summary>
              <div v-for="group in migrationGroups" :key="group.title">
                <h4>{{ group.title }}</h4>
                <ul v-if="group.items.length">
                  <li v-for="name in group.items" :key="name">
                    <code>{{ name }}</code>
                  </li>
                </ul>
                <p v-else>None</p>
              </div>
            </details>
            <div class="system-report-controls">
              <h3>Report contents</h3>
              <p>
                Includes build identity, process measurements, database version/migrations, scheduler observations and queue totals. Durable job
                identifiers, payloads and raw failures are omitted.
              </p>
              <v-checkbox
                v-model="includeDeployment"
                label="Include deployment identifiers"
                hint="Adds the instance ID, hostname, filesystem paths, public origin and database host shown in Runtime."
                persistent-hint
                density="compact"
              />
              <div class="system-actions">
                <v-btn color="primary" prepend-icon="mdi-download" @click="downloadReport">Download JSON</v-btn>
                <v-btn variant="outlined" prepend-icon="mdi-content-copy" @click="copyReport">Copy report</v-btn>
              </div>
              <p v-if="copyError" class="system-warning" role="alert">{{ copyError }}</p>
            </div>
            <details class="system-details" :open="includeDeployment">
              <summary>Inspect exact report</summary>
              <pre class="system-report" tabindex="0" aria-label="Exact support report">{{ reportText }}</pre>
            </details>
            <p class="system-note">
              The report uses the observation timestamp above. Refresh to collect a new snapshot. No report is uploaded or stored by this screen.
            </p>
          </template>
        </section>
        <aside class="system-aside">
          <span class="system-kicker">At this observation</span>
          <dl>
            <dt>Database</dt>
            <dd>Responded</dd>
            <dt>Process scheduler</dt>
            <dd>{{ snapshot.scheduler.started ? 'Started' : 'Not started' }}</dd>
            <dt>Offline mode</dt>
            <dd>{{ snapshot.runtime.offline ? 'Enabled' : 'Disabled' }}</dd>
            <dt>Pending work</dt>
            <dd><animated-counter :target-value="snapshot.queue.counts.pending" /></dd>
            <dt>Attention records</dt>
            <dd><animated-counter :target-value="snapshot.queue.totalAttention" /></dd>
          </dl>
          <div>
            <h3>One process, one moment</h3>
            <p>Measurements stay fixed until you refresh. A deployment may have other application processes; this screen does not enumerate them.</p>
          </div>
          <div>
            <h3>Deployment ownership</h3>
            <p>
              Build {{ snapshot.product.revision.slice(0, 8) }} is an independent fork of {{ snapshot.product.upstreamBase }}. Updates use your
              deployment workflow; no fork-owned update provider is configured.
            </p>
          </div>
          <div>
            <h3>Related operations</h3>
            <router-link to="/a/storage">
              Storage &amp; recovery
              <v-icon size="16" icon="mdi-arrow-right" />
            </router-link>
            <router-link to="/a/logging">
              Logging
              <v-icon size="16" icon="mdi-arrow-right" />
            </router-link>
            <router-link to="/a/utilities">
              Maintenance utilities
              <v-icon size="16" icon="mdi-arrow-right" />
            </router-link>
          </div>
        </aside>
      </div>
    </template>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AsyncState from '../common/async-state.vue'
import CyberneticHardwareGauge from './system/cybernetic-hardware-gauge.vue'
import HardwareTelemetryCard from './system/hardware-telemetry-card.vue'
import RadarPulseBeacon from '@/components/admin/security/radar-pulse-beacon.vue'
import AnimatedCounter from '@/components/admin/security/animated-counter.vue'
import { fetchSystemWorkspace } from '../../helpers/system-workspace-api.ts'
import { systemJobDestination, systemSupportReport, type SystemWorkspace } from '../../../shared/system-workspace.ts'
const sections = [
  { key: 'overview', title: 'Overview' },
  { key: 'runtime', title: 'Runtime' },
  { key: 'background', title: 'Background work' },
  { key: 'diagnostics', title: 'Diagnostics' }
] as const
type Section = (typeof sections)[number]['key']
const route = useRoute(),
  router = useRouter(),
  snapshot = shallowRef<SystemWorkspace | null>(null),
  loading = ref(false),
  error = ref(''),
  notice = ref(''),
  jobQuery = ref(''),
  includeDeployment = ref(false),
  copyError = ref('')
let controller: AbortController | null = null
const section = computed<Section>(() => sections.find((tab) => tab.key === route.query.section)?.key ?? 'overview')
const selectSection = (key: Section) => router.replace({ query: { ...route.query, section: key === 'overview' ? undefined : key } })
const dateTime = (value: string) => new Date(value).toLocaleString()
const number = (value: number) => value.toLocaleString()
const bytes = (value: number) => {
  if (value < 1024) return `${value} B`
  const i = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** i).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][i]}`
}
const duration = (seconds: number) => {
  const days = Math.floor(seconds / 86400),
    hours = Math.floor(seconds / 3600) % 24,
    minutes = Math.floor(seconds / 60) % 60
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m ${Math.floor(seconds) % 60}s`
}
const listener = (value: number | null) => (value === null ? 'No TCP listener observed' : `Listening on port ${value}`)
const attentionRows = computed(
  () =>
    snapshot.value?.queue.attention.filter((job) =>
      `${job.id} ${job.type} ${job.state} ${reasonLabel(job.reason)}`.toLowerCase().includes(jobQuery.value.trim().toLowerCase())
    ) ?? []
)
const reasonLabel = (reason: string) => ({ failed: 'Failed', 'expired-lease': 'Expired lease', unsupported: 'Unsupported version' })[reason] || reason
const reasonHelp = (reason: string) =>
  reason === 'failed'
    ? 'Review the owning workflow before retrying. This overview never replays side effects.'
    : reason === 'expired-lease'
      ? 'The lease deadline has passed. A compatible worker may reclaim the job if attempts remain; an expired lease is not proof that an external action did not occur.'
      : 'This process has no handler for this type and version. Check the deployed revision and the workflow that created the job.'
const signals = computed(() => {
  const w = snapshot.value
  if (!w) return []
  return [
    {
      title: 'PostgreSQL responded',
      detail: `A fresh version query completed in ${w.database.latencyMs} ms.`,
      attention: false,
      section: 'diagnostics' as Section
    },
    {
      title:
        w.database.migrations.pending.length || w.database.migrations.unknown.length
          ? 'Migration inventory needs review'
          : 'Migration inventory matches',
      detail: `${w.database.migrations.applied.length} applied · ${w.database.migrations.pending.length} pending · ${w.database.migrations.unknown.length} absent from this build`,
      attention: Boolean(w.database.migrations.pending.length || w.database.migrations.unknown.length),
      section: 'diagnostics' as Section
    },
    {
      title: w.scheduler.started ? 'Process scheduler started' : 'Process scheduler is not started',
      detail: `${w.scheduler.jobs.filter((j) => j.state === 'running').length} running now · ${w.scheduler.jobs.filter((j) => j.lastOutcome === 'failed').length} tasks with a failed last invocation`,
      attention: !w.scheduler.started || w.scheduler.jobs.some((j) => j.lastOutcome === 'failed'),
      section: 'background' as Section
    },
    {
      title: w.queue.totalAttention ? 'Durable work needs attention' : 'No durable attention records',
      detail: `${w.queue.counts.failed} failed · ${w.queue.expiredLeases} expired leases · ${w.queue.unsupported} unsupported pending/running versions`,
      attention: w.queue.totalAttention > 0,
      section: 'background' as Section
    }
  ]
})
const runtimeFacts = computed(() => {
  const r = snapshot.value?.runtime
  if (!r) return []
  return [
    { label: 'Runtime', value: `Bun ${r.bunVersion}` },
    { label: 'Platform', value: `${r.platform} · ${r.architecture}${r.container ? ' · Docker marker present' : ''}` },
    { label: 'Kernel', value: r.kernel, mono: true },
    { label: 'Logical CPUs visible to OS', value: String(r.logicalCpuCount) },
    { label: 'Available parallelism', value: r.availableParallelism === null ? 'Unavailable' : String(r.availableParallelism) },
    { label: 'Memory visible to OS', value: bytes(r.systemMemoryBytes) },
    { label: 'Instance ID', value: r.instanceId, mono: true },
    { label: 'Hostname', value: r.hostname, mono: true },
    { label: 'Working directory', value: r.workingDirectory, mono: true },
    { label: 'Configuration source', value: r.configFile, mono: true },
    { label: 'Database host', value: snapshot.value!.database.host, mono: true }
  ]
})
const migrationGroups = computed(() => {
  const m = snapshot.value?.database.migrations
  return m
    ? [
        { title: 'Pending in this build', items: m.pending },
        { title: 'Applied but absent from this build', items: m.unknown },
        { title: 'Applied migrations', items: m.applied }
      ]
    : []
})
const reportText = computed(() => (snapshot.value ? JSON.stringify(systemSupportReport(snapshot.value, includeDeployment.value), null, 2) : ''))
async function load() {
  controller?.abort()
  const current = new AbortController()
  controller = current
  loading.value = true
  error.value = ''
  notice.value = ''
  copyError.value = ''
  try {
    const result = await fetchSystemWorkspace(current.signal)
    if (!current.signal.aborted) snapshot.value = result
  } catch (e) {
    if (!current.signal.aborted) error.value = e instanceof Error ? e.message : 'System observations could not be collected.'
  } finally {
    if (controller === current) {
      loading.value = false
      controller = null
    }
  }
}
function downloadReport() {
  const url = URL.createObjectURL(new Blob([reportText.value + '\n'], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `tsepistle-system-${snapshot.value!.observedAt.replace(/[:.]/g, '-')}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  notice.value = 'Support report downloaded.'
}
async function copyReport() {
  copyError.value = ''
  try {
    await navigator.clipboard.writeText(reportText.value)
    notice.value = 'Support report copied.'
  } catch {
    copyError.value = 'Clipboard access is unavailable. Download the JSON report or select its text in the preview.'
  }
}
onMounted(load)
onBeforeUnmount(() => controller?.abort())
</script>

<style lang="scss">
.system-workspace {
  --system-line: rgba(var(--v-theme-on-surface), 0.16);
  .system-observed {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    font-size: 0.78rem;
    margin: 1.5rem 0 1.7rem;
    span {
      display: flex;
      align-items: center;
      gap: 0.55rem;
    }
    i {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: rgb(var(--v-theme-success));
      &.is-stale {
        background: rgb(var(--v-theme-warning));
      }
    }
  }
  .system-tabs {
    display: flex;
    gap: 1.6rem;
    border-bottom: 1px solid var(--system-line);
    margin-bottom: 2.75rem;
    overflow-x: auto;
    button {
      appearance: none;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      font-size: 0.87rem;
      padding: 0.8rem 0 1rem;
      white-space: nowrap;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      &[aria-current] {
        border-color: var(--wiki-accent-ink);
      }
      &:focus-visible {
        outline: 2px solid var(--wiki-accent-ink);
        outline-offset: -2px;
      }
    }
  }
  .system-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 246px;
    gap: 3rem;
  }
  .system-main {
    min-width: 0;
  }
  .system-kicker {
    display: block;
    font-size: 0.66rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-weight: 700;
    line-height: 1.6;
  }
  .system-heading {
    margin-bottom: 2.2rem;
    h2 {
      font-family: var(--wiki-font-display);
      font-size: clamp(2rem, 3.3vw, 3.4rem);
      line-height: 1.12;
      letter-spacing: -0.025em;
      font-weight: 500;
      margin: 0.7rem 0 1.4rem;
    }
    p {
      font-size: 1rem;
      line-height: 1.8;
      max-width: 65ch;
      color: rgba(var(--v-theme-on-surface), 0.78);
    }
  }
  .system-release {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: 2rem;
    padding: 1.8rem 0;
    border-top: 1px solid var(--system-line);
    border-bottom: 1px solid var(--system-line);
    h3 {
      font-family: var(--wiki-font-display);
      font-size: 2rem;
      font-weight: 500;
      margin: 0.4rem 0;
    }
    a {
      font-size: 0.85rem;
      color: var(--wiki-accent-ink);
    }
    strong {
      display: block;
      font-family: var(--wiki-font-display);
      font-weight: 500;
      font-size: 2.5rem;
      margin: 0.15rem 0;
    }
    span:not(.system-kicker),
    small {
      font-size: 0.8rem;
    }
  }
  .system-uptime-label {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
  }
  .system-telemetry-row {
    display: flex;
    align-items: center;
    gap: 2.5rem;
    flex-wrap: wrap;

    .system-metrics--telemetry {
      flex: 1;
      min-width: 260px;
      border-block: 0;
      padding: 0;
    }
  }
  .system-telemetry-status {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.72rem;
    color: rgba(var(--v-theme-on-surface), 0.7);
  }
  .system-section-title {
    font-size: 1rem;
    margin: 2rem 0 1rem;
  }
  .system-signals article {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
    padding: 1.3rem 0;
    border-bottom: 1px solid var(--system-line);
    > div {
      flex: 1;
      min-width: 0;
    }
    h4 {
      font-size: 0.94rem;
      font-weight: 650;
    }
    p {
      font-size: 0.82rem;
      line-height: 1.7;
      margin: 0.35rem 0 0;
      color: rgba(var(--v-theme-on-surface), 0.74);
    }
  }
  .system-positive {
    color: rgb(var(--v-theme-success));
  }
  .system-warning {
    color: rgb(var(--v-theme-warning));
  }
  .system-callout {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
    padding: 1.25rem;
    margin: 1.5rem 0;
    background: rgba(var(--v-theme-on-surface), 0.035);
    border: 1px solid var(--system-line);
    border-radius: 8px;
    p {
      font-size: 0.83rem;
      line-height: 1.75;
      margin: 0;
    }
  }
  .system-metrics {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2rem;
    padding: 1.6rem 0;
    border-block: 1px solid var(--system-line);
    span,
    small {
      display: block;
      font-size: 0.78rem;
    }
    strong {
      display: block;
      font-family: var(--wiki-font-display);
      font-size: clamp(1.8rem, 3vw, 2.5rem);
      font-weight: 500;
      margin: 0.3rem 0;
    }
  }
  .system-facts {
    display: grid;
    grid-template-columns: minmax(140px, 1fr) minmax(0, 1.5fr);
    font-size: 0.85rem;
    line-height: 1.65;
    dt,
    dd {
      margin: 0;
      padding: 0.8rem 0;
      border-bottom: 1px solid var(--system-line);
    }
    dt {
      color: rgba(var(--v-theme-on-surface), 0.7);
      padding-right: 1rem;
    }
    dd {
      overflow-wrap: anywhere;
    }
  }
  .system-mono,
  code,
  .system-report {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  }
  .system-note {
    font-size: 0.78rem;
    line-height: 1.75;
    color: rgba(var(--v-theme-on-surface), 0.73);
    margin: 1rem 0;
  }
  .system-table-wrap {
    overflow-x: auto;
    border: 1px solid var(--system-line);
    border-radius: 8px;
    &:focus-visible {
      outline: 2px solid var(--wiki-accent-ink);
      outline-offset: 3px;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      min-width: 680px;
      font-size: 0.78rem;
      line-height: 1.6;
    }
    th,
    td {
      text-align: left;
      vertical-align: top;
      padding: 1rem;
      border-bottom: 1px solid var(--system-line);
    }
    thead th {
      font-size: 0.7rem;
      letter-spacing: 0.04em;
      background: rgba(var(--v-theme-on-surface), 0.04);
    }
    tbody th {
      font-weight: 500;
      min-width: 180px;
    }
    small {
      display: block;
      font-size: 0.69rem;
      color: rgba(var(--v-theme-on-surface), 0.7);
      font-weight: 400;
      margin-top: 0.2rem;
    }
    tr:last-child td,
    tr:last-child th {
      border-bottom: 0;
    }
  }
  .system-state {
    display: inline-block;
    font-size: 0.72rem;
    line-height: 1.6;
    border: 1px solid var(--system-line);
    border-radius: 5px;
    padding: 0.1rem 0.45rem;
    text-transform: capitalize;
  }
  .system-queue-counts {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 1rem;
    border-block: 1px solid var(--system-line);
    padding: 1.4rem 0;
    strong {
      display: block;
      font-family: var(--wiki-font-display);
      font-weight: 500;
      font-size: 2.2rem;
    }
    span {
      font-size: 0.73rem;
      text-transform: capitalize;
    }
  }
  .system-section-head {
    display: flex;
    gap: 1rem;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    margin: 1.8rem 0 1rem;
    h3 {
      font-size: 1rem;
      span {
        margin-left: 0.5rem;
        color: rgba(var(--v-theme-on-surface), 0.6);
      }
    }
    h4 {
      font-size: 0.93rem;
      overflow-wrap: anywhere;
      small {
        font-size: 0.7rem;
        font-weight: 400;
      }
    }
  }
  .system-job-search {
    flex: 0 1 280px;
    min-width: 210px;
  }
  .system-attention article {
    padding: 1.3rem 0;
    border-top: 1px solid var(--system-line);
    .system-section-head {
      margin: 0 0 0.5rem;
    }
    p {
      font-size: 0.79rem;
      line-height: 1.7;
    }
    code {
      font-size: 0.73rem;
      overflow-wrap: anywhere;
    }
  }
  .system-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.8rem;
    border: 1px dashed var(--system-line);
    padding: 1.5rem;
    border-radius: 8px;
    h4 {
      font-size: 1rem;
    }
    p {
      font-size: 0.82rem;
      line-height: 1.8;
      margin: 0;
    }
  }
  .system-migration-summary {
    display: flex;
    gap: 1.4rem;
    flex-wrap: wrap;
    font-size: 0.82rem;
    padding: 1rem 0;
    border-block: 1px solid var(--system-line);
  }
  .system-details {
    border-bottom: 1px solid var(--system-line);
    padding: 1rem 0;
    summary {
      font-size: 0.86rem;
      font-weight: 600;
      cursor: pointer;
      padding: 0.25rem 0;
      &:focus-visible {
        outline: 2px solid var(--wiki-accent-ink);
        outline-offset: 4px;
      }
    }
    h4 {
      margin: 1.25rem 0 0.65rem;
      font-size: 0.85rem;
    }
    li,
    p {
      font-size: 0.74rem;
      line-height: 1.8;
      overflow-wrap: anywhere;
    }
    ul {
      padding-left: 1.2rem;
    }
  }
  .system-report-controls {
    margin: 2rem 0;
    h3 {
      font-size: 1rem;
    }
    p {
      font-size: 0.83rem;
      line-height: 1.8;
      margin: 0.8rem 0;
    }
    .v-input {
      margin: 1.3rem 0;
    }
  }
  .system-actions {
    display: flex;
    gap: 0.8rem;
    flex-wrap: wrap;
  }
  .system-report {
    font-size: 0.72rem;
    line-height: 1.7;
    max-height: 480px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: rgba(var(--v-theme-on-surface), 0.035);
    padding: 1rem;
    border-radius: 6px;
    margin-top: 1rem;
    &:focus-visible {
      outline: 2px solid var(--wiki-accent-ink);
      outline-offset: 2px;
    }
  }
  .system-aside {
    min-width: 0;
    dl {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 1.15rem;
      font-size: 0.76rem;
      border-block: 1px solid var(--system-line);
      padding: 1.8rem 0;
      margin: 1.4rem 0;
    }
    dt {
      color: rgba(var(--v-theme-on-surface), 0.73);
    }
    dd {
      margin: 0;
      text-align: right;
      font-weight: 600;
    }
    > div {
      padding: 1.5rem 0;
      border-bottom: 1px solid var(--system-line);
    }
    h3 {
      font-size: 0.86rem;
      margin-bottom: 0.65rem;
    }
    p {
      font-size: 0.77rem;
      line-height: 1.8;
      color: rgba(var(--v-theme-on-surface), 0.73);
    }
    a {
      display: flex;
      justify-content: space-between;
      gap: 0.7rem;
      font-size: 0.8rem;
      color: inherit;
      text-decoration: none;
      padding: 0.65rem 0;
      &:hover {
        text-decoration: underline;
      }
    }
  }
  @media (max-width: 1200px) {
    .system-layout {
      grid-template-columns: minmax(0, 1fr);
    }
    .system-aside {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 1.5rem;
      > .system-kicker {
        grid-column: 1/-1;
      }
      dl {
        margin: 0;
      }
    }
  }
  @media (max-width: 600px) {
    .system-layout {
      gap: 2rem;
    }
    .system-tabs {
      gap: 1.3rem;
      margin-bottom: 2rem;
    }
    .system-release {
      grid-template-columns: 1fr;
      gap: 1.4rem;
    }
    .system-metrics {
      gap: 1rem;
    }
    .system-telemetry-row {
      flex-direction: column;
      align-items: center;
      gap: 1.5rem;
      .system-metrics--telemetry {
        width: 100%;
      }
    }
    .system-facts {
      grid-template-columns: 1fr;
      dt {
        border: 0;
        padding-bottom: 0.1rem;
      }
      dd {
        padding-top: 0.1rem;
      }
    }
    .system-queue-counts {
      grid-template-columns: repeat(3, 1fr);
    }
    .system-aside {
      grid-template-columns: 1fr;
      gap: 0.8rem;
    }
    .system-signals article {
      gap: 0.7rem;
      flex-wrap: wrap;
      .v-btn {
        margin-left: 2.2rem;
      }
    }
    .system-section-head .system-job-search {
      flex-basis: 100%;
    }
    .system-observed {
      font-size: 0.73rem;
    }
    .system-heading h2 br {
      display: none;
    }
  }
}
</style>
