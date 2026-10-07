<template>
  <v-container fluid class="locale-workspace">
    <admin-hero icon="mdi-translate" :title="$t('admin:locale.title')" :description="$t('admin:locale.makeKnowledgeFeelHome')">
      <template #actions>
        <v-btn variant="text" prepend-icon="mdi-refresh" :disabled="busy || loading" @click="reload">{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ $t('admin:locale.reloadSavedLanguageSettings') }}</v-tooltip></v-btn>
        <v-btn color="primary" :disabled="locked || !dirty" @click="review">{{ $t('admin:locale.reviewChanges') }}</v-btn>
      </template>
    </admin-hero>
    <async-state
      v-if="loading && !saved"
      state="loading"
      :title="$t('admin:locale.loadingLanguageWorkspace')"
      :message="$t('admin:locale.readingInstalledPackagesRouting')"
    />
    <async-state
      v-else-if="loadError && !saved"
      state="error"
      :title="$t('admin:locale.localeCouldNotLoaded')"
      :message="loadError"
      :retry-label="$t('admin:locale.tryAgain')"
      @retry="load()"
    />
    <v-alert v-else-if="loadError" type="error" variant="tonal" class="mb-5">{{ loadError }}</v-alert>
    <v-alert v-if="stale && !busy" type="warning" variant="tonal" class="mb-5"
      >{{ $t('admin:locale.savedLanguageStateChanged') }}</v-alert
    >
    <v-alert v-if="notice" :type="attention ? 'warning' : 'success'" variant="tonal" class="mb-5">{{ notice }}</v-alert>
    <template v-if="saved && draft">
      <div class="locale-status">
        <span><i :class="{ 'is-draft': dirty }" />{{ dirty ? $t('admin:locale.unsavedLanguageDraft') : $t('admin:locale.showingSavedLanguages') }}</span
        ><span>{{ saved.runtime.state === 'applied' ? $t('admin:locale.runtimeLanguageCurrent') : $t('admin:locale.runtimeActivationNeedsAttention2') }}</span>
      </div>
      <nav class="locale-tabs" :aria-label="$t('admin:locale.localeSections')">
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
      <div class="locale-layout">
        <section class="locale-editor">
          <template v-if="section === 'languages'">
            <div class="locale-heading">
              <span class="locale-kicker">{{ $t('admin:locale.n01MultilingualHome') }}</span>
              <h2>{{ $t('admin:locale.welcomeEveryReader') }}</h2>
              <p>{{ $t('admin:locale.chooseLanguageReadersMeet') }}</p>
            </div>
            <div class="locale-default">
              <div>
                <h3>{{ $t('admin:locale.defaultLanguage') }}</h3>
                <p>{{ $t('admin:locale.usedUnprefixedPageAddresses') }}</p>
              </div>
              <v-select
                v-model="draft.locale"
                :items="installed"
                item-title="displayName"
                item-value="code"
                :label="$t('admin:locale.defaultLanguage')"
                variant="outlined"
                density="comfortable"
                hide-details
                :disabled="locked"
              />
            </div>
            <div class="locale-section-head">
              <div>
                <h3>{{ $t('admin:locale.installedLanguages') }}</h3>
                <p>
                  {{
                    draft.namespacing
                      ? $t('admin:locale.selectLanguagesOfferedReaders')
                      : $t('admin:locale.multilingualRoutingOffOther')
                  }}
                </p>
              </div>
              <v-btn variant="text" append-icon="mdi-arrow-right" @click="selectSection('library')">{{ $t('admin:locale.findLanguage') }}</v-btn>
            </div>
            <div class="locale-installed">
              <article
                v-for="locale in installed"
                :key="locale.code"
                class="locale-language"
                :class="{ 'is-default': locale.code === draft.locale }"
              >
                <span class="locale-code" aria-hidden="true">{{ locale.code }}</span>
                <div class="locale-language-body">
                  <h4>{{ locale.nativeName }} <span v-if="locale.code === draft.locale" class="locale-badge">{{ $t('admin:locale.default') }}</span></h4>
                  <p>{{ locale.name }} · {{ locale.isRTL ? $t('admin:locale.rightLeft') : $t('admin:locale.leftRight') }}</p>
                  <div class="locale-language-counts">
                    <span>{{ $t('admin:locale.publicPages', { pages: locale.pages, interpolation: { escapeValue: false } }) }}</span><span>{{ $t('admin:locale.translationSets', { linkedTranslations: locale.linkedTranslations, interpolation: { escapeValue: false } }) }}</span
                    ><span>{{ $t('admin:locale.menuItems', { menuItems: locale.menuItems, interpolation: { escapeValue: false } }) }}</span>
                  </div>
                </div>
                <v-checkbox
                  :model-value="enabled(locale.code)"
                  :disabled="locked || !draft.namespacing || locale.code === draft.locale"
                  :aria-label="$t('admin:locale.offerReaders', { name: locale.name, interpolation: { escapeValue: false } })"
                  hide-details
                  density="compact"
                  @update:model-value="toggleLanguage(locale.code, $event === true)"
                />
              </article>
            </div>
            <div class="locale-note">
              <v-icon icon="mdi-information-outline" size="20" />
              <p>
                {{ $t('admin:locale.installingLanguageTranslatesSupported') }}
              </p>
            </div>
            <div class="locale-section-head">
              <div>
                <h3>{{ $t('admin:locale.keepTranslationsConnected') }}</h3>
                <p>
                  {{ $t('admin:locale.usePageTranslationSets') }}
                </p>
              </div>
              <v-btn variant="text" to="/pages" append-icon="mdi-arrow-right">{{ $t('admin:locale.managePages') }}</v-btn>
            </div>
          </template>
          <template v-else-if="section === 'routing'">
            <div class="locale-heading">
              <span class="locale-kicker">{{ $t('admin:locale.n02LanguageLocation') }}</span>
              <h2>{{ $t('admin:locale.clearAddressEveryLanguage') }}</h2>
              <p>{{ $t('admin:locale.chooseHowReadersMove') }}</p>
            </div>
            <div class="locale-setting">
              <div>
                <h3>{{ $t('admin:locale.multilingualWorkspace') }}</h3>
                <p>{{ $t('admin:locale.offerSelectedReadingLanguages') }}</p>
              </div>
              <v-switch
                v-model="draft.namespacing"
                :disabled="locked"
                :aria-label="$t('admin:locale.multilingualWorkspace')"
                hide-details
                color="primary"
                inset
              />
            </div>
            <div class="locale-paths">
              <div>
                <span>{{ $t('admin:locale.defaultHome') }}</span><code>{{ localeReadingPath(draft) }}</code>
              </div>
              <div v-for="locale in readingLanguages.filter((row) => row.code !== draft?.locale)" :key="locale.code">
                <span>{{ locale.nativeName }}</span
                ><code>{{ localeReadingPath(draft, locale.code) }}</code>
              </div>
            </div>
            <v-alert v-if="draft.namespacing" type="info" variant="tonal" class="my-5"
              >{{ $t('admin:locale.unprefixedPageAddressesRedirect', { locale: draft.locale, interpolation: { escapeValue: false } }) }}</v-alert
            >
            <div class="locale-setting">
              <div>
                <h3>{{ $t('admin:locale.automaticInterfaceUpdates') }}</h3>
                <p>{{ $t('admin:locale.letDailyLanguageSynchronization') }}</p>
                <p v-if="saved.catalog.offline" class="locale-muted">{{ $t('admin:locale.updatesPausedWhileOffline') }}</p>
              </div>
              <v-switch
                v-model="draft.autoUpdate"
                :disabled="locked"
                :aria-label="$t('admin:locale.automaticInterfaceUpdates')"
                hide-details
                color="primary"
                inset
              />
            </div>
            <div class="locale-related">
              <v-icon icon="mdi-compass-outline" size="23" />
              <div>
                <h3>{{ $t('admin:locale.giveEachLanguageOwn') }}</h3>
                <p>{{ $t('admin:locale.curateDestinationsAudienceVisibility') }}</p>
              </div>
              <v-btn variant="text" to="/navigation" append-icon="mdi-arrow-right">{{ $t('admin:locale.navigation') }}</v-btn>
            </div>
          </template>
          <template v-else-if="section === 'library'">
            <div class="locale-heading">
              <span class="locale-kicker">{{ $t('admin:locale.n03InterfacePackages') }}</span>
              <h2>{{ $t('admin:locale.libraryLanguages') }}</h2>
              <p>
                {{ $t('admin:locale.installLanguageBeforeOffering') }}
              </p>
            </div>
            <v-alert v-if="saved.catalog.offline" type="info" variant="tonal" class="mb-5"
              >{{ $t('admin:locale.offlineModePausesRemote') }}</v-alert
            >
            <div class="locale-library-toolbar">
              <v-text-field
                v-model="search"
                :label="$t('admin:locale.findLanguage')"
                prepend-inner-icon="mdi-magnify"
                variant="outlined"
                density="compact"
                hide-details
                clearable
              /><v-select
                v-model="packageFilter"
                :items="packageFilters"
                :label="$t('admin:locale.packageFilter')"
                variant="outlined"
                density="compact"
                hide-details
              /><v-btn variant="text" prepend-icon="mdi-refresh" :disabled="!canOperate" @click="openOperation('catalog')"
                >{{ $t('admin:locale.refreshCatalog') }}</v-btn
              >
            </div>
            <p class="locale-catalog-source">
              {{ $t('admin:locale.languages2', { filteredPackagesCount: filteredPackages.length, source: saved.catalog.source || $t('admin:locale.sourceUnavailable'), observedAt: saved.catalog.observedAt ? $t('admin:locale.catalogChecked', { observedAt: date(saved.catalog.observedAt), interpolation: { escapeValue: false } }) : $t('admin:locale.cachedCatalogRefreshTime'), interpolation: { escapeValue: false } }) }}
            </p>
            <section class="locale-local-import" aria-labelledby="locale-local-import-title">
              <div class="locale-local-import__heading">
                <v-icon icon="mdi-file-upload-outline" size="23" />
                <div>
                  <span class="locale-kicker">{{ $t('admin:locale.reviewedLocalPackage') }}</span>
                  <h3 id="locale-local-import-title">{{ $t('admin:locale.installTranslationFile') }}</h3>
                  <p>{{ $t('admin:locale.chooseSupportedLanguageReview') }}</p>
                </div>
              </div>
              <div class="locale-local-import__form">
                <label class="locale-local-import__file" for="locale-local-file">
                  <span>{{ $t('admin:locale.flatUtf8Json') }}</span>
                  <input
                    id="locale-local-file"
                    ref="localFileInput"
                    type="file"
                    accept=".json,application/json"
                    :disabled="!canUploadLocalFile"
                    @change="selectLocalFile"
                  />
                  <small v-if="localFile">{{ localFile.name }} · {{ byteSize(localFile.size) }}</small>
                  <small v-else>{{ $t('admin:locale.filenameOnlyLabelDoes') }}</small>
                </label>
                <v-select
                  v-model="localCode"
                  :items="uploadLocales"
                  item-title="displayName"
                  item-value="code"
                  :label="$t('admin:locale.targetLanguage')"
                  variant="outlined"
                  density="comfortable"
                  :disabled="!canUploadLocalFile || (localReview !== null && localFile === null)"
                  @update:model-value="clearLocalReview"
                />
                <v-textarea
                  v-model="localReason"
                  :label="$t('admin:locale.reasonInstallingFile')"
                  variant="outlined"
                  rows="2"
                  maxlength="1000"
                  counter
                  :disabled="!canUploadLocalFile || (localReview !== null && localFile === null)"
                  @update:model-value="clearLocalReview"
                />
              </div>
              <v-alert v-if="localUploadError" type="error" variant="tonal" class="mb-3">{{ localUploadError }}</v-alert>
              <div class="locale-local-import__actions">
                <span v-if="localReview" class="locale-muted">{{ $t('admin:locale.reviewExpires', { expiresAt: date(localReview.expiresAt), interpolation: { escapeValue: false } }) }}</span>
                <v-btn
                  color="primary"
                  variant="tonal"
                  :disabled="!canReviewLocalFile"
                  :loading="busy"
                  @click="reviewLocalUpload"
                  >{{ $t('admin:locale.reviewFile') }}</v-btn
                >
              </div>
              <div v-if="localReview" class="locale-local-import__review">
                <div class="locale-local-import__identity">
                  <span class="locale-code" aria-hidden="true">{{ localReview.code }}</span>
                  <div>
                    <h4>{{ localReview.nativeName }} <small>({{ localReview.code }})</small></h4>
                    <p>{{ $t('admin:locale.sha256', { name: localReview.name, interpolation: { escapeValue: false } }) }} <code>{{ localReview.digest }}</code></p>
                    <p>{{ $t('admin:locale.reason', { reason: localReview.reason, interpolation: { escapeValue: false } }) }}</p>
                  </div>
                </div>
                <div class="locale-local-import__counts" :aria-label="$t('admin:locale.translationKeyChanges')">
                  <span><strong>{{ localReview.changes.added.length }}</strong> {{ $t('admin:locale.added') }}</span>
                  <span><strong>{{ localReview.changes.changed.length }}</strong> {{ $t('admin:locale.changed') }}</span>
                  <span><strong>{{ localReview.changes.removed.length }}</strong> {{ $t('admin:locale.removed') }}</span>
                </div>
                <details
                  v-for="change in reviewChangeTypes"
                  :key="change.key"
                  class="locale-local-import__change-list"
                  @toggle="toggleReviewChanges(change.key, $event)"
                >
                  <summary>{{ $t('admin:locale.keys', { label: change.label, value: localReview.changes[change.key].length, interpolation: { escapeValue: false } }) }}</summary>
                  <ul v-if="openReviewChange === change.key">
                    <li v-for="key in localReview.changes[change.key]" :key="key"><code>{{ key }}</code></li>
                  </ul>
                </details>
                <p class="locale-muted">{{ $t('admin:locale.stagedBytesAdministratorReason') }}</p>
                <div class="locale-local-import__actions">
                  <v-btn
                    color="primary"
                    variant="flat"
                    :disabled="!canCommitLocalFile"
                    :loading="busy"
                    @click="commitLocalUpload"
                    >{{ $t('admin:locale.commitQueuePublication') }}</v-btn
                  >
                </div>
              </div>
            </section>
            <p v-if="dirty" class="locale-muted">{{ $t('admin:locale.saveResetLanguageDraft') }}</p>
            <div v-if="filteredPackages.length" class="locale-package-list">
              <article v-for="locale in filteredPackages" :key="locale.code" class="locale-package-row">
                <span class="locale-code" aria-hidden="true">{{ locale.code }}</span>
                <div class="locale-package-name">
                  <h3>{{ locale.nativeName }}</h3>
                  <p>{{ locale.name }} · {{ locale.isRTL ? $t('admin:locale.rightLeft') : $t('admin:locale.leftRight') }}</p>
                  <span v-if="locale.isInstalled" class="locale-badge">{{
                    updateAvailable(locale) ? $t('admin:locale.updateAvailable') : $t('admin:locale.installed')
                  }}</span>
                </div>
                <div class="locale-coverage">
                  <strong>{{ locale.availability }}<small>%</small></strong
                  ><span>{{ $t('admin:locale.upstreamInterfaceCoverage') }}</span>
                  <div class="locale-coverage-track" aria-hidden="true"><i :style="{ width: locale.availability + '%' }" /></div>
                </div>
                <v-btn
                  :variant="locale.isInstalled ? 'text' : 'tonal'"
                  :disabled="!canOperate || !locale.availableRemotely"
                  :aria-label="$t('admin:locale.package', { isInstalled: locale.isInstalled ? $t('admin:locale.refreshPackage') : $t('admin:locale.install'), name: locale.name, interpolation: { escapeValue: false } })"
                  @click="openOperation('install', locale)"
                  >{{ locale.isInstalled ? $t('admin:locale.refreshPackage') : $t('admin:locale.install') }}</v-btn
                >
              </article>
            </div>
            <async-state
              v-else
              state="empty"
              :title="$t('admin:locale.noMatchingLanguages')"
              :message="$t('admin:locale.tryAnotherNamePackage')"
            />
            <div class="locale-note">
              <v-icon icon="mdi-translate" size="20" />
              <p>
                {{ $t('admin:locale.coverageReportedUpstreamTranslation') }}
              </p>
            </div>
          </template>
          <template v-else>
            <div class="locale-heading">
              <span class="locale-kicker">{{ $t('admin:locale.n04ChangesOperations') }}</span>
              <h2>{{ $t('admin:locale.traceableLanguageWorkspace') }}</h2>
              <p>{{ $t('admin:locale.followServerWorkReview') }}</p>
            </div>
            <h3 class="mb-4">{{ $t('admin:locale.packageOperations') }}</h3>
            <div v-if="saved.operations.length" class="locale-operations">
              <article v-for="operation in saved.operations" :key="operation.id" class="locale-operation">
                <v-icon :icon="operationIcon(operation.state)" size="22" />
                <div>
                  <h4>
                    {{
                      operation.kind === 'catalog'
                        ? $t('admin:locale.refreshLanguageCatalog')
                        : operation.kind === 'local'
                          ? $t('admin:locale.installReviewedLocalFile', { code: operation.code, interpolation: { escapeValue: false } })
                          : $t('admin:locale.installRefresh', { code: operation.code, interpolation: { escapeValue: false } })
                    }}
                  </h4>
                  <p>
                    {{ $t('admin:locale.attempt', { createdAt: date(operation.createdAt), attempts: operation.attempts, interpolation: { escapeValue: false } }) }}
                    <span v-if="operation.message">· {{ operation.message }}</span>
                  </p>
                </div>
                <span class="locale-badge">{{ stateName(operation.state) }}</span>
              </article>
            </div>
            <p v-else class="locale-muted">
              {{ $t('admin:locale.noRecordedPackageOperations') }}
            </p>
            <h3 class="mt-8 mb-4">{{ $t('admin:locale.administrativeChanges') }}</h3>
            <div v-if="saved.history.length" class="locale-history">
              <article v-for="event in saved.history" :key="event.id">
                <span class="locale-history-mark" />
                <div>
                  <h4>{{ event.reason }}</h4>
                  <p>{{ event.fields.map(fieldName).join(' · ') }}</p>
                  <small
                    >{{ date(event.createdAt) }} · {{ event.actorId ? $t('admin:locale.administrator', { actorId: event.actorId, interpolation: { escapeValue: false } }) : $t('admin:locale.systemApi')
                    }}<span v-if="event.kind !== 'settings'">
                      · {{ event.appliedAt ? $t('admin:locale.published', { appliedAt: date(event.appliedAt), interpolation: { escapeValue: false } }) : $t('admin:locale.requested') }}</span
                    ></small
                  >
                </div>
              </article>
            </div>
            <p v-else class="locale-muted">{{ $t('admin:locale.noRecordedSettingsChanges') }}</p>
          </template>
        </section>
        <aside class="locale-aside" :aria-label="$t('admin:locale.languageWorkspaceOverview')">
          <span class="locale-kicker">{{ $t('admin:locale.readerLanguageMenu') }}</span>
          <div class="locale-specimen">
            <div>
              <v-icon icon="mdi-web" size="20" /><strong>{{ languageName(draft.locale) }}</strong>
            </div>
            <ul v-if="draft.namespacing">
              <li v-for="locale in readingLanguages" :key="locale.code" :dir="locale.isRTL ? 'rtl' : 'ltr'">
                <span>{{ locale.nativeName }}</span
                ><v-icon v-if="locale.code === draft.locale" icon="mdi-check" size="17" />
              </li>
            </ul>
            <p v-else>{{ $t('admin:locale.oneDefaultLanguageMultilingual') }}</p>
            <small>{{ $t('admin:locale.illustrativeReaderMenu') }}</small>
          </div>
          <dl class="locale-summary">
            <div>
              <dt>{{ $t('admin:locale.installedPackages') }}</dt>
              <dd>{{ installed.length }}</dd>
            </div>
            <div>
              <dt>{{ $t('admin:locale.readingLanguages') }}</dt>
              <dd>{{ readingLanguages.length }}</dd>
            </div>
            <div>
              <dt>{{ $t('admin:locale.automaticUpdates') }}</dt>
              <dd>{{ saved.catalog.offline ? $t('admin:locale.pausedOffline') : draft.autoUpdate ? $t('admin:locale.daily') : $t('admin:locale.off') }}</dd>
            </div>
          </dl>
          <div v-if="activeOperation" class="locale-running" role="status">
            <v-progress-circular indeterminate size="20" width="2" />
            <div>
              <strong>{{ stateName(activeOperation.state) }}</strong>
              <p>{{ activeOperation.kind === 'catalog' ? $t('admin:locale.languageCatalogRefresh') : $t('admin:locale.package2', { code: activeOperation.code, interpolation: { escapeValue: false } }) }}</p>
              <v-btn variant="text" size="small" @click="selectSection('activity')">{{ $t('admin:locale.viewOperation') }}</v-btn>
            </div>
          </div>
          <div class="locale-publication">
            <h3>{{ $t('admin:locale.publication') }}</h3>
            <p>
              {{ $t('admin:locale.languageSettingsTakeEffect') }}
            </p>
            <v-btn v-if="dirty" variant="outlined" :disabled="busy" @click="reset">{{ $t('admin:locale.resetDraft') }}</v-btn
            ><v-btn v-if="saved.runtime.state !== 'applied'" variant="tonal" :disabled="locked || dirty" @click="initialize"
              >{{ $t('admin:locale.retryRuntimeActivation') }}</v-btn
            >
          </div>
        </aside>
      </div>
    </template>
    <v-dialog v-model="reviewing" max-width="760" :persistent="busy" scrollable>
      <v-card class="locale-dialog"
        ><v-card-title><h2>{{ $t('admin:locale.reviewLanguageSettings') }}</h2></v-card-title
        ><v-card-text
          ><p>{{ $t('admin:locale.confirmSavedProposedSettings') }}</p>
          <div v-if="saved && reviewed" class="locale-review">
            <div v-for="field in changedFields" :key="field">
              <h3>{{ fieldName(field) }}</h3>
              <div>
                <section>
                  <small>{{ $t('admin:locale.saved') }}</small>
                  <p>{{ reviewValue(saved.policy, field) }}</p>
                </section>
                <section>
                  <small>{{ $t('admin:locale.proposed') }}</small>
                  <p>{{ reviewValue(reviewed, field) }}</p>
                </section>
              </div>
            </div>
          </div>
          <v-textarea
            v-model="reason"
            :label="$t('admin:locale.reasonChange')"
            variant="outlined"
            rows="2"
            maxlength="1000"
            counter
            :disabled="busy"
          /><v-alert v-if="saveError" type="error" variant="tonal">{{ saveError }}</v-alert></v-card-text
        ><v-card-actions
          ><v-btn v-if="stale" variant="text" :disabled="busy" @click="reload">{{ $t('admin:locale.reloadSavedSettings') }}</v-btn><v-spacer /><v-btn
            :disabled="busy"
            @click="reviewing = false"
            >{{ $t('admin:locale.backDraft') }}</v-btn
          ><v-btn color="primary" variant="flat" :disabled="locked || reason.trim().length < 3" :loading="busy" @click="confirm"
            >{{ $t('admin:locale.publishLanguages') }}</v-btn
          ></v-card-actions
        ></v-card
      >
    </v-dialog>
    <v-dialog v-model="operationOpen" max-width="600" :persistent="busy" scrollable>
      <v-card class="locale-dialog"
        ><v-card-title
          ><h2>
            {{
              operationKind === 'catalog'
                ? $t('admin:locale.refreshLanguageCatalog')
                : operationLocale?.isInstalled
                  ? $t('admin:locale.refreshInterfacePackage')
                  : $t('admin:locale.installInterfacePackage')
            }}
          </h2></v-card-title
        ><v-card-text
          ><template v-if="operationKind === 'install' && operationLocale"
            ><div class="locale-operation-subject">
              <span class="locale-code">{{ operationLocale.code }}</span>
              <div>
                <h3>{{ operationLocale.nativeName }}</h3>
                <p>{{ operationLocale.name }} · {{ operationLocale.isRTL ? $t('admin:locale.rightLeft') : $t('admin:locale.leftRight') }}</p>
              </div>
            </div>
            <p>
              {{ $t('admin:locale.serverWillFetchLatest', { source: saved?.catalog.source, interpolation: { escapeValue: false } }) }}
            </p></template
          >
          <p v-else>
            {{ $t('admin:locale.checkAvailableInterfacePackages', { source: saved?.catalog.source, interpolation: { escapeValue: false } }) }}
          </p>
          <p>{{ $t('admin:locale.progressResultRecordedActivity') }}</p>
          <v-textarea
            v-model="operationReason"
            :label="$t('admin:locale.reasonOperation')"
            variant="outlined"
            rows="2"
            maxlength="1000"
            counter
            :disabled="busy"
          /><v-alert v-if="saveError" type="error" variant="tonal">{{ saveError }}</v-alert></v-card-text
        ><v-card-actions
          ><v-btn v-if="stale" :disabled="busy" @click="reload">{{ $t('admin:locale.reloadSavedSettings') }}</v-btn><v-spacer /><v-btn
            :disabled="busy"
            @click="operationOpen = false"
            >{{ $t('common:actions.cancel') }}</v-btn
          ><v-btn
            color="primary"
            variant="flat"
            :disabled="!canOperate || operationReason.trim().length < 3"
            :loading="busy"
            @click="startOperation"
            >{{ $t('admin:locale.queueOperation') }}</v-btn
          ></v-card-actions
        ></v-card
      >
    </v-dialog>
  </v-container>
