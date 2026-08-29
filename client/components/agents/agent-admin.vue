<template>
  <section class="agent-control" aria-labelledby="admin-title">
    <section class="agent-hero">
      <div class="agent-hero__copy">
        <div class="agent-eyebrow">
          <span class="agent-eyebrow__signal" aria-hidden="true" />
          Agent control center
        </div>
        <h1 id="admin-title">{{ embedded ? 'Agents' : 'Agent administration' }}</h1>
        <p>Shape how AI operates across this workspace—from model access and specialist knowledge to browser boundaries and runtime safeguards.</p>
        <div class="agent-hero__status">
          <v-chip size="small" variant="tonal" :color="runtime?.enabled ? 'success' : 'warning'" :prepend-icon="runtime?.enabled ? 'mdi-check-circle-outline' : 'mdi-pause-circle-outline'">
            {{ runtime?.enabled ? 'Agent runtime active' : 'Agent runtime paused' }}
          </v-chip>
          <v-chip size="small" variant="outlined" prepend-icon="mdi-shield-check-outline">Policy governed</v-chip>
        </div>
      </div>
      <div class="agent-hero__actions">
        <v-btn variant="tonal" color="primary" prepend-icon="mdi-refresh" :loading="loading" @click="load">Refresh status</v-btn>
      </div>
      <div class="agent-hero__art" aria-hidden="true">
        <span class="agent-hero__orbit agent-hero__orbit--outer" />
        <span class="agent-hero__orbit agent-hero__orbit--inner" />
        <span class="agent-hero__node agent-hero__node--one" />
        <span class="agent-hero__node agent-hero__node--two" />
        <span class="agent-hero__node agent-hero__node--three" />
        <v-icon size="42">mdi-creation-outline</v-icon>
      </div>
    </section>

    <v-alert v-if="error" class="mb-5" type="error" variant="tonal" closable @click:close="error = ''">{{ error }}</v-alert>

    <section class="agent-snapshot" aria-label="Agent platform status">
      <article class="agent-snapshot__item">
        <span class="agent-snapshot__icon agent-snapshot__icon--blue"><v-icon size="21">mdi-server-network-outline</v-icon></span>
        <span><small>Runtime policy</small><strong>{{ enabledCapabilityCount }} of {{ capabilityRows.length }} capabilities</strong></span>
      </article>
      <article class="agent-snapshot__item">
        <span class="agent-snapshot__icon agent-snapshot__icon--violet"><v-icon size="21">mdi-brain</v-icon></span>
        <span><small>Provider profiles</small><strong>{{ enabledProviderCount }} enabled · {{ profiles.length }} total</strong></span>
      </article>
      <article class="agent-snapshot__item">
        <span class="agent-snapshot__icon agent-snapshot__icon--teal"><v-icon size="21">mdi-web-check</v-icon></span>
        <span><small>Browser boundary</small><strong>{{ enabledBrowserCount }} approved target{{ enabledBrowserCount === 1 ? '' : 's' }}</strong></span>
      </article>
    </section>

    <div class="agent-workspace">
      <nav class="agent-sections" aria-label="Agent administration sections">
        <div class="agent-sections__label">Configure</div>
        <button
          v-for="section in sectionItems"
          :key="section.value"
          type="button"
          class="agent-section"
          :class="{ 'agent-section--active': tab === section.value }"
          :aria-current="tab === section.value ? 'page' : undefined"
          @click="tab = section.value"
        >
          <span class="agent-section__icon"><v-icon size="21">{{ section.icon }}</v-icon></span>
          <span class="agent-section__copy"><strong>{{ section.title }}</strong><small>{{ section.description }}</small></span>
          <v-chip v-if="section.badge" class="agent-section__badge" size="x-small" variant="tonal">{{ section.badge }}</v-chip>
          <v-icon class="agent-section__arrow" size="18">mdi-chevron-right</v-icon>
        </button>
        <div class="agent-sections__note">
          <v-icon size="18">mdi-lock-outline</v-icon>
          <span>Every change is policy-scoped and recorded in the audit ledger.</span>
        </div>
      </nav>

      <v-window v-model="tab" class="agent-content">
        <v-window-item value="runtime">
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
              <v-chip variant="tonal" :color="runtime?.enabled ? 'success' : 'warning'" size="small">{{ runtime?.enabled ? 'Active' : 'Paused' }}</v-chip>
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

        <v-window-item value="profiles">
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
              <v-btn color="primary" prepend-icon="mdi-plus" :disabled="runtime?.providerEnabled !== true" @click="openProfile()">Add provider</v-btn>
            </div>
            <div class="agent-panel__body">
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
                      <template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" icon="mdi-dots-horizontal" variant="text" density="comfortable" :aria-label="`Actions for ${profile.displayName}`" /></template>
                      <v-list density="comfortable">
                        <v-list-item prepend-icon="mdi-pencil-outline" title="Edit settings" subtitle="Updates this profile" @click="openProfile(profile)" />
                        <v-list-item prepend-icon="mdi-connection" :title="profile.status === 'disabled' ? 'Test and enable' : 'Test connection'" :disabled="!profile.secretConfigured" @click="testConnection(profile)" />
                        <v-list-item prepend-icon="mdi-account-multiple-outline" title="Edit access grants" @click="openGrants(profile)" />
                        <v-list-item v-if="profile.status === 'disabled'" prepend-icon="mdi-play-circle-outline" title="Enable" :disabled="!profile.conformed || !profile.secretConfigured" @click="setProfileEnabled(profile, true)" />
                        <v-list-item v-else prepend-icon="mdi-pause-circle-outline" title="Disable" @click="setProfileEnabled(profile, false)" />
                        <v-list-item prepend-icon="mdi-star-outline" title="Set global default" :disabled="!profile.conformed || profile.status !== 'enabled' || profile.exposureMode !== 'all_agent_users'" @click="setDefault(profile)" />
                        <v-divider class="my-1" />
                        <v-list-item prepend-icon="mdi-delete-outline" title="Remove provider" base-color="error" @click="confirmRemove(profile)" />
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
                  <div class="provider-card__models">
                    <div><span>Agent model</span><code>{{ profile.model }}</code></div>
                    <div><span>Utility model</span><code>{{ profile.utilityModel || profile.model }}</code><small v-if="!profile.utilityModel">Shared</small></div>
                  </div>
                  <p v-if="!profile.conformed && profile.connectionCheck?.message" class="provider-card__error">{{ profile.connectionCheck.message }}</p>
                  <div class="provider-card__meta">
                    <div><v-icon size="17">mdi-account-multiple-outline</v-icon><span><small>Available to</small><strong>{{ profile.exposureMode === 'all_agent_users' ? 'Everyone' : groupNames(profile.groupIds) }}</strong></span></div>
                    <div><v-icon size="17">mdi-server-outline</v-icon><span><small>Destination</small><strong>{{ profile.destinationHost }}</strong></span></div>
                  </div>
                  <button type="button" class="provider-card__edit" @click="openProfile(profile)">Open configuration <v-icon size="17">mdi-arrow-right</v-icon></button>
                </article>
              </div>
              <div v-else class="agent-empty">
                <span class="agent-empty__icon"><v-icon size="34">mdi-brain</v-icon></span>
                <h3>Connect the first provider</h3>
                <p>Start with the model your team trusts. Wiki verifies the connection and capabilities before making it available.</p>
                <v-btn color="primary" prepend-icon="mdi-plus" :disabled="runtime?.providerEnabled !== true" @click="openProfile()">Add provider</v-btn>
              </div>
            </div>
          </section>
        </v-window-item>

        <v-window-item value="skills">
          <SkillAdmin :csrf-token="csrfToken" embedded />
        </v-window-item>

        <v-window-item value="browser">
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
              <v-btn color="primary" prepend-icon="mdi-plus" @click="browserDialog = true">Add target</v-btn>
            </div>
            <div class="agent-panel__body">
              <v-alert type="info" variant="tonal" density="compact" class="mb-5">Redirects and every outgoing request are revalidated against these canonical targets by the browser worker.</v-alert>
              <div v-if="browserTargets.length" class="target-list">
                <article v-for="target in browserTargets" :key="target.id" class="target-row">
                  <span class="target-row__icon"><v-icon size="20">mdi-lock-outline</v-icon></span>
                  <div class="target-row__copy"><strong>{{ target.canonicalUrl }}</strong><small>Policy {{ target.policySha256.slice(0, 16) }}…</small></div>
                  <div class="target-row__state"><span>{{ target.enabled ? 'Allowed' : 'Paused' }}</span><v-switch :model-value="target.enabled" color="primary" hide-details inset :aria-label="`Enable ${target.canonicalUrl}`" @update:model-value="value => setBrowserEnabled(target, Boolean(value))" /></div>
                </article>
              </div>
              <div v-else class="agent-empty">
                <span class="agent-empty__icon agent-empty__icon--teal"><v-icon size="34">mdi-web-off</v-icon></span>
                <h3>No browser destinations approved</h3>
                <p>The Agent cannot browse external pages until an exact HTTPS target is added here.</p>
                <v-btn color="primary" prepend-icon="mdi-plus" @click="browserDialog = true">Add target</v-btn>
              </div>
            </div>
          </section>
        </v-window-item>
      </v-window>
    </div>

    <v-dialog v-model="profileDialog" max-width="76rem" scrollable :fullscreen="smAndDown">
      <v-card class="profile-editor">
        <div class="profile-editor__header">
          <span class="profile-editor__mark"><v-icon size="24">mdi-creation-outline</v-icon></span>
          <div>
            <div class="agent-panel__eyebrow">{{ editingProfile ? 'Provider configuration' : 'New inference connection' }}</div>
            <h2>{{ editingProfile ? `Edit ${editingProfile.displayName}` : 'Add provider profile' }}</h2>
            <p>{{ editingProfile ? 'Update the connection, models, or operating limits. Saving runs a fresh verification.' : 'A guided setup for a secure, verified Agent provider.' }}</p>
          </div>
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" aria-label="Close provider editor" @click="profileDialog = false" />
        </div>
        <v-progress-linear class="profile-editor__progress" color="primary" :model-value="profileProgress" aria-label="Provider setup progress" />
        <div class="profile-editor__workspace">
          <nav class="profile-steps" aria-label="Provider setup sections">
            <button v-for="(step, index) in profileSteps" :key="step.value" type="button" :class="{ 'profile-step--active': profileStep === step.value }" :aria-current="profileStep === step.value ? 'step' : undefined" @click="profileStep = step.value">
              <span class="profile-step__index">{{ index + 1 }}</span>
              <span><strong>{{ step.title }}</strong><small>{{ step.description }}</small></span>
              <v-icon size="17">mdi-chevron-right</v-icon>
            </button>
          </nav>
          <v-form id="provider-profile-form" class="profile-editor__form" @submit.prevent="saveProfile">
            <v-alert v-if="profileError" type="error" variant="tonal" density="compact" class="mb-5" closable @click:close="profileError = ''">{{ profileError }}</v-alert>

            <section v-if="profileStep === 'identity'" class="profile-form-section">
              <div class="profile-form-section__intro"><span><v-icon size="21">mdi-card-account-details-outline</v-icon></span><div><h3>Name the connection</h3><p>Choose the API contract first; Wiki derives the safe behavior from it.</p></div></div>
              <div class="form-grid">
                <v-text-field v-model="profileDraft.displayName" label="Display name" placeholder="Production Agent" required autofocus />
                <div class="protocol-field">
                  <v-select v-model="profileDraft.transportKind" :items="protocolOptions" item-title="title" item-value="value" label="API protocol" required @update:model-value="selectProtocol">
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
                <v-text-field v-model="profileDraft.model" label="Agent model" :hint="agentModelHint" persistent-hint required />
                <v-text-field v-model="profileDraft.utilityModel" label="Utility model (optional)" hint="Titles, enrichment, classification, and routing. Leave blank to share the Agent model." persistent-hint />
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
                <v-select v-model="profileDraft.toolCalling" :items="toolCallingOptions" item-title="title" item-value="value" label="Tool calling" :disabled="profileDraft.transportKind === 'legacy-completions'" hint="Native uses the API contract. Prompt-emulated supports models without native tools and is verified before enablement." persistent-hint @update:model-value="selectToolCalling" />
              </div>
            </section>

            <section v-else-if="profileStep === 'connection'" class="profile-form-section">
              <div class="profile-form-section__intro"><span><v-icon size="21">mdi-connection</v-icon></span><div><h3>Secure the connection</h3><p>Credentials stay server-managed and every save performs a live capability check.</p></div></div>
              <div class="form-grid">
                <v-text-field v-model="profileDraft.baseUrl" label="Base URL" hint="Public HTTPS API root; the selected endpoint path is appended." persistent-hint required />
                <v-select v-if="availableAuthModes.length > 1" v-model="profileDraft.authMode" :items="availableAuthModes" label="Authentication mode" />
                <v-text-field class="secret-field" v-model="profileDraft.secretValue" label="API key" type="password" autocomplete="new-password" :hint="editingProfile && editingProfile.secretConfigured ? 'Leave blank to retain the current encrypted credential, or enter a replacement.' : 'Encrypted with the server-managed provider key and never returned by the API.'" persistent-hint :required="!editingProfile || !editingProfile.secretConfigured" prepend-inner-icon="mdi-key-outline" />
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
              <v-alert type="info" variant="tonal" density="compact" class="mb-5">These safe defaults suit most deployments. Cost values are reservation ceilings; provider billing is not calculated in this release, so profiles use <code>unpriced-v1</code>.</v-alert>
              <div class="limit-group">
                <h4>Model boundaries</h4>
                <div class="form-grid"><v-text-field v-model.number="profileDraft.maxContextTokens" type="number" label="Maximum context tokens" /><v-text-field v-model.number="profileDraft.maxOutputTokens" type="number" label="Maximum output tokens" /></div>
              </div>
              <div class="limit-group">
                <h4>Daily ceilings</h4>
                <div class="form-grid"><v-text-field v-model.number="profileDraft.dailyTokens" type="number" label="Daily token limit" /><v-text-field v-model.number="profileDraft.dailyCostMicros" type="number" label="Daily cost reservation (micros)" /></div>
              </div>
              <div class="limit-group">
                <h4>Per-run reservations</h4>
                <div class="form-grid"><v-text-field v-model.number="profileDraft.reservationTokens" type="number" label="Token reservation" /><v-text-field v-model.number="profileDraft.reservationCostMicros" type="number" label="Cost reservation (micros)" /></div>
              </div>
              <div class="limit-group">
                <h4>Reliability</h4>
                <div class="form-grid"><v-text-field v-model.number="profileDraft.timeoutMs" type="number" label="Request timeout (ms)" /><v-text-field v-model.number="profileDraft.maxAttempts" type="number" label="Maximum attempts" /></div>
              </div>
            </section>
          </v-form>
        </div>
        <div class="profile-editor__footer">
          <div class="profile-editor__position"><strong>{{ currentProfileStep.title }}</strong><span>{{ profileStepIndex + 1 }} of {{ profileSteps.length }}</span></div>
          <v-spacer />
          <v-btn variant="text" @click="profileDialog = false">Cancel</v-btn>
          <v-btn v-if="profileStepIndex > 0" variant="outlined" prepend-icon="mdi-arrow-left" @click="previousProfileStep">Back</v-btn>
          <v-btn v-if="profileStepIndex < profileSteps.length - 1" variant="tonal" color="primary" append-icon="mdi-arrow-right" @click="nextProfileStep">Continue</v-btn>
          <v-btn color="primary" prepend-icon="mdi-check-decagram-outline" :loading="saving" form="provider-profile-form" type="submit">Save and verify</v-btn>
        </div>
      </v-card>
    </v-dialog>

    <v-dialog :model-value="removingProfile !== null" max-width="34rem" @update:model-value="value => { if (!value) removingProfile = null }">
      <v-card class="compact-dialog">
        <div class="compact-dialog__header compact-dialog__header--danger"><span><v-icon size="23">mdi-delete-outline</v-icon></span><div><h2>Remove provider profile?</h2><p>This cannot be undone.</p></div></div>
        <v-card-text><p><strong>{{ removingProfile?.displayName }}</strong> will no longer be available to sessions or new runs.</p><p class="mb-0">The configuration is removed from use and its server-managed API keys are permanently deleted. Audit records are retained.</p></v-card-text>
        <v-card-actions><v-spacer /><v-btn @click="removingProfile = null">Cancel</v-btn><v-btn color="error" :loading="saving" @click="removeProfile">Remove provider</v-btn></v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="grantsDialog" max-width="40rem" scrollable>
      <v-card class="compact-dialog">
        <div class="compact-dialog__header"><span><v-icon size="23">mdi-account-multiple-outline</v-icon></span><div><h2>{{ grantProfile ? `Access for ${grantProfile.displayName}` : 'Provider access' }}</h2><p>Control who can discover and use this profile.</p></div></div>
        <v-card-text>
          <v-select v-model="grantDraft.exposureMode" :items="exposureModes" label="Available to" />
          <v-autocomplete v-if="grantDraft.exposureMode === 'groups'" v-model="grantDraft.groupIds" :items="groups" item-title="name" item-value="id" label="Wiki groups" multiple chips closable-chips hint="Users receive this provider through any selected group." persistent-hint />
          <v-alert class="mt-4" type="info" variant="tonal" density="compact">The global default is available to everyone. Group-assigned profiles augment that default and appear as a session choice only when a user has more than one available profile.</v-alert>
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn @click="grantsDialog = false">Cancel</v-btn><v-btn color="primary" :loading="saving" :disabled="grantDraft.exposureMode === 'groups' && grantDraft.groupIds.length === 0" @click="saveGrants">Save access</v-btn></v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="browserDialog" max-width="40rem">
      <v-card class="compact-dialog">
        <div class="compact-dialog__header compact-dialog__header--teal"><span><v-icon size="23">mdi-web-plus</v-icon></span><div><h2>Add browser target</h2><p>Approve one exact canonical HTTPS destination.</p></div></div>
        <v-card-text><v-text-field v-model="browserUrl" label="Exact HTTPS URL" placeholder="https://example.com/path" autofocus prepend-inner-icon="mdi-lock-outline" /><v-checkbox v-model="browserEnabled" label="Enable immediately" /></v-card-text>
        <v-card-actions><v-spacer /><v-btn @click="browserDialog = false">Cancel</v-btn><v-btn color="primary" :loading="saving" @click="createBrowserTarget">Add target</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
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

