<template>
  <v-container fluid class="mail-workspace">
    <div :inert="dialogOpen || undefined">
      <admin-hero :title="$t('admin:mail.title')" :description="$t('admin:mail.consideredChannelInvitationsAccount')" icon="mdi-email-outline">
        <template #actions>
          <v-btn variant="text" prepend-icon="mdi-refresh" :disabled="busy || loading" @click="reload">{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ $t('admin:mail.reloadSavedMailSettings') }}</v-tooltip></v-btn>
          <v-btn v-if="dirty" variant="text" :disabled="busy" @click="askDiscard(reset)">{{ $t('admin:mail.resetDraft') }}</v-btn>
          <v-btn color="primary" :disabled="locked || !dirty || issues.length > 0" @click="openReview">{{ $t('admin:mail.reviewChanges') }}</v-btn>
        </template>
      </admin-hero>
      <async-state v-if="loading && !saved" state="loading" :title="$t('admin:mail.loadingMail')" :message="$t('admin:mail.readingSavedSettingsDiagnostic')" />
      <async-state
        v-else-if="error && !saved"
        state="error"
        :title="$t('admin:mail.mailCouldNotLoaded')"
        :message="error"
        :retry-label="$t('admin:mail.tryAgain')"
        @retry="load"
      />
      <v-alert v-else-if="error" type="error" variant="tonal" class="mb-5">{{ error }}</v-alert>
      <v-alert v-if="notice" type="info" variant="tonal" class="mb-5" aria-live="polite">{{ notice }}</v-alert>
      <v-alert v-if="stale" type="warning" variant="tonal" class="mb-5">
        {{ $t('admin:mail.savedSettingsChangedPublication') }}
      </v-alert>
      <template v-if="saved && policy">
        <div class="mail-state-line">
          <span>
            <i :class="{ 'is-draft': dirty }" />
            {{ dirty ? $t('admin:mail.unsavedMailDraft') : $t('admin:mail.showingSavedSettings') }}
          </span>
          <span>{{ $t('admin:mail.observed', { observedAt: dateTime(saved.observedAt), interpolation: { escapeValue: false } }) }}</span>
        </div>
        <nav class="mail-tabs" :aria-label="$t('admin:mail.mailSections')">
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
          {{ $t('admin:mail.offlineModePausesOutgoing') }}
        </v-alert>
        <div class="mail-layout" :class="{ 'mail-layout-wide': section === 'templates' }">
          <section class="mail-main">
            <template v-if="section === 'transport'">
              <header class="mail-heading">
                <span class="mail-kicker">{{ $t('admin:mail.n01RecognisableSender') }}</span>
                <h2>{{ $t('admin:mail.workspace2') }}</h2>
                <p>{{ $t('admin:mail.giveEveryMessageClear') }}</p>
              </header>
              <section class="mail-panel">
                <div class="mail-section-head">
                  <div>
                    <h3>{{ $t('admin:mail.senderIdentity') }}</h3>
                    <p>{{ $t('admin:mail.usedAccountNotificationMessages') }}</p>
                  </div>
                  <v-switch v-model="policy.enabled" :label="$t('admin:mail.deliveryEnabled')" color="primary" hide-details inset :disabled="locked" />
                </div>
                <div class="mail-fields">
                  <v-text-field v-model="policy.senderName" :label="$t('admin:mail.senderName2')" variant="outlined" maxlength="255" :disabled="locked" />
                  <v-text-field
                    v-model="policy.senderEmail"
                    :label="$t('admin:mail.senderEmail2')"
                    type="email"
                    variant="outlined"
                    maxlength="254"
                    :disabled="locked"
                  />
                  <v-text-field
                    v-model="policy.replyTo"
                    :label="$t('admin:mail.replyEmailOptional')"
                    type="email"
                    variant="outlined"
                    maxlength="254"
                    :disabled="locked"
                    persistent-hint
                    :hint="$t('admin:mail.leaveEmptyDirectReplies')"
                  />
                </div>
                <p class="mail-note">
                  {{ $t('admin:mail.pausingDeliveryKeepsTransport') }}
                </p>
              </section>
              <section class="mail-panel">
                <div class="mail-section-head">
                  <div>
                    <h3>{{ $t('admin:mail.smtpTransport') }}</h3>
                    <p>{{ $t('admin:mail.providersOutgoingMailConnection') }}</p>
                  </div>
                </div>
                <div class="mail-fields mail-host-fields">
                  <v-text-field
                    v-model="policy.host"
                    :label="$t('admin:mail.smtpHostname')"
                    variant="outlined"
                    maxlength="255"
                    :placeholder="$t('admin:mail.smtpExampleCom')"
                    :disabled="locked"
                    persistent-hint
                    :hint="$t('admin:mail.hostnameIpAddressWithout')"
                  />
                  <v-text-field
                    :model-value="policy.port"
                    :label="$t('admin:mail.smtpPort')"
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
                  :label="$t('admin:mail.connectionSecurity')"
                  variant="outlined"
                  :disabled="locked"
                  persistent-hint
                  :hint="tlsHint"
                />
                <v-alert v-if="policy.tlsMode === 'plain' || policy.tlsMode === 'opportunistic'" type="warning" variant="tonal" class="mt-4">
                  {{
                    policy.tlsMode === 'plain'
                      ? $t('admin:mail.modeDoesNotEncrypt')
                      : $t('admin:mail.mailCanTravelWithout')
                  }}
                </v-alert>
                <div class="mail-subsection">
                  <h4>{{ $t('admin:mail.authentication') }}</h4>
                  <p>{{ $t('admin:mail.useCredentialsSuppliedProvider') }}</p>
                </div>
                <v-text-field v-model="policy.user" :label="$t('admin:mail.smtpUsername')" variant="outlined" maxlength="255" autocomplete="off" :disabled="locked" />
                <mail-secret-field v-model="secrets.pass" :stored="saved.secrets.pass" :label="$t('admin:mail.smtpPassword')" :disabled="locked" />
                <details class="mail-advanced">
                  <summary>{{ $t('admin:mail.advancedConnectionSettings') }}</summary>
                  <div class="mail-fields mt-5">
                    <v-text-field
                      v-model="policy.name"
                      :label="$t('admin:mail.clientGreetingNameOptional')"
                      variant="outlined"
                      maxlength="255"
                      :disabled="locked"
                      persistent-hint
                      :hint="$t('admin:mail.hostnameSentEhloEmpty')"
                    />
                    <v-text-field
                      v-model="policy.tlsServerName"
                      :label="$t('admin:mail.tlsCertificateHostnameOptional')"
                      variant="outlined"
                      maxlength="253"
                      :disabled="locked"
                      persistent-hint
                      :hint="$t('admin:mail.useWhenCertificateName')"
                    />
                  </div>
                  <v-switch
                    v-model="policy.verifySSL"
                    :label="$t('admin:mail.verifyServersTlsCertificate')"
                    color="primary"
                    inset
                    :disabled="locked || policy.tlsMode === 'plain'"
                    hide-details
                  />
                  <v-alert v-if="!policy.verifySSL && policy.tlsMode !== 'plain'" type="warning" variant="tonal" class="mt-3">
                    {{ $t('admin:mail.certificateVerificationDisabledServers') }}
                  </v-alert>
                </details>
              </section>
            </template>
            <template v-else-if="section === 'signing'">
              <header class="mail-heading">
                <span class="mail-kicker">{{ $t('admin:mail.n02VerifiableOrigin') }}</span>
                <h2>{{ $t('admin:mail.signDomain') }}</h2>
                <p>{{ $t('admin:mail.prepareSigningKeyPublish') }}</p>
              </header>
              <div class="mail-steps">
                <div>
                  <b>1</b>
                  <span>
                    {{ $t('admin:mail.saveKey') }}
                    <br />
                    <small>{{ $t('admin:mail.keepSigningPaused') }}</small>
                  </span>
                </div>
                <div>
                  <b>2</b>
                  <span>
                    {{ $t('admin:mail.publishCheckDns') }}
                    <br />
                    <small>{{ $t('admin:mail.dnsProvider') }}</small>
                  </span>
                </div>
                <div>
                  <b>3</b>
                  <span>
                    {{ $t('admin:mail.enableSigning') }}
                    <br />
                    <small>{{ $t('admin:mail.reviewSave') }}</small>
                  </span>
                </div>
              </div>
              <section class="mail-panel">
                <div class="mail-section-head">
                  <div>
                    <h3>{{ $t('admin:mail.signingIdentity') }}</h3>
                    <p>{{ $t('admin:mail.dkimAddsDomainSignature') }}</p>
                  </div>
                  <v-switch v-model="policy.useDKIM" :label="$t('admin:mail.signingEnabled')" color="primary" hide-details inset :disabled="locked" />
                </div>
                <div class="mail-fields">
                  <v-text-field
                    v-model="policy.dkimDomainName"
                    :label="$t('admin:mail.signingDomain')"
                    variant="outlined"
                    :placeholder="$t('admin:mail.exampleCom')"
                    maxlength="253"
                    :disabled="locked"
                  />
                  <v-text-field
                    v-model="policy.dkimKeySelector"
                    :label="$t('admin:mail.keySelector')"
                    variant="outlined"
                    :placeholder="$t('admin:mail.wiki')"
                    maxlength="253"
                    :disabled="locked"
                    persistent-hint
                    :hint="$t('admin:mail.useNewSelectorWhen')"
                  />
                </div>
                <mail-secret-field
                  v-model="secrets.dkimPrivateKey"
                  :stored="saved.secrets.dkimPrivateKey"
                  :label="$t('admin:mail.dkimPrivateKey2')"
                  multiline
                  :disabled="locked"
                />
                <p class="mail-note">
                  {{ $t('admin:mail.useUnencryptedRsaPrivate') }}
                </p>
              </section>
              <section class="mail-panel">
                <div class="mail-section-head">
                  <div>
                    <h3>{{ $t('admin:mail.dnsPublication') }}</h3>
                    <p>{{ $t('admin:mail.derivedSavedKeyIncluding') }}</p>
                  </div>
                  <v-btn variant="outlined" :disabled="!canCheckDns" @click="runCheck('dkim')">{{ $t('admin:mail.checkDns') }}</v-btn>
                </div>
                <v-alert v-if="dirty" type="info" variant="tonal" class="mb-4">
                  {{ $t('admin:mail.dnsRecordBelowDescribes') }}
                </v-alert>
                <template v-if="saved.dkimRecord">
                  <div class="mail-record">
                    <div>
                      <span>{{ $t('admin:mail.txtRecordName') }}</span>
                      <v-btn variant="text" size="small" :disabled="dirty" @click="copy(saved.dkimRecord.name, $t('admin:mail.recordNameCopied'))">
                        {{ $t('admin:mail.copyName') }}
                      </v-btn>
                    </div>
                    <code>{{ saved.dkimRecord.name }}</code>
                  </div>
                  <div class="mail-record">
                    <div>
                      <span>{{ $t('admin:mail.txtValueBitRsa', { bits: saved.dkimRecord.bits, interpolation: { escapeValue: false } }) }}</span>
                      <v-btn variant="text" size="small" :disabled="dirty" @click="copy(saved.dkimRecord.value, $t('admin:mail.publicRecordCopied'))">
                        {{ $t('admin:mail.copyValue') }}
                      </v-btn>
                    </div>
                    <code>{{ saved.dkimRecord.value }}</code>
                  </div>
                  <p class="mail-note">
                    {{ $t('admin:mail.pasteFullValueUsing') }}
                  </p>
                </template>
                <div v-else class="mail-empty">
                  <v-icon icon="mdi-key-outline" size="32" />
                  <h4>{{ $t('admin:mail.noPublicRecordReady') }}</h4>
                  <p>{{ $t('admin:mail.saveValidDomainSelector') }}</p>
                </div>
                <p class="mail-note">
                  {{ $t('admin:mail.matchingKeyDoesNot') }}
                </p>
              </section>
            </template>
            <template v-else-if="section === 'templates'">
              <header class="mail-heading">
                <span class="mail-kicker">{{ $t('admin:mail.n03MessagesPeopleReceive') }}</span>
                <h2>{{ $t('admin:mail.oneFamiliarVoice') }}</h2>
                <p>{{ $t('admin:mail.inspectActualBundledLayouts') }}</p>
              </header>
              <div class="mail-template-layout">
                <nav class="mail-template-list" :aria-label="$t('admin:mail.emailTemplates')">
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
                      <span class="mail-kicker">{{ $t('admin:mail.samplePreview') }}</span>
                      <h3>{{ templateTitle }}</h3>
                    </div>
                    <v-btn variant="text" prepend-icon="mdi-refresh" :loading="previewLoading" @click="loadPreview">{{ $t('admin:mail.reloadPreview') }}</v-btn>
                  </div>
                  <v-alert v-if="previewError" type="error" variant="tonal">{{ previewError }}</v-alert>
                  <v-progress-linear v-if="previewLoading" indeterminate color="primary" :aria-label="$t('admin:mail.loadingEmailPreview')" />
                  <template v-if="preview">
                    <p class="mail-preview-subject">
                      <strong>{{ $t('admin:mail.subject') }}</strong>
                      {{ preview.subject }}
                    </p>
                    <iframe
                      :srcdoc="preview.html"
                      :title="$t('admin:mail.emailPreview', { templateTitle, interpolation: { escapeValue: false } })"
                      sandbox=""
                      referrerpolicy="no-referrer"
                      class="mail-preview-frame"
                    />
                  </template>
                  <div v-else-if="!previewLoading" class="mail-empty">
                    <p>{{ $t('admin:mail.selectTemplateInspectMessage') }}</p>
                  </div>
                </section>
              </div>
              <p class="mail-note">
                {{ $t('admin:mail.workspaceIdentityComesGeneral') }}
              </p>
            </template>
            <template v-else>
              <header class="mail-heading">
                <span class="mail-kicker">{{ $t('admin:mail.n04EvidenceBeforeAssumptions') }}</span>
                <h2>{{ $t('admin:mail.followDeliveryPath') }}</h2>
                <p>{{ $t('admin:mail.testSpecificStepKeep') }}</p>
              </header>
              <div class="mail-diagnostic-actions">
                <section class="mail-panel">
                  <v-icon icon="mdi-lan-connect" size="28" />
                  <h3>{{ $t('admin:mail.connection') }}</h3>
                  <p>{{ $t('admin:mail.checkSavedTransportConfigured') }}</p>
                  <v-btn variant="outlined" :disabled="!canCheckSmtp" @click="runCheck('connection')">{{ $t('admin:mail.checkConnection') }}</v-btn>
                </section>
                <section class="mail-panel">
                  <v-icon icon="mdi-email-fast-outline" size="28" />
                  <h3>{{ $t('admin:mail.testMessage') }}</h3>
                  <p>{{ $t('admin:mail.sendOneMessageAddress') }}</p>
                  <v-btn color="primary" :disabled="!canCheckSmtp" @click="openTest">{{ $t('admin:mail.prepareTestMessage') }}</v-btn>
                </section>
              </div>
              <p v-if="dirty" class="mail-note">{{ $t('admin:mail.saveResetDraftBefore') }}</p>
              <p v-else-if="!saved.runtime.allocated || !saved.runtime.settingsCurrent" class="mail-note">
                {{ $t('admin:mail.applyValidEnabledTransport') }}
              </p>
              <v-alert v-if="unconfirmed" type="warning" variant="tonal" class="mb-5">
                <p>{{ $t('admin:mail.requestResponseWasLost') }}</p>
                <code>{{ unconfirmed.id }}</code>
                <div class="mt-3">
                  <v-btn variant="outlined" :disabled="busy" @click="recoverCheck">{{ $t('admin:mail.recoverReceipt') }}</v-btn>
                  <v-btn v-if="receiptMissing" variant="text" :disabled="busy" @click="retryCheck">{{ $t('admin:mail.retryOriginalRequest') }}</v-btn>
                  <p v-if="receiptMissing" class="mt-3">
                    {{ $t('admin:mail.retryingUsesSameRequest') }}
                  </p>
                </div>
              </v-alert>
              <section class="mail-panel">
                <div class="mail-section-head">
                  <div>
                    <h3>{{ $t('admin:mail.diagnosticRegister') }}</h3>
                    <p>{{ $t('admin:mail.latest50AdministrationChecks') }}</p>
                  </div>
                  <div class="mail-inline-actions">
                    <v-btn variant="text" :disabled="busy || refreshing" @click="refreshChecks">{{ $t('admin:mail.refreshChecks') }}</v-btn>
                    <v-btn variant="text" :disabled="!checks.length" @click="downloadChecks">{{ $t('admin:mail.export') }}</v-btn>
                  </div>
                </div>
                <div v-if="!checks.length" class="mail-empty">
                  <v-icon icon="mdi-email-search-outline" size="34" />
                  <h4>{{ $t('admin:mail.noChecksRecorded') }}</h4>
                  <p>{{ $t('admin:mail.startConnectionCheckThen') }}</p>
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
                        {{ check.configurationRevision === saved.revision ? $t('admin:mail.currentSavedRevision') : $t('admin:mail.earlierSavedRevision') }}
                      </span>
                    </div>
                    <v-chip :color="checkColor(check.state)" size="small" label>{{ checkLabel(check) }}</v-chip>
                  </div>
                  <p>{{ check.summary }}</p>
                  <p v-if="check.recipient" class="mail-note">{{ $t('admin:mail.recipient', { recipient: check.recipient, interpolation: { escapeValue: false } }) }}</p>
                  <div class="mail-check-footer">
                    <span>{{ check.actorId ? $t('admin:mail.requestedAccount', { actorId: check.actorId, interpolation: { escapeValue: false } }) : $t('admin:mail.requestedApiPrincipal') }}</span>
                    <v-btn size="small" variant="text" @click="copyCheckLink(check.id)">{{ $t('admin:mail.copyReceiptLink') }}</v-btn>
                  </div>
                </article>
              </section>
              <details class="mail-history">
                <summary>{{ $t('admin:mail.configurationHistoryRecentChanges', { historyCount: saved.history.length, interpolation: { escapeValue: false } }) }}</summary>
                <article v-for="event in saved.history" :key="event.id">
                  <div>
                    <strong>{{ event.reason }}</strong>
                    <span>{{ dateTime(event.createdAt) }}</span>
                  </div>
                  <p>{{ event.fields.map(fieldLabel).join(', ') }}</p>
                  <small>{{ event.actorId ? $t('admin:mail.account', { actorId: event.actorId, interpolation: { escapeValue: false } }) : $t('admin:mail.apiPrincipal') }}</small>
                </article>
                <p v-if="!saved.history.length" class="mail-note">{{ $t('admin:mail.noReviewedConfigurationChanges') }}</p>
              </details>
            </template>
            <v-alert v-if="issues.length && section !== 'templates'" type="warning" variant="tonal" class="mt-5">
              <strong>{{ $t('admin:mail.beforeSaving') }}</strong>
              <ul>
                <li v-for="issue in issues" :key="issue">{{ issue }}</li>
              </ul>
            </v-alert>
          </section>
          <aside v-if="section !== 'templates'" class="mail-aside">
            <div class="mail-aside-card">
              <span class="mail-kicker">{{ $t('admin:mail.savedChannel') }}</span>
              <h3>{{ saved.policy.senderName || $t('admin:mail.workspace') }}</h3>
              <p class="mail-sender-address">
                {{ saved.policy.senderEmail || $t('admin:mail.noSenderAddress') }}
              </p>
              <dl>
                <div>
                  <dt>{{ $t('admin:mail.delivery') }}</dt>
                  <dd>{{ saved.policy.enabled ? $t('admin:mail.enabled') : $t('admin:mail.paused') }}</dd>
                </div>
                <div>
                  <dt>{{ $t('admin:mail.transport') }}</dt>
                  <dd>{{ tlsTitle(saved.policy.tlsMode) }}</dd>
                </div>
                <div>
                  <dt>{{ $t('admin:mail.signing') }}</dt>
                  <dd>{{ saved.policy.useDKIM ? $t('admin:mail.enabled') : $t('admin:mail.paused') }}</dd>
                </div>
              </dl>
            </div>
            <div class="mail-aside-card">
              <span class="mail-kicker">{{ $t('admin:mail.applicationProcess') }}</span>
              <h3>{{ runtimeTitle }}</h3>
              <p>{{ runtimeDescription }}</p>
              <v-btn
                v-if="!saved.runtime.settingsCurrent || (saved.policy.enabled && !saved.runtime.allocated)"
                variant="outlined"
                block
                :disabled="locked || dirty"
                @click="applySaved"
              >
                {{ $t('admin:mail.applySavedSettings') }}
              </v-btn>
              <p class="mail-note">{{ $t('admin:mail.allocatedTransportConfigurationEvidence') }}</p>
            </div>
            <div class="mail-aside-note">
              <v-icon icon="mdi-text-box-check-outline" size="22" />
              <div>
                <strong>{{ $t('admin:mail.oneChannelImportantMoments') }}</strong>
                <p>{{ $t('admin:mail.invitationsVerificationPasswordRecovery') }}</p>
              </div>
            </div>
          </aside>
        </div>
        <div v-if="dirty" class="mail-draft-bar" :aria-label="$t('admin:mail.mailDraftActions')">
          <div>
            <strong>{{ $t('admin:mail.unsavedChangesCount', { count: changes.length }) }}</strong>
            <span>{{ $t('admin:mail.reviewBeforeApplyingOutgoing') }}</span>
          </div>
          <div class="mail-inline-actions">
            <v-btn variant="text" :disabled="busy" @click="askDiscard(reset)">{{ $t('admin:mail.resetChanges') }}</v-btn>
            <v-btn color="primary" :disabled="locked || issues.length > 0" @click="openReview">{{ $t('admin:mail.reviewChanges') }}</v-btn>
          </div>
        </div>
      </template>
    </div>
    <v-dialog v-model="reviewOpen" max-width="720" persistent aria-labelledby="mail-review-title">
      <v-card class="mail-dialog">
        <v-card-title id="mail-review-title">{{ $t('admin:mail.reviewMailChanges') }}</v-card-title>
        <v-card-text>
          <p>{{ $t('admin:mail.saveTheseSettingsApply') }}</p>
          <div class="mail-review-list">
            <div v-for="change in changes" :key="change.key">
              <strong>{{ change.label }}</strong>
              <span v-if="change.before !== undefined">
                {{ change.before || $t('admin:mail.empty') }}
                <v-icon icon="mdi-arrow-right" size="16" />
                {{ change.after || $t('admin:mail.empty') }}
              </span>
              <span v-else>{{ change.after }}</span>
            </div>
          </div>
          <v-textarea v-model="reason" :label="$t('admin:mail.reasonChange')" variant="outlined" rows="2" maxlength="1000" :disabled="busy" hide-details />
          <v-alert v-if="reviewError" type="error" variant="tonal" class="mt-4">{{ reviewError }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-btn :disabled="busy" @click="reviewOpen = false">{{ $t('admin:mail.keepEditing') }}</v-btn>
          <v-spacer />
          <v-btn color="primary" :loading="busy" :disabled="reason.trim().length < 3 || stale" @click="publish">{{ $t('admin:mail.saveApply') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog v-model="testOpen" max-width="580" persistent aria-labelledby="mail-test-title">
      <v-card class="mail-dialog">
        <v-card-title id="mail-test-title">{{ $t('admin:mail.sendDeliveryTest') }}</v-card-title>
        <v-card-text>
          <p>{{ $t('admin:mail.sendsOneRealEmail') }}</p>
          <v-text-field v-model="recipient" :label="$t('admin:mail.testRecipient2')" type="email" variant="outlined" maxlength="254" :disabled="busy" class="mt-5" />
          <v-alert v-if="lastUncertain" type="warning" variant="tonal" class="mb-4">
            {{ $t('admin:mail.previousTestHasUncertain') }}
          </v-alert>
          <v-checkbox
            v-if="lastUncertain"
            v-model="acknowledgeUncertain"
            :label="$t('admin:mail.iReviewedPreviousUncertain')"
            hide-details
            :disabled="busy"
          />
          <v-checkbox v-model="confirmSend" :label="$t('admin:mail.sendOneTestEmail')" hide-details :disabled="busy" />
          <v-alert v-if="testError" type="error" variant="tonal" class="mt-4">{{ testError }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-btn :disabled="busy" @click="testOpen = false">{{ $t('common:actions.cancel') }}</v-btn>
          <v-spacer />
          <v-btn
            color="primary"
            :loading="busy"
            :disabled="!canCheckSmtp || !isMailAddress(recipient.trim()) || !confirmSend || (!!lastUncertain && !acknowledgeUncertain)"
            @click="sendTest"
          >
            {{ $t('admin:mail.sendTestEmail') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>
<script setup lang="ts">
import { confirmDiscard } from '../common/confirm-dialog.ts'
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
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const route = useRoute(),
  router = useRouter()
const sections = [
  { key: 'transport', title: t('admin:mail.senderTransport') },
  { key: 'signing', title: t('admin:mail.signing') },
  { key: 'templates', title: t('admin:mail.templates') },
  { key: 'diagnostics', title: t('admin:mail.diagnostics') }
]
const tlsModes = [
  { title: t('admin:mail.tlsConnectionStart'), value: 'implicit' },
  { title: t('admin:mail.starttlsRequired'), value: 'starttls' },
  { title: t('admin:mail.starttlsWhenOffered'), value: 'opportunistic' },
  { title: t('admin:mail.plainConnection'), value: 'plain' }
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
  reason = ref(''),
  reviewError = ref(''),
  testError = ref(''),
  recipient = ref(''),
  confirmSend = ref(false),
  acknowledgeUncertain = ref(false)
const receiptMissing = ref(false)
const unconfirmed = ref<MailCheckRequest | null>(null)
const section = computed(() => (sections.some((item) => item.key === route.query.section) ? String(route.query.section) : 'transport'))
const templateKey = computed(() =>
  MAIL_TEMPLATES.some((item) => item.key === route.query.template) ? String(route.query.template) : 'account-welcome'
)
const templateTitle = computed(() => MAIL_TEMPLATES.find((item) => item.key === templateKey.value)?.title || t('admin:mail.email'))
const preview = shallowRef<{ html: string; subject: string } | null>(null),
  previewLoading = ref(false),
  previewError = ref('')
let disposed = false,
  sequence = 0,
  previewSequence = 0,
  timer: ReturnType<typeof setTimeout> | undefined
const labels: Record<string, string> = {
  enabled: t('admin:mail.delivery'),
  senderName: t('admin:mail.senderName2'),
  senderEmail: t('admin:mail.senderEmail2'),
  replyTo: t('admin:mail.replyEmail'),
  host: t('admin:mail.smtpHostname'),
  port: t('admin:mail.smtpPort2'),
  name: t('admin:mail.clientGreetingName'),
  tlsMode: t('admin:mail.connectionSecurity'),
  verifySSL: t('admin:mail.certificateVerification'),
  tlsServerName: t('admin:mail.certificateHostname'),
  user: t('admin:mail.smtpUsername'),
  useDKIM: t('admin:mail.dkimSigning'),
  dkimDomainName: t('admin:mail.signingDomain'),
  dkimKeySelector: t('admin:mail.keySelector'),
  'secret.pass': t('admin:mail.smtpPassword'),
  'secret.dkimPrivateKey': t('admin:mail.dkimPrivateKey2')
}
const fieldLabel = (key: string) => labels[key] || key
const display = (key: string, value: unknown) =>
  key === 'tlsMode' ? tlsTitle(String(value)) : typeof value === 'boolean' ? (value ? t('admin:mail.enabled') : t('admin:mail.disabled')) : String(value ?? '')
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
        after: secrets.value[key].action === 'clear' ? t('admin:mail.removeSavedCredential') : t('admin:mail.replaceSavedCredential')
      })
  return fields
})
const dirty = computed(() => changes.value.length > 0),
  locked = computed(() => busy.value || loading.value || stale.value),
  dialogOpen = computed(() => reviewOpen.value || testOpen.value)
const issues = computed(() => {
  if (!policy.value || !saved.value) return []
  const presence = { ...saved.value.secrets },
    result: string[] = []
  for (const key of ['pass', 'dkimPrivateKey'] as const) {
    const action = secrets.value[key]
    if (action.action !== 'keep') presence[key] = action.action === 'replace' && !!action.value
    if (action.action === 'replace' && !action.value)
      result.push(t('admin:mail.enterReplacementChooseKeep', { fieldLabel: fieldLabel('secret.' + key).toLowerCase(), interpolation: { escapeValue: false } }))
  }
  return [...result, ...mailConfigurationIssues(policy.value, presence)]
})
const tlsHint = computed(
  () =>
    ({
      implicit: t('admin:mail.usuallyPort465Encryption'),
      starttls: t('admin:mail.usuallyPort587Delivery'),
      opportunistic: t('admin:mail.upgradesOnlyWhenServer'),
      plain: t('admin:mail.tlsNotAttemptedEven')
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
    ? t('admin:mail.savedSettingsAwaitApplication')
    : saved.value.runtime.offline
      ? t('admin:mail.pausedOfflineMode')
      : saved.value.runtime.allocated
        ? t('admin:mail.transportAllocated')
        : saved.value.runtime.state === 'invalid'
          ? t('admin:mail.configurationNeedsAttention')
          : t('admin:mail.deliveryPaused')
)
const runtimeDescription = computed(() =>
  !saved.value?.runtime.settingsCurrent
    ? t('admin:mail.runningTransportDiffersSaved')
    : saved.value.runtime.allocated
      ? t('admin:mail.processConfiguredUseSaved')
      : saved.value?.issues[0] || t('admin:mail.noOutgoingTransportAllocated')
)
const dateTime = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? t('admin:mail.unknownTime')
    : date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short'
      })
}
const checkTitle = (kind: MailCheck['kind']) =>
  ({
    connection: t('admin:mail.smtpConnection'),
    dkim: t('admin:mail.dkimDnsRecord'),
    test: t('admin:mail.deliveryTest')
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
    ? { connection: t('admin:mail.connected'), dkim: t('admin:mail.keyMatches'), test: t('admin:mail.smtpAccepted') }[check.kind]
    : { running: t('admin:mail.running'), failed: t('admin:mail.failed'), uncertain: t('admin:mail.uncertain') }[check.state]
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
const message = (cause: unknown) => (cause instanceof Error ? cause.message : t('admin:mail.mailAdministrationUnavailable'))
const status = (cause: unknown) => (cause && typeof cause === 'object' ? Reflect.get(cause, 'status') : undefined)
function reload() {
  askDiscard(() => {
    notice.value = ''
    void load()
  })
}
const discardTitle = t('admin:mail.discardMailDraft'),
  discardMessage = t('admin:mail.unsavedSettingsReplacementCredentials')
async function askDiscard(action: () => void) {
  if (!dirty.value) return action()
  if (!(await confirmDiscard(discardTitle, discardMessage, t('admin:mail.discardDraft')))) return
  reset()
  action()
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
      ? t('admin:mail.mailSettingsSavedApplied')
      : t('admin:mail.mailSettingsWereSaved')
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
      ? t('admin:mail.savedMailTransportWas')
      : t('admin:mail.savedTransportCouldNot')
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
    if (!disposed && seq === sequence) error.value = t('admin:mail.checkRefreshFailed', { cause: message(cause), interpolation: { escapeValue: false } })
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
          ? t('admin:mail.noReceiptHasBeen')
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
    error.value = t('admin:mail.clipboardAccessFailedSelect')
  }
}
function copyCheckLink(id: string) {
  const href = router.resolve({
    query: { ...route.query, section: 'diagnostics', check: id }
  }).href
  void copy(new URL(href, location.origin).toString(), t('admin:mail.receiptLinkCopied'))
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
onBeforeRouteLeave(async () => {
  if (busy.value) return false
  if (!dirty.value) return true
  return !busy.value && (await confirmDiscard(discardTitle, discardMessage, t('admin:mail.discardDraft')))
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
