<template>
  <v-expansion-panels class="agent-session-settings" variant="accordion">
    <v-expansion-panel class="agent-session-settings__panel" elevation="0">
      <v-expansion-panel-title class="agent-session-settings__title">
        <span class="agent-session-settings__mark" aria-hidden="true">
          <v-icon icon="mdi-tune-variant" size="20" />
        </span>
        <span class="agent-session-settings__heading">
          <span class="agent-session-settings__eyebrow">Conversation controls</span>
          <span class="agent-session-settings__name">Session configuration</span>
        </span>
        <span class="agent-session-settings__summary">
          <span class="agent-session-settings__profile">{{ profileSummary }}</span>
          <v-chip v-if="profileChanged" size="x-small" color="warning" variant="tonal">Unsaved choice</v-chip>
        </span>
      </v-expansion-panel-title>

      <v-expansion-panel-text>
        <div class="agent-session-settings__scope" aria-label="Current session scope and retention">
          <div class="agent-session-settings__fact">
            <v-icon icon="mdi-message-processing-outline" size="19" aria-hidden="true" />
            <div>
              <span>Session scope</span>
              <strong>This conversation only</strong>
              <p>Provider changes apply to future runs here. Existing messages and the conversation’s memory snapshot stay unchanged.</p>
            </div>
          </div>
          <div class="agent-session-settings__fact">
            <v-icon :icon="retentionIcon" size="19" aria-hidden="true" />
            <div>
              <span>Retention</span>
              <strong>{{ retentionTitle }}</strong>
              <p>{{ retentionSummary }}</p>
            </div>
          </div>
        </div>

        <v-alert v-if="disabled" class="agent-session-settings__notice" type="info" variant="tonal" density="compact" icon="mdi-lock-clock">
          Configuration is locked while this session has an active run or an open durable goal. Finish or cancel that work before changing providers.
        </v-alert>

        <template v-if="profiles.length > 1">
          <section class="agent-session-settings__provider" aria-labelledby="agent-session-provider-title">
            <header class="agent-session-settings__provider-header">
              <div>
                <p class="agent-session-settings__eyebrow">Execution route</p>
                <h3 id="agent-session-provider-title" class="text-title-medium">Provider for future runs</h3>
              </div>
              <v-chip :color="profileChanged ? 'warning' : 'success'" size="x-small" variant="tonal">
                {{ profileChanged ? 'Change not applied' : 'Current state' }}
              </v-chip>
            </header>

            <v-select
              v-model="profileId"
              :items="profileItems"
              item-title="title"
              item-value="value"
              label="Provider profile"
              :hint="profileBehavior"
              persistent-hint
              variant="outlined"
              :disabled="disabled || applying"
            />

            <div class="agent-session-settings__route" :class="{ 'agent-session-settings__route--pending': profileChanged }">
              <div class="agent-session-settings__route-heading">
                <span>{{ profileChanged ? 'Pending route' : 'Route in use' }}</span>
                <v-chip v-if="profileId === null" size="x-small" variant="outlined">Follows default</v-chip>
                <v-chip v-else size="x-small" variant="outlined">Selected for session</v-chip>
              </div>
              <dl>
                <div>
                  <dt>Profile</dt>
                  <dd>{{ routeProfileName }}</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>{{ routeModel }}</dd>
                </div>
                <div>
                  <dt>Destination</dt>
                  <dd>{{ routeDestination }}</dd>
                </div>
              </dl>
            </div>

            <div class="agent-session-settings__actions">
              <p v-if="applying" class="agent-session-settings__status" role="status" aria-live="polite">
                <v-progress-circular indeterminate :size="16" :width="2" aria-hidden="true" />
                Applying provider profile to this conversation…
              </p>
              <p v-else-if="profileError" class="agent-session-settings__status agent-session-settings__status--error" role="alert">
                <v-icon icon="mdi-alert-circle-outline" size="17" aria-hidden="true" />
                {{ profileError }}
              </p>
              <p v-else-if="profileChanged" class="agent-session-settings__status agent-session-settings__status--pending" role="status" aria-live="polite">
                Your selection is staged. Apply it before starting the next run.
              </p>
              <p v-else class="agent-session-settings__status">
                The current route is ready for the next Agent run.
              </p>
              <v-btn v-if="profileChanged" variant="text" :disabled="disabled || applying" @click="resetProfileSelection">Revert</v-btn>
              <v-btn color="primary" variant="flat" :loading="applying" :disabled="disabled || applying || !profileChanged" @click="applyProfile">
                {{ profileError ? 'Retry apply' : 'Apply to session' }}
              </v-btn>
            </div>
          </section>
        </template>
      </v-expansion-panel-text>
    </v-expansion-panel>
  </v-expansion-panels>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentProviderProfileView, AgentSessionView } from '../../../shared/agents/contracts.ts'

