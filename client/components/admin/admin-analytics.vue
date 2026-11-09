<template>
  <v-container fluid class="analytics-workspace">
    <admin-hero icon="mdi-chart-areaspline" :title="tr('title')" :description="tr('operationalSubtitle')">
      <template #actions>
        <v-btn variant="text" prepend-icon="mdi-refresh" :disabled="busy || loading" @click="reload">{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ tr('reloadSavedAnalyticsSettings') }}</v-tooltip></v-btn>
        <v-btn v-if="dirty" variant="text" :disabled="locked" @click="reset">{{ tr('resetDraft') }}</v-btn>
        <v-btn color="primary" variant="tonal" :data-commitment="dirty && !locked ? 'active' : undefined" :disabled="locked || !dirty" @click="review">{{ tr('reviewChanges') }}</v-btn>
      </template>
      <template v-if="saved && policy" #status>
        <div class="analytics-status">
          <span>
            <i :class="{ 'is-draft': dirty }" aria-hidden="true" />
            {{ dirty ? tr('unsavedAnalyticsDraft') : tr('showingSavedSettings') }}
          </span>
          <span>{{ tr('observed', { observedAt: dateTime(saved.observedAt), interpolation: { escapeValue: false } }) }}</span>
        </div>
      </template>
    </admin-hero>
    <async-state
      v-if="loading && !saved"
      state="loading"
      :title="tr('loadingAnalytics')"
      :message="tr('readingCollectionPolicyIntegrations')"
    />
    <async-state
      v-else-if="error && !saved"
      state="error"
      :title="tr('analyticsCouldNotLoaded2')"
      :message="error"
      :retry-label="tr('tryAgain')"
      @retry="load"
    />
    <v-alert v-else-if="error" type="error" variant="tonal" class="mb-5">{{ error }}</v-alert>
    <v-alert v-if="stale" type="warning" variant="tonal" class="mb-5">
      {{ tr('savedStateChangedAction') }}
    </v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" class="mb-5">{{ notice }}</v-alert>
    <template v-if="saved && policy">
      <nav class="analytics-tabs" :aria-label="tr('analyticsSections')">
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
          <h2 class="sr-only">{{ sections.find((tab) => tab.key === section)?.title }}</h2>
          <template v-if="section === 'overview'">
            <p class="analytics-section-help">{{ tr('localEvidenceCompletedReader') }}</p>
            <div class="analytics-metrics wiki-surface-well">
              <div>
                <span>{{ tr('recordedReaderResponses') }}</span>
                <strong><animated-number :value="saved.insights.totalResponses" :duration="700" :format-value="number" /></strong>
                <small>{{ tr('utc', { from: saved.insights.from, through: saved.insights.through, interpolation: { escapeValue: false } }) }}</small>
              </div>
              <div>
                <span>{{ tr('sharedPagesReached') }}</span>
                <strong><animated-number :value="saved.insights.pages" :duration="700" :format-value="number" /></strong>
                <small>{{ tr('currentPublishedUnprotectedPages') }}</small>
              </div>
            </div>
            <div class="analytics-section-head">
              <h3>{{ tr('dailyResponseHistory') }}</h3>
              <v-select
                :model-value="reportDays"
                :items="reportWindows"
                :label="tr('reportingWindow')"
                variant="outlined"
                density="compact"
                hide-details
                class="analytics-window"
                :disabled="locked"
                @update:model-value="selectWindow"
              />
              <v-btn variant="text" prepend-icon="mdi-download" :disabled="!saved.insights.daily.length" @click="exportCounts">{{ tr('exportCounts') }}</v-btn>
            </div>
            <div v-if="!saved.insights.totalResponses" class="analytics-empty wiki-surface-well">
              <v-icon size="36" icon="mdi-chart-timeline-variant" />
              <h3>{{ tr('noReaderResponsesRecorded') }}</h3>
              <p>
                {{
                  saved.policy.localEnabled
                    ? tr('eligibleResponsesWillAppear')
                    : tr('localCountsPausedEnable')
                }}
              </p>
              <v-btn variant="outlined" @click="selectSection('collection')">{{ tr('reviewCollectionPolicy') }}</v-btn>
            </div>
            <figure v-else class="analytics-chart wiki-surface-well">
              <svg
                class="analytics-chart-svg"
                viewBox="0 0 720 180"
                role="img"
                :aria-label="tr('dailyRecordedReaderResponses')"
                preserveAspectRatio="none"
                @pointermove="handleChartPointer"
                @pointerleave="clearChartPointer"
              >
                <title>{{ tr('dailyRecordedReaderResponses') }}</title>
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
                >
                  <title>{{ tr('responses', { day: bar.day, responses: number(bar.responses), interpolation: { escapeValue: false } }) }}</title>
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
              <div v-if="activeBar" class="analytics-chart-readout">
                <span class="analytics-chart-readout__day">{{ activeBar.day }}</span>
                <span class="analytics-chart-readout__count"><strong>{{ number(activeBar.responses) }}</strong> {{ tr('responses2') }}</span>
              </div>
              <figcaption>
                <span>{{ saved.insights.from }}</span>
                <span>{{ saved.insights.through }}</span>
              </figcaption>
            </figure>
            <details v-if="saved.insights.daily.length" class="analytics-detail-table">
              <summary>{{ tr('viewExactDailyCounts') }}</summary>
              <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: This bounded overflow region needs a tab stop for keyboard scrolling. -->
              <section class="analytics-table-scroll wiki-surface-well" tabindex="0" :aria-label="tr('dailyResponseCounts')"><table>
                <caption class="sr-only">{{ tr('recordedResponsesUtcDay') }}</caption>
                <thead>
                  <tr>
                    <th scope="col">{{ tr('day') }}</th>
                    <th scope="col">{{ tr('responses3') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in saved.insights.daily" :key="row.day">
                    <th scope="row">{{ row.day }}</th>
                    <td>{{ number(row.responses) }}</td>
                  </tr>
                </tbody>
              </table></section>
            </details>
            <div class="analytics-section-head">
              <div>
                <h3>{{ tr('mostReadSharedPages') }}</h3>
                <p>{{ tr('up15PagesRetained') }}</p>
              </div>
            </div>
            <div v-if="saved.insights.topPages.length" class="analytics-ranked wiki-surface-well">
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
            <p v-else class="analytics-muted">{{ tr('pageRankingsAppearWhen') }}</p>
            <p class="analytics-footnote">
              {{ tr('countsCanIncludeAutomated') }}
            </p>
          </template>
          <template v-else-if="section === 'collection'">
            <p class="analytics-section-help">{{ tr('onePolicyGovernsLocal') }}</p>
            <div class="analytics-setting">
              <div>
                <h3>{{ tr('localReaderCounts') }}</h3>
                <p>
                  {{ tr('storeDailyCountPer') }}
                </p>
              </div>
              <v-switch :model-value="policy.localEnabled" @update:model-value="$event !== null && (policy.localEnabled = $event)" :label="tr('recordLocalReaderCounts')" color="primary" hide-details :disabled="locked" />
            </div>
            <div class="analytics-setting">
              <div>
                <h3>{{ tr('externalIntegrations') }}</h3>
                <p>
                  {{ tr('allowEnabledProvidersEmbed') }}
                </p>
              </div>
              <v-switch :model-value="policy.externalEnabled" @update:model-value="$event !== null && (policy.externalEnabled = $event)" :label="tr('allowExternalIntegrations')" color="primary" hide-details :disabled="locked" />
            </div>
            <v-alert v-if="saved.offline" type="info" variant="tonal" class="mb-5">
              {{ tr('offlineModeSuspendsExternal') }}
            </v-alert>
            <div class="analytics-setting">
              <div>
                <h3>{{ tr('readerAudience') }}</h3>
                <p>
                  {{ tr('appliesOnlyPublishedShared') }}
                </p>
              </div>
              <v-select
                v-model="policy.audience"
                :items="audiences"
                :label="tr('measureResponses')"
                variant="outlined"
                hide-details
                :disabled="locked"
              />
            </div>
            <div class="analytics-setting">
              <div>
                <h3>{{ tr('keepAdministrationOut') }}</h3>
                <p>{{ tr('excludeReaderRequestsMade') }}</p>
              </div>
              <v-switch
                :model-value="policy.excludeAdministrators"
                @update:model-value="$event !== null && (policy.excludeAdministrators = $event)"
                :label="tr('excludeSystemAdministrators')"
                color="primary"
                hide-details
                :disabled="locked"
              />
            </div>
            <div class="analytics-setting">
              <div>
                <h3>{{ tr('respectRequestPrivacySignals') }}</h3>
                <p>{{ tr('skipBothLocalExternal') }}</p>
              </div>
              <v-switch :model-value="policy.respectPrivacySignals" @update:model-value="$event !== null && (policy.respectPrivacySignals = $event)" :label="tr('honorDntGpcHeaders')" color="primary" hide-details :disabled="locked" />
            </div>
            <div class="analytics-setting analytics-setting-wide">
              <div>
                <h3>{{ tr('excludedPathsSections') }}</h3>
                <p>
                  {{ tr('oneLiteralPagePath') }}
                </p>
              </div>
              <v-textarea
                v-model="excludedText"
                :label="tr('excludedPagePaths')"
                variant="outlined"
                rows="3"
                auto-grow
                :disabled="locked"
                :error-messages="policyErrors"
              />
            </div>
            <div class="analytics-setting">
              <div>
                <h3>{{ tr('localRetention') }}</h3>
                <p>
                  {{ tr('reportUsesInclusiveUtc') }}
                </p>
              </div>
              <v-select
                v-model="policy.retentionDays"
                :items="[
                  { title: tr('n30Days'), value: 30 },
                  { title: tr('n90Days'), value: 90 },
                  { title: tr('n365Days'), value: 365 }
                ]"
                :label="tr('retainLocalCounts')"
                variant="outlined"
                hide-details
                :disabled="locked"
              />
            </div>
            <div class="analytics-section-head">
              <div>
                <h3>{{ tr('collectionPreview') }}</h3>
                <p>{{ tr('simulationDraftNotLive') }}</p>
              </div>
            </div>
            <div class="analytics-simulator wiki-surface-well">
              <v-text-field v-model="simulation.path" :label="tr('examplePagePath')" variant="outlined" hide-details />
              <v-select
                v-model="simulation.reader"
                :items="[
                  { title: tr('anonymousReader'), value: 'anonymous' },
                  { title: tr('signedReader'), value: 'signed-in' },
                  { title: tr('systemAdministrator'), value: 'administrator' }
                ]"
                :label="tr('exampleReader')"
                variant="outlined"
                hide-details
              />
              <v-checkbox :model-value="simulation.privacySignal" @update:model-value="$event !== null && (simulation.privacySignal = $event)" :label="tr('requestSendsDntGpc')" hide-details />
              <div role="status" class="analytics-simulation-result">
                <strong>
                  {{ $t(simulationResult.local ? 'admin:analytics.simulationLocalEligible' : 'admin:analytics.simulationLocalExcluded') }}
                  · {{ $t(simulationResult.external ? 'admin:analytics.simulationExternalEligible' : 'admin:analytics.simulationExternalExcluded') }}
                </strong>
                <p>{{ simulationReason }} {{ tr('simulationProvidersRequired') }}</p>
              </div>
            </div>
            <div class="analytics-erasure">
              <div>
                <h3>{{ tr('eraseLocalHistory') }}</h3>
                <p>{{ tr('removeAllStoredLocal') }}</p>
              </div>
              <v-btn variant="outlined" color="error" :disabled="locked || dirty" @click="openErase">{{ tr('reviewErasure') }}</v-btn>
            </div>
          </template>
          <template v-else-if="section === 'providers'">
            <p class="analytics-section-help">{{ tr('configureProvidersIndependentlyExternal') }}</p>
            <div class="analytics-provider-filter">
              <v-text-field v-model="search" :label="tr('findProvider')" prepend-inner-icon="mdi-magnify" variant="outlined" hide-details clearable />
              <v-select v-model="category" :items="categories" :label="tr('providerCategory')" variant="outlined" hide-details />
            </div>
            <div class="analytics-provider-layout">
              <nav :aria-label="tr('analyticsProviders')" class="analytics-provider-list">
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
                <p v-if="!filteredProviders.length" class="analytics-muted">{{ tr('noProvidersMatchTry') }}</p>
              </nav>
              <article v-if="provider && providerDraft" class="analytics-provider-detail">
                <span class="analytics-kicker">{{ categoryLabel(provider.category) }}</span>
                <h3>{{ provider.title }}</h3>
                <p>{{ provider.description }}</p>
                <v-switch
                  :model-value="providerDraft.isEnabled"
                  @update:model-value="$event !== null && (providerDraft.isEnabled = $event)"
                  :label="tr('enable', { title: provider.title, interpolation: { escapeValue: false } })"
                  color="primary"
                  hide-details
                  :disabled="locked || (!provider.isAvailable && !providerDraft.isEnabled)"
                />
                <div class="analytics-capabilities">
                  <span v-for="capability in provider.capabilities" :key="capability">{{ capability }}</span>
                </div>
                <v-alert v-if="!provider.isAvailable" type="warning" variant="tonal">
                  {{ tr('integrationUnavailableSavedEnablement') }}
                </v-alert>
                <p class="analytics-compatibility">{{ provider.compatibility }}</p>
                <div class="analytics-provider-fields">
                  <template v-for="field in provider.fields" :key="field.key">
                    <v-switch
                      v-if="field.kind === 'boolean'"
                      :model-value="providerDraft.config[field.key] === 'true'"
                      :label="field.title"
                      :hint="field.hint"
                      persistent-hint
                      color="primary"
                      :disabled="locked || !provider.isAvailable"
                      @update:model-value="providerDraft.config[field.key] = $event ? 'true' : 'false'"
                    />
                    <v-text-field
                      v-else
                      v-model="providerDraft.config[field.key]"
                      :label="field.optional ? tr('optionalFieldLabel', { field: field.title }) : field.title"
                      :hint="field.hint"
                      persistent-hint
                      variant="outlined"
                      :inputmode="field.kind === 'number' ? 'numeric' : field.kind === 'url' ? 'url' : 'text'"
                      :disabled="locked || !provider.isAvailable"
                    />
                  </template>
                </div>
                <div v-if="providerProblems.length" class="analytics-provider-problems" role="status">
                  <strong>{{ providerDraft.isEnabled ? tr('resolveBeforePublication') : tr('neededBeforeEnabling') }}</strong>
                  <ul>
                    <li v-for="issue in providerProblems" :key="issue">{{ issue }}</li>
                  </ul>
                </div>
                <div class="analytics-hosts">
                  <h4>{{ tr('declaredScriptConfiguredHosts') }}</h4>
                  <ul v-if="providerHosts.length">
                    <li v-for="host in providerHosts" :key="host">
                      <code>{{ host }}</code>
                    </li>
                  </ul>
                  <p v-else>{{ tr('completeServerFieldsSee') }}</p>
                  <small>{{ tr('sdksTagContainersMay') }}</small>
                </div>
                <p class="analytics-footnote">
                  {{ tr('trackingIdentifiersEnteredHere') }}
                </p>
                <v-btn
                  v-if="provider.website"
                  :href="provider.website"
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="text"
                  append-icon="mdi-open-in-new"
                  :aria-label="tr('websiteOpensNewTab', { title: provider.title, interpolation: { escapeValue: false } })"
                >
                  {{ tr('providerWebsite') }}
                </v-btn>
              </article>
              <div v-else class="analytics-empty wiki-surface-well">
                <h3>{{ tr('selectIntegration') }}</h3>
                <p>{{ tr('chooseProviderInspectConfiguration') }}</p>
              </div>
            </div>
          </template>
          <template v-else>
            <p class="analytics-section-help">{{ tr('latest50CollectionChanges') }}</p>
            <div v-if="!saved.history.length" class="analytics-empty wiki-surface-well">
              <h3>{{ tr('noAdministrativeActivityYet') }}</h3>
              <p>{{ tr('publishingSettingsErasingLocal') }}</p>
            </div>
            <ol v-else class="analytics-history wiki-surface-well">
              <li v-for="event in saved.history" :key="event.id">
                <span class="analytics-event-icon"><v-icon :icon="event.kind === 'erase' ? 'mdi-delete-outline' : 'mdi-check'" /></span>
                <div>
                  <div class="analytics-section-head">
                    <h3>{{ event.kind === 'erase' ? tr('localHistoryErased') : tr('analyticsPublished') }}</h3>
                    <time :datetime="event.createdAt">{{ dateTime(event.createdAt) }}</time>
                  </div>
                  <p>{{ event.reason }}</p>
                  <small>
                    {{ event.actorId === null ? tr('apiPrincipal') : tr('account', { actorId: event.actorId, interpolation: { escapeValue: false } }) }}
                    <template v-if="event.kind === 'erase'">{{ tr('dailyRecordsRemoved', { number: number(event.erasedRows || 0), interpolation: { escapeValue: false } }) }}</template>
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
          <span class="analytics-kicker">{{ tr('collectionGlance') }}</span>
          <div class="analytics-policy-card wiki-surface-well">
            <div>
              <span>{{ tr('localCounts') }}</span>
              <strong>{{ policy.localEnabled ? tr('enabled') : tr('paused') }}</strong>
            </div>
            <div>
              <span>{{ tr('externalScripts') }}</span>
              <strong>{{ saved.offline ? tr('offline') : policy.externalEnabled ? tr('allowed') : tr('paused') }}</strong>
            </div>
            <div>
              <span>{{ tr('enabledProviders') }}</span>
              <strong>{{ enabledCount }}</strong>
            </div>
            <div>
              <span>{{ tr('audience') }}</span>
              <strong>{{ audiences.find((row) => row.value === policy!.audience)?.title }}</strong>
            </div>
            <div>
              <span>{{ tr('retainedHistory') }}</span>
              <strong>{{ tr('days2', { retentionDays: policy.retentionDays, interpolation: { escapeValue: false } }) }}</strong>
            </div>
          </div>
          <p v-if="dirty" class="analytics-footnote">{{ tr('summaryReflectsDraftOverview') }}</p>
          <div class="analytics-aside-note">
            <h3>{{ tr('measureContext') }}</h3>
            <p>
              {{ tr('localCountersDescribeRecorded') }}
            </p>
          </div>
          <div class="analytics-aside-note">
            <h3>{{ tr('publication') }}</h3>
            <p>{{ tr('settingsApplyNextReader') }}</p>
          </div>
        </aside>
      </div>
    </template>
    <v-dialog v-model="reviewOpen" max-width="760" :persistent="busy" aria-labelledby="analytics-review-title">
      <v-card v-if="reviewDraft" class="analytics-dialog">
        <v-card-title id="analytics-review-title">{{ tr('reviewAnalyticsPublication') }}</v-card-title>
        <v-card-text>
          <p>{{ tr('publishCollectionPolicyProvider') }}</p>
          <dl class="analytics-review-list wiki-surface-well">
            <template v-for="change in reviewChanges" :key="change.key">
              <dt>{{ change.label }}</dt>
              <dd>
                <del>{{ change.before }}</del>
                <strong>{{ change.after }}</strong>
              </dd>
            </template>
          </dl>
          <div v-for="row in reviewProviders" :key="row.key" class="analytics-review-provider wiki-surface-well">
            <h3>{{ providerTitle(row.key) }}</h3>
            <p>{{ row.isEnabled ? tr('enabled') : tr('disabled') }}</p>
            <dl>
              <template v-for="field in changedProviderFields(row)" :key="field.key">
                <dt>{{ field.title }}</dt>
                <dd>
                  <del>{{ field.before || tr('empty') }}</del>
                  <strong>{{ field.after || tr('empty') }}</strong>
                </dd>
              </template>
            </dl>
          </div>
          <v-alert v-if="reviewDraft.policy.retentionDays < (saved?.policy.retentionDays || 0)" type="warning" variant="tonal" class="my-4">
            {{ tr('olderCountersWillLeave') }}
          </v-alert>
          <v-textarea v-model="reason" :label="tr('reasonChange')" variant="outlined" rows="2" counter="1000" maxlength="1000" :disabled="busy" />
          <p v-if="reviewError" class="analytics-error" role="alert">{{ reviewError }}</p>
        </v-card-text>
        <v-card-actions>
          <v-btn :disabled="busy" @click="reviewOpen = false">{{ tr('backDraft') }}</v-btn>
          <v-spacer />
          <v-btn color="primary" variant="tonal" :data-commitment="dirty && reason.trim().length >= 3 && !busy && !stale ? 'active' : undefined" :disabled="reason.trim().length < 3 || busy || stale" :loading="busy" @click="publish">
            {{ tr('publishAnalytics') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog v-model="eraseOpen" max-width="640" :persistent="busy" aria-labelledby="analytics-erase-title">
      <v-card class="analytics-dialog">
        <v-card-title id="analytics-erase-title">{{ tr('eraseLocalResponseHistory') }}</v-card-title>
        <v-card-text>
          <p>
            {{ tr('permanentlyRemovesAllLocal') }}
          </p>
          <v-text-field v-model="eraseConfirmation" :label="tr('typeEraseLocalCounts')" variant="outlined" :disabled="busy" />
          <v-textarea v-model="reason" :label="tr('reasonErasingLocalCounts')" variant="outlined" rows="2" maxlength="1000" :disabled="busy" />
          <p v-if="reviewError" class="analytics-error" role="alert">{{ reviewError }}</p>
        </v-card-text>
        <v-card-actions>
          <v-btn :disabled="busy" @click="eraseOpen = false">{{ $t('common:actions.cancel') }}</v-btn>
          <v-spacer />
          <v-btn
            color="error"
            variant="flat"
            :loading="busy"
            :disabled="eraseConfirmation !== 'ERASE LOCAL COUNTS' || reason.trim().length < 3 || busy || stale"
            @click="erase"
          >
            {{ tr('eraseLocalCounts') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>
<script setup lang="ts">
import { helpers } from '../../helpers/index.ts'
import { confirmDiscard } from '../common/confirm-dialog.ts'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue'
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
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const tr = useTranslate('admin:analytics')

const barGradId = useId()
const barGlowId = useId()

interface BarDatum {
  day: string
  responses: number
  x: number
  width: number
  height: number
}
const activeDay = ref<string | null>(null)
const sections = [
    { key: 'overview', title: tr('overview') },
    { key: 'collection', title: tr('collection') },
    { key: 'providers', title: tr('providers') },
    { key: 'activity', title: tr('activity') }
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
  { title: tr('retainedWindow'), value: 0 },
  ...[7, 30, 90, 365].filter((days) => days <= (saved.value?.policy.retentionDays || 90)).map((days) => ({ title: tr('lastDays', { days, interpolation: { escapeValue: false } }), value: days }))
])
const search = ref(''),
  category = ref('all'),
  selected = ref(''),
  reviewOpen = ref(false),
  eraseOpen = ref(false),
  reason = ref(''),
  reviewError = ref(''),
  eraseConfirmation = ref(''),
  reviewDraft = shallowRef<{ policy: AnalyticsPolicy; providers: AnalyticsProviderDraft[]; fingerprint: string } | null>(null),
  eraseFingerprint = ref('')
let sequence = 0,
  disposed = false
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
  { title: tr('everyone'), value: 'everyone' },
  { title: tr('anonymousReaders'), value: 'anonymous' },
  { title: tr('signedReaders'), value: 'signed-in' }
]
const categories = [
  { title: tr('allPurposes'), value: 'all' },
  { title: tr('trafficMeasurement'), value: 'traffic' },
  { title: tr('sessionReplay'), value: 'replay' },
  { title: tr('browserPerformance'), value: 'performance' },
  { title: tr('tagContainers'), value: 'tags' }
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
    ? tr('unavailable')
    : row?.isEnabled
      ? analyticsProviderIssues(row).length
        ? tr('needsConfiguration')
        : tr('enabledReadyEmbed')
      : tr('disabled')
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
const simulationReasonKeys: Record<string, string> = {
  'Only completed reader GET responses are eligible; prefetch is excluded.': 'simulationCompletedReader',
  'Only published, shared reader pages without a page password are eligible.': 'simulationPublicReader',
  'The request sends a Do Not Track or Global Privacy Control signal.': 'simulationPrivacySignal',
  'System administrators are excluded.': 'simulationAdministratorExcluded',
  'The reader is outside the selected audience.': 'simulationAudienceExcluded',
  'The page matches an excluded path or section.': 'simulationPathExcluded',
  'Offline mode suspends external integrations.': 'simulationOffline',
  'Collection is paused.': 'simulationPaused',
  'Eligible for local counts; offline mode suspends external integrations.': 'simulationLocalOffline',
  'Eligible under the saved collection policy.': 'simulationDraftEligible'
}
const simulationReason = computed(() => t(`admin:analytics.${simulationReasonKeys[simulationResult.value.reason]}`))
const numberFormat = new Intl.NumberFormat(),
  number = (value: number) => numberFormat.format(value),
  dateTime = (value: string) => Number.isNaN(new Date(value).valueOf()) ? 'Invalid Date' : String(helpers.formatMoment(value, 'L LT'))
const fieldLabel = (key: string) =>
  ({
    localEnabled: tr('localReaderCounts'),
    externalEnabled: tr('externalIntegrations'),
    audience: tr('readerAudience'),
    excludeAdministrators: tr('excludeAdministrators'),
    respectPrivacySignals: tr('honorPrivacySignals'),
    excludedPaths: tr('excludedPaths'),
    retentionDays: tr('localRetention')
  })[key] || key
const display = (key: string, value: unknown) =>
  key === 'retentionDays'
    ? tr('days', { value, interpolation: { escapeValue: false } })
    : typeof value === 'boolean'
      ? value
        ? tr('yes')
        : tr('no')
      : Array.isArray(value)
        ? value.join(', ') || tr('none')
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
      .map((field) => ({
        key: field.key,
        title: field.title,
        before: field.kind === 'boolean' ? (original.config[field.key] === 'true' ? tr('on') : tr('off')) : original.config[field.key],
        after: field.kind === 'boolean' ? (row.config[field.key] === 'true' ? tr('on') : tr('off')) : row.config[field.key]
      })) || []
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
    x: (((Date.parse(row.day) - from) / 86400000) * 720) / days,
    width: Math.max(0.8, 720 / days - 1),
    height: Math.max(1, (row.responses / max) * 150)
  }))
})
const activeBar = computed<BarDatum | null>(() => {
  if (!activeDay.value) return null
  return bars.value.find((bar) => bar.day === activeDay.value) || null
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
  activeDay.value = closest?.day || null
}
function clearChartPointer() {
  activeDay.value = null
}
function reset() {
  if (saved.value) {
    policy.value = clone(saved.value.policy)
    providers.value = draftProviders(saved.value)
  }
  notice.value = ''
}
async function load() {
  const id = ++sequence
  clearChartPointer()
  loading.value = true
  error.value = ''
  try {
    const value = await fetchAnalyticsWorkspace(reportDays.value)
    if (disposed || id !== sequence) return
    clearChartPointer()
    saved.value = value
    stale.value = false
    reset()
    selected.value = value.providers.some((row) => row.key === route.query.provider)
      ? String(route.query.provider)
      : value.providers.some((row) => row.key === selected.value)
        ? selected.value
        : value.providers[0]?.key || ''
  } catch (err) {
    if (id === sequence && !disposed) error.value = err instanceof Error ? err.message : tr('analyticsCouldNotLoaded')
  } finally {
    if (id === sequence && !disposed) loading.value = false
  }
}
async function selectWindow(days: number) {
  if (locked.value || !saved.value || days === reportDays.value) return
  const id = ++sequence,
    current = saved.value
  loading.value = true
  error.value = ''
  try {
    const value = await fetchAnalyticsWorkspace(days)
    if (disposed || id !== sequence) return
    if (value.fingerprint !== current.fingerprint) {
      stale.value = true
      error.value = tr('analyticsSettingsChangedReload')
      return
    }
    clearChartPointer()
    saved.value = { ...current, insights: value.insights, observedAt: value.observedAt }
    reportDays.value = days
  } catch (err) {
    if (!disposed && id === sequence) error.value = err instanceof Error ? err.message : tr('reportingWindowCouldNot')
  } finally {
    if (!disposed && id === sequence) loading.value = false
  }
}
const discardTitle = tr('discardDraft'),
  discardMessage = tr('thereUnpublishedAnalyticsChanges')
async function guarded(action: () => void) {
  if (!dirty.value) return action()
  if (!(await confirmDiscard(discardTitle, discardMessage, tr('discardDraft2')))) return
  reset()
  action()
}
function reload() {
  guarded(() => {
    void load()
  })
}
function selectSection(key: string) {
  clearChartPointer()
  void router.replace({ query: { ...route.query, section: key } })
}
function selectProvider(key: string) {
  clearChartPointer()
  selected.value = key
  void router.replace({ query: { ...route.query, section: 'providers', provider: key } })
}
function review() {
  if (!saved.value || !policy.value) return
  const validation = AnalyticsPolicySchema.safeParse(policy.value)
  const invalid = providers.value.find((row) => row.isEnabled && analyticsProviderIssues(row).length)
  if (!validation.success) {
    error.value = validation.error.issues[0]?.message || tr('checkCollectionPolicy')
    selectSection('collection')
    return
  }
  if (invalid) {
    selected.value = invalid.key
    selectSection('providers')
    error.value = tr('needsValidConfigurationBefore', { key: providerTitle(invalid.key), interpolation: { escapeValue: false } })
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
      clearChartPointer()
      saved.value = value
      reset()
      notice.value = message
      stale.value = false
    } catch {
      stale.value = true
      notice.value = message
      error.value = tr('actionWasConfirmedBut')
    }
  } catch (err) {
    reviewError.value = err instanceof Error ? err.message : tr('outcomeUnconfirmed')
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
    tr('analyticsPublishedPolicyApplies'),
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
  clearChartPointer()
  void completeWrite(
    () => eraseAnalyticsInsights(eraseFingerprint.value, reason.value.trim(), eraseConfirmation.value),
    tr('localResponseHistoryErased'),
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
watch(section, clearChartPointer)
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
onBeforeRouteLeave(async () => {
  if (busy.value) return false
  if (!dirty.value) return true
  return !busy.value && (await confirmDiscard(discardTitle, discardMessage, tr('discardDraft2')))
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