</template>
<script setup lang="ts">
import { confirmDiscard } from '../common/confirm-dialog.ts'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import AsyncState from '@/components/common/async-state.vue'
import {
  LocalePolicySchema,
  LocaleFileReviewSchema,
  MAX_LOCALE_FILE_BYTES,
  localeChangedFields,
  localeReadingPath,
  type LocaleFileReview,
  type LocalePackage,
  type LocalePolicy,
  type LocaleWorkspace,
} from '../../../shared/locale-policy.ts'
import {
  commitLocaleFile,
  fetchLocaleWorkspace,
  queueLocaleOperation,
  retryLocaleRuntime,
  reviewLocaleFile,
  saveLocaleWorkspace,
} from '../../helpers/locale-workspace-api.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const route = useRoute(),
  router = useRouter(),
  sections = [
    { key: 'languages', title: t('admin:locale.languages') },
    { key: 'routing', title: t('admin:locale.routing') },
    { key: 'library', title: t('admin:locale.packageLibrary') },
    { key: 'activity', title: t('admin:locale.activity') },
  ]
const section = computed(() => (sections.some((tab) => tab.key === route.query.section) ? String(route.query.section) : 'languages'))
const saved = ref<LocaleWorkspace | null>(null),
  draft = ref<LocalePolicy | null>(null),
  reviewed = ref<LocalePolicy | null>(null)
