<template>
  <v-container fluid class="analytics-workspace">
    <admin-hero icon="mdi-chart-areaspline" title="Analytics" description="Understand your readers. Be deliberate about what you measure.">
      <template #actions>
        <v-btn variant="text" prepend-icon="mdi-refresh" :disabled="busy || loading" @click="reload">Reload workspace</v-btn>
        <v-btn v-if="dirty" variant="text" :disabled="locked" @click="reset">Reset draft</v-btn>
        <v-btn color="primary" :disabled="locked || !dirty" @click="review">Review changes</v-btn>
      </template>
    </admin-hero>
    <async-state
      v-if="loading && !saved"
      state="loading"
      title="Loading Analytics"
      message="Reading collection policy, integrations and recorded responses."
    />
    <async-state
      v-else-if="error && !saved"
      state="error"
      title="Analytics could not be loaded"
      :message="error"
      retry-label="Try again"
      @retry="load"
    />
    <v-alert v-else-if="error" type="error" variant="tonal" class="mb-5">{{ error }}</v-alert>
    <v-alert v-if="stale" type="warning" variant="tonal" class="mb-5">
      The saved state changed or an action is unconfirmed. Reload before another publication.
    </v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" class="mb-5">{{ notice }}</v-alert>
    <template v-if="saved && policy">
      <div class="analytics-status">
        <span>
          <i :class="{ 'is-draft': dirty }" />
          {{ dirty ? 'Unsaved analytics draft' : 'Showing saved settings' }}
        </span>
        <span>Observed {{ dateTime(saved.observedAt) }}</span>
      </div>
      <nav class="analytics-tabs" aria-label="Analytics sections">
        <button
          v-for="tab in sections"
          :key="tab.key"
          type="button"
          :aria-current="section === tab.key ? 'page' : undefined"
          :disabled="busy"
          @click="selectSection(tab.key)"
        >
          {{ tab.title }}
        </button>
      </nav>
      <div class="analytics-layout">
        <section class="analytics-main">
          <template v-if="section === 'overview'">
            <div class="analytics-heading">
              <span class="analytics-kicker">01 / A reading pulse</span>
              <h2>Knowledge in use</h2>
              <p>Local evidence from completed reader responses. External services keep their own reports.</p>
            </div>
            <div class="analytics-metrics">
              <div>
                <span>Recorded reader responses</span>
                <strong><animated-number :value="saved.insights.totalResponses" :duration="700" :format-value="number" /></strong>
                <small>{{ saved.insights.from }} — {{ saved.insights.through }} · UTC</small>
              </div>
              <div>
                <span>Shared pages reached</span>
                <strong><animated-number :value="saved.insights.pages" :duration="700" :format-value="number" /></strong>
                <small>Current published, unprotected pages</small>
              </div>
            </div>
            <div class="analytics-section-head">
              <h3>Daily response history</h3>
              <v-select
                :model-value="reportDays"
                :items="reportWindows"
                label="Reporting window"
                variant="outlined"
                density="compact"
                hide-details
                class="analytics-window"
                :disabled="locked"
                @update:model-value="selectWindow"
              />
              <v-btn variant="text" prepend-icon="mdi-download" :disabled="!saved.insights.daily.length" @click="exportCounts">Export counts</v-btn>
            </div>
            <div v-if="!saved.insights.totalResponses" class="analytics-empty">
              <v-icon size="36" icon="mdi-chart-timeline-variant" />
              <h3>No reader responses recorded</h3>
              <p>
                {{
                  saved.policy.localEnabled
                    ? 'Eligible responses will appear after readers open pages. Reload this workspace to observe new counts.'
                    : 'Local counts are paused. Enable them in Collection when you are ready to measure reader activity.'
                }}
              </p>
              <v-btn variant="outlined" @click="selectSection('collection')">Review collection policy</v-btn>
            </div>
            <figure v-else class="analytics-chart">
              <svg
                class="analytics-chart-svg"
                viewBox="0 0 720 180"
                role="img"
                aria-label="Daily recorded reader responses. Exact counts are available in the table below."
                preserveAspectRatio="none"
                @pointermove="handleChartPointer"
                @pointerleave="clearChartPointer"
              >
                <defs>
                  <linearGradient :id="barGradId" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="rgb(var(--v-theme-primary))" stop-opacity="1" />
                    <stop offset="50%" stop-color="color-mix(in srgb, rgb(var(--v-theme-primary)) 85%, white 15%)" stop-opacity="0.9" />
                    <stop offset="100%" stop-color="rgb(var(--v-theme-primary))" stop-opacity="0.4" />
                  </linearGradient>
                  <filter :id="barGlowId" x="-20%" y="-20%" width="140%" height="140%">
                    <feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="rgb(var(--v-theme-primary))" flood-opacity="0.45" />
                  </filter>
                </defs>
                <line x1="0" y1="169" x2="720" y2="169" class="chart-baseline" />
                <rect
                  v-for="bar in bars"
                  :key="bar.day"
                  class="analytics-bar"
                  :class="{ 'is-active': activeBar?.day === bar.day }"
                  :x="bar.x"
                  :y="169 - bar.height"
                  :width="bar.width"
                  :height="bar.height"
                  rx="3"
                  ry="3"
                  :fill="`url(#${barGradId})`"
                  :filter="`url(#${barGlowId})`"
                  tabindex="0"
                  role="graphics-symbol"
                  :aria-label="`${bar.day}: ${number(bar.responses)} responses`"
                  @focus="activeBar = bar"
                  @blur="clearChartPointer"
                >
                  <title>{{ bar.day }}: {{ number(bar.responses) }} responses</title>
                </rect>
                <line
                  v-if="activeBar"
                  class="chart-laser-line"
                  :x1="activeBar.x + activeBar.width / 2"
                  y1="8"
                  :x2="activeBar.x + activeBar.width / 2"
                  y2="169"
                />
                <circle
                  v-if="activeBar"
                  class="chart-datum-point"
                  :cx="activeBar.x + activeBar.width / 2"
                  :cy="169 - activeBar.height"
                  r="4.5"
                />
              </svg>
              <div
                v-if="activeBar"
                class="chart-hud-tooltip analytics-chart-tooltip"
                :style="tooltipStyle"
                role="tooltip"
                aria-live="polite"
              >
                <span class="chart-hud-tooltip__day tooltip-day">{{ activeBar.day }}</span>
                <span class="chart-hud-tooltip__count tooltip-responses">
                  <strong>{{ number(activeBar.responses) }}</strong> responses
                </span>
                <span class="chart-hud-tooltip__pct tooltip-pct">{{ activeBar.pct }}% of max</span>
              </div>
              <figcaption>
                <span>{{ saved.insights.from }}</span>
                <span>{{ saved.insights.through }}</span>
              </figcaption>
            </figure>
            <details v-if="saved.insights.daily.length" class="analytics-detail-table">
              <summary>View exact daily counts</summary>
              <div class="analytics-table-scroll" tabindex="0" role="region" aria-label="Daily response counts">
                <table>
                  <caption class="sr-only">Recorded responses by UTC day</caption>
                  <thead>
                    <tr>
                      <th scope="col">Day</th>
                      <th scope="col">Responses</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in saved.insights.daily" :key="row.day">
                      <th scope="row">{{ row.day }}</th>
                      <td>{{ number(row.responses) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </details>
            <div class="analytics-section-head">
              <div>
                <h3>Most-read shared pages</h3>
                <p>Up to 15 pages in the retained window.</p>
              </div>
            </div>
            <div v-if="saved.insights.topPages.length" class="analytics-ranked">
              <a v-for="(page, index) in saved.insights.topPages" :key="page.id" :href="`/i/${page.id}`">
                <span class="analytics-rank">{{ String(index + 1).padStart(2, '0') }}</span>
                <span>
                  <strong>{{ page.title }}</strong>
                  <small>{{ page.locale }} / {{ page.path }}</small>
                </span>
                <b>{{ number(page.responses) }}</b>
                <v-icon icon="mdi-arrow-top-right" size="18" />
              </a>
            </div>
            <p v-else class="analytics-muted">Page rankings appear when eligible responses have been recorded.</p>
            <p class="analytics-footnote">
              Counts can include automated requests and repeat loads; they are not unique visitors or confirmed human views. Recording is best effort
              after a successful response. Personal, unpublished and password-protected pages are excluded. A page removed from the eligible inventory
              no longer appears in these reports.
            </p>
          </template>
          <template v-else-if="section === 'collection'">
            <div class="analytics-heading">
              <span class="analytics-kicker">02 / Intentional measurement</span>
              <h2>Choose what counts</h2>
              <p>One policy governs local counters and external integrations on eligible reader pages.</p>
            </div>
            <div class="analytics-setting">
              <div>
                <h3>Local reader counts</h3>
                <p>
                  Store a daily count per page in this wiki. No visitor identity, IP address, referrer, session or query string is stored in these
                  counters.
                </p>
              </div>
              <v-switch v-model="policy.localEnabled" label="Record local reader counts" color="primary" hide-details :disabled="locked" />
            </div>
            <div class="analytics-setting">
              <div>
                <h3>External integrations</h3>
                <p>
                  Allow enabled providers to embed their browser scripts. Their own configuration controls what they collect, including URLs or page
                  content.
                </p>
              </div>
              <v-switch v-model="policy.externalEnabled" label="Allow external integrations" color="primary" hide-details :disabled="locked" />
            </div>
            <v-alert v-if="saved.offline" type="info" variant="tonal" class="mb-5">
              Offline mode suspends external integrations. Local counters can still operate.
            </v-alert>
            <div class="analytics-setting">
              <div>
                <h3>Reader audience</h3>
                <p>
                  Applies only to published shared pages that the reader can already access. Administration, sign-in, editing and personal pages never
                  embed tracking.
                </p>
              </div>
              <v-select
                v-model="policy.audience"
                :items="audiences"
                label="Measure responses from"
                variant="outlined"
                hide-details
                :disabled="locked"
              />
            </div>
            <div class="analytics-setting">
              <div>
                <h3>Keep administration out</h3>
                <p>Exclude reader requests made by accounts with system administration access.</p>
              </div>
              <v-switch
                v-model="policy.excludeAdministrators"
                label="Exclude system administrators"
                color="primary"
                hide-details
                :disabled="locked"
              />
            </div>
            <div class="analytics-setting">
              <div>
                <h3>Respect request privacy signals</h3>
                <p>Skip both local and external collection when a request sends Do Not Track or Global Privacy Control.</p>
              </div>
              <v-switch v-model="policy.respectPrivacySignals" label="Honor DNT and GPC headers" color="primary" hide-details :disabled="locked" />
            </div>
            <div class="analytics-setting analytics-setting-wide">
              <div>
                <h3>Excluded paths and sections</h3>
                <p>
                  One literal page path per line, without its language prefix. “handbook” excludes that page and its descendants; “/” excludes every
                  page. These are not regular expressions.
                </p>
              </div>
              <v-textarea
                v-model="excludedText"
                label="Excluded page paths"
                variant="outlined"
                rows="3"
                auto-grow
                :disabled="locked"
                :error-messages="policyErrors"
              />
            </div>
            <div class="analytics-setting">
              <div>
                <h3>Local retention</h3>
                <p>
                  The report uses this inclusive UTC window. Hourly cleanup removes older counters, even while collection is paused. Reducing
                  retention can permanently remove older counts.
                </p>
              </div>
              <v-select
                v-model="policy.retentionDays"
                :items="[
                  { title: '30 days', value: 30 },
                  { title: '90 days', value: 90 },
                  { title: '365 days', value: 365 }
                ]"
                label="Retain local counts for"
                variant="outlined"
                hide-details
                :disabled="locked"
              />
            </div>
            <div class="analytics-section-head">
              <div>
                <h3>Collection preview</h3>
                <p>A simulation of this draft, not a live traffic test.</p>
              </div>
            </div>
            <div class="analytics-simulator">
              <v-text-field v-model="simulation.path" label="Example page path" variant="outlined" hide-details />
              <v-select
                v-model="simulation.reader"
                :items="[
                  { title: 'Anonymous reader', value: 'anonymous' },
                  { title: 'Signed-in reader', value: 'signed-in' },
                  { title: 'System administrator', value: 'administrator' }
                ]"
                label="Example reader"
                variant="outlined"
                hide-details
              />
              <v-checkbox v-model="simulation.privacySignal" label="Request sends DNT or GPC" hide-details />
              <div role="status" class="analytics-simulation-result">
                <strong>
                  Local: {{ simulationResult.local ? 'eligible' : 'excluded' }} · External: {{ simulationResult.external ? 'eligible' : 'excluded' }}
                </strong>
                <p>{{ simulationResult.reason }} Enabled, valid providers are also required for external embedding.</p>
              </div>
            </div>
            <div class="analytics-erasure">
              <div>
                <h3>Erase local history</h3>
                <p>Remove all stored local counters. Provider data is managed in each external service. Collection settings remain in effect.</p>
              </div>
              <v-btn variant="outlined" color="error" :disabled="locked || dirty" @click="openErase">Review erasure</v-btn>
            </div>
          </template>
          <template v-else-if="section === 'providers'">
            <div class="analytics-heading">
              <span class="analytics-kicker">03 / Deliberate connections</span>
              <h2>Give every integration a purpose</h2>
              <p>Configure providers independently. External collection must also be allowed in Collection.</p>
            </div>
            <div class="analytics-provider-filter">
              <v-text-field v-model="search" label="Find a provider" prepend-inner-icon="mdi-magnify" variant="outlined" hide-details clearable />
              <v-select v-model="category" :items="categories" label="Provider category" variant="outlined" hide-details />
            </div>
            <div class="analytics-provider-layout">
              <nav aria-label="Analytics providers" class="analytics-provider-list">
                <button
                  v-for="row in filteredProviders"
                  :key="row.key"
                  type="button"
                  :aria-current="selected === row.key ? 'true' : undefined"
                  :disabled="busy"
                  @click="selectProvider(row.key)"
                >
                  <v-icon :icon="categoryIcon(row.category)" />
                  <span>
                    <strong>{{ row.title }}</strong>
                    <small>{{ providerStatus(row.key) }}</small>
                  </span>
                  <v-icon icon="mdi-chevron-right" size="18" />
                </button>
                <p v-if="!filteredProviders.length" class="analytics-muted">No providers match. Try another name or category.</p>
              </nav>
              <article v-if="provider && providerDraft" class="analytics-provider-detail">
                <span class="analytics-kicker">{{ categoryLabel(provider.category) }}</span>
                <h3>{{ provider.title }}</h3>
                <p>{{ provider.description }}</p>
                <v-switch
                  v-model="providerDraft.isEnabled"
                  :label="`Enable ${provider.title}`"
                  color="primary"
                  hide-details
                  :disabled="locked || (!provider.isAvailable && !providerDraft.isEnabled)"
                />
                <div class="analytics-capabilities">
                  <span v-for="capability in provider.capabilities" :key="capability">{{ capability }}</span>
                </div>
                <v-alert v-if="!provider.isAvailable" type="warning" variant="tonal">
                  This integration is unavailable. A saved enablement can be turned off.
                </v-alert>
                <p class="analytics-compatibility">{{ provider.compatibility }}</p>
                <div class="analytics-provider-fields">
                  <v-text-field
                    v-for="field in provider.fields"
                    :key="field.key"
                    v-model="providerDraft.config[field.key]"
                    :label="field.title + (field.optional ? ' (optional)' : '')"
                    :hint="field.hint"
                    persistent-hint
                    variant="outlined"
                    :inputmode="field.kind === 'number' ? 'numeric' : field.kind === 'url' ? 'url' : 'text'"
                    :disabled="locked || !provider.isAvailable"
                  />
                </div>
                <div v-if="providerProblems.length" class="analytics-provider-problems" role="status">
                  <strong>{{ providerDraft.isEnabled ? 'Resolve before publication' : 'Needed before enabling' }}</strong>
                  <ul>
                    <li v-for="issue in providerProblems" :key="issue">{{ issue }}</li>
                  </ul>
                </div>
                <div class="analytics-hosts">
                  <h4>Declared script and configured hosts</h4>
                  <ul v-if="providerHosts.length">
                    <li v-for="host in providerHosts" :key="host">
                      <code>{{ host }}</code>
                    </li>
                  </ul>
                  <p v-else>Complete the server fields to see configured hosts.</p>
                  <small>SDKs and tag containers may contact additional destinations. This is configuration evidence, not a delivery test.</small>
                </div>
                <p class="analytics-footnote">
                  Tracking identifiers entered here are embedded in reader pages. Do not enter private API credentials. Cookies, consent and
                  downstream retention depend on the provider; this workspace does not add a consent banner.
                </p>
                <v-btn
                  v-if="provider.website"
                  :href="provider.website"
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="text"
                  append-icon="mdi-open-in-new"
                  :aria-label="`${provider.title} website — opens in a new tab`"
                >
                  Provider website
                </v-btn>
              </article>
              <div v-else class="analytics-empty">
                <h3>Select an integration</h3>
                <p>Choose a provider to inspect its configuration and collection behavior.</p>
              </div>
            </div>
          </template>
          <template v-else>
            <div class="analytics-heading">
              <span class="analytics-kicker">04 / An accountable record</span>
              <h2>Decisions, with context</h2>
              <p>The latest 50 collection changes and local-history erasures. Provider delivery and visitor activity are not recorded here.</p>
            </div>
            <div v-if="!saved.history.length" class="analytics-empty">
              <h3>No administrative activity yet</h3>
              <p>Publishing settings or erasing local counts adds an attributed receipt.</p>
            </div>
            <ol v-else class="analytics-history">
              <li v-for="event in saved.history" :key="event.id">
                <span class="analytics-event-icon"><v-icon :icon="event.kind === 'erase' ? 'mdi-delete-outline' : 'mdi-check'" /></span>
                <div>
                  <div class="analytics-section-head">
                    <h3>{{ event.kind === 'erase' ? 'Local history erased' : 'Analytics published' }}</h3>
                    <time :datetime="event.createdAt">{{ dateTime(event.createdAt) }}</time>
                  </div>
                  <p>{{ event.reason }}</p>
                  <small>
                    {{ event.actorId === null ? 'API principal' : `Account #${event.actorId}` }}
                    <template v-if="event.kind === 'erase'">· {{ number(event.erasedRows || 0) }} daily records removed</template>
                  </small>
                  <div class="analytics-event-fields">
                    <span v-for="field in event.fields" :key="field">{{ fieldLabel(field) }}</span>
                    <span v-for="key in event.providers" :key="key">{{ providerTitle(key) }}</span>
                  </div>
                </div>
              </li>
            </ol>
          </template>
        </section>
        <aside class="analytics-aside">
          <span class="analytics-kicker">Collection at a glance</span>
          <div class="analytics-policy-card">
            <div>
              <span>Local counts</span>
              <strong>{{ policy.localEnabled ? 'Enabled' : 'Paused' }}</strong>
            </div>
            <div>
              <span>External scripts</span>
              <strong>{{ saved.offline ? 'Offline' : policy.externalEnabled ? 'Allowed' : 'Paused' }}</strong>
            </div>
            <div>
              <span>Enabled providers</span>
              <strong>{{ enabledCount }}</strong>
            </div>
            <div>
              <span>Audience</span>
              <strong>{{ audiences.find((row) => row.value === policy!.audience)?.title }}</strong>
            </div>
            <div>
              <span>Retained history</span>
              <strong>{{ policy.retentionDays }} days</strong>
            </div>
          </div>
          <p v-if="dirty" class="analytics-footnote">This summary reflects your draft. Overview shows saved observations.</p>
          <div class="analytics-aside-note">
            <h3>Measure with context</h3>
            <p>
              Local counters describe recorded responses, not people. External tracking can observe more; choose integrations according to their
              actual purpose.
            </p>
          </div>
          <div class="analytics-aside-note">
            <h3>Publication</h3>
            <p>Settings apply on the next reader request. Already loaded provider scripts remain until that page is reloaded or left.</p>
          </div>
        </aside>
      </div>
    </template>
    <v-dialog v-model="reviewOpen" max-width="760" :persistent="busy" aria-labelledby="analytics-review-title">
      <v-card v-if="reviewDraft" class="analytics-dialog">
        <v-card-title id="analytics-review-title">Review analytics publication</v-card-title>
        <v-card-text>
          <p>Publish the collection policy and provider configuration together.</p>
          <dl class="analytics-review-list">
            <template v-for="change in reviewChanges" :key="change.key">
              <dt>{{ change.label }}</dt>
              <dd>
                <del>{{ change.before }}</del>
                <strong>{{ change.after }}</strong>
              </dd>
            </template>
          </dl>
          <div v-for="row in reviewProviders" :key="row.key" class="analytics-review-provider">
            <h3>{{ providerTitle(row.key) }}</h3>
            <p>{{ row.isEnabled ? 'Enabled' : 'Disabled' }}</p>
            <dl>
              <template v-for="field in changedProviderFields(row)" :key="field.key">
                <dt>{{ field.title }}</dt>
                <dd>
                  <del>{{ field.before || 'Empty' }}</del>
                  <strong>{{ field.after || 'Empty' }}</strong>
                </dd>
              </template>
            </dl>
          </div>
          <v-alert v-if="reviewDraft.policy.retentionDays < (saved?.policy.retentionDays || 0)" type="warning" variant="tonal" class="my-4">
            Older counters will leave the report immediately and be removed by hourly cleanup.
          </v-alert>
          <v-textarea v-model="reason" label="Reason for this change" variant="outlined" rows="2" counter="1000" maxlength="1000" :disabled="busy" />
          <p v-if="reviewError" class="analytics-error" role="alert">{{ reviewError }}</p>
        </v-card-text>
        <v-card-actions>
          <v-btn :disabled="busy" @click="reviewOpen = false">Back to draft</v-btn>
          <v-spacer />
          <v-btn color="primary" variant="flat" :disabled="reason.trim().length < 3 || busy || stale" :loading="busy" @click="publish">
            Publish analytics
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog v-model="eraseOpen" max-width="640" :persistent="busy" aria-labelledby="analytics-erase-title">
      <v-card class="analytics-dialog">
        <v-card-title id="analytics-erase-title">Erase local response history</v-card-title>
        <v-card-text>
          <p>
            This permanently removes all local daily counters present when the action runs. External provider data and administrative receipts remain.
            If local collection stays enabled, subsequent responses can create new counts.
          </p>
          <v-text-field v-model="eraseConfirmation" label="Type ERASE LOCAL COUNTS" variant="outlined" :disabled="busy" />
          <v-textarea v-model="reason" label="Reason for erasing local counts" variant="outlined" rows="2" maxlength="1000" :disabled="busy" />
          <p v-if="reviewError" class="analytics-error" role="alert">{{ reviewError }}</p>
        </v-card-text>
        <v-card-actions>
          <v-btn :disabled="busy" @click="eraseOpen = false">Cancel</v-btn>
          <v-spacer />
          <v-btn
            color="error"
            variant="flat"
            :loading="busy"
            :disabled="eraseConfirmation !== 'ERASE LOCAL COUNTS' || reason.trim().length < 3 || busy || stale"
            @click="erase"
          >
            Erase local counts
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog v-model="discardOpen" max-width="480" aria-labelledby="analytics-discard-title">
      <v-card class="analytics-dialog">
        <v-card-title id="analytics-discard-title">Discard this draft?</v-card-title>
        <v-card-text>There are unpublished analytics changes. Discard them to continue.</v-card-text>
        <v-card-actions>
          <v-btn @click="keepEditing">Keep editing</v-btn>
          <v-spacer />
          <v-btn color="primary" @click="discard">Discard draft</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onWatcherCleanup, ref, shallowRef, useId, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import AnimatedNumber from '@/components/common/animated-number.vue'