type ProviderProfileApplyResult =
  | { readonly success: true }
  | { readonly success: false; readonly error: string }

const props = defineProps<{
  session: AgentSessionView
  profiles: AgentProviderProfileView[]
  disabled: boolean
  applyProviderProfile: (profileId: string | null) => Promise<ProviderProfileApplyResult>
}>()
const profileId = ref<string | null>(props.session.providerProfileId)
const applying = ref(false)
const profileError = ref('')
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

watch(
  () => [props.session.id, props.session.providerProfileId] as const,
  ([, providerProfileId]) => {
    profileId.value = providerProfileId
    profileError.value = ''
  }
)
watch(profileId, () => {
  if (!applying.value) profileError.value = ''
})

const defaultProfile = computed(() => props.profiles.find(profile => profile.isGlobalDefault) ?? props.profiles[0])
const effectiveProfile = computed(() => profileId.value
  ? props.profiles.find(profile => profile.id === profileId.value)
  : defaultProfile.value)
const profileSummary = computed(() => effectiveProfile.value
  ? `${effectiveProfile.value.name} · ${effectiveProfile.value.model}`
  : profileId.value ? 'Selected profile unavailable' : 'Current default')
const profileItems = computed(() => [
  {
    title: defaultProfile.value ? `Default · ${defaultProfile.value.name} · ${defaultProfile.value.model}` : 'Use current workspace default',
    value: null
  },
  ...props.profiles
    .filter(profile => !profile.isGlobalDefault)
    .map(profile => ({ title: `${profile.name} · ${profile.model}`, value: profile.id }))
])
const profileChanged = computed(() => profileId.value !== props.session.providerProfileId)
const profileBehavior = computed(() => profileId.value === null
  ? 'Uses the workspace default available to you whenever a new run begins.'
  : 'Routes future runs in this conversation through this profile until you change it.')
const routeProfileName = computed(() => effectiveProfile.value?.name ?? (profileId.value ? 'Selected profile unavailable' : 'Current workspace default'))
const routeModel = computed(() => effectiveProfile.value?.model ?? (profileId.value ? 'Unavailable' : 'Resolved when the next run starts'))
const routeDestination = computed(() => effectiveProfile.value?.destinationHost ?? (profileId.value ? 'Unavailable' : 'Managed by the current default'))
const retentionIcon = computed(() => props.session.folderId
  ? 'mdi-folder-lock-outline'
  : props.session.retention === 'temporary' ? 'mdi-clock-outline' : 'mdi-history')
const retentionTitle = computed(() => {
  if (props.session.folderId) return 'Filed for long-term keeping'
  return props.session.retention === 'temporary' ? 'Temporary conversation' : 'Recent conversation'
})
const retentionSummary = computed(() => {
  if (props.session.folderId) return 'Stored in a folder and kept until you remove it.'
  if (props.session.retention === 'temporary') {
    return props.session.expiresAt
      ? `Scheduled for removal ${dateFormatter.format(new Date(props.session.expiresAt))}.`
      : 'Removed automatically under the workspace temporary-session policy.'
  }
  return 'Removed after the workspace inactivity window unless you move it into a folder.'
})