const loading = ref(false),
  busy = ref(false),
  stale = ref(false),
  loadError = ref(''),
  notice = ref(''),
  attention = ref(false),
  saveError = ref('')
const reviewing = ref(false),
  reason = ref(''),
  reviewFingerprint = ref(''),
  operationOpen = ref(false),
  operationReason = ref(''),
  operationKind = ref<'catalog' | 'install'>('catalog'),
  operationLocale = ref<LocalePackage | null>(null)
const localFile = ref<File | null>(null),
  localFileInput = ref<HTMLInputElement | null>(null),
  localCode = ref<string | null>(null),
  localReason = ref(''),
  localReview = ref<LocaleFileReview | null>(null),
  localUploadError = ref(''),
  openReviewChange = ref<'added' | 'changed' | 'removed' | null>(null),
  reviewChangeTypes = [
    { key: 'added', label: t('admin:locale.addedKeys') },
    { key: 'changed', label: t('admin:locale.changedKeys') },
    { key: 'removed', label: t('admin:locale.removedKeys') },
  ] as const
const search = ref(''),
  packageFilter = ref('all'),
  packageFilters = [
    { title: t('admin:locale.allPackages'), value: 'all' },
    { title: t('admin:locale.installed'), value: 'installed' },
    { title: t('admin:locale.notInstalled'), value: 'available' },
    { title: t('admin:locale.updatesAvailable'), value: 'updates' },
  ]
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const normalizedDraft = computed(() => (draft.value ? LocalePolicySchema.safeParse(draft.value) : null))
const dirty = computed(() =>
  Boolean(
    saved.value &&
    draft.value &&
    localeChangedFields(saved.value.policy, normalizedDraft.value?.success ? normalizedDraft.value.data : draft.value).length,
  ),
)
const locked = computed(() => loading.value || busy.value || stale.value)
const installed = computed(() =>
  (saved.value?.locales || [])
    .filter((locale) => locale.isInstalled)
    .map((locale) => ({ ...locale, displayName: `${locale.nativeName} (${locale.code})` })),
)
const readingLanguages = computed(() =>
  installed.value.filter(
    (locale) => locale.code === draft.value?.locale || (draft.value?.namespacing && draft.value.namespaces.includes(locale.code)),
  ),
)
const activeOperation = computed(() => saved.value?.operations.find((operation) => ['pending', 'running'].includes(operation.state)))
const canOperate = computed(() =>
  Boolean(saved.value && !locked.value && !dirty.value && !activeOperation.value && !saved.value.catalog.offline),
)
const uploadLocales = computed(() =>
  (saved.value?.locales || [])
    .filter((locale) => locale.code !== 'en')
    .map((locale) => ({
      code: locale.code,
      displayName: `${locale.nativeName} (${locale.code}) · ${locale.isInstalled ? t('admin:locale.installed') : t('admin:locale.languageCatalog')}`,
    })),
)
const canUploadLocalFile = computed(() =>
  Boolean(saved.value && !locked.value && !dirty.value && !activeOperation.value),
)
const canReviewLocalFile = computed(() =>
  Boolean(
    canUploadLocalFile.value &&
    localFile.value &&
    localFile.value.size <= MAX_LOCALE_FILE_BYTES &&
    localCode.value &&
    localReason.value.trim().length >= 3,
  ),
)
const canCommitLocalFile = computed(() =>
  Boolean(
    saved.value &&
    !locked.value &&
    !dirty.value &&
    !activeOperation.value &&
    localReview.value &&
    Date.parse(localReview.value.expiresAt) > Date.now(),
  ),
)
const hasLocalDraft = computed(() =>
  Boolean(localFile.value || localCode.value || localReason.value.trim() || localReview.value),
)
const updateAvailable = (locale: LocalePackage) =>
  locale.isInstalled && locale.updatedAt && locale.installDate && Date.parse(locale.updatedAt) > Date.parse(locale.installDate)
