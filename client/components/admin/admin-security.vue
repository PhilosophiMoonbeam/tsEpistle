<template>
  <v-container fluid class="security-workspace">
    <admin-hero
      icon="mdi-shield-check-outline"
      title="Security"
      description="Set the boundaries for access, browsers and shared files."
    >
      <template #actions
        ><v-btn
          variant="text"
          prepend-icon="mdi-refresh"
          :disabled="busy || initializing"
          :loading="loading"
          @click="reload"
          >Reload policy</v-btn
        ><v-btn
          v-if="dirty || endSessions"
          variant="text"
          :disabled="locked"
          @click="reset"
          >Reset draft</v-btn
        ><v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-check"
          :disabled="locked || (!dirty && !endSessions)"
          @click="review"
          >Review changes</v-btn
        ></template
      >
    </admin-hero>
    <async-state
      v-if="!saved && loading"
      state="loading"
      title="Loading security policy"
    /><async-state
      v-else-if="!saved && loadError"
      state="error"
      title="Security policy is unavailable"
      :message="loadError"
      retry-label="Try again"
      @retry="load"
    />
    <template v-if="saved && draft">
      <v-alert v-if="loadError" type="error" variant="tonal" class="mt-5"
        >{{ loadError
        }}<v-btn variant="text" :disabled="busy" @click="reload"
          >Reload saved policy</v-btn
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
              ? 'Unsaved policy draft'
              : 'Showing saved policy'
          }}</span
        ><span>{{
          saved.runtime.state === 'applied'
            ? 'Runtime configuration current'
            : 'Runtime configuration needs attention'
        }}</span>
      </div>
      <nav class="security-tabs" aria-label="Security sections">
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
              <span class="security-kicker">People & credentials</span>
              <h2>Access & sessions</h2>
              <p>
                Make new sign-ins dependable, and be deliberate about when
                existing access ends.
              </p>
            </div>
            <div class="security-coverage">
              <div>
                <strong>{{ saved.coverage.activeAccounts }}</strong>
                <span>active accounts</span>
              </div>
              <div>
                <strong>
                  {{ saved.coverage.twoFactorEnrolled }}<small>
                    / {{ saved.coverage.formAccounts }}</small
                  ></strong
                >
                <span>workspace two-factor enrolled</span>
              </div>
              <div>
                <strong>{{ saved.coverage.providerManagedAccounts }}</strong>
                <span>provider-managed factors</span>
              </div>
            </div>
            <section class="security-policy-section">
              <div>
                <h3>New passwords</h3>
                <p>
                  The rule applies when a local password is created or replaced.
                  Existing passwords continue to work.
                </p>
              </div>
              <v-text-field
                v-model.number="draft.authPasswordMinLength"
                label="Minimum password length"
                type="number"
                min="12"
                max="64"
                step="1"
                variant="outlined"
                :disabled="locked"
                hint="12–64 Unicode characters. All new passwords must fit within 72 UTF-8 bytes."
                persistent-hint
              />
            </section>
            <section class="security-policy-section">
              <div>
                <h3>A second factor</h3>
                <p>
                  Workspace two-factor authentication covers form-based sign-in.
                  Redirect providers manage their own factors.
                </p>
              </div>
              <v-switch
                v-model="draft.authEnforce2FA"
                label="Require workspace two-factor authentication"
                color="primary"
                inset
                :disabled="locked"
                hint="Enabling this requirement ends existing account sessions. People complete enrollment at their next applicable sign-in."
                persistent-hint
              /><v-btn
                variant="text"
                to="/users"
                prepend-icon="mdi-account-outline"
                >Review accounts</v-btn
              >
            </section>
            <section class="security-policy-section">
              <div>
                <h3>Session tokens</h3>
                <p>
                  A token’s lifetime and its renewal window are separate.
                  Renewal is a grace period after expiration, not a maximum
                  session age.
                </p>
              </div>
              <security-duration
                :key="'life-' + loadedVersion"
                v-model="draft.authJwtExpirationSeconds"
                label="Token lifetime"
                hint="One minute to 30 days. A shorter lifetime causes more frequent token renewal."
                :disabled="locked"
              /><security-duration
                :key="'renew-' + loadedVersion"
                v-model="draft.authJwtRenewalSeconds"
                label="Expired-token renewal window"
                hint="Zero disables renewal after expiry. Up to 365 days; account access is rechecked before renewal."
                :disabled="locked"
              /><v-text-field
                v-model="draft.authJwtAudience"
                label="Token audience"
                variant="outlined"
                :disabled="locked"
                hint="The audience accepted by this workspace. Changing any token policy ends existing account sessions."
                persistent-hint
              />
            </section>
            <section class="security-policy-section security-session-action">
              <div>
                <h3>End existing sessions</h3>
                <p>
                  Require every account to sign in again. This also invalidates
                  outstanding account sign-in and recovery continuations; API
                  credentials remain separate.
                </p>
              </div>
              <v-checkbox
                v-model="endSessions"
                label="End account sessions when this review is saved"
                :disabled="locked"
                color="primary"
                hide-details
              />
              <p class="security-note">
                Your own session will end too. This action is staged until you
                review and save it.
              </p>
            </section>
          </template>
          <template v-else-if="section === 'browser'">
            <div class="security-heading">
              <span class="security-kicker">The browser boundary</span>
              <h2>Browser & transport</h2>
              <p>
                Configure the headers this application sends, with the public
                URL and proxy arrangement in view.
              </p>
            </div>
            <section class="security-policy-section">
              <div>
                <h3>Page protections</h3>
                <p>
                  These controls apply to application responses. A reverse proxy
                  may add or override headers.
                </p>
              </div>
              <v-switch
                v-model="draft.securityIframe"
                label="Block page embedding"
                color="primary"
                inset
                :disabled="locked"
                hint="Send X-Frame-Options: deny to prevent other pages from embedding the workspace."
                persistent-hint
              /><v-switch
                v-model="draft.securityReferrerPolicy"
                label="Keep referrers on the same origin"
                color="primary"
                inset
                :disabled="locked"
                hint="Send Referrer-Policy: same-origin when navigating away."
                persistent-hint
              /><v-switch
                v-model="draft.securityOpenRedirect"
                label="Normalize repeated request slashes"
                color="primary"
                inset
                :disabled="locked"
                hint="Collapses repeated slashes in request URLs. This is not a general validation rule for every redirect destination."
                persistent-hint
              />
            </section>
            <section class="security-policy-section">
              <div>
                <h3>HTTPS & proxy</h3>
                <p class="security-origin">
                  {{ saved.host || 'No public workspace URL configured' }}
                </p>
              </div>
              <v-switch
                v-model="draft.securityTrustProxy"
                label="Trust one reverse proxy hop"
                color="primary"
                inset
                :disabled="locked"
                hint="Use only when requests reach the application through one trusted proxy that controls forwarding headers. Network access to the application must match that arrangement."
                persistent-hint
              /><v-switch
                v-model="draft.securityHSTS"
                label="Remember HTTPS in browsers"
                color="primary"
                inset
                :disabled="locked"
                hint="HSTS asks browsers to use HTTPS for future visits. It does not provision a certificate or configure your reverse proxy."
                persistent-hint
              /><template v-if="draft.securityHSTS"
                ><security-duration
                  :key="'hsts-' + loadedVersion"
                  v-model="draft.securityHSTSDuration"
                  label="HTTPS memory duration"
                  hint="Start with a short duration. Browsers retain a previously received policy until it expires; zero requests that they clear it."
                  :disabled="locked" /><v-checkbox
                  v-model="draft.securityHSTSIncludeSubDomains"
                  label="Apply HTTPS memory to every subdomain"
                  :disabled="locked"
                  hint="Every affected subdomain must support HTTPS before you include it."
                  persistent-hint /></template
              ><v-btn variant="text" to="/ssl" prepend-icon="mdi-lock-outline"
                >HTTPS configuration</v-btn
              >
            </section>
            <section class="security-policy-section">
              <div>
                <h3>Content Security Policy</h3>
                <p>
                  Start with reporting, inspect browser violations across your
                  workspace, then enforce the same directives.
                </p>
              </div>
              <v-select
                v-model="draft.securityCSPMode"
                :items="cspModes"
                label="Content Security Policy mode"
                variant="outlined"
                :disabled="locked"
              /><v-textarea
                v-model="draft.securityCSPDirectives"
                label="CSP directives"
                rows="5"
                auto-grow
                variant="outlined"
                :disabled="locked"
                hint="One lowercase directive per line or separated by semicolons. Reports are visible in browser developer tools; a report collector is not provided here."
                persistent-hint
              /><v-alert
                v-if="draft.securityCSPMode === 'enforce'"
                type="warning"
                variant="tonal"
                >An enforced policy can prevent the interface, editors or
                integrations from loading. New directives must first be saved in
                report-only mode.</v-alert
              >
            </section>
            <section class="security-policy-section">
              <div>
                <h3>Observed response headers</h3>
                <p>
                  From the most recent administration API response. A proxy may
                  handle document responses differently.
                </p>
              </div>
              <dl class="security-headers">
                <div v-for="(value, key) in saved.headers" :key="key">
                  <dt>{{ key }}</dt>
                  <dd>{{ value || 'Not present' }}</dd>
                </div>
              </dl>
            </section>
          </template>
          <template v-else-if="section === 'files'">
            <div class="security-heading">
              <span class="security-kicker">Shared material</span>
              <h2>Files</h2>
              <p>
                Control what new uploads may contain and how stored attachments
                are delivered.
              </p>
            </div>
            <section class="security-policy-section">
              <div>
                <h3>Upload capacity</h3>
                <p>
                  Limits apply to new requests immediately after runtime
                  activation. The upload endpoint accepts one file per request.
                </p>
              </div>
              <v-text-field
                :model-value="draft.uploadMaxFileSize / 1048576"
                label="Maximum file size"
                type="number"
                min="0"
                max="1024"
                step="any"
                suffix="MiB"
                variant="outlined"
                :disabled="locked"
                hint="Up to 1,024 MiB. Set zero to disable new uploads; stored files remain available."
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
                    ? formatBytes(draft.uploadMaxFileSize) + ' per file'
                    : 'New uploads disabled'
                }}</strong>
              </div>
            </section>
            <section class="security-policy-section">
              <div>
                <h3>SVG handling</h3>
                <p>
                  SVG files can contain active content. Sanitization runs before
                  the uploaded file is persisted.
                </p>
              </div>
              <v-switch
                v-model="draft.uploadScanSVG"
                label="Sanitize SVG uploads"
                color="primary"
                inset
                :disabled="locked"
                hint="Applies to newly uploaded SVG files, identified by MIME type or extension. Existing files are not rescanned."
                persistent-hint
              />
            </section>
            <section class="security-policy-section">
              <div>
                <h3>Attachment delivery</h3>
                <p>Choose how the browser opens non-image attachments.</p>
              </div>
              <v-switch
                v-model="draft.uploadForceDownload"
                label="Download non-image attachments"
                color="primary"
                inset
                :disabled="locked"
                hint="Send Content-Disposition: attachment for extensions outside the supported image list. This is delivery behavior, not malware scanning."
                persistent-hint
              />
            </section>
          </template>
          <template v-else-if="section === 'signin'">
            <div class="security-heading">
              <span class="security-kicker">A clear way in</span>
              <h2>Sign-in experience</h2>
              <p>
                Shape the arrival flow while keeping a dependable route to Local
                sign-in.
              </p>
            </div>
            <section class="security-policy-section">
              <div>
                <h3>Provider routing</h3>
                <p>
                  Provider availability and ordering are managed in
                  Authentication.
                </p>
              </div>
              <v-switch
                v-model="draft.authAutoLogin"
                label="Route directly to the first enabled provider"
                color="primary"
                inset
                :disabled="locked"
                hint="Redirect providers open automatically. A form-based first provider keeps the sign-in page visible."
                persistent-hint
              /><v-switch
                v-model="draft.authHideLocal"
                label="Hide Local from the default sign-in choices"
                color="primary"
                inset
                :disabled="locked"
                hint="Requires another enabled, available provider. Local remains reachable from the all-methods recovery page."
                persistent-hint
              />
              <div class="security-recovery">
                <v-icon icon="mdi-key-outline" />
                <div>
                  <strong>All-methods recovery page</strong
                  ><code>{{ origin }}/login?all=1</code>
                  <p>
                    Keep this address available to administrators before
                    changing the default arrival flow.
                  </p>
                </div>
              </div>
              <v-btn
                variant="outlined"
                class="mt-5"
                to="/auth"
                prepend-icon="mdi-shield-account-outline"
                >Manage sign-in methods</v-btn
              >
            </section>
            <section class="security-policy-section">
              <div>
                <h3>Sign-in background</h3>
                <p>
                  Use a workspace asset path or an HTTP(S) image URL. Leave this
                  empty for the built-in background.
                </p>
              </div>
              <v-text-field
                v-model="draft.authLoginBgUrl"
                label="Sign-in background URL"
                variant="outlined"
                :disabled="locked"
                hint="An external image is loaded by visitors’ browsers. Use a workspace asset when appropriate."
                persistent-hint
              /><v-btn variant="outlined" prepend-icon="mdi-image-search-outline" :disabled="locked" @click="browseBackground">Browse workspace assets</v-btn>
            <v-btn
                variant="text"
                :disabled="!draft.authLoginBgUrl || locked"
                @click="previewBackground"
                >Preview image</v-btn
              >
              <div v-if="backgroundPreview" class="security-background-preview">
                <img
                  :src="backgroundPreview"
                  alt="Sign-in background preview"
                  @error="backgroundError = true"
                />
                <p v-if="backgroundError">This image could not be loaded.</p>
              </div>
            </section>
          </template>
          <template v-else>
            <div class="security-heading">
              <span class="security-kicker">Policy record</span>
              <h2>Activity</h2>
              <p>
                The latest 50 reviewed changes, with the reason and number of
                account sessions affected.
              </p>
            </div>
            <async-state
              v-if="!saved.history.length"
              state="empty"
              title="No recorded security changes"
              message="Reviewed policy saves and session actions will appear here."
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
                      ? 'Account #' + event.actorId
                      : 'API administrator'
                  }}
                </p>
                <ul>
                  <li v-for="field in event.fields" :key="field">
                    {{ labels[field] }}
                  </li>
                  <li v-if="event.sessionsEnded">
                    Sessions ended for {{ event.sessionsEnded }} accounts
                  </li>
                </ul>
              </li>
            </ol>
          </template>
        </section>
        <aside class="security-aside">
          <div class="security-panel">
            <span class="security-kicker">Saved policy</span>
            <h3>
              {{
                saved.runtime.state === 'applied'
                  ? 'Configuration current'
                  : 'Activation pending'
              }}
            </h3>
            <p>
              The observed application configuration
              {{
                saved.runtime.state === 'applied' ? 'matches' : 'differs from'
              }}
              the saved policy. Review response headers for the browser-facing behavior.
            </p>
            <dl>
              <div>
                <dt>Last observed</dt>
                <dd>{{ date(saved.runtime.observedAt) }}</dd>
              </div>
              <div>
                <dt>Public address</dt>
                <dd>{{ origin || 'Not configured' }}</dd>
              </div>
            </dl>
            <v-btn
              variant="text"
              :disabled="locked || dirty || endSessions"
              :loading="initializing"
              @click="initialize"
              >Retry runtime activation</v-btn
            >
          </div>
          <div class="security-panel">
            <h3>Related controls</h3>
            <router-link to="/auth"
              >Identity providers
              <v-icon icon="mdi-arrow-top-right" size="16" /></router-link
            ><router-link to="/users"
              >Account access
              <v-icon icon="mdi-arrow-top-right" size="16" /></router-link
            ><router-link to="/api"
              >API credentials <v-icon icon="mdi-arrow-top-right" size="16"
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
          <span class="security-kicker">A deliberate change</span>
          <h2 id="security-review-title">Review security policy</h2>
          <p>
            These values are fixed for this review. Confirm their effect before
            applying the policy.
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
            >Existing account sessions will end, including yours. You must sign
            in again after saving. API credentials are not revoked.</v-alert
          ><v-textarea
            v-model="reason"
            label="Administrative reason"
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
              >Reload saved policy</v-btn
            ></v-alert
          ></v-card-text
        ><v-card-actions
          ><v-btn variant="text" :disabled="busy" @click="reviewing = false"
            >Keep editing</v-btn
          ><v-spacer /><v-btn
            color="primary"
            variant="flat"
            :disabled="busy || stale || reason.trim().length < 3"
            :loading="busy"
            @click="confirm"
            >Save security policy</v-btn
          ></v-card-actions
        ></v-card
      ></v-dialog
    >
    <editor-modal-media v-if="assetPickerOpen" />
  </v-container>
