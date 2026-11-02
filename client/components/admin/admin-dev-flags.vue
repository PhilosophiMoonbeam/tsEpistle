<template>
  <div class="developer-flags-workspace" :class="{ 'has-admin-draft-bar': dirty }" :style="{ '--admin-draft-bar-height': draftBarHeight ? `${draftBarHeight}px` : undefined }">
    <div :inert="reviewOpen || undefined">
      <admin-hero
        :title="dt('developerFlags')"
        :description="dt('temporaryDiagnosticSettingsInvestigating')"
        :eyebrow="dt('operations')"
        icon="mdi-toggle-switch-off-outline"
      >
        <template v-if="workspace" #status>
          <dl class="flags-strip">
            <div>
              <dt>{{ dt('reviewedPolicy') }}</dt>
              <dd>{{ workspace.saved.state === 'staged' ? dt('awaitingExplicitApplication') : savedSource }}</dd>
            </div>
            <div>
              <dt>{{ dt('process') }}</dt>
              <dd>{{ workspace.process.state === 'applied' ? dt('matchesSavedPolicy') : dt('needsReconciliation') }}</dd>
            </div>
            <div>
              <dt>{{ dt('observed') }}</dt>
              <dd>{{ date(workspace.observedAt) }}</dd>
            </div>
          </dl>
        </template>
        <template #actions>
          <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" :disabled="busy" @click="refresh">{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ dt('reloadDeveloperFlagObservations') }}</v-tooltip></v-btn>
          <v-btn variant="tonal" :disabled="!canReviewSave" :data-commitment="canReviewSave && dirty ? 'active' : undefined" @click="reviewSave">{{ dt('reviewChanges') }}</v-btn>
        </template>
      </admin-hero>

      <async-state
        v-if="loading && !workspace"
        state="loading"
        :title="dt('readingDeveloperFlagSettings')"
        :message="dt('loadingSavedPolicyCurrent')"
      />
      <async-state
        v-else-if="error && !workspace"
        state="error"
        :title="dt('developerFlagsCouldNot2')"
        :message="error"
        :retry-label="dt('tryAgain')"
        @retry="reloadWorkspace()"
      />

      <template v-else-if="workspace">
        <v-alert v-if="error" type="error" variant="tonal" class="mb-4" role="alert">{{ error }}</v-alert>
        <v-alert v-if="notice" type="success" variant="tonal" class="mb-4" role="status">{{ notice }}</v-alert>
        <v-alert v-if="stale" type="warning" variant="tonal" class="mb-4">
          {{ recoveryMessage }}
          <v-btn variant="text" :disabled="busy" @click="recover">{{ dt('readSavedState') }}</v-btn>
        </v-alert>

        <nav ref="sectionNav" class="flags-nav" :aria-label="dt('developerFlagSections')">
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
          <header class="flags-section-head">
            <h2 id="developer-flags-overview">{{ dt('overview') }}</h2>
            <p>{{ dt('bothFlagsChangeServer') }}</p>
          </header>
          <div class="flags-grid">
            <article class="flags-panel">
              <h3>{{ dt('reviewedPolicyLocalProcess') }}</h3>
              <dl class="flags-facts">
                <div>
                  <dt>{{ dt('ldapDebug') }}</dt>
                  <dd>{{ dt('reviewedProcess', { ldapdebug: onOff(workspace.saved.policy.ldapdebug), ldapdebug2: onOff(workspace.process.policy.ldapdebug), interpolation: { escapeValue: false } }) }}</dd>
                </div>
                <div>
                  <dt>{{ dt('sqlQueryLogging') }}</dt>
                  <dd>{{ dt('reviewedProcess2', { sqllog: onOff(workspace.saved.policy.sqllog), sqllog2: onOff(workspace.process.policy.sqllog), interpolation: { escapeValue: false } }) }}</dd>
                </div>
                <div>
                  <dt>{{ dt('knexDebugSwitch') }}</dt>
                  <dd>{{ workspace.process.sqlQueryLoggingApplied ? dt('observedEnabled') : dt('observedDisabled') }}</dd>
                </div>
                <div>
                  <dt>{{ dt('processScope') }}</dt>
                  <dd>{{ dt('pointTimeLocalObservation', { instanceId: workspace.process.instanceId, interpolation: { escapeValue: false } }) }}</dd>
                </div>
              </dl>
              <div v-if="workspace.saved.state === 'staged'" class="flags-runtime-note">
                <div>
                  <h3>{{ dt('stagedNotActivated') }}</h3>
                  <p>
                    {{ dt('savingRecordsReviewedPolicy') }}
                  </p>
                </div>
              </div>
              <div v-if="!workspace.process.settingsCurrent" class="flags-runtime-note">
                <div>
                  <h3>{{ workspace.saved.state === 'staged' ? dt('applicationRequired') : dt('savedNotReconciled') }}</h3>
                  <p>{{ dt('reviewReconciliationBeforeAnother') }}</p>
                </div>
                <v-btn color="primary" :disabled="locked" @click="reviewApply">{{ dt('reviewApplication') }}</v-btn>
              </div>
            </article>
            <aside class="flags-panel">
              <p class="flags-kicker">{{ dt('deploymentBaseline') }}</p>
              <h3>{{ dt('defaultsNotEvidenceRunning') }}</h3>
              <p>
                {{ dt('deploymentDefaultsLdapDebug', { ldapdebug: onOff(workspace.deployment.defaults.ldapdebug), sqllog: onOff(workspace.deployment.defaults.sqllog), interpolation: { escapeValue: false } }) }}
              </p>
              <p>
                {{ dt('applyingSendsPeerReload') }}
              </p>
            </aside>
          </div>
        </section>

        <section v-else-if="section === 'controls'" aria-labelledby="developer-flags-controls">
          <header class="flags-section-head">
            <h2 id="developer-flags-controls">{{ dt('controls') }}</h2>
            <p>{{ dt('draftChangesDoNot') }}</p>
          </header>
          <div class="flags-grid">
            <div>
              <article class="flags-flag" :class="{ 'flags-flag--enabled': draft.ldapdebug }">
                <div class="flags-flag__head">
                  <div>
                    <p class="flags-kicker">{{ dt('authenticationLdap') }}</p>
                    <h3>{{ dt('ldapDebug') }}</h3>
                  </div>
                  <v-chip size="small" :color="draft.ldapdebug ? 'warning' : undefined" variant="tonal">
                    {{ draft.ldapdebug ? dt('draftEnabled') : dt('draftOff') }}
                  </v-chip>
                </div>
                <p class="mt-3">{{ dt('writesLdapAdAuthentication') }}</p>
                <v-switch :model-value="draft.ldapdebug" @update:model-value="$event !== null && (draft.ldapdebug = $event)" color="warning" :label="dt('enableLdapDebug')" hide-details :disabled="locked" />
                <dl class="flags-facts">
                  <div>
                    <dt>{{ dt('prerequisite') }}</dt>
                    <dd>{{ dt('ldapSignAttemptMust') }}</dd>
                  </div>
                  <div>
                    <dt>{{ dt('sensitivity') }}</dt>
                    <dd>
                      {{ dt('errorObjectsCanContain') }}
                    </dd>
                  </div>
                  <div>
                    <dt>{{ dt('performance') }}</dt>
                    <dd>{{ dt('onlyFailureExceptionPaths') }}</dd>
                  </div>
                  <div>
                    <dt>{{ dt('reverse') }}</dt>
                    <dd>
                      {{ dt('saveApplyOffAfter') }}
                    </dd>
                  </div>
                </dl>
              </article>

              <article class="flags-flag" :class="{ 'flags-flag--enabled': draft.sqllog }">
                <div class="flags-flag__head">
                  <div>
                    <p class="flags-kicker">{{ dt('databaseKnex') }}</p>
                    <h3>{{ dt('sqlQueryLogging') }}</h3>
                  </div>
                  <v-chip size="small" :color="draft.sqllog ? 'warning' : undefined" variant="tonal">
                    {{ draft.sqllog ? dt('draftEnabled') : dt('draftOff') }}
                  </v-chip>
                </div>
                <p class="mt-3">
                  {{ dt('setsProcesssKnexDebug') }}
                </p>
                <v-switch :model-value="draft.sqllog" @update:model-value="$event !== null && (draft.sqllog = $event)" color="warning" :label="dt('enableSqlQueryLogging')" hide-details :disabled="locked" />
                <dl class="flags-facts">
                  <div>
                    <dt>{{ dt('prerequisite') }}</dt>
                    <dd>{{ dt('activeProcessMustReconcile') }}</dd>
                  </div>
                  <div>
                    <dt>{{ dt('sensitivity') }}</dt>
                    <dd>{{ dt('statementsBoundValuesMay') }}</dd>
                  </div>
                  <div>
                    <dt>{{ dt('performance') }}</dt>
                    <dd>{{ dt('everyDatabaseQueryCan') }}</dd>
                  </div>
                  <div>
                    <dt>{{ dt('reverse') }}</dt>
                    <dd>{{ dt('saveApplyOffStops') }}</dd>
                  </div>
                </dl>
              </article>
            </div>

            <aside class="flags-panel">
              <p class="flags-kicker">{{ dt('reasonedChange') }}</p>
              <h3>{{ dt('leaveConciseOperationalReason') }}</h3>
              <p>
                {{ dt('reasonsIdentifyWhySensitive') }}
              </p>
              <v-textarea v-model="reason" class="mt-5" :label="dt('administrativeReason')" rows="4" maxlength="1000" counter :disabled="locked" />
            </aside>
          </div>
        </section>

        <section v-else aria-labelledby="developer-flags-history">
          <header class="flags-section-head">
            <h2 id="developer-flags-history">{{ dt('history') }}</h2>
            <p>{{ dt('onlyPolicyChangesRecorded') }}</p>
          </header>
          <article class="flags-panel">
            <p v-if="!workspace.history.length" class="flags-empty">{{ dt('noDeveloperFlagPolicy') }}</p>
            <ol v-else class="flags-history">
              <li v-for="event in workspace.history" :key="event.id" class="flags-history-row">
                <div>
                  <strong>{{ event.changed.map(flagLabel).join(' and ') }}</strong>
                  <p>{{ event.reason }}</p>
                  <p>
                    {{ event.policy.ldapdebug ? dt('ldapDebugEnabled') : dt('ldapDebugOff') }} ·
                    {{ event.policy.sqllog ? dt('sqlQueryLoggingEnabled') : dt('sqlQueryLoggingOff') }}
                  </p>
                </div>
                <time :datetime="event.createdAt">{{ date(event.createdAt) }} · {{ actor(event) }}</time>
              </li>
            </ol>
          </article>
        </section>
        <div v-if="dirty" ref="draftBar" class="flags-savebar">
          <div>
            <strong>{{ dt('unsavedDiagnosticPolicy') }}</strong>
            <p>{{ dt('savingRecordsPolicyApplication') }}</p>
          </div>
          <v-btn variant="text" :disabled="busy" @click="resetPendingDraft">{{ dt('reset') }}</v-btn>
        </div>
      </template>
    </div>

    <v-dialog v-model="reviewOpen" max-width="620" :persistent="busy" aria-labelledby="developer-flags-review-title">
      <v-card class="pa-6">
        <p class="flags-kicker">{{ dt('review', { value: reviewKind === 'save' ? 'policy' : dt('runtimeApplication'), interpolation: { escapeValue: false } }) }}</p>
        <h2 id="developer-flags-review-title">
          {{ reviewKind === 'save' ? dt('saveDiagnosticPolicy') : dt('applyReviewedDiagnosticPolicy') }}
        </h2>
        <template v-if="reviewKind === 'save'">
          <p class="mt-4">{{ dt('reviewedPolicyRemainsSeparate') }}</p>
          <dl class="flags-facts">
            <div v-for="key in reviewChanges" :key="key">
              <dt>{{ flagLabel(key) }}</dt>
              <dd>{{ onOff(workspace!.saved.policy[key]) }} → {{ onOff(reviewPolicy![key]) }}</dd>
            </div>
            <div>
              <dt>{{ dt('reason') }}</dt>
              <dd>{{ reviewReason }}</dd>
            </div>
          </dl>
          <v-checkbox
            v-if="enablesDiagnosticOutput"
            :model-value="riskAcknowledged"
            @update:model-value="riskAcknowledged = $event === true"
            :label="dt('iUnderstandTheseDiagnostics')"
            hide-details
            :disabled="busy"
          />
        </template>
        <template v-else>
          <p class="mt-4">
            {{ dt('applyPromotesReviewedFlags') }}
          </p>
          <dl class="flags-facts">
            <div>
              <dt>{{ dt('reviewedPolicy') }}</dt>
              <dd>{{ dt('ldapDebugSqlQuery', { ldapdebug: onOff(workspace!.saved.policy.ldapdebug), sqllog: onOff(workspace!.saved.policy.sqllog), interpolation: { escapeValue: false } }) }}</dd>
            </div>
            <div>
              <dt>{{ dt('currentProcess') }}</dt>
              <dd>{{ dt('ldapDebugSqlQuery', { ldapdebug: onOff(workspace!.process.policy.ldapdebug), sqllog: onOff(workspace!.process.policy.sqllog), interpolation: { escapeValue: false } }) }}</dd>
            </div>
          </dl>
          <v-checkbox
            :model-value="riskAcknowledged"
            @update:model-value="riskAcknowledged = $event === true"
            :label="dt('iReviewedPolicyWant')"
            hide-details
            :disabled="busy"
          />
        </template>
        <v-alert v-if="reviewError" type="error" variant="tonal" class="mt-5">{{ reviewError }}</v-alert>
        <v-card-actions class="px-0 pt-5">
          <v-spacer />
          <v-btn :disabled="busy" @click="closeReview">{{ $t('common:actions.cancel') }}</v-btn>
          <v-btn color="primary" :loading="busy" :disabled="!reviewReady" :data-commitment="reviewKind === 'save' && reviewReady ? 'active' : undefined" @click="confirmReview">
            {{ reviewKind === 'save' ? dt('savePolicy') : dt('promoteApplyPolicy') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { confirmDiscard } from '../common/confirm-dialog.ts'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
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

const dt = useTranslate('admin:devFlags')

const sections = [
  { key: 'overview', title: dt('overview') },
  { key: 'controls', title: dt('controls') },
  { key: 'history', title: dt('history') }
] as const
const FLAG_LABEL: Record<DeveloperFlagKey, string> = {
  ldapdebug: dt('ldapDebug'),
  sqllog: dt('sqlQueryLogging')
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
const reviewReason = ref('')
const riskAcknowledged = ref(false)
const reviewError = ref('')
const sectionNav = ref<HTMLElement | null>(null)
const draftBar = ref<HTMLElement | null>(null)
const draftBarHeight = ref(0)

watch(draftBar, (element, _previous, onCleanup) => {
  draftBarHeight.value = element?.getBoundingClientRect().height ?? 0
  if (!element) return
  const measure = () => { draftBarHeight.value = element.getBoundingClientRect().height }
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  } else {
    window.addEventListener('resize', measure)
    onCleanup(() => window.removeEventListener('resize', measure))
  }
}, { flush: 'post' })

let disposed = false
const savedSource = computed(() =>
  workspace.value?.saved.source === 'reviewed-administration'
    ? dt('reviewedAdministrationRecord')
    : workspace.value?.saved.source === 'database'
      ? dt('promotedDatabaseSetting')
      : dt('effectiveDeploymentConfiguration')
)
let generation = 0

const section = computed(() =>
  sections.some((item) => item.key === route.query.section) ? (route.query.section as (typeof sections)[number]['key']) : 'overview'
)
const policyChanged = computed(() => Boolean(workspace.value && !samePolicy(draft.value, workspace.value.saved.policy)))
const dirty = computed(() => policyChanged.value || reason.value.trim().length > 0)
const locked = computed(() => loading.value || busy.value || stale.value || !workspace.value)
const canReviewSave = computed(() => !locked.value && policyChanged.value && reason.value.trim().length >= 3)
const reviewChanges = computed(() =>
  workspace.value && reviewPolicy.value ? developerFlagChangedFields(workspace.value.saved.policy, reviewPolicy.value) : []
)
const enablesDiagnosticOutput = computed(() =>
  Boolean(workspace.value && reviewPolicy.value && reviewChanges.value.some((key) => !workspace.value!.saved.policy[key] && reviewPolicy.value![key]))
)
const reviewReady = computed(
  () => !busy.value && !loading.value && !stale.value && Boolean(workspace.value) && (reviewKind.value === 'apply'
    ? riskAcknowledged.value
    : reviewChanges.value.length > 0 && reviewReason.value.length >= 3 && (!enablesDiagnosticOutput.value || riskAcknowledged.value))
)
const recoveryMessage = computed(() =>
  recoveryKind.value === 'save'
    ? dt('saveResponseWasNot')
    : recoveryKind.value === 'apply'
      ? dt('applicationResponseWasNot')
      : dt('priorActionWasConfirmed')
)

function samePolicy(left: DeveloperFlags, right: DeveloperFlags) {
  return left.ldapdebug === right.ldapdebug && left.sqllog === right.sqllog
}

function copyPolicy(value: DeveloperFlags): DeveloperFlags {
  return { ldapdebug: value.ldapdebug, sqllog: value.sqllog }
}

function onOff(value: boolean) {
  return value ? dt('enabled') : dt('off')
}

function flagLabel(value: DeveloperFlagKey) {
  return FLAG_LABEL[value]
}

function actor(value: DeveloperFlagEvent) {
  return value.apiKeyId ? dt('apiCredential', { apiKeyId: value.apiKeyId, interpolation: { escapeValue: false } }) : value.actorId ? dt('user', { actorId: value.actorId, interpolation: { escapeValue: false } }) : dt('unknownPrincipal')
}

function date(value: string) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? dt('unknownTime') : parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function resetDraft() {
  if (workspace.value) draft.value = copyPolicy(workspace.value.saved.policy)
  reason.value = ''
  notice.value = ''
}

async function resetPendingDraft() {
  resetDraft()
  await nextTick()
  sectionNav.value?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus()
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
      notice.value = dt('savedStateWasReloaded')
    } else {
      resetDraft()
    }
    stale.value = false
    recoveryKind.value = ''
    return true
  } catch (cause) {
    if (!disposed && token === generation) error.value = cause instanceof Error ? cause.message : dt('developerFlagsCouldNot')
    return false
  } finally {
    if (!disposed && token === generation) loading.value = false
  }
}