const filteredPackages = computed(() =>
  (saved.value?.locales || []).filter(
    (locale) =>
      `${locale.name} ${locale.nativeName} ${locale.code}`.toLocaleLowerCase().includes((search.value || '').trim().toLocaleLowerCase()) &&
      (packageFilter.value === 'all' ||
        (packageFilter.value === 'installed' && locale.isInstalled) ||
        (packageFilter.value === 'available' && !locale.isInstalled) ||
        (packageFilter.value === 'updates' && updateAvailable(locale))),
  ),
)
const changedFields = computed(() => (saved.value && reviewed.value ? localeChangedFields(saved.value.policy, reviewed.value) : []))
const languageName = (code: string) => saved.value?.locales.find((locale) => locale.code === code)?.nativeName || code
const enabled = (code: string) => code === draft.value?.locale || Boolean(draft.value?.namespacing && draft.value.namespaces.includes(code))
function toggleLanguage(code: string, checked: boolean) {
  if (locked.value || !draft.value || code === draft.value.locale) return
  draft.value.namespaces = checked
    ? [...new Set([...draft.value.namespaces, code])]
    : draft.value.namespaces.filter((value) => value !== code)
}
function selectSection(key: string) {
  void router.replace({ query: { ...route.query, section: key } })
}
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : t('admin:locale.requestCouldNotCompleted'))
let sequence = 0,
  disposed = false,
  poll: ReturnType<typeof setTimeout> | undefined
