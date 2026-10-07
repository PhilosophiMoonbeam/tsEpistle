<template>
  <v-container
    fluid
    class="storage-workspace"
    :inert="reviewOpen"
  >
    <admin-hero
      :title="$t('admin:storage.title')"
      :description="$t('admin:storage.keepKnowledgePortableMake')"
      icon="mdi-database-outline"
    >
      <template #actions>
        <v-btn
          variant="text"
          prepend-icon="mdi-refresh"
          :disabled="busy || loading"
          @click="reload"
        >{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ $t('admin:storage.reloadSavedStorageSettings') }}</v-tooltip></v-btn>
        <v-btn
          v-if="dirty"
          variant="text"
          :disabled="locked"
          @click="reset"
        >{{ $t('admin:storage.resetDraft') }}</v-btn>
        <v-btn
          color="primary"
          :disabled="locked || !dirty"
          @click="reviewSave"
        >{{ $t('admin:storage.reviewChanges') }}</v-btn>
      </template>
    </admin-hero>
    <async-state
      v-if="loading && !saved"
      state="loading"
      :title="$t('admin:storage.loadingStorage')"
      :message="$t('admin:storage.readingSavedTargetsActive')"
    />
    <async-state
      v-else-if="error && !saved"
      state="error"
      :title="$t('admin:storage.storageCouldNotLoaded2')"
      :message="error"
      :retry-label="$t('admin:storage.tryAgain')"
      @retry="load(true)"
    />
    <v-alert
      v-else-if="error"
      variant="tonal"
      type="warning"
      class="mb-5"
    >{{ error }}</v-alert>
    <v-alert
      v-if="stale"
      variant="tonal"
      type="warning"
      class="mb-5"
    >{{ $t('admin:storage.reloadBeforeAnotherChange') }}</v-alert>
    <v-alert
      v-if="notice"
      variant="tonal"
      type="success"
      class="mb-5"
      role="status"
    >{{ notice }}</v-alert>
    <template v-if="saved">
      <div class="storage-status"><span><i
            :class="{attention:dirty || stale}" />{{ stale ? $t('admin:storage.reloadRequired') : dirty ? $t('admin:storage.unsavedTargetConfiguration') : $t('admin:storage.savedConfigurationObservedRuntime') }}</span><time
          :datetime="saved.observedAt"
        >{{ $t('admin:storage.observed', { observedAt: dateTime(saved.observedAt), interpolation: { escapeValue: false } }) }}</time></div>
      <nav
        class="storage-tabs"
        :aria-label="$t('admin:storage.storageSections')"
      ><button
          v-for="tab in sections"
          :key="tab.key"
          type="button"
          :aria-current="section === tab.key ? 'page' : undefined"
          @click="selectSection(tab.key)"
        >{{ tab.title }}</button></nav>
      <v-alert
        v-if="saved.offline"
        type="info"
        variant="tonal"
        class="mb-6"
      >{{ saved.gitSyncAllowedWhileOffline
          ? $t('admin:storage.offlineModePausesOther')
          : $t('admin:storage.offlineModePausesNew') }}</v-alert>
      <div
        v-if="activeOperation"
        class="storage-running"
        role="status"
      >
        <v-icon :icon="activeOperation.state === 'interrupted' ? 'mdi-alert-circle-outline' : 'mdi-timer-sand'" />
        <div><strong>{{ operationLabel(activeOperation.state) }} · {{ activeOperation.title }}</strong>
          <p>
            {{ activeOperation.state === 'interrupted' ? $t('admin:storage.outcomeNeedsReviewBefore') : $t('admin:storage.settingsAdditionalOperationsLocked') }}
          </p>
        </div>
        <v-btn
          variant="outlined"
          @click="selectOperation(activeOperation.id)"
        >{{ $t('admin:storage.viewOperation') }}</v-btn>
      </div>
      <template v-if="section === 'overview'">
        <div class="storage-overview">
          <section>
            <div class="storage-heading"><span class="storage-kicker">{{ $t('admin:storage.n01CopiesPurpose') }}</span>
              <h2>{{ $t('admin:storage.knowledge') }}<br />{{ $t('admin:storage.beyondDatabase') }}</h2>
              <p>{{ $t('admin:storage.chooseWhereSharedPages') }}</p>
            </div>
            <div class="storage-metrics">
              <div><span>{{ $t('admin:storage.usingSavedSettings') }}</span><strong>{{ currentTargets.length }}<small> / {{ enabledTargets.length }}</small></strong>
                <p>{{ $t('admin:storage.initializedAvailableNewWork') }}</p>
              </div>
              <div><span>{{ $t('admin:storage.awaitingApplication') }}</span><strong>{{ pendingTargets.length }}</strong>
                <p>{{ $t('admin:storage.savedConfigurationDiffersRuntime') }}</p>
              </div>
            </div>
            <div class="storage-section-head">
              <h3>{{ $t('admin:storage.configuredDestinations') }}</h3><v-btn
                variant="text"
                append-icon="mdi-arrow-right"
                @click="selectSection('targets')"
              >{{ $t('admin:storage.allTargets') }}</v-btn>
            </div>
            <div
              v-if="!enabledTargets.length"
              class="storage-empty"
            ><v-icon
                size="36"
                icon="mdi-folder-plus-outline"
              />
              <h3>{{ $t('admin:storage.chooseFirstDestination') }}</h3>
              <p>{{ $t('admin:storage.startLocalExportConnect') }}</p><v-btn
                variant="outlined"
                @click="selectSection('targets')"
              >{{ $t('admin:storage.browseTargets') }}</v-btn>
            </div>
            <button
              v-for="target in enabledTargets"
              :key="target.key"
              type="button"
              class="storage-destination"
              @click="selectTarget(target.key)"
            ><v-icon :icon="targetIcon(target.key)" /><span><strong>{{ target.title }}</strong><small>{{ modeLabel(target.mode) }} ·
                  {{ intervalLabel(target) }}</small></span><span
                class="storage-badge"
                :data-state="observation(target.key)?.state"
              >{{ runtimeLabel(target.key) }}</span><v-icon
                icon="mdi-arrow-top-right"
                size="18"
              /></button>
          </section>
          <aside class="storage-aside">
            <span class="storage-kicker">{{ $t('admin:storage.configurationRuntime') }}</span>
            <h3>{{ $t('admin:storage.savedOneStep') }}<br />{{ $t('admin:storage.runningNext') }}</h3>
            <p>{{ $t('admin:storage.reviewChangesChooseSave') }}</p>
            <p>{{ $t('admin:storage.initializationCanConnectServices') }}</p><v-btn
              block
              variant="outlined"
              :disabled="actionLocked || (!enabledTargets.length && !pendingTargets.length)"
              @click="reviewActivation"
            >{{ $t('admin:storage.applySavedSettings') }}</v-btn>
            <div class="storage-aside-rule" /><span class="storage-kicker">{{ $t('admin:storage.recoveryCoverage') }}</span>
            <h3>{{ $t('admin:storage.contentCopyHasBoundaries') }}</h3>
            <p>{{ $t('admin:storage.storageExportsUsefulPortability') }}</p><v-btn
              variant="text"
              append-icon="mdi-arrow-right"
              @click="selectSection('recovery')"
            >{{ $t('admin:storage.buildRecoveryPlan') }}</v-btn>
            <div class="storage-aside-rule" />
            <p class="storage-note">{{ $t('admin:storage.observationsRefreshEvery10') }}</p>
          </aside>
        </div>
      </template>
      <template v-else-if="section === 'targets'">
        <div class="storage-heading"><span class="storage-kicker">{{ $t('admin:storage.n02DestinationCatalog') }}</span>
          <h2>{{ $t('admin:storage.homeEachCopy') }}</h2>
          <p>{{ $t('admin:storage.configureDestinationAccessDirection') }}</p>
        </div>
        <div class="storage-target-layout">
          <aside class="storage-catalog">
            <v-select
              class="storage-mobile-target"
              :model-value="selectedTarget?.key"
              :items="saved.targets.map(target => ({value:target.key,title:target.title + (target.isAvailable ? '' : ` ${$t('admin:storage.unavailable')}`)}))"
              :label="$t('admin:storage.storageTarget')"
              variant="outlined"
              hide-details
              @update:model-value="selectTarget"
            />
            <v-text-field
              v-model="targetSearch"
              :label="$t('admin:storage.findTarget')"
              prepend-inner-icon="mdi-magnify"
              variant="outlined"
              density="compact"
              clearable
              hide-details
            />
            <nav :aria-label="$t('admin:storage.storageTargets')"><button
                v-for="target in filteredTargets"
                :key="target.key"
                type="button"
                :aria-current="selectedTarget?.key === target.key ? 'page' : undefined"
                @click="selectTarget(target.key)"
              ><v-icon
                  :icon="targetIcon(target.key)" /><span><strong>{{ target.title }}</strong><small>{{ target.isAvailable ? draftFor(target.key)?.isEnabled ? $t('admin:storage.enabledDraft') : $t('admin:storage.disabledDraft') : $t('admin:storage.unavailableBuild') }}</small></span><i
                  v-if="targetChanged(target.key)"
                  :aria-label="$t('admin:storage.unsavedChanges')"
                /></button></nav>
            <p
              v-if="!filteredTargets.length"
              class="storage-note"
            >{{ $t('admin:storage.noTargetsMatchSearch') }}</p>
            <p class="storage-note">{{ $t('admin:storage.allInstalledTargetsShown', { targetsCount: saved.targets.length, interpolation: { escapeValue: false } }) }}</p>
          </aside>
          <section
            v-if="selectedTarget && selectedDraft"
            class="storage-target-detail"
            :aria-label="$t('admin:storage.configuration', { title: selectedTarget.title, interpolation: { escapeValue: false } })"
          >
            <div class="storage-target-head">
              <div><span class="storage-kicker">{{ targetKind(selectedTarget.key) }}</span>
                <h3>{{ selectedTarget.title }}</h3>
                <p>{{ selectedTarget.description }}</p>
              </div><span
                class="storage-badge"
                :data-state="observation(selectedTarget.key)?.state"
              >{{ runtimeLabel(selectedTarget.key) }}</span>
            </div>
            <div class="storage-enable">
              <div>
                <h4>{{ $t('admin:storage.includeTarget') }}</h4>
                <p>{{ $t('admin:storage.draftBecomesActiveAfter') }}</p>
              </div><v-switch
                :model-value="selectedDraft.isEnabled"
                :label="selectedDraft.isEnabled ? $t('admin:storage.enabled') : $t('admin:storage.disabled')"
                :aria-label="$t('admin:storage.enable', { title: selectedTarget.title, interpolation: { escapeValue: false } })"
                color="primary"
                hide-details
                :disabled="locked || (!selectedTarget.isAvailable && !selectedDraft.isEnabled)"
                @update:model-value="selectedDraft.isEnabled = Boolean($event)"
              />
            </div>
            <details
              class="storage-runtime-evidence"
              :open="['error','warning'].includes(observation(selectedTarget.key)?.lastOutcome || '')"
            >
              <summary>{{ $t('admin:storage.runtimeEvidence') }}</summary>
              <dl class="storage-facts">
                <dt>{{ $t('admin:storage.usingSavedConfiguration') }}</dt>
                <dd>{{ observation(selectedTarget.key)?.matchesSaved ? $t('admin:storage.yes') : $t('admin:storage.applyRequired') }}</dd>
                <dt>{{ $t('admin:storage.lastRecordedAttempt') }}</dt>
                <dd>{{ dateTime(observation(selectedTarget.key)?.lastAttempt) }}</dd>
                <dt>{{ $t('admin:storage.lastRecordedResult') }}</dt>
                <dd>{{ lastOutcomeLabel(observation(selectedTarget.key)?.lastOutcome) }}</dd>
              </dl>
              <p class="storage-note">{{ $t('admin:storage.attemptCanInitializationContent') }}</p>
              <p
                v-if="['error','warning'].includes(observation(selectedTarget.key)?.lastOutcome || '')"
                class="storage-note"
              >{{ $t('admin:storage.targetReportedIssueReview') }}</p>
            </details>
            <v-alert
              v-if="!selectedTarget.isAvailable"
              variant="tonal"
              type="warning"
              class="mb-5"
            >{{ $t('admin:storage.moduleCannotRunCurrent') }}</v-alert>
            <div class="storage-fields storage-direction">
              <v-select
                v-model="selectedDraft.mode"
                :items="selectedTarget.modes.map(value => ({value,title:modeLabel(value)}))"
                :label="$t('admin:storage.contentDirection')"
                variant="outlined"
                :disabled="locked || !selectedTarget.isAvailable"
                persistent-hint
                :hint="$t('admin:storage.explicitActionsDescribeTheir')"
              />
              <div v-if="selectedTarget.schedule"><v-select
                  :model-value="scheduleMode"
                  :items="intervals"
                  :label="$t('admin:storage.scheduledSynchronization')"
                  variant="outlined"
                  :disabled="locked"
                  @update:model-value="setSchedule"
                /><v-text-field
                  v-credential-autofill
                  v-if="scheduleMode === 'custom'"
                  v-model="selectedDraft.syncInterval"
                  :label="$t('admin:storage.customIntervalIso8601')"
                  autocomplete="off"
                  variant="outlined"
                  :hint="$t('admin:storage.examplesPt30mPt2h10')"
                  persistent-hint
                  :disabled="locked"
                /></div>
              <div
                v-else
                class="storage-field-note"
              ><strong>{{ selectedTarget.key === 'disk' ? $t('admin:storage.archivesFollowTheirOwn') : $t('admin:storage.updatesFollowContentEvents') }}</strong>
                <p>
                  {{ selectedTarget.key === 'disk' ? $t('admin:storage.dailyFolderArchivesCan') : $t('admin:storage.targetHasNoConfigurable') }}
                </p>
              </div>
            </div>
            <section
              v-for="group in fieldGroups"
              :key="group.title"
              class="storage-field-section"
            >
              <div class="storage-section-head">
                <h4>{{ group.title }}</h4><span>{{ group.hint }}</span>
              </div>
              <div class="storage-fields">
                <template
                  v-for="field in group.fields"
                  :key="field.key"
                >
                  <div
                    v-if="field.sensitive"
                    class="storage-secret"
                    :class="{'storage-full':field.multiline}"
                  ><label>{{ field.title }}</label>
                    <p>{{ selectedTarget.secrets[field.key] ? $t('admin:storage.valueSavedNeverReturned') : $t('admin:storage.noValueCurrentlySaved') }}
                    </p><v-select
                      :model-value="selectedDraft.secrets[field.key]?.action"
                      :items="secretActions"
                      :label="$t('admin:storage.action', { title: field.title, interpolation: { escapeValue: false } })"
                      variant="outlined"
                      density="compact"
                      hide-details
                      :disabled="locked"
                      @update:model-value="setSecretAction(field.key,$event)"
                    /><v-textarea
                      v-credential-autofill
                      v-if="field.multiline && selectedDraft.secrets[field.key]?.action === 'replace'"
                      :model-value="secretValue(field.key)"
                      :label="$t('admin:storage.new', { title: field.title, interpolation: { escapeValue: false } })"
                      variant="outlined"
                      rows="4"
                      class="mt-4"
                      autocomplete="off"
                      :disabled="locked"
                      @update:model-value="setSecretValue(field.key,$event)"
                    /><v-text-field
                      v-credential-autofill
                      v-else-if="selectedDraft.secrets[field.key]?.action === 'replace'"
                      :model-value="secretValue(field.key)"
                      :label="$t('admin:storage.new', { title: field.title, interpolation: { escapeValue: false } })"
                      type="password"
                      autocomplete="new-password"
                      variant="outlined"
                      class="mt-4"
                      :disabled="locked"
                      @update:model-value="setSecretValue(field.key,$event)"
                    />
                    <p class="storage-note">{{ field.hint }}</p>
                  </div>
                  <v-select
                    v-else-if="field.options.length"
                    :model-value="selectedDraft.config[field.key]"
                    :items="field.options"
                    :label="field.title"
                    :hint="field.hint"
                    persistent-hint
                    variant="outlined"
                    :disabled="locked || !selectedTarget.isAvailable"
                    @update:model-value="setField(field.key,$event)"
                  />
                  <div
                    v-else-if="field.type === 'boolean'"
                    class="storage-toggle"
                  ><v-switch
                      :model-value="Boolean(selectedDraft.config[field.key])"
                      :label="field.title"
                      color="primary"
                      hide-details
                      :disabled="locked || !selectedTarget.isAvailable"
                      @update:model-value="setField(field.key,Boolean($event))"
                    />
                    <p>{{ field.hint }}</p>
                  </div>
                  <v-textarea
                    v-credential-autofill
                    v-else-if="field.multiline"
                    :model-value="String(selectedDraft.config[field.key] ?? '')"
                    :label="field.title"
                    :hint="field.hint"
                    persistent-hint
                    variant="outlined"
                    rows="3"
                    class="storage-full"
                    autocomplete="off"
                    :disabled="locked || !selectedTarget.isAvailable"
                    @update:model-value="setField(field.key,$event)"
                  />
                  <v-text-field
                    v-credential-autofill
                    v-else
                    :model-value="selectedDraft.config[field.key]"
                    :label="field.title"
                    :type="field.type === 'number' ? 'number' : 'text'"
                    :hint="field.hint"
                    persistent-hint
                    variant="outlined"
                    :disabled="locked || !selectedTarget.isAvailable"
                    autocomplete="off"
                    @update:model-value="setField(field.key,field.type === 'number' ? Number($event) : $event)"
                  />
                </template>
              </div>
            </section>
            <v-alert
              v-if="selectedIssues.length"
              :type="selectedDraft.isEnabled ? 'warning' : 'info'"
              variant="tonal"
              class="mb-6"
            ><strong>{{ selectedDraft.isEnabled ? $t('admin:storage.beforeTargetCanRun') : $t('admin:storage.beforeEnablingTarget') }}</strong>
              <ul>
                <li
                  v-for="issue in selectedIssues"
                  :key="issue"
                >{{ issue }}</li>
              </ul>
            </v-alert>
            <section class="storage-field-section">
              <div class="storage-section-head">
                <h4>{{ $t('admin:storage.targetOperations') }}</h4><span>{{ $t('admin:storage.useSavedActiveConfiguration') }}</span>
              </div>
              <p
                v-if="dirty || !observation(selectedTarget.key)?.matchesSaved || !observation(selectedTarget.key)?.active"
                class="storage-note"
              >{{ $t('admin:storage.saveApplyTargetSuccessfully') }}</p>
              <div class="storage-action-list">
                <article
                  v-for="action in selectedTarget.actions"
                  :key="action.handler"
                >
                  <div>
                    <h4>{{ action.title }}</h4>
                    <p>{{ action.effect }}</p>
                  </div><v-btn
                    variant="outlined"
                    :disabled="!canRun(selectedTarget.key)"
                    @click="reviewAction(selectedTarget,action)"
                  >{{ $t('admin:storage.reviewAction') }}</v-btn>
                </article>
              </div>
            </section>
          </section>
          <div
            v-else
            class="storage-empty"
          >
            <h3>{{ $t('admin:storage.noStorageModulesInstalled') }}</h3>
            <p>{{ $t('admin:storage.checkApplicationBuildRefresh') }}</p>
          </div>
        </div>
      </template>
      <template v-else-if="section === 'operations'">
        <div class="storage-heading"><span class="storage-kicker">{{ $t('admin:storage.n03RecordWork') }}</span>
          <h2>{{ $t('admin:storage.everyOperationLeavesReceipt') }}</h2>
          <p>{{ $t('admin:storage.followQueuedWorkInspect') }}</p>
        </div>
        <div class="storage-section-head"><v-text-field
            v-model="operationSearch"
            :label="$t('admin:storage.findOperation')"
            prepend-inner-icon="mdi-magnify"
            variant="outlined"
            density="compact"
            hide-details
            clearable
          /><v-select
            v-model="operationFilter"
            :items="operationFilters"
            :label="$t('admin:storage.outcome')"
            variant="outlined"
            density="compact"
            hide-details
          /></div>
        <div
          v-if="!filteredOperations.length"
          class="storage-empty"
        ><v-icon
            size="36"
            icon="mdi-clipboard-text-clock-outline"
          />
          <h3>{{ saved.operations.length ? $t('admin:storage.noMatchingOperations') : $t('admin:storage.noReviewedOperationsYet') }}</h3>
          <p>{{ $t('admin:storage.applyingSettingsRunningTarget') }}</p>
        </div>
        <div
          v-else
          class="storage-operation-layout"
        >
          <nav
            :aria-label="$t('admin:storage.storageOperationHistory')"
            class="storage-operation-list"
          ><button
              v-for="operation in filteredOperations"
              :key="operation.id"
              type="button"
              :aria-current="selectedOperation?.id === operation.id ? 'page' : undefined"
              @click="selectOperation(operation.id)"
            ><span
                class="storage-badge"
                :data-state="operation.state"
              >{{ operationLabel(operation.state) }}</span><strong>{{ operation.title }}</strong><small>{{ operation.targetKey ? targetTitle(operation.targetKey) : $t('admin:storage.allConfiguredTargets') }}
                · {{ dateTime(operation.createdAt) }}</small></button></nav>
          <storage-operation-receipt
            v-if="selectedOperation"
            :operation="selectedOperation"
            :target-titles="targetTitles"
            :locked="baseLocked || dirty"
            @download="downloadReceipt"
            @decision="reviewDecision($event.operation,$event.kind)"
          />
        </div>
        <p class="storage-note mt-5">{{ $t('admin:storage.showingUp50Recent') }}</p>
        <details class="storage-configuration-history">
          <summary>{{ $t('admin:storage.configurationPublicationHistoryRecent', { historyCount: saved.history.length, interpolation: { escapeValue: false } }) }}</summary>
          <article
            v-for="event in saved.history"
            :key="event.id"
          ><strong>{{ event.reason }}</strong>
            <p>{{ actor(event.actorId) }} · {{ dateTime(event.createdAt) }}</p>
            <ul>
              <li
                v-for="target in event.targets"
                :key="target.key"
              >{{ targetTitle(target.key) }}: {{ target.fields.map(changedFieldLabel).join(', ') }}</li>
            </ul>
          </article>
          <p v-if="!saved.history.length">{{ $t('admin:storage.noReviewedConfigurationPublications') }}</p>
        </details>
      </template>
      <template v-else>
        <div class="storage-overview">
          <section>
            <div class="storage-heading"><span class="storage-kicker">{{ $t('admin:storage.n04RecoveryConsidered') }}</span>
              <h2>{{ $t('admin:storage.knowWhatCopyCan') }}</h2>
              <p>{{ $t('admin:storage.startFailureYouNeed') }}</p>
            </div>
            <div class="storage-coverage">
              <article><span>01</span>
                <div>
                  <h3>{{ $t('admin:storage.sharedContentExport') }}</h3>
                  <p>{{ $t('admin:storage.copiesSharedPagesAssets') }}</p><v-btn
                    variant="text"
                    append-icon="mdi-arrow-right"
                    @click="selectSection('targets')"
                  >{{ $t('admin:storage.configureExportTarget') }}</v-btn>
                </div>
              </article>
              <article><span>02</span>
                <div>
                  <h3>{{ $t('admin:storage.storageFolderArchive') }}</h3>
                  <p>{{ $t('admin:storage.localDiskArchivesPackage') }}</p>
                  <p>{{ $t('admin:storage.dailyArchivesRotateDay') }}</p><v-btn
                    variant="text"
                    append-icon="mdi-arrow-right"
                    @click="selectTarget('disk')"
                  >{{ $t('admin:storage.inspectLocalDisk') }}</v-btn>
                </div>
              </article>
              <article><span>03</span>
                <div>
                  <h3>{{ $t('admin:storage.wholeWorkspaceRecovery') }}</h3>
                  <p>{{ $t('admin:storage.keepDatabaseBackupRequired') }}</p>
                  <p>{{ $t('admin:storage.restoreIntoIsolatedEnvironment') }}</p><v-btn
                    to="/system"
                    variant="text"
                    append-icon="mdi-arrow-right"
                  >{{ $t('admin:storage.inspectDeploymentInformation') }}</v-btn>
                </div>
              </article>
            </div>
          </section>
          <aside class="storage-aside"><span class="storage-kicker">{{ $t('admin:storage.recoveryRehearsal') }}</span>
            <h3>{{ $t('admin:storage.copyBecomesUseful') }}<br />{{ $t('admin:storage.whenRestoreWorks') }}</h3>
            <ol class="storage-checklist">
              <li>{{ $t('admin:storage.recordDeploymentVersionConfiguration') }}</li>
              <li>{{ $t('admin:storage.backUpDatabaseRequired') }}</li>
              <li>{{ $t('admin:storage.restoreIsolatedInstanceRemote') }}</li>
              <li>{{ $t('admin:storage.verifyAccountsPermissionsPrivate') }}</li>
              <li>{{ $t('admin:storage.rebuildDerivedIndexesNeeded') }}</li>
            </ol><v-btn
              block
              variant="outlined"
              prepend-icon="mdi-download"
              @click="downloadRecoveryPlan"
            >{{ $t('admin:storage.downloadRecoveryChecklist') }}</v-btn>
            <p class="storage-note">{{ $t('admin:storage.downloadsPlanCurrentTarget') }}</p>
          </aside>
        </div>
      </template>
      <div
        v-if="dirty"
        class="storage-draft-bar"
      >
        <div><strong>{{ $t('admin:storage.changedTargetsCount', { count: changedTargets.length }) }}</strong><span>{{ $t('admin:storage.reviewCompleteDraftBefore') }}</span></div><v-btn
          variant="text"
          :disabled="locked"
          @click="reset"
        >{{ $t('admin:storage.resetDraft') }}</v-btn><v-btn
          color="primary"
          :disabled="locked"
          @click="reviewSave"
        >{{ $t('admin:storage.reviewChanges') }}</v-btn>
      </div>
    </template>
    <v-dialog
      v-model="reviewOpen"
      max-width="800"
      :persistent="busy"
      aria-labelledby="storage-review-title"
    ><v-card class="storage-dialog"><v-card-title
          id="storage-review-title">{{ reviewState?.title || $t('admin:storage.reviewStorageChanges') }}</v-card-title><v-card-text v-if="reviewState">
          <p>{{ reviewState.effect }}</p>
          <template v-if="reviewState.kind === 'save'">
            <article
              v-for="change in reviewChanges"
              :key="change.key"
              class="storage-review-target"
            >
              <h3>{{ targetTitle(change.key) }}</h3>
              <dl class="storage-facts"><template
                  v-for="field in change.fields"
                  :key="field.key"
                >
                  <dt>{{ field.label }}</dt>
                  <dd>{{ field.before }} <v-icon
                      icon="mdi-arrow-right"
                      size="14"
                    /> {{ field.after }}</dd>
                </template></dl>
            </article><v-alert
              type="info"
              variant="tonal"
              class="my-5"
            >{{ $t('admin:storage.saveApplyQueuesInitialization') }}</v-alert>
          </template>
          <v-alert
            v-if="reviewState.kind === 'resolve'"
            type="warning"
            variant="tonal"
            class="my-5"
          >{{ $t('admin:storage.resolvingRecordDoesNot') }}</v-alert>
          <v-textarea
            v-model="reason"
            :label="$t('admin:storage.administrativeReason')"
            variant="outlined"
            rows="2"
            maxlength="1000"
            counter
            :disabled="busy"
            :hint="$t('admin:storage.recordIntentSoAnother')"
            persistent-hint
          />
          <v-text-field
            v-if="reviewState.confirmation"
            v-model="confirmation"
            :label="$t('admin:storage.confirmationLabel')"
            :hint="reviewState.confirmation"
            persistent-hint
            :hide-details="false"
            variant="outlined"
            autocomplete="off"
            :disabled="busy"
            class="mt-4"
          />
          <p
            v-if="reviewError"
            role="alert"
            class="storage-error"
          >{{ reviewError }}</p>
        </v-card-text><v-card-actions class="storage-dialog-actions"><v-btn
            :disabled="busy"
            @click="reviewOpen = false"
          >{{ $t('admin:storage.back') }}</v-btn><v-spacer /><v-btn
            v-if="reviewState?.kind === 'save'"
            variant="outlined"
            :disabled="!canConfirm"
            @click="submit(false)"
          >{{ $t('admin:storage.saveOnly') }}</v-btn><v-btn
            color="primary"
            variant="flat"
            :disabled="!canConfirm"
            :aria-busy="busy"
            @click="submit(true)"
          >{{ busy ? $t('admin:storage.recording') : reviewState?.kind === 'save' ? $t('admin:storage.saveApply') : reviewState?.kind === 'cancel' ? $t('admin:storage.cancelOperation2') : reviewState?.kind === 'resolve' ? $t('admin:storage.resolveOperation') : $t('admin:storage.queueOperation') }}</v-btn></v-card-actions></v-card></v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { confirmDiscard } from '../common/confirm-dialog.ts'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { vCredentialAutofill } from '../../helpers/credential-autofill.ts'