import AsyncState from '@/components/common/async-state.vue'
import {
  AnalyticsPolicySchema,
  analyticsChangedFields,
  decideAnalyticsCollection,
  type AnalyticsPolicy,
  type AnalyticsProviderDraft,
  type AnalyticsWorkspace
} from '../../../shared/analytics-policy.ts'
import { analyticsProviderIssues, analyticsDestinations } from '../../../shared/analytics-providers.ts'
import { fetchAnalyticsWorkspace, saveAnalyticsWorkspace, eraseAnalyticsInsights } from '../../helpers/analytics-workspace-api.ts'
import './analytics-workspace.scss'

const barGradId = useId()
const barGlowId = useId()

interface BarDatum {
  day: string
  responses: number
  pct: number
  x: number
  width: number
  height: number
}
const activeBar = ref<BarDatum | null>(null)
const sections = [
    { key: 'overview', title: 'Overview' },
    { key: 'collection', title: 'Collection' },
    { key: 'providers', title: 'Providers' },
    { key: 'activity', title: 'Activity' }
  ],
  route = useRoute(),
  router = useRouter()
const saved = shallowRef<AnalyticsWorkspace | null>(null),
  policy = ref<AnalyticsPolicy | null>(null),
  providers = ref<AnalyticsProviderDraft[]>([]),
  loading = ref(false),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  stale = ref(false)