function schedulePoll() {
  clearTimeout(poll)
  if (!disposed && activeOperation.value)
    poll = setTimeout(() => {
      void load(true)
    }, 3000)
}
async function load(background = false) {
  if (busy.value) return
  const seq = ++sequence
  if (!background) loading.value = true
  try {
    const result = await fetchLocaleWorkspace()
    if (disposed || seq !== sequence) return
    const staged = result.localFileReview ? LocaleFileReviewSchema.safeParse(result.localFileReview) : null,
      stagedReview = staged?.success ? staged.data : null
    if (background && (dirty.value || reviewing.value || operationOpen.value || hasLocalDraft.value) && saved.value) {
      if (
        result.fingerprint !== saved.value.fingerprint ||
        (localReview.value !== null && stagedReview?.id !== localReview.value.id)
      )
        stale.value = true
      saved.value = { ...result, policy: saved.value.policy, fingerprint: saved.value.fingerprint }
    } else {
      saved.value = result
      draft.value = copy(result.policy)
      localReview.value = stagedReview
      localCode.value = stagedReview?.code ?? null
      localReason.value = stagedReview?.reason ?? ''
      stale.value = false
    }
    loadError.value = ''
  } catch (error) {
    if (!disposed && seq === sequence) loadError.value = errorMessage(error)
  } finally {
    if (!disposed && seq === sequence) {
      loading.value = false
      schedulePoll()
    }
  }
}
async function reload() {
  if (busy.value) return
  if (
    (dirty.value || hasLocalDraft.value) &&
    !(await confirmDiscard(t('admin:locale.discardDraftReload'), t('admin:locale.unexpiredServerReviewedFile')))
  )
    return
  if (busy.value) return
  reviewing.value = false
  operationOpen.value = false
  localFile.value = null
  localReview.value = null
  localCode.value = null
  localReason.value = ''
  if (localFileInput.value) localFileInput.value.value = ''
  await load()
}
function reset() {
  if (busy.value || !saved.value) return
  draft.value = copy(saved.value.policy)
  saveError.value = ''
  notice.value = ''
}
function review() {
  if (locked.value || !dirty.value || !saved.value || !draft.value) return
  const result = LocalePolicySchema.safeParse(draft.value)
  if (!result.success) {
    notice.value = result.error.issues.map((issue) => issue.message).join(' ')
    attention.value = true
    return
  }
  reviewed.value = copy(result.data)
  reviewFingerprint.value = saved.value.fingerprint
  reason.value = ''
  saveError.value = ''
  reviewing.value = true
}
function writeFailure(error: unknown) {
  const status = error && typeof error === 'object' ? Number(Reflect.get(error, 'status')) : 0
  stale.value = !status || status >= 500 || [401, 403, 409].includes(status)
  saveError.value = errorMessage(error) + (stale.value ? ` ${t('admin:locale.reloadSavedSettingsBefore')}` : '')
}
async function confirm() {
  if (locked.value || !saved.value || !reviewed.value || reason.value.trim().length < 3) return
  busy.value = true
  saveError.value = ''
  try {
    const result = await saveLocaleWorkspace(copy(reviewed.value), reviewFingerprint.value, reason.value.trim())
    if (disposed) return
    saved.value = { ...saved.value, policy: copy(reviewed.value), runtime: { ...saved.value.runtime, state: 'needs-attention' } }
    draft.value = copy(reviewed.value)
    reviewing.value = false
    reviewed.value = null
    attention.value = result.activation !== 'applied'
    notice.value = attention.value
      ? t('admin:locale.languagesSavedRuntimeActivation')
      : t('admin:locale.languagesPublishedReadersSee')
    stale.value = true
    busy.value = false
    await load()
  } catch (error) {
    if (!disposed) writeFailure(error)
  } finally {
    if (!disposed) busy.value = false
  }
}
function openOperation(kind: 'install' | 'catalog', locale?: LocalePackage) {
  if (!canOperate.value || !saved.value) return
  operationKind.value = kind
  operationLocale.value = locale || null
  operationReason.value = ''
  reviewFingerprint.value = saved.value.fingerprint
  saveError.value = ''
  operationOpen.value = true
}
async function startOperation() {
  if (!canOperate.value || operationReason.value.trim().length < 3) return
  busy.value = true
  saveError.value = ''
  try {
    await queueLocaleOperation(operationKind.value, operationLocale.value?.code, reviewFingerprint.value, operationReason.value.trim())
    if (disposed) return
    operationOpen.value = false
    notice.value = t('admin:locale.languageOperationQueuedFollow')
    attention.value = false
    stale.value = true
    busy.value = false
    selectSection('activity')
    await load()
  } catch (error) {
    if (!disposed) writeFailure(error)
  } finally {
    if (!disposed) busy.value = false
  }
}
function clearLocalReview() {
  localReview.value = null
  openReviewChange.value = null
}
function selectLocalFile(event: Event) {
  const input = event.currentTarget
  if (!(input instanceof HTMLInputElement)) return
  const file = input.files?.[0] ?? null
  clearLocalReview()
  localUploadError.value = ''
  localFile.value = file
  if (file && file.size > MAX_LOCALE_FILE_BYTES) {
    localUploadError.value = t('admin:locale.selectedLanguageFileExceeds')
    localFile.value = null
    input.value = ''
  }
}
function toggleReviewChanges(kind: 'added' | 'changed' | 'removed', event: Event) {
  const details = event.currentTarget
  if (details instanceof HTMLDetailsElement) openReviewChange.value = details.open ? kind : null
}
const byteSize = (size: number) =>
  size < 1024 ? t('admin:locale.bytes', { size, interpolation: { escapeValue: false } }) : size < 1024 * 1024 ? t('admin:locale.kib', { value: (size / 1024).toFixed(1), interpolation: { escapeValue: false } }) : t('admin:locale.mib', { value: (size / 1024 / 1024).toFixed(2), interpolation: { escapeValue: false } })
