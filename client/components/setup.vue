<template lang='pug'>
  v-app.setup
    auth-shell.setup-shell(
      :title='product.name'
      heading-id='setup-title'
      :eyebrow='$t(`common:setup.firstRunSetup`, { defaultValue: "First-run setup" })'
      logo-url='/_assets/svg/icon-tsepistle.svg'
      size='wide'
      :busy='loading'
    )
      template(#lead)
        p {{ $t(`common:setup.independentCommunityForkDerived`, { defaultValue: `Independent community fork derived from ${product.upstreamBase}`, upstreamBase: product.upstreamBase, interpolation: { escapeValue: false } }) }}

      v-alert.setup-alert(
        v-model='error'
        type='error'
        variant='tonal'
        icon='mdi-alert-circle-outline'
        closable
        role='alert'
        tabindex='-1'
        ref='setupAlert'
      ) {{ errorMessage }}
      v-alert.setup-alert(
        v-if='!error'
        :model-value='true'
        color='primary'
        variant='tonal'
        icon='mdi-package-variant-closed'
      )
        span {{ $t(`common:setup.youInstalling`, { defaultValue: "You are installing" }) }} #[strong {{ product.name }} {{ product.version }}].
        .text-body-small.mt-1
          a(:href='product.sourceUrl', target='_blank', rel='noopener noreferrer') {{ $t(`common:setup.viewSourceRevision`, { defaultValue: `View source at revision ${product.revision.slice(0, 12)}`, revision: product.revision.slice(0, 12), interpolation: { escapeValue: false } }) }}

      form#setup-form.setup-form(@submit.prevent='install', :aria-busy='loading', novalidate)
        section.setup-section(aria-labelledby='setup-admin-title')
          .setup-section-heading
            .setup-section-icon(aria-hidden='true')
              v-icon(size='21') mdi-shield-account-outline
            div
              h2#setup-admin-title {{ $t(`common:setup.administratorAccount`, { defaultValue: "Administrator account" }) }}
              p {{ $t(`common:setup.createAccountWillManage`, { defaultValue: "Create the account that will manage this wiki." }) }}
          v-row
            v-col(cols='12')
              v-text-field(
                variant='outlined'
                v-model='conf.adminEmail'
                :label='$t(`common:setup.administratorEmail`, { defaultValue: "Administrator email" })'
                :hint='$t(`common:setup.emailAddressAdministratorAccount`, { defaultValue: "The email address of the administrator account." })'
                persistent-hint
                required
                type='email'
                autocomplete='email'
                :error-messages='fieldErrors.adminEmail'
                :disabled='loading'
                ref='adminEmailInput'
                prepend-inner-icon='mdi-email-outline'
              )
            v-col(cols='12', sm='6')
              v-text-field(
                variant='outlined'
                ref='adminPassword'
                counter
                v-model='conf.adminPassword'
                :label='$t(`common:setup.password`, { defaultValue: "Password" })'
                :type="showPassword ? 'text' : 'password'"
                autocomplete='new-password'
                :hint='passwordHint'
                persistent-hint
                required
                loading
                :error-messages='fieldErrors.adminPassword'
                :disabled='loading'
                prepend-inner-icon='mdi-lock-outline'
              )
                template(v-slot:append-inner)
                  password-visibility-toggle(v-model:visible='showPassword', :field='$t(`common:setup.administratorPassword`, { defaultValue: "administrator password" })', :disabled='loading')
                template(v-slot:loader)
                  password-strength(:model-value='conf.adminPassword')
            v-col(cols='12', sm='6')
              v-text-field(
                variant='outlined'
                ref='adminPasswordConfirm'
                counter
                v-model='conf.adminPasswordConfirm'
                :label='$t(`common:setup.confirmPassword`, { defaultValue: "Confirm password" })'
                :type="showPasswordConfirm ? 'text' : 'password'"
                autocomplete='new-password'
                :hint='$t(`common:setup.enterSamePasswordAgain`, { defaultValue: "Enter the same password again." })'
                persistent-hint
                required
                :error-messages='fieldErrors.adminPasswordConfirm'
                :disabled='loading'
                prepend-inner-icon='mdi-lock-check-outline'
              )
                template(v-slot:append-inner)
                  password-visibility-toggle(v-model:visible='showPasswordConfirm', :field='$t(`common:setup.passwordConfirmation`, { defaultValue: "password confirmation" })', :disabled='loading')

        section.setup-section(aria-labelledby='setup-address-title')
          .setup-section-heading
            .setup-section-icon(aria-hidden='true')
              v-icon(size='21') mdi-web
            div
              h2#setup-address-title {{ $t(`common:setup.publicAddress`, { defaultValue: "Public address" }) }}
              p {{ $t(`common:setup.tellWikiWhichUrl`, { defaultValue: "Tell the wiki which URL visitors will use." }) }}
          v-text-field(
            variant='outlined'
            ref='adminSiteUrl'
            v-model='conf.siteUrl'
            :label='$t(`common:setup.siteUrl`, { defaultValue: "Site URL" })'
            :placeholder='$t(`common:setup.httpsWikiExampleCom`, { defaultValue: "https://wiki.example.com" })'
            persistent-placeholder
            :hint='$t(`common:setup.fullPublicUrlWithout`, { defaultValue: "Full public URL without a trailing slash, for example https://wiki.example.com." })'
            persistent-hint
            required
            type='url'
            inputmode='url'
            autocomplete='url'
            :error-messages='fieldErrors.siteUrl'
            :disabled='loading'
            prepend-inner-icon='mdi-link-variant'
          )

        section.setup-section.setup-telemetry(aria-labelledby='setup-telemetry-title')
          .setup-section-heading
            .setup-section-icon(aria-hidden='true')
              v-icon(size='21') mdi-chart-box-outline
            div
              h2#setup-telemetry-title {{ $t(`common:setup.telemetry`, { defaultValue: "Telemetry" }) }}
              p {{ $t(`common:setup.shareAnonymousInstallData`, { defaultValue: "Share anonymous install data to help improve the project." }) }}
          v-switch(
            inset
            color='primary'
            v-model='conf.telemetry'
            :label='$t(`common:setup.allowAnonymousTelemetry`, { defaultValue: "Allow anonymous telemetry" })'
            :disabled='loading'
            aria-describedby='setup-telemetry-details'
            hide-details
          )
          p#setup-telemetry-details.setup-telemetry-details
            | {{ $t(`common:setup.installEachStartupServer`, { defaultValue: "At install and at each startup, the server sends its version, platform, operating system, CPU count, memory, database type and version, and a random install ID." }) }}
            | {{ $t(`common:setup.neverSendsPagesUsers`, { defaultValue: "It never sends pages, users or settings. You can turn this off later in Administration." }) }}

      .setup-actions
        v-btn(
          ref='installButton'
          color='primary'
          type='submit'
          form='setup-form'
          :disabled='loading'
          :loading='loading'
          size='large'
          variant='flat'
          block
        )
          v-icon(start) mdi-check
          span {{ $t(`common:setup.install`, { defaultValue: `Install ${product.name}`, name: product.name, interpolation: { escapeValue: false } }) }}

    v-dialog(:model-value='loading || success', width='420', persistent, aria-labelledby='setup-progress-title')
      v-card.setup-progress(variant='flat' :aria-busy='loading')
        v-progress-linear(v-if='!success' indeterminate color='primary' aria-hidden='true')
        v-card-text.text-center
          .setup-progress-spinner(v-if='!success')
            breeding-rhombus-spinner(
              :animation-duration='2000'
              :size='56'
              color='rgb(var(--v-theme-primary))'
            )
          v-icon.setup-progress-success(v-else icon='mdi-check-circle-outline' size='56' color='success' aria-hidden='true')
          template(v-if='!success')
            .setup-progress-title#setup-progress-title(role='status' aria-live='polite') {{ $t(`common:setup.finalizingInstallation`, { defaultValue: "Finalizing your installation..." }) }}
            .setup-progress-copy {{ $t(`common:setup.justMoment`, { defaultValue: "Just a moment" }) }}
          template(v-else)
            .setup-progress-title#setup-progress-title(role='status' aria-live='polite') {{ $t(`common:setup.installationComplete`, { defaultValue: "Installation complete!" }) }}
            .setup-progress-copy(v-if='readinessChecking') {{ $t(`common:setup.waitingServerReady`, { defaultValue: "Waiting for the server to be ready..." }) }}
            .setup-progress-copy(v-else-if='readinessTimedOut') {{ $t(`common:setup.serverStillStartingClick`, { defaultValue: "The server is still starting. Click Continue to sign in to retry." }) }}
            .setup-progress-copy(v-else) {{ $t(`common:setup.takingYouSign`, { defaultValue: "Taking you to sign in..." }) }}
            v-btn.mt-4(
              color='primary'
              variant='flat'
              autofocus
              :loading='readinessChecking'
              :disabled='readinessChecking'
              @click='continueToLogin'
            ) {{ $t(`common:setup.continueSign`, { defaultValue: "Continue to sign in" }) }}
</template>

<script lang='ts'>
import { markRaw } from 'vue'
import validateValues from '../../shared/validation'
import { newPasswordIssue } from '../../shared/security-policy.ts'
import { BreedingRhombusSpinner } from 'epic-spinners'
import AuthShell from './common/auth-shell.vue'
import PasswordStrength from './common/password-strength.vue'
import PasswordVisibilityToggle from './common/password-visibility-toggle.vue'
import confetti from 'canvas-confetti'
import { getErrorMessage } from '../helpers/root-ui-store'
import { sameOriginJsonFetch } from '../helpers/json-transport.ts'
import { isRecord } from '../helpers/type-guards'
import type { ProductMetadata } from '../../shared/product.ts'
/* global siteConfig */


type SetupConfig = {
  adminEmail: string
  adminPassword: string
  adminPasswordConfirm: string
  siteUrl: string
  telemetry: boolean
}

const SETUP_FIELD_NAMES = ['adminEmail', 'adminPassword', 'adminPasswordConfirm', 'siteUrl'] as const

type FinalizeResponse = {
  ok: boolean
  error: string
}

const SUCCESS_REDIRECT_DELAY_MS = 1000
const READINESS_POLL_INTERVAL_MS = 1000
const READINESS_TIMEOUT_MS = 60_000

function focusComponent (ref: unknown): void {
  if (!ref || typeof ref !== 'object') return
  const candidate = ref as { focus?: unknown, $el?: unknown }
  if (typeof candidate.focus === 'function') {
    candidate.focus()
    return
  }
  if (!candidate.$el || typeof candidate.$el !== 'object') return
  const root = candidate.$el as { focus?: unknown }
  if (typeof root.focus === 'function') root.focus()
}

function normalizeFinalizeResponse (payload: unknown): FinalizeResponse {
  if (!isRecord(payload) || typeof payload.ok !== 'boolean' || (payload.error !== undefined && typeof payload.error !== 'string')) {
    throw new Error('Setup response is invalid.')
  }
  return {
    ok: payload.ok,
    error: typeof payload.error === 'string' ? payload.error : ''
  }
}
export default {
  components: {
    AuthShell,
    BreedingRhombusSpinner,
    PasswordStrength,
    PasswordVisibilityToggle
  },

  data() {
    return {
      loading: false,
      success: false,
      error: false,
      errorMessage: '',
      fieldErrors: {
        adminEmail: '',
        adminPassword: '',
        adminPasswordConfirm: '',
        siteUrl: ''
      },
      product: siteConfig.product as ProductMetadata,
      conf: {
        adminEmail: '',
        adminPassword: '',
        adminPasswordConfirm: '',
        siteUrl: '',
        telemetry: true
      } as SetupConfig,
      showPassword: false,
      showPasswordConfirm: false,
      // First-run setup has no policy endpoint yet; the server enforces the same minimum.
      passwordHint: this.$t('common:setup.least12CharactersNo', { defaultValue: "At least 12 characters; no more than 72 UTF-8 bytes." }),
      focusTimer: null as number | null,
      redirectTimer: null as number | null,
      readinessTimer: null as number | null,
      readinessTimeoutTimer: null as number | null,
      readinessWaitResolve: null as (() => void) | null,
      readinessController: null as AbortController | null,
      readinessGeneration: 0,
      readinessDeadlineReached: false,
      readinessChecking: false,
      readinessTimedOut: false,
      navigationStarted: false,
      isDisposed: false
    }
  },
  mounted() {
    this.focusTimer = window.setTimeout(() => {
      this.focusTimer = null
      if (!this.isDisposed) focusComponent(this.$refs.adminEmailInput)
    }, 500)
  },
  beforeUnmount() {
    this.readinessGeneration += 1
    this.isDisposed = true
    if (this.focusTimer !== null) {
      window.clearTimeout(this.focusTimer)
      this.focusTimer = null
    }
    if (this.redirectTimer !== null) {
      window.clearTimeout(this.redirectTimer)
      this.redirectTimer = null
    }
    if (this.readinessTimer !== null) {
      window.clearTimeout(this.readinessTimer)
      this.readinessTimer = null
    }
    if (this.readinessWaitResolve !== null) {
      const resolveReadinessWait = this.readinessWaitResolve
      this.readinessWaitResolve = null
      resolveReadinessWait()
    }
    if (this.readinessTimeoutTimer !== null) {
      window.clearTimeout(this.readinessTimeoutTimer)
      this.readinessTimeoutTimer = null
    }
    if (this.readinessController !== null) {
      this.readinessController.abort()
      this.readinessController = null
    }
  },
  methods: {
    async install () {
      if (this.loading || this.success) return
      this.fieldErrors = {
        adminEmail: '',
        adminPassword: '',
        adminPasswordConfirm: '',
        siteUrl: ''
      }
      this.error = false

      let validationResults = validateValues(this.conf, {
        adminEmail: {
          presence: {
            allowEmpty: false
          },
          email: true
        },
        adminPassword: {
          presence: {
            allowEmpty: false
          },
          length: {
            minimum: 12
          }
        },
        adminPasswordConfirm: {
          equality: 'adminPassword'
        },
        siteUrl: {
          presence: {
            allowEmpty: false
          },
          url: {
            schemes: ['http', 'https'],
            allowLocal: true,
            allowDataUrl: false
          },
          format: {
            pattern: '^(?!.*/$).*$',
            flags: 'i',
            message: this.$t('common:setup.mustNotHaveTrailing', { defaultValue: "must not have a trailing slash" })
        }
        }
      }, {
        fullMessages: false
      })
      const passwordIssue = newPasswordIssue(this.conf.adminPassword)
      if (passwordIssue) validationResults = { ...validationResults, adminPassword: [passwordIssue] }
      if (validationResults) {
        for (const field of SETUP_FIELD_NAMES) {
          this.fieldErrors[field] = validationResults[field]?.[0] ?? ''
        }
        const firstField = SETUP_FIELD_NAMES.find(field => this.fieldErrors[field])
        if (!firstField) return
        this.error = true
        this.errorMessage = this.fieldErrors[firstField]
        this.$nextTick(() => {
          focusComponent(this.$refs[firstField === 'adminEmail' ? 'adminEmailInput' : firstField === 'adminPassword' ? 'adminPassword' : firstField === 'adminPasswordConfirm' ? 'adminPasswordConfirm' : 'adminSiteUrl'])
        })
        return
      }

      this.loading = true
      this.success = false

      // Finalization is non-idempotent. Let the server resolve it rather than
      // creating an ambiguous retry state by aborting an in-flight request.

      try {
        const response = await sameOriginJsonFetch(window.fetch.bind(window), '/finalize', {
          method: 'POST',
          cache: 'no-cache',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(this.conf)
        })
        const resp = normalizeFinalizeResponse(await response.json())
        if (this.isDisposed) return

        if (!resp.ok) {
          this.error = true
          this.errorMessage = resp.error || this.$t('common:setup.setupCouldNotCompleted', { defaultValue: "Setup could not be completed. Please try again." })
          this.loading = false
          this.$nextTick(() => focusComponent(this.$refs.installButton))
          return
        }

        this.success = true
        try {
          if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            confetti({
              particleCount: 100,
              spread: 70,
              zIndex: 100000,
              disableForReducedMotion: true,
            })
          }
        } catch (celebrationError) {
          console.error(celebrationError)
        }
        this.redirectTimer = window.setTimeout(() => {
          this.redirectTimer = null
          this.continueToLogin()
        }, SUCCESS_REDIRECT_DELAY_MS)
      } catch (err) {
        if (this.isDisposed) return
        console.error(err)
        this.error = true
        this.errorMessage = getErrorMessage(err)
        this.loading = false
        this.$nextTick(() => focusComponent(this.$refs.installButton))
      }
    },
    continueToLogin () {
      if (this.isDisposed || !this.success || this.navigationStarted) return
      if (this.redirectTimer !== null) {
        window.clearTimeout(this.redirectTimer)
        this.redirectTimer = null
      }
      if (this.readinessChecking) return
      this.startReadinessCheck()
    },
    startReadinessCheck () {
      if (this.isDisposed || !this.success || this.navigationStarted || this.readinessChecking) return

      this.readinessTimedOut = false
      this.readinessDeadlineReached = false
      this.readinessChecking = true
      this.loading = true
      const controller = markRaw(new AbortController())
      this.readinessController = controller
      const deadline = Date.now() + READINESS_TIMEOUT_MS
      const generation = ++this.readinessGeneration
      this.readinessTimeoutTimer = window.setTimeout(() => {
        if (this.isDisposed || this.readinessGeneration !== generation) return
        this.readinessDeadlineReached = true
        controller.abort()
        if (this.readinessTimer !== null) {
          window.clearTimeout(this.readinessTimer)
          this.readinessTimer = null
          const releaseReadinessWait = this.readinessWaitResolve
          this.readinessWaitResolve = null
          releaseReadinessWait?.()
        }
      }, READINESS_TIMEOUT_MS)
      void this.pollReadiness(controller, deadline, generation).catch(error => {
        if (this.isDisposed) return
        console.error(error)
        this.finishReadinessTimeout()
      })
    },
    async pollReadiness (controller: AbortController, deadline: number, generation: number): Promise<void> {
      let timedOut = false
      let waitTimer: number | null = null
      let waitRelease: (() => void) | null = null
      let consecutiveHealthyResponses = 0

      try {
        while (!this.isDisposed && !this.navigationStarted) {
          if (this.readinessDeadlineReached || Date.now() >= deadline) {
            timedOut = true
            break
          }

          try {
            const response = await sameOriginJsonFetch(window.fetch.bind(window), '/healthz', {
              method: 'GET',
              credentials: 'same-origin',
              cache: 'no-store',
              headers: {
                Accept: 'application/json'
              },
              signal: controller.signal
            })
            if (this.isDisposed) return
            if (controller.signal.aborted) {
              timedOut = this.readinessDeadlineReached
              break
            }

            if (response.status === 200) {
              let payload: unknown = null
              try {
                payload = await response.json()
              } catch {
                payload = null
              }
              const healthy =
                !this.isDisposed &&
                !this.navigationStarted &&
                !controller.signal.aborted &&
                Date.now() < deadline &&
                isRecord(payload) &&
                payload.ok === true
              consecutiveHealthyResponses = healthy ? consecutiveHealthyResponses + 1 : 0
              if (consecutiveHealthyResponses >= 2) {
                this.readinessChecking = false
                this.loading = false
                this.navigationStarted = true
                window.location.assign('/login')
                return
              }
            }
            else {
              consecutiveHealthyResponses = 0
            }
          } catch {
            consecutiveHealthyResponses = 0
            if (this.isDisposed) return
            if (controller.signal.aborted) {
              timedOut = this.readinessDeadlineReached
              break
            }
          }

          if (this.isDisposed) return
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            timedOut = true
            break
          }
          await new Promise<void>(resolve => {
            const release = () => {
              if (this.readinessTimer === waitTimer) this.readinessTimer = null
              if (this.readinessWaitResolve === release) this.readinessWaitResolve = null
              resolve()
            }
            waitRelease = release
            waitTimer = window.setTimeout(release, Math.min(READINESS_POLL_INTERVAL_MS, remaining))
            this.readinessTimer = waitTimer
            this.readinessWaitResolve = release
          })
          waitTimer = null
          waitRelease = null
        }
      } finally {
        if (waitTimer !== null) {
          window.clearTimeout(waitTimer)
          if (this.readinessTimer === waitTimer) this.readinessTimer = null
          if (this.readinessWaitResolve === waitRelease) this.readinessWaitResolve = null
          waitTimer = null
          waitRelease = null
        }
        if (this.readinessGeneration === generation) {
          if (this.readinessTimeoutTimer !== null) {
            window.clearTimeout(this.readinessTimeoutTimer)
            this.readinessTimeoutTimer = null
          }
          if (!controller.signal.aborted) controller.abort()
          this.readinessController = null
          this.readinessDeadlineReached = false
        }
      }

      if (timedOut && !this.isDisposed && !this.navigationStarted) this.finishReadinessTimeout()
    },
    finishReadinessTimeout () {
      if (this.isDisposed || this.navigationStarted) return
      this.readinessChecking = false
      this.loading = false
      this.readinessTimedOut = true
    },

  }
}

