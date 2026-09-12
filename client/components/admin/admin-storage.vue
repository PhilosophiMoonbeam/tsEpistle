<template>
  <v-container
    fluid
    class="storage-workspace"
    :inert="reviewOpen || discardOpen"
  >
    <admin-hero
      title="Storage"
      description="Keep knowledge portable. Make every copy and every recovery deliberate."
      icon="mdi-database-outline"
    >
      <template #actions>
        <v-btn
          variant="text"
          prepend-icon="mdi-refresh"
          :disabled="busy || loading"
          @click="reload"
        >Reload workspace</v-btn>
        <v-btn
          v-if="dirty"
          variant="text"
          :disabled="locked"
          @click="reset"
        >Reset draft</v-btn>
        <v-btn
          color="primary"
          :disabled="locked || !dirty"
          @click="reviewSave"
        >Review changes</v-btn>
      </template>
    </admin-hero>
    <async-state
      v-if="loading && !saved"
      state="loading"
      title="Loading Storage"
      message="Reading saved targets, active runtimes and operation receipts."
    />
    <async-state
      v-else-if="error && !saved"
      state="error"
      title="Storage could not be loaded"
      :message="error"
      retry-label="Try again"
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
    >Reload before another change. The saved state changed or the outcome of a request needs confirmation.</v-alert>
    <v-alert
      v-if="notice"
      variant="tonal"
      type="success"
      class="mb-5"
      role="status"
    >{{ notice }}</v-alert>
    <template v-if="saved">
      <div class="storage-status"><span><i
            :class="{attention:dirty || stale}" />{{ stale ? 'Reload required' : dirty ? 'Unsaved target configuration' : 'Saved configuration & observed runtime' }}</span><time
          :datetime="saved.observedAt"
        >Observed {{ dateTime(saved.observedAt) }}</time></div>
      <nav
        class="storage-tabs"
        aria-label="Storage sections"
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
      >Offline mode pauses new remote storage work. Local disk remains available. Work already in progress may finish.</v-alert>
      <div
        v-if="activeOperation"
        class="storage-running"
        role="status"
      >
        <v-icon :icon="activeOperation.state === 'interrupted' ? 'mdi-alert-circle-outline' : 'mdi-timer-sand'" />
        <div><strong>{{ operationLabel(activeOperation.state) }} · {{ activeOperation.title }}</strong>
          <p>
            {{ activeOperation.state === 'interrupted' ? 'Its outcome needs review before settings can change or another operation can start.' : 'Settings and additional operations are locked until this work finishes. You can leave this page and return to its receipt.' }}
          </p>
        </div>
        <v-btn
          variant="outlined"
          @click="selectOperation(activeOperation.id)"
        >View operation</v-btn>
      </div>
      <template v-if="section === 'overview'">
        <div class="storage-overview">
          <section>
            <div class="storage-heading"><span class="storage-kicker">01 / Copies with a purpose</span>
              <h2>Your knowledge,<br />beyond this database</h2>
              <p>Choose where shared pages and assets go. Know which settings are running, what changed, and what each copy can restore.</p>
            </div>
            <div class="storage-metrics">
              <div><span>Using saved settings</span><strong>{{ currentTargets.length }}<small> / {{ enabledTargets.length }}</small></strong>
                <p>Initialized and available for new work</p>
              </div>
              <div><span>Awaiting application</span><strong>{{ pendingTargets.length }}</strong>
                <p>Saved configuration differs from the runtime</p>
              </div>
            </div>
            <div class="storage-section-head">
              <h3>Configured destinations</h3><v-btn
                variant="text"
                append-icon="mdi-arrow-right"
                @click="selectSection('targets')"
              >All targets</v-btn>
            </div>
            <div
              v-if="!enabledTargets.length"
              class="storage-empty"
            ><v-icon
                size="36"
                icon="mdi-folder-plus-outline"
              />
              <h3>Choose your first destination</h3>
              <p>Start with a local export, connect a Git repository, or send content to an object store. Targets stay disabled until you configure and
                apply them.</p><v-btn
                variant="outlined"
                @click="selectSection('targets')"
              >Browse targets</v-btn>
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
            <span class="storage-kicker">Configuration → runtime</span>
            <h3>Saved is one step.<br />Running is the next.</h3>
            <p>Review changes and choose Save and apply to queue activation. Save only lets you stage settings for later.</p>
            <p>Initialization can connect to services, create destination resources and synchronize Git content.</p><v-btn
              block
              variant="outlined"
              :disabled="actionLocked || (!enabledTargets.length && !pendingTargets.length)"
              @click="reviewActivation"
            >Apply saved settings</v-btn>
            <div class="storage-aside-rule" /><span class="storage-kicker">Recovery coverage</span>
            <h3>A content copy has boundaries</h3>
            <p>Storage exports are useful for portability. Whole-workspace recovery also needs the database, files and configuration secrets.</p><v-btn
              variant="text"
              append-icon="mdi-arrow-right"
              @click="selectSection('recovery')"
            >Build a recovery plan</v-btn>
            <div class="storage-aside-rule" />
            <p class="storage-note">Observations refresh every 10 seconds while this page is open. An initialized target is not proof that its remote
              copy is complete.</p>
          </aside>
        </div>
      </template>
      <template v-else-if="section === 'targets'">
        <div class="storage-heading"><span class="storage-kicker">02 / Destination catalog</span>
          <h2>A home for each copy</h2>
          <p>Configure the destination, its access and the direction of content flow. Review all changed targets together.</p>
        </div>
        <div class="storage-target-layout">
          <aside class="storage-catalog">
            <v-select
              class="storage-mobile-target"
              :model-value="selectedTarget?.key"
              :items="saved.targets.map(target => ({value:target.key,title:target.title + (target.isAvailable ? '' : ' · Unavailable')}))"
              label="Storage target"
              variant="outlined"
              hide-details
              @update:model-value="selectTarget"
            />
            <v-text-field
              v-model="targetSearch"
              label="Find a target"
              prepend-inner-icon="mdi-magnify"
              variant="outlined"
              density="compact"
              clearable
              hide-details
            />
            <nav aria-label="Storage targets"><button
                v-for="target in filteredTargets"
                :key="target.key"
                type="button"
                :aria-current="selectedTarget?.key === target.key ? 'page' : undefined"
                @click="selectTarget(target.key)"
              ><v-icon
                  :icon="targetIcon(target.key)" /><span><strong>{{ target.title }}</strong><small>{{ target.isAvailable ? draftFor(target.key)?.isEnabled ? 'Enabled in draft' : 'Disabled in draft' : 'Unavailable in this build' }}</small></span><i
                  v-if="targetChanged(target.key)"
                  aria-label="Unsaved changes"
                /></button></nav>
            <p
              v-if="!filteredTargets.length"
              class="storage-note"
            >No targets match this search.</p>
            <p class="storage-note">All {{ saved.targets.length }} installed targets are shown. Credentials are kept unless you explicitly replace or
              clear them.</p>
          </aside>
          <section
            v-if="selectedTarget && selectedDraft"
            class="storage-target-detail"
            :aria-label="selectedTarget.title + ' configuration'"
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
                <h4>Include this target</h4>
                <p>The draft becomes active after you save and apply it.</p>
              </div><v-switch
                :model-value="selectedDraft.isEnabled"
                :label="selectedDraft.isEnabled ? 'Enabled' : 'Disabled'"
                :aria-label="'Enable ' + selectedTarget.title"
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
              <summary>Runtime evidence</summary>
              <dl class="storage-facts">
                <dt>Using saved configuration</dt>
                <dd>{{ observation(selectedTarget.key)?.matchesSaved ? 'Yes' : 'Apply required' }}</dd>
                <dt>Last recorded attempt</dt>
                <dd>{{ dateTime(observation(selectedTarget.key)?.lastAttempt) }}</dd>
                <dt>Last recorded result</dt>
                <dd>{{ lastOutcomeLabel(observation(selectedTarget.key)?.lastOutcome) }}</dd>
              </dl>
              <p class="storage-note">An attempt can be initialization, a content event, synchronization or an explicit action. It does not verify the
                completeness of a destination copy.</p>
              <p
                v-if="['error','warning'].includes(observation(selectedTarget.key)?.lastOutcome || '')"
                class="storage-note"
              >The target reported an issue. Review its destination and access settings and inspect application logs before deciding whether to repeat
                an operation.</p>
            </details>
            <v-alert
              v-if="!selectedTarget.isAvailable"
              variant="tonal"
              type="warning"
              class="mb-5"
            >This module cannot run in the current build. Saved values are retained. You can disable an enabled target.</v-alert>
            <div class="storage-fields storage-direction">
              <v-select
                v-model="selectedDraft.mode"
                :items="selectedTarget.modes.map(value => ({value,title:modeLabel(value)}))"
                label="Content direction"
                variant="outlined"
                :disabled="locked || !selectedTarget.isAvailable"
                persistent-hint
                hint="Explicit actions describe their own effects below."
              />
              <div v-if="selectedTarget.schedule"><v-select
                  :model-value="scheduleMode"
                  :items="intervals"
                  label="Scheduled synchronization"
                  variant="outlined"
                  :disabled="locked"
                  @update:model-value="setSchedule"
                /><v-text-field
                  v-credential-autofill
                  v-if="scheduleMode === 'custom'"
                  v-model="selectedDraft.syncInterval"
                  label="Custom interval (ISO 8601)"
                  autocomplete="off"
                  variant="outlined"
                  hint="Examples: PT30M or PT2H. From 10 seconds to 24 days."
                  persistent-hint
                  :disabled="locked"
                /></div>
              <div
                v-else
                class="storage-field-note"
              ><strong>{{ selectedTarget.key === 'disk' ? 'Archives follow their own schedule' : 'Updates follow content events' }}</strong>
                <p>
                  {{ selectedTarget.key === 'disk' ? 'Daily folder archives can be enabled in Target behavior. They do not refresh the folder from the database first.' : 'This target has no configurable synchronization interval. Use an export to catch up content created while it was disabled.' }}
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
                    <p>{{ selectedTarget.secrets[field.key] ? 'A value is saved. It is never returned to this page.' : 'No value is currently saved.' }}
                    </p><v-select
                      :model-value="selectedDraft.secrets[field.key]?.action"
                      :items="secretActions"
                      :label="field.title + ' action'"
                      variant="outlined"
                      density="compact"
                      hide-details
                      :disabled="locked"
                      @update:model-value="setSecretAction(field.key,$event)"
                    /><v-textarea
                      v-credential-autofill
                      v-if="field.multiline && selectedDraft.secrets[field.key]?.action === 'replace'"
                      :model-value="secretValue(field.key)"
                      :label="'New ' + field.title"
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
                      :label="'New ' + field.title"
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
            ><strong>{{ selectedDraft.isEnabled ? 'Before this target can run' : 'Before enabling this target' }}</strong>
              <ul>
                <li
                  v-for="issue in selectedIssues"
                  :key="issue"
                >{{ issue }}</li>
              </ul>
            </v-alert>
            <section class="storage-field-section">
              <div class="storage-section-head">
                <h4>Target operations</h4><span>Use the saved, active configuration</span>
              </div>
              <p
                v-if="dirty || !observation(selectedTarget.key)?.matchesSaved || !observation(selectedTarget.key)?.active"
                class="storage-note"
              >Save and apply this target successfully before running an action. Each operation has a separate review and receipt.</p>
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
                  >Review action</v-btn>
                </article>
              </div>
            </section>
          </section>
          <div
            v-else
            class="storage-empty"
          >
            <h3>No storage modules are installed</h3>
            <p>Check the application build and refresh the workspace.</p>
          </div>
        </div>
      </template>
      <template v-else-if="section === 'operations'">
        <div class="storage-heading"><span class="storage-kicker">03 / A record of the work</span>
          <h2>Every operation leaves a receipt</h2>
          <p>Follow queued work, inspect completed imports and exports, and resolve uncertainty before repeating external effects.</p>
        </div>
        <div class="storage-section-head"><v-text-field
            v-model="operationSearch"
            label="Find an operation"
            prepend-inner-icon="mdi-magnify"
            variant="outlined"
            density="compact"
            hide-details
            clearable
          /><v-select
            v-model="operationFilter"
            :items="operationFilters"
            label="Outcome"
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
          <h3>{{ saved.operations.length ? 'No matching operations' : 'No reviewed operations yet' }}</h3>
          <p>Applying settings and running target actions creates records here. Older runtime observations remain in the target summary.</p>
        </div>
        <div
          v-else
          class="storage-operation-layout"
        >
          <nav
            aria-label="Storage operation history"
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
              >{{ operationLabel(operation.state) }}</span><strong>{{ operation.title }}</strong><small>{{ operation.targetKey ? targetTitle(operation.targetKey) : 'All configured targets' }}
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
        <p class="storage-note mt-5">Showing up to 50 recent records, plus any older unresolved operation. Uncertain jobs are never replayed
          automatically.</p>
        <details class="storage-configuration-history">
          <summary>Configuration publication history · {{ saved.history.length }} recent changes</summary>
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
          <p v-if="!saved.history.length">No reviewed configuration publications have been recorded.</p>
        </details>
      </template>
      <template v-else>
        <div class="storage-overview">
          <section>
            <div class="storage-heading"><span class="storage-kicker">04 / Recovery, considered</span>
              <h2>Know what your copy can bring back</h2>
              <p>Start with the failure you need to recover from. Keep content portability and whole-workspace restoration in the same plan.</p>
            </div>
            <div class="storage-coverage">
              <article><span>01</span>
                <div>
                  <h3>Shared-content export</h3>
                  <p>Copies shared pages and assets into a target. Private pages, users, permissions, settings and database history are outside this
                    export.</p><v-btn
                    variant="text"
                    append-icon="mdi-arrow-right"
                    @click="selectSection('targets')"
                  >Configure an export target</v-btn>
                </div>
              </article>
              <article><span>02</span>
                <div>
                  <h3>Storage-folder archive</h3>
                  <p>Local disk archives package the files already in that folder. They do not refresh the folder first or form a transactional snapshot
                    of files being edited.</p>
                  <p>Daily archives rotate by day of the month; manual archives have unique names. Neither includes the workspace database or
                    application configuration.</p><v-btn
                    variant="text"
                    append-icon="mdi-arrow-right"
                    @click="selectTarget('disk')"
                  >Inspect local disk</v-btn>
                </div>
              </article>
              <article><span>03</span>
                <div>
                  <h3>Whole-workspace recovery</h3>
                  <p>Keep a database backup, required persistent files, application configuration and the secrets needed to decrypt stored credentials.
                    Store these independently of the application host.</p>
                  <p>Restore into an isolated environment and verify the result before reconnecting storage targets. The application cannot verify an
                    external backup from this page.</p><v-btn
                    to="/a/system"
                    variant="text"
                    append-icon="mdi-arrow-right"
                  >Inspect deployment information</v-btn>
                </div>
              </article>
            </div>
          </section>
          <aside class="storage-aside"><span class="storage-kicker">Recovery rehearsal</span>
            <h3>A copy becomes useful<br />when a restore works</h3>
            <ol class="storage-checklist">
              <li>Record the deployment version and configuration requirements.</li>
              <li>Back up the database and required persistent files with a consistent capture procedure.</li>
              <li>Restore to an isolated instance with remote storage disabled.</li>
              <li>Verify accounts, permissions, private and shared pages, assets and agent memory.</li>
              <li>Rebuild derived indexes as needed, then deliberately reconnect storage destinations.</li>
            </ol><v-btn
              block
              variant="outlined"
              prepend-icon="mdi-download"
              @click="downloadRecoveryPlan"
            >Download recovery checklist</v-btn>
            <p class="storage-note">This downloads a plan and current target observations. It does not create or validate a backup.</p>
          </aside>
        </div>
      </template>
      <div
        v-if="dirty"
        class="storage-draft-bar"
      >
        <div><strong>{{ changedTargets.length }} changed {{ changedTargets.length === 1 ? 'target' : 'targets' }}</strong><span>Review the complete
            draft before saving.</span></div><v-btn
          variant="text"
          :disabled="locked"
          @click="reset"
        >Reset draft</v-btn><v-btn
          color="primary"
          :disabled="locked"
          @click="reviewSave"
        >Review changes</v-btn>
      </div>
    </template>
    <v-dialog
      v-model="reviewOpen"
      max-width="800"
      :persistent="busy"
      aria-labelledby="storage-review-title"
    ><v-card class="storage-dialog"><v-card-title
          id="storage-review-title">{{ reviewState?.title || 'Review storage changes' }}</v-card-title><v-card-text v-if="reviewState">
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
            >Save and apply queues initialization as part of the same publication. It can connect to services, create destination resources and
              synchronize Git content. Save only keeps the current runtimes until a later application.</v-alert>
          </template>
          <v-alert
            v-if="reviewState.kind === 'resolve'"
            type="warning"
            variant="tonal"
            class="my-5"
          >Resolving this record does not undo prior effects or stop a worker. Verify its destination and stop the prior worker before proceeding. This
            unlocks configuration and new operations.</v-alert>
          <v-textarea
            v-model="reason"
            label="Administrative reason"
            variant="outlined"
            rows="2"
            maxlength="1000"
            counter
            :disabled="busy"
            hint="Record the intent so another administrator can understand this decision."
            persistent-hint
          />
          <v-text-field
            v-if="reviewState.confirmation"
            v-model="confirmation"
            :label="'Type ' + reviewState.confirmation"
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
          >Back</v-btn><v-spacer /><v-btn
            v-if="reviewState?.kind === 'save'"
            variant="outlined"
            :disabled="!canConfirm"
            @click="submit(false)"
          >Save only</v-btn><v-btn
            color="primary"
            variant="flat"
            :disabled="!canConfirm"
            :aria-busy="busy"
            @click="submit(true)"
          >{{ busy ? 'Recording…' : reviewState?.kind === 'save' ? 'Save and apply' : reviewState?.kind === 'cancel' ? 'Cancel operation' : reviewState?.kind === 'resolve' ? 'Resolve operation' : 'Queue operation' }}</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog
      v-model="discardOpen"
      max-width="480"
      aria-labelledby="storage-discard-title"
    ><v-card class="storage-dialog"><v-card-title id="storage-discard-title">Discard unsaved
          changes?</v-card-title><v-card-text>{{ stale ? 'The server outcome needs confirmation. Reload discards this local draft and reads saved state; it does not undo server changes.' : 'Your target draft has not been saved. Leaving or reloading will discard it.' }}</v-card-text><v-card-actions><v-btn
            @click="discardOpen = false; pendingNavigation = null"
          >Keep editing</v-btn><v-spacer /><v-btn
            color="primary"
            @click="discard"
          >Discard draft</v-btn></v-card-actions></v-card></v-dialog>
  </v-container>
