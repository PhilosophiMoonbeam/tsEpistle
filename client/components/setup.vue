<template lang='pug'>
  v-app.setup
    v-main.setup-main(aria-labelledby='setup-title')
      v-container.setup-shell(fluid)
        v-card.setup-card(:aria-busy='loading')
          header.setup-intro
            .setup-mark(aria-hidden='true')
              img(src='/_assets/svg/icon-tsfranki.svg', alt='')
            .setup-intro-copy
              .setup-eyebrow First-run setup
              h1#setup-title {{ product.name }}
              p Independent community fork derived from {{ product.upstreamBase }}

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
            span You are installing #[strong {{ product.name }} {{ product.version }}].
            .text-body-small.mt-1
              a(:href='product.sourceUrl', target='_blank', rel='noopener noreferrer') View source at revision {{ product.revision.slice(0, 12) }}

          form#setup-form.setup-form(@submit.prevent='install', :aria-busy='loading', novalidate)
            section.setup-section
              .setup-section-heading
                .setup-section-icon
                  v-icon(size='21') mdi-account-shield-outline
                div
                  h2 Administrator account
                  p Create the account that will manage this wiki.
              v-row
                v-col(cols='12')
                  v-text-field(
                    variant='outlined'
                    v-model='conf.adminEmail'
                    label='Administrator Email'
                    hint='The email address of the administrator account.'
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
                    counter='255'
                    v-model='conf.adminPassword'
                    label='Password'
                    :type="pwdMode ? 'password' : 'text'"
                    autocomplete='new-password'
                    hint='At least 8 characters long.'
                    persistent-hint
                    required
                    :error-messages='fieldErrors.adminPassword'
                    :disabled='loading'
                    prepend-inner-icon='mdi-lock-outline'
                  )
                    template(v-slot:append-inner)
                      v-btn(icon type='button' variant='text' size='small' :aria-label="pwdMode ? 'Show administrator password' : 'Hide administrator password'" :disabled='loading' @click='pwdMode = !pwdMode')
                        v-icon(:icon="pwdMode ? 'mdi-eye-off' : 'mdi-eye'")
                v-col(cols='12', sm='6')
                  v-text-field(
                    variant='outlined'
                    ref='adminPasswordConfirm'
                    counter='255'
                    v-model='conf.adminPasswordConfirm'
                    label='Confirm Password'
                    :type="pwdConfirmMode ? 'password' : 'text'"
                    autocomplete='new-password'
                    hint='Enter the same password again.'
                    persistent-hint
                    required
                    :error-messages='fieldErrors.adminPasswordConfirm'
                    :disabled='loading'
                    prepend-inner-icon='mdi-lock-check-outline'
                  )
                    template(v-slot:append-inner)
                      v-btn(icon type='button' variant='text' size='small' :aria-label="pwdConfirmMode ? 'Show password confirmation' : 'Hide password confirmation'" :disabled='loading' @click='pwdConfirmMode = !pwdConfirmMode')
                        v-icon(:icon="pwdConfirmMode ? 'mdi-eye-off' : 'mdi-eye'")

            section.setup-section
              .setup-section-heading
                .setup-section-icon
                  v-icon(size='21') mdi-web
                div
                  h2 Public address
                  p Tell the wiki which URL visitors will use.
              v-text-field(
                variant='outlined'
                ref='adminSiteUrl'
                v-model='conf.siteUrl'
                label='Site URL'
                placeholder='https://wiki.example.com'
                persistent-placeholder
                hint='Full public URL without a trailing slash, for example https://wiki.example.com.'
                persistent-hint
                required
                type='url'
                inputmode='url'
                autocomplete='url'
                :error-messages='fieldErrors.siteUrl'
                :disabled='loading'
                prepend-inner-icon='mdi-link-variant'
              )

            section.setup-section.setup-telemetry
              .setup-section-heading
                .setup-section-icon
                  v-icon(size='21') mdi-chart-box-outline
                div
                  h2 Telemetry
                  p Share anonymous usage data to help improve the project.
              v-switch(
                inset
                color='primary'
                v-model='conf.telemetry'
                label='Allow anonymous telemetry'
                :disabled='loading'
                hide-details
              )
              a.setup-learn(href='https://docs.requarks.io/telemetry', target='_blank', rel='noopener noreferrer') Learn more about telemetry

          v-card-actions.setup-actions
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
              span Install {{ product.name }}

    v-dialog(v-model='loading', width='420', persistent, aria-labelledby='setup-progress-title')
      v-card.setup-progress(variant='flat' :aria-busy='!success')
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
            .setup-progress-title#setup-progress-title(role='status' aria-live='polite') Finalizing your installation...
            .setup-progress-copy Just a moment
          template(v-else)
            .setup-progress-title#setup-progress-title(role='status' aria-live='polite') Installation complete!
            .setup-progress-copy Taking you to sign in...
            v-btn.mt-4(
              color='primary'
              variant='flat'
              autofocus
              @click='continueToLogin'
            ) Continue to sign in