function localWriteFailure(error: unknown) {
  const status = error && typeof error === 'object' ? Number(Reflect.get(error, 'status')) : 0
  localUploadError.value = errorMessage(error)
  if (!status || status >= 500 || [401, 403, 409].includes(status)) stale.value = true
}
async function reviewLocalUpload() {
  if (!canReviewLocalFile.value || !saved.value || !localFile.value || !localCode.value) return
  busy.value = true
  localUploadError.value = ''
  try {
    const result = await reviewLocaleFile(localFile.value, localCode.value, saved.value.fingerprint, localReason.value.trim())
    if (disposed) return
    localReview.value = LocaleFileReviewSchema.parse(result)
    localCode.value = localReview.value.code
    localReason.value = localReview.value.reason
    openReviewChange.value = null
  } catch (error) {
    if (!disposed) localWriteFailure(error)
  } finally {
    if (!disposed) busy.value = false
  }
}
async function commitLocalUpload() {
  if (!canCommitLocalFile.value || !localReview.value) return
  busy.value = true
  localUploadError.value = ''
  try {
    await commitLocaleFile(localReview.value.id)
    if (disposed) return
    localFile.value = null
    localReview.value = null
    localCode.value = null
    localReason.value = ''
    if (localFileInput.value) localFileInput.value.value = ''
    notice.value = t('admin:locale.reviewedLocalLanguageFile')
    attention.value = false
    stale.value = true
    busy.value = false
    selectSection('activity')
    await load()
  } catch (error) {
    if (!disposed) localWriteFailure(error)
  } finally {
    if (!disposed) busy.value = false
  }
}
async function initialize() {
  if (locked.value || dirty.value || !saved.value) return
  busy.value = true
  try {
    const result = await retryLocaleRuntime(saved.value.fingerprint)
    if (disposed) return
    attention.value = result.activation !== 'applied'
    notice.value = attention.value
      ? t('admin:locale.runtimeActivationNeedsAttention')
      : t('admin:locale.runtimeLanguageResourcesApplied')
    busy.value = false
    await load()
  } catch (error) {
    notice.value = errorMessage(error)
    attention.value = true
  } finally {
    busy.value = false
  }
}
const fieldName = (field: string) =>
  ({
    locale: t('admin:locale.defaultLanguage'),
    namespacing: t('admin:locale.multilingualRouting'),
    namespaces: t('admin:locale.readingLanguages'),
    autoUpdate: t('admin:locale.automaticInterfaceUpdates'),
    catalog: t('admin:locale.languageCatalog'),
  })[field] || field.replace('package:', 'Package: ')