const resetProfileSelection = (): void => {
  if (applying.value) return
  profileId.value = props.session.providerProfileId
  profileError.value = ''
}
const applyProfile = async (): Promise<void> => {
  if (props.disabled || applying.value || !profileChanged.value) return
  applying.value = true
  profileError.value = ''
  try {
    const result = await props.applyProviderProfile(profileId.value)
    if (!result.success) {
      const error = typeof result.error === 'string' ? result.error.trim() : ''
      profileError.value = error || 'The provider profile could not be applied. Try again.'
    }
  } catch (value) {
    const error = value instanceof Error && typeof value.message === 'string' ? value.message.trim() : ''
    profileError.value = error || 'The provider profile could not be applied. Try again.'
  } finally {
    applying.value = false
  }
}
</script>
<style scoped>
.agent-session-settings {
  margin-bottom: var(--wiki-space-4);
}

.agent-session-settings__panel {
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius) !important;
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);
}

.agent-session-settings__title {
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-3)) !important;
  padding: var(--wiki-space-3) var(--wiki-space-4) !important;
}

.agent-session-settings__title :deep(.v-expansion-panel-title__overlay) {
  opacity: 0;
}

.agent-session-settings__mark {
  display: grid;
  width: var(--wiki-control-height);
  height: var(--wiki-control-height);
  flex: 0 0 auto;
  place-items: center;
  margin-inline-end: var(--wiki-space-3);
  border: 1px solid color-mix(in srgb, var(--wiki-ambient-accent) 26%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--wiki-ambient-accent) 9%, var(--wiki-surface-raised));
  color: var(--wiki-accent-warm);
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);
}

.agent-session-settings__heading {
  display: grid;
  min-width: 0;
  flex: 0 1 auto;
}

.agent-session-settings__eyebrow {
  margin: 0;
  color: var(--wiki-accent-warm);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .085em;
  text-transform: uppercase;
}

.agent-session-settings__name {
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-heading);
  font-size: .9375rem;
  font-weight: 650;
  line-height: 1.35;
}

.agent-session-settings__summary {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
  align-items: center;
  justify-content: flex-end;
  margin-inline-start: var(--wiki-space-4);
}

.agent-session-settings__profile {
  overflow: hidden;
  max-width: 24rem;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
  font-family: var(--wiki-font-mono);
  font-size: .75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-session-settings :deep(.v-expansion-panel-text__wrapper) {
  padding: 0 var(--wiki-space-4) var(--wiki-space-4);
}

.agent-session-settings__scope {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--wiki-space-3);
  margin-bottom: var(--wiki-space-4);
}

.agent-session-settings__fact {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--wiki-space-3);
  align-items: start;
  padding: var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
}

.agent-session-settings__fact > .v-icon {
  color: var(--wiki-accent-warm);
}

.agent-session-settings__fact div {
  display: grid;
}

.agent-session-settings__fact span,
.agent-session-settings__route-heading > span,
.agent-session-settings__route dt {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .055em;
  text-transform: uppercase;
}

.agent-session-settings__fact strong {
  margin-top: var(--wiki-space-1);
  color: rgb(var(--v-theme-on-surface));
  font-size: .8125rem;
  line-height: 1.4;
}

.agent-session-settings__fact p {
  margin: var(--wiki-space-1) 0 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
  font-size: .75rem;
  line-height: 1.5;
}

.agent-session-settings__notice {
  margin-bottom: var(--wiki-space-4);
}

.agent-session-settings__provider {
  padding: var(--wiki-space-4);
  border: 1px solid color-mix(in srgb, var(--wiki-ambient-accent) 22%, var(--wiki-surface-border));
  border-radius: var(--wiki-panel-radius);
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--wiki-ambient-accent) 6%, transparent), transparent 62%),
    var(--wiki-surface-sunken);
}

