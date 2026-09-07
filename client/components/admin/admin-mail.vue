<template>
  <v-container fluid class="mail-workspace">
    <div :inert="dialogOpen || undefined">
      <admin-hero title="Mail" description="A considered channel for invitations, account access and knowledge updates." icon="mdi-email-outline">
        <template #actions>
          <v-btn variant="text" prepend-icon="mdi-refresh" :disabled="busy || loading" @click="reload">Reload workspace</v-btn>
          <v-btn v-if="dirty" variant="text" :disabled="busy" @click="askDiscard(reset)">Reset draft</v-btn>
          <v-btn color="primary" :disabled="locked || !dirty || issues.length > 0" @click="openReview">Review changes</v-btn>
        </template>
      </admin-hero>
      <async-state v-if="loading && !saved" state="loading" title="Loading Mail" message="Reading saved settings and diagnostic evidence." />
      <async-state
        v-else-if="error && !saved"
        state="error"
        title="Mail could not be loaded"
        :message="error"
        retry-label="Try again"
        @retry="load"
      />
      <v-alert v-else-if="error" type="error" variant="tonal" class="mb-5">{{ error }}</v-alert>
      <v-alert v-if="notice" type="info" variant="tonal" class="mb-5" aria-live="polite">{{ notice }}</v-alert>
      <v-alert v-if="stale" type="warning" variant="tonal" class="mb-5">
        Saved settings changed or a publication is unconfirmed. Reload and review before another action.
      </v-alert>
      <template v-if="saved && policy">
        <div class="mail-state-line">
          <span>
            <i :class="{ 'is-draft': dirty }" />
            {{ dirty ? 'Unsaved mail draft' : 'Showing saved settings' }}
          </span>
          <span>Observed {{ dateTime(saved.observedAt) }}</span>
        </div>
        <nav class="mail-tabs" aria-label="Mail sections">
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
        <v-alert v-if="saved.offline || saved.runtime.offline" type="warning" variant="tonal" class="mb-5">
          Offline mode pauses outgoing mail and diagnostic network checks. Templates and saved configuration remain available.
        </v-alert>
        <div class="mail-layout" :class="{ 'mail-layout-wide': section === 'templates' }">
          <section class="mail-main">
            <template v-if="section === 'transport'">
              <header class="mail-heading">
                <span class="mail-kicker">01 / A recognisable sender</span>
                <h2>From your workspace</h2>
                <p>Give every message a clear identity, then choose how it reaches your mail provider.</p>
              </header>
              <section class="mail-panel">
                <div class="mail-section-head">
                  <div>
                    <h3>Sender identity</h3>
                    <p>Used for account and notification messages.</p>
                  </div>
                  <v-switch v-model="policy.enabled" label="Delivery enabled" color="primary" hide-details inset :disabled="locked" />
                </div>
                <div class="mail-fields">
                  <v-text-field v-model="policy.senderName" label="Sender name" variant="outlined" maxlength="255" :disabled="locked" />
                  <v-text-field
                    v-model="policy.senderEmail"
                    label="Sender email"
                    type="email"
                    variant="outlined"
                    maxlength="254"
                    :disabled="locked"
                  />
                  <v-text-field
                    v-model="policy.replyTo"
                    label="Reply-to email (optional)"
                    type="email"
                    variant="outlined"
                    maxlength="254"
                    :disabled="locked"
                    persistent-hint
                    hint="Leave empty to direct replies to the sender address."
                  />
                </div>
                <p class="mail-note">
                  Pausing delivery keeps your transport and credentials saved. Account verification, password reset and watched-page messages depend
                  on this channel.
                </p>
              </section>
              <section class="mail-panel">
                <div class="mail-section-head">
                  <div>
                    <h3>SMTP transport</h3>
                    <p>Your provider's outgoing mail connection.</p>
                  </div>
                </div>
                <div class="mail-fields mail-host-fields">
                  <v-text-field
                    v-model="policy.host"
                    label="SMTP hostname"
                    variant="outlined"
                    maxlength="255"
                    placeholder="smtp.example.com"
                    :disabled="locked"
                    persistent-hint
                    hint="A hostname or IP address, without a URL scheme."
                  />
                  <v-text-field
                    :model-value="policy.port"
                    label="Port"
                    type="number"
                    min="1"
                    max="65535"
                    variant="outlined"
                    :disabled="locked"
                    @update:model-value="policy.port = Number($event)"
                  />
                </div>
                <v-select
                  v-model="policy.tlsMode"
                  :items="tlsModes"
                  label="Connection security"
                  variant="outlined"
                  :disabled="locked"
                  persistent-hint
                  :hint="tlsHint"
                />
                <v-alert v-if="policy.tlsMode === 'plain' || policy.tlsMode === 'opportunistic'" type="warning" variant="tonal" class="mt-4">
                  {{
                    policy.tlsMode === 'plain'
                      ? 'This mode does not encrypt the connection. Use only for a trusted local relay.'
                      : 'Mail can travel without TLS if the server does not advertise STARTTLS. A failed advertised upgrade is never downgraded.'
                  }}
                </v-alert>
                <div class="mail-subsection">
                  <h4>Authentication</h4>
                  <p>Use the credentials supplied by your provider, or leave the username empty for an unauthenticated relay.</p>
                </div>
                <v-text-field v-model="policy.user" label="SMTP username" variant="outlined" maxlength="255" autocomplete="off" :disabled="locked" />
                <mail-secret-field v-model="secrets.pass" :stored="saved.secrets.pass" label="SMTP password" :disabled="locked" />
                <details class="mail-advanced">
                  <summary>Advanced connection settings</summary>
                  <div class="mail-fields mt-5">
                    <v-text-field
                      v-model="policy.name"
                      label="Client greeting name (optional)"
                      variant="outlined"
                      maxlength="255"
                      :disabled="locked"
                      persistent-hint
                      hint="Hostname sent in EHLO. Empty uses the server default."
                    />
                    <v-text-field
                      v-model="policy.tlsServerName"
                      label="TLS certificate hostname (optional)"
                      variant="outlined"
                      maxlength="253"
                      :disabled="locked"
                      persistent-hint
                      hint="Use when the certificate name differs from the connection address."
                    />
                  </div>
                  <v-switch
                    v-model="policy.verifySSL"
                    label="Verify the server's TLS certificate"
                    color="primary"
                    inset
                    :disabled="locked || policy.tlsMode === 'plain'"
                    hide-details
                  />
                  <v-alert v-if="!policy.verifySSL && policy.tlsMode !== 'plain'" type="warning" variant="tonal" class="mt-3">
                    Certificate verification is disabled. The server's identity will not be checked.
                  </v-alert>
                </details>
              </section>
            </template>
            <template v-else-if="section === 'signing'">
              <header class="mail-heading">
                <span class="mail-kicker">02 / A verifiable origin</span>
                <h2>Sign with your domain</h2>
                <p>Prepare a signing key, publish its DNS record, then enable DKIM on outgoing messages.</p>
              </header>
              <div class="mail-steps">
                <div>
                  <b>1</b>
                  <span>
                    Save the key
                    <br />
                    <small>Keep signing paused</small>
                  </span>
                </div>
                <div>
                  <b>2</b>
                  <span>
                    Publish & check DNS
                    <br />
                    <small>At your DNS provider</small>
                  </span>
                </div>
                <div>
                  <b>3</b>
                  <span>
                    Enable signing
                    <br />
                    <small>Review and save</small>
                  </span>
                </div>
              </div>
              <section class="mail-panel">
                <div class="mail-section-head">
                  <div>
                    <h3>Signing identity</h3>
                    <p>DKIM adds a domain signature to outgoing mail.</p>
                  </div>
                  <v-switch v-model="policy.useDKIM" label="Signing enabled" color="primary" hide-details inset :disabled="locked" />
                </div>
                <div class="mail-fields">
                  <v-text-field
                    v-model="policy.dkimDomainName"
                    label="Signing domain"
                    variant="outlined"
                    placeholder="example.com"
                    maxlength="253"
                    :disabled="locked"
                  />
                  <v-text-field
                    v-model="policy.dkimKeySelector"
                    label="Key selector"
                    variant="outlined"
                    placeholder="wiki"
                    maxlength="253"
                    :disabled="locked"
                    persistent-hint
                    hint="Use a new selector when rotating to a new signing key."
                  />
                </div>
                <mail-secret-field
                  v-model="secrets.dkimPrivateKey"
                  :stored="saved.secrets.dkimPrivateKey"
                  label="DKIM private key"
                  multiline
                  :disabled="locked"
                />
                <p class="mail-note">
                  Use an unencrypted RSA private key of at least 2048 bits. Your DNS provider receives only the public record below.
                </p>
              </section>
              <section class="mail-panel">
                <div class="mail-section-head">
                  <div>
                    <h3>DNS publication</h3>
                    <p>Derived from the saved key, including when signing is paused.</p>
                  </div>
                  <v-btn variant="outlined" :disabled="!canCheckDns" @click="runCheck('dkim')">Check DNS</v-btn>
                </div>
                <v-alert v-if="dirty" type="info" variant="tonal" class="mb-4">
                  The DNS record below describes saved settings. Save your draft before copying or checking a replacement key.
                </v-alert>
                <template v-if="saved.dkimRecord">
                  <div class="mail-record">
                    <div>
                      <span>TXT record name</span>
                      <v-btn variant="text" size="small" :disabled="dirty" @click="copy(saved.dkimRecord.name, 'Record name copied.')">
                        Copy name
                      </v-btn>
                    </div>
                    <code>{{ saved.dkimRecord.name }}</code>
                  </div>
                  <div class="mail-record">
                    <div>
                      <span>TXT value · {{ saved.dkimRecord.bits }}-bit RSA</span>
                      <v-btn variant="text" size="small" :disabled="dirty" @click="copy(saved.dkimRecord.value, 'Public record copied.')">
                        Copy value
                      </v-btn>
                    </div>
                    <code>{{ saved.dkimRecord.value }}</code>
                  </div>
                  <p class="mail-note">
                    Paste the full value using your DNS provider's TXT editor. Providers may split long values into quoted chunks; those chunks must
                    form one record. Allow time for DNS propagation.
                  </p>
                </template>
                <div v-else class="mail-empty">
                  <v-icon icon="mdi-key-outline" size="32" />
                  <h4>No public record is ready</h4>
                  <p>Save a valid domain, selector and private key to prepare the DNS record. Signing can remain paused.</p>
                </div>
                <p class="mail-note">
                  A matching key does not verify SPF, DMARC alignment or inbox delivery. Keep those policies consistent with your sending provider.
                </p>
              </section>
            </template>
            <template v-else-if="section === 'templates'">
              <header class="mail-heading">
                <span class="mail-kicker">03 / The messages people receive</span>
                <h2>One familiar voice</h2>
                <p>Inspect the actual bundled layouts with sample content and workspace branding. Previews send no mail.</p>
              </header>
              <div class="mail-template-layout">
                <nav class="mail-template-list" aria-label="Email templates">
                  <button
                    v-for="item in MAIL_TEMPLATES"
                    :key="item.key"
                    type="button"
                    :aria-current="templateKey === item.key ? 'page' : undefined"
                    @click="selectTemplate(item.key)"
                  >
                    <strong>{{ item.title }}</strong>
                    <span>{{ item.description }}</span>
                    <v-icon icon="mdi-arrow-top-right" size="18" />
                  </button>
                </nav>
                <section class="mail-preview-panel">
                  <div class="mail-preview-toolbar">
                    <div>
                      <span class="mail-kicker">Sample preview</span>
                      <h3>{{ templateTitle }}</h3>
                    </div>
                    <v-btn variant="text" prepend-icon="mdi-refresh" :loading="previewLoading" @click="loadPreview">Reload preview</v-btn>
                  </div>
                  <v-alert v-if="previewError" type="error" variant="tonal">{{ previewError }}</v-alert>
                  <v-progress-linear v-if="previewLoading" indeterminate color="primary" aria-label="Loading email preview" />
                  <template v-if="preview">
                    <p class="mail-preview-subject">
                      <strong>Subject</strong>
                      {{ preview.subject }}
                    </p>
                    <iframe
                      :srcdoc="preview.html"
                      :title="templateTitle + ' email preview'"
                      sandbox=""
                      referrerpolicy="no-referrer"
                      class="mail-preview-frame"
                    />
                  </template>
                  <div v-else-if="!previewLoading" class="mail-empty">
                    <p>Select a template to inspect its message.</p>
                  </div>
                </section>
              </div>
              <p class="mail-note">
                Workspace identity comes from General settings. Actual messages use the account, page and action involved. The shared layouts are
                maintained with the application.
              </p>
            </template>
            <template v-else>
              <header class="mail-heading">
                <span class="mail-kicker">04 / Evidence before assumptions</span>
                <h2>Follow the delivery path</h2>
                <p>Test a specific step and keep its result. SMTP acceptance is a handoff; the recipient mailbox confirms arrival.</p>
              </header>
              <div class="mail-diagnostic-actions">
                <section class="mail-panel">
                  <v-icon icon="mdi-lan-connect" size="28" />
                  <h3>Connection</h3>
                  <p>Check the saved transport and configured authentication. No message is sent.</p>
                  <v-btn variant="outlined" :disabled="!canCheckSmtp" @click="runCheck('connection')">Check connection</v-btn>
                </section>
                <section class="mail-panel">
                  <v-icon icon="mdi-email-fast-outline" size="28" />
                  <h3>Test message</h3>
                  <p>Send one message to an address you choose, then inspect its arrival.</p>
                  <v-btn color="primary" :disabled="!canCheckSmtp" @click="openTest">Prepare test message</v-btn>
                </section>
              </div>
              <p v-if="dirty" class="mail-note">Save or reset your draft before running checks.</p>
              <p v-else-if="!saved.runtime.allocated || !saved.runtime.settingsCurrent" class="mail-note">
                Apply a valid, enabled transport before running an SMTP check. DKIM DNS can be checked independently in Signing.
              </p>
              <v-alert v-if="unconfirmed" type="warning" variant="tonal" class="mb-5">
                <p>The request response was lost. Its outcome is unconfirmed. Refresh its receipt before requesting another check.</p>
                <code>{{ unconfirmed.id }}</code>
                <div class="mt-3">
                  <v-btn variant="outlined" :disabled="busy" @click="recoverCheck">Recover receipt</v-btn>
                  <v-btn v-if="receiptMissing" variant="text" :disabled="busy" @click="retryCheck">Retry original request</v-btn>
                  <p v-if="receiptMissing" class="mt-3">
                    Retrying uses the same request identifier. It retrieves an existing check or starts the originally requested check if none was
                    recorded.
                  </p>
                </div>
              </v-alert>
              <section class="mail-panel">
                <div class="mail-section-head">
                  <div>
                    <h3>Diagnostic register</h3>
                    <p>The latest 50 administration checks. These are not records of all outgoing mail.</p>
                  </div>
                  <div class="mail-inline-actions">
                    <v-btn variant="text" :disabled="busy || refreshing" @click="refreshChecks">Refresh checks</v-btn>
                    <v-btn variant="text" :disabled="!checks.length" @click="downloadChecks">Export</v-btn>
                  </div>
                </div>
                <div v-if="!checks.length" class="mail-empty">
                  <v-icon icon="mdi-email-search-outline" size="34" />
                  <h4>No checks recorded</h4>
                  <p>Start with a connection check, then send a message when you are ready to verify delivery.</p>
                </div>
                <article
                  v-for="check in checks"
                  :key="check.id"
                  :id="'mail-check-' + check.id"
                  :tabindex="route.query.check === check.id ? -1 : undefined"
                  class="mail-check"
                  :class="{
                    'mail-check-selected': route.query.check === check.id
                  }"
                >
                  <div class="mail-check-head">
                    <div>
                      <h4>{{ checkTitle(check.kind) }}</h4>
                      <span>
                        {{ dateTime(check.createdAt) }} ·
                        {{ check.configurationRevision === saved.revision ? 'Current saved revision' : 'Earlier saved revision' }}
                      </span>
                    </div>
                    <v-chip :color="checkColor(check.state)" size="small" label>{{ checkLabel(check) }}</v-chip>
                  </div>
                  <p>{{ check.summary }}</p>
                  <p v-if="check.recipient" class="mail-note">Recipient: {{ check.recipient }}</p>
                  <div class="mail-check-footer">
                    <span>{{ check.actorId ? `Requested by account ${check.actorId}` : 'Requested by an API principal' }}</span>
                    <v-btn size="small" variant="text" @click="copyCheckLink(check.id)">Copy receipt link</v-btn>
                  </div>
                </article>
              </section>
              <details class="mail-history">
                <summary>Configuration history · {{ saved.history.length }} recent changes</summary>
                <article v-for="event in saved.history" :key="event.id">
                  <div>
                    <strong>{{ event.reason }}</strong>
                    <span>{{ dateTime(event.createdAt) }}</span>
                  </div>
                  <p>{{ event.fields.map(fieldLabel).join(', ') }}</p>
                  <small>{{ event.actorId ? `Account ${event.actorId}` : 'API principal' }}</small>
                </article>
                <p v-if="!saved.history.length" class="mail-note">No reviewed configuration changes recorded yet.</p>
              </details>
            </template>
            <v-alert v-if="issues.length && section !== 'templates'" type="warning" variant="tonal" class="mt-5">
              <strong>Before saving</strong>
              <ul>
                <li v-for="issue in issues" :key="issue">{{ issue }}</li>
              </ul>
            </v-alert>
          </section>
          <aside v-if="section !== 'templates'" class="mail-aside">
            <div class="mail-aside-card">
              <span class="mail-kicker">Saved channel</span>
              <h3>{{ saved.policy.senderName || 'Your workspace' }}</h3>
              <p class="mail-sender-address">
                {{ saved.policy.senderEmail || 'No sender address' }}
              </p>
              <dl>
                <div>
                  <dt>Delivery</dt>
                  <dd>{{ saved.policy.enabled ? 'Enabled' : 'Paused' }}</dd>
                </div>
                <div>
                  <dt>Transport</dt>
                  <dd>{{ tlsTitle(saved.policy.tlsMode) }}</dd>
                </div>
                <div>
                  <dt>Signing</dt>
                  <dd>{{ saved.policy.useDKIM ? 'Enabled' : 'Paused' }}</dd>
                </div>
              </dl>
            </div>
            <div class="mail-aside-card">
              <span class="mail-kicker">This application process</span>
              <h3>{{ runtimeTitle }}</h3>
              <p>{{ runtimeDescription }}</p>
              <v-btn
                v-if="!saved.runtime.settingsCurrent || (saved.policy.enabled && !saved.runtime.allocated)"
                variant="outlined"
                block
                :disabled="locked || dirty"
                @click="applySaved"
              >
                Apply saved settings
              </v-btn>
              <p class="mail-note">An allocated transport is configuration evidence. Check the connection to observe the SMTP server.</p>
            </div>
            <div class="mail-aside-note">
              <v-icon icon="mdi-text-box-check-outline" size="22" />
              <div>
                <strong>One channel, important moments</strong>
                <p>Invitations, verification, password recovery and watched-page updates all use these settings.</p>
              </div>
            </div>
          </aside>
        </div>
        <div v-if="dirty" class="mail-draft-bar" aria-label="Mail draft actions">
          <div>
            <strong>{{ changes.length }} unsaved {{ changes.length === 1 ? 'change' : 'changes' }}</strong>
            <span>Review before applying to outgoing mail.</span>
          </div>
          <div class="mail-inline-actions">
            <v-btn variant="text" :disabled="busy" @click="askDiscard(reset)">Reset changes</v-btn>
            <v-btn color="primary" :disabled="locked || issues.length > 0" @click="openReview">Review draft</v-btn>
          </div>
        </div>
      </template>
    </div>
    <v-dialog v-model="reviewOpen" max-width="720" persistent aria-labelledby="mail-review-title">
      <v-card class="mail-dialog">
        <v-card-title id="mail-review-title">Review mail changes</v-card-title>
        <v-card-text>
          <p>Save these settings and apply them to this application's mail transport. Messages already in progress keep their original transport.</p>
          <div class="mail-review-list">
            <div v-for="change in changes" :key="change.key">
              <strong>{{ change.label }}</strong>
              <span v-if="change.before !== undefined">
                {{ change.before || 'Empty' }}
                <v-icon icon="mdi-arrow-right" size="16" />
                {{ change.after || 'Empty' }}
              </span>
              <span v-else>{{ change.after }}</span>
            </div>
          </div>
          <v-textarea v-model="reason" label="Reason for this change" variant="outlined" rows="2" maxlength="1000" :disabled="busy" hide-details />
          <v-alert v-if="reviewError" type="error" variant="tonal" class="mt-4">{{ reviewError }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-btn :disabled="busy" @click="reviewOpen = false">Keep editing</v-btn>
          <v-spacer />
          <v-btn color="primary" :loading="busy" :disabled="reason.trim().length < 3 || stale" @click="publish">Save and apply</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog v-model="testOpen" max-width="580" persistent aria-labelledby="mail-test-title">
      <v-card class="mail-dialog">
        <v-card-title id="mail-test-title">Send a delivery test</v-card-title>
        <v-card-text>
          <p>This sends one real email using the saved sender and transport. Check the recipient's inbox and spam folder afterward.</p>
          <v-text-field v-model="recipient" label="Test recipient" type="email" variant="outlined" maxlength="254" :disabled="busy" class="mt-5" />
          <v-alert v-if="lastUncertain" type="warning" variant="tonal" class="mb-4">
            The previous test has an uncertain outcome. It may already have been accepted. Inspect its mailbox or provider logs before sending again.
          </v-alert>
          <v-checkbox
            v-if="lastUncertain"
            v-model="acknowledgeUncertain"
            label="I reviewed the previous uncertain test and want another message"
            hide-details
            :disabled="busy"
          />
          <v-checkbox v-model="confirmSend" label="Send one test email to this address" hide-details :disabled="busy" />
          <v-alert v-if="testError" type="error" variant="tonal" class="mt-4">{{ testError }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-btn :disabled="busy" @click="testOpen = false">Cancel</v-btn>
          <v-spacer />
          <v-btn
            color="primary"
            :loading="busy"
            :disabled="!canCheckSmtp || !isMailAddress(recipient.trim()) || !confirmSend || (!!lastUncertain && !acknowledgeUncertain)"
            @click="sendTest"
          >
            Send test email
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog v-model="discardOpen" max-width="500" persistent aria-labelledby="mail-discard-title">
      <v-card class="mail-dialog">
        <v-card-title id="mail-discard-title">Discard this mail draft?</v-card-title>
        <v-card-text>Unsaved settings and replacement credentials will be discarded.</v-card-text>
        <v-card-actions>
          <v-btn @click="cancelDiscard">Keep editing</v-btn>
          <v-spacer />
          <v-btn color="primary" @click="discard">Discard draft</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, toRaw, nextTick } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import AsyncState from '@/components/common/async-state.vue'
import MailSecretField from './mail-secret-field.vue'
import {
  MAIL_TEMPLATES,
  mailConfigurationIssues,
  isMailAddress,
  type MailPolicy,
  type MailDraft,
  type MailWorkspace,
  type MailCheck,
  type MailCheckRequest
} from '../../../shared/mail-workspace.ts'
import {
  fetchMailWorkspace,
  saveMailWorkspace,
  applyMailWorkspace,
  startMailCheck,
  fetchMailCheck,
  fetchMailPreview
} from '../../helpers/mail-workspace-api.ts'
import './mail-workspace.scss'
const route = useRoute(),
  router = useRouter()
const sections = [
  { key: 'transport', title: 'Sender & transport' },
  { key: 'signing', title: 'Signing' },
  { key: 'templates', title: 'Templates' },
  { key: 'diagnostics', title: 'Diagnostics' }
]
const tlsModes = [
  { title: 'TLS from connection start', value: 'implicit' },
  { title: 'STARTTLS required', value: 'starttls' },
  { title: 'STARTTLS when offered', value: 'opportunistic' },
  { title: 'Plain connection', value: 'plain' }
]
const tlsTitle = (value: string) => tlsModes.find((item) => item.value === value)?.title || value
const saved = shallowRef<MailWorkspace | null>(null),
  policy = ref<MailPolicy | null>(null),
  secrets = ref<MailDraft['secrets']>({
    pass: { action: 'keep' },
    dkimPrivateKey: { action: 'keep' }
  })
const loading = ref(false),
  busy = ref(false),
  refreshing = ref(false),
  error = ref(''),
  notice = ref(''),
  stale = ref(false),
  checks = ref<MailCheck[]>([])
const reviewOpen = ref(false),
  testOpen = ref(false),
  discardOpen = ref(false),
  reason = ref(''),
  reviewError = ref(''),
  testError = ref(''),
  recipient = ref(''),
  confirmSend = ref(false),
  acknowledgeUncertain = ref(false)
const receiptMissing = ref(false)
const unconfirmed = ref<MailCheckRequest | null>(null),
  pendingAction = shallowRef<(() => void) | null>(null)
const section = computed(() => (sections.some((item) => item.key === route.query.section) ? String(route.query.section) : 'transport'))
const templateKey = computed(() =>
  MAIL_TEMPLATES.some((item) => item.key === route.query.template) ? String(route.query.template) : 'account-welcome'
)
const templateTitle = computed(() => MAIL_TEMPLATES.find((item) => item.key === templateKey.value)?.title || 'Email')
const preview = shallowRef<{ html: string; subject: string } | null>(null),
  previewLoading = ref(false),
  previewError = ref('')
let disposed = false,
  sequence = 0,
  previewSequence = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  allowLeave = false
const labels: Record<string, string> = {
  enabled: 'Delivery',
  senderName: 'Sender name',
  senderEmail: 'Sender email',
  replyTo: 'Reply-to email',
  host: 'SMTP hostname',
  port: 'SMTP port',
  name: 'Client greeting name',
  tlsMode: 'Connection security',
  verifySSL: 'Certificate verification',
  tlsServerName: 'Certificate hostname',
  user: 'SMTP username',
  useDKIM: 'DKIM signing',
  dkimDomainName: 'Signing domain',
  dkimKeySelector: 'Key selector',
  'secret.pass': 'SMTP password',
  'secret.dkimPrivateKey': 'DKIM private key'
}
const fieldLabel = (key: string) => labels[key] || key
const display = (key: string, value: unknown) =>
  key === 'tlsMode' ? tlsTitle(String(value)) : typeof value === 'boolean' ? (value ? 'Enabled' : 'Disabled') : String(value ?? '')
const changes = computed(() => {
  if (!saved.value || !policy.value) return []
  const fields: {
    key: string
    label: string
    before?: string
    after: string
  }[] = []
  for (const key of Object.keys(policy.value) as Array<keyof MailPolicy>)
    if (policy.value[key] !== saved.value.policy[key])
      fields.push({
        key,
        label: fieldLabel(key),
        before: display(key, saved.value.policy[key]),
        after: display(key, policy.value[key])
      })
  for (const key of ['pass', 'dkimPrivateKey'] as const)
    if (secrets.value[key].action !== 'keep')
      fields.push({
        key,
        label: fieldLabel('secret.' + key),
        after: secrets.value[key].action === 'clear' ? 'Remove saved credential' : 'Replace saved credential'
      })
  return fields
})
const dirty = computed(() => changes.value.length > 0),
  locked = computed(() => busy.value || loading.value || stale.value),
  dialogOpen = computed(() => reviewOpen.value || testOpen.value || discardOpen.value)
const issues = computed(() => {
  if (!policy.value || !saved.value) return []
  const presence = { ...saved.value.secrets },
    result: string[] = []
  for (const key of ['pass', 'dkimPrivateKey'] as const) {
    const action = secrets.value[key]
    if (action.action !== 'keep') presence[key] = action.action === 'replace' && !!action.value
    if (action.action === 'replace' && !action.value)
      result.push(`Enter a replacement ${fieldLabel('secret.' + key).toLowerCase()} or choose Keep saved.`)
  }
  return [...result, ...mailConfigurationIssues(policy.value, presence)]
})
const tlsHint = computed(
  () =>
    ({
      implicit: 'Usually port 465. Encryption begins as soon as the connection opens.',
      starttls: 'Usually port 587. Delivery requires a successful TLS upgrade.',
      opportunistic: 'Upgrades only when the server advertises STARTTLS.',
      plain: 'TLS is not attempted, even if the server advertises it.'
    })[policy.value?.tlsMode || 'starttls']
)
const running = computed(() => checks.value.some((check) => check.state === 'running'))
const canCheck = computed(
  () => !!saved.value && !locked.value && !dirty.value && !running.value && !unconfirmed.value && !saved.value.offline && !saved.value.runtime.offline
)
const canCheckSmtp = computed(() => canCheck.value && !!saved.value?.runtime.allocated && !!saved.value?.runtime.settingsCurrent)
const canCheckDns = computed(() => canCheck.value && !!saved.value?.dkimRecord)
const lastUncertain = computed(() => {
  const latest = checks.value
    .filter((check) => check.kind === 'test')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || b.id.localeCompare(a.id))[0]
  return latest?.state === 'uncertain' ? latest : null
})
const runtimeTitle = computed(() =>
  !saved.value?.runtime.settingsCurrent
    ? 'Saved settings await application'
    : saved.value.runtime.offline
      ? 'Paused by offline mode'
      : saved.value.runtime.allocated
        ? 'Transport allocated'
        : saved.value.runtime.state === 'invalid'
          ? 'Configuration needs attention'
          : 'Delivery is paused'
)
const runtimeDescription = computed(() =>
  !saved.value?.runtime.settingsCurrent
    ? 'The running transport differs from the saved configuration.'
    : saved.value.runtime.allocated
      ? 'This process is configured to use the saved mail transport.'
      : saved.value?.issues[0] || 'No outgoing transport is allocated in this process.'
)
const dateTime = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Unknown time'
    : date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short'
      })
}
const checkTitle = (kind: MailCheck['kind']) =>
  ({
    connection: 'SMTP connection',
    dkim: 'DKIM DNS record',
    test: 'Delivery test'
  })[kind]