import AsyncState from '@/components/common/async-state.vue'
import {
  StorageTargetDraftSchema,
  storageConfigurationIssues,
  type StorageWorkspace,
  type StorageTargetDraft,
  type StorageTargetView,
  type StorageField,
  type StorageActionDefinition,
  type StorageOperationView,
  type StorageValue
} from '../../../shared/storage-workspace.ts'
import { fetchStorageWorkspace, saveStorageConfiguration, submitStorageOperation, decideStorageOperation } from '../../helpers/storage-workspace-api.ts'
import StorageOperationReceipt from './storage-operation-receipt.vue'
import { dateTime, actor, operationLabel } from '../../helpers/storage-presentation.ts'
import './storage-workspace.scss'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const targetTitles = computed(() => Object.fromEntries(saved.value?.targets.map(target => [target.key, target.title]) || []))
const route = useRoute(),
  router = useRouter(),
  sections = [
    { key: 'overview', title: t('admin:storage.overview') },
    { key: 'targets', title: t('admin:storage.targets') },
    { key: 'operations', title: t('admin:storage.operations') },
    { key: 'recovery', title: t('admin:storage.recovery') }
  ]
const saved = shallowRef<StorageWorkspace | null>(null),
  drafts = ref<StorageTargetDraft[]>([]),
  loading = ref(false),
  busy = ref(false),
  stale = ref(false),
  error = ref(''),
  notice = ref(''),
  targetSearch = ref(''),
  operationSearch = ref(''),
  operationFilter = ref('all')
