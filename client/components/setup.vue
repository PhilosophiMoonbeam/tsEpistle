<template lang='pug'>
  v-app.setup
    v-main.setup-main
      v-container.setup-shell(fluid)
        v-card.setup-card
          header.setup-intro
            .setup-mark(aria-hidden='true')
              img(src='/_assets/svg/icon-tsfranki.svg', alt='')
            .setup-intro-copy
              .setup-eyebrow First-run setup
              h1 {{ product.name }}
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

          form#setup-form.setup-form(@submit.prevent='install')
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
                    hint='At least 8 characters long.'
                    persistent-hint
                    required
                    :error-messages='fieldErrors.adminPassword'
                    prepend-inner-icon='mdi-lock-outline'
                  )
                    template(v-slot:append-inner)
                      v-btn(icon variant='text' size='small' :aria-label="pwdMode ? 'Show password' : 'Hide password'" @click='pwdMode = !pwdMode')
                        v-icon(:icon="pwdMode ? 'mdi-eye-off' : 'mdi-eye'")
                v-col(cols='12', sm='6')
                  v-text-field(
                    variant='outlined'
                    ref='adminPasswordConfirm'
                    counter='255'
                    v-model='conf.adminPasswordConfirm'
                    label='Confirm Password'
                    :type="pwdConfirmMode ? 'password' : 'text'"
                    hint='Enter the same password again.'
                    persistent-hint
                    required
                    :error-messages='fieldErrors.adminPasswordConfirm'
                    prepend-inner-icon='mdi-lock-check-outline'
                  )
                    template(v-slot:append-inner)
                      v-btn(icon variant='text' size='small' :aria-label="pwdConfirmMode ? 'Show password' : 'Hide password'" @click='pwdConfirmMode = !pwdConfirmMode')
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
                hint='Full public URL without a trailing slash, for example https://wiki.example.com.'
                persistent-hint
                required
                type='url'
                inputmode='url'
                autocomplete='url'
                :error-messages='fieldErrors.siteUrl'
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
                hide-details
              )
              a.setup-learn(href='https://docs.requarks.io/telemetry', target='_blank', rel='noopener noreferrer') Learn more about telemetry

          v-card-actions.setup-actions
            v-btn(
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
      v-card.setup-progress(color='primary')
        v-card-text.text-center
          .setup-progress-spinner(v-if='!success')
            breeding-rhombus-spinner(
              :animation-duration='2000'
              :size='56'
              color='#FFF'
            )
          v-icon.setup-progress-success(v-else icon='mdi-check-circle-outline' size='56' color='white' aria-hidden='true')
          template(v-if='!success')
            .setup-progress-title#setup-progress-title(role='status' aria-live='polite') Finalizing your installation...
            .setup-progress-copy Just a moment
          template(v-else)
            .setup-progress-title#setup-progress-title(role='status' aria-live='polite') Installation complete!
            .setup-progress-copy Redirecting...
</template>

<script lang='ts'>
import _ from 'lodash'
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

function focusComponent (ref: unknown): void {
  if (!ref || typeof ref !== 'object') return
  const candidate = ref as { focus?: unknown }
  if (typeof candidate.focus === 'function') candidate.focus()
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
      pwdConfirmMode: true
    }
  },
  mounted() {
    _.delay(() => {
      focusComponent(this.$refs.adminEmailInput)
    }, 500)
  },
  methods: {
    async install () {
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
      this.$forceUpdate()

      _.delay(async () => {
        try {
          const resp = await sameOriginJsonFetch(window.fetch.bind(window), '/finalize', {
            method: 'POST',
            cache: 'no-cache',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(this.conf)
          }).then(async res => normalizeFinalizeResponse(await res.json()))

          if (resp.ok === true) {
            _.delay(() => {
              confetti({
                particleCount: 100,
                spread: 70,
                zIndex: 100000
              })
              this.success = true
              _.delay(() => {
                window.location.assign('/login')
              }, 3000)
            }, 10000)
          } else {
            this.error = true
            this.errorMessage = resp.error
            this.loading = false
            this.$nextTick(() => focusComponent(this.$refs.setupAlert))
          }
        } catch (err) {
          console.error(err)
          this.error = true
          this.errorMessage = getErrorMessage(err)
          this.loading = false
          this.$nextTick(() => focusComponent(this.$refs.setupAlert))
        }
      }, 1000)
    }
  }
}

</script>

<style lang='scss'>
.setup {
  font-family: 'WikiAgentSans', 'Roboto', sans-serif;
}

.setup-main {
  position: relative;
  min-height: 100vh;
  min-height: 100dvh;
  overflow: hidden auto;
  background:
    radial-gradient(circle at 14% 8%, rgba(var(--v-theme-primary), .28), transparent 29rem),
    radial-gradient(circle at 90% 88%, rgba(99, 102, 241, .18), transparent 32rem),
    linear-gradient(145deg, #0b1220, #172033 58%, #101827);

  &::before {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(255, 255, 255, .025) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, .025) 1px, transparent 1px);
    background-size: 44px 44px;
    content: '';
    mask-image: linear-gradient(to bottom, #000, transparent 92%);
    pointer-events: none;
  }
}