</template>

<script lang='ts'>
import validateValues from '../../shared/validation'
import { BreedingRhombusSpinner } from 'epic-spinners'
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

type FinalizeResponse = {
  ok: boolean
  error: string
}

const SUCCESS_REDIRECT_DELAY_MS = 1000

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
    BreedingRhombusSpinner
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
      pwdMode: true,
      pwdConfirmMode: true,
      focusTimer: null as number | null,
      redirectTimer: null as number | null,
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
    this.isDisposed = true
    if (this.focusTimer !== null) window.clearTimeout(this.focusTimer)
    if (this.redirectTimer !== null) window.clearTimeout(this.redirectTimer)
  },
  methods: {
    async install () {
      if (this.loading) return
      this.fieldErrors = {
        adminEmail: '',
        adminPassword: '',
        adminPasswordConfirm: '',
        siteUrl: ''
      }
      this.error = false

      const validationResults = validateValues(this.conf, {
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
            minimum: 8,
            maximum: 255
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
            message: 'must not have a trailing slash'
        }
        }
      }, {
        fullMessages: false
      })
      if (validationResults) {
        const firstField = Object.keys(validationResults)[0] as 'adminEmail' | 'adminPassword' | 'adminPasswordConfirm' | 'siteUrl'
        this.error = true
        this.errorMessage = validationResults[firstField][0]
        this.fieldErrors[firstField] = this.errorMessage
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
          this.errorMessage = resp.error || 'Setup could not be completed. Please try again.'
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
      if (this.isDisposed) return
      if (this.redirectTimer !== null) {
        window.clearTimeout(this.redirectTimer)
        this.redirectTimer = null
      }
      window.location.assign('/login')
    }
  }
}

</script>

<style lang='scss'>
.setup {
  font-family: var(--wiki-font-body);
}

.setup-main {
  position: relative;
  min-height: 100vh;
  min-height: 100dvh;
  overflow: hidden auto;
  background:
    radial-gradient(
      circle at 14% 10%,
      color-mix(in srgb, var(--wiki-accent-warm) 18%, transparent),
      transparent 32rem
    ),
    radial-gradient(
      circle at 88% 86%,
      color-mix(in srgb, var(--wiki-accent-spectral) 14%, transparent),
      transparent 36rem
    ),
    linear-gradient(
      145deg,
      var(--wiki-surface-sunken),
      rgb(var(--v-theme-background))
    );
  isolation: isolate;

  &::before {
    position: absolute;
    z-index: -1;
    inset: 0;
    background-image:
      linear-gradient(var(--wiki-surface-border) 1px, transparent 1px),
      linear-gradient(90deg, var(--wiki-surface-border) 1px, transparent 1px);
    background-size: var(--wiki-grid-size) var(--wiki-grid-size);
    content: '';
    mask-image: linear-gradient(to bottom, rgb(var(--v-theme-on-surface)), transparent 88%);
    opacity: .48;
    pointer-events: none;
  }
}

.setup-shell {
  display: grid;
  width: min(100%, 61.25rem);
  min-height: 100dvh;
  margin: 0 auto;
  padding: clamp(var(--wiki-space-6), 5vh, var(--wiki-space-12)) var(--wiki-page-gutter) !important;
  place-items: center;
}

.setup-card {
  width: 100%;
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--wiki-hero-radius) !important;
  background: color-mix(
    in srgb,
    rgb(var(--v-theme-surface)) 97%,
    rgb(var(--v-theme-background))
  ) !important;
  box-shadow: var(--wiki-shadow-lg), var(--wiki-shadow-inset) !important;
}

.setup-intro {
  display: flex;
  gap: var(--wiki-space-5);
  align-items: center;
  padding: var(--wiki-space-8) var(--wiki-space-8) var(--wiki-space-6);
}

