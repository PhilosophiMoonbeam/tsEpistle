<template>
  <v-container fluid class="security-workspace">
    <admin-hero
      icon="mdi-shield-check-outline"
      :title="$t('admin:security.title')"
      :description="$t('admin:security.setBoundariesAccessBrowsers')"
    >
      <template #actions
        ><v-btn
          variant="text"
          prepend-icon="mdi-refresh"
          :disabled="busy || initializing"
          :loading="loading"
          @click="reload"
          >{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ $t('admin:security.reloadSavedSecurityPolicy') }}</v-tooltip></v-btn
        ><v-btn
          v-if="dirty || endSessions"
          variant="text"
          :disabled="locked"
          @click="reset"
          >{{ $t('admin:security.resetDraft') }}</v-btn
        ><v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-check"
          :disabled="locked || (!dirty && !endSessions)"
          @click="review"
          >{{ $t('admin:security.reviewChanges') }}</v-btn
        ></template
      >
    </admin-hero>
    <async-state
      v-if="!saved && loading"
      state="loading"
      :title="$t('admin:security.loadingSecurityPolicy')"
    /><async-state
      v-else-if="!saved && loadError"
      state="error"
      :title="$t('admin:security.securityPolicyUnavailable')"
      :message="loadError"
      :retry-label="$t('admin:security.tryAgain')"
      @retry="load"
    />
    <template v-if="saved && draft">
      <v-alert v-if="loadError" type="error" variant="tonal" class="mt-5"
        >{{ loadError
        }}<v-btn variant="text" :disabled="busy" @click="reload"
          >{{ $t('admin:security.reloadSavedPolicy') }}</v-btn
        ></v-alert
      ><v-alert
        v-if="notice"
        :type="attention ? 'warning' : 'success'"
        variant="tonal"
        class="mt-5"
        >{{ notice }}</v-alert
      >
      <div class="security-status">
        <span
          ><i :class="dirty || endSessions ? 'is-draft' : ''" />{{
            dirty || endSessions
              ? $t('admin:security.unsavedPolicyDraft')
              : $t('admin:security.showingSavedPolicy')
          }}</span
        ><span>{{
          saved.runtime.state === 'applied'
            ? $t('admin:security.runtimeConfigurationCurrent')
            : $t('admin:security.runtimeConfigurationNeedsAttention')
        }}</span>
      </div>
      <nav class="security-tabs" :aria-label="$t('admin:security.securitySections')">
        <button
          v-for="tab in sections"
          :key="tab.key"
          type="button"
          :aria-current="section === tab.key ? 'page' : undefined"
          :disabled="busy || initializing"
          @click="selectSection(tab.key)"
        >
          {{ tab.title }}
        </button>
      </nav>
      <div class="security-layout">
        <section class="security-editor">
          <template v-if="section === 'access'">
            <div class="security-heading">
              <span class="security-kicker">{{ $t('admin:security.peopleCredentials') }}</span>
              <h2>{{ $t('admin:security.accessSessions') }}</h2>
              <p>
                {{ $t('admin:security.makeNewSignIns') }}
              </p>
            </div>
            <div class="security-coverage">
              <div>
                <strong>{{ saved.coverage.activeAccounts }}</strong>
                <span>{{ $t('admin:security.activeAccounts') }}</span>
              </div>
              <div>
                <strong>
                  {{ saved.coverage.twoFactorEnrolled }}<small>
                    / {{ saved.coverage.formAccounts }}</small
                  ></strong
                >
                <span>{{ $t('admin:security.workspaceTwoFactorEnrolled') }}</span>
              </div>
              <div>
                <strong>{{ saved.coverage.providerManagedAccounts }}</strong>
                <span>{{ $t('admin:security.providerManagedFactors') }}</span>
              </div>
            </div>
            <section class="security-policy-section">
              <div>
                <h3>{{ $t('admin:security.newPasswords') }}</h3>
                <p>
                  {{ $t('admin:security.ruleAppliesWhenLocal') }}
                </p>
              </div>
              <v-text-field
                v-model.number="draft.authPasswordMinLength"
                :label="$t('admin:security.fieldLabels.authPasswordMinLength')"
                type="number"
                min="12"
                max="64"
                step="1"
                variant="outlined"
                :disabled="locked"
                :hint="$t('admin:security.n1264UnicodeCharacters')"
                persistent-hint
              />
            </section>
            <section class="security-policy-section">
              <div>
                <h3>{{ $t('admin:security.secondFactor') }}</h3>
                <p>
                  {{ $t('admin:security.workspaceTwoFactorAuthentication') }}
                </p>
              </div>
              <v-switch
                v-model="draft.authEnforce2FA"
                :label="$t('admin:security.fieldLabels.authEnforce2FA')"
                color="primary"
                inset
                :disabled="locked"
                :hint="$t('admin:security.enablingRequirementEndsExisting')"
                persistent-hint
              /><v-btn
                variant="text"
                to="/users"
                prepend-icon="mdi-account-outline"
                >{{ $t('admin:security.reviewAccounts') }}</v-btn
              >
            </section>
            <section class="security-policy-section">
              <div>
                <h3>{{ $t('admin:security.sessionTokens') }}</h3>
                <p>
                  {{ $t('admin:security.tokensLifetimeRenewalWindow') }}
                </p>
              </div>
              <security-duration
                :key="'life-' + loadedVersion"
                v-model="draft.authJwtExpirationSeconds"
                :label="$t('admin:security.fieldLabels.authJwtExpirationSeconds')"
                :hint="$t('admin:security.oneMinute30Days')"
                :disabled="locked"
              /><security-duration
                :key="'renew-' + loadedVersion"
                v-model="draft.authJwtRenewalSeconds"
                :label="$t('admin:security.fieldLabels.authJwtRenewalSeconds')"
                :hint="$t('admin:security.zeroDisablesRenewalAfter')"
                :disabled="locked"
              /><v-text-field
                v-model="draft.authJwtAudience"
                :label="$t('admin:security.fieldLabels.authJwtAudience')"
                variant="outlined"
                :disabled="locked"
                :hint="$t('admin:security.audienceAcceptedWorkspaceChanging')"
                persistent-hint
              />
            </section>
            <section class="security-policy-section security-session-action">
              <div>
                <h3>{{ $t('admin:security.endExistingSessions') }}</h3>
                <p>
                  {{ $t('admin:security.requireEveryAccountSign') }}
                </p>
              </div>
              <v-checkbox
                v-model="endSessions"
                :label="$t('admin:security.endAccountSessionsWhen')"
                :disabled="locked"
                color="primary"
                hide-details
              />
              <p class="security-note">
                {{ $t('admin:security.ownSessionWillEnd') }}
              </p>
            </section>
          </template>
          <template v-else-if="section === 'browser'">
            <div class="security-heading">
              <span class="security-kicker">{{ $t('admin:security.browserBoundary') }}</span>
              <h2>{{ $t('admin:security.browserTransport') }}</h2>
              <p>
                {{ $t('admin:security.configureHeadersApplicationSends') }}
              </p>
            </div>
            <section class="security-policy-section">
              <div>
                <h3>{{ $t('admin:security.pageProtections') }}</h3>
                <p>
                  {{ $t('admin:security.theseControlsApplyApplication') }}
                </p>
              </div>
              <v-switch
                v-model="draft.securityIframe"
                :label="$t('admin:security.fieldLabels.securityIframe')"
                color="primary"
                inset
                :disabled="locked"
                :hint="$t('admin:security.sendXFrameOptions')"
                persistent-hint
              /><v-switch
                v-model="draft.securityReferrerPolicy"
                :label="$t('admin:security.keepReferrersSameOrigin')"
                color="primary"
                inset
                :disabled="locked"
                :hint="$t('admin:security.sendReferrerPolicySame')"
                persistent-hint
              /><v-switch
                v-model="draft.securityOpenRedirect"
                :label="$t('admin:security.fieldLabels.securityOpenRedirect')"
                color="primary"
                inset
                :disabled="locked"
                :hint="$t('admin:security.collapsesRepeatedSlashesRequest')"
                persistent-hint
              />
            </section>
            <section class="security-policy-section">
              <div>
                <h3>{{ $t('admin:security.httpsProxy') }}</h3>
                <p class="security-origin">
                  {{ saved.host || $t('admin:security.noPublicWorkspaceUrl') }}
                </p>
              </div>
              <v-switch
                v-model="draft.securityTrustProxy"
                :label="$t('admin:security.trustOneReverseProxy')"
                color="primary"
                inset
                :disabled="locked"
                :hint="$t('admin:security.useOnlyWhenRequests')"
                persistent-hint
              /><v-switch
                v-model="draft.securityHSTS"
                :label="$t('admin:security.rememberHttpsBrowsers')"
                color="primary"
                inset
                :disabled="locked"
                :hint="$t('admin:security.hstsAsksBrowsersUse')"
                persistent-hint
              /><template v-if="draft.securityHSTS"
                ><security-duration
                  :key="'hsts-' + loadedVersion"
                  v-model="draft.securityHSTSDuration"
                  :label="$t('admin:security.fieldLabels.securityHSTSDuration')"
                  :hint="$t('admin:security.startShortDurationBrowsers')"
                  :disabled="locked" /><v-checkbox
                  v-model="draft.securityHSTSIncludeSubDomains"
                  :label="$t('admin:security.applyHttpsMemoryEvery')"
                  :disabled="locked"
                  :hint="$t('admin:security.everyAffectedSubdomainMust')"
                  persistent-hint /></template
              ><v-btn variant="text" to="/ssl" prepend-icon="mdi-lock-outline"
                >{{ $t('admin:security.httpsConfiguration') }}</v-btn
              >
            </section>
            <section class="security-policy-section">
              <div>
                <h3>{{ $t('admin:security.contentSecurityPolicy') }}</h3>
                <p>
                  {{ $t('admin:security.startReportingInspectBrowser') }}
                </p>
              </div>
              <v-select
                v-model="draft.securityCSPMode"
                :items="cspModes"
                :label="$t('admin:security.fieldLabels.securityCSPMode')"
                variant="outlined"
                :disabled="locked"
              /><v-textarea
                v-model="draft.securityCSPDirectives"
                :label="$t('admin:security.cspDirectives')"
                rows="5"
                auto-grow
                variant="outlined"
                :disabled="locked"
                :hint="$t('admin:security.oneLowercaseDirectivePer')"
                persistent-hint
              /><v-alert
                v-if="draft.securityCSPMode === 'enforce'"
                type="warning"
                variant="tonal"
                >{{ $t('admin:security.enforcedPolicyCanPrevent') }}</v-alert
              >
            </section>
            <section class="security-policy-section">
              <div>
                <h3>{{ $t('admin:security.observedResponseHeaders') }}</h3>
                <p>
                  {{ $t('admin:security.mostRecentAdministrationApi') }}
                </p>
              </div>
              <dl class="security-headers">
                <div v-for="(value, key) in saved.headers" :key="key">
                  <dt>{{ key }}</dt>
                  <dd>{{ value || $t('admin:security.notPresent') }}</dd>
                </div>
              </dl>
            </section>
          </template>
          <template v-else-if="section === 'files'">
            <div class="security-heading">
              <span class="security-kicker">{{ $t('admin:security.sharedMaterial') }}</span>
              <h2>{{ $t('admin:security.files') }}</h2>
              <p>
                {{ $t('admin:security.controlWhatNewUploads') }}
              </p>
            </div>
            <section class="security-policy-section">
              <div>
                <h3>{{ $t('admin:security.uploadCapacity') }}</h3>
                <p>
                  {{ $t('admin:security.limitsApplyNewRequests') }}
                </p>
              </div>
              <v-text-field
                :model-value="draft.uploadMaxFileSize / 1048576"
                :label="$t('admin:security.fieldLabels.uploadMaxFileSize')"
                type="number"
                min="0"
                max="1024"
                step="any"
                :suffix="$t('admin:security.mib2')"
                variant="outlined"
                :disabled="locked"
                :hint="$t('admin:security.up1024Mib')"
                persistent-hint
                @update:model-value="
                  draft.uploadMaxFileSize = Number($event) * 1048576
                "
              />
              <div class="security-file-measure">
                <v-icon
                  :icon="
                    draft.uploadMaxFileSize
                      ? 'mdi-file-upload-outline'
                      : 'mdi-upload-off-outline'
                  "
                /><strong>{{
                  draft.uploadMaxFileSize
                    ? $t('admin:security.perFile', { uploadMaxFileSize: formatBytes(draft.uploadMaxFileSize), interpolation: { escapeValue: false } })
                    : $t('admin:security.newUploadsDisabled')
                }}</strong>
              </div>
            </section>
            <section class="security-policy-section">
              <div>
                <h3>{{ $t('admin:security.svgHandling') }}</h3>
                <p>
                  {{ $t('admin:security.svgFilesCanContain') }}
                </p>
              </div>
              <v-switch
                v-model="draft.uploadScanSVG"
                :label="$t('admin:security.fieldLabels.uploadScanSVG')"
                color="primary"
                inset
                :disabled="locked"
                :hint="$t('admin:security.appliesNewlyUploadedSvg')"
                persistent-hint
              />
            </section>
            <section class="security-policy-section">
              <div>
                <h3>{{ $t('admin:security.attachmentDelivery') }}</h3>
                <p>{{ $t('admin:security.chooseHowBrowserOpens') }}</p>
              </div>
              <v-switch
                v-model="draft.uploadForceDownload"
                :label="$t('admin:security.fieldLabels.uploadForceDownload')"
                color="primary"
                inset
                :disabled="locked"
                :hint="$t('admin:security.sendContentDispositionAttachment')"
                persistent-hint
              />
            </section>
          </template>
          <template v-else-if="section === 'signin'">
            <div class="security-heading">
              <span class="security-kicker">{{ $t('admin:security.clearWay') }}</span>
              <h2>{{ $t('admin:security.signExperience') }}</h2>
              <p>
                {{ $t('admin:security.shapeArrivalFlowWhile') }}
              </p>
            </div>
            <section class="security-policy-section">
              <div>
                <h3>{{ $t('admin:security.providerRouting') }}</h3>
                <p>
                  {{ $t('admin:security.providerAvailabilityOrderingManaged') }}
                </p>
              </div>
              <v-switch
                v-model="draft.authAutoLogin"
                :label="$t('admin:security.routeDirectlyFirstEnabled')"
                color="primary"
                inset
                :disabled="locked"
                :hint="$t('admin:security.redirectProvidersOpenAutomatically')"
                persistent-hint
              /><v-switch
                v-model="draft.authHideLocal"
                :label="$t('admin:security.hideLocalDefaultSign')"
                color="primary"
                inset
                :disabled="locked"
                :hint="$t('admin:security.requiresAnotherEnabledAvailable')"
                persistent-hint
              />
              <div class="security-recovery">
                <v-icon icon="mdi-key-outline" />
                <div>
                  <strong>{{ $t('admin:security.allMethodsRecoveryPage') }}</strong
                  ><code>{{ origin }}/login?all=1</code>
                  <p>
                    {{ $t('admin:security.keepAddressAvailableAdministrators') }}
                  </p>
                </div>
              </div>
              <v-btn
                variant="outlined"
                class="mt-5"
                to="/auth"
                prepend-icon="mdi-shield-account-outline"
                >{{ $t('admin:security.manageSignMethods') }}</v-btn
              >
            </section>
            <section class="security-policy-section">
              <div>
                <h3>{{ $t('admin:security.fieldLabels.authLoginBgUrl') }}</h3>
                <p>
                  {{ $t('admin:security.useWorkspaceAssetPath') }}
                </p>
              </div>
              <v-text-field
                v-model="draft.authLoginBgUrl"
                :label="$t('admin:security.signBackgroundUrl')"
                variant="outlined"
                :disabled="locked"
                :hint="$t('admin:security.externalImageLoadedVisitors')"
                persistent-hint
              /><v-btn variant="outlined" prepend-icon="mdi-image-search-outline" :disabled="locked" @click="browseBackground">{{ $t('admin:security.browseWorkspaceAssets') }}</v-btn>
            <v-btn
                variant="text"
                :disabled="!draft.authLoginBgUrl || locked"
                @click="previewBackground"
                >{{ $t('admin:security.previewImage') }}</v-btn
              >
              <div v-if="backgroundPreview" class="security-background-preview">
                <img
                  :src="backgroundPreview"
                  :alt="$t('admin:security.signBackgroundPreview')"
                  @error="backgroundError = true"
                />
                <p v-if="backgroundError">{{ $t('admin:security.imageCouldNotLoaded') }}</p>
              </div>
            </section>
          </template>
          <template v-else>
            <div class="security-heading">
              <span class="security-kicker">{{ $t('admin:security.policyRecord') }}</span>
              <h2>{{ $t('admin:security.activity') }}</h2>
              <p>
                {{ $t('admin:security.latest50ReviewedChanges') }}
              </p>
            </div>
            <async-state
              v-if="!saved.history.length"
              state="empty"
              :title="$t('admin:security.noRecordedSecurityChanges')"
              :message="$t('admin:security.reviewedPolicySavesSession')"
            />
            <ol v-else class="security-activity">
              <li v-for="event in saved.history" :key="event.id">
                <div>
                  <strong>{{ event.reason }}</strong
                  ><time>{{ date(event.createdAt) }}</time>
                </div>
                <p>
                  {{
                    event.actorId
                      ? $t('admin:security.account', { actorId: event.actorId, interpolation: { escapeValue: false } })
                      : $t('admin:security.apiAdministrator')
                  }}
                </p>
                <ul>
                  <li v-for="field in event.fields" :key="field">
                    {{ labels[field] }}
                  </li>
                  <li v-if="event.sessionsEnded">
                    {{ $t('admin:security.sessionsEndedAccounts', { sessionsEnded: event.sessionsEnded, interpolation: { escapeValue: false } }) }}
                  </li>
                </ul>
              </li>
            </ol>
          </template>
        </section>
        <aside class="security-aside">
          <div class="security-panel">
            <span class="security-kicker">{{ $t('admin:security.savedPolicy') }}</span>
            <h3>
              {{
                saved.runtime.state === 'applied'
                  ? $t('admin:security.configurationCurrent')
                  : $t('admin:security.activationPending')
              }}
            </h3>
            <p>
              {{ $t('admin:security.observedApplicationConfigurationSaved', { state: saved.runtime.state === 'applied' ? 'matches' : $t('admin:security.differs'), interpolation: { escapeValue: false } }) }}
            </p>
            <dl>
              <div>
                <dt>{{ $t('admin:security.lastObserved') }}</dt>
                <dd>{{ date(saved.runtime.observedAt) }}</dd>
              </div>
              <div>
                <dt>{{ $t('admin:security.publicAddress') }}</dt>
                <dd>{{ origin || $t('admin:security.notConfigured') }}</dd>
              </div>
            </dl>
            <v-btn
              variant="text"
              :disabled="locked || dirty || endSessions"
              :loading="initializing"
              @click="initialize"
              >{{ $t('admin:security.retryRuntimeActivation') }}</v-btn
            >
          </div>
          <div class="security-panel">
            <h3>{{ $t('admin:security.relatedControls') }}</h3>
            <router-link to="/auth"
              >{{ $t('admin:security.identityProviders') }}
              <v-icon icon="mdi-arrow-top-right" size="16" /></router-link
            ><router-link to="/users"
              >{{ $t('admin:security.accountAccess') }}
              <v-icon icon="mdi-arrow-top-right" size="16" /></router-link
            ><router-link to="/api"
              >{{ $t('admin:security.apiCredentials') }} <v-icon icon="mdi-arrow-top-right" size="16"
            /></router-link>
          </div>
        </aside>
      </div>
    </template>
    <v-dialog
      v-model="reviewing"
      :persistent="busy"
      max-width="800"
      :fullscreen="$vuetify.display.smAndDown"
      aria-labelledby="security-review-title"
      ><v-card v-if="reviewed && saved" class="security-review"
        ><div class="security-review-heading">
          <span class="security-kicker">{{ $t('admin:security.deliberateChange') }}</span>
          <h2 id="security-review-title">{{ $t('admin:security.reviewSecurityPolicy') }}</h2>
          <p>
            {{ $t('admin:security.theseValuesFixedReview') }}
          </p>
        </div>
        <v-card-text
          ><dl v-if="changes.length" class="security-differences">
            <div v-for="field in changes" :key="field">
              <dt>{{ labels[field] }}</dt>
              <dd>
                <span>{{ displayValue(field, saved!.policy[field]) }}</span
                ><v-icon icon="mdi-arrow-right" size="16" /><strong>{{
                  displayValue(field, reviewed![field])
                }}</strong>
              </dd>
            </div>
          </dl>
          <v-alert
            v-if="reviewEndsSessions"
            type="warning"
            variant="tonal"
            class="my-5"
            >{{ $t('admin:security.existingAccountSessionsWill') }}</v-alert
          ><v-textarea
            v-model="reason"
            :label="$t('admin:security.administrativeReason')"
            variant="outlined"
            rows="2"
            maxlength="1000"
            :disabled="busy"
          /><v-alert v-if="saveError" type="error" variant="tonal"
            >{{ saveError
            }}<v-btn
              v-if="stale"
              variant="text"
              :disabled="busy"
              @click="reloadReview"
              >{{ $t('admin:security.reloadSavedPolicy') }}</v-btn
            ></v-alert
          ></v-card-text
        ><v-card-actions
          ><v-btn variant="text" :disabled="busy" @click="reviewing = false"
            >{{ $t('admin:security.keepEditing') }}</v-btn
          ><v-spacer /><v-btn
            color="primary"
            variant="flat"
            :disabled="busy || stale || reason.trim().length < 3"
            :loading="busy"
            @click="confirm"
            >{{ $t('admin:security.saveSecurityPolicy') }}</v-btn
          ></v-card-actions
        ></v-card
      ></v-dialog
    >
    <editor-modal-media v-if="assetPickerOpen" />
  </v-container>