.setup-shell {
  position: relative;
  z-index: 1;
  display: grid;
  width: min(100%, 980px);
  min-height: 100dvh;
  margin: 0 auto;
  padding: clamp(24px, 5vh, 56px) var(--wiki-page-gutter) !important;
  place-items: center;
}

.setup-card {
  width: 100%;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, .16);
  border-radius: 24px !important;
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 96%, transparent) !important;
  box-shadow: 0 30px 90px rgba(3, 7, 18, .34) !important;
  backdrop-filter: blur(20px) saturate(135%);
  -webkit-backdrop-filter: blur(20px) saturate(135%);
}

.setup-intro {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 28px 30px 22px;
}

.setup-mark,
.setup-section-icon {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 22%, transparent);
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, transparent);
  color: rgb(var(--v-theme-primary));
}

.setup-mark {
  width: 64px;
  height: 64px;
  border: 0;
  border-radius: 19px;
  background: transparent;
  box-shadow: none;

  img {
    display: block;
    width: 100%;
    height: 100%;
  }
}

.setup-intro-copy {
  min-width: 0;

  h1 {
    margin: 3px 0 4px;
    color: rgb(var(--v-theme-on-surface));
    font-size: clamp(1.8rem, 4vw, 2.3rem);
    font-weight: 760;
    letter-spacing: -.045em;
    line-height: 1.08;
  }

  p {
    margin: 0;
    color: rgb(var(--v-theme-on-surface));
    font-size: .9rem;
    opacity: .66;
  }
}

.setup-eyebrow {
  color: rgb(var(--v-theme-primary));
  font-size: .67rem;
  font-weight: 760;
  letter-spacing: .12em;
  text-transform: uppercase;
}

.setup-alert {
  margin: 0 30px 14px;
  border-radius: 13px;
}

.setup-form {
  border-top: 1px solid rgba(var(--v-border-color), .1);
}

.setup-section {
  padding: 24px 30px;

  & + & {
    border-top: 1px solid rgba(var(--v-border-color), .1);
  }

  .v-row {
    margin-bottom: -12px;
  }

  .v-field {
    border-radius: var(--wiki-control-radius);
  }
}

.setup-section-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;

  h2 {
    margin: 0;
    color: rgb(var(--v-theme-on-surface));
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: -.015em;
  }

  p {
    margin: 2px 0 0;
    color: rgb(var(--v-theme-on-surface));
    font-size: .8rem;
    opacity: .62;
  }
}

.setup-section-icon {
  width: 40px;
  height: 40px;
  border-radius: 12px;
}

.setup-telemetry {
  .v-switch {
    max-width: 420px;
  }
}

.setup-learn {
  display: inline-block;
  margin-top: 8px;
  color: rgb(var(--v-theme-primary));
  font-size: .78rem;
  font-weight: 620;
  text-decoration: none;

  &:hover,
  &:focus-visible {
    text-decoration: underline;
    text-underline-offset: .2em;
  }
}

.setup-actions {
  padding: 18px 30px 24px;
  border-top: 1px solid rgba(var(--v-border-color), .1);
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 4%, rgb(var(--v-theme-surface)));

  .v-btn {
    min-height: 50px;
    border-radius: 12px;
    font-weight: 700;
  }
}

.setup-progress {
  border-radius: 18px !important;

  .v-card-text {
    padding: 30px 24px 28px !important;
  }
}

.setup-progress-spinner {
  display: inline-block;
  width: 56px;
  height: 56px;
  margin-bottom: 12px;
}
.setup-progress-success {
  display: block;
  margin: 0 auto 12px;
}

.setup-progress-title {
  color: #fff;
  font-size: 1.05rem;
  font-weight: 700;
}

.setup-progress-copy {
  margin-top: 3px;
  color: rgba(255, 255, 255, .72);
  font-size: .82rem;
}

@media (max-width: 599px) {
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
    gap: 14px;
    padding: 22px 20px 18px;
  }

  .setup-mark {
    width: 54px;
    height: 54px;
    border-radius: 16px;
  }

  .setup-intro-copy {
    h1 {
      font-size: 1.65rem;
    }

    p {
      font-size: .8rem;
    }
  }

  .setup-alert {
    margin: 0 16px 12px;
  }

  .setup-section {
    padding: 20px;
  }

  .setup-section-heading {
    align-items: flex-start;
  }

  .setup-actions {
    padding: 16px 20px 20px;
  }
}

@media (max-height: 700px) and (min-width: 600px) {
  .setup-shell {
    align-items: start;
    padding-block: 20px !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  .setup * {
    transition-duration: .01ms !important;
  }
}
</style>
