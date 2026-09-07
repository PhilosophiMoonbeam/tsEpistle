<template>
  <div class="developer-flags-workspace">
    <div :inert="reviewOpen || discardOpen || undefined">
      <header class="flags-hero">
        <div>
          <p class="flags-kicker">Workspace controls / Diagnostic boundaries</p>
          <h1>Developer flags</h1>
          <p class="flags-intro">
            Temporary diagnostic settings for investigating an active problem. Save a reviewed policy first, then explicitly reconcile it with this
            process.
          </p>
        </div>
        <v-btn variant="outlined" prepend-icon="mdi-refresh" :loading="loading" :disabled="busy" @click="refresh">Refresh observations</v-btn>
      </header>

      <async-state
        v-if="loading && !workspace"
        state="loading"
        title="Reading developer flag settings"
        message="Loading the saved policy and the current process observation."
      />
      <async-state
        v-else-if="error && !workspace"
        state="error"
        title="Developer flags could not be loaded"
        :message="error"
        retry-label="Try again"
        @retry="reloadWorkspace()"
      />

      <template v-else-if="workspace">
        <v-alert v-if="error" type="error" variant="tonal" class="mb-4" role="alert">{{ error }}</v-alert>
        <v-alert v-if="notice" type="success" variant="tonal" class="mb-4" role="status">{{ notice }}</v-alert>
        <v-alert v-if="stale" type="warning" variant="tonal" class="mb-4">
          {{ recoveryMessage }}
          <v-btn variant="text" :disabled="busy" @click="recover">Read saved state</v-btn>
        </v-alert>

        <div class="flags-strip">
          <div>
            <span>Reviewed policy</span>
            <strong>{{ workspace.saved.state === 'staged' ? 'Awaiting explicit application' : savedSource }}</strong>
          </div>
          <div>
            <span>This process</span>
            <strong>{{ workspace.process.state === 'applied' ? 'Matches saved policy' : 'Needs reconciliation' }}</strong>
          </div>
          <div>
            <span>Observed</span>
            <strong>{{ date(workspace.observedAt) }}</strong>
          </div>
        </div>

        <nav class="flags-nav" aria-label="Developer flag sections">
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
              <p class="flags-kicker">01 / Operating boundary</p>
              <h2 id="developer-flags-overview">Turn detail on only long enough to find the fault.</h2>
              <p>Both flags change server-side diagnostic output. They are not reader features, health signals, or persistent monitoring.</p>
            </div>
          </div>
          <div class="flags-grid">
            <article class="flags-panel">
              <h3>Reviewed policy and local process</h3>
              <dl class="flags-facts">
                <div>
                  <dt>LDAP Debug</dt>
                  <dd>Reviewed {{ onOff(workspace.saved.policy.ldapdebug) }} · process {{ onOff(workspace.process.policy.ldapdebug) }}</dd>
                </div>
                <div>
                  <dt>SQL Query Logging</dt>
                  <dd>Reviewed {{ onOff(workspace.saved.policy.sqllog) }} · process {{ onOff(workspace.process.policy.sqllog) }}</dd>
                </div>
                <div>
                  <dt>Knex debug switch</dt>
                  <dd>{{ workspace.process.sqlQueryLoggingApplied ? 'Observed enabled' : 'Observed disabled' }}</dd>
                </div>
                <div>
                  <dt>Process scope</dt>
                  <dd>{{ workspace.process.instanceId }} · this is a point-in-time local observation</dd>
                </div>
              </dl>
              <div v-if="workspace.saved.state === 'staged'" class="flags-runtime-note">
                <div>
                  <h3>Staged, not activated</h3>
                  <p>
                    Saving records this reviewed policy separately. Unrelated configuration reloads and restarts keep the active flags unchanged until
                    you explicitly apply it.
                  </p>
                </div>
              </div>
              <div v-if="!workspace.process.settingsCurrent" class="flags-runtime-note">
                <div>
                  <h3>{{ workspace.saved.state === 'staged' ? 'Application required' : 'Saved, not reconciled' }}</h3>
                  <p>Review the reconciliation before another flag change.</p>
                </div>
                <v-btn color="primary" :disabled="locked" @click="reviewApply">Review application</v-btn>
              </div>
            </article>
            <aside class="flags-panel flags-panel--quiet">
              <p class="flags-kicker">Deployment baseline</p>
              <h3>Defaults are not evidence of a running effect.</h3>
              <p>
                Deployment defaults are LDAP Debug {{ onOff(workspace.deployment.defaults.ldapdebug) }} and SQL Query Logging
                {{ onOff(workspace.deployment.defaults.sqllog) }}. A promoted database flag setting overrides the effective deployment configuration
                when present.
              </p>
              <p>
                Applying sends a peer reload request after this process has reconciled. The request cannot confirm that any peer received or applied
                it.
              </p>
            </aside>
          </div>
        </section>

        <section v-else-if="section === 'controls'" aria-labelledby="developer-flags-controls">
          <div class="flags-section-head">
            <div>
              <p class="flags-kicker">02 / Reviewed diagnostic policy</p>
              <h2 id="developer-flags-controls">Name the exposure before you save it.</h2>
              <p>Draft changes do not affect requests. A review records the selected flags, your current authority, and the administrative reason.</p>
            </div>
          </div>
          <div class="flags-grid">
            <div>
              <article class="flags-flag" :class="{ 'flags-flag--enabled': draft.ldapdebug }">
                <div class="flags-flag__head">
                  <div>
                    <p class="flags-kicker">Authentication / LDAP</p>
                    <h3>LDAP Debug</h3>
                  </div>
                  <v-chip size="small" :color="draft.ldapdebug ? 'warning' : undefined" variant="tonal">
                    {{ draft.ldapdebug ? 'Draft: enabled' : 'Draft: off' }}
                  </v-chip>
                </div>
                <p class="mt-3">Writes LDAP/AD authentication error objects to the application warning log when an LDAP sign-in fails or throws.</p>
                <v-switch v-model="draft.ldapdebug" color="warning" label="Enable LDAP Debug" hide-details :disabled="locked" />
                <dl class="flags-facts">
                  <div>
                    <dt>Prerequisite</dt>
                    <dd>An LDAP sign-in attempt must reach this server. Other authentication strategies are unaffected.</dd>
                  </div>
                  <div>
                    <dt>Sensitivity</dt>
                    <dd>
                      Error objects can contain directory, endpoint, or account details. This control does not redact what the authentication handler
                      logs.
                    </dd>
                  </div>
                  <div>
                    <dt>Performance</dt>
                    <dd>Only failure and exception paths add messages, but log volume and log transport still add work.</dd>
                  </div>
                  <div>
                    <dt>Reverse</dt>
                    <dd>
                      Save and apply Off after gathering the needed evidence. Existing log records remain wherever your deployment retained them.
                    </dd>
                  </div>
                </dl>
              </article>

              <article class="flags-flag" :class="{ 'flags-flag--enabled': draft.sqllog }">
                <div class="flags-flag__head">
                  <div>
                    <p class="flags-kicker">Database / Knex</p>
                    <h3>SQL Query Logging</h3>
                  </div>
                  <v-chip size="small" :color="draft.sqllog ? 'warning' : undefined" variant="tonal">
                    {{ draft.sqllog ? 'Draft: enabled' : 'Draft: off' }}
                  </v-chip>
                </div>
                <p class="mt-3">
                  Sets this process’s Knex debug switch so database queries can be written to the server’s configured console output.
                </p>
                <v-switch v-model="draft.sqllog" color="warning" label="Enable SQL Query Logging" hide-details :disabled="locked" />
                <dl class="flags-facts">
                  <div>
                    <dt>Prerequisite</dt>
                    <dd>The active process must reconcile the saved policy with its database connection. A peer needs its own reload handling.</dd>
                  </div>
                  <div>
                    <dt>Sensitivity</dt>
                    <dd>Statements and bound values may be emitted. Do not assume SQL diagnostic output is redacted.</dd>
                  </div>
                  <div>
                    <dt>Performance</dt>
                    <dd>Every database query can add log I/O. It can produce substantial volume and materially slow a busy process.</dd>
                  </div>
                  <div>
                    <dt>Reverse</dt>
                    <dd>Save and apply Off. It stops future Knex debug output on a reconciled process; it does not remove retained logs.</dd>
                  </div>
                </dl>
              </article>
            </div>

            <aside class="flags-panel flags-panel--quiet">
              <p class="flags-kicker">Reasoned change</p>
              <h3>Leave a concise operational reason.</h3>
              <p>
                Reasons identify why a sensitive diagnostic setting was changed. Do not place credentials, query values, directory records, or
                customer data here.
              </p>
              <v-textarea v-model="reason" class="mt-5" label="Administrative reason" rows="4" maxlength="1000" counter :disabled="locked" />
              <div class="flags-runtime-note">
                <div>
                  <h3>{{ dirty ? 'Unsaved draft' : 'No pending changes' }}</h3>
                  <p>
                    {{
                      dirty
                        ? 'Review the exact differences before saving. Saving alone does not change the process.'
                        : 'Change one or both flags to prepare a reviewed policy.'
                    }}
                  </p>
                </div>
              </div>
            </aside>
          </div>
          <div v-if="dirty" class="flags-savebar">
            <div>
              <strong>Unsaved diagnostic policy</strong>
              <p>Saving records the policy. Application remains a separate, explicit action.</p>
            </div>
            <div class="flags-actions">
              <v-btn variant="text" :disabled="busy" @click="resetDraft">Reset</v-btn>
              <v-btn color="primary" :disabled="locked || !policyChanged || reason.trim().length < 3" @click="reviewSave">Review changes</v-btn>
            </div>
          </div>
        </section>

        <section v-else aria-labelledby="developer-flags-history">
          <div class="flags-section-head">
            <div>
              <p class="flags-kicker">03 / Change register</p>
              <h2 id="developer-flags-history">The retained record explains the saved policy.</h2>
              <p>Only policy changes are recorded here. Reloading reads current state; it never repeats a save or runtime application.</p>
            </div>
          </div>
          <article class="flags-panel">
            <p v-if="!workspace.history.length" class="flags-empty">No developer flag policy changes have been recorded.</p>
            <ol v-else class="flags-history">
              <li v-for="event in workspace.history" :key="event.id" class="flags-history-row">
                <div>
                  <strong>{{ event.changed.map(flagLabel).join(' and ') }}</strong>
                  <p>{{ event.reason }}</p>
                  <p>
                    {{ event.policy.ldapdebug ? 'LDAP Debug enabled' : 'LDAP Debug off' }} ·
                    {{ event.policy.sqllog ? 'SQL Query Logging enabled' : 'SQL Query Logging off' }}
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
        <p class="flags-kicker">Review {{ reviewKind === 'save' ? 'policy' : 'runtime application' }}</p>
        <h2 id="developer-flags-review-title">
          {{ reviewKind === 'save' ? 'Save this diagnostic policy' : 'Apply the reviewed diagnostic policy' }}
        </h2>
        <template v-if="reviewKind === 'save'">
          <p class="mt-4">The reviewed policy remains separate from active settings and the running process until you explicitly apply it.</p>
          <dl class="flags-facts">
            <div v-for="key in reviewChanges" :key="key">
              <dt>{{ flagLabel(key) }}</dt>
              <dd>{{ onOff(workspace!.saved.policy[key]) }} → {{ onOff(reviewPolicy![key]) }}</dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd>{{ reason.trim() }}</dd>
            </div>
          </dl>
          <v-checkbox
            v-if="enablesDiagnosticOutput"
            v-model="riskAcknowledged"
            label="I understand these diagnostics can expose sensitive information in server logs and add log volume."
            hide-details
            :disabled="busy"
          />
        </template>
        <template v-else>
          <p class="mt-4">
            Apply promotes the reviewed flags into active settings, then rechecks the saved fingerprint and your current authority before local
            reconciliation.
          </p>
          <dl class="flags-facts">
            <div>
              <dt>Reviewed policy</dt>
              <dd>LDAP Debug {{ onOff(workspace!.saved.policy.ldapdebug) }} · SQL Query Logging {{ onOff(workspace!.saved.policy.sqllog) }}</dd>
            </div>
            <div>
              <dt>Current process</dt>
              <dd>LDAP Debug {{ onOff(workspace!.process.policy.ldapdebug) }} · SQL Query Logging {{ onOff(workspace!.process.policy.sqllog) }}</dd>
            </div>
          </dl>
          <v-checkbox
            v-model="riskAcknowledged"
            label="I reviewed this policy and want to promote and reconcile this process now."
            hide-details
            :disabled="busy"
          />
        </template>
        <v-alert v-if="reviewError" type="error" variant="tonal" class="mt-5">{{ reviewError }}</v-alert>
        <v-card-actions class="px-0 pt-5">
          <v-spacer />
          <v-btn :disabled="busy" @click="closeReview">Cancel</v-btn>
          <v-btn color="primary" :loading="busy" :disabled="!reviewReady" @click="confirmReview">
            {{ reviewKind === 'save' ? 'Save policy' : 'Promote and apply policy' }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="discardOpen" max-width="460" aria-labelledby="developer-flags-discard-title">
      <v-card class="pa-6">
        <h2 id="developer-flags-discard-title">Discard this diagnostic draft?</h2>
        <p class="mt-4">The saved policy and any process application are unchanged. Your pending draft and reason will be discarded.</p>
        <v-card-actions class="px-0 pt-5">
          <v-btn @click="keepEditing">Keep editing</v-btn>
          <v-spacer />
          <v-btn color="primary" @click="discardDraft">Discard draft</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
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

const sections = [
  { key: 'overview', title: 'Overview' },
  { key: 'controls', title: 'Controls' },
  { key: 'history', title: 'History' }
] as const
const FLAG_LABEL: Record<DeveloperFlagKey, string> = {
  ldapdebug: 'LDAP Debug',
  sqllog: 'SQL Query Logging'
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
const discardOpen = ref(false)
const reviewKind = ref<'save' | 'apply'>('save')
const reviewPolicy = shallowRef<DeveloperFlags | null>(null)
const reviewFingerprint = ref('')
const riskAcknowledged = ref(false)
const reviewError = ref('')
const pendingAction = shallowRef<(() => void) | null>(null)

let disposed = false
const savedSource = computed(() =>
  workspace.value?.saved.source === 'reviewed-administration'
    ? 'Reviewed administration record'
    : workspace.value?.saved.source === 'database'
      ? 'Promoted database setting'
      : 'Effective deployment configuration'
)
let generation = 0
let allowLeave = false

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
    ? 'The save response was not confirmed. Do not submit the draft again until you read the saved state.'
    : recoveryKind.value === 'apply'
      ? 'The application response was not confirmed. Read the saved policy and process observation instead of applying again.'
      : 'The prior action was confirmed, but the refreshed state could not be read. Reload before another action.'
)

function samePolicy(left: DeveloperFlags, right: DeveloperFlags) {
  return left.ldapdebug === right.ldapdebug && left.sqllog === right.sqllog
}

function copyPolicy(value: DeveloperFlags): DeveloperFlags {
  return { ldapdebug: value.ldapdebug, sqllog: value.sqllog }
}

function onOff(value: boolean) {
  return value ? 'Enabled' : 'Off'
}

function flagLabel(value: DeveloperFlagKey) {
  return FLAG_LABEL[value]
}

function actor(value: DeveloperFlagEvent) {
  return value.apiKeyId ? `API credential ${value.apiKeyId}` : value.actorId ? `User ${value.actorId}` : 'Unknown principal'
}

function date(value: string) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? 'Unknown time' : parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
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
      notice.value = 'Saved state was reloaded. Review the retained draft again before saving.'
    } else {
      resetDraft()
    }
    stale.value = false
    recoveryKind.value = ''
    return true
  } catch (cause) {
    if (!disposed && token === generation) error.value = cause instanceof Error ? cause.message : 'Developer flags could not be loaded.'
    return false
  } finally {
    if (!disposed && token === generation) loading.value = false
  }
}