const reportDays = ref(0)
const reportWindows = computed(() => [
  { title: 'Retained window', value: 0 },
  ...[7, 30, 90, 365].filter((days) => days <= (saved.value?.policy.retentionDays || 90)).map((days) => ({ title: `Last ${days} days`, value: days }))
])
const search = ref(''),
  category = ref('all'),
  selected = ref(''),
  reviewOpen = ref(false),
  eraseOpen = ref(false),
  discardOpen = ref(false),
  reason = ref(''),
  reviewError = ref(''),
  eraseConfirmation = ref(''),
  reviewDraft = shallowRef<{ policy: AnalyticsPolicy; providers: AnalyticsProviderDraft[]; fingerprint: string } | null>(null),
  eraseFingerprint = ref(''),
  pendingAction = shallowRef<(() => void) | null>(null)
let sequence = 0,
  disposed = false,
  allowLeave = false
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const section = computed(() => (sections.some((tab) => tab.key === route.query.section) ? String(route.query.section) : 'overview'))
const draftProviders = (workspace: AnalyticsWorkspace) =>
  workspace.providers.map(({ key, isEnabled, config }) => ({ key, isEnabled, config: clone(config) }))
const dirty = computed(() =>
  Boolean(
    saved.value &&
      policy.value &&
      (JSON.stringify(policy.value) !== JSON.stringify(saved.value.policy) ||
        JSON.stringify(providers.value) !== JSON.stringify(draftProviders(saved.value)))
  )
)
const locked = computed(() => loading.value || busy.value || stale.value || !saved.value),
  enabledCount = computed(() => providers.value.filter((row) => row.isEnabled).length)