.setup-mark,
.setup-section-icon {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 24%, transparent);
  background: color-mix(in srgb, var(--wiki-accent-warm) 10%, var(--wiki-surface-raised));
  color: var(--wiki-accent-warm);
}

.setup-mark {
  width: 4rem;
  height: 4rem;
  overflow: hidden;
  border-radius: var(--wiki-panel-radius);
  box-shadow: var(--wiki-shadow-sm);

  img {
    display: block;
    width: 100%;
    height: 100%;
  }
}

.setup-intro-copy {
  min-width: 0;

  h1 {
    margin: var(--wiki-space-1) 0;
    color: rgb(var(--v-theme-on-surface));
    font-size: clamp(1.75rem, 4vw, 2.25rem);
    font-weight: 740;
    letter-spacing: -.045em;
    line-height: var(--wiki-leading-heading);
  }

  p {
    margin: 0;
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
    font-size: .875rem;
  }
}

.setup-eyebrow {
  color: var(--wiki-accent-warm);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .1em;
  line-height: 1rem;
  text-transform: uppercase;
}

.setup-alert {
  margin: 0 var(--wiki-space-8) var(--wiki-space-4);
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
  border-top: 1px solid var(--wiki-surface-border);
}

.setup-section {
  padding: var(--wiki-space-6) var(--wiki-space-8);

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
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
    font-size: .8125rem;
  }
}

.setup-section-icon {
  width: 2.5rem;
  height: 2.5rem;
  border-radius: var(--wiki-control-radius);
}

.setup-telemetry {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  column-gap: var(--wiki-space-6);

  .setup-section-heading {
    grid-column: 1 / -1;
  }

  .v-switch {
    max-width: 26.25rem;
  }
}

.setup-learn {
  display: inline-block;
  margin-bottom: var(--wiki-space-2);
  color: var(--wiki-accent-warm);
  font-size: .8125rem;
  font-weight: 650;
  text-decoration-thickness: .0625rem;
  text-underline-offset: var(--wiki-space-1);

  &:hover,
  &:focus-visible {
    text-decoration-thickness: .125rem;
  }
}

.setup-actions {
  padding: var(--wiki-space-5) var(--wiki-space-8) var(--wiki-space-6);
  border-top: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-sunken);

  .v-btn {
    min-height: var(--wiki-control-height);
    border-radius: var(--wiki-control-radius);
    font-weight: 700;
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
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
  font-size: .8125rem;
}

@media (max-width: 599px) {
  .setup-main {
    background: color-mix(
      in srgb,
      rgb(var(--v-theme-surface)) 96%,
      rgb(var(--v-theme-background))
    );
  }

  .setup-shell {
    align-items: start;
    padding: 0 !important;
  }

  .setup-card {
    min-height: 100dvh;
    border: 0;
    border-radius: 0 !important;
    box-shadow: none !important;
  }

  .setup-intro {
    gap: var(--wiki-space-3);
    padding: var(--wiki-space-6) var(--wiki-space-5) var(--wiki-space-5);
  }

  .setup-mark {
    width: 3.25rem;
    height: 3.25rem;
  }

  .setup-intro-copy {
    h1 {
      font-size: 1.625rem;
    }

    p {
      font-size: .8125rem;
    }
  }

  .setup-alert {
    margin: 0 var(--wiki-space-4) var(--wiki-space-3);
  }

  .setup-section {
    padding: var(--wiki-space-5);
  }

  .setup-section-heading {
    align-items: flex-start;
    margin-bottom: var(--wiki-space-4);
  }

  .setup-telemetry {
    display: block;
  }

  .setup-learn {
    margin-top: var(--wiki-space-2);
    margin-bottom: 0;
  }

  .setup-actions {
    padding: var(--wiki-space-4) var(--wiki-space-5) var(--wiki-space-5);
  }
}

@media (max-height: 700px) and (min-width: 600px) {
  .setup-shell {
    align-items: start;
    padding-block: var(--wiki-space-5) !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  .setup *,
  .setup *::before,
  .setup *::after {
    transition-duration: .01ms !important;
    animation-duration: .01ms !important;
  }
}

@media print {
  .setup-main {
    background: transparent !important;

    &::before {
      display: none;
    }
  }

  .setup-shell {
    padding: 0 !important;
  }

  .setup-card {
    border: 0;
    box-shadow: none !important;
  }

  .setup-actions {
    display: none;
  }
}
</style>