</template>

<script setup lang="ts">
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
const targetTitles = computed(() => Object.fromEntries(saved.value?.targets.map(target => [target.key, target.title]) || []))
const route = useRoute(),
  router = useRouter(),
  sections = [
    { key: 'overview', title: 'Overview' },
    { key: 'targets', title: 'Targets' },
    { key: 'operations', title: 'Operations' },
    { key: 'recovery', title: 'Recovery' }
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
  discardOpen = ref(false),
  reason = ref(''),
  confirmation = ref(''),
  reviewError = ref(''),
  customIntervals = ref<string[]>([]),
  pendingNavigation = shallowRef<(() => void) | null>(null)
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
  writeConfirmed = false,
  leaving = false
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
  { value: 'all', title: 'All outcomes' },
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
  { value: 'keep', title: 'Keep saved value' },
  { value: 'replace', title: 'Replace value' },
  { value: 'clear', title: 'Clear saved value' }
]
const intervals = [
  { value: 'P0D', title: 'No scheduled sync' },
  { value: 'PT1M', title: 'Every minute' },
  { value: 'PT5M', title: 'Every 5 minutes' },
  { value: 'PT15M', title: 'Every 15 minutes' },
  { value: 'PT1H', title: 'Every hour' },
  { value: 'custom', title: 'Custom interval' }
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
    { title: 'Destination', hint: 'Where content is stored', fields: fields.filter(field => destinationKeys.includes(field.key)) },
    { title: 'Access', hint: 'Hidden credentials are retained', fields: fields.filter(field => field.sensitive || accessKeys.includes(field.key)) },
    {
      title: 'Target behavior',
      hint: 'Provider-specific options',
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
              label: key === 'isEnabled' ? 'Target state' : key === 'mode' ? 'Direction' : 'Schedule',
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
                before: target.secrets[field.key] ? 'Value saved' : 'Not configured',
                after: change.action === 'replace' ? 'Replace credential' : 'Clear credential'
              })
          } else if (before.config[field.key] !== draft.config[field.key])
            fields.push({ key: field.key, label: field.title, before: display(before.config[field.key]), after: display(draft.config[field.key]) })
        }
        return { key: draft.key, fields }
      }) || []
)
function display(value: unknown) {
  return typeof value === 'boolean' ? (value ? 'Enabled' : 'Disabled') : value === undefined || value === '' ? 'Empty' : String(value)
}