const audiences = [
  { title: 'Everyone', value: 'everyone' },
  { title: 'Anonymous readers', value: 'anonymous' },
  { title: 'Signed-in readers', value: 'signed-in' }
]
const categories = [
  { title: 'All purposes', value: 'all' },
  { title: 'Traffic measurement', value: 'traffic' },
  { title: 'Session replay', value: 'replay' },
  { title: 'Browser performance', value: 'performance' },
  { title: 'Tag containers', value: 'tags' }
]
const categoryLabel = (key: string) => categories.find((row) => row.value === key)?.title || key
const categoryIcon = (key: string) =>
  ({ traffic: 'mdi-chart-line', replay: 'mdi-motion-play-outline', performance: 'mdi-speedometer', tags: 'mdi-tag-multiple-outline' })[key] ||
  'mdi-chart-box-outline'
const filteredProviders = computed(
  () =>
    saved.value?.providers.filter(
      (row) =>
        (category.value === 'all' || row.category === category.value) &&
        `${row.title} ${row.description}`.toLowerCase().includes((search.value || '').toLowerCase())
    ) || []
)
const provider = computed(() => saved.value?.providers.find((row) => row.key === selected.value)),
  providerDraft = computed(() => providers.value.find((row) => row.key === selected.value))
const providerProblems = computed(() => (providerDraft.value ? analyticsProviderIssues(providerDraft.value) : [])),
  providerHosts = computed(() => (providerDraft.value ? analyticsDestinations(providerDraft.value) : []))
