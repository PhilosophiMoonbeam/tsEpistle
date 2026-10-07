<template>
  <v-container fluid class="analytics-workspace">
    <admin-hero icon="mdi-chart-areaspline" :title="$t('admin:analytics.title')" :description="$t('admin:analytics.understandReadersDeliberateAbout')">
      <template #actions>
        <v-btn variant="text" prepend-icon="mdi-refresh" :disabled="busy || loading" @click="reload">{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ $t('admin:analytics.reloadSavedAnalyticsSettings') }}</v-tooltip></v-btn>
        <v-btn v-if="dirty" variant="text" :disabled="locked" @click="reset">{{ $t('admin:analytics.resetDraft') }}</v-btn>
        <v-btn color="primary" :disabled="locked || !dirty" @click="review">{{ $t('admin:analytics.reviewChanges') }}</v-btn>
      </template>
    </admin-hero>
    <async-state
      v-if="loading && !saved"
      state="loading"
      :title="$t('admin:analytics.loadingAnalytics')"
      :message="$t('admin:analytics.readingCollectionPolicyIntegrations')"
    />
    <async-state
      v-else-if="error && !saved"
      state="error"
      :title="$t('admin:analytics.analyticsCouldNotLoaded2')"
      :message="error"
      :retry-label="$t('admin:analytics.tryAgain')"
      @retry="load"
    />
    <v-alert v-else-if="error" type="error" variant="tonal" class="mb-5">{{ error }}</v-alert>
    <v-alert v-if="stale" type="warning" variant="tonal" class="mb-5">
      {{ $t('admin:analytics.savedStateChangedAction') }}
    </v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" class="mb-5">{{ notice }}</v-alert>
    <template v-if="saved && policy">
      <div class="analytics-status">
        <span>
          <i :class="{ 'is-draft': dirty }" />
          {{ dirty ? $t('admin:analytics.unsavedAnalyticsDraft') : $t('admin:analytics.showingSavedSettings') }}
        </span>
        <span>{{ $t('admin:analytics.observed', { observedAt: dateTime(saved.observedAt), interpolation: { escapeValue: false } }) }}</span>
      </div>
      <nav class="analytics-tabs" :aria-label="$t('admin:analytics.analyticsSections')">
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
              <span class="analytics-kicker">{{ $t('admin:analytics.n01ReadingPulse') }}</span>
              <h2>{{ $t('admin:analytics.knowledgeUse') }}</h2>
              <p>{{ $t('admin:analytics.localEvidenceCompletedReader') }}</p>
            </div>
            <div class="analytics-metrics">
              <div>
                <span>{{ $t('admin:analytics.recordedReaderResponses') }}</span>
                <strong><animated-number :value="saved.insights.totalResponses" :duration="700" :format-value="number" /></strong>
                <small>{{ $t('admin:analytics.utc', { from: saved.insights.from, through: saved.insights.through, interpolation: { escapeValue: false } }) }}</small>
              </div>
              <div>
                <span>{{ $t('admin:analytics.sharedPagesReached') }}</span>
                <strong><animated-number :value="saved.insights.pages" :duration="700" :format-value="number" /></strong>
                <small>{{ $t('admin:analytics.currentPublishedUnprotectedPages') }}</small>
              </div>
            </div>
            <div class="analytics-section-head">
              <h3>{{ $t('admin:analytics.dailyResponseHistory') }}</h3>
              <v-select
                :model-value="reportDays"
                :items="reportWindows"
                :label="$t('admin:analytics.reportingWindow')"
                variant="outlined"
                density="compact"
                hide-details
                class="analytics-window"
                :disabled="locked"
                @update:model-value="selectWindow"
              />
              <v-btn variant="text" prepend-icon="mdi-download" :disabled="!saved.insights.daily.length" @click="exportCounts">{{ $t('admin:analytics.exportCounts') }}</v-btn>
            </div>
            <div v-if="!saved.insights.totalResponses" class="analytics-empty">
              <v-icon size="36" icon="mdi-chart-timeline-variant" />
              <h3>{{ $t('admin:analytics.noReaderResponsesRecorded') }}</h3>
              <p>
                {{
                  saved.policy.localEnabled
                    ? $t('admin:analytics.eligibleResponsesWillAppear')
                    : $t('admin:analytics.localCountsPausedEnable')
                }}
              </p>
              <v-btn variant="outlined" @click="selectSection('collection')">{{ $t('admin:analytics.reviewCollectionPolicy') }}</v-btn>
            </div>
            <figure v-else class="analytics-chart">
              <svg
                class="analytics-chart-svg"
                viewBox="0 0 720 180"
                role="img"
                :aria-label="$t('admin:analytics.dailyRecordedReaderResponses')"
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
                >
                  <title>{{ $t('admin:analytics.responses', { day: bar.day, responses: number(bar.responses), interpolation: { escapeValue: false } }) }}</title>
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
                <span class="analytics-chart-readout__count"><strong>{{ number(activeBar.responses) }}</strong> {{ $t('admin:analytics.responses2') }}</span>
              </div>
              <figcaption>
                <span>{{ saved.insights.from }}</span>
                <span>{{ saved.insights.through }}</span>
              </figcaption>
            </figure>
            <details v-if="saved.insights.daily.length" class="analytics-detail-table">
              <summary>{{ $t('admin:analytics.viewExactDailyCounts') }}</summary>
              <div class="analytics-table-scroll" tabindex="0" role="region" :aria-label="$t('admin:analytics.dailyResponseCounts')">
                <table>
                  <caption class="sr-only">{{ $t('admin:analytics.recordedResponsesUtcDay') }}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{{ $t('admin:analytics.day') }}</th>
                      <th scope="col">{{ $t('admin:analytics.responses3') }}</th>
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
                <h3>{{ $t('admin:analytics.mostReadSharedPages') }}</h3>
                <p>{{ $t('admin:analytics.up15PagesRetained') }}</p>
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
            <p v-else class="analytics-muted">{{ $t('admin:analytics.pageRankingsAppearWhen') }}</p>
            <p class="analytics-footnote">
              {{ $t('admin:analytics.countsCanIncludeAutomated') }}
            </p>
          </template>
          <template v-else-if="section === 'collection'">
            <div class="analytics-heading">
              <span class="analytics-kicker">{{ $t('admin:analytics.n02IntentionalMeasurement') }}</span>
              <h2>{{ $t('admin:analytics.chooseWhatCounts') }}</h2>
              <p>{{ $t('admin:analytics.onePolicyGovernsLocal') }}</p>
            </div>
            <div class="analytics-setting">
              <div>
                <h3>{{ $t('admin:analytics.localReaderCounts') }}</h3>
                <p>
                  {{ $t('admin:analytics.storeDailyCountPer') }}
                </p>
              </div>
              <v-switch v-model="policy.localEnabled" :label="$t('admin:analytics.recordLocalReaderCounts')" color="primary" hide-details :disabled="locked" />
            </div>
            <div class="analytics-setting">
              <div>
                <h3>{{ $t('admin:analytics.externalIntegrations') }}</h3>
                <p>
                  {{ $t('admin:analytics.allowEnabledProvidersEmbed') }}
                </p>
              </div>
              <v-switch v-model="policy.externalEnabled" :label="$t('admin:analytics.allowExternalIntegrations')" color="primary" hide-details :disabled="locked" />
            </div>
            <v-alert v-if="saved.offline" type="info" variant="tonal" class="mb-5">
              {{ $t('admin:analytics.offlineModeSuspendsExternal') }}
            </v-alert>
            <div class="analytics-setting">
              <div>
                <h3>{{ $t('admin:analytics.readerAudience') }}</h3>
                <p>
                  {{ $t('admin:analytics.appliesOnlyPublishedShared') }}
                </p>
              </div>
              <v-select
                v-model="policy.audience"
                :items="audiences"
                :label="$t('admin:analytics.measureResponses')"
                variant="outlined"
                hide-details
                :disabled="locked"
              />
            </div>
            <div class="analytics-setting">
              <div>
                <h3>{{ $t('admin:analytics.keepAdministrationOut') }}</h3>
                <p>{{ $t('admin:analytics.excludeReaderRequestsMade') }}</p>
              </div>
              <v-switch
                v-model="policy.excludeAdministrators"
                :label="$t('admin:analytics.excludeSystemAdministrators')"
                color="primary"
                hide-details
                :disabled="locked"
              />
            </div>
            <div class="analytics-setting">
              <div>
                <h3>{{ $t('admin:analytics.respectRequestPrivacySignals') }}</h3>
                <p>{{ $t('admin:analytics.skipBothLocalExternal') }}</p>
              </div>
              <v-switch v-model="policy.respectPrivacySignals" :label="$t('admin:analytics.honorDntGpcHeaders')" color="primary" hide-details :disabled="locked" />
            </div>
            <div class="analytics-setting analytics-setting-wide">
              <div>
                <h3>{{ $t('admin:analytics.excludedPathsSections') }}</h3>
                <p>
                  {{ $t('admin:analytics.oneLiteralPagePath') }}
                </p>
              </div>
              <v-textarea
                v-model="excludedText"
                :label="$t('admin:analytics.excludedPagePaths')"
                variant="outlined"
                rows="3"
                auto-grow
                :disabled="locked"
                :error-messages="policyErrors"
              />
            </div>
            <div class="analytics-setting">
              <div>
                <h3>{{ $t('admin:analytics.localRetention') }}</h3>
                <p>
                  {{ $t('admin:analytics.reportUsesInclusiveUtc') }}
                </p>
              </div>
              <v-select
                v-model="policy.retentionDays"
                :items="[
                  { title: $t('admin:analytics.n30Days'), value: 30 },
                  { title: $t('admin:analytics.n90Days'), value: 90 },
                  { title: $t('admin:analytics.n365Days'), value: 365 }
                ]"
                :label="$t('admin:analytics.retainLocalCounts')"
                variant="outlined"
                hide-details
                :disabled="locked"
              />
            </div>
            <div class="analytics-section-head">
              <div>
                <h3>{{ $t('admin:analytics.collectionPreview') }}</h3>
                <p>{{ $t('admin:analytics.simulationDraftNotLive') }}</p>
              </div>
            </div>
            <div class="analytics-simulator">
              <v-text-field v-model="simulation.path" :label="$t('admin:analytics.examplePagePath')" variant="outlined" hide-details />
              <v-select
                v-model="simulation.reader"
                :items="[
                  { title: $t('admin:analytics.anonymousReader'), value: 'anonymous' },
                  { title: $t('admin:analytics.signedReader'), value: 'signed-in' },
                  { title: $t('admin:analytics.systemAdministrator'), value: 'administrator' }
                ]"
                :label="$t('admin:analytics.exampleReader')"
                variant="outlined"
                hide-details
              />
              <v-checkbox v-model="simulation.privacySignal" :label="$t('admin:analytics.requestSendsDntGpc')" hide-details />
              <div role="status" class="analytics-simulation-result">
                <strong>
                  {{ $t(simulationResult.local ? 'admin:analytics.simulationLocalEligible' : 'admin:analytics.simulationLocalExcluded') }}
                  · {{ $t(simulationResult.external ? 'admin:analytics.simulationExternalEligible' : 'admin:analytics.simulationExternalExcluded') }}
                </strong>
                <p>{{ simulationReason }} {{ $t('admin:analytics.simulationProvidersRequired') }}</p>
              </div>
            </div>
            <div class="analytics-erasure">
              <div>
                <h3>{{ $t('admin:analytics.eraseLocalHistory') }}</h3>
                <p>{{ $t('admin:analytics.removeAllStoredLocal') }}</p>
              </div>
              <v-btn variant="outlined" color="error" :disabled="locked || dirty" @click="openErase">{{ $t('admin:analytics.reviewErasure') }}</v-btn>
            </div>
          </template>
          <template v-else-if="section === 'providers'">
            <div class="analytics-heading">
              <span class="analytics-kicker">{{ $t('admin:analytics.n03DeliberateConnections') }}</span>
              <h2>{{ $t('admin:analytics.giveEveryIntegrationPurpose') }}</h2>
              <p>{{ $t('admin:analytics.configureProvidersIndependentlyExternal') }}</p>
            </div>
            <div class="analytics-provider-filter">
              <v-text-field v-model="search" :label="$t('admin:analytics.findProvider')" prepend-inner-icon="mdi-magnify" variant="outlined" hide-details clearable />
              <v-select v-model="category" :items="categories" :label="$t('admin:analytics.providerCategory')" variant="outlined" hide-details />
            </div>
            <div class="analytics-provider-layout">
              <nav :aria-label="$t('admin:analytics.analyticsProviders')" class="analytics-provider-list">
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
                <p v-if="!filteredProviders.length" class="analytics-muted">{{ $t('admin:analytics.noProvidersMatchTry') }}</p>
              </nav>
              <article v-if="provider && providerDraft" class="analytics-provider-detail">
                <span class="analytics-kicker">{{ categoryLabel(provider.category) }}</span>
                <h3>{{ provider.title }}</h3>
                <p>{{ provider.description }}</p>
                <v-switch
                  v-model="providerDraft.isEnabled"
                  :label="$t('admin:analytics.enable', { title: provider.title, interpolation: { escapeValue: false } })"
                  color="primary"
                  hide-details
                  :disabled="locked || (!provider.isAvailable && !providerDraft.isEnabled)"
                />
                <div class="analytics-capabilities">
                  <span v-for="capability in provider.capabilities" :key="capability">{{ capability }}</span>
                </div>
                <v-alert v-if="!provider.isAvailable" type="warning" variant="tonal">
                  {{ $t('admin:analytics.integrationUnavailableSavedEnablement') }}
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
                      :label="field.optional ? $t('admin:analytics.optionalFieldLabel', { field: field.title }) : field.title"
                      :hint="field.hint"
                      persistent-hint
                      variant="outlined"
                      :inputmode="field.kind === 'number' ? 'numeric' : field.kind === 'url' ? 'url' : 'text'"
                      :disabled="locked || !provider.isAvailable"
                    />
                  </template>
                </div>
                <div v-if="providerProblems.length" class="analytics-provider-problems" role="status">
                  <strong>{{ providerDraft.isEnabled ? $t('admin:analytics.resolveBeforePublication') : $t('admin:analytics.neededBeforeEnabling') }}</strong>
                  <ul>
                    <li v-for="issue in providerProblems" :key="issue">{{ issue }}</li>
                  </ul>
                </div>
                <div class="analytics-hosts">
                  <h4>{{ $t('admin:analytics.declaredScriptConfiguredHosts') }}</h4>
                  <ul v-if="providerHosts.length">
                    <li v-for="host in providerHosts" :key="host">
                      <code>{{ host }}</code>
                    </li>
                  </ul>
                  <p v-else>{{ $t('admin:analytics.completeServerFieldsSee') }}</p>
                  <small>{{ $t('admin:analytics.sdksTagContainersMay') }}</small>
                </div>
                <p class="analytics-footnote">
                  {{ $t('admin:analytics.trackingIdentifiersEnteredHere') }}
                </p>
                <v-btn
                  v-if="provider.website"
                  :href="provider.website"
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="text"
                  append-icon="mdi-open-in-new"
                  :aria-label="$t('admin:analytics.websiteOpensNewTab', { title: provider.title, interpolation: { escapeValue: false } })"
                >
                  {{ $t('admin:analytics.providerWebsite') }}
                </v-btn>
              </article>
              <div v-else class="analytics-empty">
                <h3>{{ $t('admin:analytics.selectIntegration') }}</h3>
                <p>{{ $t('admin:analytics.chooseProviderInspectConfiguration') }}</p>
              </div>
            </div>
          </template>
          <template v-else>
            <div class="analytics-heading">
              <span class="analytics-kicker">{{ $t('admin:analytics.n04AccountableRecord') }}</span>
              <h2>{{ $t('admin:analytics.decisionsContext') }}</h2>
              <p>{{ $t('admin:analytics.latest50CollectionChanges') }}</p>
            </div>
            <div v-if="!saved.history.length" class="analytics-empty">
              <h3>{{ $t('admin:analytics.noAdministrativeActivityYet') }}</h3>
              <p>{{ $t('admin:analytics.publishingSettingsErasingLocal') }}</p>
            </div>
            <ol v-else class="analytics-history">
              <li v-for="event in saved.history" :key="event.id">
                <span class="analytics-event-icon"><v-icon :icon="event.kind === 'erase' ? 'mdi-delete-outline' : 'mdi-check'" /></span>
                <div>
                  <div class="analytics-section-head">
                    <h3>{{ event.kind === 'erase' ? $t('admin:analytics.localHistoryErased') : $t('admin:analytics.analyticsPublished') }}</h3>
                    <time :datetime="event.createdAt">{{ dateTime(event.createdAt) }}</time>
                  </div>
                  <p>{{ event.reason }}</p>
                  <small>
                    {{ event.actorId === null ? $t('admin:analytics.apiPrincipal') : $t('admin:analytics.account', { actorId: event.actorId, interpolation: { escapeValue: false } }) }}
                    <template v-if="event.kind === 'erase'">{{ $t('admin:analytics.dailyRecordsRemoved', { number: number(event.erasedRows || 0), interpolation: { escapeValue: false } }) }}</template>
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
          <span class="analytics-kicker">{{ $t('admin:analytics.collectionGlance') }}</span>
          <div class="analytics-policy-card">
            <div>
              <span>{{ $t('admin:analytics.localCounts') }}</span>
              <strong>{{ policy.localEnabled ? $t('admin:analytics.enabled') : $t('admin:analytics.paused') }}</strong>
            </div>
            <div>
              <span>{{ $t('admin:analytics.externalScripts') }}</span>
              <strong>{{ saved.offline ? $t('admin:analytics.offline') : policy.externalEnabled ? $t('admin:analytics.allowed') : $t('admin:analytics.paused') }}</strong>
            </div>
            <div>
              <span>{{ $t('admin:analytics.enabledProviders') }}</span>
              <strong>{{ enabledCount }}</strong>
            </div>
            <div>
              <span>{{ $t('admin:analytics.audience') }}</span>
              <strong>{{ audiences.find((row) => row.value === policy!.audience)?.title }}</strong>
            </div>
            <div>
              <span>{{ $t('admin:analytics.retainedHistory') }}</span>
              <strong>{{ $t('admin:analytics.days2', { retentionDays: policy.retentionDays, interpolation: { escapeValue: false } }) }}</strong>
            </div>
          </div>
          <p v-if="dirty" class="analytics-footnote">{{ $t('admin:analytics.summaryReflectsDraftOverview') }}</p>
          <div class="analytics-aside-note">
            <h3>{{ $t('admin:analytics.measureContext') }}</h3>
            <p>
              {{ $t('admin:analytics.localCountersDescribeRecorded') }}
            </p>
          </div>
          <div class="analytics-aside-note">
            <h3>{{ $t('admin:analytics.publication') }}</h3>
            <p>{{ $t('admin:analytics.settingsApplyNextReader') }}</p>
          </div>
        </aside>
      </div>
    </template>
    <v-dialog v-model="reviewOpen" max-width="760" :persistent="busy" aria-labelledby="analytics-review-title">
      <v-card v-if="reviewDraft" class="analytics-dialog">
        <v-card-title id="analytics-review-title">{{ $t('admin:analytics.reviewAnalyticsPublication') }}</v-card-title>
        <v-card-text>
          <p>{{ $t('admin:analytics.publishCollectionPolicyProvider') }}</p>
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
            <p>{{ row.isEnabled ? $t('admin:analytics.enabled') : $t('admin:analytics.disabled') }}</p>
            <dl>
              <template v-for="field in changedProviderFields(row)" :key="field.key">
                <dt>{{ field.title }}</dt>
                <dd>
                  <del>{{ field.before || $t('admin:analytics.empty') }}</del>
                  <strong>{{ field.after || $t('admin:analytics.empty') }}</strong>
                </dd>
              </template>
            </dl>
          </div>
          <v-alert v-if="reviewDraft.policy.retentionDays < (saved?.policy.retentionDays || 0)" type="warning" variant="tonal" class="my-4">
            {{ $t('admin:analytics.olderCountersWillLeave') }}
          </v-alert>
          <v-textarea v-model="reason" :label="$t('admin:analytics.reasonChange')" variant="outlined" rows="2" counter="1000" maxlength="1000" :disabled="busy" />
          <p v-if="reviewError" class="analytics-error" role="alert">{{ reviewError }}</p>
        </v-card-text>
        <v-card-actions>
          <v-btn :disabled="busy" @click="reviewOpen = false">{{ $t('admin:analytics.backDraft') }}</v-btn>
          <v-spacer />
          <v-btn color="primary" variant="flat" :disabled="reason.trim().length < 3 || busy || stale" :loading="busy" @click="publish">
            {{ $t('admin:analytics.publishAnalytics') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog v-model="eraseOpen" max-width="640" :persistent="busy" aria-labelledby="analytics-erase-title">
      <v-card class="analytics-dialog">
        <v-card-title id="analytics-erase-title">{{ $t('admin:analytics.eraseLocalResponseHistory') }}</v-card-title>
        <v-card-text>
          <p>
            {{ $t('admin:analytics.permanentlyRemovesAllLocal') }}
          </p>
          <v-text-field v-model="eraseConfirmation" :label="$t('admin:analytics.typeEraseLocalCounts')" variant="outlined" :disabled="busy" />
          <v-textarea v-model="reason" :label="$t('admin:analytics.reasonErasingLocalCounts')" variant="outlined" rows="2" maxlength="1000" :disabled="busy" />
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
            {{ $t('admin:analytics.eraseLocalCounts') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>
<script setup lang="ts">
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
    { key: 'overview', title: t('admin:analytics.overview') },
    { key: 'collection', title: t('admin:analytics.collection') },
    { key: 'providers', title: t('admin:analytics.providers') },
    { key: 'activity', title: t('admin:analytics.activity') }
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
  { title: t('admin:analytics.retainedWindow'), value: 0 },
  ...[7, 30, 90, 365].filter((days) => days <= (saved.value?.policy.retentionDays || 90)).map((days) => ({ title: t('admin:analytics.lastDays', { days, interpolation: { escapeValue: false } }), value: days }))
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
  { title: t('admin:analytics.everyone'), value: 'everyone' },
  { title: t('admin:analytics.anonymousReaders'), value: 'anonymous' },
  { title: t('admin:analytics.signedReaders'), value: 'signed-in' }
]
const categories = [
  { title: t('admin:analytics.allPurposes'), value: 'all' },
  { title: t('admin:analytics.trafficMeasurement'), value: 'traffic' },
  { title: t('admin:analytics.sessionReplay'), value: 'replay' },
  { title: t('admin:analytics.browserPerformance'), value: 'performance' },
  { title: t('admin:analytics.tagContainers'), value: 'tags' }
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
    ? t('admin:analytics.unavailable')
    : row?.isEnabled
      ? analyticsProviderIssues(row).length
        ? t('admin:analytics.needsConfiguration')
        : t('admin:analytics.enabledReadyEmbed')
      : t('admin:analytics.disabled')
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
  dateTime = (value: string) => new Date(value).toLocaleString()
const fieldLabel = (key: string) =>
  ({
    localEnabled: t('admin:analytics.localReaderCounts'),
    externalEnabled: t('admin:analytics.externalIntegrations'),
    audience: t('admin:analytics.readerAudience'),
    excludeAdministrators: t('admin:analytics.excludeAdministrators'),
    respectPrivacySignals: t('admin:analytics.honorPrivacySignals'),
    excludedPaths: t('admin:analytics.excludedPaths'),
    retentionDays: t('admin:analytics.localRetention')
  })[key] || key
const display = (key: string, value: unknown) =>
  key === 'retentionDays'
    ? t('admin:analytics.days', { value, interpolation: { escapeValue: false } })
    : typeof value === 'boolean'
      ? value
        ? t('admin:analytics.yes')
        : t('admin:analytics.no')
      : Array.isArray(value)
        ? value.join(', ') || t('admin:analytics.none')
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
        before: field.kind === 'boolean' ? (original.config[field.key] === 'true' ? t('admin:analytics.on') : t('admin:analytics.off')) : original.config[field.key],
        after: field.kind === 'boolean' ? (row.config[field.key] === 'true' ? t('admin:analytics.on') : t('admin:analytics.off')) : row.config[field.key]
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
    if (id === sequence && !disposed) error.value = err instanceof Error ? err.message : t('admin:analytics.analyticsCouldNotLoaded')
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
      error.value = t('admin:analytics.analyticsSettingsChangedReload')
      return
    }
    clearChartPointer()
    saved.value = { ...current, insights: value.insights, observedAt: value.observedAt }
    reportDays.value = days
  } catch (err) {
    if (!disposed && id === sequence) error.value = err instanceof Error ? err.message : t('admin:analytics.reportingWindowCouldNot')
  } finally {
    if (!disposed && id === sequence) loading.value = false
  }
}
const discardTitle = t('admin:analytics.discardDraft'),
  discardMessage = t('admin:analytics.thereUnpublishedAnalyticsChanges')
async function guarded(action: () => void) {
  if (!dirty.value) return action()
  if (!(await confirmDiscard(discardTitle, discardMessage, t('admin:analytics.discardDraft2')))) return
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
    error.value = validation.error.issues[0]?.message || t('admin:analytics.checkCollectionPolicy')
    selectSection('collection')
    return
  }
  if (invalid) {
    selected.value = invalid.key
    selectSection('providers')
    error.value = t('admin:analytics.needsValidConfigurationBefore', { key: providerTitle(invalid.key), interpolation: { escapeValue: false } })
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
      error.value = t('admin:analytics.actionWasConfirmedBut')
    }
  } catch (err) {
    reviewError.value = err instanceof Error ? err.message : t('admin:analytics.outcomeUnconfirmed')
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
    t('admin:analytics.analyticsPublishedPolicyApplies'),
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
    t('admin:analytics.localResponseHistoryErased'),
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
  return !busy.value && (await confirmDiscard(discardTitle, discardMessage, t('admin:analytics.discardDraft2')))
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