const props = withDefaults(defineProps<{ csrfToken: string; embedded?: boolean }>(), { embedded: false })
const { smAndDown } = useDisplay()
const { embedded } = props
const tab = ref('runtime')
type ProfileStep = 'identity' | 'models' | 'connection' | 'access' | 'limits'
const profileStep = ref<ProfileStep>('identity')
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const profileError = ref('')
const runtime = ref<RuntimePolicy | null>(null)
const profiles = ref<Profile[]>([])
const groups = ref<GroupOption[]>([])
const browserTargets = ref<BrowserTarget[]>([])
const profileDialog = ref(false)
const grantsDialog = ref(false)
const browserDialog = ref(false)
const editingProfile = ref<Profile | null>(null)
const removingProfile = ref<Profile | null>(null)
const grantProfile = ref<Profile | null>(null)
const browserUrl = ref('')
const browserEnabled = ref(false)
const grantDraft = reactive({ exposureMode: 'all_agent_users' as 'all_agent_users' | 'groups', groupIds: [] as number[] })
const protocolOptions = AGENT_PROVIDER_PROTOCOL_OPTIONS.filter(option => agentProviderProtocolExecutionModes(option.value).includes('agent'))
const exposureModes = [{ title: 'Everyone', value: 'all_agent_users' }, { title: 'Selected Wiki groups', value: 'groups' }]
const toolCallingOptions = [
  { title: 'Native API tools', value: 'native' as const },
  { title: 'Prompt-emulated tools', value: 'prompt' as const }
]
const defaults = (): ProfileDraft => ({ displayName: '', transportKind: 'openai-responses', model: '', utilityModel: '', agentReasoningEffort: null, utilityReasoningEffort: null, ...agentProviderProtocolDefaults('openai-responses'), secretValue: '', exposureMode: 'all_agent_users', groupIds: [], maxContextTokens: 128000, maxOutputTokens: 8192, dailyTokens: 1000000, dailyCostMicros: 10000000, reservationTokens: 32000, reservationCostMicros: 1000000, reservationMilliseconds: 300000, timeoutMs: 120000, maxRetries: 0, maxAttempts: 3, promptVersion: 1, additionalHeaders: {} })
const profileDraft = reactive<ProfileDraft>(defaults())
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
const sectionItems = computed(() => [
  { value: 'runtime', title: 'Runtime', description: 'Policy and safeguards', icon: 'mdi-tune-variant', badge: runtime.value?.enabled ? 'Active' : 'Paused' },
  { value: 'profiles', title: 'Providers', description: 'Models and access', icon: 'mdi-brain', badge: profiles.value.length ? String(profiles.value.length) : '' },
  { value: 'skills', title: 'Skills', description: 'Approved expertise', icon: 'mdi-book-open-variant-outline', badge: '' },
  { value: 'browser', title: 'Browser access', description: 'Network boundaries', icon: 'mdi-web-check', badge: browserTargets.value.length ? String(browserTargets.value.length) : '' }
])
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
const previousProfileStep = () => {
  const previous = profileSteps.value[profileStepIndex.value - 1]
  if (previous) profileStep.value = previous.value
}
const nextProfileStep = () => {
  const next = profileSteps.value[profileStepIndex.value + 1]
  if (next) profileStep.value = next.value
}

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.method && init.method !== 'GET' ? { 'x-wiki-csrf': props.csrfToken } : {}), ...init.headers } })
  if (!response.ok) { const body = await response.json().catch(() => ({})) as { message?: string; error?: string }; throw new Error(body.message ?? body.error ?? `Request failed (${response.status})`) }
  return response.status === 204 ? undefined as T : await response.json() as T
}
const run = async (operation: () => Promise<void>) => { saving.value = true; error.value = ''; try { await operation() } catch (value) { error.value = value instanceof Error ? value.message : 'Agent administration request failed.' } finally { saving.value = false } }
const load = async () => { loading.value = true; error.value = ''; try { const [runtimeResult, profileResult, browserResult, groupResult] = await Promise.all([request<{ runtime: RuntimePolicy }>('/_api/agents/admin/runtime'), request<{ profiles: Profile[] }>('/_api/agents/admin/profiles'), request<{ targets: BrowserTarget[] }>('/_api/agents/admin/browser-targets'), request<GroupOption[]>('/_api/groups')]); runtime.value = runtimeResult.runtime; profiles.value = profileResult.profiles; browserTargets.value = browserResult.targets; groups.value = groupResult } catch (value) { error.value = value instanceof Error ? value.message : 'Agent administration could not be loaded.' } finally { loading.value = false } }
const openProfile = (profile?: Profile) => {
  profileError.value = ''
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
  profileDialog.value = true
}
const profilePayload = () => ({ transportKind: profileDraft.transportKind, model: profileDraft.model, utilityModel: profileDraft.utilityModel.trim() || null, baseUrl: profileDraft.baseUrl, authMode: profileDraft.authMode, secretReference: null, ...(profileDraft.secretValue ? { secretValue: profileDraft.secretValue } : {}), adapterConfig: { timeoutMs: profileDraft.timeoutMs, maxRetries: profileDraft.maxRetries, additionalHeaders: profileDraft.additionalHeaders, ...(profileDraft.agentReasoningEffort === null ? {} : { agentReasoningEffort: profileDraft.agentReasoningEffort }), ...(profileDraft.utilityReasoningEffort === null ? {} : { utilityReasoningEffort: profileDraft.utilityReasoningEffort }) }, capabilities: { streaming: profileDraft.streaming, toolCalling: profileDraft.toolCalling, parallelToolCalls: profileDraft.parallelToolCalls, structuredOutput: profileDraft.structuredOutput, usage: profileDraft.usage, cancellation: profileDraft.cancellation, maxContextTokens: profileDraft.maxContextTokens, maxOutputTokens: profileDraft.maxOutputTokens }, capabilityRevision: agentProviderCapabilityRevision(profileDraft.transportKind), policies: { allowedModes: ['agent'], dailyTokens: profileDraft.dailyTokens, dailyCostMicros: profileDraft.dailyCostMicros, reservationTokens: profileDraft.reservationTokens, reservationCostMicros: profileDraft.reservationCostMicros, reservationMilliseconds: profileDraft.reservationMilliseconds, promptVersion: profileDraft.promptVersion, maxAttempts: profileDraft.maxAttempts }, pricingRevision: AGENT_PROVIDER_PRICING_REVISION })
const saveProfile = async (): Promise<void> => {
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
const confirmRemove = (profile: Profile) => { removingProfile.value = profile }
const removeProfile = () => run(async () => { if (!removingProfile.value) return; await request(`/_api/agents/admin/profiles/${encodeURIComponent(removingProfile.value.id)}`, { method: 'DELETE' }); removingProfile.value = null; await load() })
const setProfileEnabled = (profile: Profile, enabled: boolean) => run(async () => { await request(`/_api/agents/admin/profiles/${profile.id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }); await load() })
const setDefault = (profile: Profile) => run(async () => { await request(`/_api/agents/admin/profiles/${profile.id}/default`, { method: 'POST', body: '{}' }); await load() })
const testConnection = (profile: Profile) => run(async () => {
  const result = await request<{ profile: Profile; connectionCheck: ConnectionCheck }>(`/_api/agents/admin/profiles/${profile.id}/connection-check`, { method: 'POST', body: JSON.stringify({ enableOnSuccess: profile.status === 'disabled' }) })
  await load()
  if (result.connectionCheck.status === 'failed') throw new Error(result.connectionCheck.message ?? result.connectionCheck.errorCode ?? 'Provider connection check failed.')
})
const groupNames = (groupIds: readonly number[]): string => groupIds.map(id => groups.value.find(group => group.id === id)?.name ?? `Group ${id}`).join(', ')
const openGrants = (profile: Profile) => { grantProfile.value = profile; grantDraft.exposureMode = profile.exposureMode; grantDraft.groupIds = [...profile.groupIds]; grantsDialog.value = true }
const saveGrants = () => run(async () => { if (!grantProfile.value) return; await request(`/_api/agents/admin/profiles/${grantProfile.value.id}/grants`, { method: 'PUT', body: JSON.stringify({ exposureMode: grantDraft.exposureMode, groupIds: grantDraft.exposureMode === 'groups' ? grantDraft.groupIds : [] }) }); grantsDialog.value = false; await load() })
const createBrowserTarget = () => run(async () => { await request('/_api/agents/admin/browser-targets', { method: 'POST', body: JSON.stringify({ canonicalUrl: browserUrl.value, enabled: browserEnabled.value }) }); browserDialog.value = false; browserUrl.value = ''; browserEnabled.value = false; await load() })
const setBrowserEnabled = (target: BrowserTarget, enabled: boolean) => run(async () => { await request(`/_api/agents/admin/browser-targets/${target.id}`, { method: 'PUT', body: JSON.stringify({ enabled }) }); await load() })
onMounted(() => void load())
</script>

<style scoped>
.agent-control {
  --agent-blue: #3b82f6;
  --agent-violet: #8b5cf6;
  --agent-teal: #0d9488;
  --agent-amber: #d97706;
  color: rgb(var(--v-theme-on-surface));
}

.agent-hero {
  position: relative;
  display: flex;
  min-height: 15rem;
  overflow: hidden;
  align-items: flex-end;
  gap: 2rem;
  margin-bottom: 1rem;
  padding: clamp(2rem, 4.5vw, 3.4rem);
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 18%, transparent);
  border-radius: 1.5rem;
  background:
    radial-gradient(circle at 84% 16%, rgba(var(--v-theme-primary), .18), transparent 18rem),
    linear-gradient(135deg, color-mix(in srgb, rgb(var(--v-theme-primary)) 11%, rgb(var(--v-theme-surface))), rgb(var(--v-theme-surface)) 62%);
  box-shadow: 0 1.2rem 3.5rem rgba(20, 28, 50, .075);
}

.agent-hero__copy {
  position: relative;
  z-index: 2;
  max-width: 48rem;
}

.agent-hero h1 {
  margin: .75rem 0 .65rem;
  font-size: clamp(2.25rem, 4.2vw, 4rem);
  font-weight: 760;
  letter-spacing: -.055em;
  line-height: 1;
}

.agent-hero p {
  max-width: 43rem;
  margin: 0;
  color: rgba(var(--v-theme-on-surface), .68);
  font-size: 1.03rem;
  line-height: 1.6;
}

.agent-eyebrow,
.agent-panel__eyebrow {
  color: rgb(var(--v-theme-primary));
  font-size: .68rem;
  font-weight: 780;
  letter-spacing: .13em;
  text-transform: uppercase;
}

.agent-eyebrow {
  display: flex;
  align-items: center;
  gap: .65rem;
}

.agent-eyebrow__signal {
  width: .5rem;
  height: .5rem;
  border-radius: 50%;
  background: rgb(var(--v-theme-primary));
  box-shadow: 0 0 0 .35rem rgba(var(--v-theme-primary), .1);
}

.agent-hero__status {
  display: flex;
  flex-wrap: wrap;
  gap: .5rem;
  margin-top: 1.35rem;
}

.agent-hero__actions {
  position: relative;
  z-index: 2;
  margin-left: auto;
}

.agent-hero__art {
  position: absolute;
  top: 1.2rem;
  right: 4.5rem;
  display: grid;
  width: 11rem;
  height: 11rem;
  place-items: center;
  color: rgb(var(--v-theme-primary));
}

.agent-hero__orbit {
  position: absolute;
  border: 1px solid rgba(var(--v-theme-primary), .18);
  border-radius: 50%;
}

.agent-hero__orbit--outer {
  width: 10.5rem;
  height: 10.5rem;
  border-style: dashed;
}

.agent-hero__orbit--inner {
  width: 6.8rem;
  height: 6.8rem;
  background: rgba(var(--v-theme-surface), .5);
  box-shadow: 0 1.4rem 3rem rgba(var(--v-theme-primary), .11);
  backdrop-filter: blur(.75rem);
}

.agent-hero__node {
  position: absolute;
  width: .75rem;
  height: .75rem;
  border: .2rem solid rgb(var(--v-theme-surface));
  border-radius: 50%;
  background: rgb(var(--v-theme-primary));
  box-shadow: 0 .25rem .8rem rgba(var(--v-theme-primary), .28);
}

.agent-hero__node--one { top: .65rem; }
.agent-hero__node--two { right: .65rem; bottom: 2.5rem; }
.agent-hero__node--three { bottom: 1.6rem; left: 1.2rem; }

.agent-snapshot {
  display: grid;
  gap: .75rem;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-bottom: 1rem;
}

.agent-snapshot__item {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: .8rem;
  padding: .9rem 1rem;
  border: 1px solid rgba(var(--v-border-color), .12);
  border-radius: 1rem;
  background: rgb(var(--v-theme-surface));
  box-shadow: 0 .4rem 1.5rem rgba(20, 28, 50, .035);
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
  border-radius: .8rem;
  background: rgba(var(--v-theme-primary), .1);
  color: rgb(var(--v-theme-primary));
}

.agent-snapshot__icon {
  width: 2.6rem;
  height: 2.6rem;
}

.agent-snapshot__icon--blue { background: rgba(59, 130, 246, .11); color: var(--agent-blue); }
.agent-snapshot__icon--violet { background: rgba(139, 92, 246, .11); color: var(--agent-violet); }
.agent-snapshot__icon--teal { background: rgba(13, 148, 136, .11); color: var(--agent-teal); }

.agent-snapshot__item > span:last-child {
  display: grid;
  min-width: 0;
}

.agent-snapshot__item small,
.provider-card__models span,
.provider-card__meta small,
.selection-preview small {
  color: rgba(var(--v-theme-on-surface), .58);
  font-size: .67rem;
  font-weight: 700;
  letter-spacing: .065em;
  text-transform: uppercase;
}

.agent-snapshot__item strong {
  overflow: hidden;
  font-size: .85rem;
  font-weight: 670;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-workspace {
  display: grid;
  align-items: start;
  gap: 1rem;
  grid-template-columns: 17rem minmax(0, 1fr);
}

.agent-sections {
  position: sticky;
  top: 1rem;
  display: grid;
  gap: .3rem;
  padding: .75rem;
  border: 1px solid rgba(var(--v-border-color), .12);
  border-radius: 1.1rem;
  background: rgb(var(--v-theme-surface));
  box-shadow: 0 .7rem 2rem rgba(20, 28, 50, .04);
}

.agent-sections__label {
  padding: .35rem .55rem .55rem;
  color: rgba(var(--v-theme-on-surface), .52);
  font-size: .64rem;
  font-weight: 760;
  letter-spacing: .12em;
  text-transform: uppercase;
}

.agent-section {
  display: grid;
  width: 100%;
  min-height: 4.3rem;
  align-items: center;
  gap: .7rem;
  grid-template-columns: 2.35rem minmax(0, 1fr) auto auto;
  padding: .65rem;
  border: 1px solid transparent;
  border-radius: .85rem;
  background: transparent;
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  text-align: left;
  transition: border-color .16s ease, background-color .16s ease, transform .16s ease;
}

.agent-section:hover {
  background: rgba(var(--v-theme-primary), .045);
  transform: translateX(.1rem);
}

.agent-section:focus-visible,
.provider-card__edit:focus-visible,
.profile-steps button:focus-visible,
.access-choice__item:focus-within {
  outline: .15rem solid rgba(var(--v-theme-primary), .42);
  outline-offset: .12rem;
}

.agent-section--active {
  border-color: rgba(var(--v-theme-primary), .17);
  background: rgba(var(--v-theme-primary), .085);
  color: rgb(var(--v-theme-primary));
}

.agent-section__icon {
  display: grid;
  width: 2.35rem;
  height: 2.35rem;
  place-items: center;
  border-radius: .7rem;
  background: rgba(var(--v-theme-on-surface), .05);
  color: rgba(var(--v-theme-on-surface), .7);
}

.agent-section--active .agent-section__icon {
  background: rgba(var(--v-theme-primary), .13);
  color: rgb(var(--v-theme-primary));
}

.agent-section__copy {
  display: grid;
  min-width: 0;
}

.agent-section__copy strong { font-size: .83rem; font-weight: 680; }
.agent-section__copy small { color: rgba(var(--v-theme-on-surface), .58); font-size: .7rem; }
.agent-section__badge { justify-self: end; }
.agent-section__arrow { opacity: .38; }
.agent-section--active .agent-section__arrow { opacity: .85; }

.agent-sections__note {
  display: flex;
  align-items: flex-start;
  gap: .55rem;
  margin-top: .35rem;
  padding: .8rem .65rem .45rem;
  border-top: 1px solid rgba(var(--v-border-color), .1);
  color: rgba(var(--v-theme-on-surface), .58);
  font-size: .69rem;
  line-height: 1.45;
}

.agent-content { min-width: 0; }

.agent-panel {
  overflow: hidden;
  border: 1px solid rgba(var(--v-border-color), .12);
  border-radius: 1.1rem;
  background: rgb(var(--v-theme-surface));
  box-shadow: 0 .7rem 2rem rgba(20, 28, 50, .04);
}

.agent-panel__header {
  display: flex;
  min-height: 6.25rem;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 1.35rem 1.5rem;
  border-bottom: 1px solid rgba(var(--v-border-color), .1);
}

.agent-panel__heading {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: .9rem;
}

.agent-panel__icon {
  width: 2.85rem;
  height: 2.85rem;
}

.agent-panel__icon--violet { background: rgba(139, 92, 246, .11); color: var(--agent-violet); }
.agent-panel__icon--teal { background: rgba(13, 148, 136, .11); color: var(--agent-teal); }

.agent-panel__header h2 {
  margin: .12rem 0 .15rem;
  font-size: 1.2rem;
  font-weight: 720;
  letter-spacing: -.025em;
}

.agent-panel__header p,
.profile-editor__header p {
  margin: 0;
  color: rgba(var(--v-theme-on-surface), .62);
  font-size: .78rem;
}

.agent-panel__body { padding: 1.5rem; }

.runtime-section + .runtime-section { margin-top: 1.75rem; }

.section-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: .9rem;
}

.section-heading h3,
.profile-form-section__intro h3 {
  margin: 0 0 .15rem;
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: -.015em;
}

.section-heading p,
.profile-form-section__intro p,
.subsection-card__heading p,
.protocol-behavior__heading p {
  margin: 0;
  color: rgba(var(--v-theme-on-surface), .6);
  font-size: .75rem;
  line-height: 1.5;
}

.section-heading > span {
  color: rgb(var(--v-theme-primary));
  font-size: .72rem;
  font-weight: 700;
}

.capability-map {
  display: grid;
  gap: .5rem;
  grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
}

.capability-item {
  display: flex;
  min-height: 2.7rem;
  align-items: center;
  gap: .55rem;
  padding: .55rem .65rem;
  border: 1px solid rgba(var(--v-border-color), .1);
  border-radius: .75rem;
  background: rgba(var(--v-theme-on-surface), .018);
  color: rgba(var(--v-theme-on-surface), .57);
  font-size: .75rem;
  font-weight: 620;
}

.capability-item--enabled {
  border-color: rgba(var(--v-theme-success), .14);
  background: rgba(var(--v-theme-success), .045);
  color: rgb(var(--v-theme-on-surface));
}
.metrics-note code {
  color: rgb(var(--v-theme-on-surface));
  font-weight: 650;
}

.capability-item__state {
  display: grid;
  width: 1.35rem;
  height: 1.35rem;
  place-items: center;
  border-radius: 50%;
  background: rgba(var(--v-theme-on-surface), .08);
}

.capability-item--enabled .capability-item__state {
  background: rgba(var(--v-theme-success), .14);
  color: rgb(var(--v-theme-success));
}

.policy-grid {
  display: grid;
  gap: .75rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.policy-card {
  padding: 1rem;
  border: 1px solid rgba(var(--v-border-color), .1);
  border-radius: .9rem;
  background: rgba(var(--v-theme-on-surface), .018);
}

.policy-card__title {
  display: flex;
  align-items: center;
  gap: .6rem;
  margin-bottom: .75rem;
}

.policy-card__title span {
  display: grid;
  width: 2rem;
  height: 2rem;
  place-items: center;
  border-radius: .6rem;
  background: rgba(var(--v-theme-primary), .1);
  color: rgb(var(--v-theme-primary));
}

.policy-card h4,
.subsection-card h4,
.protocol-behavior h4,
.limit-group h4 {
  margin: 0;
  font-size: .82rem;
  font-weight: 700;
}

.policy-card dl { display: grid; gap: .42rem; margin: 0; }

.policy-card dl > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  padding-bottom: .38rem;
  border-bottom: 1px solid rgba(var(--v-border-color), .075);
  font-size: .72rem;
}

.policy-card dl > div:last-child { padding-bottom: 0; border: 0; }
.policy-card dt { color: rgba(var(--v-theme-on-surface), .58); }
.policy-card dd { margin: 0; font-weight: 650; text-align: right; }

.metrics-note {
  display: flex;
  align-items: flex-start;
  gap: .8rem;
  margin-top: 1.25rem;
  padding: 1rem;
  border: 1px solid rgba(var(--v-theme-primary), .12);
  border-radius: .85rem;
  background: rgba(var(--v-theme-primary), .04);
}

.metrics-note > span {
  display: grid;
  width: 2.15rem;
  height: 2.15rem;
  flex: 0 0 auto;
  place-items: center;
  border-radius: .65rem;
  background: rgba(var(--v-theme-primary), .11);
  color: rgb(var(--v-theme-primary));
}

.metrics-note strong { display: block; margin-bottom: .15rem; font-size: .8rem; }
.metrics-note p { margin: 0; color: rgba(var(--v-theme-on-surface), .62); font-size: .72rem; line-height: 1.5; }

.provider-grid {
  display: grid;
  gap: .85rem;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
}

.provider-card {
  position: relative;
  display: flex;
  min-width: 0;
  overflow: hidden;
  flex-direction: column;
  padding: 1.05rem;
  border: 1px solid rgba(var(--v-border-color), .12);
  border-radius: 1rem;
  background:
    radial-gradient(circle at 100% 0, rgba(var(--v-theme-primary), .055), transparent 11rem),
    rgba(var(--v-theme-on-surface), .014);
  transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease;
}

.provider-card:hover {
  border-color: rgba(var(--v-theme-primary), .2);
  box-shadow: 0 .8rem 2rem rgba(20, 28, 50, .065);
  transform: translateY(-.1rem);
}

.provider-card__top {
  display: flex;
  align-items: flex-start;
  gap: .7rem;
}

.provider-card__mark {
  width: 2.65rem;
  height: 2.65rem;
  border-radius: .8rem;
  background: linear-gradient(145deg, rgba(var(--v-theme-primary), .17), rgba(139, 92, 246, .11));
}

.provider-card__identity { min-width: 0; flex: 1 1 auto; }

.provider-card__name {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: .45rem;
}

.provider-card__name h3 {
  overflow: hidden;
  margin: .1rem 0 .15rem;
  font-size: .95rem;
  font-weight: 720;
  letter-spacing: -.015em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-card__identity > p {
  margin: 0;
  color: rgba(var(--v-theme-on-surface), .58);
  font-size: .7rem;
}

.provider-card__status {
  display: flex;
  flex-wrap: wrap;
  gap: .4rem;
  margin: .9rem 0;
}

.connection-state {
  display: inline-flex;
  align-items: center;
  gap: .3rem;
  padding: .28rem .48rem;
  border-radius: 999px;
  background: rgba(var(--v-theme-on-surface), .06);
  color: rgba(var(--v-theme-on-surface), .63);
  font-size: .64rem;
  font-weight: 680;
}

.connection-state--success { background: rgba(var(--v-theme-success), .09); color: rgb(var(--v-theme-success)); }
.connection-state--error { background: rgba(var(--v-theme-error), .09); color: rgb(var(--v-theme-error)); }
.connection-state__dot { width: .38rem; height: .38rem; border-radius: 50%; background: currentColor; }

.provider-card__models {
  display: grid;
  gap: .5rem;
  padding: .8rem;
  border: 1px solid rgba(var(--v-border-color), .085);
  border-radius: .75rem;
  background: rgba(var(--v-theme-surface), .65);
}

.provider-card__models > div {
  display: grid;
  align-items: center;
  gap: .55rem;
  grid-template-columns: 5.2rem minmax(0, 1fr) auto;
}

.provider-card__models code {
  overflow: hidden;
  font-size: .72rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-card__models small {
  padding: .16rem .35rem;
  border-radius: 999px;
  background: rgba(var(--v-theme-primary), .08);
  color: rgb(var(--v-theme-primary));
  font-size: .57rem;
  font-weight: 700;
  text-transform: uppercase;
}

.provider-card__error { margin: .65rem 0 0; color: rgb(var(--v-theme-error)); font-size: .69rem; line-height: 1.45; }

.provider-card__meta {
  display: grid;
  gap: .55rem;
  margin-top: .9rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.provider-card__meta > div {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: .5rem;
  color: rgba(var(--v-theme-on-surface), .58);
}

.provider-card__meta > div > span { display: grid; min-width: 0; }
.provider-card__meta strong { overflow: hidden; font-size: .69rem; font-weight: 630; text-overflow: ellipsis; white-space: nowrap; }

.provider-card__edit {
  display: flex;
  width: calc(100% + 2.1rem);
  align-items: center;
  justify-content: space-between;
  margin: .95rem -1.05rem -1.05rem;
  padding: .7rem 1.05rem;
  border: 0;
  border-top: 1px solid rgba(var(--v-border-color), .085);
  background: transparent;
  color: rgb(var(--v-theme-primary));
  cursor: pointer;
  font-size: .7rem;
  font-weight: 680;
  text-align: left;
}

.provider-card__edit:hover { background: rgba(var(--v-theme-primary), .045); }

.agent-empty {
  display: grid;
  min-height: 22rem;
  place-items: center;
  align-content: center;
  padding: 3rem 1.5rem;
  text-align: center;
}

.agent-empty__icon {
  width: 4.5rem;
  height: 4.5rem;
  margin-bottom: 1rem;
  border-radius: 1.35rem;
  background: linear-gradient(145deg, rgba(var(--v-theme-primary), .15), rgba(139, 92, 246, .1));
}

.agent-empty__icon--teal { background: rgba(13, 148, 136, .1); color: var(--agent-teal); }
.agent-empty h3 { margin: 0 0 .35rem; font-size: 1.05rem; font-weight: 720; }
.agent-empty p { max-width: 30rem; margin: 0 0 1.15rem; color: rgba(var(--v-theme-on-surface), .6); font-size: .78rem; line-height: 1.55; }

.target-list { display: grid; gap: .65rem; }

.target-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: .8rem;
  padding: .8rem;
  border: 1px solid rgba(var(--v-border-color), .1);
  border-radius: .85rem;
  background: rgba(var(--v-theme-on-surface), .018);
}

.target-row__icon { width: 2.5rem; height: 2.5rem; background: rgba(13, 148, 136, .1); color: var(--agent-teal); }
.target-row__copy { display: grid; min-width: 0; flex: 1 1 auto; }
.target-row__copy strong { overflow: hidden; font-size: .79rem; text-overflow: ellipsis; white-space: nowrap; }
.target-row__copy small { color: rgba(var(--v-theme-on-surface), .55); font-family: monospace; font-size: .66rem; }
.target-row__state { display: flex; align-items: center; gap: .55rem; color: rgba(var(--v-theme-on-surface), .62); font-size: .7rem; font-weight: 650; }

.profile-editor {
  overflow: hidden;
  border-radius: 1.25rem !important;
  background: rgb(var(--v-theme-surface)) !important;
}

.profile-editor__header {
  display: flex;
  min-height: 6.5rem;
  align-items: center;
  gap: .9rem;
  padding: 1.15rem 1.35rem;
  border-bottom: 1px solid rgba(var(--v-border-color), .1);
  background:
    radial-gradient(circle at 88% 0, rgba(var(--v-theme-primary), .09), transparent 15rem),
    rgb(var(--v-theme-surface));
}

.profile-editor__mark { width: 3rem; height: 3rem; background: linear-gradient(145deg, rgba(var(--v-theme-primary), .16), rgba(139, 92, 246, .1)); }
.profile-editor__header h2 { margin: .12rem 0 .15rem; font-size: 1.2rem; font-weight: 730; letter-spacing: -.025em; }
.profile-editor__progress { flex: 0 0 auto; }

.profile-editor__workspace {
  display: grid;
  min-height: min(38rem, calc(100vh - 14rem));
  overflow: hidden;
  grid-template-columns: 15.5rem minmax(0, 1fr);
}

.profile-steps {
  display: grid;
  align-content: start;
  gap: .3rem;
  padding: 1rem .75rem;
  border-right: 1px solid rgba(var(--v-border-color), .1);
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 2.4%, rgb(var(--v-theme-surface)));
}

.profile-steps button {
  display: grid;
  min-height: 3.9rem;
  align-items: center;
  gap: .65rem;
  grid-template-columns: 1.7rem minmax(0, 1fr) auto;
  padding: .55rem .6rem;
  border: 1px solid transparent;
  border-radius: .75rem;
  background: transparent;
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  text-align: left;
}

.profile-steps button:hover { background: rgba(var(--v-theme-primary), .045); }
.profile-steps button.profile-step--active { border-color: rgba(var(--v-theme-primary), .16); background: rgba(var(--v-theme-primary), .085); color: rgb(var(--v-theme-primary)); }

.profile-step__index {
  display: grid;
  width: 1.7rem;
  height: 1.7rem;
  place-items: center;
  border-radius: 50%;
  background: rgba(var(--v-theme-on-surface), .07);
  color: rgba(var(--v-theme-on-surface), .62);
  font-size: .65rem;
  font-weight: 750;
}

.profile-step--active .profile-step__index { background: rgb(var(--v-theme-primary)); color: rgb(var(--v-theme-on-primary)); }
.profile-steps button > span:nth-child(2) { display: grid; min-width: 0; }
.profile-steps strong { font-size: .76rem; font-weight: 690; }
.profile-steps small { color: rgba(var(--v-theme-on-surface), .55); font-size: .65rem; }
.profile-steps button > .v-icon { opacity: .38; }
.profile-step--active > .v-icon { opacity: .9 !important; }

.profile-editor__form {
  min-width: 0;
  overflow: auto;
  padding: clamp(1.25rem, 3vw, 2rem);
}

.profile-form-section { max-width: 52rem; margin: 0 auto; }

.profile-form-section__intro {
  display: flex;
  align-items: flex-start;
  gap: .8rem;
  margin-bottom: 1.5rem;
}

.profile-form-section__intro > span { width: 2.55rem; height: 2.55rem; }
.form-grid { display: grid; gap: .25rem 1rem; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.protocol-field, .secret-field { grid-column: 1 / -1; }

.field-note {
  display: flex;
  align-items: flex-start;
  gap: .4rem;
  margin: -1rem .1rem 1rem;
  color: rgba(var(--v-theme-on-surface), .58);
  font-size: .7rem;
  line-height: 1.45;
}

.selection-preview {
  display: flex;
  align-items: center;
  gap: .75rem;
  margin-top: .45rem;
  padding: .9rem;
  border: 1px solid rgba(var(--v-theme-primary), .12);
  border-radius: .85rem;
  background: rgba(var(--v-theme-primary), .035);
}

.selection-preview__icon { width: 2.6rem; height: 2.6rem; }
.selection-preview > div { display: grid; }
.selection-preview strong { font-size: .83rem; }
.selection-preview p { margin: .05rem 0 0; color: rgba(var(--v-theme-on-surface), .58); font-size: .68rem; }

.subsection-card,
.protocol-behavior,
.limit-group {
  margin-top: .8rem;
  padding: 1rem;
  border: 1px solid rgba(var(--v-border-color), .1);
  border-radius: .85rem;
  background: rgba(var(--v-theme-on-surface), .018);
}

.subsection-card__heading,
.protocol-behavior__heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: .9rem;
}

.subsection-card__heading > .v-icon { width: 2.1rem; height: 2.1rem; }
.protocol-behavior { margin-top: .5rem; border-color: rgba(var(--v-theme-primary), .12); background: rgba(var(--v-theme-primary), .025); }
.protocol-behavior__heading { justify-content: flex-start; }
.protocol-behavior__heading > span { display: grid; width: 2.1rem; height: 2.1rem; flex: 0 0 auto; place-items: center; border-radius: .65rem; background: rgba(var(--v-theme-primary), .1); color: rgb(var(--v-theme-primary)); }

.protocol-summary { display: grid; gap: .45rem; margin: 0; }
.protocol-summary > div { display: grid; gap: .65rem; grid-template-columns: minmax(7.5rem, .38fr) minmax(0, 1fr); padding-top: .45rem; border-top: 1px solid rgba(var(--v-border-color), .08); }
.protocol-summary dt { color: rgba(var(--v-theme-on-surface), .58); font-size: .69rem; font-weight: 650; }
.protocol-summary dd { margin: 0; font-size: .71rem; line-height: 1.45; }

.access-choice { display: grid; gap: .65rem; }

.access-choice__item {
  display: grid;
  min-height: 5.2rem;
  align-items: center;
  gap: .8rem;
  grid-template-columns: 2.8rem minmax(0, 1fr) auto;
  padding: .85rem;
  border: 1px solid rgba(var(--v-border-color), .12);
  border-radius: .9rem;
  background: rgba(var(--v-theme-on-surface), .014);
  cursor: pointer;
}

.access-choice__item input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.access-choice__item--active { border-color: rgba(var(--v-theme-primary), .28); background: rgba(var(--v-theme-primary), .055); }
.access-choice__icon { display: grid; width: 2.8rem; height: 2.8rem; place-items: center; border-radius: .8rem; background: rgba(var(--v-theme-primary), .09); color: rgb(var(--v-theme-primary)); }
.access-choice__item > span:nth-of-type(2) { display: grid; }
.access-choice__item strong { font-size: .82rem; }
.access-choice__item small { color: rgba(var(--v-theme-on-surface), .58); font-size: .7rem; line-height: 1.45; }
.access-choice__check { color: rgb(var(--v-theme-primary)); }

.limit-group h4 { margin-bottom: .75rem; color: rgba(var(--v-theme-on-surface), .72); }

.profile-editor__footer {
  display: flex;
  min-height: 4.6rem;
  align-items: center;
  gap: .55rem;
  padding: .7rem 1rem;
  border-top: 1px solid rgba(var(--v-border-color), .1);
  background: rgb(var(--v-theme-surface));
}

.profile-editor__position { display: grid; }
.profile-editor__position strong { font-size: .74rem; }
.profile-editor__position span { color: rgba(var(--v-theme-on-surface), .55); font-size: .65rem; }

.compact-dialog {
  overflow: hidden;
  border-radius: 1.1rem !important;
}

.compact-dialog__header {
  display: flex;
  align-items: center;
  gap: .75rem;
  padding: 1.15rem 1.25rem;
  border-bottom: 1px solid rgba(var(--v-border-color), .1);
  background: rgba(var(--v-theme-primary), .035);
}

.compact-dialog__header > span { width: 2.7rem; height: 2.7rem; }
.compact-dialog__header--danger { background: rgba(var(--v-theme-error), .035); }
.compact-dialog__header--danger > span { background: rgba(var(--v-theme-error), .1); color: rgb(var(--v-theme-error)); }
.compact-dialog__header--teal { background: rgba(13, 148, 136, .035); }
.compact-dialog__header--teal > span { background: rgba(13, 148, 136, .1); color: var(--agent-teal); }
.compact-dialog__header h2 { margin: 0; font-size: 1.05rem; font-weight: 720; letter-spacing: -.02em; }
.compact-dialog__header p { margin: .08rem 0 0; color: rgba(var(--v-theme-on-surface), .58); font-size: .7rem; }

code { overflow-wrap: anywhere; }

:global(.profile-editor .v-messages),
:global(.compact-dialog .v-messages) {
  opacity: 1 !important;
}

:global(.profile-editor .v-field-label),
:global(.profile-editor .v-messages__message),
:global(.compact-dialog .v-field-label),
:global(.compact-dialog .v-messages__message) {
  color: rgba(var(--v-theme-on-surface), .78) !important;
  opacity: 1 !important;
}
@media (max-width: 1100px) {
  .agent-workspace { grid-template-columns: 14rem minmax(0, 1fr); }
  .agent-section { grid-template-columns: 2.35rem minmax(0, 1fr) auto; }
  .agent-section__badge { display: none; }
  .agent-hero__art { right: 2rem; opacity: .75; }
}

@media (max-width: 860px) {
  .agent-hero { min-height: 13rem; align-items: flex-start; }
  .agent-hero__copy { max-width: calc(100% - 6rem); }
  .agent-hero__actions { align-self: flex-end; }
  .agent-hero__art { top: .6rem; right: .5rem; transform: scale(.72); transform-origin: top right; }
  .agent-snapshot { grid-template-columns: 1fr; }
  .agent-workspace { grid-template-columns: minmax(0, 1fr); }
  .agent-sections {
    position: static;
    display: flex;
    overflow-x: auto;
    padding: .5rem;
    scrollbar-width: thin;
  }
  .agent-sections__label,
  .agent-sections__note { display: none; }
  .agent-section {
    min-width: 10.75rem;
    grid-template-columns: 2.35rem minmax(0, 1fr);
  }
  .agent-section__arrow,
  .agent-section__badge { display: none; }
  .profile-editor__workspace { grid-template-columns: 12.5rem minmax(0, 1fr); }
}

@media (max-width: 700px) {
  .agent-hero {
    min-height: auto;
    flex-direction: column;
    align-items: stretch;
    padding: 1.5rem;
    border-radius: 1.2rem;
  }
  .agent-hero__copy { max-width: none; }
  .agent-hero h1 { font-size: 2.5rem; }
  .agent-hero__art { display: none; }
  .agent-hero__actions { align-self: flex-start; margin: 0; }
  .agent-panel__header { align-items: flex-start; flex-direction: column; }
  .agent-panel__header > .v-btn { width: 100%; }
  .policy-grid,
  .form-grid,
  .provider-card__meta { grid-template-columns: 1fr; }
  .protocol-field,
  .secret-field { grid-column: auto; }
  .profile-editor { border-radius: 0 !important; }
  .profile-editor__header { min-height: 5.5rem; padding: .9rem 1rem; }
  .profile-editor__mark { width: 2.5rem; height: 2.5rem; }
  .profile-editor__header p { display: none; }
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
    padding: .5rem;
    border-right: 0;
    border-bottom: 1px solid rgba(var(--v-border-color), .1);
  }
  .profile-steps button {
    min-width: 7.5rem;
    min-height: 3.2rem;
    grid-template-columns: 1.7rem minmax(0, 1fr);
  }
  .profile-steps button > .v-icon,
  .profile-steps small { display: none; }
  .profile-editor__form { flex: 1 1 auto; padding: 1.15rem; }
  .profile-editor__position { display: none; }
  .profile-editor__footer {
    overflow-x: auto;
    justify-content: flex-end;
    padding: .6rem;
  }
  .profile-editor__footer > .v-spacer,
  .profile-editor__footer > .v-btn:first-of-type { display: none; }
  .protocol-summary > div { grid-template-columns: 1fr; gap: .15rem; }
  .target-row { align-items: flex-start; flex-wrap: wrap; }
  .target-row__state { width: 100%; justify-content: flex-end; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    transition-duration: .01ms !important;
    animation-duration: .01ms !important;
  }
}
</style>