const providerStatus = (key: string) => {
  const row = providers.value.find((row) => row.key === key),
    meta = saved.value?.providers.find((row) => row.key === key)
  return !meta?.isAvailable
    ? 'Unavailable'
    : row?.isEnabled
      ? analyticsProviderIssues(row).length
        ? 'Needs configuration'
        : 'Enabled · ready to embed'
      : 'Disabled'
}
const providerTitle = (key: string) => saved.value?.providers.find((row) => row.key === key)?.title || key
const excludedText = computed({
  get: () => policy.value?.excludedPaths.join('\n') || '',
  set: (value: string) => {
    if (policy.value)
      policy.value.excludedPaths = value
        .split('\n')
        .map((row) => row.trim())
        .filter(Boolean)
  }
})
const policyErrors = computed(() => {
  if (!policy.value) return []
  const result = AnalyticsPolicySchema.safeParse(policy.value)
  return result.success ? [] : result.error.issues.map((issue) => issue.message)
})
const simulation = ref({ path: 'handbook/start', reader: 'anonymous', privacySignal: false })
const simulationResult = computed(() =>
  decideAnalyticsCollection(policy.value!, {
    method: 'GET',
    reader: true,
    published: true,
    visibility: 'public',
    protected: false,
    path: simulation.value.path.replace(/^\/+|\/+$/g, ''),
    signedIn: simulation.value.reader !== 'anonymous',
    administrator: simulation.value.reader === 'administrator',
    privacySignal: simulation.value.privacySignal,
    prefetch: false,
    offline: saved.value?.offline || false
  })
)
const number = (value: number) => new Intl.NumberFormat().format(value),
  dateTime = (value: string) => new Date(value).toLocaleString()