function modeLabel(value: string) {
  return ({ push: 'Export to target', pull: 'Import from target', sync: 'Two-way synchronization' } as Record<string, string>)[value] || value
}

function lastOutcomeLabel(value: string | null | undefined) {
  return (
    (
      { operational: 'Completed attempt', pending: 'Pending', warning: 'Issue recorded', error: 'Failed attempt', paused: 'Paused offline' } as Record<
        string,
        string
      >
    )[value || ''] || 'Not recorded'
  )
}
function runtimeLabel(key: string) {
  return (
    (
      {
        disabled: 'Disabled',
        pending: 'Apply required',
        active: 'Using saved settings',
        paused: 'Paused offline',
        failed: 'Initialization failed',
        outdated: 'Apply required'
      } as Record<string, string>
    )[observation(key)?.state || 'pending'] || 'Not observed'
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
  return key === 'disk' ? 'Local filesystem' : key === 'git' ? 'Versioned repository' : key === 'sftp' ? 'Remote filesystem' : 'Object storage'
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
      ? 'Folder archives available'
      : 'Content event updates'
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
    (!saved.value?.offline || key === 'disk')
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
      error.value = 'Storage settings or your access changed. Your draft is retained until you reload.'
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
    if (!disposed && id === sequence) error.value = err instanceof Error ? err.message : 'Storage could not be loaded.'
    return false
  } finally {
    if (!disposed && id === sequence) {
      loading.value = false
      schedulePoll()
    }
  }
}
function guarded(action: () => void) {
  if (dirty.value && !writeConfirmed) {
    pendingNavigation.value = action
    discardOpen.value = true
  } else action()
}
function reload() {
  guarded(() => {
    void load(true)
  })
}
function discard() {
  const next = pendingNavigation.value
  discardOpen.value = false
  pendingNavigation.value = null
  reset()
  next?.()
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
      error.value = `Check the fields and replacement credentials for ${targetTitle(draft.key)}.`
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
    title: 'Review storage publication',
    effect: 'Review every changed target. Credential values are omitted from this summary.',
    confirmation: '',
    body: { targets: clone(drafts.value), fingerprint: saved.value.fingerprint },
    drafts: clone(drafts.value)
  })
}
function reviewActivation() {
  if (actionLocked.value || !saved.value) return
  openReview({
    kind: 'enqueue',
    title: 'Apply saved storage settings',
    effect:
      'Stop the previous targets and initialize enabled targets using saved settings. Initialization can connect to remote services, create resources and synchronize Git content.',
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
    title: kind === 'cancel' ? 'Cancel before execution' : 'Resolve an uncertain operation',
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
      notice.value = apply ? 'Settings saved. Applying them is queued.' : 'Settings saved. Existing runtimes continue until you apply the saved configuration.'
    } else if (review.kind === 'enqueue') {
      operationId = (await submitStorageOperation({ ...review.body, reason: reason.value.trim(), confirmation: confirmation.value })).id
      notice.value = 'Operation queued. Its receipt will remain available after you leave this page.'
    } else {
      await decideStorageOperation(review.id!, review.kind, { ...review.body, reason: reason.value.trim(), confirmation: confirmation.value })
      notice.value = review.kind === 'cancel' ? 'Operation cancelled before execution.' : 'Recovery decision recorded. Prior effects have not been undone.'
    }
    writeConfirmed = true
    reviewOpen.value = false
    if (!(await load(true))) {
      stale.value = true
      error.value = 'The action was recorded, but the refreshed workspace could not be loaded. Reload to confirm its current state.'
    }
    if (operationId) selectOperation(operationId)
  } catch (err) {
    reviewError.value = err instanceof Error ? err.message : 'The outcome is unconfirmed.'
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
    `# Workspace recovery checklist\n\nObserved: ${saved.value.observedAt}\n\nThis is a plan, not a backup or verification report.\n\n1. Record the deployed application version and configuration requirements.\n2. Capture a consistent database backup and required persistent files. Retain configuration and decryption secrets separately and securely.\n3. Restore into an isolated instance with remote storage disabled.\n4. Verify accounts, permissions, private and shared pages, assets and agent memory.\n5. Rebuild derived indexes as needed, then deliberately reconnect storage targets.\n\n## Current target observations\n\n${saved.value.targets.map(target => `- ${target.title}: ${target.isEnabled ? 'enabled' : 'disabled'}; ${modeLabel(target.mode)}; ${runtimeLabel(target.key)}.`).join('\n')}\n\nContent exports omit private pages, accounts, settings and database history. Folder archives capture current files, not the database or configuration, and are not transactional snapshots. External backup integrity has not been verified.\n`,
    'text/markdown'
  )
}
function beforeUnload(event: BeforeUnloadEvent) {
  if ((dirty.value && !writeConfirmed) || busy.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}
onBeforeRouteLeave(to => {
  if (leaving) return true
  if (busy.value) return false
  if (dirty.value && !writeConfirmed) {
    pendingNavigation.value = () => {
      leaving = true
      void router.push(to.fullPath)
    }
    discardOpen.value = true
    return false
  }
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
