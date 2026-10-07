<template>
  <div class="tls-workspace">
    <div :inert="dialog || undefined">
      <admin-hero
        :title="$t('admin:ssl.httpsCertificates')"
        :description="$t('admin:ssl.knowWhereEncryptionBegins')"
        :eyebrow="$t('admin:ssl.operations')"
        icon="mdi-certificate-outline"
      >
        <template #actions>
          <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" :disabled="busy" @click="refresh">{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ $t('admin:ssl.reloadCertificateEvidence') }}</v-tooltip></v-btn>
        </template>
      </admin-hero>
      <v-alert v-if="error" type="error" variant="tonal" class="mb-4" role="alert">{{ error }}</v-alert>
      <v-alert v-if="notice" type="info" variant="tonal" class="mb-4" role="status">{{ notice }}</v-alert>
      <div v-if="!workspace" class="tls-empty">
        <v-progress-circular v-if="loading" indeterminate :aria-label="$t('admin:ssl.loadingHttpsWorkspace')" />
        <h2>{{ loading ? $t('admin:ssl.readingConnectionLandscape') : $t('admin:ssl.httpsEvidenceUnavailable') }}</h2>
        <p>{{ $t('admin:ssl.certificatePolicyInformationAppears') }}</p>
      </div>
      <template v-else>
        <div class="tls-summary">
          <div>
            <span>{{ $t('admin:ssl.publicAddress') }}</span>
            <strong>{{ workspace.publicUrl || $t('admin:ssl.notConfigured') }}</strong>
          </div>
          <div>
            <span>{{ $t('admin:ssl.encryptionBoundary') }}</span>
            <strong>{{ boundary }}</strong>
          </div>
          <div>
            <span>{{ $t('admin:ssl.redirectPolicy') }}</span>
            <strong>
              {{ workspace.redirection.enabled ? $t('admin:ssl.enabled') : $t('admin:ssl.providerDisabled') }}
              <small>{{ workspace.runtimeRedirection.settingsCurrent ? $t('admin:ssl.applied') : $t('admin:ssl.processDiffers') }}</small>
            </strong>
          </div>
        </div>
        <nav class="tls-nav" :aria-label="$t('admin:ssl.httpsWorkspaceSections')">
          <button v-for="item in sections" :key="item.id" :aria-current="section === item.id ? 'page' : undefined" @click="selectSection(item.id)">
            <span>{{ item.number }}</span>
            {{ item.label }}
          </button>
        </nav>
        <section v-if="section === 'connections'" aria-labelledby="tls-connections">
          <div class="tls-section-heading">
            <div>
              <p class="tls-eyebrow">{{ $t('admin:ssl.n01ConnectionPath') }}</p>
              <h2 id="tls-connections">{{ $t('admin:ssl.followEncryptedConnection') }}</h2>
              <p>{{ $t('admin:ssl.publicHttpsApplicationListener') }}</p>
            </div>
            <v-btn color="primary" :disabled="locked || workspace.offline" @click="runCheck('public-check')">{{ $t('admin:ssl.checkPublicHttps') }}</v-btn>
          </div>
          <div class="tls-path">
            <div>
              <span class="tls-step">01</span>
              <h3>{{ $t('admin:ssl.publicEndpoint') }}</h3>
              <p class="tls-mono">{{ workspace.publicUrl }}</p>
              <p>{{ publicCheck ? publicCheck.summary : $t('admin:ssl.noHandshakeHasBeen') }}</p>
            </div>
            <div>
              <span class="tls-step">02</span>
              <h3>{{ workspace.redirection.trustedProxy ? $t('admin:ssl.trustedReverseProxy') : $t('admin:ssl.directIngress') }}</h3>
              <p>
                {{
                  workspace.redirection.trustedProxy
                    ? $t('admin:ssl.forwardedConnectionInformationTrusted')
                    : $t('admin:ssl.forwardedHttpsClaimsNot')
                }}
              </p>
              <router-link to="/security">
                {{ $t('admin:ssl.reviewProxyTrust') }}
                <v-icon size="16">mdi-arrow-top-right</v-icon>
              </router-link>
            </div>
            <div>
              <span class="tls-step">03</span>
              <h3>{{ $t('admin:ssl.applicationListeners') }}</h3>
              <p>
                {{ $t('admin:ssl.http') }}
                <strong>{{ port(workspace.listeners.httpPort) }}</strong>
              </p>
              <p>
                {{ $t('admin:ssl.https') }}
                <strong>{{ port(workspace.listeners.httpsPort) }}</strong>
              </p>
              <v-btn size="small" variant="outlined" :disabled="locked || !workspace.listeners.httpsPort" @click="runCheck('native-check')">
                {{ $t('admin:ssl.checkNativeHttps') }}
              </v-btn>
            </div>
          </div>
          <div class="tls-columns">
            <article class="tls-panel">
              <p class="tls-eyebrow">{{ $t('admin:ssl.publicObservation') }}</p>
              <h3>{{ publicConnection ? (publicConnection.connected ? $t('admin:ssl.handshakeObserved') : $t('admin:ssl.connectionUnsuccessful')) : $t('admin:ssl.awaitingCheck') }}</h3>
              <template v-if="publicConnection">
                <dl class="tls-facts">
                  <div>
                    <dt>{{ $t('admin:ssl.certificateTrust') }}</dt>
                    <dd>{{ verdict(publicConnection.trusted) }}</dd>
                  </div>
                  <div>
                    <dt>{{ $t('admin:ssl.hostnameMatch') }}</dt>
                    <dd>{{ verdict(publicConnection.hostnameMatches) }}</dd>
                  </div>
                  <div>
                    <dt>{{ $t('admin:ssl.protocolCipher') }}</dt>
                    <dd>{{ publicConnection.protocol || $t('admin:ssl.unknown') }} / {{ publicConnection.cipher || $t('admin:ssl.unknown') }}</dd>
                  </div>
                  <div>
                    <dt>{{ $t('admin:ssl.observed') }}</dt>
                    <dd>{{ date(publicConnection.observedAt) }}</dd>
                  </div>
                  <div>
                    <dt>{{ $t('admin:ssl.certificateExpires') }}</dt>
                    <dd>{{ publicConnection.certificate ? date(publicConnection.certificate.validUntil) : $t('admin:ssl.notObserved') }}</dd>
                  </div>
                </dl>
                <v-btn variant="text" @click="openReceipt(publicCheck!)">{{ $t('admin:ssl.inspectReceiptChain') }}</v-btn>
              </template>
              <p v-else>
                {{ $t('admin:ssl.checkOpensTlsHandshake') }}
              </p>
            </article>
            <aside class="tls-panel tls-aside">
              <p class="tls-eyebrow">{{ $t('admin:ssl.deploymentContext') }}</p>
              <h3>{{ workspace.listeners.httpsPort ? $t('admin:ssl.nativeTlsRunning') : $t('admin:ssl.applicationServesHttp') }}</h3>
              <p>
                {{
                  workspace.listeners.httpsPort
                    ? $t('admin:ssl.nativeCertificateCanInspected')
                    : $t('admin:ssl.reverseProxyCanProvide')
                }}
              </p>
              <p>{{ $t('admin:ssl.listenerPortsProviderCertificate') }}</p>
              <p v-if="workspace.offline">{{ $t('admin:ssl.externalChecksCertificateIssuance') }}</p>
              <router-link to="/general">
                {{ $t('admin:ssl.reviewPublicAddress') }}
                <v-icon size="16">mdi-arrow-top-right</v-icon>
              </router-link>
            </aside>
          </div>
        </section>
        <section v-else-if="section === 'certificates'" aria-labelledby="tls-certificates">
          <div class="tls-section-heading">
            <div>
              <p class="tls-eyebrow">{{ $t('admin:ssl.n02CertificateLifecycle') }}</p>
              <h2 id="tls-certificates">{{ $t('admin:ssl.validateReviewPutInto') }}</h2>
              <p>{{ $t('admin:ssl.savedCertificateBecomesActive') }}</p>
            </div>
          </div>
          <div class="tls-certificate-strip">
            <div>
              <span>{{ $t('admin:ssl.provider') }}</span>
              <strong>{{ workspace.deployment.provider || $t('admin:ssl.noNativeProvider') }}</strong>
            </div>
            <div>
              <span>{{ $t('admin:ssl.material') }}</span>
              <strong>{{ (workspace.deployment.format || 'PEM').toUpperCase() }} · {{ workspace.deployment.source }}</strong>
            </div>
            <div>
              <span>{{ $t('admin:ssl.domain') }}</span>
              <strong>{{ workspace.deployment.domain || $t('admin:ssl.notConfigured') }}</strong>
            </div>
          </div>
          <div class="tls-columns">
            <article class="tls-panel">
              <p class="tls-eyebrow">{{ $t('admin:ssl.serviceNativeListener') }}</p>
              <h3>{{ workspace.listeners.material?.certificate?.subject || $t('admin:ssl.noNativeCertificateActive') }}</h3>
              <dl v-if="workspace.listeners.material" class="tls-facts">
                <div>
                  <dt>{{ $t('admin:ssl.applied2') }}</dt>
                  <dd>{{ date(workspace.listeners.material.appliedAt) }}</dd>
                </div>
                <div>
                  <dt>{{ $t('admin:ssl.expires') }}</dt>
                  <dd>
                    {{
                      workspace.listeners.material.certificate
                        ? date(workspace.listeners.material.certificate.validUntil)
                        : $t('admin:ssl.runNativeHandshakeInspect')
                    }}
                  </dd>
                </div>
                <div>
                  <dt>{{ $t('admin:ssl.replacementMethod') }}</dt>
                  <dd>
                    {{
                      workspace.listeners.replacementMode === 'listener-restart' ? $t('admin:ssl.listenerRestartConnectionsInterrupted') : $t('admin:ssl.tlsContextReload')
                    }}
                  </dd>
                </div>
              </dl>
              <p v-else>{{ $t('admin:ssl.publicHttpsMaySupplied') }}</p>
            </article>
            <article class="tls-panel">
              <p class="tls-eyebrow">{{ $t('admin:ssl.savedCertificateAuthority') }}</p>
              <h3>{{ workspace.savedCertificate?.subject || $t('admin:ssl.noSavedAcmeCertificate') }}</h3>
              <p v-if="workspace.savedCertificate">
                {{ $t('admin:ssl.expires2', { validity: workspace.savedCertificate.validity, validUntil: date(workspace.savedCertificate.validUntil), interpolation: { escapeValue: false } }) }}
              </p>
              <p v-if="workspace.savedCertificateIssue">{{ workspace.savedCertificateIssue }}</p>
              <p>{{ $t('admin:ssl.issuanceSavesNewMaterial') }}</p>
              <v-btn
                variant="outlined"
                :disabled="locked || workspace.offline || !workspace.deployment.enabled || workspace.deployment.provider !== 'letsencrypt'"
                @click="review('renew-certificate')"
              >
                {{ $t('admin:ssl.reviewCertificateIssuance') }}
              </v-btn>
            </article>
          </div>
          <article class="tls-panel tls-validation">
            <div>
              <p class="tls-eyebrow">{{ $t('admin:ssl.replacementReadiness') }}</p>
              <h3>{{ materialCheck?.state === 'succeeded' ? $t('admin:ssl.materialValidated') : $t('admin:ssl.validateConfiguredMaterial') }}</h3>
              <p>
                {{
                  materialCheck?.summary ||
                  $t('admin:ssl.checkCertificatePrivateKey')
                }}
              </p>
              <p v-if="materialCheck?.result?.material">
                {{ $t('admin:ssl.expires3', { subject: materialCheck.result.material.certificate.subject, validUntil: date(materialCheck.result.material.certificate.validUntil), interpolation: { escapeValue: false } }) }}
              </p>
            </div>
            <div class="tls-actions">
              <v-btn variant="outlined" :disabled="locked || !workspace.deployment.enabled" @click="runCheck('validate-material')">
                {{ $t('admin:ssl.validateMaterial') }}
              </v-btn>
              <v-btn
                color="primary"
                :disabled="locked || !workspace.listeners.httpsPort || materialCheck?.state !== 'succeeded'"
                @click="review('apply-certificate')"
              >
                {{ $t('admin:ssl.reviewReplacement') }}
              </v-btn>
            </div>
          </article>
          <p class="tls-footnote">
            {{ $t('admin:ssl.letsEncryptRequiresReachable') }}
          </p>
        </section>
        <section v-else-if="section === 'policy'" aria-labelledby="tls-policy">
          <div class="tls-section-heading">
            <div>
              <p class="tls-eyebrow">{{ $t('admin:ssl.n03RedirectPolicy') }}</p>
              <h2 id="tls-policy">{{ $t('admin:ssl.makeSecureRouteDefault') }}</h2>
              <p>{{ $t('admin:ssl.reviewDestinationTrustBoundary') }}</p>
            </div>
          </div>
          <div class="tls-columns">
            <article class="tls-panel">
              <h3>{{ $t('admin:ssl.httpHttps') }}</h3>
              <v-switch
                v-model="draftEnabled"
                :label="$t('admin:ssl.redirectHttpRequestsPublic')"
                color="primary"
                hide-details
                :disabled="busy || unconfirmedPolicy"
              />
              <dl class="tls-facts">
                <div>
                  <dt>{{ $t('admin:ssl.destination') }}</dt>
                  <dd>{{ workspace.publicUrl }}</dd>
                </div>
                <div>
                  <dt>{{ $t('admin:ssl.savedPolicy') }}</dt>
                  <dd>{{ workspace.redirection.enabled ? $t('admin:ssl.enabled') : $t('admin:ssl.providerDisabled') }}</dd>
                </div>
                <div>
                  <dt>{{ $t('admin:ssl.runningProcess') }}</dt>
                  <dd>{{ workspace.runtimeRedirection.enabled ? $t('admin:ssl.enabled') : $t('admin:ssl.providerDisabled') }}</dd>
                </div>
                <div>
                  <dt>{{ $t('admin:ssl.eligibleRoute') }}</dt>
                  <dd>{{ workspace.redirection.eligible ? $t('admin:ssl.available') : workspace.redirection.reason }}</dd>
                </div>
              </dl>
              <v-textarea
                v-model="policyReason"
                :label="$t('admin:ssl.reasonPolicyChange')"
                rows="2"
                counter="1000"
                maxlength="1000"
                :disabled="busy || unconfirmedPolicy"
              />
              <v-btn v-if="!workspace.runtimeRedirection.settingsCurrent" variant="outlined" :disabled="locked" @click="review('apply-policy')">
                {{ $t('admin:ssl.reviewSavedPolicyApplication') }}
              </v-btn>
            </article>
            <aside class="tls-panel tls-aside">
              <h3>{{ $t('admin:ssl.verifyBeforeRedirecting') }}</h3>
              <p>
                {{ $t('admin:ssl.enablingRequiresSuccessfulPublic') }}
              </p>
              <p>{{ workspace.redirection.reason || $t('admin:ssl.deploymentHasSupportedHttps') }}</p>
              <v-btn variant="outlined" :disabled="locked || workspace.offline" @click="runCheck('public-check')">{{ $t('admin:ssl.checkPublicHttps') }}</v-btn>
              <p>
                {{ $t('admin:ssl.trustedProxyRequestsAlready') }}
              </p>
              <div class="tls-actions">
                <router-link to="/general">{{ $t('admin:ssl.publicAddress') }}</router-link>
                <router-link to="/security">{{ $t('admin:ssl.proxyTrust') }}</router-link>
              </div>
            </aside>
          </div>
          <div v-if="dirty" class="tls-savebar">
            <span>{{ $t('admin:ssl.unsavedRedirectPolicy') }}</span>
            <div class="tls-actions">
              <v-btn variant="text" :disabled="busy" @click="resetDraft">{{ $t('admin:ssl.reset') }}</v-btn>
              <v-btn
                color="primary"
                :disabled="busy || unconfirmedPolicy || policyReason.trim().length < 3 || (draftEnabled && !workspace.redirection.eligible)"
                @click="review('save-policy')"
              >
                {{ $t('admin:ssl.reviewPolicy') }}
              </v-btn>
            </div>
          </div>
          <article class="tls-panel mt-5">
            <h3>{{ $t('admin:ssl.policyHistory') }}</h3>
            <p v-if="!workspace.history.length">{{ $t('admin:ssl.noPolicyChangesHave') }}</p>
            <ol v-else class="tls-history">
              <li v-for="event in workspace.history" :key="event.id">
                <div>
                  <strong>{{ event.enabled ? $t('admin:ssl.redirectionEnabled') : $t('admin:ssl.redirectionDisabled') }}</strong>
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
              <p class="tls-eyebrow">{{ $t('admin:ssl.n04OperationRegister') }}</p>
              <h2 id="tls-operations">{{ $t('admin:ssl.inspectableRecordEveryAction') }}</h2>
              <p>{{ $t('admin:ssl.refreshReadsExistingReceipts') }}</p>
            </div>
            <v-btn variant="outlined" :disabled="!workspace.operations.length" @click="exportEvidence">{{ $t('admin:ssl.exportEvidence') }}</v-btn>
          </div>
          <v-alert v-if="unconfirmedId" type="warning" variant="tonal" class="mb-4">
            {{ $t('admin:ssl.responseWasNotConfirmed', { unconfirmedId, interpolation: { escapeValue: false } }) }}
            <v-btn variant="text" :disabled="busy" @click="recoverReceipt">{{ $t('admin:ssl.readReceipt') }}</v-btn>
          </v-alert>
          <div class="tls-register">
            <div>
              <p v-if="!workspace.operations.length" class="tls-empty">{{ $t('admin:ssl.noHttpsOperationsRecorded') }}</p>
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
                    <dt>{{ $t('admin:ssl.requested') }}</dt>
                    <dd>{{ actor(selected) }}</dd>
                  </div>
                  <div>
                    <dt>{{ $t('admin:ssl.reason') }}</dt>
                    <dd>{{ selected.reason || $t('admin:ssl.diagnosticCheck') }}</dd>
                  </div>
                  <div>
                    <dt>{{ $t('admin:ssl.startedCompleted') }}</dt>
                    <dd>{{ date(selected.createdAt) }} / {{ selected.completedAt ? date(selected.completedAt) : $t('admin:ssl.pending') }}</dd>
                  </div>
                  <div>
                    <dt>{{ $t('admin:ssl.receipt') }}</dt>
                    <dd class="tls-mono">{{ selected.id }}</dd>
                  </div>
                </dl>
                <template v-if="selected.result?.connection">
                  <h4>{{ $t('admin:ssl.connectionEvidence') }}</h4>
                  <p>
                    {{ selected.result.connection.endpoint.host }}:{{ selected.result.connection.endpoint.port }} ·
                    {{ selected.result.connection.protocol }}
                  </p>
                  <p>
                    {{ $t('admin:ssl.trustHostname', { trusted: verdict(selected.result.connection.trusted), hostnameMatches: verdict(selected.result.connection.hostnameMatches), interpolation: { escapeValue: false } }) }}
                  </p>
                </template>
                <div v-for="(cert, index) in selectedCertificates" :key="cert.fingerprint256" class="tls-chain">
                  <h4>{{ index === 0 ? $t('admin:ssl.certificate') : $t('admin:ssl.chainCertificate', { value: (index + 1), interpolation: { escapeValue: false } }) }}</h4>
                  <dl class="tls-facts">
                    <div>
                      <dt>{{ $t('admin:ssl.subject') }}</dt>
                      <dd>{{ cert.subject }}</dd>
                    </div>
                    <div>
                      <dt>{{ $t('admin:ssl.issuer') }}</dt>
                      <dd>{{ cert.issuer }}</dd>
                    </div>
                    <div>
                      <dt>{{ $t('admin:ssl.names') }}</dt>
                      <dd>{{ cert.subjectAlternativeNames }}</dd>
                    </div>
                    <div>
                      <dt>{{ $t('admin:ssl.validUntil') }}</dt>
                      <dd>{{ date(cert.validFrom) }} / {{ date(cert.validUntil) }}</dd>
                    </div>
                    <div>
                      <dt>{{ $t('admin:ssl.key') }}</dt>
                      <dd>{{ cert.key }}</dd>
                    </div>
                    <div>
                      <dt>{{ $t('admin:ssl.sha256Fingerprint') }}</dt>
                      <dd class="tls-mono">{{ cert.fingerprint256 }}</dd>
                    </div>
                  </dl>
                </div>
              </template>
              <template v-else>
                <h3>{{ $t('admin:ssl.selectOperation') }}</h3>
                <p>{{ $t('admin:ssl.inspectOutcomeAttributionPublic') }}</p>
              </template>
            </article>
          </div>
        </section>
        <footer class="tls-footer">
          <span>{{ $t('admin:ssl.workspaceObserved', { observedAt: date(workspace.observedAt), interpolation: { escapeValue: false } }) }}</span>
          <span>{{ $t('admin:ssl.certificateChecksPointTime') }}</span>
        </footer>
      </template>
    </div>
    <v-dialog v-model="dialog" max-width="620" :persistent="busy" aria-labelledby="tls-review-title">
      <v-card class="pa-6">
        <p class="tls-eyebrow">{{ $t('admin:ssl.reviewChange') }}</p>
        <h2 id="tls-review-title">{{ reviewTitle }}</h2>
        <p class="my-4">{{ reviewDescription }}</p>
        <p v-if="action === 'save-policy'">
          {{ $t('admin:ssl.destination2', { publicUrl: workspace?.publicUrl, interpolation: { escapeValue: false } }) }}
          <br />
          {{ $t('admin:ssl.reason2', { policyReason, interpolation: { escapeValue: false } }) }}
        </p>
        <v-textarea
          v-if="certificateMutation"
          v-model="operationReason"
          :label="$t('admin:ssl.reasonCertificateChange')"
          rows="2"
          maxlength="1000"
          counter="1000"
          :disabled="busy"
        />
        <v-checkbox
          v-if="action === 'apply-certificate' && workspace?.listeners.replacementMode === 'listener-restart'"
          v-model="restartAck"
          :label="$t('admin:ssl.iUnderstandActiveHttps')"
          :disabled="busy"
          hide-details
        />
        <v-checkbox
          v-if="action === 'renew-certificate'"
          v-model="issuanceAck"
          :label="$t('admin:ssl.requestCertificateLetsEncrypt')"
          :disabled="busy"
          hide-details
        />
        <v-checkbox
          v-if="certificateMutation && uncertainMutation"
          v-model="uncertainAck"
          :label="$t('admin:ssl.iReviewedUncertainReceipt', { kindLabel: kindLabel(uncertainMutation.kind).toLowerCase(), interpolation: { escapeValue: false } })"
          :disabled="busy"
          hide-details
        />
        <v-alert v-if="dialogError" type="error" variant="tonal" class="my-3">{{ dialogError }}</v-alert>
        <v-card-actions class="px-0 pt-5">
          <v-spacer />
          <v-btn :disabled="busy" @click="closeReview">{{ $t('common:actions.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" :loading="busy" :disabled="!reviewReady" @click="confirmReview">
            {{ action === 'renew-certificate' ? $t('admin:ssl.requestCertificate') : action === 'apply-certificate' ? $t('admin:ssl.applyCertificate') : $t('admin:ssl.applyPolicy') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
<script setup lang="ts">
import { confirmDiscard } from '../common/confirm-dialog.ts'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import type { TlsOperation, TlsOperationKind, TlsWorkspace } from '../../../shared/tls-workspace.ts'
import { applyTlsPolicy, fetchTlsOperation, fetchTlsWorkspace, saveTlsPolicy, startTlsOperation } from '../../helpers/tls-workspace-api.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const route = useRoute(),
  router = useRouter()
const sections = [
  { id: 'connections', number: '01', label: t('admin:ssl.connections') },
  { id: 'certificates', number: '02', label: t('admin:ssl.certificates') },
  { id: 'policy', number: '03', label: t('admin:ssl.redirectPolicy') },
  { id: 'operations', number: '04', label: t('admin:ssl.operations') }
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
    ? t('admin:ssl.reverseProxy')
    : workspace.value?.listeners.httpsPort
      ? t('admin:ssl.nativeHttps')
      : t('admin:ssl.externalIngressUnverified')
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
    'public-check': t('admin:ssl.publicHttpsCheck'),
    'native-check': t('admin:ssl.nativeHttpsCheck'),
    'validate-material': t('admin:ssl.materialValidation'),
    'apply-certificate': t('admin:ssl.certificateReplacement'),
    'renew-certificate': t('admin:ssl.certificateIssuance')
  })[kind] || kind
const reviewTitle = computed(() =>
  action.value === 'save-policy'
    ? draftEnabled.value
      ? t('admin:ssl.enableHttpsRedirection')
      : t('admin:ssl.disableHttpsRedirection')
    : action.value === 'apply-policy'
      ? t('admin:ssl.applySavedRedirectPolicy')
      : kindLabel(action.value)
)
const reviewDescription = computed(() =>
  action.value === 'renew-certificate'
    ? t('admin:ssl.requestSaveCertificateUsing', { domain: workspace.value?.deployment.domain || 'the configured domain', subscriberEmail: workspace.value?.deployment.subscriberEmail || 'the configured subscriber', interpolation: { escapeValue: false } })
    : action.value === 'apply-certificate'
      ? t('admin:ssl.replaceNativeListenerCertificate')
      : t('admin:ssl.applyRedirectPolicyRunning')
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
  return Number.isNaN(parsed.getTime()) ? t('admin:ssl.unknown') : parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
const actor = (value: { actorId: number | null; apiKeyId: number | null }) =>
  value.apiKeyId ? t('admin:ssl.apiKey', { apiKeyId: value.apiKeyId, interpolation: { escapeValue: false } }) : value.actorId ? t('admin:ssl.user', { actorId: value.actorId, interpolation: { escapeValue: false } }) : t('admin:ssl.system')
const port = (value: number | null) => (value ? t('admin:ssl.port', { value, interpolation: { escapeValue: false } }) : t('admin:ssl.notRunning'))
const verdict = (value: boolean | null) => (value === null ? t('admin:ssl.notObserved') : value ? t('admin:ssl.verified') : t('admin:ssl.notVerified'))
const message = (value: unknown) => (value instanceof Error ? value.message : t('admin:ssl.requestCouldNotConfirmed'))
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
  try {
    const value = await fetchTlsWorkspace()
    if (disposed || token !== generation) return
    const preserve = dirty.value
    workspace.value = value
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
        ? t('admin:ssl.redirectPolicySavedApplied')
        : t('admin:ssl.policySavedReconcilePublic')
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
        error.value = t('admin:ssl.refreshEvidenceRecoverSaved', { cause: message(cause), interpolation: { escapeValue: false } })
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
onBeforeRouteLeave(async () => {
  if (busy.value) return false
  if (!dirty.value) return true
  return confirmDiscard(t('admin:ssl.leaveUnsavedPolicy'), t('admin:ssl.redirectPolicyDraftWill'), t('admin:ssl.discardDraft'))
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
})
</script>
<style lang="scss" src="./tls-workspace.scss"></style>