const reviewOpen = ref(false),
  reason = ref(''),
  confirmation = ref(''),
  reviewError = ref(''),
  customIntervals = ref<string[]>([])
type Review = {
  kind: 'save' | 'enqueue' | 'cancel' | 'resolve'
  title: string
  effect: string
  confirmation: string
  body: Record<string, unknown>
  drafts?: StorageTargetDraft[]
  id?: string
}
const reviewState = shallowRef<Review | null>(null)
let disposed = false,
  sequence = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  writeConfirmed = false
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const fromSaved = (value: StorageWorkspace): StorageTargetDraft[] =>
  value.targets.map(({ key, isEnabled, mode, syncInterval, config, secrets }) => ({
    key,
    isEnabled,
    mode,
    syncInterval,
    config: clone(config),
    secrets: Object.fromEntries(Object.keys(secrets).map(key => [key, { action: 'keep' as const }]))
  }))
const section = computed(() => (sections.some(tab => tab.key === route.query.section) ? String(route.query.section) : 'overview'))
const draftFor = (key: string) => drafts.value.find(target => target.key === key)
const dirty = computed(() => Boolean(saved.value) && JSON.stringify(drafts.value) !== JSON.stringify(fromSaved(saved.value!)))
const reviewInputDirty = computed(() => reviewOpen.value && (reason.value.length > 0 || confirmation.value.length > 0))
const targetChanged = (key: string) =>
  Boolean(saved.value) && JSON.stringify(draftFor(key)) !== JSON.stringify(fromSaved(saved.value!).find(target => target.key === key))