const checkColor = (state: MailCheck['state']) =>
  ({
    running: 'info',
    succeeded: 'success',
    failed: 'error',
    uncertain: 'warning'
  })[state]
const checkLabel = (check: MailCheck) =>
  check.state === 'succeeded'
    ? { connection: 'Connected', dkim: 'Key matches', test: 'SMTP accepted' }[check.kind]
    : { running: 'Running', failed: 'Failed', uncertain: 'Uncertain' }[check.state]
function reset() {
  if (saved.value) policy.value = structuredClone(saved.value.policy)
  secrets.value = {
    pass: { action: 'keep' },
    dkimPrivateKey: { action: 'keep' }
  }
  reviewError.value = ''
  reason.value = ''
}
function schedule() {
  clearTimeout(timer)
  if (!disposed && running.value)
    timer = setTimeout(() => {
      void refreshChecks()
    }, 2500)
}
async function load() {
  const seq = ++sequence
  loading.value = true
  error.value = ''
  try {
    const value = await fetchMailWorkspace()
    if (disposed || seq !== sequence) return
    saved.value = value
    checks.value = value.checks
    stale.value = false
    reset()
    if (unconfirmed.value && checks.value.some((row) => row.id === unconfirmed.value!.id)) unconfirmed.value = null
    schedule()
    if (section.value === 'templates') void loadPreview()
    if (typeof route.query.check === 'string' && !checks.value.some((row) => row.id === route.query.check)) await loadLinkedReceipt(route.query.check)
    if (typeof route.query.check === 'string') void revealReceipt()
  } catch (cause) {
    if (!disposed && seq === sequence) error.value = message(cause)
  } finally {
    if (!disposed && seq === sequence) loading.value = false
  }
}
const message = (cause: unknown) => (cause instanceof Error ? cause.message : 'Mail administration is unavailable.')
const status = (cause: unknown) => (cause && typeof cause === 'object' ? Reflect.get(cause, 'status') : undefined)
function reload() {
  askDiscard(() => {
    notice.value = ''
    void load()
  })
}
function askDiscard(action: () => void) {
  if (!dirty.value) return action()
  pendingAction.value = action
  discardOpen.value = true
}
function cancelDiscard() {
  discardOpen.value = false
  pendingAction.value = null
}
function discard() {
  const action = pendingAction.value
  pendingAction.value = null
  discardOpen.value = false
  reset()
  action?.()
}
function selectSection(key: string) {
  void router.replace({ query: { ...route.query, section: key } })
}
function selectTemplate(key: string) {
  void router.replace({
    query: { ...route.query, section: 'templates', template: key }
  })
}
function openReview() {
  if (locked.value || !dirty.value || issues.value.length) return
  reason.value = ''
  reviewError.value = ''
  reviewOpen.value = true
}
async function publish() {
  if (!saved.value || !policy.value || busy.value || stale.value || reason.value.trim().length < 3) return
  busy.value = true
  reviewError.value = ''
  error.value = ''
  try {
    const result = await saveMailWorkspace({
      policy: structuredClone(toRaw(policy.value)),
      secrets: structuredClone(toRaw(secrets.value)),
      fingerprint: saved.value.fingerprint,
      reason: reason.value.trim()
    })
    if (disposed) return
    reviewOpen.value = false
    stale.value = true
    const presence = { ...saved.value.secrets }
    for (const key of ['pass', 'dkimPrivateKey'] as const) {
      const action = secrets.value[key]
      if (action.action !== 'keep') presence[key] = action.action === 'replace'
    }
    saved.value = {
      ...saved.value,
      policy: structuredClone(toRaw(policy.value)),
      secrets: presence,
      revision: result.revision,
      dkimRecord: null
    }
    secrets.value = {
      pass: { action: 'keep' },
      dkimPrivateKey: { action: 'keep' }
    }
    notice.value = result.applied
      ? 'Mail settings saved and applied.'
      : 'Mail settings were saved, but the transport was not applied. Reload and review the runtime state.'
    await load()
  } catch (cause) {
    if (disposed) return
    reviewError.value = message(cause)
    if (status(cause) !== 400) stale.value = true
  } finally {
    if (!disposed) busy.value = false
  }
}
async function applySaved() {
  if (!saved.value || dirty.value || locked.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await applyMailWorkspace(saved.value.fingerprint)
    if (disposed) return
    notice.value = result.applied
      ? 'The saved mail transport was applied.'
      : 'The saved transport could not be allocated. Review the configuration issues.'
    await load()
  } catch (cause) {
    if (!disposed) {
      error.value = message(cause)
      stale.value = true
    }
  } finally {
    if (!disposed) busy.value = false
  }
}
async function refreshChecks() {
  const seq = sequence
  if (disposed || refreshing.value || loading.value) return
  refreshing.value = true
  try {
    const value = await fetchMailWorkspace()
    if (disposed || seq !== sequence) return
    const linked = checks.value.find((row) => row.id === route.query.check)
    checks.value = linked && !value.checks.some((row) => row.id === linked.id) ? [linked, ...value.checks] : value.checks
    if (saved.value && saved.value.fingerprint !== value.fingerprint) stale.value = true
    else if (saved.value)
      saved.value = {
        ...saved.value,
        runtime: value.runtime,
        observedAt: value.observedAt
      }
    if (unconfirmed.value && checks.value.some((row) => row.id === unconfirmed.value!.id)) unconfirmed.value = null
    receiptMissing.value = false
    schedule()
  } catch (cause) {
    if (!disposed && seq === sequence) error.value = 'Check refresh failed. ' + message(cause)
  } finally {
    if (!disposed) refreshing.value = false
  }
}
async function revealReceipt() {
  await nextTick()
  if (disposed || typeof route.query.check !== 'string') return
  const element = document.getElementById('mail-check-' + route.query.check)
  element?.scrollIntoView({ block: 'center' })
  element?.focus({ preventScroll: true })
}
async function loadLinkedReceipt(id: string) {
  const seq = sequence
  try {
    const check = await fetchMailCheck(id)
    if (!disposed && seq === sequence && route.query.check === id) checks.value = [check, ...checks.value.filter((row) => row.id !== check.id)]
  } catch (cause) {
    if (!disposed && seq === sequence && route.query.check === id) error.value = message(cause)
  }
}
async function recoverCheck() {
  if (!unconfirmed.value || busy.value) return
  busy.value = true
  try {
    const check = await fetchMailCheck(unconfirmed.value.id)
    if (disposed) return
    checks.value = [check, ...checks.value.filter((row) => row.id !== check.id)]
    unconfirmed.value = null
    receiptMissing.value = false
    error.value = ''
    schedule()
  } catch (cause) {
    if (!disposed) {
      receiptMissing.value = status(cause) === 404
      error.value =
        status(cause) === 404
          ? 'No receipt has been recorded for this request yet. Keep its identifier and refresh again before requesting another check.'
          : message(cause)
    }
  } finally {
    if (!disposed) busy.value = false
  }
}
function retryCheck() {
  if (unconfirmed.value && receiptMissing.value && !busy.value) void submitCheck(unconfirmed.value)
}
async function submitCheck(input: MailCheckRequest) {
  busy.value = true
  error.value = ''
  testError.value = ''
  try {
    const check = await startMailCheck(input)
    if (disposed) return
    unconfirmed.value = null
    receiptMissing.value = false
    checks.value = [check, ...checks.value.filter((row) => row.id !== check.id)]
    testOpen.value = false
    selectSection('diagnostics')
    schedule()
  } catch (cause) {
    if (disposed) return
    const text = message(cause)
    if (testOpen.value) testError.value = text
    else error.value = text
    if (![400, 403, 409].includes(Number(status(cause)))) {
      unconfirmed.value = input
      testOpen.value = false
      selectSection('diagnostics')
    }
    if (status(cause) === 409) stale.value = true
  } finally {
    if (!disposed) busy.value = false
  }
}
function runCheck(kind: 'connection' | 'dkim') {
  if (!saved.value || (kind === 'connection' ? !canCheckSmtp.value : !canCheckDns.value)) return
  void submitCheck({
    id: crypto.randomUUID(),
    kind,
    fingerprint: saved.value.fingerprint
  })
}
function openTest() {
  recipient.value = ''
  confirmSend.value = false
  acknowledgeUncertain.value = false
  testError.value = ''
  testOpen.value = true
}
function sendTest() {
  if (
    !saved.value ||
    busy.value ||
    !canCheckSmtp.value ||
    !confirmSend.value ||
    !isMailAddress(recipient.value.trim()) ||
    (lastUncertain.value && !acknowledgeUncertain.value)
  )
    return
  void submitCheck({
    id: crypto.randomUUID(),
    kind: 'test',
    fingerprint: saved.value.fingerprint,
    recipient: recipient.value.trim(),
    confirmSend: true,
    ...(lastUncertain.value ? { acknowledgedUncertainId: lastUncertain.value.id } : {})
  })
}
async function loadPreview() {
  const seq = ++previewSequence
  previewLoading.value = true
  previewError.value = ''
  preview.value = null
  try {
    const value = await fetchMailPreview(templateKey.value)
    if (!disposed && seq === previewSequence) preview.value = value
  } catch (cause) {
    if (!disposed && seq === previewSequence) previewError.value = message(cause)
  } finally {
    if (!disposed && seq === previewSequence) previewLoading.value = false
  }
}
async function copy(value: string, feedback: string) {
  try {
    await navigator.clipboard.writeText(value)
    notice.value = feedback
  } catch {
    error.value = 'Clipboard access failed. Select and copy the text directly.'
  }
}
function copyCheckLink(id: string) {
  const href = router.resolve({
    query: { ...route.query, section: 'diagnostics', check: id }
  }).href
  void copy(new URL(href, location.origin).toString(), 'Receipt link copied.')
}
function downloadChecks() {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), checks: checks.value }, null, 2)], { type: 'application/json' })
  )
  const link = document.createElement('a')
  link.href = url
  link.download = 'mail-diagnostics.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
watch([section, templateKey], () => {
  if (section.value === 'templates' && saved.value) void loadPreview()
})
watch(
  () => route.query.check,
  (value) => {
    if (typeof value === 'string' && saved.value) {
      if (!checks.value.some((row) => row.id === value)) void loadLinkedReceipt(value).then(revealReceipt)
      else void revealReceipt()
    }
  }
)
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
  void load()
  window.addEventListener('beforeunload', beforeUnload)
})
onBeforeUnmount(() => {
  disposed = true
  sequence++
  previewSequence++
  clearTimeout(timer)
  window.removeEventListener('beforeunload', beforeUnload)
  secrets.value = {
    pass: { action: 'keep' },
    dkimPrivateKey: { action: 'keep' }
  }
})
</script>