</template>
<script lang="ts">
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
  { key: 'access', title: 'Access & sessions' },
  { key: 'browser', title: 'Browser & transport' },
  { key: 'files', title: 'Files' },
  { key: 'signin', title: 'Sign-in experience' },
  { key: 'activity', title: 'Activity' }
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
      labels: securityPolicyLabels,
      sections,
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
        { title: 'Off', value: 'off' },
        { title: 'Report only', value: 'report-only' },
        { title: 'Enforce', value: 'enforce' }
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
  beforeRouteLeave(): boolean {
    return this.canLeave()
  },
  beforeRouteUpdate(to, from): boolean {
    return (
      !this.busy &&
      !this.initializing &&
      (to.path === from.path || this.canLeave())
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
        !window.confirm('Discard unsaved security policy changes?')
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
        ? (value / 1048576).toLocaleString(undefined, {
            maximumFractionDigits: 3
          }) + ' MiB'
        : 'Invalid capacity'
    },
    displayValue(
      field: keyof SecurityPolicy,
      value: SecurityPolicy[keyof SecurityPolicy]
    ): string {
      if (field === 'authHideLocal') return value ? 'Hidden by default' : 'Visible by default'
      if (typeof value === 'boolean') return value ? 'Enabled' : 'Disabled'
      if (field === 'uploadMaxFileSize')
        return Number(value) === 0
          ? 'Uploads disabled'
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
      return String(value || 'Not set')
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
          'Security policy saved.' +
          (result.sessionsEnded
            ? ` Sessions ended for ${result.sessionsEnded} accounts.`
            : '') +
          (result.activation === 'needs-attention'
            ? ' Runtime activation needs attention.'
            : '')
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
              ? ' The outcome is unconfirmed. Reload before saving again.'
              : '')
          if (this.stale) {
            this.notice =
              'Reload the saved policy before another review. Your draft is retained.'
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
        !window.confirm(
          'Discard this review and load the saved security policy?'
        )
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
            ? 'Runtime security configuration applied.'
            : 'Runtime activation needs attention. Review the observed policy and server diagnostics.'
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
    canLeave(): boolean {
      return (
        !this.busy &&
        !this.initializing &&
        ((!this.dirty &&
          !this.endSessions &&
          !(this.reviewing && this.reason)) ||
          window.confirm('Discard unsaved security policy changes?'))
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