const changedTargets = computed(() => drafts.value.filter(target => targetChanged(target.key)))
const activeOperation = computed(() => saved.value?.operations.find(operation => ['queued', 'running', 'interrupted'].includes(operation.state)))
const baseLocked = computed(() => busy.value || loading.value || stale.value || !saved.value),
  locked = computed(() => baseLocked.value || Boolean(activeOperation.value)),
  actionLocked = computed(() => locked.value || dirty.value)
const observation = (key: string) => saved.value?.runtime.find(target => target.key === key)
const enabledTargets = computed(() => saved.value?.targets.filter(target => target.isEnabled) || []),
  currentTargets = computed(() => enabledTargets.value.filter(target => observation(target.key)?.state === 'active' && observation(target.key)?.matchesSaved)),
  pendingTargets = computed(() => saved.value?.runtime.filter(target => target.state === 'outdated' || target.state === 'pending') || [])
const selectedTarget = computed(() => saved.value?.targets.find(target => target.key === route.query.target) || saved.value?.targets[0]),
  selectedDraft = computed(() => (selectedTarget.value ? draftFor(selectedTarget.value.key) : undefined))
const filteredTargets = computed(
  () =>
    saved.value?.targets.filter(target =>
      `${target.title} ${target.description} ${target.key}`.toLowerCase().includes((targetSearch.value || '').toLowerCase())
    ) || []
)
const operationFilters = [
  { value: 'all', title: t('admin:storage.allOutcomes') },
  ...['queued', 'running', 'succeeded', 'partial', 'failed', 'interrupted', 'cancelled', 'resolved'].map(value => ({ value, title: operationLabel(value) }))
]
const filteredOperations = computed(
  () =>
    saved.value?.operations.filter(
      operation =>
        (operationFilter.value === 'all' || operation.state === operationFilter.value) &&
        `${operation.title} ${operation.targetKey || ''} ${operation.reason}`.toLowerCase().includes((operationSearch.value || '').toLowerCase())
    ) || []
)
const selectedOperation = computed(() => filteredOperations.value.find(operation => operation.id === route.query.operation) || filteredOperations.value[0])
const secretActions = [
  { value: 'keep', title: t('admin:storage.keepSavedValue') },
  { value: 'replace', title: t('admin:storage.replaceValue') },
  { value: 'clear', title: t('admin:storage.clearSavedValue') }
]
const intervals = [
  { value: 'P0D', title: t('admin:storage.noScheduledSync') },
  { value: 'PT1M', title: t('admin:storage.everyMinute') },
  { value: 'PT5M', title: t('admin:storage.every5Minutes') },
  { value: 'PT15M', title: t('admin:storage.every15Minutes') },
  { value: 'PT1H', title: t('admin:storage.everyHour') },
  { value: 'custom', title: t('admin:storage.customInterval') }
]
const scheduleMode = computed(() =>
  selectedDraft.value
    ? customIntervals.value.includes(selectedDraft.value.key) || !intervals.some(interval => interval.value === selectedDraft.value!.syncInterval)
      ? 'custom'
      : selectedDraft.value.syncInterval
    : 'P0D'
)
const destinationKeys = [
  'host',
  'port',
  'endpoint',
  'region',
  'bucket',
  'accountName',
  'containerName',
  'repoUrl',
  'branch',
  'path',
  'basePath',
  'localRepoPath',
  'pathPrefix'
]
const accessKeys = ['authType', 'authMode', 'sshPrivateKeyMode', 'sshPrivateKeyPath', 'sshKnownHosts', 'hostKeyFingerprint', 'accessKeyId', 'username', 'basicUsername']
function visibleField(field: StorageField) {
  const config = selectedDraft.value?.config,
    key = selectedTarget.value?.key
  if (!config) return false
  if (key === 'sftp') {
    if (['privateKey', 'passphrase'].includes(field.key) && config.authMode !== 'privateKey') return false
    if (field.key === 'password' && config.authMode !== 'password') return false
  }
  if (key === 'git') {
    if (field.key.startsWith('ssh') && config.authType !== 'ssh') return false
    if (field.key.startsWith('basic') && config.authType !== 'basic') return false
    if (field.key === 'sshPrivateKeyPath' && config.sshPrivateKeyMode !== 'path') return false
    if (field.key === 'sshPrivateKeyContent' && config.sshPrivateKeyMode !== 'contents') return false
  }
  return true
}
const fieldGroups = computed(() => {
  const fields = selectedTarget.value?.fields.filter(visibleField) || []
  return [
    { title: t('admin:storage.destination'), hint: t('admin:storage.whereContentStored'), fields: fields.filter(field => destinationKeys.includes(field.key)) },
    { title: t('admin:storage.access'), hint: t('admin:storage.hiddenCredentialsRetained'), fields: fields.filter(field => field.sensitive || accessKeys.includes(field.key)) },
    {
      title: t('admin:storage.targetBehavior'),
      hint: t('admin:storage.providerSpecificOptions'),
      fields: fields.filter(field => !field.sensitive && !accessKeys.includes(field.key) && !destinationKeys.includes(field.key))
    }
  ].filter(group => group.fields.length)
})
const issuesFor = (draft: StorageTargetDraft) => {
  const target = saved.value?.targets.find(target => target.key === draft.key)
  if (!target) return []
  return storageConfigurationIssues({
    key: draft.key,
    config: draft.config,
    secrets: Object.fromEntries(
      Object.entries(draft.secrets).map(([key, value]) => [
        key,
        value.action === 'keep' ? target.secrets[key] === true : value.action === 'replace' && Boolean(value.value)
      ])
    )
  })
}
const selectedIssues = computed(() => (selectedDraft.value ? issuesFor(selectedDraft.value) : []))
const canConfirm = computed(
  () =>
    !busy.value &&
    !stale.value &&
    reason.value.trim().length >= 3 &&
    reason.value.trim().length <= 1000 &&
    Boolean(reviewState.value) &&
    (!reviewState.value!.confirmation || confirmation.value === reviewState.value!.confirmation)
)
const reviewChanges = computed(
  () =>
    reviewState.value?.drafts
      ?.filter(draft => {
        const before = fromSaved(saved.value!).find(target => target.key === draft.key)
        return JSON.stringify(before) !== JSON.stringify(draft)
      })
      .map(draft => {
        const before = fromSaved(saved.value!).find(target => target.key === draft.key)!,
          target = saved.value!.targets.find(target => target.key === draft.key)!,
          fields: Array<{ key: string; label: string; before: string; after: string }> = []
        for (const key of ['isEnabled', 'mode', 'syncInterval'] as const)
          if (before[key] !== draft[key])
            fields.push({
              key,
              label: key === 'isEnabled' ? t('admin:storage.targetState2') : key === 'mode' ? t('admin:storage.direction') : t('admin:storage.schedule'),
              before: display(before[key]),
              after: display(draft[key])
            })
        for (const field of target.fields) {
          if (field.sensitive) {
            const change = draft.secrets[field.key]
            if (change && change.action !== 'keep')
              fields.push({
                key: field.key,
                label: field.title,
                before: target.secrets[field.key] ? t('admin:storage.valueSaved') : t('admin:storage.notConfigured'),
                after: change.action === 'replace' ? t('admin:storage.replaceCredential') : t('admin:storage.clearCredential')
              })
          } else if (before.config[field.key] !== draft.config[field.key])
            fields.push({ key: field.key, label: field.title, before: display(before.config[field.key]), after: display(draft.config[field.key]) })
        }
        return { key: draft.key, fields }
      }) || []
)
function display(value: unknown) {
  return typeof value === 'boolean' ? (value ? t('admin:storage.enabled') : t('admin:storage.disabled')) : value === undefined || value === '' ? t('admin:storage.empty') : String(value)
}