function guarded(action: () => void) {
  if (dirty.value) {
    pendingAction.value = action
    discardOpen.value = true
  } else {
    action()
  }
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
      await confirmedRefresh('Developer flag policy saved. Review the saved policy before applying it to the process.')
    } else {
      const result = await applyDeveloperFlags(reviewFingerprint.value)
      reviewOpen.value = false
      if (result.applied) {
        await confirmedRefresh(
          result.published
            ? 'Saved policy applied to this process and a peer reload was published.'
            : 'Saved policy applied to this process. Peer reload publication was not confirmed.'
        )
      } else {
        notice.value = 'Saved policy was not applied to this process. Read the current observation before another application.'
        unexpectedOutcome('refresh')
      }
    }
  } catch (cause) {
    const status = cause && typeof cause === 'object' ? Reflect.get(cause, 'status') : undefined
    reviewError.value = cause instanceof Error ? cause.message : 'The action outcome could not be confirmed.'
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

function keepEditing() {
  discardOpen.value = false
  pendingAction.value = null
}

function discardDraft() {
  resetDraft()
  discardOpen.value = false
  const action = pendingAction.value
  pendingAction.value = null
  action?.()
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value || busy.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}

onBeforeRouteLeave((to) => {
  if (allowLeave) return true
  if (busy.value) return false
  if (!dirty.value) return true
  pendingAction.value = () => {
    allowLeave = true
    void router.push(to.fullPath)
  }
  discardOpen.value = true
  return false
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