const fieldLabel = (key: string) =>
  ({
    localEnabled: 'Local reader counts',
    externalEnabled: 'External integrations',
    audience: 'Reader audience',
    excludeAdministrators: 'Exclude administrators',
    respectPrivacySignals: 'Honor privacy signals',
    excludedPaths: 'Excluded paths',
    retentionDays: 'Local retention'
  })[key] || key
const display = (key: string, value: unknown) =>
  key === 'retentionDays'
    ? `${value} days`
    : typeof value === 'boolean'
      ? value
        ? 'Yes'
        : 'No'
      : Array.isArray(value)
        ? value.join(', ') || 'None'
        : String(value)
const reviewChanges = computed(() =>
  saved.value && reviewDraft.value
    ? analyticsChangedFields(saved.value.policy, reviewDraft.value.policy).map((key) => ({
        key,
        label: fieldLabel(key),
        before: display(key, Reflect.get(saved.value!.policy, key)),
        after: display(key, Reflect.get(reviewDraft.value!.policy, key))
      }))
    : []
)
const reviewProviders = computed(
  () =>
    reviewDraft.value?.providers.filter(
      (row) => JSON.stringify(row) !== JSON.stringify(draftProviders(saved.value!).find((old) => old.key === row.key))
    ) || []
)
const changedProviderFields = (row: AnalyticsProviderDraft) => {
  const original = saved.value?.providers.find((p) => p.key === row.key)
  return (
    original?.fields
      .filter((field) => row.config[field.key] !== original.config[field.key])
      .map((field) => ({ key: field.key, title: field.title, before: original.config[field.key], after: row.config[field.key] })) || []
  )
}
const bars = computed<BarDatum[]>(() => {
  if (!saved.value) return []
  const from = Date.parse(saved.value.insights.from),
    through = Date.parse(saved.value.insights.through),
    days = Math.round((through - from) / 86400000) + 1,
    max = Math.max(1, ...saved.value.insights.daily.map((row) => row.responses))
  return saved.value.insights.daily.map((row) => ({
    ...row,
    pct: Math.round((row.responses / max) * 100),
    x: (((Date.parse(row.day) - from) / 86400000) * 720) / days,
    width: Math.max(0.8, 720 / days - 1),
    height: Math.max(1, (row.responses / max) * 150)
  }))
})
function handleChartPointer(event: PointerEvent) {
  const svg = event.currentTarget as SVGSVGElement | null
  if (!svg || !bars.value.length) return
  const rect = svg.getBoundingClientRect()
  if (rect.width <= 0) return
  const svgX = ((event.clientX - rect.left) / rect.width) * 720
  let closest: BarDatum | null = null
  let minDistance = Infinity
  for (const bar of bars.value) {
    const barMid = bar.x + bar.width / 2
    const distance = Math.abs(svgX - barMid)
    if (distance < minDistance) {
      minDistance = distance
      closest = bar
    }
  }
  activeBar.value = closest
}
function clearChartPointer() {
  activeBar.value = null
}
const tooltipStyle = computed(() => {
  if (!activeBar.value) return { display: 'none' }
  const percentX = Math.min(95, Math.max(5, ((activeBar.value.x + activeBar.value.width / 2) / 720) * 100))
  const percentY = Math.max(0, ((169 - activeBar.value.height) / 180) * 100)
  return {
    left: `${percentX}%`,
    top: `${percentY}%`
  }
})
function reset() {
  if (saved.value) {
    policy.value = clone(saved.value.policy)
    providers.value = draftProviders(saved.value)
  }
  notice.value = ''
}
async function load() {
  const id = ++sequence
  loading.value = true
  error.value = ''
  try {
    const value = await fetchAnalyticsWorkspace(reportDays.value)
    if (disposed || id !== sequence) return
    saved.value = value
    stale.value = false
    reset()
    selected.value = value.providers.some((row) => row.key === route.query.provider)
      ? String(route.query.provider)
      : value.providers.some((row) => row.key === selected.value)
        ? selected.value
        : value.providers[0]?.key || ''
  } catch (err) {
    if (id === sequence && !disposed) error.value = err instanceof Error ? err.message : 'Analytics could not be loaded.'
  } finally {
    if (id === sequence && !disposed) loading.value = false
  }
}
function selectWindow(days: number) {
  if (locked.value || !saved.value || days === reportDays.value) return
  reportDays.value = days
}
watch(reportDays, async (days) => {
  if (locked.value || !saved.value) return
  const controller = new AbortController()
  onWatcherCleanup(() => controller.abort())
  const id = ++sequence
  loading.value = true
  error.value = ''
  try {
    const value = await fetchAnalyticsWorkspace(days)
    if (disposed || id !== sequence || controller.signal.aborted) return
    if (value.fingerprint !== saved.value.fingerprint) {
      stale.value = true
      error.value = 'Analytics settings changed. Reload before changing the reporting window.'
      return
    }
    saved.value = { ...saved.value, insights: value.insights, observedAt: value.observedAt }
  } catch (err) {
    if (!disposed && id === sequence && !controller.signal.aborted) {
      error.value = err instanceof Error ? err.message : 'The reporting window could not be loaded.'
    }
  } finally {
    if (!disposed && id === sequence) loading.value = false
  }
})
function guarded(action: () => void) {
  if (dirty.value) {
    pendingAction.value = action
    discardOpen.value = true
  } else action()
}
function reload() {
  guarded(() => {
    void load()
  })
}
function keepEditing() {
  discardOpen.value = false
  pendingAction.value = null
}
function discard() {
  reset()
  discardOpen.value = false
  const action = pendingAction.value
  pendingAction.value = null
  action?.()
}
function selectSection(key: string) {
  void router.replace({ query: { ...route.query, section: key } })
}
function selectProvider(key: string) {
  selected.value = key
  void router.replace({ query: { ...route.query, section: 'providers', provider: key } })
}
function review() {
  if (!saved.value || !policy.value) return
  const validation = AnalyticsPolicySchema.safeParse(policy.value)
  const invalid = providers.value.find((row) => row.isEnabled && analyticsProviderIssues(row).length)
  if (!validation.success) {
    error.value = validation.error.issues[0]?.message || 'Check the collection policy.'
    selectSection('collection')
    return
  }
  if (invalid) {
    selected.value = invalid.key
    selectSection('providers')
    error.value = `${providerTitle(invalid.key)} needs valid configuration before publication.`
    return
  }
  error.value = ''
  reason.value = ''
  reviewError.value = ''
  reviewDraft.value = clone({ policy: validation.data, providers: providers.value, fingerprint: saved.value.fingerprint })
  reviewOpen.value = true
}
async function completeWrite(action: () => Promise<unknown>, message: string, after: () => void) {
  busy.value = true
  reviewError.value = ''
  try {
    await action()
    after()
    reviewOpen.value = false
    eraseOpen.value = false
    try {
      const value = await fetchAnalyticsWorkspace(reportDays.value)
      if (disposed) return
      saved.value = value
      reset()
      notice.value = message
      stale.value = false
    } catch {
      stale.value = true
      notice.value = message
      error.value = 'The action was confirmed, but the refreshed workspace could not be read. Reload before another action.'
    }
  } catch (err) {
    reviewError.value = err instanceof Error ? err.message : 'The outcome is unconfirmed.'
    const status = err && typeof err === 'object' ? Reflect.get(err, 'status') : undefined
    if (status === 409 || !status || status >= 500) stale.value = true
  } finally {
    busy.value = false
  }
}
function publish() {
  const snapshot = reviewDraft.value
  if (!snapshot || reason.value.trim().length < 3) return
  void completeWrite(
    () => saveAnalyticsWorkspace(snapshot.policy, snapshot.providers, snapshot.fingerprint, reason.value.trim()),
    'Analytics published. The policy applies on the next reader request.',
    () => {
      if (saved.value) {
        saved.value = {
          ...saved.value,
          policy: clone(snapshot.policy),
          providers: saved.value.providers.map((row) => ({ ...row, ...snapshot.providers.find((draft) => draft.key === row.key) }))
        }
        reset()
      }
    }
  )
}
function openErase() {
  if (!saved.value) return
  eraseFingerprint.value = saved.value.fingerprint
  eraseConfirmation.value = ''
  reason.value = ''
  reviewError.value = ''
  eraseOpen.value = true
}
function erase() {
  void completeWrite(
    () => eraseAnalyticsInsights(eraseFingerprint.value, reason.value.trim(), eraseConfirmation.value),
    'Local response history erased. Collection settings remain in effect.',
    () => {}
  )
}
function exportCounts() {
  if (!saved.value) return
  const rows = ['utc_day,recorded_responses', ...saved.value.insights.daily.map((row) => `${row.day},${row.responses}`)],
    url = URL.createObjectURL(new Blob([rows.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' })),
    link = document.createElement('a')
  link.href = url
  link.download = `reader-responses-${saved.value.insights.from}-${saved.value.insights.through}.csv`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
watch(
  () => route.query.provider,
  (key) => {
    if (saved.value) selected.value = saved.value.providers.some((row) => row.key === key) ? String(key) : saved.value.providers[0]?.key || ''
  }
)
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value || busy.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}
onBeforeRouteLeave((to) => {
  if (allowLeave) return true
  if (busy.value) return false
  if (!dirty.value) return true
  pendingAction.value = () => {
    allowLeave = true
    void router.push(to.fullPath)
  }
  discardOpen.value = true
  return false
})
onMounted(() => {
  void load()
  window.addEventListener('beforeunload', beforeUnload)
})
onBeforeUnmount(() => {
  disposed = true
  sequence++
  window.removeEventListener('beforeunload', beforeUnload)
})
</script>