function modeLabel(value: string) {
  return ({ push: t('admin:storage.exportTarget'), pull: t('admin:storage.importTarget'), sync: t('admin:storage.twoWaySynchronization') } as Record<string, string>)[value] || value
}

function lastOutcomeLabel(value: string | null | undefined) {
  return (
    (
      { operational: t('admin:storage.completedAttempt'), pending: t('admin:storage.pending'), warning: t('admin:storage.issueRecorded'), error: t('admin:storage.failedAttempt'), paused: t('admin:storage.pausedOffline') } as Record<
        string,
        string
      >
    )[value || ''] || t('admin:storage.notRecorded')
  )
}
function runtimeLabel(key: string) {
  return (
    (
      {
        disabled: t('admin:storage.disabled'),
        pending: t('admin:storage.applyRequired'),
        active: t('admin:storage.usingSavedSettings'),
        paused: t('admin:storage.pausedOffline'),
        failed: t('admin:storage.initializationFailed'),
        outdated: t('admin:storage.applyRequired')
      } as Record<string, string>
    )[observation(key)?.state || 'pending'] || t('admin:storage.notObserved')
  )
}
function targetIcon(key: string) {
  return (
    (
      {
        disk: 'mdi-folder-outline',
        git: 'mdi-source-repository',
        sftp: 'mdi-server-network-outline',
        s3: 'mdi-aws',
        azure: 'mdi-microsoft-azure',
        digitalocean: 'mdi-cloud-outline',
        s3generic: 'mdi-bucket-outline'
      } as Record<string, string>
    )[key] || 'mdi-database-outline'
  )
}
function targetKind(key: string) {
  return key === 'disk' ? t('admin:storage.localFilesystem') : key === 'git' ? t('admin:storage.versionedRepository') : key === 'sftp' ? t('admin:storage.remoteFilesystem') : t('admin:storage.objectStorage')
}
function targetTitle(key: string) {
  return saved.value?.targets.find(target => target.key === key)?.title || key
}