</script>

<style lang='scss'>
.setup {
  font-family: var(--wiki-font-body);
}

.setup-alert {
  margin: 0 0 var(--wiki-space-4);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  box-shadow: none;

  a {
    color: currentColor;
    font-weight: 650;
    text-underline-offset: var(--wiki-space-1);
  }
}

.setup-form {
  margin-top: var(--wiki-space-2);
  border-top: 1px solid var(--wiki-surface-border);
}

.setup-section {
  padding-block: var(--wiki-space-6);

  & + & {
    border-top: 1px solid var(--wiki-surface-border);
  }
}

.setup-section-heading {
  display: flex;
  gap: var(--wiki-space-3);
  align-items: center;
  margin-bottom: var(--wiki-space-5);

  h2 {
    margin: 0;
    color: rgb(var(--v-theme-on-surface));
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: -.015em;
  }

  p {
    margin: var(--wiki-space-1) 0 0;
    color: var(--wiki-text-muted);
    font-size: .8125rem;
  }
}

.setup-section-icon {
  display: grid;
  width: 2.5rem;
  height: 2.5rem;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 24%, transparent);
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--wiki-accent-warm) 10%, var(--wiki-surface-raised));
  color: var(--wiki-accent-ink);
}

.setup-telemetry {
  .v-switch {
    max-width: 26.25rem;
  }
}

