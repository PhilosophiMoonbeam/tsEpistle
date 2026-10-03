<template>
  <section class="agent-control" aria-labelledby="admin-title">
    <AdminHero
      :title="embedded ? $t('admin:agentAdmin.agents') : $t('admin:agentAdmin.agentAdministration')"
      :description="$t('admin:agentAdmin.connectModelsCurateExpertise')"
      icon="mdi-robot-outline"
      :eyebrow="$t('admin:agentAdmin.intelligenceConnections')"
      heading-id="admin-title"
    >
      <template #status>
        <div class="agent-hero__status" :aria-label="$t('admin:agentAdmin.controlCenterStatus')" role="status" aria-live="polite">
          <v-chip
            size="small"
            variant="tonal"
            :color="loadFailed ? 'error' : !dataLoaded ? undefined : runtime?.enabled ? 'success' : 'warning'"
            :prepend-icon="loadFailed ? 'mdi-alert-circle-outline' : !dataLoaded ? 'mdi-progress-clock' : runtime?.enabled ? 'mdi-check-circle-outline' : 'mdi-pause-circle-outline'"
          >
            {{ loadFailed ? dataLoaded ? $t('admin:agentAdmin.refreshFailedShowingLast') : $t('admin:agentAdmin.deploymentStateUnavailable') : !dataLoaded ? $t('admin:agentAdmin.readingDeploymentState') : runtime?.enabled ? $t('admin:agentAdmin.agentRuntimeActive') : $t('admin:agentAdmin.agentRuntimePaused') }}
          </v-chip>
        </div>
      </template>
      <template #actions>
        <v-btn class="agent-hero__refresh" variant="tonal" color="primary" prepend-icon="mdi-refresh" :loading="loading" :disabled="loading || Boolean(actionBusyKey)" @click="load">{{ $t('admin:agentAdmin.refreshStatus') }}</v-btn>
      </template>
    </AdminHero>

    <v-alert v-if="error" class="agent-global-error" type="error" variant="tonal" closable role="alert" @click:close="error = ''">
      <strong>{{ $t('admin:agentAdmin.controlCenterCouldNot') }}</strong>
      <span>{{ error }}</span>
      <template #append><v-btn variant="text" size="small" @click="load">{{ $t('admin:agentAdmin.retry') }}</v-btn></template>
    </v-alert>
    <!-- The triggering buttons show their own loading state; this live region only
         announces it, so the layout does not shift while an action runs. -->
    <p class="agent-operation-status" role="status" aria-live="polite">{{ actionBusyKey ? actionBusyMessage : '' }}</p>


    <div class="agent-workspace">
      <nav class="agent-sections" :aria-label="$t('admin:agentAdmin.agentAdministrationSections')" role="tablist" aria-orientation="horizontal">
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
          @keydown.home.prevent="selectSection(0, $event)"
          @keydown.end.prevent="selectSection(sectionItems.length - 1, $event)"
        >
          <span class="agent-section__icon"><v-icon :icon="section.icon" size="20" aria-hidden="true" /></span>
          <span class="agent-section__copy"><strong>{{ section.title }}</strong><small>{{ section.description }}</small></span>
          <v-chip v-if="section.badge" class="agent-section__badge" size="x-small" variant="tonal">{{ section.badge }}</v-chip>
        </button>
      </nav>

      <v-window v-model="tab" class="agent-content">
        <v-window-item id="agent-panel-overview" value="overview" role="tabpanel" aria-labelledby="agent-tab-overview">
          <section class="agent-overview">
            <div class="agent-overview__intro">
              <div class="agent-panel__eyebrow">{{ $t('admin:agentAdmin.knowledgeConversation') }}</div>
              <h2>{{ $t('admin:agentAdmin.modelsExpertiseAccess') }}</h2>
              <p>{{ $t('admin:agentAdmin.reviewConversationSetupThen') }}</p>
            </div>
            <v-alert v-if="resourceState.runtime.error || resourceState.profiles.error" type="warning" variant="tonal" role="alert">
              {{ resourceState.runtime.error || resourceState.profiles.error }}
              <v-btn variant="text" :disabled="loading" @click="refreshResources(['runtime', 'profiles'])">{{ $t('admin:agentAdmin.retry') }}</v-btn>
            </v-alert>
            <v-skeleton-loader v-if="!dataLoaded && loading" type="article, list-item-three-line" />
            <div v-else-if="dataLoaded" class="agent-overview__grid">
              <section class="agent-setup" aria-labelledby="agent-setup-title">
                <h3 id="agent-setup-title">{{ $t('admin:agentAdmin.conversationSetup') }}</h3>
                <p class="agent-overview__caption">{{ $t('admin:agentAdmin.configurationChecksLastRefresh') }}</p>
                <button class="agent-setup__step" type="button" @click="tab = 'runtime'">
                  <v-icon :icon="runtime?.enabled && runtime?.providerEnabled ? 'mdi-check-circle-outline' : 'mdi-pause-circle-outline'" :color="runtime?.enabled && runtime?.providerEnabled ? 'success' : 'warning'" aria-hidden="true" />
                  <span><strong>{{ $t('admin:agentAdmin.enableRuntime') }}</strong><small>{{ runtime?.enabled && runtime?.providerEnabled ? $t('admin:agentAdmin.agentProviderInferenceEnabled') : $t('admin:agentAdmin.enableAgentProviderInference') }}</small></span><v-icon icon="mdi-arrow-right" size="18" aria-hidden="true" />
                </button>
                <button class="agent-setup__step" type="button" @click="tab = 'profiles'">
                  <v-icon :icon="readyProviders.length ? 'mdi-check-circle-outline' : 'mdi-plus-circle-outline'" :color="readyProviders.length ? 'success' : 'warning'" aria-hidden="true" />
                  <span><strong>{{ $t('admin:agentAdmin.connectModel') }}</strong><small>{{ readyProviders.length ? $t('admin:agentAdmin.enabledProfilesCredentialsPassed', { readyProvidersCount: readyProviders.length, interpolation: { escapeValue: false } }) : $t('admin:agentAdmin.addProviderVerifyConnection') }}</small></span><v-icon icon="mdi-arrow-right" size="18" aria-hidden="true" />
                </button>
                <button class="agent-setup__step" type="button" @click="tab = 'profiles'">
                  <v-icon :icon="defaultProvider ? 'mdi-check-circle-outline' : 'mdi-star-outline'" :color="defaultProvider ? 'success' : 'warning'" aria-hidden="true" />
                  <span><strong>{{ $t('admin:agentAdmin.chooseWorkspaceDefault') }}</strong><small>{{ defaultProvider ? `${defaultProvider.displayName} · ${defaultProvider.model}` : $t('admin:agentAdmin.setVerifiedProviderAvailable') }}</small></span><v-icon icon="mdi-arrow-right" size="18" aria-hidden="true" />
                </button>
              </section>
              <aside class="agent-default">
                <div class="agent-panel__eyebrow">{{ $t('admin:agentAdmin.workspaceDefault') }}</div>
                <h3>{{ defaultProvider?.displayName || $t('admin:agentAdmin.noDefaultSelected') }}</h3>
                <code v-if="defaultProvider">{{ defaultProvider.model }}</code>
                <p>{{ defaultProvider ? $t('admin:agentAdmin.usedWhenConversationHas') : $t('admin:agentAdmin.sharedDefaultGivesNew') }}</p>
                <v-btn variant="tonal" color="primary" append-icon="mdi-arrow-right" @click="tab = 'profiles'">{{ $t('admin:agentAdmin.manageProviders') }}</v-btn>
              </aside>
              <section class="agent-pathways" :aria-label="$t('admin:agentAdmin.extendAgent')">
                <button type="button" @click="tab = 'skills'"><v-icon icon="mdi-book-open-variant-outline" aria-hidden="true" /><span><strong>{{ $t('admin:agentAdmin.curateExpertise') }}</strong><small>{{ $t('admin:agentAdmin.mapWikiPagesApproved') }}</small></span><v-icon icon="mdi-arrow-right" size="18" aria-hidden="true" /></button>
                <button type="button" @click="tab = 'tools'"><v-icon icon="mdi-connection" aria-hidden="true" /><span><strong>{{ $t('admin:agentAdmin.connectAnotherAgent') }}</strong><small>{{ $t('admin:agentAdmin.exploreToolsTheirPermissions') }}</small></span><v-icon icon="mdi-arrow-right" size="18" aria-hidden="true" /></button>
                <button type="button" @click="tab = 'memory'"><v-icon icon="mdi-brain" aria-hidden="true" /><span><strong>{{ $t('admin:agentAdmin.understandWhatPersists') }}</strong><small>{{ $t('admin:agentAdmin.knowledgeSourcesPersonalMemory') }}</small></span><v-icon icon="mdi-arrow-right" size="18" aria-hidden="true" /></button>
              </section>
            </div>
            <div v-else class="agent-empty"><h3>{{ $t('admin:agentAdmin.deploymentStateUnavailable') }}</h3><p>{{ resourceState.runtime.error }}</p><v-btn variant="tonal" :disabled="loading" @click="refreshResources(['runtime', 'profiles'])">{{ $t('admin:agentAdmin.retry') }}</v-btn></div>
          </section>
        </v-window-item>

        <v-window-item id="agent-panel-tools" value="tools" role="tabpanel" aria-labelledby="agent-tab-tools">
          <AgentAdminTools :tools="toolInventory" :loaded="dataLoaded" :loading="loading" :mcp-enabled="Boolean(runtime?.enabled && runtime?.mcpEnabled)" />
        </v-window-item>

        <v-window-item id="agent-panel-memory" value="memory" role="tabpanel" aria-labelledby="agent-tab-memory">
          <section class="agent-panel">
            <div class="agent-panel__header"><div><div class="agent-panel__eyebrow">{{ $t('admin:agentAdmin.continuitySources') }}</div><h2>{{ $t('admin:agentAdmin.knowledgeMemory') }}</h2><p>{{ $t('admin:agentAdmin.understandWhatAgentKnows') }}</p></div></div>
            <div class="agent-panel__body">
              <div class="agent-memory-sources">
                <article><v-icon icon="mdi-book-open-page-variant-outline" aria-hidden="true" /><h3>{{ $t('admin:agentAdmin.wikiKnowledge') }}</h3><p>{{ $t('admin:agentAdmin.pagesSharedSourceTruth') }}</p><a href="/a/search">{{ $t('admin:agentAdmin.configureRetrieval') }} <v-icon icon="mdi-arrow-right" size="16" aria-hidden="true" /></a></article>
                <article><v-icon icon="mdi-file-certificate-outline" aria-hidden="true" /><h3>{{ $t('admin:agentAdmin.approvedExpertise') }}</h3><p>{{ $t('admin:agentAdmin.organizationSkillsPackagePage') }}</p><button type="button" @click="tab = 'skills'">{{ $t('admin:agentAdmin.manageSkills') }} <v-icon icon="mdi-arrow-right" size="16" aria-hidden="true" /></button></article>
                <article><v-icon icon="mdi-account-lock-outline" aria-hidden="true" /><h3>{{ $t('admin:agentAdmin.personalMemory') }}</h3><p>{{ $t('admin:agentAdmin.preferencesProjectNotesBelong') }}</p><p>{{ $t('admin:agentAdmin.updatesRecalledNextConversation') }}</p></article>
              </div>
              <section class="runtime-section">
                <div class="section-heading"><div><h3>{{ $t('admin:agentAdmin.conversationRetention') }}</h3><p>{{ $t('admin:agentAdmin.historySeparatePersonalMemory') }}</p></div></div>
                <dl v-if="runtime" class="agent-retention">
                  <div><dt>{{ $t('admin:agentAdmin.temporaryConversations') }}</dt><dd>{{ $t('admin:agentAdmin.hours', { temporarySessionHours: runtime.retention.temporarySessionHours, interpolation: { escapeValue: false } }) }}</dd></div>
                  <div><dt>{{ $t('admin:agentAdmin.recentConversationsNotFolder') }}</dt><dd>{{ $t('admin:agentAdmin.daysWithoutActivity', { savedSessionDays: runtime.retention.savedSessionDays, interpolation: { escapeValue: false } }) }}</dd></div>
                  <div><dt>{{ $t('admin:agentAdmin.conversationsFolders') }}</dt><dd>{{ $t('admin:agentAdmin.keptUntilRemovedFolder') }}</dd></div>
                  <div><dt>{{ $t('admin:agentAdmin.mcpProposalContent') }}</dt><dd>{{ $t('admin:agentAdmin.days', { mcpContentDays: runtime.retention.mcpContentDays, interpolation: { escapeValue: false } }) }}</dd></div>
                  <div><dt>{{ $t('admin:agentAdmin.auditEvidence') }}</dt><dd>{{ $t('admin:agentAdmin.days2', { auditDays: runtime.retention.auditDays, interpolation: { escapeValue: false } }) }}</dd></div>
                </dl>
                <v-alert v-else type="info" variant="tonal">{{ $t('admin:agentAdmin.retentionConfigurationUnavailableRefresh') }}</v-alert>
                <p class="agent-overview__caption">{{ $t('admin:agentAdmin.expiryEnforcedMaintenanceActive') }}</p>
              </section>
            </div>
          </section>
        </v-window-item>

        <v-window-item id="agent-panel-runtime" value="runtime" role="tabpanel" aria-labelledby="agent-tab-runtime">
          <section class="agent-panel">
            <div class="agent-panel__header">
              <div class="agent-panel__heading">
                <span class="agent-panel__icon"><v-icon icon="mdi-tune-variant" size="22" aria-hidden="true" /></span>
                <div>
                  <div class="agent-panel__eyebrow">{{ $t('admin:agentAdmin.operationalEnvelope') }}</div>
                  <h2>{{ $t('admin:agentAdmin.runtimePolicy') }}</h2>
                  <p>{{ $t('admin:agentAdmin.effectiveSafeguardsCurrentlyGoverning') }}</p>
                </div>
              </div>
              <div class="agent-panel__state">
                <span>{{ $t('admin:agentAdmin.deploymentControlled') }}</span>
                <v-chip variant="tonal" :color="loading ? undefined : !runtime ? 'error' : runtime.enabled ? 'success' : 'warning'" size="small">{{ loading ? $t('admin:agentAdmin.loading') : !runtime ? $t('admin:agentAdmin.unavailable') : runtime.enabled ? $t('admin:agentAdmin.active') : $t('admin:agentAdmin.paused') }}</v-chip>
              </div>
            </div>
            <v-progress-linear v-if="loading" indeterminate :aria-label="$t('admin:agentAdmin.loadingRuntimePolicy')" />
            <div v-else-if="runtime" class="agent-panel__body">
              <v-alert type="info" variant="tonal" density="compact" class="mb-5">{{ $t('admin:agentAdmin.killSwitchesDeploymentConfiguration') }}</v-alert>
              <section class="runtime-section">
                <div class="section-heading">
                  <div><h3>{{ $t('admin:agentAdmin.capabilityMap') }}</h3><p>{{ $t('admin:agentAdmin.oneViewWhatPlatform') }}</p></div>
                  <span>{{ $t('admin:agentAdmin.enabled2', { enabledCapabilityCount, interpolation: { escapeValue: false } }) }}</span>
                </div>
                <div class="capability-map">
                  <div v-for="item in capabilityRows" :key="item.label" class="capability-item" :class="{ 'capability-item--enabled': item.enabled }">
                    <span class="capability-item__state"><v-icon :icon="item.enabled ? 'mdi-check' : 'mdi-minus'" size="15" aria-hidden="true" /></span>
                    <span>{{ item.label }}</span>
                    <small>{{ item.enabled ? $t('admin:agentAdmin.available') : $t('admin:agentAdmin.blocked') }}</small>
                  </div>
                </div>
              </section>
              <section class="runtime-section">
                <div class="section-heading"><div><h3>{{ $t('admin:agentAdmin.operatingLimits') }}</h3><p>{{ $t('admin:agentAdmin.capacityOrchestrationContinuityRetention') }}</p></div></div>
                <div class="policy-grid">
                  <article class="policy-card">
                    <div class="policy-card__title"><span><v-icon icon="mdi-gauge" size="19" aria-hidden="true" /></span><h4>{{ $t('admin:agentAdmin.capacity') }}</h4></div>
                    <dl><div><dt>{{ $t('admin:agentAdmin.concurrentRuns') }}</dt><dd>{{ $t('admin:agentAdmin.global', { globalConcurrency: runtime.quotas.globalConcurrency, interpolation: { escapeValue: false } }) }}</dd></div><div><dt>{{ $t('admin:agentAdmin.perUserRuns') }}</dt><dd>{{ runtime.quotas.perUserConcurrency }}</dd></div><div><dt>{{ $t('admin:agentAdmin.sseConnections') }}</dt><dd>{{ $t('admin:agentAdmin.perUser', { maximumSseConnectionsPerUser: runtime.quotas.maximumSseConnectionsPerUser, interpolation: { escapeValue: false } }) }}</dd></div><div><dt>{{ $t('admin:agentAdmin.reconciliation') }}</dt><dd>{{ $t('admin:agentAdmin.ms', { pollingMilliseconds: runtime.quotas.pollingMilliseconds, interpolation: { escapeValue: false } }) }}</dd></div></dl>
                  </article>
                  <article class="policy-card">
                    <div class="policy-card__title"><span><v-icon icon="mdi-account-multiple-outline" size="19" aria-hidden="true" /></span><h4>{{ $t('admin:agentAdmin.specialistResearch') }}</h4></div>
                    <dl><div><dt>{{ $t('admin:agentAdmin.concurrentSpecialists') }}</dt><dd>{{ runtime.orchestration.maxConcurrentChildren }}</dd></div><div><dt>{{ $t('admin:agentAdmin.tasksPerResponse') }}</dt><dd>{{ runtime.orchestration.maxChildren }}</dd></div><div><dt>{{ $t('admin:agentAdmin.specialistDeadline') }}</dt><dd>{{ $t('admin:agentAdmin.sec', { childTimeoutMilliseconds: runtime.orchestration.childTimeoutMilliseconds / 1000, interpolation: { escapeValue: false } }) }}</dd></div><div><dt>{{ $t('admin:agentAdmin.aggregateTokens') }}</dt><dd>{{ runtime.orchestration.maxAggregateChildTokens }}</dd></div></dl>
                  </article>
                  <article class="policy-card">
                    <div class="policy-card__title"><span><v-icon icon="mdi-target" size="19" aria-hidden="true" /></span><h4>{{ $t('admin:agentAdmin.durableGoals') }}</h4></div>
                    <dl><div><dt>{{ $t('admin:agentAdmin.continuations') }}</dt><dd>{{ runtime.goals.maxContinuations }}</dd></div><div><dt>{{ $t('admin:agentAdmin.aggregateTokens') }}</dt><dd>{{ runtime.goals.maxTokens }}</dd></div><div><dt>{{ $t('admin:agentAdmin.toolCalls') }}</dt><dd>{{ runtime.goals.maxToolCalls }}</dd></div><div><dt>{{ $t('admin:agentAdmin.maximumDuration') }}</dt><dd>{{ $t('admin:agentAdmin.min', { maxDurationMilliseconds: runtime.goals.maxDurationMilliseconds / 60000, interpolation: { escapeValue: false } }) }}</dd></div></dl>
                  </article>
                  <article class="policy-card">
                    <div class="policy-card__title"><span><v-icon icon="mdi-archive-clock-outline" size="19" aria-hidden="true" /></span><h4>{{ $t('admin:agentAdmin.retention') }}</h4></div>
                    <dl><div><dt>{{ $t('admin:agentAdmin.temporarySessions') }}</dt><dd>{{ $t('admin:agentAdmin.hr', { temporarySessionHours: runtime.retention.temporarySessionHours, interpolation: { escapeValue: false } }) }}</dd></div><div><dt>{{ $t('admin:agentAdmin.mcpProposals') }}</dt><dd>{{ $t('admin:agentAdmin.days', { mcpContentDays: runtime.retention.mcpContentDays, interpolation: { escapeValue: false } }) }}</dd></div><div><dt>{{ $t('admin:agentAdmin.auditLedger') }}</dt><dd>{{ $t('admin:agentAdmin.days2', { auditDays: runtime.retention.auditDays, interpolation: { escapeValue: false } }) }}</dd></div><div><dt>{{ $t('admin:agentAdmin.maintenanceBatch') }}</dt><dd>{{ runtime.retention.maintenanceBatchSize }}</dd></div></dl>
                  </article>
                </div>
              </section>
              <aside class="metrics-note"><span><v-icon icon="mdi-chart-timeline-variant-shimmer" size="20" aria-hidden="true" /></span><div><strong>{{ $t('admin:agentAdmin.metricsHealthRemainIsolated') }}</strong><p>{{ $t('admin:agentAdmin.runProposalArtifactUsage') }} <code>/healthz</code>.</p></div></aside>
            </div>
          </section>
        </v-window-item>

        <v-window-item id="agent-panel-profiles" value="profiles" role="tabpanel" aria-labelledby="agent-tab-profiles">
          <section class="agent-panel">
            <div class="agent-panel__header">
              <div class="agent-panel__heading">
                <span class="agent-panel__icon"><v-icon icon="mdi-brain" size="22" aria-hidden="true" /></span>
                <div>
                  <div class="agent-panel__eyebrow">{{ $t('admin:agentAdmin.inferenceFoundation') }}</div>
                  <h2>{{ $t('admin:agentAdmin.providerProfiles') }}</h2>
                  <p>{{ $t('admin:agentAdmin.connectModelsVerifyBehavior') }}</p>
                </div>
              </div>
              <v-btn color="primary" prepend-icon="mdi-plus" :disabled="runtime?.providerEnabled !== true || Boolean(actionBusyKey)" @click="openProfile()">{{ $t('admin:agentAdmin.addProvider') }}</v-btn>
            </div>
            <div class="agent-panel__body">
              <v-alert v-if="resourceState.profiles.error || resourceState.runtime.error" type="warning" variant="tonal" role="alert" class="mb-4">{{ resourceState.profiles.error || resourceState.runtime.error }} <v-btn variant="text" :disabled="loading" @click="refreshResources(['profiles', 'runtime'])">{{ $t('admin:agentAdmin.retry') }}</v-btn></v-alert>
              <v-alert v-for="(warning, id) in profileWarnings" :key="id" type="warning" variant="tonal" closable role="alert" class="mb-4" @click:close="delete profileWarnings[id]">{{ warning }}</v-alert>
              <v-progress-linear v-if="loading" indeterminate class="mb-4" :aria-label="$t('admin:agentAdmin.loadingProviderProfiles')" />
              <aside class="provider-policy-strip" :aria-label="$t('admin:agentAdmin.providerGovernance')">
                <span><v-icon icon="mdi-connection" size="17" aria-hidden="true" /><strong>{{ $t('admin:agentAdmin.verify') }}</strong>{{ $t('admin:agentAdmin.liveCapabilityCheckEvery') }}</span>
                <span><v-icon icon="mdi-key-outline" size="17" aria-hidden="true" /><strong>{{ $t('admin:agentAdmin.protect') }}</strong>{{ $t('admin:agentAdmin.credentialsRemainServerManaged') }}</span>
                <span><v-icon icon="mdi-account-lock-outline" size="17" aria-hidden="true" /><strong>{{ $t('admin:agentAdmin.scope') }}</strong>{{ $t('admin:agentAdmin.accessFollowsExplicitGrants') }}</span>
              </aside>
              <v-alert v-if="runtime?.providerEnabled === false" type="info" variant="tonal" class="mb-4">{{ $t('admin:agentAdmin.providerAdministrationUnavailableWhile') }} <code>agents.provider.enabled</code>{{ $t('admin:agentAdmin.configureProviderRuntimeKeys') }}</v-alert>
              <v-alert v-if="profiles.some(profile => !profile.secretConfigured)" type="warning" variant="tonal" class="mb-4">{{ $t('admin:agentAdmin.providerCredentialUnavailableEdit') }}</v-alert>
              <v-alert v-if="profiles.some(profile => profile.status === 'enabled' && profile.conformed && profile.exposureMode === 'all_agent_users') && !profiles.some(profile => profile.isGlobalDefault)" type="warning" variant="tonal" class="mb-4">{{ $t('admin:agentAdmin.noGlobalDefaultProvider') }} <strong>{{ $t('admin:agentAdmin.setGlobalDefault') }}</strong> {{ $t('admin:agentAdmin.beforeStartingConversation') }}</v-alert>
              <div v-if="profiles.length" class="provider-inventory-toolbar" role="search" :aria-label="$t('admin:agentAdmin.findProviderProfiles')">
                <v-text-field v-model="providerQuery" :label="$t('admin:agentAdmin.findProvider')" prepend-inner-icon="mdi-magnify" clearable hide-details />
                <v-select v-model="providerState" :items="providerStates" :label="$t('admin:agentAdmin.providerState')" hide-details />
              </div>
              <p v-if="profiles.length" class="provider-inventory-count" role="status">{{ $t('admin:agentAdmin.providers2', { filteredProfilesCount: filteredProfiles.length, profilesCount: profiles.length, interpolation: { escapeValue: false } }) }}</p>
              <div v-if="filteredProfiles.length" class="provider-grid">
                <article v-for="profile in filteredProfiles" :key="profile.id" class="provider-card">
                  <div class="provider-card__top">
                    <span class="provider-card__mark"><v-icon icon="mdi-creation-outline" size="23" aria-hidden="true" /></span>
                    <div class="provider-card__identity">
                      <div class="provider-card__name"><h3>{{ profile.displayName }}</h3><v-chip v-if="profile.isGlobalDefault" size="x-small" color="primary" variant="tonal">{{ $t('admin:agentAdmin.default') }}</v-chip></div>
                      <p>{{ agentProviderProtocolOption(profile.transportKind).title }}</p>
                    </div>
                    <v-menu>
                      <template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" icon="mdi-dots-horizontal" variant="text" density="comfortable" :aria-label="$t('admin:agentAdmin.actions', { displayName: profile.displayName, interpolation: { escapeValue: false } })" :disabled="Boolean(actionBusyKey)" /></template>
                      <v-list density="comfortable">
                        <v-list-item prepend-icon="mdi-pencil-outline" :title="$t('admin:agentAdmin.editSettings')" :subtitle="$t('admin:agentAdmin.updatesProfile')" :disabled="Boolean(actionBusyKey)" @click="openProfile(profile)" />
                        <v-list-item prepend-icon="mdi-history" :title="$t('admin:agentAdmin.connectionHistory')" :subtitle="$t('admin:agentAdmin.reviewPreviousVerificationResults')" @click="openConnectionHistory(profile)" />
                        <v-list-item prepend-icon="mdi-connection" :title="profile.status === 'disabled' ? $t('admin:agentAdmin.testEnable') : $t('admin:agentAdmin.testConnection')" :subtitle="connectionActionSubtitle(profile)" :disabled="!profile.secretConfigured || Boolean(actionBusyKey)" @click="testConnection(profile)" />
                        <v-list-item prepend-icon="mdi-account-multiple-outline" :title="$t('admin:agentAdmin.editAccessGrants')" :subtitle="$t('admin:agentAdmin.changesProfileVisibility')" :disabled="Boolean(actionBusyKey)" @click="openGrants(profile)" />
                        <v-list-item v-if="profile.status === 'disabled'" prepend-icon="mdi-play-circle-outline" :title="$t('admin:agentAdmin.enableProvider')" :subtitle="enableProfileSubtitle(profile)" :disabled="!profile.conformed || !profile.secretConfigured || Boolean(actionBusyKey)" @click="confirmEnableProfile(profile)" />
                        <v-list-item v-else prepend-icon="mdi-pause-circle-outline" :title="$t('admin:agentAdmin.disableProvider')" :subtitle="profile.isGlobalDefault ? $t('admin:agentAdmin.clearsWorkspaceDefaultStops') : $t('admin:agentAdmin.stopsNewRunsUsing')" :disabled="Boolean(actionBusyKey)" @click="setProfileEnabled(profile, false)" />
                        <v-list-item prepend-icon="mdi-star-outline" :title="$t('admin:agentAdmin.setGlobalDefault')" :subtitle="$t('admin:agentAdmin.makesWorkspaceFallback')" :disabled="!profile.conformed || profile.status !== 'enabled' || profile.exposureMode !== 'all_agent_users' || profile.isGlobalDefault || Boolean(actionBusyKey)" @click="setDefault(profile)" />
                        <v-divider class="my-1" />
                        <v-list-item prepend-icon="mdi-delete-outline" :title="$t('admin:agentAdmin.removeProvider')" :subtitle="$t('admin:agentAdmin.permanentlyDeletesCredential')" base-color="error" :disabled="Boolean(actionBusyKey)" @click="confirmRemove(profile)" />
                      </v-list>
                    </v-menu>
                  </div>
                  <div class="provider-card__status">
                    <span :class="['connection-state', `connection-state--${profile.conformed ? 'success' : profile.connectionCheck?.status === 'failed' ? 'error' : 'neutral'}`]">
                      <v-icon :icon="profile.conformed ? 'mdi-check-circle' : profile.connectionCheck?.status === 'failed' ? 'mdi-alert-circle' : 'mdi-clock-outline'" size="15" aria-hidden="true" />
                      {{ profile.conformed ? $t('admin:agentAdmin.connectionVerified') : profile.connectionCheck?.status === 'failed' ? $t('admin:agentAdmin.connectionFailed') : $t('admin:agentAdmin.notVerified') }}
                    </span>
                    <span :class="['connection-state', profile.status === 'enabled' ? 'connection-state--success' : 'connection-state--neutral']"><span class="connection-state__dot" />{{ profile.status === 'enabled' ? $t('admin:agentAdmin.enabled') : $t('admin:agentAdmin.disabled') }}</span>
                  </div>
                  <time v-if="profile.connectionCheck" class="provider-card__checked" :datetime="profile.connectionCheck.completedAt">{{ $t('admin:agentAdmin.lastChecked', { completedAt: formatConnectionCheckDate(profile.connectionCheck.completedAt), interpolation: { escapeValue: false } }) }}</time>
                  <div class="provider-card__models">
                    <div><span>{{ $t('admin:agentAdmin.agentModel') }}</span><code :title="profile.model">{{ profile.model }}</code></div>
                    <div><span>{{ $t('admin:agentAdmin.utilityModel') }}</span><code :title="profile.utilityModel || profile.model">{{ profile.utilityModel || profile.model }}</code><small v-if="!profile.utilityModel">{{ $t('admin:agentAdmin.shared') }}</small></div>
                  </div>
                  <p v-if="!profile.conformed && profile.connectionCheck?.message" class="provider-card__error">{{ profile.connectionCheck.message }}</p>
                  <div class="provider-card__meta">
                    <div><v-icon icon="mdi-account-multiple-outline" size="17" aria-hidden="true" /><span><small>{{ $t('admin:agentAdmin.available2') }}</small><strong>{{ profile.exposureMode === 'all_agent_users' ? $t('admin:agentAdmin.everyone') : groupNames(profile.groupIds) }}</strong></span></div>
                    <div><v-icon icon="mdi-server-outline" size="17" aria-hidden="true" /><span><small>{{ $t('admin:agentAdmin.destination') }}</small><strong>{{ profile.destinationHost }}</strong></span></div>
                  </div>
                  <button type="button" class="provider-card__edit" :disabled="Boolean(actionBusyKey)" @click="openProfile(profile)">{{ $t('admin:agentAdmin.openConfiguration') }} <v-icon icon="mdi-arrow-right" size="17" aria-hidden="true" /></button>
                </article>
              </div>
              <div v-else-if="profiles.length" class="agent-empty">
                <h3>{{ $t('admin:agentAdmin.noProvidersMatch') }}</h3><p>{{ $t('admin:agentAdmin.tryAnotherModelName') }}</p>
                <v-btn variant="tonal" @click="providerQuery = ''; providerState = 'all'">{{ $t('admin:agentAdmin.clearFilters') }}</v-btn>
              </div>
              <div v-else-if="resourceState.profiles.loaded" class="agent-empty">
                <span class="agent-empty__icon"><v-icon icon="mdi-brain" size="34" aria-hidden="true" /></span>
                <h3>{{ $t('admin:agentAdmin.connectFirstProvider') }}</h3>
                <p>{{ $t('admin:agentAdmin.startModelTeamTrusts') }}</p>
                <v-btn color="primary" prepend-icon="mdi-plus" :disabled="runtime?.providerEnabled !== true || Boolean(actionBusyKey)" @click="openProfile()">{{ $t('admin:agentAdmin.addProvider') }}</v-btn>
              </div>
              <v-skeleton-loader v-else-if="resourceState.profiles.loading" type="article" />
              <div v-else class="agent-empty"><h3>{{ $t('admin:agentAdmin.providerDataUnavailable') }}</h3><p>{{ resourceState.profiles.error }}</p><v-btn variant="tonal" @click="refreshResources(['profiles'])">{{ $t('admin:agentAdmin.retry') }}</v-btn></div>
            </div>
          </section>
        </v-window-item>

        <v-window-item id="agent-panel-skills" value="skills" role="tabpanel" aria-labelledby="agent-tab-skills">
          <v-alert v-if="runtime && !runtime.skillsEnabled" type="info" variant="tonal" class="mb-4">{{ $t('admin:agentAdmin.skillsDisabledDeploymentConfiguration') }}</v-alert>
          <SkillAdmin :csrf-token="csrfToken" embedded />
        </v-window-item>

        <v-window-item id="agent-panel-browser" value="browser" role="tabpanel" aria-labelledby="agent-tab-browser">
          <section class="agent-panel">
            <div class="agent-panel__header">
              <div class="agent-panel__heading">
                <span class="agent-panel__icon agent-panel__icon--teal"><v-icon icon="mdi-web-check" size="22" aria-hidden="true" /></span>
                <div>
                  <div class="agent-panel__eyebrow">{{ $t('admin:agentAdmin.networkBoundary') }}</div>
                  <h2>{{ $t('admin:agentAdmin.browserAccess') }}</h2>
                  <p>{{ $t('admin:agentAdmin.approveExactHttpsDestinations') }}</p>
                </div>
              </div>
              <v-btn color="primary" prepend-icon="mdi-plus" :disabled="Boolean(actionBusyKey)" @click="openBrowserDialog">{{ $t('admin:agentAdmin.addTarget') }}</v-btn>
            </div>
            <div class="agent-panel__body">
              <v-alert v-if="resourceState.browser.error || resourceState.runtime.error" type="warning" variant="tonal" role="alert" class="mb-4">{{ resourceState.browser.error || resourceState.runtime.error }} <v-btn variant="text" :disabled="loading" @click="refreshResources(['browser', 'runtime'])">{{ $t('admin:agentAdmin.retry') }}</v-btn></v-alert>
              <v-progress-linear v-if="loading" indeterminate class="mb-4" :aria-label="$t('admin:agentAdmin.loadingBrowserTargets')" />
              <v-alert v-if="runtime?.browserEnabled === false" type="info" variant="tonal" density="compact" class="mb-4">{{ $t('admin:agentAdmin.isolatedBrowserPausedDeployment') }}</v-alert>
              <aside class="browser-boundary-note">
                <v-icon icon="mdi-shield-key-outline" size="19" aria-hidden="true" />
                <span><strong>{{ $t('admin:agentAdmin.exactDestinationsOnly') }}</strong> {{ $t('admin:agentAdmin.eachHttpsUrlCanonicalized') }}</span>
              </aside>
              <div v-if="browserTargets.length" class="provider-inventory-toolbar" role="search" :aria-label="$t('admin:agentAdmin.findBrowserDestinations')">
                <v-text-field v-model="browserQuery" :label="$t('admin:agentAdmin.findDestination')" prepend-inner-icon="mdi-magnify" clearable hide-details />
                <v-select v-model="browserState" :label="$t('admin:agentAdmin.destinationState')" :items="[{ title: $t('admin:agentAdmin.allDestinations'), value: 'all' }, { title: $t('admin:agentAdmin.allowed'), value: 'allowed' }, { title: $t('admin:agentAdmin.paused'), value: 'paused' }]" hide-details />
              </div>
              <p v-if="browserTargets.length" class="provider-inventory-count" role="status">{{ $t('admin:agentAdmin.destinations', { filteredBrowserTargetsCount: filteredBrowserTargets.length, browserTargetsCount: browserTargets.length, interpolation: { escapeValue: false } }) }}</p>
              <div v-if="filteredBrowserTargets.length" class="target-list">
                <article v-for="target in filteredBrowserTargets" :key="target.id" class="target-row">
                  <span class="target-row__icon"><v-icon icon="mdi-lock-outline" size="20" aria-hidden="true" /></span>
                  <div class="target-row__copy"><strong :title="target.canonicalUrl">{{ target.canonicalUrl }}</strong><small :title="$t('admin:agentAdmin.policy', { policySha256: target.policySha256, interpolation: { escapeValue: false } })">{{ $t('admin:agentAdmin.policy2', { policySha256: target.policySha256.slice(0, 16), interpolation: { escapeValue: false } }) }}</small></div>
                  <div class="target-row__state"><span>{{ target.enabled ? $t('admin:agentAdmin.allowed') : $t('admin:agentAdmin.paused') }}</span><v-switch :model-value="target.enabled" color="primary" hide-details inset :loading="actionBusyKey === `browser:${target.id}`" :disabled="Boolean(actionBusyKey)" :aria-label="$t('admin:agentAdmin.browserTarget', { enabled: target.enabled ? $t('admin:agentAdmin.pause') : $t('admin:agentAdmin.allow'), canonicalUrl: target.canonicalUrl, interpolation: { escapeValue: false } })" @update:model-value="value => setBrowserEnabled(target, Boolean(value))" /></div>
                </article>
              </div>
              <div v-else-if="browserTargets.length" class="agent-empty">
                <h3>{{ $t('admin:agentAdmin.noDestinationsMatch') }}</h3><v-btn variant="tonal" @click="browserQuery = ''; browserState = 'all'">{{ $t('admin:agentAdmin.clearFilters') }}</v-btn>
              </div>
              <div v-else-if="resourceState.browser.loaded" class="agent-empty">
                <span class="agent-empty__icon agent-empty__icon--teal"><v-icon icon="mdi-web-off" size="34" aria-hidden="true" /></span>
                <h3>{{ $t('admin:agentAdmin.noBrowserDestinationsApproved') }}</h3>
                <v-btn color="primary" prepend-icon="mdi-plus" :disabled="Boolean(actionBusyKey)" @click="openBrowserDialog">{{ $t('admin:agentAdmin.addTarget') }}</v-btn>
              </div>
              <v-skeleton-loader v-else-if="resourceState.browser.loading" type="article" />
              <div v-else class="agent-empty"><h3>{{ $t('admin:agentAdmin.browserDataUnavailable') }}</h3><p>{{ resourceState.browser.error }}</p><v-btn variant="tonal" @click="refreshResources(['browser'])">{{ $t('admin:agentAdmin.retry') }}</v-btn></div>
            </div>
          </section>
        </v-window-item>
      </v-window>
    </div>

    <v-dialog v-model="connectionHistoryDialog" max-width="46rem" scrollable aria-labelledby="connection-history-title">
      <v-card class="compact-dialog">
        <div class="compact-dialog__header"><span><v-icon icon="mdi-history" aria-hidden="true" /></span><div><h2 id="connection-history-title">{{ $t('admin:agentAdmin.connectionHistory') }}</h2><p>{{ $t('admin:agentAdmin.latest20Checks', { displayName: connectionHistoryProfile?.displayName, interpolation: { escapeValue: false } }) }}</p></div></div>
        <v-card-text>
          <v-progress-linear v-if="connectionHistoryLoading" indeterminate :aria-label="$t('admin:agentAdmin.loadingConnectionHistory')" />
          <v-alert v-else-if="connectionHistoryError" type="error" variant="tonal">{{ connectionHistoryError }}<template #append><v-btn variant="text" @click="loadConnectionHistory">{{ $t('admin:agentAdmin.retry') }}</v-btn></template></v-alert>
          <p v-else-if="!connectionHistory.length">{{ $t('admin:agentAdmin.noConnectionChecksHave') }}</p>
          <div v-else class="connection-history">
            <details v-for="check in connectionHistory" :key="check.id">
              <summary><v-icon :icon="check.status === 'passed' ? 'mdi-check-circle-outline' : 'mdi-alert-circle-outline'" :color="check.status === 'passed' ? 'success' : 'error'" size="20" aria-hidden="true" /><strong>{{ check.status === 'passed' ? $t('admin:agentAdmin.passed') : $t('admin:agentAdmin.failed') }}</strong><time :datetime="check.completedAt">{{ formatConnectionCheckDate(check.completedAt) }}</time></summary>
              <p v-if="check.message">{{ check.message }}</p>
              <ul><li v-for="probe in check.checks" :key="probe.name"><strong>{{ probe.passed ? $t('admin:agentAdmin.passed') : $t('admin:agentAdmin.failed') }} · {{ probe.name }}</strong><p v-if="probe.detail">{{ probe.detail }}</p></li></ul>
            </details>
          </div>
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn @click="connectionHistoryDialog = false">{{ $t('common:actions.close') }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog :model-value="profileDialog" max-width="76rem" scrollable :fullscreen="smAndDown" :persistent="saving" aria-labelledby="provider-profile-title" @update:model-value="onProfileDialogModelValue">
      <v-card class="profile-editor" :aria-busy="saving">
        <div class="profile-editor__header">
          <span class="profile-editor__mark"><v-icon icon="mdi-creation-outline" size="24" aria-hidden="true" /></span>
          <div class="profile-editor__title">
            <div class="agent-panel__eyebrow">{{ editingProfile ? $t('admin:agentAdmin.providerConfiguration') : $t('admin:agentAdmin.newInferenceConnection') }}</div>
            <h2 id="provider-profile-title">{{ editingProfile ? $t('admin:agentAdmin.edit', { displayName: editingProfile.displayName, interpolation: { escapeValue: false } }) : $t('admin:agentAdmin.addProviderProfile') }}</h2>
            <p>{{ editingProfile ? $t('admin:agentAdmin.updateConnectionModelsOperating') : $t('admin:agentAdmin.guidedSetupSecureVerified') }}</p>
          </div>
          <v-spacer />
          <v-chip v-if="saving" class="profile-editor__change" size="small" color="primary" variant="tonal" prepend-icon="mdi-connection">{{ smAndDown ? $t('admin:agentAdmin.saving') : $t('admin:agentAdmin.savingVerifying') }}</v-chip>
          <v-chip v-else-if="profileDirty" class="profile-editor__change" size="small" color="warning" variant="tonal" prepend-icon="mdi-circle-edit-outline">{{ smAndDown ? $t('admin:agentAdmin.unsaved') : $t('admin:agentAdmin.unsavedChanges') }}</v-chip>
          <v-chip v-else-if="!editingProfile" class="profile-editor__change" size="small" variant="outlined" prepend-icon="mdi-file-edit-outline">{{ $t('admin:agentAdmin.unsaved') }}</v-chip>
          <v-chip v-else class="profile-editor__change" size="small" variant="outlined" prepend-icon="mdi-check-circle-outline">{{ smAndDown ? $t('admin:agentAdmin.saved') : $t('admin:agentAdmin.noPendingChanges') }}</v-chip>
          <v-btn icon="mdi-close" variant="text" :aria-label="$t('admin:agentAdmin.closeProviderEditor')" :disabled="saving" @click="requestProfileClose" />
        </div>
        <v-progress-linear class="profile-editor__progress" color="primary" :model-value="profileProgress" :aria-label="$t('admin:agentAdmin.providerSetupProgress')" />
        <div class="profile-editor__workspace">
          <nav ref="profileRail" class="profile-steps" :aria-label="$t('admin:agentAdmin.providerSetupSections')">
            <button v-for="(step, index) in profileSteps" :key="step.value" type="button" :class="{ 'profile-step--active': profileStep === step.value }" :aria-current="profileStep === step.value ? 'step' : undefined" :aria-disabled="!canNavigateProfileStep(index)" @click="navigateProfileStep(index)">
              <span class="profile-step__index">{{ index + 1 }}</span>
              <span><strong>{{ step.title }}</strong><small>{{ step.description }}</small></span>
              <v-icon icon="mdi-chevron-right" size="17" aria-hidden="true" />
            </button>
          </nav>
          <v-form id="provider-profile-form" class="profile-editor__form" @submit.prevent="submitProfileStep">
            <v-alert v-if="profileError" type="error" variant="tonal" density="compact" class="mb-5" closable role="alert" @click:close="profileError = ''">{{ profileError }}</v-alert>

            <section v-if="profileStep === 'identity'" class="profile-form-section">
              <div class="profile-form-section__intro"><span><v-icon icon="mdi-card-account-details-outline" size="21" aria-hidden="true" /></span><div><h3>{{ $t('admin:agentAdmin.nameConnection') }}</h3><p>{{ $t('admin:agentAdmin.chooseApiContractFirst') }}</p></div></div>
              <div class="form-grid">
                <v-text-field v-model="profileDraft.displayName" :rules="profileDisplayNameRules" :label="$t('admin:agentAdmin.displayName')" maxlength="255" counter="255" required autofocus />
                <div class="protocol-field">
                  <v-select :model-value="profileDraft.transportKind" :items="protocolOptions" :label="$t('admin:agentAdmin.apiProtocol')" required @update:model-value="selectProtocol">
                    <template #item="{ props: itemProps, internalItem }">
                      <v-list-subheader v-if="internalItem.raw.startsGroup">{{ internalItem.raw.group }}</v-list-subheader>
                      <v-list-item v-bind="itemProps" :title="internalItem.raw.title" :subtitle="internalItem.raw.description" />
                    </template>
                  </v-select>
                  <div class="field-note"><v-icon icon="mdi-information-outline" size="16" aria-hidden="true" /><span>{{ $t('admin:agentAdmin.requestsUse', { description: selectedProtocol.description, interpolation: { escapeValue: false } }) }} <code>{{ selectedProtocol.endpoint }}</code>.</span></div>
                </div>
              </div>
              <aside class="selection-preview"><span class="selection-preview__icon"><v-icon icon="mdi-api" size="22" aria-hidden="true" /></span><div><small>{{ $t('admin:agentAdmin.selectedProtocol') }}</small><strong>{{ selectedProtocol.title }}</strong><p>{{ selectedProtocol.group }} · {{ selectedProtocol.endpoint }}</p></div></aside>
            </section>

            <section v-else-if="profileStep === 'models'" class="profile-form-section">
              <div class="profile-form-section__intro"><span><v-icon icon="mdi-brain" size="21" aria-hidden="true" /></span><div><h3>{{ $t('admin:agentAdmin.assignModelRoles') }}</h3><p>{{ $t('admin:agentAdmin.useOneCapableModel') }}</p></div></div>
              <div class="form-grid">
                <v-text-field v-model="profileDraft.model" :rules="profileModelRules" :label="$t('admin:agentAdmin.agentModel')" :hint="agentModelHint" maxlength="255" persistent-hint required />
                <v-text-field v-model="profileDraft.utilityModel" :label="$t('admin:agentAdmin.utilityModelOptional')" :hint="$t('admin:agentAdmin.titlesEnrichmentClassificationRouting')" maxlength="255" persistent-hint />
              </div>
              <div v-if="reasoningEffortOptions.length > 1" class="subsection-card">
                <div class="subsection-card__heading"><div><h4>{{ $t('admin:agentAdmin.reasoningEffort') }}</h4><p>{{ reasoningSupportHint }}</p></div><v-icon icon="mdi-head-cog-outline" size="20" aria-hidden="true" /></div>
                <div class="form-grid">
                  <v-select v-model="profileDraft.agentReasoningEffort" :items="reasoningEffortOptions" :label="$t('admin:agentAdmin.agentReasoning')" :hint="$t('admin:agentAdmin.depthAnswersWikiActions')" persistent-hint />
                  <v-select v-model="profileDraft.utilityReasoningEffort" :items="reasoningEffortOptions" :label="$t('admin:agentAdmin.utilityReasoning')" :hint="$t('admin:agentAdmin.independentDepthBoundedTasks')" persistent-hint />
                </div>
              </div>
              <div v-if="profileDraft.transportKind === 'gemini-api'" class="subsection-card">
                <div class="subsection-card__heading"><div><h4>{{ $t('admin:agentAdmin.mediaAttachments') }}</h4><p>{{ $t('admin:agentAdmin.chooseWhatProviderMakes') }}</p></div><v-icon icon="mdi-image-outline" size="20" aria-hidden="true" /></div>
                <v-switch v-model="profileDraft.mediaAttachments" :label="$t('admin:agentAdmin.pdfImageAttachments')" color="primary" hide-details />
                <p class="text-body-2 mb-2">{{ $t('admin:agentAdmin.attachUpFourFiles') }}</p>
                <details class="media-storage-help mb-3">
                  <summary>{{ $t('admin:agentAdmin.privacyRetentionStorage') }}</summary>
                  <dl>
                    <dt>{{ $t('admin:agentAdmin.privacyLimits') }}</dt><dd>{{ $t('admin:agentAdmin.filesStayPrivateConversation') }}</dd>
                    <dt>{{ $t('admin:agentAdmin.conversationRetention') }}</dt><dd>{{ $t('admin:agentAdmin.originalsGeneratedMediaFollow') }}</dd>
                    <dt>{{ $t('admin:agentAdmin.storage') }}</dt><dd>{{ $t('admin:agentAdmin.savedOriginalsLimited1') }}</dd>
                  </dl>
                </details>
                <v-switch v-model="profileDraft.mediaImages" :label="$t('admin:agentAdmin.imageCreationEditing')" color="primary" hide-details />
                <div v-if="profileDraft.mediaImages" class="form-grid mt-3">
                  <v-text-field model-value="gemini-3.1-flash-image" :label="$t('admin:agentAdmin.imageModel')" readonly hide-details />
                  <span class="text-body-2">{{ $t('admin:agentAdmin.generateImagesChatEdit') }}</span>
                  <v-text-field v-model="profileDraft.imageInputRate" :rules="[mediaRateRule]" :label="$t('admin:agentAdmin.imageInputRate')" :hint="$t('admin:agentAdmin.microdollarsPerMillionTokens')" persistent-hint inputmode="numeric" />
                  <v-text-field v-model="profileDraft.imageOutputRate" :rules="[mediaRateRule]" :label="$t('admin:agentAdmin.imageOutputRate')" :hint="$t('admin:agentAdmin.microdollarsPerMillionTokens2')" persistent-hint inputmode="numeric" />
                </div>
                <v-switch v-model="profileDraft.mediaVideo" :label="$t('admin:agentAdmin.videoCreation')" color="primary" hide-details />
                <div v-if="profileDraft.mediaVideo" class="mt-3">
                  <p class="text-body-2 mb-3"><code>gemini-omni-1.1-flash</code> {{ $t('admin:agentAdmin.n310SecondLandscape') }}</p>
                  <div class="form-grid">
                    <v-text-field v-model="profileDraft.videoInputRate" :rules="[mediaRateRule]" :label="$t('admin:agentAdmin.videoInputRate')" :hint="$t('admin:agentAdmin.microdollarsPerMillionInput')" persistent-hint inputmode="numeric" />
                    <v-text-field v-model="profileDraft.videoOutputRate" :rules="[mediaRateRule]" :label="$t('admin:agentAdmin.videoOutputRate')" :hint="$t('admin:agentAdmin.microdollarsPerMillionVideo')" persistent-hint inputmode="numeric" />
                    <v-text-field v-model="profileDraft.videoTextOutputRate" :rules="[mediaRateRule]" :label="$t('admin:agentAdmin.videoTextOutputRate')" :hint="$t('admin:agentAdmin.microdollarsPerMillionText')" persistent-hint inputmode="numeric" />
                  </div>
                  <p class="text-body-2 mb-3">{{ $t('admin:agentAdmin.usageEstimatedWhenGoogle') }}</p>
                </div>
                <v-switch v-model="profileDraft.mediaMusic" :label="$t('admin:agentAdmin.musicCreation')" color="primary" hide-details />
                <div v-if="profileDraft.mediaMusic" class="mt-3">
                  <p class="text-body-2 mb-3"><code>lyria-3.5</code> {{ $t('admin:agentAdmin.newMp3CompositionsText') }}</p>
                  <v-text-field v-model="profileDraft.musicSongRate" :rules="[(value: string) => mediaRateValid(value) || $t('admin:agentAdmin.enterPositiveWholeNumber2')]" :label="$t('admin:agentAdmin.costPerSong')" :hint="$t('admin:agentAdmin.microdollarsPerSong80')" persistent-hint inputmode="numeric" />
                  <p class="text-body-2 mb-3">{{ $t('admin:agentAdmin.eachCompletedCompositionCharged') }}</p>
                </div>
                <v-switch v-model="profileDraft.mediaSpeech" :label="$t('admin:agentAdmin.speechInput')" color="primary" hide-details />
                <div v-if="profileDraft.mediaSpeech" class="form-grid mt-3">
                  <v-text-field model-value="gemini-3.5-transcribe" :label="$t('admin:agentAdmin.transcriptionModel')" readonly hide-details />
                  <span class="text-body-2">{{ $t('admin:agentAdmin.recordShortMessageThen') }}</span>
                  <v-text-field v-model="profileDraft.speechInputRate" :rules="[mediaRateRule]" :label="$t('admin:agentAdmin.speechInputRate')" :hint="$t('admin:agentAdmin.microdollarsPerMillionAudio')" persistent-hint inputmode="numeric" />
                  <v-text-field v-model="profileDraft.speechOutputRate" :rules="[mediaRateRule]" :label="$t('admin:agentAdmin.speechOutputRate')" :hint="$t('admin:agentAdmin.microdollarsPerMillionOutput')" persistent-hint inputmode="numeric" />
                </div>
                <p class="text-body-2 mt-3">{{ $t('admin:agentAdmin.usesProfilesGoogleCredential') }}</p>
              </div>
              <div class="subsection-card">
                <div class="subsection-card__heading"><div><h4>{{ $t('admin:agentAdmin.toolCalling') }}</h4><p>{{ $t('admin:agentAdmin.howModelInvokesGoverned') }}</p></div><v-icon icon="mdi-tools" size="20" aria-hidden="true" /></div>
                <v-select v-model="profileDraft.toolCalling" :items="toolCallingOptions" :label="$t('admin:agentAdmin.toolCalling')" :disabled="profileDraft.transportKind === 'legacy-completions'" :hint="$t('admin:agentAdmin.nativeUsesApiContract')" persistent-hint @update:model-value="selectToolCalling" />
              </div>
            </section>

            <section v-else-if="profileStep === 'connection'" class="profile-form-section">
              <div class="profile-form-section__intro"><span><v-icon icon="mdi-connection" size="21" aria-hidden="true" /></span><div><h3>{{ $t('admin:agentAdmin.secureConnection') }}</h3><p>{{ $t('admin:agentAdmin.credentialsStayServerManaged') }}</p></div></div>
              <div class="form-grid">
                <v-text-field v-model="profileDraft.baseUrl" :rules="providerBaseUrlRules" :label="$t('admin:agentAdmin.baseUrl')" :hint="$t('admin:agentAdmin.publicHttpsApiRoot')" persistent-hint autocomplete="url" spellcheck="false" required />
                <v-select v-if="availableAuthModes.length > 1" v-model="profileDraft.authMode" :items="availableAuthModes" :label="$t('admin:agentAdmin.authenticationMode')" />
                <v-text-field class="secret-field" v-model="profileDraft.secretValue" :rules="profileSecretRules" :label="$t('admin:agentAdmin.apiKey')" type="password" autocomplete="new-password" :hint="editingProfile && editingProfile.secretConfigured ? $t('admin:agentAdmin.leaveBlankRetainCurrent') : $t('admin:agentAdmin.encryptedServerManagedProvider')" persistent-hint :required="!editingProfile || !editingProfile.secretConfigured" prepend-inner-icon="mdi-key-outline" />
              </div>
              <div class="protocol-behavior">
                <div class="protocol-behavior__heading"><span><v-icon icon="mdi-shield-check-outline" size="19" aria-hidden="true" /></span><div><h4>{{ $t('admin:agentAdmin.protocolDerivedBehavior') }}</h4><p>{{ $t('admin:agentAdmin.wikiVerifiesProviderConnection') }}</p></div></div>
                <dl class="protocol-summary">
                  <div v-for="row in protocolBehaviorRows" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div>
                </dl>
              </div>
            </section>

            <section v-else-if="profileStep === 'access'" class="profile-form-section">
              <div class="profile-form-section__intro"><span><v-icon icon="mdi-account-multiple-outline" size="21" aria-hidden="true" /></span><div><h3>{{ $t('admin:agentAdmin.chooseAudience') }}</h3><p>{{ $t('admin:agentAdmin.makeProfileWorkspaceOption') }}</p></div></div>
              <div class="access-choice" role="radiogroup" :aria-label="$t('admin:agentAdmin.chooseAudience')">
                <label v-for="mode in exposureModes" :key="mode.value" class="access-choice__item" :class="{ 'access-choice__item--active': profileDraft.exposureMode === mode.value }">
                  <input v-model="profileDraft.exposureMode" type="radio" name="provider-exposure" :value="mode.value">
                  <span class="access-choice__icon"><v-icon :icon="mode.value === 'all_agent_users' ? 'mdi-account-group-outline' : 'mdi-account-lock-outline'" size="23" aria-hidden="true" /></span>
                  <span><strong>{{ mode.title }}</strong><small>{{ mode.value === 'all_agent_users' ? $t('admin:agentAdmin.everyUserAgentPermission') : $t('admin:agentAdmin.onlyMembersGroupsYou') }}</small></span>
                  <v-icon :icon="profileDraft.exposureMode === mode.value ? 'mdi-radiobox-marked' : 'mdi-radiobox-blank'" class="access-choice__check" size="20" aria-hidden="true" />
                </label>
              </div>
              <v-autocomplete v-if="profileDraft.exposureMode === 'groups'" v-model="profileDraft.groupIds" class="mt-5" :items="groups" item-title="name" item-value="id" :label="$t('admin:agentAdmin.wikiGroups')" multiple chips closable-chips :hint="$t('admin:agentAdmin.usersReceiveProviderThrough')" persistent-hint />
              <div v-if="profileDraft.exposureMode === 'groups' && (resourceState.groups.error || !groups.length)" class="field-note" role="status">
                <template v-if="resourceState.groups.error">{{ resourceState.groups.error }} <v-btn variant="text" :disabled="resourceState.groups.loading" @click="refreshResources(['groups'])">{{ $t('admin:agentAdmin.retry') }}</v-btn></template>
                <template v-else-if="resourceState.groups.loaded">{{ $t('admin:agentAdmin.noWikiGroupsYet') }} <router-link to="/a/groups">{{ $t('admin:agentAdmin.manageWikiGroups') }}</router-link></template>
                <template v-else>{{ $t('admin:agentAdmin.loading') }}</template>
              </div>
            </section>

            <section v-else class="profile-form-section">
              <div class="profile-form-section__intro"><span><v-icon icon="mdi-gauge" size="21" aria-hidden="true" /></span><div><h3>{{ $t('admin:agentAdmin.advancedLimitsQuotas') }}</h3><p>{{ $t('admin:agentAdmin.boundContextOutputRetries') }}</p></div></div>
              <v-alert type="info" variant="tonal" density="compact" class="mb-5">{{ $t('admin:agentAdmin.theseSafeDefaultsSuit') }}</v-alert>
              <div class="limit-group">
                <h4>{{ $t('admin:agentAdmin.modelBoundaries') }}</h4>
                <div class="form-grid"><v-text-field v-model.number="profileDraft.maxContextTokens" type="number" min="1024" max="10000000" step="1" :rules="profileRules.maxContextTokens" :label="$t('admin:agentAdmin.maximumContextTokens')" /><v-text-field v-model.number="profileDraft.maxOutputTokens" type="number" min="1" max="1000000" step="1" :rules="profileRules.maxOutputTokens" :label="$t('admin:agentAdmin.maximumOutputTokens')" /></div>
              </div>
              <div class="limit-group">
                <h4>{{ $t('admin:agentAdmin.dailyCeilings') }}</h4>
                <div class="form-grid"><v-text-field v-model.number="profileDraft.dailyTokens" type="number" min="1" max="1000000000" step="1" :rules="profileRules.dailyTokens" :label="$t('admin:agentAdmin.dailyTokenLimit')" /><v-text-field v-model.number="profileDraft.dailyCostMicros" type="number" min="1" step="1" :rules="profileRules.dailyCostMicros" :label="$t('admin:agentAdmin.dailyCostReservationMicros')" /></div>
              </div>
              <div class="limit-group">
                <h4>{{ $t('admin:agentAdmin.perRunReservations') }}</h4>
                <div class="form-grid"><v-text-field v-model.number="profileDraft.reservationTokens" type="number" min="1" max="10000000" step="1" :rules="profileRules.reservationTokens" :label="$t('admin:agentAdmin.tokenReservation')" /><v-text-field v-model.number="profileDraft.reservationCostMicros" type="number" min="1" step="1" :rules="profileRules.reservationCostMicros" :label="$t('admin:agentAdmin.costReservationMicros')" /></div>
              </div>
              <div class="limit-group">
                <h4>{{ $t('admin:agentAdmin.reliability') }}</h4>
                <div class="form-grid"><v-text-field v-model.number="profileDraft.timeoutMs" type="number" min="1000" max="300000" step="1" :rules="profileRules.timeoutMs" :label="$t('admin:agentAdmin.requestTimeoutMs')" /><v-text-field v-model.number="profileDraft.maxAttempts" type="number" min="1" max="10" step="1" :rules="profileRules.maxAttempts" :label="$t('admin:agentAdmin.maximumAttempts')" /></div>
              </div>
            </section>
          </v-form>
        </div>
        <div class="profile-editor__footer">
          <div class="profile-editor__position">
            <strong>{{ currentProfileStep.title }}</strong>
            <span>{{ $t('admin:agentAdmin.of', { value: profileStepIndex + 1, profileStepsCount: profileSteps.length, value2: profileDirty ? $t('admin:agentAdmin.changesNotYetSaved') : $t('admin:agentAdmin.draftMatchesSavedState'), interpolation: { escapeValue: false } }) }}</span>
          </div>
          <div class="profile-editor__save-state" role="status" aria-live="polite">
            <v-icon :icon="saving ? 'mdi-progress-clock' : profileDirty ? 'mdi-circle-edit-outline' : 'mdi-shield-check-outline'" size="17" aria-hidden="true" />
            <span>{{ profileSaveState }}</span>
          </div>
          <v-spacer />
          <v-btn variant="text" :disabled="saving" @click="requestProfileClose">{{ $t('common:actions.cancel') }}</v-btn>
          <v-btn variant="text" :disabled="saving || !profileDirty" prepend-icon="mdi-restore" @click="resetProfileDraft">{{ $t('admin:agentAdmin.reset') }}</v-btn>
          <v-btn v-if="profileStepIndex > 0" variant="outlined" prepend-icon="mdi-arrow-left" :disabled="saving" @click="previousProfileStep">{{ $t('admin:agentAdmin.back') }}</v-btn>
          <v-btn v-if="!editingProfile && profileStepIndex < profileSteps.length - 1" variant="tonal" color="primary" append-icon="mdi-arrow-right" :disabled="saving || !profileStepValid" form="provider-profile-form" type="submit">{{ $t('admin:agentAdmin.continue') }}</v-btn>
          <v-btn v-else color="primary" prepend-icon="mdi-check-decagram-outline" :loading="saving" :disabled="saving || !profileDraftValid || !profileDirty" type="button" @click="saveProfile">{{ $t('admin:agentAdmin.saveVerify') }}</v-btn>
        </div>
      </v-card>
    </v-dialog>
    <v-dialog v-model="profileDiscardDialog" max-width="32rem" aria-labelledby="provider-discard-title">
      <v-card class="compact-dialog">
        <div class="compact-dialog__header compact-dialog__header--danger"><span><v-icon icon="mdi-alert-outline" size="23" aria-hidden="true" /></span><div><div class="agent-panel__eyebrow">{{ $t('admin:agentAdmin.unsavedConfiguration') }}</div><h2 id="provider-discard-title">{{ $t('admin:agentAdmin.discardProviderChanges') }}</h2><p>{{ $t('admin:agentAdmin.editsHaveNotBeen') }}</p></div></div>
        <v-card-text>{{ $t('admin:agentAdmin.keepEditingReviewDraft') }}</v-card-text>
        <v-card-actions><v-spacer /><v-btn @click="profileDiscardDialog = false">{{ $t('admin:agentAdmin.keepEditing') }}</v-btn><v-btn color="error" variant="tonal" @click="discardProfileChanges">{{ $t('admin:agentAdmin.discardChanges') }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog :model-value="enablingProfile !== null" max-width="34rem" :persistent="Boolean(actionBusyKey)" aria-labelledby="provider-enable-title" @update:model-value="value => { if (!value && !actionBusyKey) enablingProfile = null }">
      <v-card class="compact-dialog" :aria-busy="actionBusyKey.startsWith('enabled:')">
        <div class="compact-dialog__header"><span><v-icon icon="mdi-play-circle-outline" size="23" aria-hidden="true" /></span><div><div class="agent-panel__eyebrow">{{ $t('admin:agentAdmin.enablementReview') }}</div><h2 id="provider-enable-title">{{ $t('admin:agentAdmin.enableProviderProfile') }}</h2><p>{{ $t('admin:agentAdmin.newAgentRunsWill') }}</p></div></div>
        <v-card-text><v-alert v-if="enableError" class="mb-3" type="error" variant="tonal" density="compact" role="alert">{{ enableError }}</v-alert><p><strong>{{ enablingProfile?.displayName }}</strong> {{ $t('admin:agentAdmin.hasVerifiedConnectionWill', { value: enablingProfile?.exposureMode === 'all_agent_users' ? $t('admin:agentAdmin.everyAgentUser') : groupNames(enablingProfile?.groupIds ?? []), interpolation: { escapeValue: false } }) }}</p><v-alert v-if="enablingProfile && willBecomeDefault(enablingProfile)" type="warning" variant="tonal" density="compact">{{ $t('admin:agentAdmin.noGlobalDefaultExists') }}</v-alert></v-card-text>
        <v-card-actions><v-spacer /><v-btn :disabled="Boolean(actionBusyKey)" @click="enablingProfile = null">{{ $t('common:actions.cancel') }}</v-btn><v-btn color="primary" prepend-icon="mdi-play-circle-outline" :loading="actionBusyKey.startsWith('enabled:')" :disabled="Boolean(actionBusyKey)" @click="enableConfirmedProfile">{{ $t('admin:agentAdmin.enableProvider') }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog :model-value="browserEnableTarget !== null" max-width="36rem" :persistent="Boolean(actionBusyKey)" aria-labelledby="browser-enable-title" @update:model-value="value => { if (!value && !actionBusyKey) browserEnableTarget = null }">
      <v-card class="compact-dialog" :aria-busy="actionBusyKey.startsWith('browser:')">
        <div class="compact-dialog__header compact-dialog__header--teal"><span><v-icon icon="mdi-web-check" size="23" aria-hidden="true" /></span><div><div class="agent-panel__eyebrow">{{ $t('admin:agentAdmin.networkAllowlistReview') }}</div><h2 id="browser-enable-title">{{ $t('admin:agentAdmin.allowBrowserTarget') }}</h2><p>{{ $t('admin:agentAdmin.isolatedBrowserWillPermitted') }}</p></div></div>
        <v-card-text><v-alert v-if="browserEnableError" class="mb-3" type="error" variant="tonal" density="compact" role="alert">{{ browserEnableError }}</v-alert><p class="browser-confirm-url"><code>{{ browserEnableTarget?.canonicalUrl }}</code></p><p class="mb-0">{{ $t('admin:agentAdmin.onlyCanonicalUrlApproved') }}</p></v-card-text>
        <v-card-actions><v-spacer /><v-btn :disabled="Boolean(actionBusyKey)" @click="browserEnableTarget = null">{{ $t('common:actions.cancel') }}</v-btn><v-btn color="primary" prepend-icon="mdi-shield-check-outline" :loading="actionBusyKey.startsWith('browser:')" :disabled="Boolean(actionBusyKey)" @click="allowConfirmedBrowserTarget">{{ $t('admin:agentAdmin.allowTarget') }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>


    <v-dialog :model-value="removingProfile !== null" max-width="34rem" :persistent="actionBusyKey === 'remove'" aria-labelledby="provider-remove-title" @update:model-value="value => { if (!value) removingProfile = null }">
      <v-card class="compact-dialog" :aria-busy="actionBusyKey === 'remove'">
        <div class="compact-dialog__header compact-dialog__header--danger"><span><v-icon icon="mdi-delete-outline" size="23" aria-hidden="true" /></span><div><div class="agent-panel__eyebrow">{{ $t('admin:agentAdmin.destructiveOperation') }}</div><h2 id="provider-remove-title">{{ $t('admin:agentAdmin.removeProviderProfile') }}</h2><p>{{ $t('admin:agentAdmin.cannotUndone') }}</p></div></div>
        <v-card-text><v-alert v-if="removeError" class="mb-3" type="error" variant="tonal" density="compact" role="alert">{{ removeError }}</v-alert><p><strong>{{ removingProfile?.displayName }}</strong> {{ $t('admin:agentAdmin.willNoLongerAvailable') }}</p><p class="mb-0">{{ $t('admin:agentAdmin.configurationRemovedUseServer') }}</p></v-card-text>
        <v-alert v-if="removingProfile?.isGlobalDefault" class="mx-6 mt-4 mb-0" type="warning" variant="tonal" density="compact">{{ $t('admin:agentAdmin.globalDefaultRemovingLeaves') }}</v-alert>
        <v-card-actions><v-spacer /><v-btn :disabled="Boolean(actionBusyKey)" @click="removingProfile = null">{{ $t('common:actions.cancel') }}</v-btn><v-btn color="error" prepend-icon="mdi-delete-forever-outline" :loading="actionBusyKey === 'remove'" :disabled="Boolean(actionBusyKey)" @click="removeProfile">{{ removingProfile?.isGlobalDefault ? $t('admin:agentAdmin.removeDefaultProvider') : $t('admin:agentAdmin.removeProvider') }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="grantsDialog" max-width="40rem" scrollable :persistent="actionBusyKey === 'grants'" aria-labelledby="provider-grants-title">
      <v-card class="compact-dialog">
        <div class="compact-dialog__header"><span><v-icon icon="mdi-account-multiple-outline" size="23" aria-hidden="true" /></span><div><h2 id="provider-grants-title">{{ grantProfile ? $t('admin:agentAdmin.access2', { displayName: grantProfile.displayName, interpolation: { escapeValue: false } }) : $t('admin:agentAdmin.providerAccess') }}</h2><p>{{ $t('admin:agentAdmin.controlWhoCanDiscover') }}</p></div></div>
        <v-card-text><v-alert v-if="grantsError" class="mb-3" type="error" variant="tonal" density="compact" role="alert">{{ grantsError }}</v-alert><v-select v-model="grantDraft.exposureMode" :items="exposureModes" :label="$t('admin:agentAdmin.available2')" /><v-autocomplete v-if="grantDraft.exposureMode === 'groups'" v-model="grantDraft.groupIds" :items="groups" item-title="name" item-value="id" :label="$t('admin:agentAdmin.wikiGroups')" multiple chips closable-chips :hint="$t('admin:agentAdmin.usersReceiveProviderThrough')" persistent-hint /><v-alert class="mt-4" type="info" variant="tonal" density="compact">{{ $t('admin:agentAdmin.globalDefaultAvailableEveryone') }}</v-alert></v-card-text>
        <div v-if="grantDraft.exposureMode === 'groups' && (resourceState.groups.error || !groups.length)" class="field-note mx-6" role="status">
          <template v-if="resourceState.groups.error">{{ resourceState.groups.error }} <v-btn variant="text" :disabled="resourceState.groups.loading" @click="refreshResources(['groups'])">{{ $t('admin:agentAdmin.retry') }}</v-btn></template>
          <template v-else-if="resourceState.groups.loaded">{{ $t('admin:agentAdmin.noWikiGroupsYet') }} <router-link to="/a/groups">{{ $t('admin:agentAdmin.manageWikiGroups') }}</router-link></template>
          <template v-else>{{ $t('admin:agentAdmin.loading') }}</template>
        </div>
        <v-alert v-if="grantProfile?.isGlobalDefault && grantsDirty" class="mx-6 mt-4 mb-0" type="warning" variant="tonal" density="compact">{{ $t('admin:agentAdmin.savingAnyAccessChange') }}</v-alert>
        <v-card-actions><span class="compact-dialog__audit"><v-icon icon="mdi-text-box-check-outline" size="16" aria-hidden="true" />{{ $t('admin:agentAdmin.accessChangesAudited') }}</span><v-spacer /><v-btn :disabled="actionBusyKey === 'grants'" @click="grantsDialog = false">{{ $t('common:actions.cancel') }}</v-btn><v-btn color="primary" :loading="actionBusyKey === 'grants'" :disabled="Boolean(actionBusyKey) || !grantsDirty || (grantDraft.exposureMode === 'groups' && grantDraft.groupIds.length === 0)" @click="saveGrants">{{ grantProfile?.isGlobalDefault ? $t('admin:agentAdmin.saveClearDefault') : $t('admin:agentAdmin.saveAccess') }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="browserDialog" max-width="40rem" :persistent="actionBusyKey === 'browser-create'" aria-labelledby="browser-create-title">
      <v-card class="compact-dialog" :aria-busy="actionBusyKey === 'browser-create'">
        <div class="compact-dialog__header compact-dialog__header--teal"><span><v-icon icon="mdi-web-plus" size="23" aria-hidden="true" /></span><div><div class="agent-panel__eyebrow">{{ $t('admin:agentAdmin.networkPolicyEntry') }}</div><h2 id="browser-create-title">{{ $t('admin:agentAdmin.addBrowserTarget') }}</h2><p>{{ $t('admin:agentAdmin.approveOneExactCanonical') }}</p></div></div>
        <v-form id="browser-target-form" @submit.prevent="createBrowserTarget">
          <v-card-text>
            <v-alert v-if="browserError" class="mb-3" type="error" variant="tonal" density="compact" role="alert">{{ browserError }}</v-alert>
            <v-alert class="mb-4" type="warning" variant="tonal" density="compact">{{ $t('admin:agentAdmin.approvalExactPathsOrigins') }}</v-alert>
            <v-text-field v-model="browserUrl" :rules="browserUrlRules" :label="$t('admin:agentAdmin.exactCanonicalHttpsUrl')" :hint="$t('admin:agentAdmin.httpsExampleComPath')" persistent-hint autofocus prepend-inner-icon="mdi-lock-outline" autocomplete="url" spellcheck="false" required />
            <v-checkbox v-model="browserEnabled" :label="$t('admin:agentAdmin.enableImmediately')" :hint="$t('admin:agentAdmin.leaveOffStageTarget')" persistent-hint />
          </v-card-text>
        </v-form>
        <v-card-actions><span class="compact-dialog__audit"><v-icon icon="mdi-fingerprint" size="16" aria-hidden="true" />{{ $t('admin:agentAdmin.policyHashWillRecorded') }}</span><v-spacer /><v-btn :disabled="actionBusyKey === 'browser-create'" @click="browserDialog = false">{{ $t('common:actions.cancel') }}</v-btn><v-btn color="primary" type="submit" form="browser-target-form" :loading="actionBusyKey === 'browser-create'" :disabled="Boolean(actionBusyKey) || !isBrowserUrlValid">{{ browserEnabled ? $t('admin:agentAdmin.addAllowTarget') : $t('admin:agentAdmin.addPausedTarget') }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
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
import AgentAdminTools from './agent-admin-tools.vue'
import type { AgentAdminTool } from '../../../shared/agents/admin.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()

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
  retention: { savedSessionDays: number; temporarySessionHours: number; mcpContentDays: number; auditDays: number; maintenanceBatchSize: number }
}
interface ConnectionCheck { status: 'passed' | 'failed'; errorCode: string | null; message: string | null; completedAt: string }
interface ConnectionHistoryCheck extends ConnectionCheck { id: string; checks: { name: string; passed: boolean; detail?: string }[] }
interface Profile { id: string; displayName: string; status: 'enabled' | 'disabled'; isGlobalDefault: boolean; exposureMode: 'all_agent_users' | 'groups'; groupIds: number[]; conformed: boolean; connectionCheck: ConnectionCheck | null; transportKind: AgentProviderTransport; model: string; utilityModel: string | null; baseUrl: string; destinationHost: string; authMode: AgentProviderAuthMode; secretConfigured: boolean; adapterConfig: { timeoutMs: number; maxRetries: number; additionalHeaders: Record<string, string>; agentReasoningEffort?: AgentReasoningEffort; utilityReasoningEffort?: AgentReasoningEffort; media?: { attachments: boolean; imageGeneration?: { model: 'gemini-3.1-flash-image'; pricingRevision: string }; transcription?: { model: 'gemini-3.5-transcribe'; pricingRevision: string }; videoGeneration?: { model: 'gemini-omni-1.1-flash'; pricingRevision: string; textOutputMicrosPerMillionTokens: number; usagePolicy: 'reported-or-estimated' }; musicGeneration?: { model: 'lyria-3.5'; costMicrosPerSong: number; usagePolicy: 'reported-or-estimated' } } }; capabilities: { streaming: boolean; toolCalling: AgentProviderToolCalling; parallelToolCalls: boolean; structuredOutput: AgentProviderStructuredOutput; usage: AgentProviderUsageMode; cancellation: boolean; maxContextTokens: number; maxOutputTokens: number }; policies: { allowedModes: string[]; dailyTokens: number; dailyCostMicros: number; reservationTokens: number; reservationCostMicros: number; reservationMilliseconds: number; promptVersion: number; maxAttempts: number } }
interface BrowserTarget { id: string; canonicalUrl: string; enabled: boolean; policySha256: string }
interface GroupOption { id: number; name: string; isSystem: boolean }
interface ProfileDraft { mediaAttachments: boolean; mediaImages: boolean; mediaSpeech: boolean; mediaVideo: boolean; mediaMusic: boolean; videoInputRate: string; videoOutputRate: string; videoTextOutputRate: string; musicSongRate: string; imageInputRate: string; imageOutputRate: string; speechInputRate: string; speechOutputRate: string; displayName: string; transportKind: AgentProviderTransport; model: string; utilityModel: string; agentReasoningEffort: AgentReasoningEffort | null; utilityReasoningEffort: AgentReasoningEffort | null; baseUrl: string; authMode: AgentProviderAuthMode; secretValue: string; exposureMode: 'all_agent_users' | 'groups'; groupIds: number[]; maxContextTokens: number; maxOutputTokens: number; dailyTokens: number; dailyCostMicros: number; reservationTokens: number; reservationCostMicros: number; reservationMilliseconds: number; timeoutMs: number; maxRetries: number; maxAttempts: number; promptVersion: number; additionalHeaders: Record<string, string>; structuredOutput: AgentProviderStructuredOutput; usage: AgentProviderUsageMode; streaming: boolean; toolCalling: AgentProviderToolCalling; parallelToolCalls: boolean; cancellation: boolean }

const { csrfToken, embedded = false } = defineProps<{ csrfToken: string; embedded?: boolean }>()
const { smAndDown } = useDisplay()
const tab = ref('overview')
const toolInventory = shallowRef<AgentAdminTool[]>([])
const providerQuery = ref<string | null>('')
const providerState = ref('all')
const providerStates = [{ title: t('admin:agentAdmin.allProviders'), value: 'all' }, { title: t('admin:agentAdmin.enabled'), value: 'enabled' }, { title: t('admin:agentAdmin.disabled'), value: 'disabled' }, { title: t('admin:agentAdmin.needsAttention'), value: 'attention' }]
const readyProviders = computed(() => profiles.value.filter(profile => profile.status === 'enabled' && profile.secretConfigured && profile.conformed))
const defaultProvider = computed(() => readyProviders.value.find(profile => profile.isGlobalDefault && profile.exposureMode === 'all_agent_users'))
const filteredProfiles = computed(() => {
  const terms = (providerQuery.value || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return profiles.value.filter(profile =>
    (providerState.value === 'all' || (providerState.value === 'attention' ? !profile.conformed || !profile.secretConfigured : profile.status === providerState.value)) &&
    terms.every(term => `${profile.displayName} ${profile.model} ${profile.utilityModel || ''} ${profile.destinationHost} ${agentProviderProtocolOption(profile.transportKind).title} ${groupNames(profile.groupIds)}`.toLocaleLowerCase().includes(term)))
})
type ProfileStep = 'identity' | 'models' | 'connection' | 'access' | 'limits'
const profileStep = ref<ProfileStep>('identity')
type AdminResource = 'runtime' | 'profiles' | 'browser' | 'groups'
const resourceState = reactive<Record<AdminResource, { loaded: boolean; loading: boolean; error: string }>>({
  runtime: { loaded: false, loading: false, error: '' },
  profiles: { loaded: false, loading: false, error: '' },
  browser: { loaded: false, loading: false, error: '' },
  groups: { loaded: false, loading: false, error: '' }
})
const loading = computed(() => Object.values(resourceState).some(state => state.loading))
const loadFailed = computed(() => Object.values(resourceState).some(state => state.error))
const dataLoaded = computed(() => resourceState.runtime.loaded)
const profileWarnings = reactive<Record<string, string>>({})
const profileRail = ref<HTMLElement | null>(null)
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
const browserQuery = ref<string | null>('')
const browserState = ref('all')
const filteredBrowserTargets = computed(() => browserTargets.value.filter(target =>
  (browserState.value === 'all' || target.enabled === (browserState.value === 'allowed')) &&
  target.canonicalUrl.toLocaleLowerCase().includes((browserQuery.value || '').trim().toLocaleLowerCase())))
const connectionHistoryDialog = ref(false)
const connectionHistoryProfile = shallowRef<Profile | null>(null)
const connectionHistory = shallowRef<ConnectionHistoryCheck[]>([])
const connectionHistoryLoading = ref(false)
const connectionHistoryError = ref('')
let connectionHistoryController: AbortController | null = null
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
const resourceControllers = new Map<AdminResource, AbortController>()
let disposed = false
const sameIdSet = (left: readonly number[], right: readonly number[]): boolean => {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort((a, b) => a - b)
  const sortedRight = [...right].sort((a, b) => a - b)
  return sortedLeft.every((id, index) => id === sortedRight[index])
}
const grantsDirty = computed(() => Boolean(grantProfile.value) && (grantDraft.exposureMode !== grantProfile.value?.exposureMode || !sameIdSet(grantDraft.groupIds, grantProfile.value?.groupIds ?? [])))
const protocolOptions = AGENT_PROVIDER_PROTOCOL_OPTIONS.filter(option => agentProviderProtocolExecutionModes(option.value).includes('agent'))
const exposureModes = [{ title: t('admin:agentAdmin.everyone'), value: 'all_agent_users' }, { title: t('admin:agentAdmin.selectedWikiGroups'), value: 'groups' }]
const toolCallingOptions = [
  { title: t('admin:agentAdmin.nativeApiTools'), value: 'native' as const },
  { title: t('admin:agentAdmin.promptEmulatedTools'), value: 'prompt' as const }
]
const connectionDateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const formatConnectionCheckDate = (completedAt: string): string => {
  const completed = new Date(completedAt)
  return Number.isNaN(completed.getTime()) ? t('admin:agentAdmin.unknownTime') : connectionDateFormatter.format(completed)
}
const defaults = (): ProfileDraft => ({ mediaAttachments: false, mediaImages: false, mediaSpeech: false, mediaVideo: false, mediaMusic: false, videoInputRate: '1500000', videoOutputRate: '17500000', videoTextOutputRate: '9000000', musicSongRate: '80000', imageInputRate: '', imageOutputRate: '', speechInputRate: '', speechOutputRate: '', displayName: '', transportKind: 'openai-responses', model: '', utilityModel: '', agentReasoningEffort: null, utilityReasoningEffort: null, ...agentProviderProtocolDefaults('openai-responses'), secretValue: '', exposureMode: 'all_agent_users', groupIds: [], maxContextTokens: 128000, maxOutputTokens: 8192, dailyTokens: 1000000, dailyCostMicros: 10000000, reservationTokens: 32000, reservationCostMicros: 1000000, reservationMilliseconds: 300000, timeoutMs: 120000, maxRetries: 0, maxAttempts: 3, promptVersion: 1, additionalHeaders: {} })
const profileDraft = reactive<ProfileDraft>(defaults())
const profileDraftFingerprint = (): string => JSON.stringify(profileDraft)
const profileBaseline = ref(profileDraftFingerprint())
const profileDirty = computed(() => profileDialog.value && profileDraftFingerprint() !== profileBaseline.value)
const availableAuthModes = computed<AgentProviderAuthMode[]>(() => profileDraft.transportKind === 'legacy-completions' ? ['bearer', 'api-key-header'] : [agentProviderProtocolDefaults(profileDraft.transportKind).authMode])

const selectedProtocol = computed(() => agentProviderProtocolOption(profileDraft.transportKind))
const agentModelHint = computed(() => profileDraft.transportKind === 'gemini-api'
  ? t('admin:agentAdmin.gemini3XModel')
  : t('admin:agentAdmin.primaryModelConversationalAnswers'))
const reasoningEffortTitles: Readonly<Record<AgentReasoningEffort, string>> = {
  none: t('admin:agentAdmin.none'),
  minimal: t('admin:agentAdmin.minimal'),
  low: t('admin:agentAdmin.low'),
  medium: t('admin:agentAdmin.medium'),
  high: t('admin:agentAdmin.high'),
  xhigh: t('admin:agentAdmin.extraHigh'),
  max: t('admin:agentAdmin.maximum')
}
const reasoningEffortOptions = computed(() => [
  { title: t('admin:agentAdmin.providerModelDefault'), value: null },
  ...agentProviderReasoningEfforts(profileDraft.transportKind).map(value => ({ title: reasoningEffortTitles[value], value }))
])
const reasoningSupportHint = computed(() => ({
  'openai-responses': t('admin:agentAdmin.sentResponsesApiReasoning'),
  openresponses: t('admin:agentAdmin.sentOpenresponsesReasoningEffort'),
  'openai-chat': t('admin:agentAdmin.sentChatCompletionsReasoning'),
  'legacy-completions': '',
  'anthropic-messages': t('admin:agentAdmin.sentMessagesApiOutput'),
  'gemini-api': t('admin:agentAdmin.sentGeminiInteractionsGeneration')
})[profileDraft.transportKind])
const protocolBehaviorRows = computed(() => {
  const structuredOutput = {
    'native-json-schema': t('admin:agentAdmin.nativeJsonSchema'),
    'tool-result': t('admin:agentAdmin.toolResultSchema'),
    'prompt-only': t('admin:agentAdmin.promptValidatedText')
  }[profileDraft.structuredOutput]
  const usage = {
    stream: t('admin:agentAdmin.providerTokenCountsResponse'),
    terminal: t('admin:agentAdmin.providerTokenCountsFinal'),
    estimated: t('admin:agentAdmin.estimatedTokenCounts')
  }[profileDraft.usage]
  const authentication = {
    bearer: t('admin:agentAdmin.bearerToken'),
    'api-key-header': t('admin:agentAdmin.apiKeyHeader'),
    'anthropic-api-key': t('admin:agentAdmin.anthropicApiKey'),
    'google-api-key': t('admin:agentAdmin.googleApiKey')
  }[profileDraft.authMode]
  return [
    { label: t('admin:agentAdmin.availableUse'), value: t('admin:agentAdmin.wikiAgentActionsGoverned') },
    { label: t('admin:agentAdmin.modelRoles'), value: profileDraft.utilityModel.trim() ? t('admin:agentAdmin.agentUtility', { model: profileDraft.model || t('admin:agentAdmin.notSet'), utilityModel: profileDraft.utilityModel, interpolation: { escapeValue: false } }) : t('admin:agentAdmin.agentModelAlsoHandles') },
    ...(reasoningEffortOptions.value.length > 1 ? [{
      label: t('admin:agentAdmin.reasoning'),
      value: t('admin:agentAdmin.agentUtility2', { agentReasoningEffort: profileDraft.agentReasoningEffort === null ? t('admin:agentAdmin.providerDefault') : reasoningEffortTitles[profileDraft.agentReasoningEffort], utilityReasoningEffort: profileDraft.utilityReasoningEffort === null ? t('admin:agentAdmin.providerDefault') : reasoningEffortTitles[profileDraft.utilityReasoningEffort], interpolation: { escapeValue: false } })
    }] : []),
    { label: t('admin:agentAdmin.toolCalls'), value: profileDraft.toolCalling === 'prompt' ? t('admin:agentAdmin.promptEmulatedOneAction') : profileDraft.parallelToolCalls ? t('admin:agentAdmin.nativeApiMultipleCalls') : t('admin:agentAdmin.nativeApiOneCall') },
    { label: t('admin:agentAdmin.responseDelivery'), value: profileDraft.streaming ? t('admin:agentAdmin.streamed', { cancellation: profileDraft.cancellation ? t('admin:agentAdmin.cancellable') : t('admin:agentAdmin.notCancellable'), interpolation: { escapeValue: false } }) : t('admin:agentAdmin.oneBufferedResponse') },
    { label: t('admin:agentAdmin.structuredOutput'), value: structuredOutput },
    { label: t('admin:agentAdmin.usageAccounting'), value: usage },
    { label: t('admin:agentAdmin.authentication'), value: authentication }
  ]
})
const selectProtocol = (value: unknown) => {
  if (!isAgentProviderTransport(value) || value === profileDraft.transportKind) return
  const previousDefaults = agentProviderProtocolDefaults(profileDraft.transportKind)
  const baseUrl = profileDraft.baseUrl
  const authMode = profileDraft.authMode
  Object.assign(profileDraft, agentProviderProtocolDefaults(value), {
    transportKind: value,
    ...(baseUrl !== previousDefaults.baseUrl ? { baseUrl } : {}),
    ...(value === 'legacy-completions' && (authMode === 'bearer' || authMode === 'api-key-header') ? { authMode } : {}),
    agentReasoningEffort: null, utilityReasoningEffort: null,
    mediaAttachments: false, mediaImages: false, mediaSpeech: false, mediaVideo: false, mediaMusic: false
  })
}
const selectToolCalling = () => {
  profileDraft.parallelToolCalls = profileDraft.toolCalling === 'native' && agentProviderProtocolDefaults(profileDraft.transportKind).parallelToolCalls
}

const capabilityRows = computed(() => runtime.value ? [
  { label: t('admin:agentAdmin.inlineAgent'), enabled: runtime.value.enabled },
  { label: t('admin:agentAdmin.providerInference'), enabled: runtime.value.providerEnabled },
  { label: t('admin:agentAdmin.specialistResearch'), enabled: runtime.value.orchestrationEnabled },
  { label: t('admin:agentAdmin.durableGoals'), enabled: runtime.value.goalsEnabled },
  { label: t('admin:agentAdmin.approvedSkills'), enabled: runtime.value.skillsEnabled },
  { label: t('admin:agentAdmin.isolatedBrowser'), enabled: runtime.value.browserEnabled },
  { label: t('admin:agentAdmin.proposals'), enabled: runtime.value.proposalsEnabled },
  { label: t('admin:agentAdmin.allWrites'), enabled: runtime.value.proposalsEnabled && runtime.value.writes.enabled },
  { label: t('common:actions.create'), enabled: runtime.value.proposalsEnabled && runtime.value.writes.enabled && runtime.value.writes.create },
  { label: t('admin:agentAdmin.patch'), enabled: runtime.value.proposalsEnabled && runtime.value.writes.enabled && runtime.value.writes.patch },
  { label: t('common:actions.move'), enabled: runtime.value.proposalsEnabled && runtime.value.writes.enabled && runtime.value.writes.move },
  { label: t('admin:agentAdmin.restore'), enabled: runtime.value.proposalsEnabled && runtime.value.writes.enabled && runtime.value.writes.restore },
  { label: t('common:actions.delete'), enabled: runtime.value.proposalsEnabled && runtime.value.writes.enabled && runtime.value.writes.delete },
  { label: 'MCP', enabled: runtime.value.mcpEnabled }
].map(item => ({ ...item, enabled: runtime.value!.enabled && item.enabled })) : [])
const enabledCapabilityCount = computed(() => capabilityRows.value.filter(item => item.enabled).length)
const actionBusyMessage = computed(() => {
  if (actionBusyKey.value.startsWith('test:')) return t('admin:agentAdmin.testingProviderConnectionRefreshing')
  if (actionBusyKey.value.startsWith('default:')) return t('admin:agentAdmin.updatingWorkspaceDefaultProvider')
  if (actionBusyKey.value.startsWith('enabled:')) return t('admin:agentAdmin.updatingProviderAvailability')
  if (actionBusyKey.value.startsWith('browser:')) return t('admin:agentAdmin.updatingBrowserNetworkBoundary')
  if (actionBusyKey.value === 'browser-create') return t('admin:agentAdmin.recordingBrowserTargetPolicy')
  if (actionBusyKey.value === 'grants') return t('admin:agentAdmin.savingProviderAccessGrants')
  if (actionBusyKey.value === 'remove') return t('admin:agentAdmin.removingProviderProfileCredential')
  return t('admin:agentAdmin.applyingAdministrationChange')
})
const sectionItems = computed(() => [
  { value: 'overview', title: t('admin:agentAdmin.overview'), description: t('admin:agentAdmin.setupReadiness'), icon: 'mdi-view-dashboard-outline', badge: '' },
  { value: 'profiles', title: t('admin:agentAdmin.providers'), description: t('admin:agentAdmin.modelsAccess'), icon: 'mdi-brain', badge: profiles.value.length ? String(profiles.value.length) : '' },
  { value: 'skills', title: t('admin:agentAdmin.skills'), description: t('admin:agentAdmin.approvedExpertise'), icon: 'mdi-book-open-variant-outline', badge: '' },
  { value: 'browser', title: t('admin:agentAdmin.browserAccess'), description: t('admin:agentAdmin.networkBoundaries'), icon: 'mdi-web-check', badge: browserTargets.value.length ? String(browserTargets.value.length) : '' },
  { value: 'tools', title: t('admin:agentAdmin.toolsMcp'), description: t('admin:agentAdmin.capabilityDirectory'), icon: 'mdi-connection', badge: '' },
  { value: 'memory', title: t('admin:agentAdmin.knowledgeMemory'), description: t('admin:agentAdmin.sourcesRetention'), icon: 'mdi-book-open-page-variant-outline', badge: '' },
  { value: 'runtime', title: t('admin:agentAdmin.runtime'), description: t('admin:agentAdmin.policySafeguards'), icon: 'mdi-tune-variant', badge: resourceState.runtime.error ? resourceState.runtime.loaded ? t('admin:agentAdmin.stale') : t('admin:agentAdmin.unavailable') : dataLoaded.value ? runtime.value?.enabled ? t('admin:agentAdmin.active') : t('admin:agentAdmin.paused') : resourceState.runtime.loading ? t('admin:agentAdmin.loading') : '' }
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
  event.preventDefault()
  const target = event.currentTarget as HTMLElement | null
  const rtlMultiplier = target && getComputedStyle(target).direction === 'rtl' ? -1 : 1
  selectSection(currentIndex + direction * rtlMultiplier, event)
}
const profileSteps = computed<Array<{ value: ProfileStep; title: string; description: string }>>(() => [
  { value: 'identity', title: t('admin:agentAdmin.setup'), description: t('admin:agentAdmin.nameProtocol') },
  { value: 'models', title: t('admin:agentAdmin.models'), description: t('admin:agentAdmin.rolesReasoning') },
  { value: 'connection', title: t('admin:agentAdmin.connection'), description: t('admin:agentAdmin.endpointKey') },
  ...(!editingProfile.value ? [{ value: 'access' as const, title: t('admin:agentAdmin.access'), description: t('admin:agentAdmin.audienceGroups') }] : []),
  { value: 'limits', title: t('admin:agentAdmin.limits'), description: t('admin:agentAdmin.quotasReliability') }
])
const profileStepIndex = computed(() => Math.max(0, profileSteps.value.findIndex(step => step.value === profileStep.value)))
const currentProfileStep = computed(() => profileSteps.value[profileStepIndex.value] ?? profileSteps.value[0])
const profileProgress = computed(() => ((profileStepIndex.value + 1) / profileSteps.value.length) * 100)
const integerInRange = (value: number, minimum: number, maximum: number): boolean => Number.isSafeInteger(value) && value >= minimum && value <= maximum
const integerRule = (label: string, minimum: number, maximum: number) => (value: number): true | string => integerInRange(value, minimum, maximum) || t('admin:agentAdmin.mustWholeNumber', { label, minimum: minimum.toLocaleString(), maximum: maximum.toLocaleString(), interpolation: { escapeValue: false } })
const requiredTextRule = (label: string) => (value: unknown): true | string =>
  (typeof value === 'string' && Boolean(value.trim())) || t('admin:agentAdmin.required', { label, interpolation: { escapeValue: false } })
const profileDisplayNameRules = [requiredTextRule(t('admin:agentAdmin.displayName'))]
const profileModelRules = [requiredTextRule(t('admin:agentAdmin.agentModel'))]
const profileSecretRules = computed(() =>
  editingProfile.value?.secretConfigured ? [] : [requiredTextRule(t('admin:agentAdmin.apiKey'))]
)
const profileRules = {
  maxContextTokens: [integerRule(t('admin:agentAdmin.maximumContextTokens'), 1024, 10_000_000)],
  maxOutputTokens: [integerRule(t('admin:agentAdmin.maximumOutputTokens'), 1, 1_000_000)],
  dailyTokens: [integerRule(t('admin:agentAdmin.dailyTokenLimit'), 1, 1_000_000_000)],
  dailyCostMicros: [integerRule(t('admin:agentAdmin.dailyCostReservation'), 1, Number.MAX_SAFE_INTEGER)],
  reservationTokens: [integerRule(t('admin:agentAdmin.tokenReservation'), 1, 10_000_000)],
  reservationCostMicros: [integerRule(t('admin:agentAdmin.costReservation'), 1, Number.MAX_SAFE_INTEGER)],
  timeoutMs: [integerRule(t('admin:agentAdmin.requestTimeout'), 1_000, 300_000)],
  maxAttempts: [integerRule(t('admin:agentAdmin.maximumAttempts'), 1, 10)]
}
const providerBaseUrlError = computed(() => {
  const input = profileDraft.baseUrl.trim()
  if (!input) return t('admin:agentAdmin.enterProviderBaseUrl')
  try {
    const url = new URL(input)
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    const octets = hostname.split('.').map(value => Number(value))
    const mapped = /^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(hostname)
    const mappedOctets = mapped ? [parseInt(mapped[1], 16) >> 8, parseInt(mapped[1], 16) & 255, parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255] : null
    if (mappedOctets) octets.splice(0, octets.length, ...mappedOctets)
    const privateIpv4 = octets.length === 4 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255) && (octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168) || octets[0] >= 224)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || privateIpv4 || hostname === '::' || hostname === '::1' || /^(?:fc|fd|fe[89ab])/i.test(hostname)) return t('admin:agentAdmin.usePublicHttpsOrigin')
    return ''
  } catch {
    return t('admin:agentAdmin.enterValidAbsoluteHttps')
  }
})
const providerBaseUrlRule = (): true | string => providerBaseUrlError.value || true
const providerBaseUrlRules = [providerBaseUrlRule]
const profileStepIsValid = (step: ProfileStep): boolean => {
  if (step === 'identity') return Boolean(profileDraft.displayName.trim() && profileDraft.transportKind)
  if (step === 'models') return Boolean(profileDraft.model.trim()) && mediaSettingsValid.value
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
const navigateProfileStep = (index: number): void => {
  if (saving.value) return
  if (!canNavigateProfileStep(index)) {
    profileError.value = t('admin:agentAdmin.completeRequiredFieldsStep')
    return
  }
  profileError.value = ''
  profileStep.value = profileSteps.value[index].value
}
watch([profileStep, profileDialog], async () => {
  await nextTick()
  const rail = profileRail.value
  const active = rail?.querySelector<HTMLElement>('.profile-step--active')
  if (!profileDialog.value || !rail || !active || rail.scrollWidth <= rail.clientWidth) return
  const railBounds = rail.getBoundingClientRect()
  const activeBounds = active.getBoundingClientRect()
  rail.scrollBy({
    left: activeBounds.left + activeBounds.width / 2 - railBounds.left - railBounds.width / 2,
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
  })
}, { flush: 'post' })
const profileSaveState = computed(() => {
  if (saving.value) return t('admin:agentAdmin.verifyingProviderCapabilities')
  const invalid = profileSteps.value.find(step => !profileStepIsValid(step.value))
  if (invalid) {
    let field = invalid.title
    if (invalid.value === 'connection') field = providerBaseUrlError.value ? t('admin:agentAdmin.baseUrl') : t('admin:agentAdmin.apiKey')
    if (invalid.value === 'identity') field = t('admin:agentAdmin.displayName')
    if (invalid.value === 'models') field = profileDraft.model.trim() ? t('admin:agentAdmin.mediaSettings') : t('admin:agentAdmin.agentModel')
    if (invalid.value === 'access') field = t('admin:agentAdmin.wikiGroups')
    if (invalid.value === 'limits') {
      for (const [key, rules] of Object.entries(profileRules)) {
        const issue = rules[0](profileDraft[key as keyof typeof profileRules])
        if (issue !== true) { field = issue; break }
      }
    }
    return t('admin:agentAdmin.reviewInvalidField', { step: invalid.title, field, interpolation: { escapeValue: false } })
  }
  return profileDirty.value ? t('admin:agentAdmin.readyReviewSave') : t('admin:agentAdmin.configurationUnchanged')
})
const previousProfileStep = () => {
  const previous = profileSteps.value[profileStepIndex.value - 1]
  if (previous) profileStep.value = previous.value
}
const nextProfileStep = () => {
  if (!profileStepValid.value) { profileError.value = t('admin:agentAdmin.completeRequiredFieldsStep'); return }
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
  maxProfileStepIndex.value = editingProfile.value ? profileSteps.value.length - 1 : 0
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
  if (!response.ok) { const body = await response.json().catch(() => ({})) as { message?: string; error?: string }; throw new Error(body.message ?? body.error ?? t('admin:agentAdmin.requestFailed', { status: response.status, interpolation: { escapeValue: false } })) }
  return response.status === 204 ? undefined as T : await response.json() as T
}
const run = async (operation: () => Promise<void>, busyKey = 'global', onError: (message: string) => void = message => { error.value = message }) => {
  if (actionBusyKey.value) return
  saving.value = true
  actionBusyKey.value = busyKey
  error.value = ''
  try { await operation() } catch (value) { onError(value instanceof Error ? value.message : t('admin:agentAdmin.agentAdministrationRequestFailed')) } finally { saving.value = false; actionBusyKey.value = '' }
}
const refreshResources = async (resources: AdminResource[]): Promise<void> => {
  if (disposed) return
  await Promise.all(resources.map(async resource => {
    resourceControllers.get(resource)?.abort()
    const controller = new AbortController()
    resourceControllers.set(resource, controller)
    const state = resourceState[resource]
    state.loading = true
    try {
      if (resource === 'runtime') {
        const result = await request<{ runtime: RuntimePolicy; tools?: AgentAdminTool[] }>('/_api/agents/admin/runtime', { signal: controller.signal })
        if (controller.signal.aborted || disposed) return
        runtime.value = result.runtime
        toolInventory.value = result.tools ?? []
      } else if (resource === 'profiles') {
        const result = await request<{ profiles: Profile[] }>('/_api/agents/admin/profiles', { signal: controller.signal })
        if (controller.signal.aborted || disposed) return
        profiles.value = result.profiles
      } else if (resource === 'browser') {
        const result = await request<{ targets: BrowserTarget[] }>('/_api/agents/admin/browser-targets', { signal: controller.signal })
        if (controller.signal.aborted || disposed) return
        browserTargets.value = result.targets
      } else {
        const result = await request<GroupOption[]>('/_api/groups', { signal: controller.signal })
        if (controller.signal.aborted || disposed) return
        groups.value = result
      }
      state.loaded = true
      state.error = ''
    } catch (value) {
      if (!controller.signal.aborted && !disposed) state.error = value instanceof Error ? value.message : t('admin:agentAdmin.agentAdministrationCouldNot')
    } finally {
      if (resourceControllers.get(resource) === controller) {
        state.loading = false
        resourceControllers.delete(resource)
      }
    }
  }))
}
const load = (): Promise<void> => refreshResources(['runtime', 'profiles', 'browser', 'groups'])
const openProfile = (profile?: Profile) => {
  profileError.value = ''
  editingProfile.value = profile ?? null
  maxProfileStepIndex.value = profile ? profileSteps.value.length - 1 : 0
  profileStep.value = 'identity'
  Object.assign(profileDraft, defaults(), profile ? {
    ...agentProviderProtocolDefaults(profile.transportKind),
    displayName: profile.displayName,
    transportKind: profile.transportKind,
    model: profile.model,
    utilityModel: profile.utilityModel ?? '',
    agentReasoningEffort: profile.adapterConfig.agentReasoningEffort ?? null,
    utilityReasoningEffort: profile.adapterConfig.utilityReasoningEffort ?? null,
    mediaAttachments: profile.adapterConfig.media?.attachments ?? false,
    mediaImages: Boolean(profile.adapterConfig.media?.imageGeneration),
    mediaSpeech: Boolean(profile.adapterConfig.media?.transcription),
    mediaVideo: Boolean(profile.adapterConfig.media?.videoGeneration),
    mediaMusic: Boolean(profile.adapterConfig.media?.musicGeneration),
    videoInputRate: profile.adapterConfig.media?.videoGeneration?.pricingRevision.split('|')[1] ?? '1500000',
    videoOutputRate: profile.adapterConfig.media?.videoGeneration?.pricingRevision.split('|')[2] ?? '17500000',
    videoTextOutputRate: String(profile.adapterConfig.media?.videoGeneration?.textOutputMicrosPerMillionTokens ?? 9000000),
    musicSongRate: String(profile.adapterConfig.media?.musicGeneration?.costMicrosPerSong ?? 80000),
    imageInputRate: profile.adapterConfig.media?.imageGeneration?.pricingRevision.split('|')[1] ?? '',
    imageOutputRate: profile.adapterConfig.media?.imageGeneration?.pricingRevision.split('|')[2] ?? '',
    speechInputRate: profile.adapterConfig.media?.transcription?.pricingRevision.split('|')[1] ?? '',
    speechOutputRate: profile.adapterConfig.media?.transcription?.pricingRevision.split('|')[2] ?? '',
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
  if (!profile) void refreshResources(['groups'])
}
const mediaRateValid = (value: string): boolean => /^[1-9][0-9]{0,14}$/u.test(value) && Number.isSafeInteger(Number(value))
const mediaRateRule = (value: string): true | string => mediaRateValid(value) || t('admin:agentAdmin.enterPositiveWholeNumber')
const mediaSettingsValid = computed(() => profileDraft.transportKind !== 'gemini-api' || (
  (!profileDraft.mediaImages || (mediaRateValid(profileDraft.imageInputRate) && mediaRateValid(profileDraft.imageOutputRate))) &&
  (!profileDraft.mediaVideo || [profileDraft.videoInputRate, profileDraft.videoOutputRate, profileDraft.videoTextOutputRate].every(mediaRateValid)) &&
  (!profileDraft.mediaMusic || mediaRateValid(profileDraft.musicSongRate)) &&
  (!profileDraft.mediaSpeech || (mediaRateValid(profileDraft.speechInputRate) && mediaRateValid(profileDraft.speechOutputRate)))
))
const mediaPayload = () => profileDraft.transportKind !== 'gemini-api' || !(profileDraft.mediaAttachments || profileDraft.mediaImages || profileDraft.mediaSpeech || profileDraft.mediaVideo || profileDraft.mediaMusic) ? {} : {
  media: {
    attachments: profileDraft.mediaAttachments,
    ...(profileDraft.mediaVideo ? { videoGeneration: { model: 'gemini-omni-1.1-flash', pricingRevision: `video-v1|${profileDraft.videoInputRate}|${profileDraft.videoOutputRate}`, textOutputMicrosPerMillionTokens: Number(profileDraft.videoTextOutputRate), usagePolicy: 'reported-or-estimated' } } : {}),
    ...(profileDraft.mediaMusic ? { musicGeneration: { model: 'lyria-3.5', costMicrosPerSong: Number(profileDraft.musicSongRate), usagePolicy: 'reported-or-estimated' } } : {}),
    ...(profileDraft.mediaImages ? { imageGeneration: { model: 'gemini-3.1-flash-image', pricingRevision: `gemini-image-v1|${profileDraft.imageInputRate}|${profileDraft.imageOutputRate}` } } : {}),
    ...(profileDraft.mediaSpeech ? { transcription: { model: 'gemini-3.5-transcribe', pricingRevision: `gemini-speech-v1|${profileDraft.speechInputRate}|${profileDraft.speechOutputRate}` } } : {})
  }
}
const profilePayload = () => ({ transportKind: profileDraft.transportKind, model: profileDraft.model, utilityModel: profileDraft.utilityModel.trim() || null, baseUrl: profileDraft.baseUrl, authMode: profileDraft.authMode, secretReference: null, ...(profileDraft.secretValue ? { secretValue: profileDraft.secretValue } : {}), adapterConfig: { ...mediaPayload(), timeoutMs: profileDraft.timeoutMs, maxRetries: profileDraft.maxRetries, additionalHeaders: profileDraft.additionalHeaders, ...(profileDraft.agentReasoningEffort === null ? {} : { agentReasoningEffort: profileDraft.agentReasoningEffort }), ...(profileDraft.utilityReasoningEffort === null ? {} : { utilityReasoningEffort: profileDraft.utilityReasoningEffort }) }, capabilities: { streaming: profileDraft.streaming, toolCalling: profileDraft.toolCalling, parallelToolCalls: profileDraft.parallelToolCalls, structuredOutput: profileDraft.structuredOutput, usage: profileDraft.usage, cancellation: profileDraft.cancellation, maxContextTokens: profileDraft.maxContextTokens, maxOutputTokens: profileDraft.maxOutputTokens }, capabilityRevision: agentProviderCapabilityRevision(profileDraft.transportKind), policies: { allowedModes: ['agent'], dailyTokens: profileDraft.dailyTokens, dailyCostMicros: profileDraft.dailyCostMicros, reservationTokens: profileDraft.reservationTokens, reservationCostMicros: profileDraft.reservationCostMicros, reservationMilliseconds: profileDraft.reservationMilliseconds, promptVersion: profileDraft.promptVersion, maxAttempts: profileDraft.maxAttempts }, pricingRevision: AGENT_PROVIDER_PRICING_REVISION })
const saveProfile = async (): Promise<void> => {
  if (saving.value || !profileDirty.value) return
  if (!profileDraftValid.value) {
    const invalidStep = profileSteps.value.find(step => !profileStepIsValid(step.value))
    if (invalidStep) profileStep.value = invalidStep.value
    profileError.value = t('admin:agentAdmin.reviewHighlightedProviderSettings')
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
    if (result.connectionCheck.status === 'failed') profileWarnings[result.profile.id] = t('admin:agentAdmin.profileSavedButConnection', { value: result.connectionCheck.message ?? result.connectionCheck.errorCode ?? t('admin:agentAdmin.providerConnectionCheckFailed'), interpolation: { escapeValue: false } })
    else delete profileWarnings[result.profile.id]
    await refreshResources(['profiles', 'runtime'])
  } catch (value) {
    profileError.value = value instanceof Error ? value.message : t('admin:agentAdmin.providerProfileCouldNot')
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
const removeProfile = () => run(async () => { if (!removingProfile.value) return; const profile = removingProfile.value; await request(`/_api/agents/admin/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE' }); delete profileWarnings[profile.id]; removingProfile.value = null; await refreshResources(profile.isGlobalDefault ? ['profiles', 'runtime'] : ['profiles']) }, 'remove', message => { removeError.value = message })
const willBecomeDefault = (profile: Profile): boolean => profile.exposureMode === 'all_agent_users' && !profiles.value.some(candidate => candidate.isGlobalDefault)
const enableProfileSubtitle = (profile: Profile): string => willBecomeDefault(profile) ? t('admin:agentAdmin.alsoBecomesWorkspaceDefault') : profile.exposureMode === 'all_agent_users' ? t('admin:agentAdmin.makesAvailableEveryAgent') : t('admin:agentAdmin.makesAvailableGrantedGroups')
const connectionActionSubtitle = (profile: Profile): string => profile.status === 'disabled' ? willBecomeDefault(profile) ? t('admin:agentAdmin.successfulCheckEnablesSets') : t('admin:agentAdmin.successfulCheckEnablesProfile') : t('admin:agentAdmin.runsLiveCapabilityCheck')
const confirmEnableProfile = (profile: Profile): void => { enableError.value = ''; enablingProfile.value = profile }
const enableConfirmedProfile = (): void => {
  const profile = enablingProfile.value
  if (!profile) return
  void run(async () => { await request(`/_api/agents/admin/profiles/${encodeURIComponent(profile.id)}/enabled`, { method: 'POST', body: JSON.stringify({ enabled: true }) }); await refreshResources(willBecomeDefault(profile) ? ['profiles', 'runtime'] : ['profiles']); enablingProfile.value = null }, `enabled:${profile.id}`, message => { enableError.value = message })
}
const setProfileEnabled = (profile: Profile, enabled: boolean) => run(async () => { await request(`/_api/agents/admin/profiles/${encodeURIComponent(profile.id)}/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }); await refreshResources(profile.isGlobalDefault || (enabled && willBecomeDefault(profile)) ? ['profiles', 'runtime'] : ['profiles']) }, `enabled:${profile.id}`)
const setDefault = (profile: Profile) => run(async () => { await request(`/_api/agents/admin/profiles/${encodeURIComponent(profile.id)}/default`, { method: 'POST', body: '{}' }); await refreshResources(['profiles', 'runtime']) }, `default:${profile.id}`)
const testConnection = (profile: Profile) => run(async () => {
  const result = await request<{ profile: Profile; connectionCheck: ConnectionCheck }>(`/_api/agents/admin/profiles/${encodeURIComponent(profile.id)}/connection-check`, { method: 'POST', body: JSON.stringify({ enableOnSuccess: profile.status === 'disabled' }) })
  if (result.connectionCheck.status === 'passed') delete profileWarnings[profile.id]
  await refreshResources(profile.isGlobalDefault || (profile.status === 'disabled' && willBecomeDefault(profile)) ? ['profiles', 'runtime'] : ['profiles'])
  if (result.connectionCheck.status === 'failed') throw new Error(result.connectionCheck.message ?? result.connectionCheck.errorCode ?? t('admin:agentAdmin.providerConnectionCheckFailed'))
}, `test:${profile.id}`)
const loadConnectionHistory = async () => {
  const profile = connectionHistoryProfile.value
  if (!profile) return
  connectionHistoryController?.abort()
  const controller = new AbortController()
  connectionHistoryController = controller
  connectionHistoryLoading.value = true
  connectionHistoryError.value = ''
  try {
    const result = await request<{ connectionChecks: ConnectionHistoryCheck[] }>(`/_api/agents/admin/profiles/${encodeURIComponent(profile.id)}/connection-checks`, { signal: controller.signal })
    if (!controller.signal.aborted) connectionHistory.value = result.connectionChecks
  } catch (value) {
    if (!controller.signal.aborted) connectionHistoryError.value = value instanceof Error ? value.message : t('admin:agentAdmin.couldNotLoadConnection')
  } finally {
    if (connectionHistoryController === controller) connectionHistoryLoading.value = false
  }
}
const openConnectionHistory = (profile: Profile) => {
  connectionHistoryProfile.value = profile
  connectionHistory.value = []
  connectionHistoryDialog.value = true
  void loadConnectionHistory()
}
watch(connectionHistoryDialog, open => { if (!open) connectionHistoryController?.abort() })
const groupNames = (groupIds: readonly number[]): string => groupIds.length ? groupIds.map(id => groups.value.find(group => group.id === id)?.name ?? t('admin:agentAdmin.group', { id, interpolation: { escapeValue: false } })).join(', ') : t('admin:agentAdmin.noSelectedGroups')
const openGrants = (profile: Profile) => { grantsError.value = ''; grantProfile.value = profile; grantDraft.exposureMode = profile.exposureMode; grantDraft.groupIds = [...profile.groupIds]; grantsDialog.value = true; void refreshResources(['groups']) }
const saveGrants = () => {
  if (!grantProfile.value || !grantsDirty.value) return
  const profile = grantProfile.value
  void run(async () => { await request(`/_api/agents/admin/profiles/${encodeURIComponent(profile.id)}/grants`, { method: 'PUT', body: JSON.stringify({ exposureMode: grantDraft.exposureMode, groupIds: grantDraft.exposureMode === 'groups' ? grantDraft.groupIds : [] }) }); grantsDialog.value = false; await refreshResources(profile.isGlobalDefault ? ['profiles', 'runtime'] : ['profiles']) }, 'grants', message => { grantsError.value = message })
}
const browserUrlError = computed(() => {
  const input = browserUrl.value.trim()
  if (!input) return t('admin:agentAdmin.enterExactCanonicalHttps')
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || !url.hostname) return t('admin:agentAdmin.browserTargetsMustUse')
    if (url.username || url.password) return t('admin:agentAdmin.browserTargetsCannotContain')
    if (url.hash) return t('admin:agentAdmin.browserTargetsCannotContain2')
    if (/%[0-9a-f]{2}/i.test(url.pathname)) return t('admin:agentAdmin.browserTargetPathsCannot')
    const keys = [...url.searchParams.keys()]
    if (new Set(keys).size !== keys.length) return t('admin:agentAdmin.browserTargetQueryKeys')
    url.hostname = url.hostname.toLowerCase().replace(/\.$/, '')
    url.search = url.searchParams.size > 0 ? `?${url.searchParams.toString()}` : ''
    if (url.toString() !== input) return t('admin:agentAdmin.useExactCanonicalUrl', { url: url.toString(), interpolation: { escapeValue: false } })
    return ''
  } catch {
    return t('admin:agentAdmin.enterValidAbsoluteHttps')
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
  await refreshResources(['browser'])
}, 'browser-create', message => { browserError.value = message })
const updateBrowserTarget = (target: BrowserTarget, enabled: boolean, onError: (message: string) => void): void => {
  void run(async () => {
    await request(`/_api/agents/admin/browser-targets/${encodeURIComponent(target.id)}`, { method: 'PUT', body: JSON.stringify({ enabled }) })
    await refreshResources(['browser'])
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
  connectionHistoryController?.abort()
  for (const controller of resourceControllers.values()) controller.abort()
  resourceControllers.clear()
})
const restoreSection = () => {
  const requested = window.location.hash.slice(1)
  tab.value = sectionItems.value.some(section => section.value === requested) ? requested : 'overview'
}
watch(tab, value => {
  const url = new URL(window.location.href)
  url.hash = value === 'overview' ? '' : value
  window.history.replaceState(window.history.state, '', url)
})
onMounted(() => {
  restoreSection()
  window.addEventListener('hashchange', restoreSection)
  void load()
})
onBeforeUnmount(() => window.removeEventListener('hashchange', restoreSection))
</script>

<style scoped>
.agent-control {
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-body);
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

.agent-global-error {
  margin-block-end: var(--wiki-space-4);
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-error)) 28%, transparent);
  border-radius: var(--wiki-control-radius);
}
.agent-operation-status {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}


.agent-global-error :deep(.v-alert__content) {
  display: grid;
  gap: var(--wiki-space-1);
}

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

.agent-panel__icon--teal,
.agent-empty__icon--teal,
.target-row__icon,
.compact-dialog__header--teal > span {
  border-color: var(--wiki-purpose-info-edge);
  background: var(--wiki-purpose-info-fill);
  color: var(--wiki-purpose-info-ink);
}

.compact-dialog .compact-dialog__header--teal {
  border-block-end: 1px solid var(--wiki-purpose-info-edge);
  background: var(--wiki-purpose-info-fill);
}

.provider-card__models span,
.provider-card__meta small,
.selection-preview small {
  color: var(--wiki-text-muted);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .06em;
  text-transform: uppercase;
}


.agent-workspace { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--wiki-space-6); }
.agent-sections { display: flex; gap: var(--wiki-space-1); min-width: 0; overflow-x: auto; padding-block-end: var(--wiki-space-2); border-block-end: 1px solid var(--wiki-surface-border); scrollbar-width: thin; }
.agent-section {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  min-height: var(--wiki-control-height);
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-3);
  align-items: center;
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

.agent-section__icon {
  display: grid;
  width: auto;
  height: auto;
  place-items: center;
  color: var(--wiki-text-muted);
}

.agent-section--active .agent-section__icon {
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
  color: var(--wiki-text-muted);
  font-size: max(.7rem, var(--wiki-label-size));
}

.agent-section__badge {
  justify-self: end;
  color: var(--wiki-accent-ink);
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
  color: var(--wiki-text-muted);
  font-size: .78rem;
}

.agent-panel__state {
  display: grid;
  flex: 0 0 auto;
  justify-items: end;
  gap: var(--wiki-space-1);
}

.agent-panel__state > span {
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
  font-size: .75rem;
  font-weight: 650;
}

.capability-item small {
  grid-column: 2;
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
  font-size: var(--wiki-label-size);
}


.connection-state {
  display: inline-flex;
  align-items: center;
  gap: var(--wiki-space-1);
  padding: var(--wiki-space-1) var(--wiki-space-2);
  border-radius: var(--wiki-radius-pill);
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 6%, transparent);
  color: var(--wiki-text-muted);
  font-size: max(.7rem, var(--wiki-label-size));
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
  font-size: max(.7rem, var(--wiki-label-size));
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
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
}

.browser-boundary-note {
  margin-block: 0 var(--wiki-space-4);
  color: var(--wiki-text-muted);
  font-size: .75rem;
  line-height: 1.5;
}

.browser-boundary-note .v-icon {
  flex: 0 0 auto;
  color: var(--wiki-purpose-info-ink);
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
  color: var(--wiki-text-muted);
  font-family: var(--wiki-font-mono);
  font-size: max(.7rem, var(--wiki-label-size));
}

.target-row__state {
  display: flex;
  align-items: center;
  gap: var(--wiki-space-2);
  color: var(--wiki-text-muted);
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

.profile-steps button:hover:not([aria-disabled="true"]) {
  background: color-mix(in srgb, var(--wiki-accent-warm) 5%, transparent);
}

.profile-steps button[aria-disabled="true"] {
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
  color: var(--wiki-text-muted);
  font-family: var(--wiki-font-mono);
  font-size: max(.7rem, var(--wiki-label-size));
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
  color: var(--wiki-text-muted);
  font-size: max(.7rem, var(--wiki-label-size));
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
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
  font-size: max(.7rem, var(--wiki-label-size));
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
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
  font-size: .7rem;
  line-height: 1.45;
}

.access-choice__check {
  color: var(--wiki-accent-ink);
}

.limit-group h4 {
  margin-block-end: var(--wiki-space-3);
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
  font-size: max(.7rem, var(--wiki-label-size));
}

.profile-editor__save-state {
  align-items: center;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--wiki-space-2);
  margin-inline-start: var(--wiki-space-3);
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
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


.agent-overview__intro { max-width: 43rem; padding-block: var(--wiki-space-1) calc(var(--wiki-space-6) + var(--wiki-space-1)); }
.agent-overview__intro h2 { font: 500 clamp(1.6rem, 2.4vw, 2rem)/1.2 var(--wiki-font-display); margin-block: var(--wiki-space-3) var(--wiki-space-4); }
.agent-overview__intro p { max-width: 60ch; font-size: .95rem; line-height: 1.7; }
.agent-overview__grid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: var(--wiki-space-6); }
.agent-setup, .agent-default { padding: clamp(var(--wiki-space-4), 2vw, calc(var(--wiki-space-6) + var(--wiki-space-1))); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); background: var(--wiki-surface-raised); }
.agent-setup h3, .agent-default h3 { font: 500 1.4rem var(--wiki-font-display); }
.agent-overview__caption { font-size: .8rem; line-height: 1.6; margin-block: var(--wiki-space-3) var(--wiki-space-4); }
.agent-setup__step { appearance: none; background: transparent; color: inherit; border: 0; cursor: pointer; display: flex; width: 100%; align-items: center; gap: var(--wiki-space-3); padding: var(--wiki-space-4) 0; border-top: 1px solid var(--wiki-surface-border); text-align: start; }
.agent-setup__step > span { display: grid; flex: 1; gap: var(--wiki-space-1); min-width: 0; }
.agent-setup__step strong { font-size: .9rem; }
.agent-setup__step small { font-size: .8rem; line-height: 1.5; overflow-wrap: anywhere; }
.agent-setup__step:focus-visible, .agent-pathways button:focus-visible, .agent-memory-sources button:focus-visible { outline: 2px solid var(--wiki-accent-ink); outline-offset: 3px; }
.agent-default { background: color-mix(in srgb, var(--wiki-accent-warm) 5%, var(--wiki-surface-raised)); }
.agent-default h3 { margin-block: var(--wiki-space-6) var(--wiki-space-2); overflow-wrap: anywhere; }
.agent-default code { font-family: var(--wiki-font-mono); font-size: .85rem; overflow-wrap: anywhere; }
.agent-default p { font-size: .85rem; line-height: 1.7; margin-block: var(--wiki-space-4) var(--wiki-space-6); }
.agent-pathways { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-block: 1px solid var(--wiki-surface-border); }
.agent-pathways button { appearance: none; background: transparent; color: inherit; border: 0; cursor: pointer; display: flex; align-items: start; gap: var(--wiki-space-3); padding: var(--wiki-space-6) var(--wiki-space-4); text-align: start; }
.agent-pathways button > span { display: grid; gap: var(--wiki-space-2); flex: 1; }
.agent-pathways strong { font-size: .9rem; }
.agent-pathways small { font-size: .8rem; line-height: 1.6; }
.agent-memory-sources { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--wiki-space-6); margin-bottom: var(--wiki-space-8); }
.agent-memory-sources h3 { font: 500 1.2rem var(--wiki-font-display); margin-block: var(--wiki-space-3); }
.agent-memory-sources p { font-size: .85rem; line-height: 1.7; margin-block: var(--wiki-space-3); }
.agent-memory-sources button { appearance: none; border: 0; background: transparent; cursor: pointer; }
.agent-memory-sources a, .agent-memory-sources button { color: var(--wiki-accent-ink); font-size: .85rem; text-decoration: underline; }
.agent-retention { display: grid; margin-bottom: var(--wiki-space-6); }
.agent-retention > div { display: grid; grid-template-columns: 1fr 1fr; gap: var(--wiki-space-4); padding-block: var(--wiki-space-3); border-bottom: 1px solid var(--wiki-surface-border); font-size: .85rem; }
.agent-retention dd { margin: 0; font-weight: 600; }
.provider-inventory-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) minmax(12rem, .4fr); gap: var(--wiki-space-4); margin-block: var(--wiki-space-6) var(--wiki-space-4); }
.provider-inventory-count { font-size: .8rem; margin-bottom: var(--wiki-space-4); }
@media (max-width: 960px) {

  .profile-editor__workspace {
    grid-template-columns: 13rem minmax(0, 1fr);
  }

  .profile-editor__footer { flex-wrap: wrap; }
  .profile-editor__save-state { width: 100%; margin-inline-start: 0; }
}