function changedFieldLabel(value: string) {
  const key = value.replace(/^(config|secret)\./, '')
  return saved.value?.targets.flatMap(target => target.fields).find(field => field.key === key)?.title || key
}
function intervalLabel(target: StorageTargetView) {
  return target.schedule
    ? intervals.find(interval => interval.value === target.syncInterval)?.title || target.syncInterval
    : target.key === 'disk'
      ? t('admin:storage.folderArchivesAvailable')
      : t('admin:storage.contentEventUpdates')
}
function setField(key: string, value: StorageValue) {
  if (!locked.value && selectedDraft.value) selectedDraft.value.config[key] = value
}
function setSchedule(value: string) {
  if (locked.value || !selectedDraft.value) return
  const key = selectedDraft.value.key
  customIntervals.value = customIntervals.value.filter(value => value !== key)
  if (value === 'custom') customIntervals.value.push(key)
  else selectedDraft.value.syncInterval = value
}
function setSecretAction(key: string, action: string) {
  if (locked.value || !selectedDraft.value) return
  selectedDraft.value.secrets[key] = action === 'replace' ? { action: 'replace', value: '' } : action === 'clear' ? { action: 'clear' } : { action: 'keep' }
}
function secretValue(key: string) {
  const value = selectedDraft.value?.secrets[key]
  return value?.action === 'replace' ? value.value : ''
}
function setSecretValue(key: string, value: string) {
  if (!locked.value && selectedDraft.value) selectedDraft.value.secrets[key] = { action: 'replace', value }
}
function canRun(key: string) {
  return (
    !actionLocked.value &&
    Boolean(saved.value?.targets.find(target => target.key === key)?.isEnabled) &&
    Boolean(observation(key)?.matchesSaved && observation(key)?.active) &&
    (!saved.value?.offline || key === 'disk' || (key === 'git' && saved.value?.gitSyncAllowedWhileOffline === true))
  )
}
function reset() {
  if (saved.value) {
    drafts.value = fromSaved(saved.value)
    customIntervals.value = []
  }
}
function selectSection(value: string) {
  void router.replace({ query: { ...route.query, section: value } })
}
function selectTarget(key: string) {
  void router.replace({ query: { ...route.query, section: 'targets', target: key } })
}
function selectOperation(id: string) {
  void router.replace({ query: { ...route.query, section: 'operations', operation: id } })
}
function schedulePoll() {
  if (timer) clearTimeout(timer)
  if (!disposed)
    timer = setTimeout(() => {
      if (!busy.value && !loading.value) void load(false)
      else schedulePoll()
    }, 10000)
}
async function load(replace = true) {
  const id = ++sequence
  if (replace) loading.value = true
  error.value = ''
  try {
    const value = await fetchStorageWorkspace()
    if (disposed || id !== sequence) return false
    if (!replace && saved.value && saved.value.fingerprint !== value.fingerprint && (dirty.value || reviewOpen.value || stale.value)) {
      stale.value = true
      saved.value = { ...saved.value, runtime: value.runtime, operations: value.operations, observedAt: value.observedAt }
      error.value = t('admin:storage.storageSettingsAccessChanged')
    } else {
      const preserve = !replace && dirty.value
      saved.value = value
      if (!preserve) reset()
      if (replace) {
        stale.value = false
        writeConfirmed = false
      }
    }
    return true
  } catch (err) {
    if (!disposed && id === sequence) error.value = err instanceof Error ? err.message : t('admin:storage.storageCouldNotLoaded')
    return false
  } finally {
    if (!disposed && id === sequence) {
      loading.value = false
      schedulePoll()
    }
  }
}
const askDiscard = () =>
  confirmDiscard(
    t('admin:storage.discardUnsavedChanges'),
    reviewInputDirty.value
      ? t('admin:storage.reviewInputWillBeDiscarded')
      : stale.value
        ? t('admin:storage.serverOutcomeNeedsConfirmation')
        : t('admin:storage.targetDraftHasNot'),
    t('admin:storage.discardDraft')
  )
