<template>
  <div class="developer-flags-workspace">
    <div :inert="reviewOpen || undefined">
      <admin-hero
        :title="$t('admin:devFlags.developerFlags')"
        :description="$t('admin:devFlags.temporaryDiagnosticSettingsInvestigating')"
        :eyebrow="$t('admin:devFlags.operations')"
        icon="mdi-toggle-switch-off-outline"
      >
        <template #actions>
          <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" :disabled="busy" @click="refresh">{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ $t('admin:devFlags.reloadDeveloperFlagObservations') }}</v-tooltip></v-btn>
        </template>
      </admin-hero>

      <async-state
        v-if="loading && !workspace"
        state="loading"
        :title="$t('admin:devFlags.readingDeveloperFlagSettings')"
        :message="$t('admin:devFlags.loadingSavedPolicyCurrent')"
      />
      <async-state
        v-else-if="error && !workspace"
        state="error"
        :title="$t('admin:devFlags.developerFlagsCouldNot2')"
        :message="error"
        :retry-label="$t('admin:devFlags.tryAgain')"
        @retry="reloadWorkspace()"
      />

      <template v-else-if="workspace">
        <v-alert v-if="error" type="error" variant="tonal" class="mb-4" role="alert">{{ error }}</v-alert>
        <v-alert v-if="notice" type="success" variant="tonal" class="mb-4" role="status">{{ notice }}</v-alert>
        <v-alert v-if="stale" type="warning" variant="tonal" class="mb-4">
          {{ recoveryMessage }}
          <v-btn variant="text" :disabled="busy" @click="recover">{{ $t('admin:devFlags.readSavedState') }}</v-btn>
        </v-alert>

        <div class="flags-strip">
          <div>
            <span>{{ $t('admin:devFlags.reviewedPolicy') }}</span>
            <strong>{{ workspace.saved.state === 'staged' ? $t('admin:devFlags.awaitingExplicitApplication') : savedSource }}</strong>
          </div>
          <div>
            <span>{{ $t('admin:devFlags.process') }}</span>
            <strong>{{ workspace.process.state === 'applied' ? $t('admin:devFlags.matchesSavedPolicy') : $t('admin:devFlags.needsReconciliation') }}</strong>
          </div>
          <div>
            <span>{{ $t('admin:devFlags.observed') }}</span>
            <strong>{{ date(workspace.observedAt) }}</strong>
          </div>
        </div>

        <nav class="flags-nav" :aria-label="$t('admin:devFlags.developerFlagSections')">
          <button
            v-for="item in sections"
            :key="item.key"
            type="button"
            :aria-current="section === item.key ? 'page' : undefined"
            :disabled="busy"
            @click="selectSection(item.key)"
          >
            {{ item.title }}
          </button>
        </nav>

        <section v-if="section === 'overview'" aria-labelledby="developer-flags-overview">
          <div class="flags-section-head">
            <div>
              <p class="flags-kicker">{{ $t('admin:devFlags.n01OperatingBoundary') }}</p>
              <h2 id="developer-flags-overview">{{ $t('admin:devFlags.turnDetailOnlyLong') }}</h2>
              <p>{{ $t('admin:devFlags.bothFlagsChangeServer') }}</p>
            </div>
          </div>
          <div class="flags-grid">
            <article class="flags-panel">
              <h3>{{ $t('admin:devFlags.reviewedPolicyLocalProcess') }}</h3>
              <dl class="flags-facts">
                <div>
                  <dt>{{ $t('admin:devFlags.ldapDebug') }}</dt>
                  <dd>{{ $t('admin:devFlags.reviewedProcess', { ldapdebug: onOff(workspace.saved.policy.ldapdebug), ldapdebug2: onOff(workspace.process.policy.ldapdebug), interpolation: { escapeValue: false } }) }}</dd>
                </div>
                <div>
                  <dt>{{ $t('admin:devFlags.sqlQueryLogging') }}</dt>
                  <dd>{{ $t('admin:devFlags.reviewedProcess2', { sqllog: onOff(workspace.saved.policy.sqllog), sqllog2: onOff(workspace.process.policy.sqllog), interpolation: { escapeValue: false } }) }}</dd>
                </div>
                <div>
                  <dt>{{ $t('admin:devFlags.knexDebugSwitch') }}</dt>
                  <dd>{{ workspace.process.sqlQueryLoggingApplied ? $t('admin:devFlags.observedEnabled') : $t('admin:devFlags.observedDisabled') }}</dd>
                </div>
                <div>
                  <dt>{{ $t('admin:devFlags.processScope') }}</dt>
                  <dd>{{ $t('admin:devFlags.pointTimeLocalObservation', { instanceId: workspace.process.instanceId, interpolation: { escapeValue: false } }) }}</dd>
                </div>
              </dl>
              <div v-if="workspace.saved.state === 'staged'" class="flags-runtime-note">
                <div>
                  <h3>{{ $t('admin:devFlags.stagedNotActivated') }}</h3>
                  <p>
                    {{ $t('admin:devFlags.savingRecordsReviewedPolicy') }}
                  </p>
                </div>
              </div>
              <div v-if="!workspace.process.settingsCurrent" class="flags-runtime-note">
                <div>
                  <h3>{{ workspace.saved.state === 'staged' ? $t('admin:devFlags.applicationRequired') : $t('admin:devFlags.savedNotReconciled') }}</h3>
                  <p>{{ $t('admin:devFlags.reviewReconciliationBeforeAnother') }}</p>
                </div>
                <v-btn color="primary" :disabled="locked" @click="reviewApply">{{ $t('admin:devFlags.reviewApplication') }}</v-btn>
              </div>
            </article>
            <aside class="flags-panel flags-panel--quiet">
              <p class="flags-kicker">{{ $t('admin:devFlags.deploymentBaseline') }}</p>
              <h3>{{ $t('admin:devFlags.defaultsNotEvidenceRunning') }}</h3>
              <p>
                {{ $t('admin:devFlags.deploymentDefaultsLdapDebug', { ldapdebug: onOff(workspace.deployment.defaults.ldapdebug), sqllog: onOff(workspace.deployment.defaults.sqllog), interpolation: { escapeValue: false } }) }}
              </p>
              <p>
                {{ $t('admin:devFlags.applyingSendsPeerReload') }}
              </p>
            </aside>
          </div>
        </section>

        <section v-else-if="section === 'controls'" aria-labelledby="developer-flags-controls">
          <div class="flags-section-head">
            <div>
              <p class="flags-kicker">{{ $t('admin:devFlags.n02ReviewedDiagnosticPolicy') }}</p>
              <h2 id="developer-flags-controls">{{ $t('admin:devFlags.nameExposureBeforeYou') }}</h2>
              <p>{{ $t('admin:devFlags.draftChangesDoNot') }}</p>
            </div>
          </div>
          <div class="flags-grid">
            <div>
              <article class="flags-flag" :class="{ 'flags-flag--enabled': draft.ldapdebug }">
                <div class="flags-flag__head">
                  <div>
                    <p class="flags-kicker">{{ $t('admin:devFlags.authenticationLdap') }}</p>
                    <h3>{{ $t('admin:devFlags.ldapDebug') }}</h3>
                  </div>
                  <v-chip size="small" :color="draft.ldapdebug ? 'warning' : undefined" variant="tonal">
                    {{ draft.ldapdebug ? $t('admin:devFlags.draftEnabled') : $t('admin:devFlags.draftOff') }}
                  </v-chip>
                </div>
                <p class="mt-3">{{ $t('admin:devFlags.writesLdapAdAuthentication') }}</p>
                <v-switch v-model="draft.ldapdebug" color="warning" :label="$t('admin:devFlags.enableLdapDebug')" hide-details :disabled="locked" />
                <dl class="flags-facts">
                  <div>
                    <dt>{{ $t('admin:devFlags.prerequisite') }}</dt>
                    <dd>{{ $t('admin:devFlags.ldapSignAttemptMust') }}</dd>
                  </div>
                  <div>
                    <dt>{{ $t('admin:devFlags.sensitivity') }}</dt>
                    <dd>
                      {{ $t('admin:devFlags.errorObjectsCanContain') }}
                    </dd>
                  </div>
                  <div>
                    <dt>{{ $t('admin:devFlags.performance') }}</dt>
                    <dd>{{ $t('admin:devFlags.onlyFailureExceptionPaths') }}</dd>
                  </div>
                  <div>
                    <dt>{{ $t('admin:devFlags.reverse') }}</dt>
                    <dd>
                      {{ $t('admin:devFlags.saveApplyOffAfter') }}
                    </dd>
                  </div>
                </dl>
              </article>

              <article class="flags-flag" :class="{ 'flags-flag--enabled': draft.sqllog }">
                <div class="flags-flag__head">
                  <div>
                    <p class="flags-kicker">{{ $t('admin:devFlags.databaseKnex') }}</p>
                    <h3>{{ $t('admin:devFlags.sqlQueryLogging') }}</h3>
                  </div>
                  <v-chip size="small" :color="draft.sqllog ? 'warning' : undefined" variant="tonal">
                    {{ draft.sqllog ? $t('admin:devFlags.draftEnabled') : $t('admin:devFlags.draftOff') }}
                  </v-chip>
                </div>
                <p class="mt-3">
                  {{ $t('admin:devFlags.setsProcesssKnexDebug') }}
                </p>
                <v-switch v-model="draft.sqllog" color="warning" :label="$t('admin:devFlags.enableSqlQueryLogging')" hide-details :disabled="locked" />
                <dl class="flags-facts">
                  <div>
                    <dt>{{ $t('admin:devFlags.prerequisite') }}</dt>
                    <dd>{{ $t('admin:devFlags.activeProcessMustReconcile') }}</dd>
                  </div>
                  <div>
                    <dt>{{ $t('admin:devFlags.sensitivity') }}</dt>
                    <dd>{{ $t('admin:devFlags.statementsBoundValuesMay') }}</dd>
                  </div>
                  <div>
                    <dt>{{ $t('admin:devFlags.performance') }}</dt>
                    <dd>{{ $t('admin:devFlags.everyDatabaseQueryCan') }}</dd>
                  </div>
                  <div>
                    <dt>{{ $t('admin:devFlags.reverse') }}</dt>
                    <dd>{{ $t('admin:devFlags.saveApplyOffStops') }}</dd>
                  </div>
                </dl>
              </article>
            </div>

            <aside class="flags-panel flags-panel--quiet">
              <p class="flags-kicker">{{ $t('admin:devFlags.reasonedChange') }}</p>
              <h3>{{ $t('admin:devFlags.leaveConciseOperationalReason') }}</h3>
              <p>
                {{ $t('admin:devFlags.reasonsIdentifyWhySensitive') }}
              </p>
              <v-textarea v-model="reason" class="mt-5" :label="$t('admin:devFlags.administrativeReason')" rows="4" maxlength="1000" counter :disabled="locked" />
              <div class="flags-runtime-note">
                <div>
                  <h3>{{ dirty ? $t('admin:devFlags.unsavedDraft') : $t('admin:devFlags.noPendingChanges') }}</h3>
                  <p>
                    {{
                      dirty
                        ? $t('admin:devFlags.reviewExactDifferencesBefore')
                        : $t('admin:devFlags.changeOneBothFlags')
                    }}
                  </p>
                </div>
              </div>
            </aside>
          </div>
          <div v-if="dirty" class="flags-savebar">
            <div>
              <strong>{{ $t('admin:devFlags.unsavedDiagnosticPolicy') }}</strong>
              <p>{{ $t('admin:devFlags.savingRecordsPolicyApplication') }}</p>
            </div>
            <div class="flags-actions">
              <v-btn variant="text" :disabled="busy" @click="resetDraft">{{ $t('admin:devFlags.reset') }}</v-btn>
              <v-btn color="primary" :disabled="locked || !policyChanged || reason.trim().length < 3" @click="reviewSave">{{ $t('admin:devFlags.reviewChanges') }}</v-btn>
            </div>
          </div>
        </section>

        <section v-else aria-labelledby="developer-flags-history">
          <div class="flags-section-head">
            <div>
              <p class="flags-kicker">{{ $t('admin:devFlags.n03ChangeRegister') }}</p>
              <h2 id="developer-flags-history">{{ $t('admin:devFlags.retainedRecordExplainsSaved') }}</h2>
              <p>{{ $t('admin:devFlags.onlyPolicyChangesRecorded') }}</p>
            </div>
          </div>
          <article class="flags-panel">
            <p v-if="!workspace.history.length" class="flags-empty">{{ $t('admin:devFlags.noDeveloperFlagPolicy') }}</p>
            <ol v-else class="flags-history">
              <li v-for="event in workspace.history" :key="event.id" class="flags-history-row">
                <div>
                  <strong>{{ event.changed.map(flagLabel).join(' and ') }}</strong>
                  <p>{{ event.reason }}</p>
                  <p>
                    {{ event.policy.ldapdebug ? $t('admin:devFlags.ldapDebugEnabled') : $t('admin:devFlags.ldapDebugOff') }} ·
                    {{ event.policy.sqllog ? $t('admin:devFlags.sqlQueryLoggingEnabled') : $t('admin:devFlags.sqlQueryLoggingOff') }}
                  </p>
                </div>
                <time :datetime="event.createdAt">{{ date(event.createdAt) }} · {{ actor(event) }}</time>
              </li>
            </ol>
          </article>
        </section>
      </template>
    </div>

    <v-dialog v-model="reviewOpen" max-width="620" :persistent="busy" aria-labelledby="developer-flags-review-title">
      <v-card class="pa-6">
        <p class="flags-kicker">{{ $t('admin:devFlags.review', { value: reviewKind === 'save' ? 'policy' : $t('admin:devFlags.runtimeApplication'), interpolation: { escapeValue: false } }) }}</p>
        <h2 id="developer-flags-review-title">
          {{ reviewKind === 'save' ? $t('admin:devFlags.saveDiagnosticPolicy') : $t('admin:devFlags.applyReviewedDiagnosticPolicy') }}
        </h2>
        <template v-if="reviewKind === 'save'">
          <p class="mt-4">{{ $t('admin:devFlags.reviewedPolicyRemainsSeparate') }}</p>
          <dl class="flags-facts">
            <div v-for="key in reviewChanges" :key="key">
              <dt>{{ flagLabel(key) }}</dt>
              <dd>{{ onOff(workspace!.saved.policy[key]) }} → {{ onOff(reviewPolicy![key]) }}</dd>
            </div>
            <div>
              <dt>{{ $t('admin:devFlags.reason') }}</dt>
              <dd>{{ reason.trim() }}</dd>
            </div>
          </dl>
          <v-checkbox
            v-if="enablesDiagnosticOutput"
            v-model="riskAcknowledged"
            :label="$t('admin:devFlags.iUnderstandTheseDiagnostics')"
            hide-details
            :disabled="busy"
          />
        </template>
        <template v-else>
          <p class="mt-4">
            {{ $t('admin:devFlags.applyPromotesReviewedFlags') }}
          </p>
          <dl class="flags-facts">
            <div>
              <dt>{{ $t('admin:devFlags.reviewedPolicy') }}</dt>
              <dd>{{ $t('admin:devFlags.ldapDebugSqlQuery', { ldapdebug: onOff(workspace!.saved.policy.ldapdebug), sqllog: onOff(workspace!.saved.policy.sqllog), interpolation: { escapeValue: false } }) }}</dd>
            </div>
            <div>
              <dt>{{ $t('admin:devFlags.currentProcess') }}</dt>
              <dd>{{ $t('admin:devFlags.ldapDebugSqlQuery', { ldapdebug: onOff(workspace!.process.policy.ldapdebug), sqllog: onOff(workspace!.process.policy.sqllog), interpolation: { escapeValue: false } }) }}</dd>
            </div>
          </dl>
          <v-checkbox
            v-model="riskAcknowledged"
            :label="$t('admin:devFlags.iReviewedPolicyWant')"
            hide-details
            :disabled="busy"
          />
        </template>
        <v-alert v-if="reviewError" type="error" variant="tonal" class="mt-5">{{ reviewError }}</v-alert>
        <v-card-actions class="px-0 pt-5">
          <v-spacer />
          <v-btn :disabled="busy" @click="closeReview">{{ $t('common:actions.cancel') }}</v-btn>
          <v-btn color="primary" :loading="busy" :disabled="!reviewReady" @click="confirmReview">
            {{ reviewKind === 'save' ? $t('admin:devFlags.savePolicy') : $t('admin:devFlags.promoteApplyPolicy') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { confirmDiscard } from '../common/confirm-dialog.ts'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import AsyncState from '@/components/common/async-state.vue'
import {
  developerFlagChangedFields,
  type DeveloperFlagEvent,
  type DeveloperFlagKey,
  type DeveloperFlags,
  type DeveloperFlagsWorkspace
} from '../../../shared/developer-flags.ts'
import { applyDeveloperFlags, fetchDeveloperFlagsWorkspace, saveDeveloperFlags } from '../../helpers/developer-flags-api.ts'
import './developer-flags-workspace.scss'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()

const sections = [
  { key: 'overview', title: t('admin:devFlags.overview') },
  { key: 'controls', title: t('admin:devFlags.controls') },
  { key: 'history', title: t('admin:devFlags.history') }
] as const
const FLAG_LABEL: Record<DeveloperFlagKey, string> = {
  ldapdebug: t('admin:devFlags.ldapDebug'),
  sqllog: t('admin:devFlags.sqlQueryLogging')
}
const route = useRoute()
const router = useRouter()
const workspace = shallowRef<DeveloperFlagsWorkspace | null>(null)
const draft = ref<DeveloperFlags>({ ldapdebug: false, sqllog: false })
const reason = ref('')
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const stale = ref(false)
const recoveryKind = ref<'save' | 'apply' | 'refresh' | ''>('')
const reviewOpen = ref(false)
const reviewKind = ref<'save' | 'apply'>('save')
const reviewPolicy = shallowRef<DeveloperFlags | null>(null)
const reviewFingerprint = ref('')
const riskAcknowledged = ref(false)
const reviewError = ref('')

let disposed = false
const savedSource = computed(() =>
  workspace.value?.saved.source === 'reviewed-administration'
    ? t('admin:devFlags.reviewedAdministrationRecord')
    : workspace.value?.saved.source === 'database'
      ? t('admin:devFlags.promotedDatabaseSetting')
      : t('admin:devFlags.effectiveDeploymentConfiguration')
)
let generation = 0

const section = computed(() =>
  sections.some((item) => item.key === route.query.section) ? (route.query.section as (typeof sections)[number]['key']) : 'overview'
)
const policyChanged = computed(() => Boolean(workspace.value && !samePolicy(draft.value, workspace.value.saved.policy)))
const dirty = computed(() => policyChanged.value || reason.value.trim().length > 0)
const locked = computed(() => loading.value || busy.value || stale.value || !workspace.value)
const reviewChanges = computed(() =>
  workspace.value && reviewPolicy.value ? developerFlagChangedFields(workspace.value.saved.policy, reviewPolicy.value) : []
)
const enablesDiagnosticOutput = computed(() =>
  Boolean(workspace.value && reviewPolicy.value && reviewChanges.value.some((key) => !workspace.value!.saved.policy[key] && reviewPolicy.value![key]))
)
const reviewReady = computed(
  () => !busy.value && (reviewKind.value === 'apply' ? riskAcknowledged.value : !enablesDiagnosticOutput.value || riskAcknowledged.value)
)
const recoveryMessage = computed(() =>
  recoveryKind.value === 'save'
    ? t('admin:devFlags.saveResponseWasNot')
    : recoveryKind.value === 'apply'
      ? t('admin:devFlags.applicationResponseWasNot')
      : t('admin:devFlags.priorActionWasConfirmed')
)

function samePolicy(left: DeveloperFlags, right: DeveloperFlags) {
  return left.ldapdebug === right.ldapdebug && left.sqllog === right.sqllog
}

function copyPolicy(value: DeveloperFlags): DeveloperFlags {
  return { ldapdebug: value.ldapdebug, sqllog: value.sqllog }
}

function onOff(value: boolean) {
  return value ? t('admin:devFlags.enabled') : t('admin:devFlags.off')
}

function flagLabel(value: DeveloperFlagKey) {
  return FLAG_LABEL[value]
}

function actor(value: DeveloperFlagEvent) {
  return value.apiKeyId ? t('admin:devFlags.apiCredential', { apiKeyId: value.apiKeyId, interpolation: { escapeValue: false } }) : value.actorId ? t('admin:devFlags.user', { actorId: value.actorId, interpolation: { escapeValue: false } }) : t('admin:devFlags.unknownPrincipal')
}

function date(value: string) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? t('admin:devFlags.unknownTime') : parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function resetDraft() {
  if (workspace.value) draft.value = copyPolicy(workspace.value.saved.policy)
  reason.value = ''
  notice.value = ''
}

async function reloadWorkspace(preserveDraft = false): Promise<boolean> {
  const token = ++generation
  const pendingDraft = copyPolicy(draft.value)
  loading.value = true
  error.value = ''
  try {
    const value = await fetchDeveloperFlagsWorkspace()
    if (disposed || token !== generation) return false
    workspace.value = value
    if (preserveDraft) {
      draft.value = pendingDraft
      notice.value = t('admin:devFlags.savedStateWasReloaded')
    } else {
      resetDraft()
    }
    stale.value = false
    recoveryKind.value = ''
    return true
  } catch (cause) {
    if (!disposed && token === generation) error.value = cause instanceof Error ? cause.message : t('admin:devFlags.developerFlagsCouldNot')
    return false
  } finally {
    if (!disposed && token === generation) loading.value = false
  }
}

const discardTitle = t('admin:devFlags.discardDiagnosticDraft'),
  discardMessage = t('admin:devFlags.savedPolicyAnyProcess')

async function guarded(action: () => void) {
  if (!dirty.value) return action()
  if (!(await confirmDiscard(discardTitle, discardMessage, t('admin:devFlags.discardDraft')))) return
  resetDraft()
  action()
}

function refresh() {
  guarded(() => {
    void reloadWorkspace()
  })
}

function recover() {
  void reloadWorkspace(true)
}

function selectSection(value: (typeof sections)[number]['key']) {
  void router.replace({ query: { ...route.query, section: value } })
}

function reviewSave() {
  if (!workspace.value || !policyChanged.value || reason.value.trim().length < 3) return
  reviewKind.value = 'save'
  reviewPolicy.value = copyPolicy(draft.value)
  reviewFingerprint.value = workspace.value.fingerprint
  riskAcknowledged.value = false
  reviewError.value = ''
  reviewOpen.value = true
}

function reviewApply() {
  if (!workspace.value || workspace.value.process.settingsCurrent) return
  reviewKind.value = 'apply'
  reviewPolicy.value = copyPolicy(workspace.value.saved.policy)
  reviewFingerprint.value = workspace.value.fingerprint
  riskAcknowledged.value = false
  reviewError.value = ''
  reviewOpen.value = true
}

function closeReview() {
  if (busy.value) return
  reviewOpen.value = false
  reviewError.value = ''
}

function unexpectedOutcome(kind: 'save' | 'apply' | 'refresh') {
  stale.value = true
  recoveryKind.value = kind
}

async function confirmedRefresh(message: string) {
  const refreshed = await reloadWorkspace()
  notice.value = message
  if (!refreshed) unexpectedOutcome('refresh')
}

async function confirmReview() {
  if (!workspace.value || !reviewPolicy.value || !reviewReady.value) return
  busy.value = true
  reviewError.value = ''
  try {
    if (reviewKind.value === 'save') {
      await saveDeveloperFlags(reviewPolicy.value, reviewFingerprint.value, reason.value.trim())
      reviewOpen.value = false
      await confirmedRefresh(t('admin:devFlags.developerFlagPolicySaved'))
    } else {
      const result = await applyDeveloperFlags(reviewFingerprint.value)
      reviewOpen.value = false
      if (result.applied) {
        await confirmedRefresh(
          result.published
            ? t('admin:devFlags.savedPolicyAppliedProcess')
            : t('admin:devFlags.savedPolicyAppliedProcess2')
        )
      } else {
        notice.value = t('admin:devFlags.savedPolicyWasNot')
        unexpectedOutcome('refresh')
      }
    }
  } catch (cause) {
    const status = cause && typeof cause === 'object' ? Reflect.get(cause, 'status') : undefined
    reviewError.value = cause instanceof Error ? cause.message : t('admin:devFlags.actionOutcomeCouldNot')
    if (status === 409) {
      reviewOpen.value = false
      unexpectedOutcome('refresh')
    } else if (typeof status !== 'number' || status >= 500) {
      reviewOpen.value = false
      unexpectedOutcome(reviewKind.value)
    }
  } finally {
    busy.value = false
  }
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value || busy.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}

onBeforeRouteLeave(async () => {
  if (busy.value) return false
  if (!dirty.value) return true
  return !busy.value && (await confirmDiscard(discardTitle, discardMessage, t('admin:devFlags.discardDraft')))
})

onMounted(() => {
  void reloadWorkspace()
  window.addEventListener('beforeunload', beforeUnload)
})

onBeforeUnmount(() => {
  disposed = true
  generation++
  window.removeEventListener('beforeunload', beforeUnload)
})
</script>