.setup-telemetry-details {
  max-width: 65ch;
  margin: var(--wiki-space-2) 0 0;
  color: var(--wiki-text-muted);
  font-size: .8125rem;
  line-height: 1.55;
}

.setup-actions {
  margin: 0 calc(-1 * var(--wiki-space-8)) calc(-1 * var(--wiki-space-8));
  padding: var(--wiki-space-5) var(--wiki-space-8) var(--wiki-space-6);
  border-top: 1px solid var(--wiki-surface-border);
  border-radius: 0 0 var(--wiki-hero-radius) var(--wiki-hero-radius);
  background: var(--wiki-surface-sunken);

  .v-btn {
    min-height: var(--wiki-control-height);
    border-radius: var(--wiki-control-radius);
    font-weight: 700;
    text-transform: none;
  }
}

.setup-progress {
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--wiki-panel-radius) !important;
  background: var(--wiki-surface-raised) !important;
  box-shadow: var(--wiki-shadow-lg) !important;

  .v-card-text {
    padding: var(--wiki-space-8) var(--wiki-space-6) !important;
  }
}

.setup-progress-spinner {
  display: inline-block;
  width: 3.5rem;
  height: 3.5rem;
  margin-bottom: var(--wiki-space-3);
}

.setup-progress-success {
  display: block;
  margin: 0 auto var(--wiki-space-3);
}

.setup-progress-title {
  color: rgb(var(--v-theme-on-surface));
  font-size: 1.0625rem;
  font-weight: 700;
}

.setup-progress-copy {
  margin-top: var(--wiki-space-1);
  color: var(--wiki-text-muted);
  font-size: .8125rem;
}

@media (max-width: 599px) {
  .setup-section {
    padding-block: var(--wiki-space-5);
  }

  .setup-section-heading {
    align-items: flex-start;
    margin-bottom: var(--wiki-space-4);
  }

  .setup-actions {
    margin: 0 calc(-1 * var(--wiki-space-5)) calc(-1 * var(--wiki-space-6));
    padding: var(--wiki-space-4) var(--wiki-space-5) var(--wiki-space-5);
    border-radius: 0;
  }
}

@media print {
  .setup-actions {
    display: none;
  }
}
</style>