async function guarded(action: () => void) {
  if (!dirty.value || writeConfirmed) return action()
  if (!(await askDiscard())) return
  reset()
  action()
}
function reload() {
  guarded(() => {
    void load(true)
  })
}
function openReview(value: Review) {
  reviewState.value = clone(value)
  reason.value = ''
  confirmation.value = ''
  reviewError.value = ''
  reviewOpen.value = true
}
function reviewSave() {
  if (locked.value || !saved.value || !dirty.value) return
  for (const draft of drafts.value) {
    const validation = StorageTargetDraftSchema.safeParse(draft)
    if (!validation.success) {
      error.value = t('admin:storage.checkFieldsReplacementCredentials', { key: targetTitle(draft.key), interpolation: { escapeValue: false } })
      selectTarget(draft.key)
      return
    }
    const issues = draft.isEnabled ? issuesFor(draft) : []
    if (issues.length) {
      error.value = `${targetTitle(draft.key)}: ${issues[0]}`
      selectTarget(draft.key)
      return
    }
  }
  openReview({
    kind: 'save',
    title: t('admin:storage.reviewStoragePublication'),
    effect: t('admin:storage.reviewEveryChangedTarget'),
    confirmation: '',
    body: { targets: clone(drafts.value), fingerprint: saved.value.fingerprint },
    drafts: clone(drafts.value)
  })
}
function reviewActivation() {
  if (actionLocked.value || !saved.value) return
  openReview({
    kind: 'enqueue',
    title: t('admin:storage.applySavedStorageSettings'),
    effect:
      t('admin:storage.stopPreviousTargetsInitialize'),
    confirmation: 'APPLY STORAGE SETTINGS',
    body: { targetKey: null, handler: 'activate', fingerprint: saved.value.fingerprint }
  })
}
function reviewAction(target: StorageTargetView, action: StorageActionDefinition) {
  if (!canRun(target.key) || !saved.value) return
  openReview({
    kind: 'enqueue',
    title: `${action.title} · ${target.title}`,
    effect: action.effect,
    confirmation: action.confirmation,
    body: { targetKey: target.key, handler: action.handler, fingerprint: saved.value.fingerprint }
  })
}
function reviewDecision(operation: StorageOperationView, kind: 'cancel' | 'resolve') {
  if (baseLocked.value || dirty.value || !saved.value) return
  openReview({
    kind,
    title: kind === 'cancel' ? t('admin:storage.cancelBeforeExecution') : t('admin:storage.resolveUncertainOperation'),
    effect: operation.effect,
    confirmation: kind === 'cancel' ? 'CANCEL OPERATION' : 'PRIOR WORKER STOPPED',
    body: { fingerprint: saved.value.fingerprint },
    id: operation.id
  })
}
async function submit(apply: boolean) {
  const review = reviewState.value
  if (!review || !canConfirm.value) return
  busy.value = true
  ++sequence
  if (timer) clearTimeout(timer)
  reviewError.value = ''
  notice.value = ''
  try {
    let operationId: string | undefined
    if (review.kind === 'save') {
      const receipt = await saveStorageConfiguration({ ...review.body, reason: reason.value.trim(), apply })
      operationId = receipt.operation?.id
      notice.value = apply ? t('admin:storage.settingsSavedApplyingThem') : t('admin:storage.settingsSavedExistingRuntimes')
    } else if (review.kind === 'enqueue') {
      operationId = (await submitStorageOperation({ ...review.body, reason: reason.value.trim(), confirmation: confirmation.value })).id
      notice.value = t('admin:storage.operationQueuedReceiptWill')
    } else {
      await decideStorageOperation(review.id!, review.kind, { ...review.body, reason: reason.value.trim(), confirmation: confirmation.value })
      notice.value = review.kind === 'cancel' ? t('admin:storage.operationCancelledBeforeExecution') : t('admin:storage.recoveryDecisionRecordedPrior')
    }
    writeConfirmed = true
    reviewOpen.value = false
    if (!(await load(true))) {
      stale.value = true
      error.value = t('admin:storage.actionWasRecordedBut')
    }
    if (operationId) selectOperation(operationId)
  } catch (err) {
    reviewError.value = err instanceof Error ? err.message : t('admin:storage.outcomeUnconfirmed')
    const status = err && typeof err === 'object' ? Reflect.get(err, 'status') : undefined
    if (status !== 400) {
      stale.value = true
      error.value = reviewError.value
    }
  } finally {
    busy.value = false
    if (!reviewOpen.value) reviewState.value = null
    schedulePoll()
  }
}
function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function downloadReceipt() {
  if (selectedOperation.value)
    download(
      `storage-operation-${selectedOperation.value.id}.json`,
      JSON.stringify({ observedAt: saved.value?.observedAt, operation: selectedOperation.value }, null, 2),
      'application/json'
    )
}
function downloadRecoveryPlan() {
  if (!saved.value) return
  download(
    'workspace-recovery-checklist.md',
    `${t('admin:storage.workspaceRecoveryChecklistObserved', { observedAt: saved.value.observedAt, targets: saved.value.targets.map(target => `- ${target.title}: ${target.isEnabled ? 'enabled' : 'disabled'}; ${modeLabel(target.mode)}; ${runtimeLabel(target.key)}.`).join('\n'), interpolation: { escapeValue: false } })}
`,
    'text/markdown'
  )
}
function beforeUnload(event: BeforeUnloadEvent) {
  if ((dirty.value && !writeConfirmed) || reviewInputDirty.value || busy.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}
onBeforeRouteLeave(async () => {
  if (busy.value) return false
  if ((dirty.value && !writeConfirmed) || reviewInputDirty.value) return !busy.value && (await askDiscard())
  return true
})
watch(reviewOpen, value => {
  if (!value && !busy.value) reviewState.value = null
})
onMounted(() => {
  void load(true)
  window.addEventListener('beforeunload', beforeUnload)
})
onBeforeUnmount(() => {
  disposed = true
  ++sequence
  if (timer) clearTimeout(timer)
  window.removeEventListener('beforeunload', beforeUnload)
  drafts.value = []
  reviewState.value = null
})
</script>
