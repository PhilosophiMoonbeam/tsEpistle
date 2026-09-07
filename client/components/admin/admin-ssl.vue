<template>
  <div class="tls-workspace">
    <div :inert="dialog || leaveDialog || undefined">
      <header class="tls-hero">
        <div>
          <p class="tls-eyebrow">Workspace controls / Infrastructure</p>
          <h1>HTTPS &amp; certificates</h1>
          <p class="tls-intro">Know where encryption begins. Keep every connection and certificate change accountable.</p>
        </div>
        <v-btn variant="outlined" prepend-icon="mdi-refresh" :loading="loading" :disabled="busy" @click="refresh">Refresh evidence</v-btn>
      </header>
      <v-alert v-if="error" type="error" variant="tonal" class="mb-4" role="alert">{{ error }}</v-alert>
      <v-alert v-if="notice" type="info" variant="tonal" class="mb-4" role="status">{{ notice }}</v-alert>
      <div v-if="!workspace" class="tls-empty">
        <v-progress-circular v-if="loading" indeterminate aria-label="Loading HTTPS workspace" />
        <h2>{{ loading ? 'Reading the connection landscape…' : 'HTTPS evidence is unavailable' }}</h2>
        <p>Certificate and policy information appears after the workspace loads.</p>
      </div>
      <template v-else>
        <div class="tls-summary">
          <div>
            <span>Public address</span>
            <strong>{{ workspace.publicUrl || 'Not configured' }}</strong>
          </div>
          <div>
            <span>Encryption boundary</span>
            <strong>{{ boundary }}</strong>
          </div>
          <div>
            <span>Redirect policy</span>
            <strong>
              {{ workspace.redirection.enabled ? 'Enabled' : 'Disabled' }}
              <small>{{ workspace.runtimeRedirection.settingsCurrent ? '· applied' : '· process differs' }}</small>
            </strong>
          </div>
        </div>
        <nav class="tls-nav" aria-label="HTTPS workspace sections">
          <button v-for="item in sections" :key="item.id" :aria-current="section === item.id ? 'page' : undefined" @click="selectSection(item.id)">
            <span>{{ item.number }}</span>
            {{ item.label }}
          </button>
        </nav>
        <section v-if="section === 'connections'" aria-labelledby="tls-connections">
          <div class="tls-section-heading">
            <div>
              <p class="tls-eyebrow">01 / Connection path</p>
              <h2 id="tls-connections">Follow the encrypted connection.</h2>
              <p>Public HTTPS and the application listener are independent observations.</p>
            </div>
            <v-btn color="primary" :disabled="locked || workspace.offline" @click="runCheck('public-check')">Check public HTTPS</v-btn>
          </div>
          <div class="tls-path">
            <div>
              <span class="tls-step">01</span>
              <h3>Public endpoint</h3>
              <p class="tls-mono">{{ workspace.publicUrl }}</p>
              <p>{{ publicCheck ? publicCheck.summary : 'No handshake has been recorded.' }}</p>
            </div>
            <div>
              <span class="tls-step">02</span>
              <h3>{{ workspace.redirection.trustedProxy ? 'Trusted reverse proxy' : 'Direct ingress' }}</h3>
              <p>
                {{
                  workspace.redirection.trustedProxy
                    ? 'Forwarded connection information is trusted by this process.'
                    : 'Forwarded HTTPS claims are not trusted.'
                }}
              </p>
              <router-link to="/security">
                Review proxy trust
                <v-icon size="16">mdi-arrow-top-right</v-icon>
              </router-link>
            </div>
            <div>
              <span class="tls-step">03</span>
              <h3>Application listeners</h3>
              <p>
                HTTP
                <strong>{{ port(workspace.listeners.httpPort) }}</strong>
              </p>
              <p>
                HTTPS
                <strong>{{ port(workspace.listeners.httpsPort) }}</strong>
              </p>
              <v-btn size="small" variant="outlined" :disabled="locked || !workspace.listeners.httpsPort" @click="runCheck('native-check')">
                Check native HTTPS
              </v-btn>
            </div>
          </div>
          <div class="tls-columns">
            <article class="tls-panel">
              <p class="tls-eyebrow">Public observation</p>
              <h3>{{ publicConnection ? (publicConnection.connected ? 'Handshake observed' : 'Connection unsuccessful') : 'Awaiting a check' }}</h3>
              <template v-if="publicConnection">
                <dl class="tls-facts">
                  <div>
                    <dt>Certificate trust</dt>
                    <dd>{{ verdict(publicConnection.trusted) }}</dd>
                  </div>
                  <div>
                    <dt>Hostname match</dt>
                    <dd>{{ verdict(publicConnection.hostnameMatches) }}</dd>
                  </div>
                  <div>
                    <dt>Protocol / cipher</dt>
                    <dd>{{ publicConnection.protocol || 'Unknown' }} / {{ publicConnection.cipher || 'Unknown' }}</dd>
                  </div>
                  <div>
                    <dt>Observed</dt>
                    <dd>{{ date(publicConnection.observedAt) }}</dd>
                  </div>
                  <div>
                    <dt>Certificate expires</dt>
                    <dd>{{ publicConnection.certificate ? date(publicConnection.certificate.validUntil) : 'Not observed' }}</dd>
                  </div>
                </dl>
                <v-btn variant="text" @click="openReceipt(publicCheck!)">Inspect receipt &amp; chain</v-btn>
              </template>
              <p v-else>
                A check opens a TLS handshake from the wiki server. It sends no page request and does not measure every user's network path.
              </p>
            </article>
            <aside class="tls-panel tls-aside">
              <p class="tls-eyebrow">Deployment context</p>
              <h3>{{ workspace.listeners.httpsPort ? 'Native TLS is running' : 'The application serves HTTP' }}</h3>
              <p>
                {{
                  workspace.listeners.httpsPort
                    ? 'The native certificate can be inspected separately from any certificate presented by a proxy.'
                    : 'A reverse proxy can provide public HTTPS while this process serves HTTP. Native TLS being disabled does not mean the public site is unencrypted.'
                }}
              </p>
              <p>Listener ports, provider and certificate sources come from deployment configuration. Proxy certificates are managed by the proxy.</p>
              <p v-if="workspace.offline">External checks and certificate issuance are paused by offline mode.</p>
              <router-link to="/general">
                Review public address
                <v-icon size="16">mdi-arrow-top-right</v-icon>
              </router-link>
            </aside>
          </div>
        </section>
        <section v-else-if="section === 'certificates'" aria-labelledby="tls-certificates">
          <div class="tls-section-heading">
            <div>
              <p class="tls-eyebrow">02 / Certificate lifecycle</p>
              <h2 id="tls-certificates">Validate. Review. Put into service.</h2>
              <p>A saved certificate becomes active only when it is applied to the native listener.</p>
            </div>
          </div>
          <div class="tls-certificate-strip">
            <div>
              <span>Provider</span>
              <strong>{{ workspace.deployment.provider || 'No native provider' }}</strong>
            </div>
            <div>
              <span>Material</span>
              <strong>{{ (workspace.deployment.format || 'PEM').toUpperCase() }} · {{ workspace.deployment.source }}</strong>
            </div>
            <div>
              <span>Domain</span>
              <strong>{{ workspace.deployment.domain || 'Not configured' }}</strong>
            </div>
          </div>
          <div class="tls-columns">
            <article class="tls-panel">
              <p class="tls-eyebrow">In service / native listener</p>
              <h3>{{ workspace.listeners.material?.certificate?.subject || 'No native certificate is active' }}</h3>
              <dl v-if="workspace.listeners.material" class="tls-facts">
                <div>
                  <dt>Applied</dt>
                  <dd>{{ date(workspace.listeners.material.appliedAt) }}</dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>
                    {{
                      workspace.listeners.material.certificate
                        ? date(workspace.listeners.material.certificate.validUntil)
                        : 'Run a native handshake to inspect'
                    }}
                  </dd>
                </div>
                <div>
                  <dt>Replacement method</dt>
                  <dd>
                    {{
                      workspace.listeners.replacementMode === 'listener-restart' ? 'Listener restart · connections interrupted' : 'TLS context reload'
                    }}
                  </dd>
                </div>
              </dl>
              <p v-else>Public HTTPS may be supplied by a reverse proxy. Its certificate cannot be replaced here.</p>
            </article>
            <article class="tls-panel">
              <p class="tls-eyebrow">Saved / certificate authority</p>
              <h3>{{ workspace.savedCertificate?.subject || 'No saved ACME certificate' }}</h3>
              <p v-if="workspace.savedCertificate">
                {{ workspace.savedCertificate.validity }} · expires {{ date(workspace.savedCertificate.validUntil) }}
              </p>
              <p v-if="workspace.savedCertificateIssue">{{ workspace.savedCertificateIssue }}</p>
              <p>Issuance saves the new material. It does not replace the running listener.</p>
              <v-btn
                variant="outlined"
                :disabled="locked || workspace.offline || !workspace.deployment.enabled || workspace.deployment.provider !== 'letsencrypt'"
                @click="review('renew-certificate')"
              >
                Review certificate issuance
              </v-btn>
            </article>
          </div>
          <article class="tls-panel tls-validation">
            <div>
              <p class="tls-eyebrow">Replacement readiness</p>
              <h3>{{ materialCheck?.state === 'succeeded' ? 'Material validated' : 'Validate the configured material' }}</h3>
              <p>
                {{
                  materialCheck?.summary ||
                  'Check the certificate, private key and validity without changing the listener. File paths and private material stay on the server.'
                }}
              </p>
              <p v-if="materialCheck?.result?.material">
                {{ materialCheck.result.material.certificate.subject }} · expires {{ date(materialCheck.result.material.certificate.validUntil) }}
              </p>
            </div>
            <div class="tls-actions">
              <v-btn variant="outlined" :disabled="locked || !workspace.deployment.enabled" @click="runCheck('validate-material')">
                Validate material
              </v-btn>
              <v-btn
                color="primary"
                :disabled="locked || !workspace.listeners.httpsPort || materialCheck?.state !== 'succeeded'"
                @click="review('apply-certificate')"
              >
                Review replacement
              </v-btn>
            </div>
          </article>
          <p class="tls-footnote">
            Let’s Encrypt requires a reachable HTTP challenge endpoint for the configured domain. Startup checks renew certificates within five days
            of expiry; there is no periodic renewal scheduler. Monitor expiry and request renewal when needed.
          </p>
        </section>
        <section v-else-if="section === 'policy'" aria-labelledby="tls-policy">
          <div class="tls-section-heading">
            <div>
              <p class="tls-eyebrow">03 / Redirect policy</p>
              <h2 id="tls-policy">Make the secure route the default.</h2>
              <p>Review the destination and trust boundary before redirecting HTTP traffic.</p>
            </div>
          </div>
          <div class="tls-columns">
            <article class="tls-panel">
              <h3>HTTP → HTTPS</h3>
              <v-switch
                v-model="draftEnabled"
                label="Redirect HTTP requests to the public HTTPS address"
                color="primary"
                hide-details
                :disabled="busy || unconfirmedPolicy"
              />
              <dl class="tls-facts">
                <div>
                  <dt>Destination</dt>
                  <dd>{{ workspace.publicUrl }}</dd>
                </div>
                <div>
                  <dt>Saved policy</dt>
                  <dd>{{ workspace.redirection.enabled ? 'Enabled' : 'Disabled' }}</dd>
                </div>
                <div>
                  <dt>Running process</dt>
                  <dd>{{ workspace.runtimeRedirection.enabled ? 'Enabled' : 'Disabled' }}</dd>
                </div>
                <div>
                  <dt>Eligible route</dt>
                  <dd>{{ workspace.redirection.eligible ? 'Available' : workspace.redirection.reason }}</dd>
                </div>
              </dl>
              <v-textarea
                v-model="policyReason"
                label="Reason for this policy change"
                rows="2"
                counter="1000"
                maxlength="1000"
                :disabled="busy || unconfirmedPolicy"
              />
              <v-btn v-if="!workspace.runtimeRedirection.settingsCurrent" variant="outlined" :disabled="locked" @click="review('apply-policy')">
                Review saved policy application
              </v-btn>
            </article>
            <aside class="tls-panel tls-aside">
              <h3>Verify before redirecting</h3>
              <p>
                Enabling requires a successful public check from the last 15 minutes for the current settings: trusted certificate, matching hostname
                and valid dates.
              </p>
              <p>{{ workspace.redirection.reason || 'The deployment has a supported HTTPS route.' }}</p>
              <v-btn variant="outlined" :disabled="locked || workspace.offline" @click="runCheck('public-check')">Check public HTTPS</v-btn>
              <p>
                Trusted proxy requests already marked HTTPS pass through without a redirect loop. Disabling remains available if the destination needs
                repair.
              </p>
              <div class="tls-actions">
                <router-link to="/general">Public address</router-link>
                <router-link to="/security">Proxy trust</router-link>
              </div>
            </aside>
          </div>
          <div v-if="dirty" class="tls-savebar">
            <span>Unsaved redirect policy</span>
            <div class="tls-actions">
              <v-btn variant="text" :disabled="busy" @click="resetDraft">Reset</v-btn>
              <v-btn
                color="primary"
                :disabled="busy || unconfirmedPolicy || policyReason.trim().length < 3 || (draftEnabled && !workspace.redirection.eligible)"
                @click="review('save-policy')"
              >
                Review policy
              </v-btn>
            </div>
          </div>
          <article class="tls-panel mt-5">
            <h3>Policy history</h3>
            <p v-if="!workspace.history.length">No policy changes have been recorded.</p>
            <ol v-else class="tls-history">
              <li v-for="event in workspace.history" :key="event.id">
                <div>
                  <strong>{{ event.enabled ? 'Redirection enabled' : 'Redirection disabled' }}</strong>
                  <p>{{ event.reason }}</p>
                </div>
                <span>{{ date(event.createdAt) }} · {{ actor(event) }}</span>
              </li>
            </ol>
          </article>
        </section>
        <section v-else aria-labelledby="tls-operations">
          <div class="tls-section-heading">
            <div>
              <p class="tls-eyebrow">04 / Operation register</p>
              <h2 id="tls-operations">An inspectable record of every action.</h2>
              <p>Refresh reads existing receipts. It never repeats an issuance or replacement.</p>
            </div>
            <v-btn variant="outlined" :disabled="!workspace.operations.length" @click="exportEvidence">Export evidence</v-btn>
          </div>
          <v-alert v-if="unconfirmedId" type="warning" variant="tonal" class="mb-4">
            The response for {{ unconfirmedId }} was not confirmed.
            <v-btn variant="text" :disabled="busy" @click="recoverReceipt">Read receipt</v-btn>
          </v-alert>
          <div class="tls-register">
            <div>
              <p v-if="!workspace.operations.length" class="tls-empty">No HTTPS operations recorded yet.</p>
              <button
                v-for="operation in workspace.operations"
                :key="operation.id"
                class="tls-operation"
                :aria-pressed="selectedId === operation.id"
                @click="openReceipt(operation)"
              >
                <div>
                  <strong>{{ kindLabel(operation.kind) }}</strong>
                  <span>{{ operation.state }} · {{ date(operation.createdAt) }}</span>
                </div>
                <p>{{ operation.summary }}</p>
              </button>
            </div>
            <article class="tls-panel tls-receipt">
              <template v-if="selected">
                <p class="tls-eyebrow">{{ selected.state }} / {{ selected.phase }}</p>
                <h3>{{ kindLabel(selected.kind) }}</h3>
                <p>{{ selected.summary }}</p>
                <dl class="tls-facts">
                  <div>
                    <dt>Requested by</dt>
                    <dd>{{ actor(selected) }}</dd>
                  </div>
                  <div>
                    <dt>Reason</dt>
                    <dd>{{ selected.reason || 'Diagnostic check' }}</dd>
                  </div>
                  <div>
                    <dt>Started / completed</dt>
                    <dd>{{ date(selected.createdAt) }} / {{ selected.completedAt ? date(selected.completedAt) : 'Pending' }}</dd>
                  </div>
                  <div>
                    <dt>Receipt</dt>
                    <dd class="tls-mono">{{ selected.id }}</dd>
                  </div>
                </dl>
                <template v-if="selected.result?.connection">
                  <h4>Connection evidence</h4>
                  <p>
                    {{ selected.result.connection.endpoint.host }}:{{ selected.result.connection.endpoint.port }} ·
                    {{ selected.result.connection.protocol }}
                  </p>
                  <p>
                    Trust: {{ verdict(selected.result.connection.trusted) }} · Hostname: {{ verdict(selected.result.connection.hostnameMatches) }}
                  </p>
                </template>
                <div v-for="(cert, index) in selectedCertificates" :key="cert.fingerprint256" class="tls-chain">
                  <h4>{{ index === 0 ? 'Certificate' : 'Chain certificate ' + (index + 1) }}</h4>
                  <dl class="tls-facts">
                    <div>
                      <dt>Subject</dt>
                      <dd>{{ cert.subject }}</dd>
                    </div>
                    <div>
                      <dt>Issuer</dt>
                      <dd>{{ cert.issuer }}</dd>
                    </div>
                    <div>
                      <dt>Names</dt>
                      <dd>{{ cert.subjectAlternativeNames }}</dd>
                    </div>
                    <div>
                      <dt>Valid from / until</dt>
                      <dd>{{ date(cert.validFrom) }} / {{ date(cert.validUntil) }}</dd>
                    </div>
                    <div>
                      <dt>Key</dt>
                      <dd>{{ cert.key }}</dd>
                    </div>
                    <div>
                      <dt>SHA-256 fingerprint</dt>
                      <dd class="tls-mono">{{ cert.fingerprint256 }}</dd>
                    </div>
                  </dl>
                </div>
              </template>
              <template v-else>
                <h3>Select an operation</h3>
                <p>Inspect its outcome, attribution and public certificate evidence.</p>
              </template>
            </article>
          </div>
        </section>
        <footer class="tls-footer">
          <span>Workspace observed {{ date(workspace.observedAt) }}</span>
          <span>Certificate checks are point-in-time evidence.</span>
        </footer>
      </template>
    </div>
    <v-dialog v-model="dialog" max-width="620" :persistent="busy" aria-labelledby="tls-review-title">
      <v-card class="pa-6">
        <p class="tls-eyebrow">Review change</p>
        <h2 id="tls-review-title">{{ reviewTitle }}</h2>
        <p class="my-4">{{ reviewDescription }}</p>
        <p v-if="action === 'save-policy'">
          Destination: {{ workspace?.publicUrl }}
          <br />
          Reason: {{ policyReason }}
        </p>
        <v-textarea
          v-if="certificateMutation"
          v-model="operationReason"
          label="Reason for this certificate change"
          rows="2"
          maxlength="1000"
          counter="1000"
          :disabled="busy"
        />
        <v-checkbox
          v-if="action === 'apply-certificate' && workspace?.listeners.replacementMode === 'listener-restart'"
          v-model="restartAck"
          label="I understand that active HTTPS connections will be interrupted."
          :disabled="busy"
          hide-details
        />
        <v-checkbox
          v-if="action === 'renew-certificate'"
          v-model="issuanceAck"
          label="Request a certificate from Let’s Encrypt for the configured domain and subscriber."
          :disabled="busy"
          hide-details
        />
        <v-checkbox
          v-if="certificateMutation && uncertainMutation"
          v-model="uncertainAck"
          :label="'I reviewed the uncertain ' + kindLabel(uncertainMutation.kind).toLowerCase() + ' receipt and accept the risk of a new change.'"
          :disabled="busy"
          hide-details
        />
        <v-alert v-if="dialogError" type="error" variant="tonal" class="my-3">{{ dialogError }}</v-alert>
        <v-card-actions class="px-0 pt-5">
          <v-spacer />
          <v-btn :disabled="busy" @click="closeReview">Cancel</v-btn>
          <v-btn color="primary" variant="flat" :loading="busy" :disabled="!reviewReady" @click="confirmReview">
            {{ action === 'renew-certificate' ? 'Request certificate' : action === 'apply-certificate' ? 'Apply certificate' : 'Apply policy' }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog v-model="leaveDialog" max-width="460" aria-labelledby="tls-leave-title">
      <v-card class="pa-6">
        <h2 id="tls-leave-title">Leave unsaved policy?</h2>
        <p class="my-4">Your redirect policy draft will be discarded. Recorded operations continue on the server.</p>
        <v-card-actions>
          <v-btn @click="stay">Keep editing</v-btn>
          <v-btn color="primary" @click="leave">Discard draft</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import type { TlsOperation, TlsOperationKind, TlsWorkspace } from '../../../shared/tls-workspace.ts'
import { applyTlsPolicy, fetchTlsOperation, fetchTlsWorkspace, saveTlsPolicy, startTlsOperation } from '../../helpers/tls-workspace-api.ts'
const route = useRoute(),
  router = useRouter()
const sections = [
  { id: 'connections', number: '01', label: 'Connections' },
  { id: 'certificates', number: '02', label: 'Certificates' },
  { id: 'policy', number: '03', label: 'Redirect policy' },
  { id: 'operations', number: '04', label: 'Operations' }
]
const section = computed(() => (sections.some((item) => item.id === route.query.section) ? String(route.query.section) : 'connections'))
const workspace = ref<TlsWorkspace | null>(null),
  loading = ref(false),
  busy = ref(false),
  error = ref(''),
  notice = ref('')
const draftEnabled = ref(false),
  policyReason = ref(''),
  draftFingerprint = ref(''),
  unconfirmedPolicy = ref(false),
  unconfirmedId = ref('')
const dialog = ref(false),
  dialogError = ref(''),
  action = ref<TlsOperationKind | 'save-policy' | 'apply-policy'>('save-policy'),
  reviewFingerprint = ref('')
const operationReason = ref(''),
  restartAck = ref(false),
  issuanceAck = ref(false),
  uncertainAck = ref(false)
const selectedId = computed(() => (typeof route.query.receipt === 'string' ? route.query.receipt : ''))
const selected = computed(() => workspace.value?.operations.find((item) => item.id === selectedId.value))
const dirty = computed(() => !!workspace.value && draftEnabled.value !== workspace.value.redirection.enabled)
const running = computed(() => workspace.value?.operations.some((item) => item.state === 'running'))
const locked = computed(() => busy.value || loading.value || !!running.value || !!unconfirmedId.value || unconfirmedPolicy.value)
const latest = (kind: TlsOperationKind) => workspace.value?.operations.find((item) => item.kind === kind)
const publicCheck = computed(() => latest('public-check')),
  publicConnection = computed(() => publicCheck.value?.result?.connection)
const materialCheck = computed(() => latest('validate-material'))
const uncertainMutation = computed(() => {
  const last = workspace.value?.operations.find((item) => ['apply-certificate', 'renew-certificate'].includes(item.kind))
  return last?.state === 'uncertain' ? last : null
})
const certificateMutation = computed(() => action.value === 'apply-certificate' || action.value === 'renew-certificate')
const boundary = computed(() =>
  workspace.value?.redirection.trustedProxy
    ? 'Reverse proxy'
    : workspace.value?.listeners.httpsPort
      ? 'Native HTTPS'
      : 'External ingress · unverified'
)
const selectedCertificates = computed(() => {
  const result = selected.value?.result
  return result?.connection?.chain.length
    ? result.connection.chain
    : result?.material
      ? [result.material.certificate]
      : result?.applied?.certificate
        ? [result.applied.certificate]
        : []
})
const kindLabel = (kind: string) =>
  ({
    'public-check': 'Public HTTPS check',
    'native-check': 'Native HTTPS check',
    'validate-material': 'Material validation',
    'apply-certificate': 'Certificate replacement',
    'renew-certificate': 'Certificate issuance'
  })[kind] || kind
const reviewTitle = computed(() =>
  action.value === 'save-policy'
    ? draftEnabled.value
      ? 'Enable HTTPS redirection'
      : 'Disable HTTPS redirection'
    : action.value === 'apply-policy'
      ? 'Apply the saved redirect policy'
      : kindLabel(action.value)
)
const reviewDescription = computed(() =>
  action.value === 'renew-certificate'
    ? `Request and save a certificate for ${workspace.value?.deployment.domain || 'the configured domain'} using ${workspace.value?.deployment.subscriberEmail || 'the configured subscriber'}. Issuance contacts the certificate authority and may be subject to its limits. Validate and apply the result separately.`
    : action.value === 'apply-certificate'
      ? 'Replace the native listener certificate with the material you validated. Changed files or settings require a new validation. Verify the native handshake after replacement.'
      : 'Apply this redirect policy to the running process. Public address and proxy trust settings must match their saved values.'
)
const reviewReady = computed(
  () =>
    !busy.value &&
    (!certificateMutation.value || operationReason.value.trim().length >= 3) &&
    (action.value !== 'renew-certificate' || issuanceAck.value) &&
    (action.value !== 'apply-certificate' || workspace.value?.listeners.replacementMode !== 'listener-restart' || restartAck.value) &&
    (!certificateMutation.value || !uncertainMutation.value || uncertainAck.value)
)
const date = (value: string) => {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? 'Unknown' : parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
const actor = (value: { actorId: number | null; apiKeyId: number | null }) =>
  value.apiKeyId ? `API key ${value.apiKeyId}` : value.actorId ? `User ${value.actorId}` : 'System'
const port = (value: number | null) => (value ? `Port ${value}` : 'Not running')
const verdict = (value: boolean | null) => (value === null ? 'Not observed' : value ? 'Verified' : 'Not verified')
const message = (value: unknown) => (value instanceof Error ? value.message : 'The request could not be confirmed.')
let disposed = false,
  generation = 0,
  poll: ReturnType<typeof setTimeout> | undefined
const selectSection = (value: string) => router.replace({ query: { ...route.query, section: value } })
const openReceipt = (value: TlsOperation) => router.replace({ query: { ...route.query, section: 'operations', receipt: value.id } })
const resetDraft = () => {
  draftEnabled.value = workspace.value?.redirection.enabled || false
  draftFingerprint.value = workspace.value?.fingerprint || ''
  policyReason.value = ''
}
const refresh = async () => {
  const token = ++generation
  loading.value = true
  error.value = ''
  const preserve = dirty.value
  try {
    const value = await fetchTlsWorkspace()
    if (disposed || token !== generation) return
    workspace.value = value
    draftFingerprint.value = value.fingerprint
    if (!preserve || unconfirmedPolicy.value) resetDraft()
    unconfirmedPolicy.value = false
    if (unconfirmedId.value && value.operations.some((item) => item.id === unconfirmedId.value)) unconfirmedId.value = ''
    if (selectedId.value && !value.operations.some((item) => item.id === selectedId.value)) {
      const receipt = await fetchTlsOperation(selectedId.value)
      if (!disposed && token === generation) workspace.value = { ...value, operations: [...value.operations, receipt] }
    }
  } catch (cause) {
    if (!disposed && token === generation) error.value = message(cause)
  } finally {
    if (!disposed && token === generation) {
      loading.value = false
      schedulePoll()
    }
  }
}
const schedulePoll = () => {
  clearTimeout(poll)
  if (running.value && !disposed)
    poll = setTimeout(() => {
      if (!busy.value && !dialog.value) void refresh()
      else schedulePoll()
    }, 2500)
}
const mergeReceipt = (value: TlsOperation) => {
  if (workspace.value)
    workspace.value = { ...workspace.value, operations: [value, ...workspace.value.operations.filter((item) => item.id !== value.id)] }
}
const recoverReceipt = async () => {
  if (!unconfirmedId.value) return
  busy.value = true
  error.value = ''
  try {
    const value = await fetchTlsOperation(unconfirmedId.value)
    if (disposed) return
    mergeReceipt(value)
    unconfirmedId.value = ''
    await openReceipt(value)
  } catch (cause) {
    if (!disposed) error.value = message(cause)
  } finally {
    if (!disposed) {
      busy.value = false
      schedulePoll()
    }
  }
}
const submitOperation = async (kind: TlsOperationKind, fingerprint: string) => {
  const id = crypto.randomUUID()
  unconfirmedId.value = id
  try {
    const value = await startTlsOperation({
      id,
      kind,
      fingerprint,
      ...(certificateMutation.value && dialog.value
        ? {
            reason: operationReason.value.trim(),
            allowRestart: restartAck.value,
            confirmIssuance: issuanceAck.value,
            ...(kind === 'apply-certificate' ? { materialCheckId: materialCheck.value?.id } : {}),
            ...(uncertainAck.value && uncertainMutation.value ? { acknowledgedUncertainId: uncertainMutation.value.id } : {})
          }
        : {})
    })
    if (disposed) return
    mergeReceipt(value)
    unconfirmedId.value = ''
    dialog.value = false
    await openReceipt(value)
    schedulePoll()
  } catch (cause) {
    const status = (cause as { status?: number }).status
    if (status && [400, 403, 409].includes(status)) unconfirmedId.value = ''
    throw cause
  }
}
const runCheck = async (kind: TlsOperationKind) => {
  if (!workspace.value || locked.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await submitOperation(kind, workspace.value.fingerprint)
  } catch (cause) {
    error.value = message(cause)
    if (unconfirmedId.value) await selectSection('operations')
  } finally {
    busy.value = false
    schedulePoll()
  }
}
const review = (value: typeof action.value) => {
  action.value = value
  reviewFingerprint.value = value === 'save-policy' ? draftFingerprint.value : workspace.value?.fingerprint || ''
  operationReason.value = ''
  restartAck.value = false
  issuanceAck.value = false
  uncertainAck.value = false
  dialogError.value = ''
  dialog.value = true
}
const closeReview = () => {
  dialog.value = false
}
const confirmReview = async () => {
  if (!workspace.value || !reviewReady.value) return
  busy.value = true
  dialogError.value = ''
  error.value = ''
  notice.value = ''
  try {
    if (certificateMutation.value) await submitOperation(action.value as TlsOperationKind, reviewFingerprint.value)
    else {
      unconfirmedPolicy.value = true
      const result =
        action.value === 'save-policy'
          ? await saveTlsPolicy({
              fingerprint: reviewFingerprint.value,
              enabled: draftEnabled.value,
              reason: policyReason.value.trim(),
              ...(draftEnabled.value ? { verifiedCheckId: publicCheck.value?.id } : {})
            })
          : await applyTlsPolicy(reviewFingerprint.value)
      notice.value = result.applied
        ? 'Redirect policy saved and applied to this process.'
        : 'Policy is saved. Reconcile public address and proxy trust before applying it.'
      dialog.value = false
      await refresh()
    }
  } catch (cause) {
    if (certificateMutation.value && unconfirmedId.value) {
      dialog.value = false
      error.value = message(cause)
      await selectSection('operations')
    } else {
      dialogError.value = message(cause)
      const status = (cause as { status?: number }).status
      if (status && [400, 403, 409].includes(status)) unconfirmedPolicy.value = false
      else if (!certificateMutation.value) {
        dialog.value = false
        error.value = message(cause) + ' Refresh evidence to recover the saved policy.'
      }
    }
  } finally {
    busy.value = false
    schedulePoll()
  }
}
const exportEvidence = () => {
  if (!workspace.value) return
  const url = URL.createObjectURL(new Blob([JSON.stringify(workspace.value, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'https-evidence.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
const leaveDialog = ref(false)
let resolveLeave: ((value: boolean) => void) | undefined
watch(leaveDialog, (value) => {
  if (!value) {
    resolveLeave?.(false)
    resolveLeave = undefined
  }
})
const stay = () => {
  leaveDialog.value = false
  resolveLeave?.(false)
  resolveLeave = undefined
}
const leave = () => {
  leaveDialog.value = false
  resolveLeave?.(true)
  resolveLeave = undefined
}
onBeforeRouteLeave(() => {
  if (busy.value) return false
  if (!dirty.value) return true
  leaveDialog.value = true
  return new Promise<boolean>((resolve) => {
    resolveLeave = resolve
  })
})
const beforeUnload = (event: BeforeUnloadEvent) => {
  if (dirty.value || busy.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}
onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload)
  void refresh()
})
onBeforeUnmount(() => {
  disposed = true
  generation++
  clearTimeout(poll)
  window.removeEventListener('beforeunload', beforeUnload)
  resolveLeave?.(false)
})
</script>
<style lang="scss" src="./tls-workspace.scss"></style>