const reviewValue = (policy: LocalePolicy, field: string) =>
  field === 'locale'
    ? `${languageName(policy.locale)} (${policy.locale})`
    : field === 'namespaces'
      ? policy.namespaces.map(languageName).join(', ') || t('admin:locale.noAdditionalLanguages')
      : field === 'namespacing'
        ? policy.namespacing
          ? t('admin:locale.enabledLanguagePrefixedAddresses')
          : t('admin:locale.offOneDefaultLanguage')
        : policy.autoUpdate
          ? t('admin:locale.dailyUpdates')
          : t('admin:locale.manualUpdates')
const date = (value: string) =>
  Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
    : t('admin:locale.dateUnavailable')
const stateName = (state: string) =>
  ({ pending: t('admin:locale.queued'), running: t('admin:locale.running'), succeeded: t('admin:locale.completed'), failed: t('admin:locale.failed'), cancelled: t('admin:locale.cancelled') })[state] || state
const operationIcon = (state: string) =>
  ({
    pending: 'mdi-clock-outline',
    running: 'mdi-progress-clock',
    succeeded: 'mdi-check-circle-outline',
    failed: 'mdi-alert-circle-outline',
    cancelled: 'mdi-cancel',
  })[state] || 'mdi-circle-outline'
const preventUnload = (event: BeforeUnloadEvent) => {
  if (dirty.value || busy.value || hasLocalDraft.value) event.preventDefault()
}
onBeforeRouteLeave(async () =>
  !(dirty.value || busy.value || hasLocalDraft.value) ||
  (!busy.value && (await confirmDiscard(t('admin:locale.discardUnsavedLanguageChanges'))))
)
onMounted(() => {
  window.addEventListener('beforeunload', preventUnload)
  void load()
})
onBeforeUnmount(() => {
  disposed = true
  sequence++
  clearTimeout(poll)
  window.removeEventListener('beforeunload', preventUnload)
})
</script>
<style src="./locale-workspace.scss" lang="scss"></style>
<style scoped lang="scss">
.locale-local-import {
  margin-block: 24px 30px;
  padding: 22px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.14);
  border-radius: 16px;
  background: rgba(var(--v-theme-surface), 0.62);
}