.agent-session-settings__provider-header,
.agent-session-settings__route-heading,
.agent-session-settings__actions,
.agent-session-settings__status {
  display: flex;
  align-items: center;
}

.agent-session-settings__provider-header {
  gap: var(--wiki-space-3);
  justify-content: space-between;
  margin-bottom: var(--wiki-space-4);
}

.agent-session-settings__provider-header h3 {
  margin: var(--wiki-space-1) 0 0;
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-heading);
}

.agent-session-settings__provider :deep(.v-field) {
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-inset);
}

.agent-session-settings__route {
  margin-top: var(--wiki-space-4);
  padding: var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-inline-start: var(--wiki-space-1) solid var(--wiki-accent-warm);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-raised);
  transition:
    border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    background-color var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.agent-session-settings__route--pending {
  border-color: color-mix(in srgb, rgb(var(--v-theme-warning)) 44%, var(--wiki-surface-border));
  border-inline-start-color: rgb(var(--v-theme-warning));
  background: color-mix(in srgb, rgb(var(--v-theme-warning)) 6%, var(--wiki-surface-raised));
}

.agent-session-settings__route-heading {
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
  justify-content: space-between;
  margin-bottom: var(--wiki-space-3);
}

.agent-session-settings__route dl {
  display: grid;
  margin: 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--wiki-space-3);
}

.agent-session-settings__route dl div {
  min-width: 0;
}

.agent-session-settings__route dt,
.agent-session-settings__route dd {
  margin: 0;
}

.agent-session-settings__route dd {
  margin-top: var(--wiki-space-1);
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-mono);
  font-size: .75rem;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.agent-session-settings__actions {
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
  margin-top: var(--wiki-space-4);
}

.agent-session-settings__actions .v-btn {
  min-height: var(--wiki-control-height);
  border-radius: var(--wiki-control-radius);
  font-weight: 650;
  text-transform: none;
}

.agent-session-settings__status {
  min-width: 0;
  flex: 1 1 16rem;
  gap: var(--wiki-space-2);
  margin: 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
  font-size: .75rem;
}

.agent-session-settings__status--pending {
  color: rgb(var(--v-theme-warning));
  font-weight: 650;
}

.agent-session-settings__status--error {
  color: rgb(var(--v-theme-error));
  font-weight: 650;
}

@media (max-width: 839.98px) {
  .agent-session-settings__scope,
  .agent-session-settings__route dl {
    grid-template-columns: minmax(0, 1fr);
  }

  .agent-session-settings__heading {
    flex: 1 1 auto;
  }

  .agent-session-settings__profile {
    max-width: 14rem;
  }
}

@media (max-width: 599.98px) {
  .agent-session-settings__title {
    align-items: center;
    flex-wrap: wrap;
  }

  .agent-session-settings__mark {
    display: none;
  }

  .agent-session-settings__summary {
    flex-basis: 100%;
    justify-content: flex-start;
    margin-block-start: var(--wiki-space-2);
    margin-inline-start: 0;
  }

  .agent-session-settings__profile {
    max-width: 12rem;
  }

  .agent-session-settings :deep(.v-expansion-panel-text__wrapper) {
    padding-inline: var(--wiki-space-3);
  }

  .agent-session-settings__provider {
    padding: var(--wiki-space-3);
  }

  .agent-session-settings__provider-header {
    align-items: flex-start;
  }

  .agent-session-settings__actions .v-btn {
    flex: 1 1 calc(50% - var(--wiki-space-1));
  }

  .agent-session-settings__status {
    flex-basis: 100%;
  }
}

@media (forced-colors: active) {
  .agent-session-settings__panel,
  .agent-session-settings__fact,
  .agent-session-settings__provider,
  .agent-session-settings__route {
    border: 1px solid CanvasText;
  }

  .agent-session-settings__route {
    border-inline-start-width: var(--wiki-space-1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .agent-session-settings__route {
    transition: none;
  }
}
</style>