</template>
<script lang="ts">
import { confirmDiscard } from '../common/confirm-dialog.ts'
import { defineAsyncComponent } from 'vue'
import { wikiStore } from '@/store/index.ts'
import { onEditorInsert, offEditorInsert, type EditorInsertPayload } from '../../helpers/editor-insert-events.ts'
import AsyncState from '@/components/common/async-state.vue'
import SecurityDuration from './security-duration.vue'
import {
  fetchSecurityWorkspace,
  saveSecurityWorkspace,
  retrySecurityRuntime,
  type SecurityInspection
} from '../../helpers/security-workspace-api.ts'
import {
  securityPolicyLabels,
  validateSecurityPolicy,
  securityChangedFields,
  securityEndsSessions,
  type SecurityPolicy
} from '../../../shared/security-policy.ts'
import { getErrorMessage } from '../../helpers/root-ui-store.ts'
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const sections = [
  { key: 'access', title: 'admin:security.accessSessions' },
  { key: 'browser', title: 'admin:security.browserTransport' },
  { key: 'files', title: 'admin:security.files' },
  { key: 'signin', title: 'admin:security.signExperience' },
  { key: 'activity', title: 'admin:security.activity' }
]
export default {
  components: {
    AsyncState,
    SecurityDuration,
    editorModalMedia: defineAsyncComponent(() => import('../editor/editor-modal-media.vue')),
  },
  data() {
    return {
      saved: null as SecurityInspection | null,
      draft: null as SecurityPolicy | null,
      reviewed: null as SecurityPolicy | null,
      changes: [] as Array<keyof SecurityPolicy>,
      labels: Object.fromEntries(Object.entries(securityPolicyLabels).map(([key, value]) => [key, this.$t(`admin:security.fieldLabels.${key}`, { defaultValue: value })])) as typeof securityPolicyLabels,
      sections: sections.map((item) => ({ ...item, title: this.$t(item.title) })),
      section: 'access',
      loading: false,
      busy: false,
      initializing: false,
      stale: false,
      loadError: '',
      saveError: '',
      notice: '',
      attention: false,
      sequence: 0,
      loadedVersion: 0,
      disposed: false,
      endSessions: false,
      reviewedEndSessions: false,
      reviewing: false,
      reason: '',
      reviewFingerprint: '',
      selectingBackground: false,
      backgroundPreview: '',
      backgroundError: false,
      cspModes: [
        { title: this.$t('admin:security.off'), value: 'off' },
        { title: this.$t('admin:security.reportOnly'), value: 'report-only' },
        { title: this.$t('admin:security.enforce'), value: 'enforce' }
      ]
    }
  },
  computed: {
    assetPickerOpen(): boolean { return this.selectingBackground && wikiStore.editor.activeModal === 'editorModalMedia' },
    dirty(): boolean {
      return Boolean(
        this.saved &&
        this.draft &&
        securityChangedFields(this.saved.policy, this.draft).length
      )
    },
    locked(): boolean {
      return this.busy || this.initializing || this.loading || this.stale
    },
    reviewEndsSessions(): boolean {
      return Boolean(
        this.reviewedEndSessions ||
        (this.saved &&
          this.reviewed &&
          securityEndsSessions(this.saved.policy, this.reviewed))
      )
    },
    origin(): string {
      try {
        return new URL(this.saved?.host ?? '').origin
      } catch {
        return ''
      }
    },
  },
  watch: {
    '$route.hash': {
      immediate: true,
      handler(hash: string) {
        this.section = sections.some((s) => s.key === hash.slice(1))
          ? hash.slice(1)
          : 'access'
      }
    }
  },
  mounted() {
    void this.load()
    onEditorInsert(this.handleBackgroundSelection)
    window.addEventListener('beforeunload', this.beforeUnload)
  },
  beforeUnmount() {
    offEditorInsert(this.handleBackgroundSelection)
    if (this.assetPickerOpen) wikiStore.editor.activeModal = ''
    this.disposed = true
    this.sequence++
    window.removeEventListener('beforeunload', this.beforeUnload)
  },
  beforeRouteLeave(): Promise<boolean> {
    return this.canLeave()
  },
  async beforeRouteUpdate(to, from): Promise<boolean> {
    return (
      !this.busy &&
      !this.initializing &&
      (to.path === from.path || (await this.canLeave()))
    )
  },
  methods: {
    async load() {
      if (this.busy) return
      const seq = ++this.sequence
      this.loading = true
      this.loadError = ''
      try {
        const result = await fetchSecurityWorkspace()
        if (this.disposed || seq !== this.sequence) return
        this.saved = result
        this.draft = copy(result.policy)
        this.endSessions = false
        this.stale = false
        this.loadedVersion++
      } catch (error) {
        if (!this.disposed && seq === this.sequence) {
          this.loadError = getErrorMessage(error)
          this.stale = true
        }
      } finally {
        if (!this.disposed && seq === this.sequence) this.loading = false
      }
    },
    async reload() {
      if (this.busy || this.initializing) return
      if (
        (this.dirty || this.endSessions) &&
        !(await confirmDiscard(this.$t('admin:security.discardUnsavedSecurityPolicy')))
      )
        return
      await this.load()
    },
    reset() {
      if (this.locked || !this.saved) return
      this.draft = copy(this.saved.policy)
      this.endSessions = false
      this.backgroundPreview = ''
      this.loadedVersion++
    },
    selectSection(key: string) {
      if (!this.busy && !this.initializing)
        void this.$router.replace({
          query: this.$route.query,
          hash: key === 'access' ? '' : '#' + key
        })
    },
    date(value: string) {
      return new Date(value).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short'
      })
    },
    formatBytes(value: number) {
      return Number.isFinite(value)
        ? this.$t('admin:security.mib', { value: (value / 1048576).toLocaleString(undefined, {
            maximumFractionDigits: 3
          }), interpolation: { escapeValue: false } })
        : this.$t('admin:security.invalidCapacity')
    },
    displayValue(
      field: keyof SecurityPolicy,
      value: SecurityPolicy[keyof SecurityPolicy]
    ): string {
      if (field === 'authHideLocal') return value ? this.$t('admin:security.hiddenDefault') : this.$t('admin:security.visibleDefault')
      if (typeof value === 'boolean') return value ? this.$t('admin:security.enabled') : this.$t('admin:security.disabled')
      if (field === 'uploadMaxFileSize')
        return Number(value) === 0
          ? this.$t('admin:security.uploadsDisabled')
          : this.formatBytes(Number(value))
      if (field.endsWith('Seconds') || field === 'securityHSTSDuration') {
        const seconds = Number(value)
        const unit =
          [86400, 3600, 60].find(
            (unit) => seconds > 0 && seconds % unit === 0
          ) ?? 1
        return (
          seconds / unit +
          ' ' +
          ({ 86400: 'days', 3600: 'hours', 60: 'minutes', 1: 'seconds' }[
            unit
          ] ?? 'seconds')
        )
      }
      return String(value || this.$t('admin:security.notSet'))
    },
    review() {
      if (
        this.locked ||
        !this.saved ||
        !this.draft ||
        (!this.dirty && !this.endSessions)
      )
        return
      const validated = validateSecurityPolicy(this.draft)
      if (!validated.ok) {
        this.notice = validated.issues.map((i) => i.message).join(' ')
        this.attention = true
        return
      }
      this.reviewed = copy(validated.value)
      this.changes = securityChangedFields(this.saved.policy, this.reviewed)
      this.reviewFingerprint = this.saved.fingerprint
      this.reviewedEndSessions = this.endSessions
      this.reason = ''
      this.saveError = ''
      this.notice = ''
      this.reviewing = true
    },
    async confirm() {
      if (
        this.busy ||
        this.locked ||
        !this.reviewing ||
        !this.reviewed ||
        this.reason.trim().length < 3
      )
        return
      this.busy = true
      this.saveError = ''
      try {
        const result = await saveSecurityWorkspace(
          this.reviewed,
          this.reviewFingerprint,
          this.reason.trim(),
          this.reviewedEndSessions
        )
        if (this.disposed) return
        this.saved = {
          ...this.saved!,
          policy: copy(this.reviewed),
          runtime: { ...this.saved!.runtime, state: 'pending' }
        }
        this.draft = copy(this.reviewed)
        this.endSessions = false
        this.reviewing = false
        this.reviewed = null
        this.reason = ''
        this.notice =
          this.$t('admin:security.securityPolicySaved', { value: (result.sessionsEnded
            ? ` ${this.$t('admin:security.sessionsEndedSentence', { count: result.sessionsEnded })}`
            : ''), activation: (result.activation === 'needs-attention'
            ? ' Runtime activation needs attention.'
            : ''), interpolation: { escapeValue: false } })
        this.attention = result.activation === 'needs-attention'
        if (result.currentSessionEnded) {
          window.location.assign('/login?all=1')
          return
        }
        this.busy = false
        this.stale = true
        await this.load()
      } catch (error) {
        if (!this.disposed) {
          const status =
            error && typeof error === 'object'
              ? Reflect.get(error, 'status')
              : 0
          this.stale = !status || Number(status) >= 500 || [401, 403, 409].includes(status)
          this.saveError =
            getErrorMessage(error) +
            (!status
              ? ` ${this.$t('admin:security.outcomeUnconfirmedReloadBefore')}`
              : '')
          if (this.stale) {
            this.notice =
              this.$t('admin:security.reloadSavedPolicyBefore')
            this.attention = true
          }
        }
      } finally {
        if (!this.disposed) this.busy = false
      }
    },
    async reloadReview() {
      if (
        this.busy ||
        !(await confirmDiscard(
          this.$t('admin:security.discardReviewLoadSaved')
        ))
      )
        return
      this.reviewing = false
      await this.load()
    },
    async initialize() {
      if (this.locked || this.dirty || this.endSessions || !this.saved) return
      this.initializing = true
      try {
        const result = await retrySecurityRuntime(this.saved.fingerprint)
        this.notice =
          result.activation === 'applied'
            ? this.$t('admin:security.runtimeSecurityConfigurationApplied')
            : this.$t('admin:security.runtimeActivationNeedsAttention2')
        this.attention = result.activation !== 'applied'
        await this.load()
      } catch (error) {
        this.notice = getErrorMessage(error)
        this.attention = true
      } finally {
        this.initializing = false
      }
    },
    browseBackground() { if (this.locked) return; this.selectingBackground = true; wikiStore.editor.editorKey = 'common'; wikiStore.editor.activeModal = 'editorModalMedia' },
    handleBackgroundSelection(event: EditorInsertPayload) { if (this.selectingBackground && !this.locked && this.draft && typeof event.path === 'string') { this.draft.authLoginBgUrl = event.path; this.backgroundPreview = ''; this.selectingBackground = false } },
    previewBackground() {
      if (!this.draft) return
      const result = validateSecurityPolicy(this.draft)
      if (!result.ok) {
        this.notice = result.issues.map((i) => i.message).join(' ')
        this.attention = true
        return
      }
      this.backgroundError = false
      this.backgroundPreview = this.draft.authLoginBgUrl
    },
    async canLeave(): Promise<boolean> {
      return (
        !this.busy &&
        !this.initializing &&
        ((!this.dirty &&
          !this.endSessions &&
          !(this.reviewing && this.reason)) ||
          (await confirmDiscard(this.$t('admin:security.discardUnsavedSecurityPolicy'))))
      )
    },
    beforeUnload(event: BeforeUnloadEvent) {
      if (
        this.busy ||
        this.initializing ||
        this.dirty ||
        this.endSessions ||
        (this.reviewing && this.reason)
      ) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
  }
}
</script>
<style lang="scss" src="./security-workspace.scss"></style>