.locale-local-import__heading,
.locale-local-import__identity {
  display: flex;
  align-items: flex-start;
  gap: 15px;
}

.locale-local-import__heading {
  margin-bottom: 20px;

  h3 {
    margin: 5px 0 3px;
  }

  p,
  small {
    margin: 0;
    color: var(--wiki-text-muted);
  }
}

.locale-local-import__form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;

  > :last-child {
    grid-column: 1 / -1;
  }
}

.locale-local-import__file {
  display: grid;
  grid-column: 1 / -1;
  gap: 8px;
  padding: 14px 16px;
  border: 1px dashed rgba(var(--v-theme-on-surface), 0.3);
  border-radius: 10px;

  span {
    font-weight: 600;
  }

  small {
    color: var(--wiki-text-muted);
  }
}

.locale-local-import__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 14px;
}

.locale-local-import__review {
  margin-top: 20px;
  padding-top: 18px;
  border-top: 1px solid rgba(var(--v-theme-on-surface), 0.14);

  h4,
  p {
    margin: 0 0 5px;
  }

  p,
  small {
    color: var(--wiki-text-muted);
  }

  code {
    overflow-wrap: anywhere;
  }
}

.locale-local-import__identity {
  align-items: center;
}

.locale-local-import__counts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-block: 16px 12px;

  span {
    padding: 6px 10px;
    border: 1px solid rgba(var(--v-theme-on-surface), 0.13);
    border-radius: 999px;
    color: var(--wiki-text-muted);
  }
}

.locale-local-import__change-list {
  border-top: 1px solid rgba(var(--v-theme-on-surface), 0.12);

  summary {
    padding: 11px 2px;
    cursor: pointer;
    font-weight: 600;
  }

  ul {
    max-height: 230px;
    margin: 0 0 14px;
    padding-inline-start: 22px;
    overflow: auto;
  }

  li {
    margin-block: 3px;
    overflow-wrap: anywhere;
  }
}

@media (max-width: 600px) {
  .locale-local-import {
    padding: 17px;
  }

  .locale-local-import__form {
    grid-template-columns: minmax(0, 1fr);

    > :last-child {
      grid-column: auto;
    }
  }
}
</style>