const discardTitle = dt('discardDiagnosticDraft'),
  discardMessage = dt('savedPolicyAnyProcess')

async function guarded(action: () => void) {
  if (!dirty.value) return action()
  if (!(await confirmDiscard(discardTitle, discardMessage, dt('discardDraft')))) return
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
  if (!canReviewSave.value || !workspace.value) return
  reviewKind.value = 'save'
  reviewPolicy.value = copyPolicy(draft.value)
  reviewFingerprint.value = workspace.value.fingerprint
  reviewReason.value = reason.value.trim()
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
      await saveDeveloperFlags(reviewPolicy.value, reviewFingerprint.value, reviewReason.value)
      reviewOpen.value = false
      await confirmedRefresh(dt('developerFlagPolicySaved'))
    } else {
      const result = await applyDeveloperFlags(reviewFingerprint.value)
      reviewOpen.value = false
      if (result.applied) {
        await confirmedRefresh(
          result.published
            ? dt('savedPolicyAppliedProcess')
            : dt('savedPolicyAppliedProcess2')
        )
      } else {
        notice.value = dt('savedPolicyWasNot')
        unexpectedOutcome('refresh')
      }
    }
  } catch (cause) {
    const status = cause && typeof cause === 'object' ? Reflect.get(cause, 'status') : undefined
    reviewError.value = cause instanceof Error ? cause.message : dt('actionOutcomeCouldNot')
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
  return !busy.value && (await confirmDiscard(discardTitle, discardMessage, dt('discardDraft')))
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