@media (max-width: 839.98px) {
  .profile-editor {
    border: 0;
    border-radius: 0 !important;
    box-shadow: none !important;
  }
}

@media (max-width: 760px) {
  .agent-overview__grid, .provider-inventory-toolbar { grid-template-columns: 1fr; }
  .agent-retention > div { grid-template-columns: 1fr; gap: var(--wiki-space-1); }



  .agent-hero__refresh {
    width: 100%;
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

  .agent-panel__icon--teal,
  .agent-empty__icon--teal,
  .target-row__icon,
  .compact-dialog__header--teal > span,
  .compact-dialog .compact-dialog__header--teal {
    border-color: CanvasText;
    background: Canvas;
    color: CanvasText;
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
@media (max-width: 1100px) { .agent-memory-sources, .agent-pathways { grid-template-columns: 1fr; } .agent-pathways button + button { border-top: 1px solid var(--wiki-surface-border); } }
.media-storage-help { font-size: .8rem; line-height: 1.6; }
.media-storage-help summary { width: fit-content; cursor: pointer; color: var(--wiki-accent-ink, rgb(var(--v-theme-primary))); }
.media-storage-help summary:focus-visible { outline: 2px solid var(--wiki-accent-ink); outline-offset: 3px; border-radius: 2px; }
.media-storage-help dl { margin-block: .65rem 0; }
.media-storage-help dt { font-weight: 600; margin-top: .65rem; }
.media-storage-help dd { margin: .1rem 0 0; color: var(--wiki-text-muted); }
.connection-history details { padding-block: 1rem; border-bottom: 1px solid var(--wiki-surface-border); }
.connection-history summary { display: flex; flex-wrap: wrap; align-items: center; gap: .7rem; cursor: pointer; font-size: .85rem; }
.connection-history summary:focus-visible { outline: 2px solid var(--wiki-accent-ink); outline-offset: 3px; }
.connection-history time { margin-inline-start: auto; }
.connection-history p, .connection-history ul { margin-block: .75rem; font-size: .85rem; line-height: 1.6; overflow-wrap: anywhere; }
.connection-history ul { padding-inline-start: 1.25rem; }
</style>
