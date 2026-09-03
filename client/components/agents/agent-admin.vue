<template>
  <section class="agent-control" aria-labelledby="admin-title">
    <AdminHero
      :title="embedded ? 'Agents' : 'Agent administration'"
      description="Review runtime safeguards, provider access, and browser boundaries for every Agent run."
      icon="mdi-robot-outline"
      eyebrow="Operations ledger · AI–01"
      heading-id="admin-title"
    >
      <template #extra>
        <dl class="agent-hero__facts" aria-label="Current administration summary">
          <div>
            <dt>Runtime</dt>
            <dd>{{ dataLoaded ? runtime?.enabled ? 'Active' : 'Paused' : error ? 'Unavailable' : 'Loading' }}</dd>
          </div>
          <div>
            <dt>Inference routes</dt>
            <dd>{{ dataLoaded ? `${enabledProviderCount}/${profiles.length} enabled` : '—' }}</dd>
          </div>
          <div>
            <dt>Network targets</dt>
            <dd>{{ dataLoaded ? `${enabledBrowserCount} allowed` : '—' }}</dd>
          </div>
        </dl>
      </template>
      <template #status>
        <div class="agent-hero__status" aria-label="Control center status" role="status" aria-live="polite">
          <v-chip
            size="small"
            variant="tonal"
            :color="loadFailed ? 'error' : !dataLoaded ? undefined : runtime?.enabled ? 'success' : 'warning'"
            :prepend-icon="loadFailed ? 'mdi-alert-circle-outline' : !dataLoaded ? 'mdi-progress-clock' : runtime?.enabled ? 'mdi-check-circle-outline' : 'mdi-pause-circle-outline'"
          >
            {{ loadFailed ? dataLoaded ? 'Refresh failed · showing last loaded status' : 'Deployment state unavailable' : !dataLoaded ? 'Reading deployment state' : runtime?.enabled ? 'Agent runtime active' : 'Agent runtime paused' }}
          </v-chip>
          <v-chip size="small" variant="outlined" prepend-icon="mdi-shield-check-outline">Policy governed</v-chip>
          <span class="agent-hero__live"><span aria-hidden="true" />Deployment view</span>
        </div>
      </template>
      <template #actions>
        <v-btn class="agent-hero__refresh" variant="tonal" color="primary" prepend-icon="mdi-refresh" :loading="loading" :disabled="loading || Boolean(actionBusyKey)" @click="load">Refresh status</v-btn>
      </template>
    </AdminHero>

    <v-alert v-if="error" class="agent-global-error" type="error" variant="tonal" closable role="alert" @click:close="error = ''">
      <strong>Control center could not complete the request.</strong>
      <span>{{ error }}</span>
      <template #append><v-btn variant="text" size="small" @click="load">Retry</v-btn></template>
    </v-alert>
    <v-alert v-if="actionBusyKey" class="agent-operation-status" type="info" variant="tonal" density="compact" role="status" aria-live="polite">
      <template #prepend><v-progress-circular indeterminate :size="18" :width="2" /></template>
      {{ actionBusyMessage }}
    </v-alert>


    <section v-if="dataLoaded" class="agent-snapshot" aria-label="Agent platform status">
      <article class="agent-snapshot__item">
        <span class="agent-snapshot__index" aria-hidden="true">01</span>
        <span class="agent-snapshot__icon"><v-icon size="21">mdi-server-network-outline</v-icon></span>
        <span><small>Runtime policy</small><strong>{{ enabledCapabilityCount }} of {{ capabilityRows.length }} capabilities</strong></span>
      </article>
      <article class="agent-snapshot__item">
        <span class="agent-snapshot__index" aria-hidden="true">02</span>
        <span class="agent-snapshot__icon"><v-icon size="21">mdi-brain</v-icon></span>
        <span><small>Provider profiles</small><strong>{{ enabledProviderCount }} enabled · {{ profiles.length }} total</strong></span>
      </article>
      <article class="agent-snapshot__item">
        <span class="agent-snapshot__index" aria-hidden="true">03</span>
        <span class="agent-snapshot__icon"><v-icon size="21">mdi-web-check</v-icon></span>
        <span><small>Browser boundary</small><strong>{{ enabledBrowserCount }} approved target{{ enabledBrowserCount === 1 ? '' : 's' }}</strong></span>
      </article>
      <article class="agent-snapshot__item">
        <span class="agent-snapshot__index" aria-hidden="true">04</span>
        <span class="agent-snapshot__icon"><v-icon size="21">mdi-archive-clock-outline</v-icon></span>
        <span><small>Audit retention</small><strong>{{ runtime?.retention.auditDays }} days</strong></span>
      </article>
    </section>
    <section v-else-if="loading" class="agent-snapshot agent-snapshot--loading" aria-label="Loading agent platform status" aria-busy="true">
      <v-skeleton-loader v-for="index in 4" :key="index" type="list-item-avatar-two-line" />
    </section>

    <div class="agent-workspace">
      <nav class="agent-sections" aria-label="Agent administration sections" role="tablist" :aria-orientation="width > 960 ? 'vertical' : 'horizontal'">
        <div class="agent-sections__label"><span>Control index</span><small>4 sections</small></div>
        <button
          v-for="(section, index) in sectionItems"
          :id="`agent-tab-${section.value}`"
          :key="section.value"
          type="button"
          role="tab"
          class="agent-section"
          :class="{ 'agent-section--active': tab === section.value }"
          :tabindex="tab === section.value ? 0 : -1"
          :aria-selected="tab === section.value"
          :aria-controls="`agent-panel-${section.value}`"
          @click="tab = section.value"
          @keydown.left="selectHorizontalSection(index, -1, $event)"
          @keydown.right="selectHorizontalSection(index, 1, $event)"
          @keydown.up="selectVerticalSection(index, -1, $event)"
          @keydown.down="selectVerticalSection(index, 1, $event)"
          @keydown.home.prevent="selectSection(0, $event)"
          @keydown.end.prevent="selectSection(sectionItems.length - 1, $event)"
        >
          <span class="agent-section__ordinal" aria-hidden="true">0{{ index + 1 }}</span>
          <span class="agent-section__icon"><v-icon size="20">{{ section.icon }}</v-icon></span>
          <span class="agent-section__copy"><strong>{{ section.title }}</strong><small>{{ section.description }}</small></span>
          <v-chip v-if="section.badge" class="agent-section__badge" size="x-small" variant="tonal">{{ section.badge }}</v-chip>
          <v-icon class="agent-section__arrow" size="18">mdi-chevron-right</v-icon>
        </button>
        <div class="agent-sections__note">
          <v-icon size="18">mdi-shield-lock-outline</v-icon>
          <span><strong>Governed control plane</strong>Changes respect deployment kill switches, user permissions, and retained audit evidence.</span>
        </div>
      </nav>

      <v-window v-model="tab" class="agent-content">
        <v-window-item id="agent-panel-runtime" value="runtime" role="tabpanel" aria-labelledby="agent-tab-runtime">
          <section class="agent-panel">
            <div class="agent-panel__header">
              <div class="agent-panel__heading">
                <span class="agent-panel__icon"><v-icon size="22">mdi-tune-variant</v-icon></span>
                <div>
                  <div class="agent-panel__eyebrow">Operational envelope</div>
                  <h2>Runtime policy</h2>
                  <p>The effective safeguards currently governing every Agent run.</p>
                </div>
              </div>
              <div class="agent-panel__state">
                <span>Deployment controlled</span>
                <v-chip variant="tonal" :color="loading ? undefined : !runtime ? 'error' : runtime.enabled ? 'success' : 'warning'" size="small">{{ loading ? 'Loading' : !runtime ? 'Unavailable' : runtime.enabled ? 'Active' : 'Paused' }}</v-chip>
              </div>
            </div>
            <v-progress-linear v-if="loading" indeterminate aria-label="Loading runtime policy" />
            <div v-else-if="runtime" class="agent-panel__body">
              <v-alert type="info" variant="tonal" density="compact" class="mb-5">Kill switches are deployment configuration. Changes require a controlled config rollout and process restart.</v-alert>
              <section class="runtime-section">
                <div class="section-heading">
                  <div><h3>Capability map</h3><p>One view of what the platform can currently execute.</p></div>
                  <span>{{ enabledCapabilityCount }} enabled</span>
                </div>
                <div class="capability-map">
                  <div v-for="item in capabilityRows" :key="item.label" class="capability-item" :class="{ 'capability-item--enabled': item.enabled }">
                    <span class="capability-item__state"><v-icon size="15">{{ item.enabled ? 'mdi-check' : 'mdi-minus' }}</v-icon></span>
                    <span>{{ item.label }}</span>
                    <small>{{ item.enabled ? 'Available' : 'Blocked' }}</small>
                  </div>
                </div>
              </section>
              <section class="runtime-section">
                <div class="section-heading"><div><h3>Operating limits</h3><p>Capacity, orchestration, continuity, and retention at a glance.</p></div></div>
                <div class="policy-grid">
                  <article class="policy-card">
                    <div class="policy-card__title"><span><v-icon size="19">mdi-gauge</v-icon></span><h4>Capacity</h4></div>
                    <dl><div><dt>Concurrent runs</dt><dd>{{ runtime.quotas.globalConcurrency }} global</dd></div><div><dt>Per-user runs</dt><dd>{{ runtime.quotas.perUserConcurrency }}</dd></div><div><dt>SSE connections</dt><dd>{{ runtime.quotas.maximumSseConnectionsPerUser }} per user</dd></div><div><dt>Reconciliation</dt><dd>{{ runtime.quotas.pollingMilliseconds }} ms</dd></div></dl>
                  </article>
                  <article class="policy-card">
                    <div class="policy-card__title"><span><v-icon size="19">mdi-account-multiple-outline</v-icon></span><h4>Specialist research</h4></div>
                    <dl><div><dt>Concurrent specialists</dt><dd>{{ runtime.orchestration.maxConcurrentChildren }}</dd></div><div><dt>Tasks per response</dt><dd>{{ runtime.orchestration.maxChildren }}</dd></div><div><dt>Specialist deadline</dt><dd>{{ runtime.orchestration.childTimeoutMilliseconds / 1000 }} sec</dd></div><div><dt>Aggregate tokens</dt><dd>{{ runtime.orchestration.maxAggregateChildTokens }}</dd></div></dl>
                  </article>
                  <article class="policy-card">
                    <div class="policy-card__title"><span><v-icon size="19">mdi-target</v-icon></span><h4>Durable goals</h4></div>
                    <dl><div><dt>Continuations</dt><dd>{{ runtime.goals.maxContinuations }}</dd></div><div><dt>Aggregate tokens</dt><dd>{{ runtime.goals.maxTokens }}</dd></div><div><dt>Tool calls</dt><dd>{{ runtime.goals.maxToolCalls }}</dd></div><div><dt>Maximum duration</dt><dd>{{ runtime.goals.maxDurationMilliseconds / 60000 }} min</dd></div></dl>
                  </article>
                  <article class="policy-card">
                    <div class="policy-card__title"><span><v-icon size="19">mdi-archive-clock-outline</v-icon></span><h4>Retention</h4></div>
                    <dl><div><dt>Temporary sessions</dt><dd>{{ runtime.retention.temporarySessionHours }} hr</dd></div><div><dt>MCP proposals</dt><dd>{{ runtime.retention.mcpContentDays }} days</dd></div><div><dt>Audit ledger</dt><dd>{{ runtime.retention.auditDays }} days</dd></div><div><dt>Maintenance batch</dt><dd>{{ runtime.retention.maintenanceBatchSize }}</dd></div></dl>
                  </article>
                </div>
              </section>
              <aside class="metrics-note"><span><v-icon size="20">mdi-chart-timeline-variant-shimmer</v-icon></span><div><strong>Metrics and health remain isolated</strong><p>Run, proposal, artifact, and usage gauges are exported through the metrics endpoint. Provider, browser-worker, and MCP failures do not affect <code>/healthz</code>.</p></div></aside>
            </div>
          </section>
        </v-window-item>

        <v-window-item id="agent-panel-profiles" value="profiles" role="tabpanel" aria-labelledby="agent-tab-profiles">
          <section class="agent-panel">
            <div class="agent-panel__header">
              <div class="agent-panel__heading">
                <span class="agent-panel__icon agent-panel__icon--violet"><v-icon size="22">mdi-brain</v-icon></span>
                <div>
                  <div class="agent-panel__eyebrow">Inference foundation</div>
                  <h2>Provider profiles</h2>
                  <p>Connect models, verify behavior, and decide who can use each profile.</p>
                </div>
              </div>
              <v-btn color="primary" prepend-icon="mdi-plus" :disabled="runtime?.providerEnabled !== true || Boolean(actionBusyKey)" @click="openProfile()">Add provider</v-btn>
            </div>
            <div class="agent-panel__body">
              <v-progress-linear v-if="loading" indeterminate class="mb-4" aria-label="Loading provider profiles" />
              <aside class="provider-policy-strip" aria-label="Provider governance">
                <span><v-icon size="17">mdi-connection</v-icon><strong>Verify</strong>Live capability check on every save</span>
                <span><v-icon size="17">mdi-key-outline</v-icon><strong>Protect</strong>Credentials remain server-managed</span>
                <span><v-icon size="17">mdi-account-lock-outline</v-icon><strong>Scope</strong>Access follows explicit grants</span>
              </aside>
              <v-alert v-if="runtime?.providerEnabled === false" type="info" variant="tonal" class="mb-4">Provider administration is unavailable while provider inference is disabled in deployment configuration. Enable <code>agents.provider.enabled</code>, configure the provider runtime keys, and restart Wiki before adding profiles.</v-alert>
              <v-alert v-if="profiles.some(profile => !profile.secretConfigured)" type="warning" variant="tonal" class="mb-4">A provider credential is unavailable. Edit the profile and enter its API key to verify and enable it.</v-alert>
              <v-alert v-if="profiles.some(profile => profile.status === 'enabled' && profile.conformed && profile.exposureMode === 'all_agent_users') && !profiles.some(profile => profile.isGlobalDefault)" type="warning" variant="tonal" class="mb-4">No global default provider is set. Open an enabled provider's actions menu and choose <strong>Set global default</strong> before starting a conversation.</v-alert>
              <div v-if="profiles.length" class="provider-grid">
                <article v-for="profile in profiles" :key="profile.id" class="provider-card">
                  <div class="provider-card__top">
                    <span class="provider-card__mark"><v-icon size="23">mdi-creation-outline</v-icon></span>
                    <div class="provider-card__identity">
                      <div class="provider-card__name"><h3>{{ profile.displayName }}</h3><v-chip v-if="profile.isGlobalDefault" size="x-small" color="primary" variant="tonal">Default</v-chip></div>
                      <p>{{ agentProviderProtocolOption(profile.transportKind).title }}</p>
                    </div>
                    <v-menu>
                      <template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" icon="mdi-dots-horizontal" variant="text" density="comfortable" :aria-label="`Actions for ${profile.displayName}`" :disabled="Boolean(actionBusyKey)" /></template>
                      <v-list density="comfortable">
                        <v-list-item prepend-icon="mdi-pencil-outline" title="Edit settings" subtitle="Updates this profile" :disabled="Boolean(actionBusyKey)" @click="openProfile(profile)" />
                        <v-list-item prepend-icon="mdi-connection" :title="profile.status === 'disabled' ? 'Test and enable' : 'Test connection'" :subtitle="connectionActionSubtitle(profile)" :disabled="!profile.secretConfigured || Boolean(actionBusyKey)" @click="testConnection(profile)" />
                        <v-list-item prepend-icon="mdi-account-multiple-outline" title="Edit access grants" subtitle="Changes profile visibility" :disabled="Boolean(actionBusyKey)" @click="openGrants(profile)" />
                        <v-list-item v-if="profile.status === 'disabled'" prepend-icon="mdi-play-circle-outline" title="Enable provider" :subtitle="enableProfileSubtitle(profile)" :disabled="!profile.conformed || !profile.secretConfigured || Boolean(actionBusyKey)" @click="confirmEnableProfile(profile)" />
                        <v-list-item v-else prepend-icon="mdi-pause-circle-outline" title="Disable provider" :subtitle="profile.isGlobalDefault ? 'Clears the workspace default and stops new runs' : 'Stops new runs from using it'" :disabled="Boolean(actionBusyKey)" @click="setProfileEnabled(profile, false)" />
                        <v-list-item prepend-icon="mdi-star-outline" title="Set global default" subtitle="Makes this the workspace fallback" :disabled="!profile.conformed || profile.status !== 'enabled' || profile.exposureMode !== 'all_agent_users' || profile.isGlobalDefault || Boolean(actionBusyKey)" @click="setDefault(profile)" />
                        <v-divider class="my-1" />
                        <v-list-item prepend-icon="mdi-delete-outline" title="Remove provider" subtitle="Permanently deletes its credential" base-color="error" :disabled="Boolean(actionBusyKey)" @click="confirmRemove(profile)" />
                      </v-list>
                    </v-menu>
                  </div>
                  <div class="provider-card__status">
                    <span :class="['connection-state', `connection-state--${profile.conformed ? 'success' : profile.connectionCheck?.status === 'failed' ? 'error' : 'neutral'}`]">
                      <v-icon size="15">{{ profile.conformed ? 'mdi-check-circle' : profile.connectionCheck?.status === 'failed' ? 'mdi-alert-circle' : 'mdi-clock-outline' }}</v-icon>
                      {{ profile.conformed ? 'Connection verified' : profile.connectionCheck?.status === 'failed' ? 'Connection failed' : 'Not verified' }}
                    </span>
                    <span :class="['connection-state', profile.status === 'enabled' ? 'connection-state--success' : 'connection-state--neutral']"><span class="connection-state__dot" />{{ profile.status === 'enabled' ? 'Enabled' : 'Disabled' }}</span>
                  </div>
                  <time v-if="profile.connectionCheck" class="provider-card__checked" :datetime="profile.connectionCheck.completedAt">Last checked {{ formatConnectionCheckDate(profile.connectionCheck.completedAt) }}</time>
                  <div class="provider-card__models">
                    <div><span>Agent model</span><code :title="profile.model">{{ profile.model }}</code></div>
                    <div><span>Utility model</span><code :title="profile.utilityModel || profile.model">{{ profile.utilityModel || profile.model }}</code><small v-if="!profile.utilityModel">Shared</small></div>
                  </div>
                  <p v-if="!profile.conformed && profile.connectionCheck?.message" class="provider-card__error">{{ profile.connectionCheck.message }}</p>
                  <div class="provider-card__meta">
                    <div><v-icon size="17">mdi-account-multiple-outline</v-icon><span><small>Available to</small><strong>{{ profile.exposureMode === 'all_agent_users' ? 'Everyone' : groupNames(profile.groupIds) }}</strong></span></div>
                    <div><v-icon size="17">mdi-server-outline</v-icon><span><small>Destination</small><strong>{{ profile.destinationHost }}</strong></span></div>
                  </div>
                  <button type="button" class="provider-card__edit" :disabled="Boolean(actionBusyKey)" @click="openProfile(profile)">Open configuration <v-icon size="17">mdi-arrow-right</v-icon></button>
                </article>
              </div>
              <div v-else-if="dataLoaded" class="agent-empty">
                <span class="agent-empty__icon"><v-icon size="34">mdi-brain</v-icon></span>
                <h3>Connect the first provider</h3>
                <p>Start with the model your team trusts. Wiki verifies the connection and capabilities before making it available.</p>
                <v-btn color="primary" prepend-icon="mdi-plus" :disabled="runtime?.providerEnabled !== true || Boolean(actionBusyKey)" @click="openProfile()">Add provider</v-btn>
              </div>
            </div>
          </section>
        </v-window-item>

        <v-window-item id="agent-panel-skills" value="skills" role="tabpanel" aria-labelledby="agent-tab-skills">
          <SkillAdmin :csrf-token="csrfToken" embedded />
        </v-window-item>

        <v-window-item id="agent-panel-browser" value="browser" role="tabpanel" aria-labelledby="agent-tab-browser">
          <section class="agent-panel">
            <div class="agent-panel__header">
              <div class="agent-panel__heading">
                <span class="agent-panel__icon agent-panel__icon--teal"><v-icon size="22">mdi-web-check</v-icon></span>
                <div>
                  <div class="agent-panel__eyebrow">Network boundary</div>
                  <h2>Browser access</h2>
                  <p>Approve exact HTTPS destinations the isolated browser may reach.</p>
                </div>
              </div>
              <v-btn color="primary" prepend-icon="mdi-plus" :disabled="Boolean(actionBusyKey)" @click="openBrowserDialog">Add target</v-btn>
            </div>
            <div class="agent-panel__body">
              <v-progress-linear v-if="loading" indeterminate class="mb-4" aria-label="Loading browser targets" />
              <v-alert v-if="runtime?.browserEnabled === false" type="info" variant="tonal" density="compact" class="mb-4">The isolated browser is paused by deployment policy. Targets remain editable here and take effect only after the runtime boundary is enabled.</v-alert>
              <aside class="browser-boundary-note">
                <v-icon size="19">mdi-shield-key-outline</v-icon>
                <span><strong>Exact destinations only.</strong> Each HTTPS URL is canonicalized, hashed into policy evidence, and can be paused without removing the record.</span>
              </aside>
              <div v-if="browserTargets.length" class="target-list">
                <article v-for="target in browserTargets" :key="target.id" class="target-row">
                  <span class="target-row__icon"><v-icon size="20">mdi-lock-outline</v-icon></span>
                  <div class="target-row__copy"><strong :title="target.canonicalUrl">{{ target.canonicalUrl }}</strong><small :title="`Policy ${target.policySha256}`">Policy {{ target.policySha256.slice(0, 16) }}…</small></div>
                  <div class="target-row__state"><span>{{ target.enabled ? 'Allowed' : 'Paused' }}</span><v-switch :model-value="target.enabled" color="primary" hide-details inset :loading="actionBusyKey === `browser:${target.id}`" :disabled="Boolean(actionBusyKey)" :aria-label="`${target.enabled ? 'Pause' : 'Allow'} browser target ${target.canonicalUrl}`" @update:model-value="value => setBrowserEnabled(target, Boolean(value))" /></div>
                </article>
              </div>
              <div v-else-if="dataLoaded" class="agent-empty">
                <span class="agent-empty__icon agent-empty__icon--teal"><v-icon size="34">mdi-web-off</v-icon></span>
                <h3>No browser destinations approved</h3>
                <v-btn color="primary" prepend-icon="mdi-plus" :disabled="Boolean(actionBusyKey)" @click="openBrowserDialog">Add target</v-btn>
              </div>
            </div>
          </section>
        </v-window-item>
      </v-window>
    </div>

    <v-dialog :model-value="profileDialog" max-width="76rem" scrollable :fullscreen="smAndDown" :persistent="saving" aria-labelledby="provider-profile-title" @update:model-value="onProfileDialogModelValue">
      <v-card class="profile-editor" :aria-busy="saving">
        <div class="profile-editor__header">
          <span class="profile-editor__mark"><v-icon size="24">mdi-creation-outline</v-icon></span>
          <div class="profile-editor__title">
            <div class="agent-panel__eyebrow">{{ editingProfile ? 'Provider configuration' : 'New inference connection' }}</div>
            <h2 id="provider-profile-title">{{ editingProfile ? `Edit ${editingProfile.displayName}` : 'Add provider profile' }}</h2>
            <p>{{ editingProfile ? 'Update the connection, models, or operating limits. Saving runs a fresh verification.' : 'A guided setup for a secure, verified Agent provider.' }}</p>
          </div>
          <v-spacer />
          <v-chip v-if="saving" class="profile-editor__change" size="small" color="primary" variant="tonal" prepend-icon="mdi-connection">{{ smAndDown ? 'Saving' : 'Saving and verifying' }}</v-chip>
          <v-chip v-else-if="profileDirty" class="profile-editor__change" size="small" color="warning" variant="tonal" prepend-icon="mdi-circle-edit-outline">{{ smAndDown ? 'Unsaved' : 'Unsaved changes' }}</v-chip>
          <v-chip v-else class="profile-editor__change" size="small" variant="outlined" prepend-icon="mdi-check-circle-outline">{{ smAndDown ? 'Saved' : 'No pending changes' }}</v-chip>
          <v-btn icon="mdi-close" variant="text" aria-label="Close provider editor" :disabled="saving" @click="requestProfileClose" />
        </div>
        <v-progress-linear class="profile-editor__progress" color="primary" :model-value="profileProgress" aria-label="Provider setup progress" />
        <div class="profile-editor__workspace">
          <nav class="profile-steps" aria-label="Provider setup sections">
            <button v-for="(step, index) in profileSteps" :key="step.value" type="button" :class="{ 'profile-step--active': profileStep === step.value }" :aria-current="profileStep === step.value ? 'step' : undefined" :disabled="!canNavigateProfileStep(index)" @click="profileStep = step.value">
              <span class="profile-step__index">{{ index + 1 }}</span>
              <span><strong>{{ step.title }}</strong><small>{{ step.description }}</small></span>
              <v-icon size="17">mdi-chevron-right</v-icon>
            </button>
          </nav>
          <v-form id="provider-profile-form" class="profile-editor__form" @submit.prevent="submitProfileStep">
            <v-alert v-if="profileError" type="error" variant="tonal" density="compact" class="mb-5" closable role="alert" @click:close="profileError = ''">{{ profileError }}</v-alert>

            <section v-if="profileStep === 'identity'" class="profile-form-section">
              <div class="profile-form-section__intro"><span><v-icon size="21">mdi-card-account-details-outline</v-icon></span><div><h3>Name the connection</h3><p>Choose the API contract first; Wiki derives the safe behavior from it.</p></div></div>
              <div class="form-grid">
                <v-text-field v-model="profileDraft.displayName" :rules="profileDisplayNameRules" label="Display name" placeholder="Production Agent" maxlength="255" counter="255" required autofocus />
                <div class="protocol-field">
                  <v-select v-model="profileDraft.transportKind" :items="protocolOptions" label="API protocol" required @update:model-value="selectProtocol">
                    <template #item="{ props: itemProps, internalItem }">
                      <v-list-subheader v-if="internalItem.raw.startsGroup">{{ internalItem.raw.group }}</v-list-subheader>
                      <v-list-item v-bind="itemProps" :title="internalItem.raw.title" :subtitle="internalItem.raw.description" />
                    </template>
                  </v-select>
                  <div class="field-note"><v-icon size="16">mdi-information-outline</v-icon><span>{{ selectedProtocol.description }} Requests use <code>{{ selectedProtocol.endpoint }}</code>.</span></div>
                </div>
              </div>
              <aside class="selection-preview"><span class="selection-preview__icon"><v-icon size="22">mdi-api</v-icon></span><div><small>Selected protocol</small><strong>{{ selectedProtocol.title }}</strong><p>{{ selectedProtocol.group }} · {{ selectedProtocol.endpoint }}</p></div></aside>
            </section>

            <section v-else-if="profileStep === 'models'" class="profile-form-section">
              <div class="profile-form-section__intro"><span><v-icon size="21">mdi-brain</v-icon></span><div><h3>Assign model roles</h3><p>Use one capable model for Agent work and, optionally, a faster model for bounded utility tasks.</p></div></div>
              <div class="form-grid">
                <v-text-field v-model="profileDraft.model" :rules="profileModelRules" label="Agent model" :hint="agentModelHint" maxlength="255" persistent-hint required />
                <v-text-field v-model="profileDraft.utilityModel" label="Utility model (optional)" hint="Titles, enrichment, classification, and routing. Leave blank to share the Agent model." maxlength="255" persistent-hint />
              </div>
              <div v-if="reasoningEffortOptions.length > 1" class="subsection-card">
                <div class="subsection-card__heading"><div><h4>Reasoning effort</h4><p>{{ reasoningSupportHint }}</p></div><v-icon size="20">mdi-head-cog-outline</v-icon></div>
                <div class="form-grid">
                  <v-select v-model="profileDraft.agentReasoningEffort" :items="reasoningEffortOptions" label="Agent reasoning" hint="Depth for answers and Wiki actions." persistent-hint />
                  <v-select v-model="profileDraft.utilityReasoningEffort" :items="reasoningEffortOptions" label="Utility reasoning" hint="Independent depth for bounded tasks." persistent-hint />
                </div>
              </div>
              <div class="subsection-card">
                <div class="subsection-card__heading"><div><h4>Tool calling</h4><p>How this model invokes governed Wiki actions.</p></div><v-icon size="20">mdi-tools</v-icon></div>
                <v-select v-model="profileDraft.toolCalling" :items="toolCallingOptions" label="Tool calling" :disabled="profileDraft.transportKind === 'legacy-completions'" hint="Native uses the API contract. Prompt-emulated supports models without native tools and is verified before enablement." persistent-hint @update:model-value="selectToolCalling" />
              </div>
            </section>

            <section v-else-if="profileStep === 'connection'" class="profile-form-section">
              <div class="profile-form-section__intro"><span><v-icon size="21">mdi-connection</v-icon></span><div><h3>Secure the connection</h3><p>Credentials stay server-managed and every save performs a live capability check.</p></div></div>
              <div class="form-grid">
                <v-text-field v-model="profileDraft.baseUrl" :rules="providerBaseUrlRules" label="Base URL" hint="Public HTTPS API root or base path; query strings, fragments, credentials, and local destinations are not allowed." persistent-hint autocomplete="url" spellcheck="false" required />
                <v-select v-if="availableAuthModes.length > 1" v-model="profileDraft.authMode" :items="availableAuthModes" label="Authentication mode" />
                <v-text-field class="secret-field" v-model="profileDraft.secretValue" :rules="profileSecretRules" label="API key" type="password" autocomplete="new-password" :hint="editingProfile && editingProfile.secretConfigured ? 'Leave blank to retain the current encrypted credential, or enter a replacement.' : 'Encrypted with the server-managed provider key and never returned by the API.'" persistent-hint :required="!editingProfile || !editingProfile.secretConfigured" prepend-inner-icon="mdi-key-outline" />
              </div>
              <div class="protocol-behavior">
                <div class="protocol-behavior__heading"><span><v-icon size="19">mdi-shield-check-outline</v-icon></span><div><h4>Protocol-derived behavior</h4><p>Wiki verifies the provider connection automatically after every save. A new profile is enabled only after that check succeeds.</p></div></div>
                <dl class="protocol-summary">
                  <div v-for="row in protocolBehaviorRows" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div>
                </dl>
              </div>
            </section>

            <section v-else-if="profileStep === 'access'" class="profile-form-section">
              <div class="profile-form-section__intro"><span><v-icon size="21">mdi-account-multiple-outline</v-icon></span><div><h3>Choose the audience</h3><p>Make this profile a workspace option or limit it to selected Wiki groups.</p></div></div>
              <div class="access-choice">
                <label v-for="mode in exposureModes" :key="mode.value" :class="{ 'access-choice__item--active': profileDraft.exposureMode === mode.value }">
                  <input v-model="profileDraft.exposureMode" type="radio" :value="mode.value">
                  <span class="access-choice__icon"><v-icon size="23">{{ mode.value === 'all_agent_users' ? 'mdi-account-group-outline' : 'mdi-account-lock-outline' }}</v-icon></span>
                  <span><strong>{{ mode.title }}</strong><small>{{ mode.value === 'all_agent_users' ? 'Every user with Agent permission can select it.' : 'Only members of the groups you choose can access it.' }}</small></span>
                  <v-icon class="access-choice__check" size="20">{{ profileDraft.exposureMode === mode.value ? 'mdi-radiobox-marked' : 'mdi-radiobox-blank' }}</v-icon>
                </label>
              </div>
              <v-autocomplete v-if="profileDraft.exposureMode === 'groups'" v-model="profileDraft.groupIds" class="mt-5" :items="groups" item-title="name" item-value="id" label="Wiki groups" multiple chips closable-chips hint="Users receive this provider through any selected group." persistent-hint />
            </section>

            <section v-else class="profile-form-section">
              <div class="profile-form-section__intro"><span><v-icon size="21">mdi-gauge</v-icon></span><div><h3>Advanced limits and quotas</h3><p>Bound context, output, retries, time, and reservations for this profile.</p></div></div>
              <v-alert type="info" variant="tonal" density="compact" class="mb-5">These safe defaults suit most deployments. Cost values are reservation ceilings enforced against this profile revision's immutable token pricing schedule.</v-alert>
              <div class="limit-group">
                <h4>Model boundaries</h4>
                <div class="form-grid"><v-text-field v-model.number="profileDraft.maxContextTokens" type="number" min="1024" max="10000000" step="1" :rules="profileRules.maxContextTokens" label="Maximum context tokens" /><v-text-field v-model.number="profileDraft.maxOutputTokens" type="number" min="1" max="1000000" step="1" :rules="profileRules.maxOutputTokens" label="Maximum output tokens" /></div>
              </div>
              <div class="limit-group">
                <h4>Daily ceilings</h4>
                <div class="form-grid"><v-text-field v-model.number="profileDraft.dailyTokens" type="number" min="1" max="1000000000" step="1" :rules="profileRules.dailyTokens" label="Daily token limit" /><v-text-field v-model.number="profileDraft.dailyCostMicros" type="number" min="1" step="1" :rules="profileRules.dailyCostMicros" label="Daily cost reservation (micros)" /></div>
              </div>
              <div class="limit-group">
                <h4>Per-run reservations</h4>
                <div class="form-grid"><v-text-field v-model.number="profileDraft.reservationTokens" type="number" min="1" max="10000000" step="1" :rules="profileRules.reservationTokens" label="Token reservation" /><v-text-field v-model.number="profileDraft.reservationCostMicros" type="number" min="1" step="1" :rules="profileRules.reservationCostMicros" label="Cost reservation (micros)" /></div>
              </div>
              <div class="limit-group">
                <h4>Reliability</h4>
                <div class="form-grid"><v-text-field v-model.number="profileDraft.timeoutMs" type="number" min="1000" max="300000" step="1" :rules="profileRules.timeoutMs" label="Request timeout (ms)" /><v-text-field v-model.number="profileDraft.maxAttempts" type="number" min="1" max="10" step="1" :rules="profileRules.maxAttempts" label="Maximum attempts" /></div>
              </div>
            </section>
          </v-form>
        </div>
        <div class="profile-editor__footer">
          <div class="profile-editor__position">
            <strong>{{ currentProfileStep.title }}</strong>
            <span>{{ profileStepIndex + 1 }} of {{ profileSteps.length }} · {{ profileDirty ? 'Changes not yet saved' : 'Draft matches saved state' }}</span>
          </div>
          <div class="profile-editor__save-state" role="status" aria-live="polite">
            <v-icon size="17">{{ saving ? 'mdi-progress-clock' : profileDirty ? 'mdi-circle-edit-outline' : 'mdi-shield-check-outline' }}</v-icon>
            <span>{{ saving ? 'Verifying provider capabilities…' : profileDirty ? 'Ready to review and save' : 'Configuration unchanged' }}</span>
          </div>
          <v-spacer />
          <v-btn variant="text" :disabled="saving" @click="requestProfileClose">Cancel</v-btn>
          <v-btn variant="text" :disabled="saving || !profileDirty" prepend-icon="mdi-restore" @click="resetProfileDraft">Reset</v-btn>
          <v-btn v-if="profileStepIndex > 0" variant="outlined" prepend-icon="mdi-arrow-left" :disabled="saving" @click="previousProfileStep">Back</v-btn>
          <v-btn v-if="profileStepIndex < profileSteps.length - 1" variant="tonal" color="primary" append-icon="mdi-arrow-right" :disabled="saving || !profileStepValid" form="provider-profile-form" type="submit">Continue</v-btn>
          <v-btn v-else color="primary" prepend-icon="mdi-check-decagram-outline" :loading="saving" :disabled="saving || !profileDraftValid || !profileDirty" form="provider-profile-form" type="submit">Save and verify</v-btn>
        </div>
      </v-card>
    </v-dialog>
    <v-dialog v-model="profileDiscardDialog" max-width="32rem" aria-labelledby="provider-discard-title">
      <v-card class="compact-dialog">
        <div class="compact-dialog__header compact-dialog__header--danger"><span><v-icon size="23">mdi-alert-outline</v-icon></span><div><div class="agent-panel__eyebrow">Unsaved configuration</div><h2 id="provider-discard-title">Discard provider changes?</h2><p>Your edits have not been verified or saved.</p></div></div>
        <v-card-text>Keep editing to review the draft, or discard every change made since this editor was opened.</v-card-text>
        <v-card-actions><v-spacer /><v-btn @click="profileDiscardDialog = false">Keep editing</v-btn><v-btn color="error" variant="tonal" @click="discardProfileChanges">Discard changes</v-btn></v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog :model-value="enablingProfile !== null" max-width="34rem" :persistent="Boolean(actionBusyKey)" aria-labelledby="provider-enable-title" @update:model-value="value => { if (!value && !actionBusyKey) enablingProfile = null }">
      <v-card class="compact-dialog" :aria-busy="actionBusyKey.startsWith('enabled:')">
        <div class="compact-dialog__header"><span><v-icon size="23">mdi-play-circle-outline</v-icon></span><div><div class="agent-panel__eyebrow">Enablement review</div><h2 id="provider-enable-title">Enable provider profile?</h2><p>New Agent runs will be able to use this connection.</p></div></div>
        <v-card-text><v-alert v-if="enableError" class="mb-3" type="error" variant="tonal" density="compact" role="alert">{{ enableError }}</v-alert><p><strong>{{ enablingProfile?.displayName }}</strong> has a verified connection and will become available to {{ enablingProfile?.exposureMode === 'all_agent_users' ? 'every Agent user' : groupNames(enablingProfile?.groupIds ?? []) }}.</p><v-alert v-if="enablingProfile && willBecomeDefault(enablingProfile)" type="warning" variant="tonal" density="compact">No global default exists. Enabling this profile will also make it the workspace default for every Agent user.</v-alert></v-card-text>
        <v-card-actions><v-spacer /><v-btn :disabled="Boolean(actionBusyKey)" @click="enablingProfile = null">Cancel</v-btn><v-btn color="primary" prepend-icon="mdi-play-circle-outline" :loading="actionBusyKey.startsWith('enabled:')" :disabled="Boolean(actionBusyKey)" @click="enableConfirmedProfile">Enable provider</v-btn></v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog :model-value="browserEnableTarget !== null" max-width="36rem" :persistent="Boolean(actionBusyKey)" aria-labelledby="browser-enable-title" @update:model-value="value => { if (!value && !actionBusyKey) browserEnableTarget = null }">
      <v-card class="compact-dialog" :aria-busy="actionBusyKey.startsWith('browser:')">
        <div class="compact-dialog__header compact-dialog__header--teal"><span><v-icon size="23">mdi-web-check</v-icon></span><div><div class="agent-panel__eyebrow">Network allowlist review</div><h2 id="browser-enable-title">Allow this browser target?</h2><p>The isolated browser will be permitted to request this exact destination.</p></div></div>
        <v-card-text><v-alert v-if="browserEnableError" class="mb-3" type="error" variant="tonal" density="compact" role="alert">{{ browserEnableError }}</v-alert><p class="browser-confirm-url"><code>{{ browserEnableTarget?.canonicalUrl }}</code></p><p class="mb-0">Only this canonical URL is approved. The recorded policy hash remains unchanged.</p></v-card-text>
        <v-card-actions><v-spacer /><v-btn :disabled="Boolean(actionBusyKey)" @click="browserEnableTarget = null">Cancel</v-btn><v-btn color="primary" prepend-icon="mdi-shield-check-outline" :loading="actionBusyKey.startsWith('browser:')" :disabled="Boolean(actionBusyKey)" @click="allowConfirmedBrowserTarget">Allow target</v-btn></v-card-actions>
      </v-card>
    </v-dialog>


    <v-dialog :model-value="removingProfile !== null" max-width="34rem" :persistent="actionBusyKey === 'remove'" aria-labelledby="provider-remove-title" @update:model-value="value => { if (!value) removingProfile = null }">
      <v-card class="compact-dialog" :aria-busy="actionBusyKey === 'remove'">
        <div class="compact-dialog__header compact-dialog__header--danger"><span><v-icon size="23">mdi-delete-outline</v-icon></span><div><div class="agent-panel__eyebrow">Destructive operation</div><h2 id="provider-remove-title">Remove provider profile?</h2><p>This cannot be undone.</p></div></div>
        <v-card-text><v-alert v-if="removeError" class="mb-3" type="error" variant="tonal" density="compact" role="alert">{{ removeError }}</v-alert><p><strong>{{ removingProfile?.displayName }}</strong> will no longer be available to sessions or new runs.</p><p class="mb-0">The configuration is removed from use and its server-managed API keys are permanently deleted. Audit records are retained.</p></v-card-text>
        <v-alert v-if="removingProfile?.isGlobalDefault" class="mx-6 mt-4 mb-0" type="warning" variant="tonal" density="compact">This is the global default. Removing it leaves new conversations without a default until another enabled provider is selected.</v-alert>
        <v-card-actions><v-spacer /><v-btn :disabled="Boolean(actionBusyKey)" @click="removingProfile = null">Cancel</v-btn><v-btn color="error" prepend-icon="mdi-delete-forever-outline" :loading="actionBusyKey === 'remove'" :disabled="Boolean(actionBusyKey)" @click="removeProfile">{{ removingProfile?.isGlobalDefault ? 'Remove default provider' : 'Remove provider' }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="grantsDialog" max-width="40rem" scrollable :persistent="actionBusyKey === 'grants'" aria-labelledby="provider-grants-title">
      <v-card class="compact-dialog">
        <div class="compact-dialog__header"><span><v-icon size="23">mdi-account-multiple-outline</v-icon></span><div><h2 id="provider-grants-title">{{ grantProfile ? `Access for ${grantProfile.displayName}` : 'Provider access' }}</h2><p>Control who can discover and use this profile.</p></div></div>
        <v-card-text><v-alert v-if="grantsError" class="mb-3" type="error" variant="tonal" density="compact" role="alert">{{ grantsError }}</v-alert><v-select v-model="grantDraft.exposureMode" :items="exposureModes" label="Available to" /><v-autocomplete v-if="grantDraft.exposureMode === 'groups'" v-model="grantDraft.groupIds" :items="groups" item-title="name" item-value="id" label="Wiki groups" multiple chips closable-chips hint="Users receive this provider through any selected group." persistent-hint /><v-alert class="mt-4" type="info" variant="tonal" density="compact">The global default is available to everyone. Group-assigned profiles augment that default and appear as a session choice only when a user has more than one available profile.</v-alert></v-card-text>
        <v-alert v-if="grantProfile?.isGlobalDefault && grantsDirty" class="mx-6 mt-4 mb-0" type="warning" variant="tonal" density="compact">Saving any access change clears this profile as the global default. Choose another global default before the next Agent conversation.</v-alert>
        <v-card-actions><span class="compact-dialog__audit"><v-icon size="16">mdi-text-box-check-outline</v-icon>Access changes are audited</span><v-spacer /><v-btn :disabled="actionBusyKey === 'grants'" @click="grantsDialog = false">Cancel</v-btn><v-btn color="primary" :loading="actionBusyKey === 'grants'" :disabled="Boolean(actionBusyKey) || !grantsDirty || (grantDraft.exposureMode === 'groups' && grantDraft.groupIds.length === 0)" @click="saveGrants">{{ grantProfile?.isGlobalDefault ? 'Save and clear default' : 'Save access' }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="browserDialog" max-width="40rem" :persistent="actionBusyKey === 'browser-create'" aria-labelledby="browser-create-title">
      <v-card class="compact-dialog" :aria-busy="actionBusyKey === 'browser-create'">
        <div class="compact-dialog__header compact-dialog__header--teal"><span><v-icon size="23">mdi-web-plus</v-icon></span><div><div class="agent-panel__eyebrow">Network policy entry</div><h2 id="browser-create-title">Add browser target</h2><p>Approve one exact canonical HTTPS destination.</p></div></div>
        <v-form id="browser-target-form" @submit.prevent="createBrowserTarget">
          <v-card-text>
            <v-alert v-if="browserError" class="mb-3" type="error" variant="tonal" density="compact" role="alert">{{ browserError }}</v-alert>
            <v-alert class="mb-4" type="warning" variant="tonal" density="compact">Approval is exact: paths and origins are not broadened automatically. Confirm the destination is trusted before enabling it.</v-alert>
            <v-text-field v-model="browserUrl" :rules="browserUrlRules" label="Exact canonical HTTPS URL" placeholder="https://example.com/path" autofocus prepend-inner-icon="mdi-lock-outline" autocomplete="url" spellcheck="false" required />
            <v-checkbox v-model="browserEnabled" label="Enable immediately" hint="Leave off to stage the target in a paused state." persistent-hint />
          </v-card-text>
        </v-form>
        <v-card-actions><span class="compact-dialog__audit"><v-icon size="16">mdi-fingerprint</v-icon>A policy hash will be recorded</span><v-spacer /><v-btn :disabled="actionBusyKey === 'browser-create'" @click="browserDialog = false">Cancel</v-btn><v-btn color="primary" type="submit" form="browser-target-form" :loading="actionBusyKey === 'browser-create'" :disabled="Boolean(actionBusyKey) || !isBrowserUrlValid">{{ browserEnabled ? 'Add and allow target' : 'Add paused target' }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue'
import { useDisplay } from 'vuetify'
import {
  agentProviderReasoningEfforts,
  type AgentProviderTransport,
  type AgentReasoningEffort
} from '../../../shared/agents/contracts.ts'
import {
  AGENT_PROVIDER_PRICING_REVISION,
  AGENT_PROVIDER_PROTOCOL_OPTIONS,
  agentProviderCapabilityRevision,
  agentProviderProtocolDefaults,
  agentProviderProtocolExecutionModes,
  agentProviderProtocolOption,
  isAgentProviderTransport,
  type AgentProviderAuthMode,
  type AgentProviderStructuredOutput,
  type AgentProviderToolCalling,
  type AgentProviderUsageMode
} from '../../helpers/agent-provider-protocols.ts'
import { sameOriginJsonFetch } from '../../helpers/json-transport.ts'
import SkillAdmin from './skill-admin.vue'

interface RuntimePolicy {
  enabled: boolean
  providerEnabled: boolean
  orchestrationEnabled: boolean
  goalsEnabled: boolean
  skillsEnabled: boolean
  browserEnabled: boolean
  proposalsEnabled: boolean
  writes: { enabled: boolean; create: boolean; patch: boolean; move: boolean; restore: boolean; delete: boolean }
  mcpEnabled: boolean
  quotas: { globalConcurrency: number; perUserConcurrency: number; pollingMilliseconds: number; maximumSseConnectionsPerUser: number }
  orchestration: {
    enabled: boolean
    maxConcurrentChildren: number
    maxChildren: number
    plannerTurns: number
    childTurns: number
    childToolCalls: number
    plannerTimeoutMilliseconds: number
    childTimeoutMilliseconds: number
    plannerMaxOutputTokens: number
    childMaxOutputTokens: number
    maxAggregateChildTokens: number
    maxAggregateChildOutputCharacters: number
  }
  goals: {
    enabled: boolean
    maxContinuations: number
    maxTokens: number
    maxToolCalls: number
    maxDurationMilliseconds: number
  }
  retention: { temporarySessionHours: number; mcpContentDays: number; auditDays: number; maintenanceBatchSize: number }
}
interface ConnectionCheck { status: 'passed' | 'failed'; errorCode: string | null; message: string | null; completedAt: string }
interface Profile { id: string; displayName: string; status: 'enabled' | 'disabled'; isGlobalDefault: boolean; exposureMode: 'all_agent_users' | 'groups'; groupIds: number[]; conformed: boolean; connectionCheck: ConnectionCheck | null; transportKind: AgentProviderTransport; model: string; utilityModel: string | null; baseUrl: string; destinationHost: string; authMode: AgentProviderAuthMode; secretConfigured: boolean; adapterConfig: { timeoutMs: number; maxRetries: number; additionalHeaders: Record<string, string>; agentReasoningEffort?: AgentReasoningEffort; utilityReasoningEffort?: AgentReasoningEffort }; capabilities: { streaming: boolean; toolCalling: AgentProviderToolCalling; parallelToolCalls: boolean; structuredOutput: AgentProviderStructuredOutput; usage: AgentProviderUsageMode; cancellation: boolean; maxContextTokens: number; maxOutputTokens: number }; policies: { allowedModes: string[]; dailyTokens: number; dailyCostMicros: number; reservationTokens: number; reservationCostMicros: number; reservationMilliseconds: number; promptVersion: number; maxAttempts: number } }
interface BrowserTarget { id: string; canonicalUrl: string; enabled: boolean; policySha256: string }
interface GroupOption { id: number; name: string; isSystem: boolean }
interface ProfileDraft { displayName: string; transportKind: AgentProviderTransport; model: string; utilityModel: string; agentReasoningEffort: AgentReasoningEffort | null; utilityReasoningEffort: AgentReasoningEffort | null; baseUrl: string; authMode: AgentProviderAuthMode; secretValue: string; exposureMode: 'all_agent_users' | 'groups'; groupIds: number[]; maxContextTokens: number; maxOutputTokens: number; dailyTokens: number; dailyCostMicros: number; reservationTokens: number; reservationCostMicros: number; reservationMilliseconds: number; timeoutMs: number; maxRetries: number; maxAttempts: number; promptVersion: number; additionalHeaders: Record<string, string>; structuredOutput: AgentProviderStructuredOutput; usage: AgentProviderUsageMode; streaming: boolean; toolCalling: AgentProviderToolCalling; parallelToolCalls: boolean; cancellation: boolean }

const { csrfToken, embedded = false } = defineProps<{ csrfToken: string; embedded?: boolean }>()
const { smAndDown, width } = useDisplay()
const tab = ref('runtime')
type ProfileStep = 'identity' | 'models' | 'connection' | 'access' | 'limits'
const profileStep = ref<ProfileStep>('identity')
const loading = ref(false)
const loadFailed = ref(false)
const dataLoaded = ref(false)
const saving = ref(false)
const actionBusyKey = ref('')
const error = ref('')
const profileError = ref('')
const grantsError = ref('')
const browserError = ref('')
const removeError = ref('')
const enableError = ref('')
const browserEnableError = ref('')
const runtime = shallowRef<RuntimePolicy | null>(null)
const profiles = shallowRef<Profile[]>([])
const groups = shallowRef<GroupOption[]>([])
const browserTargets = shallowRef<BrowserTarget[]>([])
const profileDialog = ref(false)
const grantsDialog = ref(false)
const browserDialog = ref(false)
const profileDiscardDialog = ref(false)
const editingProfile = shallowRef<Profile | null>(null)
const removingProfile = shallowRef<Profile | null>(null)
const grantProfile = shallowRef<Profile | null>(null)
const enablingProfile = shallowRef<Profile | null>(null)
const browserEnableTarget = shallowRef<BrowserTarget | null>(null)
const browserUrl = ref('')
const browserEnabled = ref(false)
const grantDraft = reactive({ exposureMode: 'all_agent_users' as 'all_agent_users' | 'groups', groupIds: [] as number[] })
let loadController: AbortController | null = null
let loadGeneration = 0
let disposed = false
const sameIdSet = (left: readonly number[], right: readonly number[]): boolean => {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort((a, b) => a - b)
  const sortedRight = [...right].sort((a, b) => a - b)
  return sortedLeft.every((id, index) => id === sortedRight[index])
}
const grantsDirty = computed(() => Boolean(grantProfile.value) && (grantDraft.exposureMode !== grantProfile.value?.exposureMode || !sameIdSet(grantDraft.groupIds, grantProfile.value?.groupIds ?? [])))
const protocolOptions = AGENT_PROVIDER_PROTOCOL_OPTIONS.filter(option => agentProviderProtocolExecutionModes(option.value).includes('agent'))
const exposureModes = [{ title: 'Everyone', value: 'all_agent_users' }, { title: 'Selected Wiki groups', value: 'groups' }]
const toolCallingOptions = [
  { title: 'Native API tools', value: 'native' as const },
  { title: 'Prompt-emulated tools', value: 'prompt' as const }
]
const connectionDateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const formatConnectionCheckDate = (completedAt: string): string => {
  const completed = new Date(completedAt)
  return Number.isNaN(completed.getTime()) ? 'at an unknown time' : connectionDateFormatter.format(completed)
}
const defaults = (): ProfileDraft => ({ displayName: '', transportKind: 'openai-responses', model: '', utilityModel: '', agentReasoningEffort: null, utilityReasoningEffort: null, ...agentProviderProtocolDefaults('openai-responses'), secretValue: '', exposureMode: 'all_agent_users', groupIds: [], maxContextTokens: 128000, maxOutputTokens: 8192, dailyTokens: 1000000, dailyCostMicros: 10000000, reservationTokens: 32000, reservationCostMicros: 1000000, reservationMilliseconds: 300000, timeoutMs: 120000, maxRetries: 0, maxAttempts: 3, promptVersion: 1, additionalHeaders: {} })
const profileDraft = reactive<ProfileDraft>(defaults())
const profileDraftFingerprint = (): string => JSON.stringify(profileDraft)
const profileBaseline = ref(profileDraftFingerprint())
const profileDirty = computed(() => profileDialog.value && profileDraftFingerprint() !== profileBaseline.value)
const availableAuthModes = computed<AgentProviderAuthMode[]>(() => profileDraft.transportKind === 'legacy-completions' ? ['bearer', 'api-key-header'] : [agentProviderProtocolDefaults(profileDraft.transportKind).authMode])

const selectedProtocol = computed(() => agentProviderProtocolOption(profileDraft.transportKind))
const agentModelHint = computed(() => profileDraft.transportKind === 'gemini-api'
  ? 'Gemini 3.x model ID, for example gemini-3.7-flash.'
  : 'Primary model for conversational answers and Wiki actions.')
const reasoningEffortTitles: Readonly<Record<AgentReasoningEffort, string>> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Maximum'
}
const reasoningEffortOptions = computed(() => [
  { title: 'Provider / model default', value: null },
  ...agentProviderReasoningEfforts(profileDraft.transportKind).map(value => ({ title: reasoningEffortTitles[value], value }))
])
const reasoningSupportHint = computed(() => ({
  'openai-responses': 'Sent as Responses API reasoning.effort. Available values vary by reasoning model.',
  openresponses: 'Sent as OpenResponses reasoning.effort. The protocol defines reasoning for GPT-5 and o-series models.',
  'openai-chat': 'Sent as Chat Completions reasoning_effort. Available values vary by reasoning model and compatible provider.',
  'legacy-completions': '',
  'anthropic-messages': 'Sent as Messages API output_config.effort. Supported Claude models default to high; xhigh and max availability varies by model.',
  'gemini-api': 'Sent as Gemini Interactions generation_config.thinking_level for Gemini 3.x models.'
})[profileDraft.transportKind])
const protocolBehaviorRows = computed(() => {
  const structuredOutput = {
    'native-json-schema': 'Native JSON Schema',
    'tool-result': 'Tool-result schema',
    'prompt-only': 'Prompt-validated text'
  }[profileDraft.structuredOutput]
  const usage = {
    stream: 'Provider token counts from the response stream',
    terminal: 'Provider token counts from the final response',
    estimated: 'Estimated token counts'
  }[profileDraft.usage]
  const authentication = {
    bearer: 'Bearer token',
    'api-key-header': 'API-key header',
    'anthropic-api-key': 'Anthropic API key',
    'google-api-key': 'Google API key'
  }[profileDraft.authMode]
  return [
    { label: 'Available use', value: 'Wiki Agent with actions governed by the user’s Wiki group permissions' },
    { label: 'Model roles', value: profileDraft.utilityModel.trim() ? `Agent: ${profileDraft.model || 'not set'} · Utility: ${profileDraft.utilityModel}` : 'The Agent model also handles bounded utility work' },
    ...(reasoningEffortOptions.value.length > 1 ? [{
      label: 'Reasoning',
      value: `Agent: ${profileDraft.agentReasoningEffort === null ? 'provider default' : reasoningEffortTitles[profileDraft.agentReasoningEffort]} · Utility: ${profileDraft.utilityReasoningEffort === null ? 'provider default' : reasoningEffortTitles[profileDraft.utilityReasoningEffort]}`
    }] : []),
    { label: 'Tool calls', value: profileDraft.toolCalling === 'prompt' ? 'Prompt-emulated; one action per model turn' : profileDraft.parallelToolCalls ? 'Native API; multiple calls per model turn, executed in order' : 'Native API; one call per model turn' },
    { label: 'Response delivery', value: profileDraft.streaming ? `Streamed; ${profileDraft.cancellation ? 'cancellable' : 'not cancellable'}` : 'One buffered response' },
    { label: 'Structured output', value: structuredOutput },
    { label: 'Usage accounting', value: usage },
    { label: 'Authentication', value: authentication }
  ]
})
const selectProtocol = (value: unknown) => {
  if (!isAgentProviderTransport(value)) return
  profileDraft.transportKind = value
  Object.assign(profileDraft, agentProviderProtocolDefaults(value), { agentReasoningEffort: null, utilityReasoningEffort: null })
}
const selectToolCalling = () => {
  profileDraft.parallelToolCalls = profileDraft.toolCalling === 'native' && agentProviderProtocolDefaults(profileDraft.transportKind).parallelToolCalls
}

const capabilityRows = computed(() => runtime.value ? [
  { label: 'Inline agent', enabled: runtime.value.enabled },
  { label: 'Provider inference', enabled: runtime.value.providerEnabled },
  { label: 'Specialist research', enabled: runtime.value.orchestrationEnabled },
  { label: 'Durable goals', enabled: runtime.value.goalsEnabled },
  { label: 'Approved skills', enabled: runtime.value.skillsEnabled },
  { label: 'Isolated browser', enabled: runtime.value.browserEnabled },
  { label: 'Proposals', enabled: runtime.value.proposalsEnabled },
  { label: 'All writes', enabled: runtime.value.writes.enabled },
  { label: 'Create', enabled: runtime.value.writes.create },
  { label: 'Patch', enabled: runtime.value.writes.patch },
  { label: 'Move', enabled: runtime.value.writes.move },
  { label: 'Restore', enabled: runtime.value.writes.restore },
  { label: 'Delete', enabled: runtime.value.writes.delete },
  { label: 'MCP', enabled: runtime.value.mcpEnabled }
] : [])
const enabledCapabilityCount = computed(() => capabilityRows.value.filter(item => item.enabled).length)
const enabledProviderCount = computed(() => profiles.value.filter(profile => profile.status === 'enabled').length)
const enabledBrowserCount = computed(() => browserTargets.value.filter(target => target.enabled).length)
const actionBusyMessage = computed(() => {
  if (actionBusyKey.value.startsWith('test:')) return 'Testing the provider connection and refreshing its status…'
  if (actionBusyKey.value.startsWith('default:')) return 'Updating the workspace default provider…'
  if (actionBusyKey.value.startsWith('enabled:')) return 'Updating provider availability…'
  if (actionBusyKey.value.startsWith('browser:')) return 'Updating the browser network boundary…'
  if (actionBusyKey.value === 'browser-create') return 'Recording the browser target and policy evidence…'
  if (actionBusyKey.value === 'grants') return 'Saving provider access grants…'
  if (actionBusyKey.value === 'remove') return 'Removing the provider profile and credential…'
  return 'Applying the administration change…'
})
const sectionItems = computed(() => [
  { value: 'runtime', title: 'Runtime', description: 'Policy and safeguards', icon: 'mdi-tune-variant', badge: loadFailed.value ? dataLoaded.value ? 'Stale' : 'Unavailable' : dataLoaded.value ? runtime.value?.enabled ? 'Active' : 'Paused' : loading.value ? 'Loading' : '' },
  { value: 'profiles', title: 'Providers', description: 'Models and access', icon: 'mdi-brain', badge: profiles.value.length ? String(profiles.value.length) : '' },
  { value: 'skills', title: 'Skills', description: 'Approved expertise', icon: 'mdi-book-open-variant-outline', badge: '' },
  { value: 'browser', title: 'Browser access', description: 'Network boundaries', icon: 'mdi-web-check', badge: browserTargets.value.length ? String(browserTargets.value.length) : '' }
])
const selectSection = (requestedIndex: number, event: KeyboardEvent): void => {
  const sections = sectionItems.value
  if (!sections.length) return
  const index = (requestedIndex + sections.length) % sections.length
  tab.value = sections[index].value
  const navigation = (event.currentTarget as HTMLElement | null)?.closest('.agent-sections')
  queueMicrotask(() => navigation?.querySelectorAll<HTMLButtonElement>('.agent-section')[index]?.focus())
}
const selectHorizontalSection = (currentIndex: number, direction: -1 | 1, event: KeyboardEvent): void => {
  if (width.value > 960) return
  event.preventDefault()
  const target = event.currentTarget as HTMLElement | null
  const rtlMultiplier = target && getComputedStyle(target).direction === 'rtl' ? -1 : 1
  selectSection(currentIndex + direction * rtlMultiplier, event)
}
const selectVerticalSection = (currentIndex: number, direction: -1 | 1, event: KeyboardEvent): void => {
  if (width.value <= 960) return
  event.preventDefault()
  selectSection(currentIndex + direction, event)
}
const profileSteps = computed<Array<{ value: ProfileStep; title: string; description: string }>>(() => [
  { value: 'identity', title: 'Setup', description: 'Name and protocol' },
  { value: 'models', title: 'Models', description: 'Roles and reasoning' },
  { value: 'connection', title: 'Connection', description: 'Endpoint and key' },
  ...(!editingProfile.value ? [{ value: 'access' as const, title: 'Access', description: 'Audience and groups' }] : []),
  { value: 'limits', title: 'Limits', description: 'Quotas and reliability' }
])
const profileStepIndex = computed(() => Math.max(0, profileSteps.value.findIndex(step => step.value === profileStep.value)))
const currentProfileStep = computed(() => profileSteps.value[profileStepIndex.value] ?? profileSteps.value[0])
const profileProgress = computed(() => ((profileStepIndex.value + 1) / profileSteps.value.length) * 100)
const integerInRange = (value: number, minimum: number, maximum: number): boolean => Number.isSafeInteger(value) && value >= minimum && value <= maximum
const integerRule = (label: string, minimum: number, maximum: number) => (value: number): true | string => integerInRange(value, minimum, maximum) || `${label} must be a whole number from ${minimum.toLocaleString()} to ${maximum.toLocaleString()}.`
const requiredTextRule = (label: string) => (value: unknown): true | string =>
  (typeof value === 'string' && Boolean(value.trim())) || `${label} is required.`
const profileDisplayNameRules = [requiredTextRule('Display name')]
const profileModelRules = [requiredTextRule('Agent model')]
const profileSecretRules = computed(() =>
  editingProfile.value?.secretConfigured ? [] : [requiredTextRule('API key')]
)
const profileRules = {
  maxContextTokens: [integerRule('Maximum context tokens', 1024, 10_000_000)],
  maxOutputTokens: [integerRule('Maximum output tokens', 1, 1_000_000)],
  dailyTokens: [integerRule('Daily token limit', 1, 1_000_000_000)],
  dailyCostMicros: [integerRule('Daily cost reservation', 1, Number.MAX_SAFE_INTEGER)],
  reservationTokens: [integerRule('Token reservation', 1, 10_000_000)],
  reservationCostMicros: [integerRule('Cost reservation', 1, Number.MAX_SAFE_INTEGER)],
  timeoutMs: [integerRule('Request timeout', 1_000, 300_000)],
  maxAttempts: [integerRule('Maximum attempts', 1, 10)]
}
const providerBaseUrlError = computed(() => {
  const input = profileDraft.baseUrl.trim()
  if (!input) return 'Enter a provider base URL.'
  try {
    const url = new URL(input)
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    const octets = hostname.split('.').map(value => Number(value))
    const privateIpv4 = octets.length === 4 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255) && (octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168) || octets[0] >= 224)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || privateIpv4 || hostname === '::' || hostname === '::1' || /^(?:fc|fd|fe[89ab])/i.test(hostname)) return 'Use a public HTTPS origin or base path without credentials, a query string, or a fragment.'
    return ''
  } catch {
    return 'Enter a valid absolute HTTPS URL.'
  }
})
const providerBaseUrlRule = (): true | string => providerBaseUrlError.value || true
const providerBaseUrlRules = [providerBaseUrlRule]
const profileStepIsValid = (step: ProfileStep): boolean => {
  if (step === 'identity') return Boolean(profileDraft.displayName.trim() && profileDraft.transportKind)
  if (step === 'models') return Boolean(profileDraft.model.trim())
  if (step === 'connection') return !providerBaseUrlError.value && Boolean(editingProfile.value?.secretConfigured || profileDraft.secretValue.trim())
  if (step === 'access') return profileDraft.exposureMode !== 'groups' || profileDraft.groupIds.length > 0
  return integerInRange(profileDraft.maxContextTokens, 1024, 10_000_000) &&
    integerInRange(profileDraft.maxOutputTokens, 1, 1_000_000) &&
    integerInRange(profileDraft.dailyTokens, 1, 1_000_000_000) &&
    integerInRange(profileDraft.dailyCostMicros, 1, Number.MAX_SAFE_INTEGER) &&
    integerInRange(profileDraft.reservationTokens, 1, 10_000_000) &&
    integerInRange(profileDraft.reservationCostMicros, 1, Number.MAX_SAFE_INTEGER) &&
    integerInRange(profileDraft.timeoutMs, 1_000, 300_000) &&
    integerInRange(profileDraft.maxAttempts, 1, 10)
}
const profileStepValid = computed(() => profileStepIsValid(profileStep.value))
const profileDraftValid = computed(() => profileSteps.value.every(step => profileStepIsValid(step.value)))
const maxProfileStepIndex = ref(0)
const canNavigateProfileStep = (index: number): boolean => index <= maxProfileStepIndex.value
const previousProfileStep = () => {
  const previous = profileSteps.value[profileStepIndex.value - 1]
  if (previous) profileStep.value = previous.value
}
const nextProfileStep = () => {
  if (!profileStepValid.value) { profileError.value = 'Complete the required fields in this step before continuing.'; return }
  const next = profileSteps.value[profileStepIndex.value + 1]
  if (next) {
    profileError.value = ''
    maxProfileStepIndex.value = Math.max(maxProfileStepIndex.value, profileStepIndex.value + 1)
    profileStep.value = next.value
  }
}
const resetProfileDraft = (): void => {
  if (saving.value || !profileBaseline.value) return
  Object.assign(profileDraft, JSON.parse(profileBaseline.value) as ProfileDraft)
  profileStep.value = 'identity'
  maxProfileStepIndex.value = 0
  profileError.value = ''
}
const requestProfileClose = (): void => {
  if (saving.value) return
  if (profileDirty.value) {
    profileDiscardDialog.value = true
    return
  }
  profileDialog.value = false
}
const onProfileDialogModelValue = (value: boolean): void => {
  if (!value) requestProfileClose()
}
const discardProfileChanges = (): void => {
  profileDiscardDialog.value = false
  profileDialog.value = false
}

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await sameOriginJsonFetch(window.fetch.bind(window), path, { credentials: 'same-origin', ...init, headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.method && init.method !== 'GET' ? { 'x-wiki-csrf': csrfToken } : {}), ...init.headers } })
  if (!response.ok) { const body = await response.json().catch(() => ({})) as { message?: string; error?: string }; throw new Error(body.message ?? body.error ?? `Request failed (${response.status})`) }
  return response.status === 204 ? undefined as T : await response.json() as T
}
const run = async (operation: () => Promise<void>, busyKey = 'global', onError: (message: string) => void = message => { error.value = message }) => {
  if (actionBusyKey.value) return
  saving.value = true
  actionBusyKey.value = busyKey
  error.value = ''
  try { await operation() } catch (value) { onError(value instanceof Error ? value.message : 'Agent administration request failed.') } finally { saving.value = false; actionBusyKey.value = '' }
}
const load = async (): Promise<void> => {
  if (disposed) return
  loadController?.abort()
  const controller = new AbortController()
  loadController = controller
  const generation = ++loadGeneration
  loading.value = true
  loadFailed.value = false
  error.value = ''
  try {
    const [runtimeResult, profileResult, browserResult, groupResult] = await Promise.all([
      request<{ runtime: RuntimePolicy }>('/_api/agents/admin/runtime', { signal: controller.signal }),
      request<{ profiles: Profile[] }>('/_api/agents/admin/profiles', { signal: controller.signal }),
      request<{ targets: BrowserTarget[] }>('/_api/agents/admin/browser-targets', { signal: controller.signal }),
      request<GroupOption[]>('/_api/groups', { signal: controller.signal })
    ])
    if (generation !== loadGeneration) return
    runtime.value = runtimeResult.runtime
    profiles.value = profileResult.profiles
    browserTargets.value = browserResult.targets
    groups.value = groupResult
    dataLoaded.value = true
  } catch (value) {
    if (generation !== loadGeneration || controller.signal.aborted) return
    loadFailed.value = true
    error.value = value instanceof Error ? value.message : 'Agent administration could not be loaded.'
  } finally {
    if (generation === loadGeneration) {
      loading.value = false
      if (loadController === controller) loadController = null
    }
  }
}
const openProfile = (profile?: Profile) => {
  profileError.value = ''
  maxProfileStepIndex.value = 0
  editingProfile.value = profile ?? null
  profileStep.value = 'identity'
  Object.assign(profileDraft, defaults(), profile ? {
    ...agentProviderProtocolDefaults(profile.transportKind),
    displayName: profile.displayName,
    transportKind: profile.transportKind,
    model: profile.model,
    utilityModel: profile.utilityModel ?? '',
    agentReasoningEffort: profile.adapterConfig.agentReasoningEffort ?? null,
    utilityReasoningEffort: profile.adapterConfig.utilityReasoningEffort ?? null,
    baseUrl: profile.baseUrl,
    authMode: profile.authMode,
    maxContextTokens: profile.capabilities.maxContextTokens,
    maxOutputTokens: profile.capabilities.maxOutputTokens,
    structuredOutput: profile.capabilities.structuredOutput,
    usage: profile.capabilities.usage,
    streaming: profile.capabilities.streaming,
    toolCalling: profile.capabilities.toolCalling,
    parallelToolCalls: profile.capabilities.parallelToolCalls,
    cancellation: profile.capabilities.cancellation,
    dailyTokens: profile.policies.dailyTokens,
    dailyCostMicros: profile.policies.dailyCostMicros,
    reservationTokens: profile.policies.reservationTokens,
    reservationCostMicros: profile.policies.reservationCostMicros,
    reservationMilliseconds: profile.policies.reservationMilliseconds,
    timeoutMs: profile.adapterConfig.timeoutMs,
    maxRetries: profile.adapterConfig.maxRetries,
    maxAttempts: profile.policies.maxAttempts,
    promptVersion: profile.policies.promptVersion,
    additionalHeaders: profile.adapterConfig.additionalHeaders
  } : {})
  profileBaseline.value = profileDraftFingerprint()
  profileDialog.value = true
}
const profilePayload = () => ({ transportKind: profileDraft.transportKind, model: profileDraft.model, utilityModel: profileDraft.utilityModel.trim() || null, baseUrl: profileDraft.baseUrl, authMode: profileDraft.authMode, secretReference: null, ...(profileDraft.secretValue ? { secretValue: profileDraft.secretValue } : {}), adapterConfig: { timeoutMs: profileDraft.timeoutMs, maxRetries: profileDraft.maxRetries, additionalHeaders: profileDraft.additionalHeaders, ...(profileDraft.agentReasoningEffort === null ? {} : { agentReasoningEffort: profileDraft.agentReasoningEffort }), ...(profileDraft.utilityReasoningEffort === null ? {} : { utilityReasoningEffort: profileDraft.utilityReasoningEffort }) }, capabilities: { streaming: profileDraft.streaming, toolCalling: profileDraft.toolCalling, parallelToolCalls: profileDraft.parallelToolCalls, structuredOutput: profileDraft.structuredOutput, usage: profileDraft.usage, cancellation: profileDraft.cancellation, maxContextTokens: profileDraft.maxContextTokens, maxOutputTokens: profileDraft.maxOutputTokens }, capabilityRevision: agentProviderCapabilityRevision(profileDraft.transportKind), policies: { allowedModes: ['agent'], dailyTokens: profileDraft.dailyTokens, dailyCostMicros: profileDraft.dailyCostMicros, reservationTokens: profileDraft.reservationTokens, reservationCostMicros: profileDraft.reservationCostMicros, reservationMilliseconds: profileDraft.reservationMilliseconds, promptVersion: profileDraft.promptVersion, maxAttempts: profileDraft.maxAttempts }, pricingRevision: AGENT_PROVIDER_PRICING_REVISION })
const saveProfile = async (): Promise<void> => {
  if (saving.value || !profileDirty.value) return
  if (!profileDraftValid.value) {
    const invalidStep = profileSteps.value.find(step => !profileStepIsValid(step.value))
    if (invalidStep) profileStep.value = invalidStep.value
    profileError.value = 'Review the highlighted provider settings before saving.'
    return
  }
  saving.value = true
  profileError.value = ''
  try {
    const payload = profilePayload()
    const result = editingProfile.value
      ? await request<{ profile: Profile; connectionCheck: ConnectionCheck }>(`/_api/agents/admin/profiles/${encodeURIComponent(editingProfile.value.id)}`, { method: 'PUT', body: JSON.stringify({ ...payload, displayName: profileDraft.displayName }) })
      : await request<{ profile: Profile; connectionCheck: ConnectionCheck }>('/_api/agents/admin/profiles', { method: 'POST', body: JSON.stringify({ ...payload, displayName: profileDraft.displayName, exposureMode: profileDraft.exposureMode, ...(profileDraft.exposureMode === 'groups' ? { groupIds: profileDraft.groupIds } : {}) }) })
    profileDialog.value = false
    await load()
    if (result.connectionCheck.status === 'failed') error.value = `Profile saved, but its connection check failed: ${result.connectionCheck.message ?? result.connectionCheck.errorCode ?? 'Unknown provider error'}`
  } catch (value) {
    profileError.value = value instanceof Error ? value.message : 'Provider profile could not be saved.'
  } finally {
    saving.value = false
  }
}
const submitProfileStep = (): void => {
  if (profileStepIndex.value < profileSteps.value.length - 1) {
    nextProfileStep()
    return
  }
  void saveProfile()
}
const confirmRemove = (profile: Profile) => { removeError.value = ''; removingProfile.value = profile }
const removeProfile = () => run(async () => { if (!removingProfile.value) return; await request(`/_api/agents/admin/profiles/${encodeURIComponent(removingProfile.value.id)}`, { method: 'DELETE' }); removingProfile.value = null; await load() }, 'remove', message => { removeError.value = message })
const willBecomeDefault = (profile: Profile): boolean => profile.exposureMode === 'all_agent_users' && !profiles.value.some(candidate => candidate.isGlobalDefault)
const enableProfileSubtitle = (profile: Profile): string => willBecomeDefault(profile) ? 'Also becomes the workspace default' : profile.exposureMode === 'all_agent_users' ? 'Makes it available to every Agent user' : 'Makes it available to its granted groups'
const connectionActionSubtitle = (profile: Profile): string => profile.status === 'disabled' ? willBecomeDefault(profile) ? 'A successful check enables it and sets the workspace default' : 'A successful check enables this profile' : 'Runs a live capability check'
const confirmEnableProfile = (profile: Profile): void => { enableError.value = ''; enablingProfile.value = profile }
const enableConfirmedProfile = (): void => {
  const profile = enablingProfile.value
  if (!profile) return
  void run(async () => { await request(`/_api/agents/admin/profiles/${encodeURIComponent(profile.id)}/enabled`, { method: 'POST', body: JSON.stringify({ enabled: true }) }); await load(); enablingProfile.value = null }, `enabled:${profile.id}`, message => { enableError.value = message })
}
const setProfileEnabled = (profile: Profile, enabled: boolean) => run(async () => { await request(`/_api/agents/admin/profiles/${encodeURIComponent(profile.id)}/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }); await load() }, `enabled:${profile.id}`)
const setDefault = (profile: Profile) => run(async () => { await request(`/_api/agents/admin/profiles/${encodeURIComponent(profile.id)}/default`, { method: 'POST', body: '{}' }); await load() }, `default:${profile.id}`)
const testConnection = (profile: Profile) => run(async () => {
  const result = await request<{ profile: Profile; connectionCheck: ConnectionCheck }>(`/_api/agents/admin/profiles/${encodeURIComponent(profile.id)}/connection-check`, { method: 'POST', body: JSON.stringify({ enableOnSuccess: profile.status === 'disabled' }) })
  await load()
  if (result.connectionCheck.status === 'failed') throw new Error(result.connectionCheck.message ?? result.connectionCheck.errorCode ?? 'Provider connection check failed.')
}, `test:${profile.id}`)
const groupNames = (groupIds: readonly number[]): string => groupIds.length ? groupIds.map(id => groups.value.find(group => group.id === id)?.name ?? `Group ${id}`).join(', ') : 'no selected groups'
const openGrants = (profile: Profile) => { grantsError.value = ''; grantProfile.value = profile; grantDraft.exposureMode = profile.exposureMode; grantDraft.groupIds = [...profile.groupIds]; grantsDialog.value = true }
const saveGrants = () => {
  if (!grantProfile.value || !grantsDirty.value) return
  const profile = grantProfile.value
  void run(async () => { await request(`/_api/agents/admin/profiles/${encodeURIComponent(profile.id)}/grants`, { method: 'PUT', body: JSON.stringify({ exposureMode: grantDraft.exposureMode, groupIds: grantDraft.exposureMode === 'groups' ? grantDraft.groupIds : [] }) }); grantsDialog.value = false; await load() }, 'grants', message => { grantsError.value = message })
}
const browserUrlError = computed(() => {
  const input = browserUrl.value.trim()
  if (!input) return 'Enter an exact canonical HTTPS URL.'
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || !url.hostname) return 'Browser targets must use HTTPS.'
    if (url.username || url.password) return 'Browser targets cannot contain credentials.'
    if (url.hash) return 'Browser targets cannot contain a fragment.'
    if (/%[0-9a-f]{2}/i.test(url.pathname)) return 'Browser target paths cannot contain percent-encoded octets.'
    const keys = [...url.searchParams.keys()]
    if (new Set(keys).size !== keys.length) return 'Browser target query keys must be unique.'
    url.hostname = url.hostname.toLowerCase().replace(/\.$/, '')
    url.search = url.searchParams.size > 0 ? `?${url.searchParams.toString()}` : ''
    if (url.toString() !== input) return `Use the exact canonical URL: ${url.toString()}`
    return ''
  } catch {
    return 'Enter a valid absolute HTTPS URL.'
  }
})
const isBrowserUrlValid = computed(() => !browserUrlError.value)
const browserUrlRule = (): true | string => browserUrlError.value || true
const browserUrlRules = [browserUrlRule]
const openBrowserDialog = (): void => { browserError.value = ''; browserUrl.value = ''; browserEnabled.value = false; browserDialog.value = true }
const createBrowserTarget = () => run(async () => {
  if (!isBrowserUrlValid.value) { browserError.value = browserUrlError.value; return }
  await request('/_api/agents/admin/browser-targets', { method: 'POST', body: JSON.stringify({ canonicalUrl: browserUrl.value.trim(), enabled: browserEnabled.value }) })
  browserDialog.value = false
  browserUrl.value = ''
  browserEnabled.value = false
  await load()
}, 'browser-create', message => { browserError.value = message })
const updateBrowserTarget = (target: BrowserTarget, enabled: boolean, onError: (message: string) => void): void => {
  void run(async () => {
    await request(`/_api/agents/admin/browser-targets/${encodeURIComponent(target.id)}`, { method: 'PUT', body: JSON.stringify({ enabled }) })
    await load()
    if (enabled) browserEnableTarget.value = null
  }, `browser:${target.id}`, onError)
}
const setBrowserEnabled = (target: BrowserTarget, enabled: boolean): void => {
  if (actionBusyKey.value || target.enabled === enabled) return
  if (enabled) {
    browserEnableError.value = ''
    browserEnableTarget.value = target
    return
  }
  updateBrowserTarget(target, false, message => { error.value = message })
}
const allowConfirmedBrowserTarget = (): void => {
  const target = browserEnableTarget.value
  if (target) updateBrowserTarget(target, true, message => { browserEnableError.value = message })
}
onBeforeUnmount(() => {
  disposed = true
  loadGeneration += 1
  loadController?.abort()
  loadController = null
})
onMounted(() => void load())
</script>

<style scoped>
.agent-control {
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-body);
}

.agent-hero__facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--wiki-space-2) var(--wiki-space-4);
  margin: 0;
}

.agent-hero__facts > div {
  display: flex;
  align-items: baseline;
  gap: var(--wiki-space-2);
}

.agent-hero__facts dt {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-size: var(--wiki-label-size);
}

.agent-hero__facts dd {
  margin: 0;
  font-family: var(--wiki-font-mono);
  font-size: var(--wiki-label-size);
  font-weight: 680;
}

.agent-panel__eyebrow {
  color: var(--wiki-accent-ink);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .13em;
  text-transform: uppercase;
}

.agent-hero__status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--wiki-space-2);
}

.agent-hero__live {
  display: inline-flex;
  align-items: center;
  gap: var(--wiki-space-2);
  margin-inline-start: var(--wiki-space-1);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .04em;
}

.agent-hero__live > span {
  width: var(--wiki-space-2);
  height: var(--wiki-space-2);
  border-radius: var(--wiki-radius-pill);
  background: rgb(var(--v-theme-success));
  box-shadow: 0 0 0 var(--wiki-space-1) color-mix(in srgb, rgb(var(--v-theme-success)) 12%, transparent);
}

.agent-global-error {
  margin-block-end: var(--wiki-space-4);
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-error)) 28%, transparent);
  border-radius: var(--wiki-control-radius);
}
.agent-operation-status {
  margin-block-end: var(--wiki-space-4);
  border-radius: var(--wiki-control-radius);
}


.agent-global-error :deep(.v-alert__content) {
  display: grid;
  gap: var(--wiki-space-1);
}

.agent-snapshot {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--wiki-space-3);
  margin-block-end: var(--wiki-space-4);
}

.agent-snapshot__item {
  position: relative;
  display: grid;
  min-width: 0;
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-8));
  align-items: center;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-3) var(--wiki-space-4);
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);
}

.agent-snapshot__index {
  position: absolute;
  inset-block-start: var(--wiki-space-2);
  inset-inline-end: var(--wiki-space-3);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 24%, transparent);
  font-family: var(--wiki-font-mono);
  font-size: var(--wiki-label-size);
}

.agent-snapshot__icon,
.agent-panel__icon,
.provider-card__mark,
.target-row__icon,
.agent-empty__icon,
.profile-editor__mark,
.profile-form-section__intro > span,
.subsection-card__heading > .v-icon,
.selection-preview__icon,
.compact-dialog__header > span {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 18%, transparent);
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--wiki-accent-warm) 9%, var(--wiki-surface-raised));
  color: var(--wiki-accent-ink);
  box-shadow: var(--wiki-shadow-inset);
}

.agent-snapshot__icon {
  width: var(--wiki-control-height);
  height: var(--wiki-control-height);
}

.agent-snapshot__item > span:last-child {
  display: grid;
  min-width: 0;
}

.agent-snapshot__item small,
.provider-card__models span,
.provider-card__meta small,
.selection-preview small {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .06em;
  text-transform: uppercase;
}

.agent-snapshot__item strong {
  overflow: hidden;
  color: rgb(var(--v-theme-on-surface));
  font-size: .82rem;
  font-weight: 680;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-snapshot--loading > :deep(.v-skeleton-loader) {
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-8));
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-xs);
}

.agent-workspace {
  display: grid;
  align-items: start;
  grid-template-columns: 18rem minmax(0, 1fr);
  gap: var(--wiki-space-4);
}

.agent-sections {
  position: sticky;
  inset-block-start: var(--wiki-space-4);
  display: grid;
  gap: var(--wiki-space-1);
  padding: var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-sm), var(--wiki-shadow-inset);
}

.agent-sections__label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-1) var(--wiki-space-2) var(--wiki-space-2);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 56%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .1em;
  text-transform: uppercase;
}

.agent-sections__label small {
  font: inherit;
  letter-spacing: .04em;
}

.agent-section {
  position: relative;
  display: grid;
  width: 100%;
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-4));
  align-items: center;
  grid-template-columns: auto var(--wiki-control-height) minmax(0, 1fr) auto auto;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-2);
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: var(--wiki-control-radius);
  background: transparent;
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  text-align: start;
  transition:
    border-color var(--wiki-motion-normal) var(--wiki-motion-ease),
    background-color var(--wiki-motion-normal) var(--wiki-motion-ease),
    box-shadow var(--wiki-motion-normal) var(--wiki-motion-ease);
}

.agent-section::before {
  position: absolute;
  inset-block: var(--wiki-space-2);
  inset-inline-start: 0;
  width: .1875rem;
  border-radius: var(--wiki-radius-pill);
  background: var(--wiki-accent-warm);
  content: '';
  opacity: 0;
  transition: opacity var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.agent-section:hover {
  border-color: var(--wiki-surface-border);
  background: color-mix(in srgb, var(--wiki-ambient-accent) 5%, transparent);
}

.agent-section:focus-visible,
.provider-card__edit:focus-visible,
.profile-steps button:focus-visible,
.access-choice__item:focus-within {
  outline: none;
  box-shadow: var(--wiki-focus-ring);
}

.agent-section--active {
  border-color: color-mix(in srgb, var(--wiki-accent-warm) 24%, var(--wiki-surface-border));
  background: color-mix(in srgb, var(--wiki-accent-warm) 8%, transparent);
}

.agent-section--active::before {
  opacity: 1;
}

.agent-section__ordinal {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 36%, transparent);
  font-family: var(--wiki-font-mono);
  font-size: var(--wiki-label-size);
}

.agent-section__icon {
  display: grid;
  width: var(--wiki-control-height);
  height: var(--wiki-control-height);
  place-items: center;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
}

.agent-section--active .agent-section__icon {
  border-color: color-mix(in srgb, var(--wiki-accent-warm) 22%, transparent);
  background: color-mix(in srgb, var(--wiki-accent-warm) 11%, var(--wiki-surface-raised));
  color: var(--wiki-accent-ink);
}

.agent-section__copy {
  display: grid;
  min-width: 0;
}

.agent-section__copy strong {
  font-size: .82rem;
  font-weight: 700;
}

.agent-section__copy small {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  font-size: .7rem;
}

.agent-section__badge {
  justify-self: end;
  color: var(--wiki-accent-ink);
}

.agent-section__arrow {
  opacity: .42;
}

.agent-section--active .agent-section__arrow {
  color: var(--wiki-accent-ink);
  opacity: 1;
}

:dir(rtl) .agent-section__arrow {
  transform: rotate(180deg);
}

.agent-sections__note {
  display: flex;
  align-items: flex-start;
  gap: var(--wiki-space-2);
  margin-block-start: var(--wiki-space-2);
  padding: var(--wiki-space-3) var(--wiki-space-2) var(--wiki-space-1);
  border-block-start: 1px solid var(--wiki-surface-border);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-size: var(--wiki-label-size);
  line-height: 1.5;
}

.agent-sections__note .v-icon {
  flex: 0 0 auto;
  color: var(--wiki-accent-ink);
}

.agent-sections__note span {
  display: grid;
  gap: var(--wiki-space-1);
}

.agent-sections__note strong {
  color: rgb(var(--v-theme-on-surface));
}

.agent-content {
  min-width: 0;
}

.agent-panel {
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-sm), var(--wiki-shadow-inset);
}

.agent-panel__header {
  display: flex;
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-10));
  align-items: center;
  justify-content: space-between;
  gap: var(--wiki-space-5);
  padding: var(--wiki-space-4) var(--wiki-space-5);
  border-block-end: 1px solid var(--wiki-surface-border);
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--wiki-ambient-accent) 5%, transparent), transparent 48%),
    var(--wiki-surface-raised);
}

.agent-panel__heading {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--wiki-space-3);
}

.agent-panel__icon {
  width: calc(var(--wiki-control-height) + var(--wiki-space-1));
  height: calc(var(--wiki-control-height) + var(--wiki-space-1));
}

.agent-panel__header h2 {
  margin: var(--wiki-space-1) 0 0;
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-heading);
  font-size: 1.18rem;
  font-weight: 730;
  letter-spacing: -.025em;
}

.agent-panel__header p,
.profile-editor__header p {
  margin: var(--wiki-space-1) 0 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
  font-size: .78rem;
}

.agent-panel__state {
  display: grid;
  flex: 0 0 auto;
  justify-items: end;
  gap: var(--wiki-space-1);
}

.agent-panel__state > span {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 54%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .055em;
  text-transform: uppercase;
}

.agent-panel__body {
  padding: var(--wiki-space-5);
}

.runtime-section + .runtime-section {
  margin-block-start: var(--wiki-space-8);
}

.section-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--wiki-space-4);
  margin-block-end: var(--wiki-space-3);
}

.section-heading h3,
.profile-form-section__intro h3 {
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-size: 1rem;
  font-weight: 720;
  letter-spacing: -.015em;
}

.section-heading p,
.profile-form-section__intro p,
.subsection-card__heading p,
.protocol-behavior__heading p {
  margin: var(--wiki-space-1) 0 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-size: .75rem;
  line-height: 1.5;
}

.section-heading > span {
  color: var(--wiki-accent-ink);
  font-size: .72rem;
  font-weight: 700;
}

.capability-map {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: var(--wiki-space-2);
}

.capability-item {
  display: grid;
  min-height: var(--wiki-control-height);
  align-items: center;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-2) var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
  font-size: .75rem;
  font-weight: 650;
}

.capability-item small {
  grid-column: 2;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .05em;
  text-transform: uppercase;
}

.capability-item--enabled {
  border-color: color-mix(in srgb, rgb(var(--v-theme-success)) 24%, var(--wiki-surface-border));
  background: color-mix(in srgb, rgb(var(--v-theme-success)) 6%, var(--wiki-surface-raised));
  color: rgb(var(--v-theme-on-surface));
}

.capability-item__state {
  display: grid;
  width: calc(var(--wiki-space-5) + var(--wiki-space-1));
  height: calc(var(--wiki-space-5) + var(--wiki-space-1));
  grid-row: 1 / span 2;
  place-items: center;
  border-radius: var(--wiki-radius-pill);
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 8%, transparent);
}

.capability-item--enabled .capability-item__state {
  background: color-mix(in srgb, rgb(var(--v-theme-success)) 14%, transparent);
  color: rgb(var(--v-theme-success));
}

.policy-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--wiki-space-3);
}

.policy-card {
  position: relative;
  padding: var(--wiki-space-4);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
}

.policy-card::after {
  position: absolute;
  inset-block: var(--wiki-space-4);
  inset-inline-start: 0;
  width: .125rem;
  background: color-mix(in srgb, var(--wiki-accent-warm) 62%, transparent);
  content: '';
}

.policy-card__title {
  display: flex;
  align-items: center;
  gap: var(--wiki-space-2);
  margin-block-end: var(--wiki-space-3);
}

.policy-card__title span {
  display: grid;
  width: calc(var(--wiki-control-height) - var(--wiki-space-2));
  height: calc(var(--wiki-control-height) - var(--wiki-space-2));
  place-items: center;
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--wiki-accent-warm) 10%, transparent);
  color: var(--wiki-accent-ink);
}

.policy-card h4,
.subsection-card h4,
.protocol-behavior h4,
.limit-group h4 {
  margin: 0;
  font-size: .82rem;
  font-weight: 710;
}

.policy-card dl {
  display: grid;
  gap: var(--wiki-space-2);
  margin: 0;
}

.policy-card dl > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--wiki-space-4);
  padding-block-end: var(--wiki-space-2);
  border-block-end: 1px solid var(--wiki-surface-border);
  font-size: .72rem;
}

.policy-card dl > div:last-child {
  padding-block-end: 0;
  border: 0;
}

.policy-card dt {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
}

.policy-card dd {
  margin: 0;
  font-family: var(--wiki-font-mono);
  font-weight: 680;
  text-align: end;
}

.metrics-note,
.browser-boundary-note {
  display: flex;
  align-items: flex-start;
  gap: var(--wiki-space-3);
  margin-block-start: var(--wiki-space-5);
  padding: var(--wiki-space-4);
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 18%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--wiki-accent-warm) 4%, var(--wiki-surface-raised));
}

.metrics-note > span {
  display: grid;
  width: calc(var(--wiki-control-height) - var(--wiki-space-2));
  height: calc(var(--wiki-control-height) - var(--wiki-space-2));
  flex: 0 0 auto;
  place-items: center;
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--wiki-accent-warm) 11%, transparent);
  color: var(--wiki-accent-ink);
}

.metrics-note strong {
  display: block;
  margin-block-end: var(--wiki-space-1);
  font-size: .8rem;
}

.metrics-note p {
  margin: 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
  font-size: .72rem;
  line-height: 1.5;
}

.metrics-note code,
code {
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-mono);
  font-weight: 650;
  overflow-wrap: anywhere;
}

.provider-policy-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-block-end: var(--wiki-space-4);
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
}

.provider-policy-strip > span {
  display: grid;
  min-width: 0;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--wiki-space-1) var(--wiki-space-2);
  padding: var(--wiki-space-3);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  font-size: var(--wiki-label-size);
  line-height: 1.4;
}

.provider-policy-strip > span + span {
  border-inline-start: 1px solid var(--wiki-surface-border);
}

.provider-policy-strip .v-icon {
  grid-row: 1 / span 2;
  color: var(--wiki-accent-ink);
}

.provider-policy-strip strong {
  color: rgb(var(--v-theme-on-surface));
  font-size: .72rem;
}

.provider-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 21rem), 1fr));
  gap: var(--wiki-space-3);
}

.provider-card {
  position: relative;
  display: flex;
  min-width: 0;
  overflow: hidden;
  flex-direction: column;
  padding: var(--wiki-space-4);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--wiki-ambient-accent) 4%, transparent), transparent 48%),
    var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);
  transition:
    border-color var(--wiki-motion-normal) var(--wiki-motion-ease),
    box-shadow var(--wiki-motion-normal) var(--wiki-motion-ease),
    transform var(--wiki-motion-normal) var(--wiki-motion-ease-out);
}

.provider-card:hover,
.provider-card:focus-within {
  border-color: color-mix(in srgb, var(--wiki-accent-warm) 28%, var(--wiki-surface-border));
  box-shadow: var(--wiki-shadow-sm), var(--wiki-shadow-inset);
  transform: translateY(calc(var(--wiki-space-1) * -.5));
}

.provider-card__top {
  display: flex;
  align-items: flex-start;
  gap: var(--wiki-space-3);
}

.provider-card__mark {
  width: var(--wiki-control-height);
  height: var(--wiki-control-height);
}

.provider-card__identity {
  min-width: 0;
  flex: 1 1 auto;
}

.provider-card__name {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--wiki-space-2);
}

.provider-card__name h3 {
  overflow: hidden;
  margin: var(--wiki-space-1) 0 0;
  font-size: .96rem;
  font-weight: 730;
  letter-spacing: -.015em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-card__identity > p {
  margin: var(--wiki-space-1) 0 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  font-size: .7rem;
}

.provider-card__status {
  display: flex;
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
  margin-block: var(--wiki-space-4) var(--wiki-space-1);
}
.provider-card__checked {
  display: block;
  margin-block-end: var(--wiki-space-3);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 56%, transparent);
  font-size: var(--wiki-label-size);
}


.connection-state {
  display: inline-flex;
  align-items: center;
  gap: var(--wiki-space-1);
  padding: var(--wiki-space-1) var(--wiki-space-2);
  border-radius: var(--wiki-radius-pill);
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 6%, transparent);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
  font-size: .65rem;
  font-weight: 680;
}

.connection-state--success {
  background: color-mix(in srgb, rgb(var(--v-theme-success)) 10%, transparent);
  color: rgb(var(--v-theme-success));
}

.connection-state--error {
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 10%, transparent);
  color: rgb(var(--v-theme-error));
}

.connection-state__dot {
  width: var(--wiki-space-2);
  height: var(--wiki-space-2);
  border-radius: var(--wiki-radius-pill);
  background: currentColor;
}

.provider-card__models {
  display: grid;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
}

.provider-card__models > div {
  display: grid;
  min-width: 0;
  align-items: center;
  grid-template-columns: 5.5rem minmax(0, 1fr) auto;
  gap: var(--wiki-space-2);
}

.provider-card__models code {
  overflow: hidden;
  font-size: .72rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-card__models small {
  padding: var(--wiki-space-1) var(--wiki-space-2);
  border-radius: var(--wiki-radius-pill);
  background: color-mix(in srgb, var(--wiki-accent-warm) 9%, transparent);
  color: var(--wiki-accent-ink);
  font-size: .58rem;
  font-weight: 700;
  text-transform: uppercase;
}

.provider-card__error {
  margin: var(--wiki-space-3) 0 0;
  color: rgb(var(--v-theme-error));
  font-size: .7rem;
  line-height: 1.45;
}

.provider-card__meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--wiki-space-3);
  margin-block-start: var(--wiki-space-4);
}

.provider-card__meta > div {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--wiki-space-2);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
}

.provider-card__meta > div > span {
  display: grid;
  min-width: 0;
}

.provider-card__meta strong {
  overflow: hidden;
  color: rgb(var(--v-theme-on-surface));
  font-size: .7rem;
  font-weight: 640;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-card__edit {
  display: flex;
  width: calc(100% + var(--wiki-space-8));
  min-height: var(--wiki-control-height);
  align-items: center;
  justify-content: space-between;
  margin: var(--wiki-space-4) calc(var(--wiki-space-4) * -1) calc(var(--wiki-space-4) * -1);
  padding: var(--wiki-space-2) var(--wiki-space-4);
  border: 0;
  border-block-start: 1px solid var(--wiki-surface-border);
  background: transparent;
  color: var(--wiki-accent-ink);
  cursor: pointer;
  font-size: .72rem;
  font-weight: 690;
  text-align: start;
}

.provider-card__edit:hover {
  background: color-mix(in srgb, var(--wiki-accent-warm) 5%, transparent);
}
.provider-card__edit:disabled {
  cursor: not-allowed;
  opacity: .46;
}

.provider-card__edit:disabled:hover {
  background: transparent;
}


.agent-empty {
  display: grid;
  min-height: calc(var(--wiki-space-12) * 7);
  place-items: center;
  align-content: center;
  padding: var(--wiki-space-12) var(--wiki-space-6);
  border: 1px dashed var(--wiki-surface-border-strong);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-sunken);
  text-align: center;
}

.agent-empty__icon {
  width: calc(var(--wiki-space-12) + var(--wiki-space-6));
  height: calc(var(--wiki-space-12) + var(--wiki-space-6));
  margin-block-end: var(--wiki-space-4);
  border-radius: var(--wiki-panel-radius);
}

.agent-empty h3 {
  margin: 0;
}

.agent-empty p {
  max-width: 34rem;
  margin: var(--wiki-space-2) auto var(--wiki-space-4);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
}

.browser-boundary-note {
  margin-block: 0 var(--wiki-space-4);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
  font-size: .75rem;
  line-height: 1.5;
}

.browser-boundary-note .v-icon {
  flex: 0 0 auto;
  color: var(--wiki-accent-ink);
}

.browser-boundary-note strong {
  color: rgb(var(--v-theme-on-surface));
}

.target-list {
  display: grid;
  gap: var(--wiki-space-2);
}

.target-row {
  display: flex;
  min-width: 0;
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-5));
  align-items: center;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
}

.target-row__icon {
  width: var(--wiki-control-height);
  height: var(--wiki-control-height);
}

.target-row__copy {
  display: grid;
  min-width: 0;
  flex: 1 1 auto;
}

.target-row__copy strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.target-row__copy small {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 54%, transparent);
  font-family: var(--wiki-font-mono);
  font-size: .66rem;
}

.target-row__state {
  display: flex;
  align-items: center;
  gap: var(--wiki-space-2);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
  font-size: .72rem;
  font-weight: 680;
}

.profile-editor {
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--wiki-hero-radius) !important;
  background: var(--wiki-surface-raised) !important;
  box-shadow: var(--wiki-shadow-lg), var(--wiki-shadow-inset) !important;
}

.profile-editor__header {
  display: flex;
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-10));
  align-items: center;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-4) var(--wiki-space-5);
  border-block-end: 1px solid var(--wiki-surface-border);
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--wiki-ambient-accent) 6%, transparent), transparent 55%),
    var(--wiki-surface-raised);
}

.profile-editor__mark {
  width: calc(var(--wiki-control-height) + var(--wiki-space-1));
  height: calc(var(--wiki-control-height) + var(--wiki-space-1));
}

.profile-editor__title {
  min-width: 0;
}

.profile-editor__title h2 {
  overflow: hidden;
  margin: var(--wiki-space-1) 0 0;
  font-size: 1.15rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.profile-editor__change {
  flex: 0 0 auto;
}

.profile-editor__workspace {
  display: grid;
  min-height: min(38rem, calc(100dvh - 14rem));
  overflow: hidden;
  grid-template-columns: 16rem minmax(0, 1fr);
}

.profile-steps {
  display: grid;
  align-content: start;
  gap: var(--wiki-space-1);
  padding: var(--wiki-space-4) var(--wiki-space-3);
  border-inline-end: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-sunken);
}

.profile-steps button {
  display: grid;
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-4));
  align-items: center;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-2);
  border: 1px solid transparent;
  border-radius: var(--wiki-control-radius);
  background: transparent;
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  text-align: start;
  transition:
    border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    background-color var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.profile-steps button:hover:not(:disabled) {
  background: color-mix(in srgb, var(--wiki-accent-warm) 5%, transparent);
}

.profile-steps button:disabled {
  cursor: not-allowed;
  opacity: .46;
}

.profile-steps button.profile-step--active {
  border-color: color-mix(in srgb, var(--wiki-accent-warm) 24%, var(--wiki-surface-border));
  background: color-mix(in srgb, var(--wiki-accent-warm) 8%, transparent);
  color: var(--wiki-accent-ink);
}

.profile-step__index {
  display: grid;
  width: calc(var(--wiki-space-6) + var(--wiki-space-1));
  height: calc(var(--wiki-space-6) + var(--wiki-space-1));
  place-items: center;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-radius-pill);
  background: var(--wiki-surface-raised);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-family: var(--wiki-font-mono);
  font-size: .65rem;
  font-weight: 750;
}

.profile-step--active .profile-step__index {
  border-color: var(--wiki-accent-warm);
  background: var(--wiki-accent-warm);
  color: rgb(var(--v-theme-on-primary));
}

.profile-steps button > span:nth-child(2) {
  display: grid;
  min-width: 0;
}

.profile-steps strong {
  font-size: .76rem;
  font-weight: 700;
}

.profile-steps small {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 55%, transparent);
  font-size: .65rem;
}

.profile-steps button > .v-icon {
  opacity: .4;
}

.profile-step--active > .v-icon {
  opacity: 1 !important;
}

.profile-editor__form {
  min-width: 0;
  overflow: auto;
  padding: clamp(var(--wiki-space-5), 3vw, var(--wiki-space-8));
}

.profile-form-section {
  max-width: 52rem;
  margin: 0 auto;
}

.profile-form-section__intro {
  display: flex;
  align-items: flex-start;
  gap: var(--wiki-space-3);
  margin-block-end: var(--wiki-space-6);
}

.profile-form-section__intro > span {
  width: var(--wiki-control-height);
  height: var(--wiki-control-height);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--wiki-space-1) var(--wiki-space-4);
}

.protocol-field,
.secret-field {
  grid-column: 1 / -1;
}

.field-note {
  display: flex;
  align-items: flex-start;
  gap: var(--wiki-space-2);
  margin: calc(var(--wiki-space-4) * -1) var(--wiki-space-1) var(--wiki-space-4);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 60%, transparent);
  font-size: .7rem;
  line-height: 1.45;
}

.selection-preview {
  display: flex;
  align-items: center;
  gap: var(--wiki-space-3);
  margin-block-start: var(--wiki-space-2);
  padding: var(--wiki-space-3);
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 18%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--wiki-accent-warm) 4%, var(--wiki-surface-raised));
}

.selection-preview__icon {
  width: var(--wiki-control-height);
  height: var(--wiki-control-height);
}

.selection-preview > div {
  display: grid;
}

.selection-preview strong {
  font-size: .83rem;
}

.selection-preview p {
  margin: var(--wiki-space-1) 0 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  font-size: .68rem;
}

.subsection-card,
.protocol-behavior,
.limit-group {
  margin-block-start: var(--wiki-space-3);
  padding: var(--wiki-space-4);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
}

.subsection-card__heading,
.protocol-behavior__heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--wiki-space-4);
  margin-block-end: var(--wiki-space-4);
}

.subsection-card__heading > .v-icon {
  width: calc(var(--wiki-control-height) - var(--wiki-space-2));
  height: calc(var(--wiki-control-height) - var(--wiki-space-2));
}

.protocol-behavior {
  margin-block-start: var(--wiki-space-2);
  border-color: color-mix(in srgb, var(--wiki-accent-warm) 18%, var(--wiki-surface-border));
  background: color-mix(in srgb, var(--wiki-accent-warm) 3%, var(--wiki-surface-raised));
}

.protocol-behavior__heading {
  justify-content: flex-start;
}

.protocol-behavior__heading > span {
  display: grid;
  width: calc(var(--wiki-control-height) - var(--wiki-space-2));
  height: calc(var(--wiki-control-height) - var(--wiki-space-2));
  flex: 0 0 auto;
  place-items: center;
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--wiki-accent-warm) 10%, transparent);
  color: var(--wiki-accent-ink);
}

.protocol-summary {
  display: grid;
  gap: var(--wiki-space-2);
  margin: 0;
}

.protocol-summary > div {
  display: grid;
  grid-template-columns: minmax(8rem, .38fr) minmax(0, 1fr);
  gap: var(--wiki-space-3);
  padding-block-start: var(--wiki-space-2);
  border-block-start: 1px solid var(--wiki-surface-border);
}

.protocol-summary dt {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  font-size: .7rem;
  font-weight: 650;
}

.protocol-summary dd {
  margin: 0;
  font-size: .72rem;
  line-height: 1.45;
}

.access-choice {
  display: grid;
  gap: var(--wiki-space-3);
}

.access-choice__item {
  position: relative;
  display: grid;
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-10));
  align-items: center;
  grid-template-columns: var(--wiki-control-height) minmax(0, 1fr) auto;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
  cursor: pointer;
  transition:
    border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    background-color var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.access-choice__item input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.access-choice__item--active {
  border-color: color-mix(in srgb, var(--wiki-accent-warm) 32%, var(--wiki-surface-border));
  background: color-mix(in srgb, var(--wiki-accent-warm) 6%, var(--wiki-surface-raised));
}

.access-choice__icon {
  display: grid;
  width: var(--wiki-control-height);
  height: var(--wiki-control-height);
  place-items: center;
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--wiki-accent-warm) 9%, transparent);
  color: var(--wiki-accent-ink);
}

.access-choice__item > span:nth-of-type(2) {
  display: grid;
}

.access-choice__item strong {
  font-size: .82rem;
}

.access-choice__item small {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 60%, transparent);
  font-size: .7rem;
  line-height: 1.45;
}

.access-choice__check {
  color: var(--wiki-accent-ink);
}

.limit-group h4 {
  margin-block-end: var(--wiki-space-3);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 74%, transparent);
}

.profile-editor__footer {
  display: flex;
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-4));
  align-items: center;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-3) var(--wiki-space-4);
  border-block-start: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-raised);
  box-shadow: 0 calc(var(--wiki-space-1) * -1) var(--wiki-space-6) color-mix(in srgb, var(--wiki-shadow-color) 32%, transparent);
}

.profile-editor__position,
.profile-editor__save-state {
  display: grid;
}

.profile-editor__position strong {
  font-size: .74rem;
}

.profile-editor__position span {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 56%, transparent);
  font-size: .65rem;
}

.profile-editor__save-state {
  align-items: center;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--wiki-space-2);
  margin-inline-start: var(--wiki-space-3);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-size: var(--wiki-label-size);
}

.profile-editor__save-state .v-icon {
  color: var(--wiki-accent-ink);
}

.compact-dialog {
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--wiki-panel-radius) !important;
  background: var(--wiki-surface-raised) !important;
  box-shadow: var(--wiki-shadow-lg), var(--wiki-shadow-inset) !important;
}

.compact-dialog__header {
  display: flex;
  align-items: center;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-4) var(--wiki-space-5);
  border-block-end: 1px solid var(--wiki-surface-border);
  background: color-mix(in srgb, var(--wiki-accent-warm) 4%, var(--wiki-surface-raised));
}

.compact-dialog__header > span {
  width: var(--wiki-control-height);
  height: var(--wiki-control-height);
}

.compact-dialog__header h2 {
  margin: var(--wiki-space-1) 0 0;
  font-size: 1.08rem;
}

.compact-dialog__header p {
  margin: var(--wiki-space-1) 0 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-size: .75rem;
}

.compact-dialog__header--danger {
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 5%, var(--wiki-surface-raised));
}

.compact-dialog__header--danger > span {
  border-color: color-mix(in srgb, rgb(var(--v-theme-error)) 20%, transparent);
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 10%, var(--wiki-surface-raised));
  color: rgb(var(--v-theme-error));
}

.compact-dialog__audit {
  display: inline-flex;
  align-items: center;
  gap: var(--wiki-space-2);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  font-size: var(--wiki-label-size);
}

.compact-dialog__audit .v-icon {
  color: var(--wiki-accent-ink);
}
.browser-confirm-url {
  overflow-wrap: anywhere;
  padding: var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
}


:global(.profile-editor .v-messages),
:global(.compact-dialog .v-messages) {
  opacity: 1 !important;
}

:global(.profile-editor .v-field),
:global(.compact-dialog .v-field) {
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
}

:global(.profile-editor .v-field--focused),
:global(.compact-dialog .v-field--focused) {
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-focus-ring);
}

:global(.profile-editor .v-field-label),
:global(.profile-editor .v-messages__message),
:global(.compact-dialog .v-field-label),
:global(.compact-dialog .v-messages__message) {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 78%, transparent) !important;
  opacity: 1 !important;
}

@media (max-width: 1180px) {
  .agent-snapshot {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .agent-workspace {
    grid-template-columns: 15rem minmax(0, 1fr);
  }

  .agent-section {
    grid-template-columns: auto var(--wiki-control-height) minmax(0, 1fr) auto;
  }

  .agent-section__badge {
    display: none;
  }
}

@media (max-width: 960px) {
  .agent-workspace {
    grid-template-columns: minmax(0, 1fr);
  }


  .agent-sections {
    position: static;
    display: flex;
    overflow-x: auto;
    padding: var(--wiki-space-2);
    scrollbar-width: thin;
  }

  .agent-sections__label,
  .agent-sections__note {
    display: none;
  }

  .agent-section {
    min-width: 11.5rem;
    grid-template-columns: auto var(--wiki-control-height) minmax(0, 1fr);
  }

  .agent-section__arrow,
  .agent-section__badge {
    display: none;
  }

  .profile-editor__workspace {
    grid-template-columns: 13rem minmax(0, 1fr);
  }

  .profile-editor__save-state {
    display: none;
  }
}

@media (max-width: 839.98px) {
  .profile-editor {
    border: 0;
    border-radius: 0 !important;
    box-shadow: none !important;
  }
}

@media (max-width: 760px) {
  .agent-hero__facts {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--wiki-space-2);
  }

  .agent-hero__facts > div {
    display: grid;
    gap: 0;
  }

  .agent-hero__status > :deep(.v-chip:nth-of-type(2)),
  .agent-hero__live {
    display: none;
  }

  .agent-hero__refresh {
    width: 100%;
  }

  .agent-snapshot {
    display: none;
  }

  .agent-panel__header {
    align-items: flex-start;
    flex-direction: column;
  }

  .agent-panel__header > .v-btn {
    width: 100%;
  }

  .agent-panel__state {
    width: 100%;
    align-items: center;
    justify-content: space-between;
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .policy-grid,
  .form-grid,
  .provider-card__meta,
  .provider-policy-strip {
    grid-template-columns: minmax(0, 1fr);
  }

  .provider-policy-strip > span + span {
    border-block-start: 1px solid var(--wiki-surface-border);
    border-inline-start: 0;
  }

  .protocol-field,
  .secret-field {
    grid-column: auto;
  }


  .profile-editor__header {
    min-height: calc(var(--wiki-control-height) + var(--wiki-space-6));
    padding: var(--wiki-space-3) var(--wiki-space-4);
  }

  .profile-editor__mark {
    width: var(--wiki-control-height);
    height: var(--wiki-control-height);
  }

  .profile-editor__header p {
    display: none;
  }

  .profile-editor__workspace {
    display: flex;
    min-height: 0;
    overflow: hidden;
    flex: 1 1 auto;
    flex-direction: column;
  }

  .profile-steps {
    display: flex;
    overflow-x: auto;
    flex: 0 0 auto;
    padding: var(--wiki-space-2);
    border-block-end: 1px solid var(--wiki-surface-border);
    border-inline-end: 0;
  }

  .profile-steps button {
    min-width: 8rem;
    min-height: var(--wiki-control-height);
    grid-template-columns: auto minmax(0, 1fr);
  }

  .profile-steps button > .v-icon,
  .profile-steps small {
    display: none;
  }

  .profile-editor__form {
    flex: 1 1 auto;
    padding: var(--wiki-space-5);
  }

  .profile-editor__position {
    display: none;
  }

  .profile-editor__footer {
    overflow-x: auto;
    justify-content: flex-end;
    padding: var(--wiki-space-2);
  }

  .profile-editor__footer > .v-spacer,
  .profile-editor__footer > .v-btn:first-of-type {
    display: none;
  }

  .protocol-summary > div {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--wiki-space-1);
  }

  .target-row {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .target-row__state {
    width: 100%;
    justify-content: flex-end;
  }

  .compact-dialog__audit {
    display: none;
  }
}

@media (max-width: 480px) {
  .agent-hero__facts {
    grid-template-columns: minmax(0, 1fr);
  }

  .agent-panel__body,
  .agent-panel__header {
    padding-inline: var(--wiki-space-4);
  }

  .provider-card__models > div {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .provider-card__models span {
    grid-column: 1 / -1;
  }

  .profile-editor__mark,
  .profile-editor__title .agent-panel__eyebrow {
    display: none;
  }

  .profile-editor__footer .v-btn {
    min-width: max-content;
  }

  .access-choice__item {
    grid-template-columns: var(--wiki-control-height) minmax(0, 1fr);
  }

  .access-choice__check {
    position: absolute;
    inset-block-start: var(--wiki-space-3);
    inset-inline-end: var(--wiki-space-3);
  }
}

@media (forced-colors: active) {
  .agent-snapshot__item,
  .agent-sections,
  .agent-panel,
  .provider-card,
  .target-row,
  .profile-editor,
  .compact-dialog {
    border: 1px solid CanvasText;
    background: Canvas;
    box-shadow: none;
  }

  .agent-section--active,
  .profile-steps button.profile-step--active,
  .access-choice__item--active {
    outline: 2px solid Highlight;
    outline-offset: -2px;
  }

  .agent-section:focus-visible,
  .provider-card__edit:focus-visible,
  .profile-steps button:focus-visible,
  .access-choice__item:focus-within {
    outline: 2px solid Highlight;
    outline-offset: 2px;
  }

  .agent-hero__live > span,
  .connection-state__dot {
    background: Highlight;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    transition-duration: .01ms !important;
    animation-duration: .01ms !important;
  }
}
</style>
