<template lang='pug'>
  v-app.page-unlock-app
    main.page-unlock(aria-labelledby='page-unlock-title')
      v-card.page-unlock-card(variant='flat')
        header.page-unlock-context
          .page-unlock-brand
            .page-unlock-logo
              img.page-unlock-logo-image(
                v-if='logoUrl && !logoImageFailed'
                :key='logoUrl'
                :src='logoUrl'
                :data-logo-source='logoUrl'
                alt=''
                @error='handleLogoError'
                @load='handleLogoLoad'
              )
              .page-unlock-logo-fallback(v-else, aria-hidden='true') {{ logoFallback }}
            .page-unlock-brand-title.text-title-large {{ siteTitle }}
          v-icon(size='28', aria-hidden='true') mdi-lock-outline
          h1#page-unlock-title.text-headline-small {{ $t('common:pageUnlock.title') }}
          p.page-unlock-page-title.text-title-medium(v-if='pageTitle') {{ pageTitle }}
          p.text-body-large {{ $t('common:pageUnlock.body') }}
        v-card-text.page-unlock-content
          v-alert#page-unlock-error.mb-4(
            v-if='error'
            type='error'
            variant='tonal'
            role='alert'
          ) {{ error }}
          template(v-if='validPageId')
            //- Native POST stays; the handler only blocks a second submit and shows progress.
            form(:action='`/_unlock/${validPageId}`', method='post', :aria-busy='submitting ? `true` : undefined', @submit='handleSubmit')
              input(type='hidden', name='returnTo', :value='returnTo')
              v-text-field(
                name='password'
                :type='hidePassword ? "password" : "text"'
                :label='$t(`common:pageUnlock.password`)'
                autocomplete='current-password'
                autofocus
                required
                variant='outlined'
                :aria-describedby='error ? "page-unlock-error" : undefined'
                :aria-invalid='error ? "true" : undefined'
              )
                template(v-slot:append-inner)
                  password-visibility-toggle(
                    :visible='!hidePassword'
                    :field='$t(`common:password.fields.pagePassword`)'
                    @update:visible='hidePassword = !$event'
                  )
              v-btn.mt-2(
                type='submit'
                color='primary'
                size='large'
                block
                :loading='submitting'
                :aria-disabled='submitting ? `true` : undefined'
              ) {{ $t('common:pageUnlock.submit') }}
          template(v-else)
            v-alert.mb-4(type='error', variant='tonal', role='alert') {{ $t('common:pageUnlock.unavailable') }}
          v-btn.page-unlock-return(
            variant='outlined'
            color='primary'
            href='/'
            block
            prepend-icon='mdi-home-outline'
          ) {{ $t('common:pageUnlock.returnHome') }}
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { wikiStore } from '@/store/index.ts'
import PasswordVisibilityToggle from './common/password-visibility-toggle.vue'

export default defineComponent({
  components: { PasswordVisibilityToggle },
  data() {
    return {
      failedLogoUrl: null as string | null,
      hidePassword: true,
      submitting: false
    }
  },
  computed: {
    siteTitle (): string {
      return wikiStore.site.title
    },
    logoUrl (): string {
      return wikiStore.site.logoUrl
    },
    logoImageFailed (): boolean { return this.failedLogoUrl === this.logoUrl },
    logoFallback (): string {
      const title = this.siteTitle.trim()
      return title ? title.charAt(0).toUpperCase() : '?'
    },
    validPageId (): number | null {
      return Number.isInteger(this.pageId) && this.pageId > 0 ? this.pageId : null
    }
  },
  props: {
    pageId: {
      type: Number,
      default: null
    },
    pageTitle: {
      type: String,
      default: ''
    },
    returnTo: {
      type: String,
      default: '/'
    },
    error: {
      type: String,
      default: ''
    }
  },
  mounted () {
    window.addEventListener('pageshow', this.resetSubmitting)
  },
  beforeUnmount () {
    window.removeEventListener('pageshow', this.resetSubmitting)
  },
  methods: {
    handleSubmit (event: Event): void {
      // One POST per attempt; a slow network must not send the password twice.
      if (this.submitting) {
        event.preventDefault()
        return
      }
      this.submitting = true
    },
    resetSubmitting (): void {
      // Back/forward cache restores the page with the old busy state.
      this.submitting = false
    },
    handleLogoError (event: Event): void {
      const image = event.currentTarget
      if (!(image instanceof HTMLImageElement)) return
      const source = image.getAttribute('data-logo-source')
      if (!source || source !== this.logoUrl) return
      this.failedLogoUrl = source
    },
    handleLogoLoad (event: Event): void {
      const image = event.currentTarget
      if (!(image instanceof HTMLImageElement)) return
      const source = image.getAttribute('data-logo-source')
      if (!source || source !== this.logoUrl) return
      if (this.failedLogoUrl === source) this.failedLogoUrl = null
    }
  }
})
</script>

<style lang='scss' scoped>
.page-unlock {
  display: grid;
  min-height: 100vh;
  min-height: 100dvh;
  padding: var(--wiki-page-gutter);
  place-items: center;
  background: rgb(var(--v-theme-background));
  color: rgb(var(--v-theme-on-background));
}

.page-unlock-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  width: min(100%, 880px);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  box-shadow: none;
}

.page-unlock-context,
.page-unlock-content {
  min-width: 0;
  padding: clamp(24px, 4vw, 40px);
  overflow-wrap: anywhere;
}

.page-unlock-context {
  border-inline-end: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-sunken);

  h1 { margin-block: 12px; }
  p { margin-block: 12px 0; line-height: 1.6; }
}

.page-unlock-content {
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.page-unlock-brand {
  display: flex;
  min-width: 0;
  gap: 12px;
  align-items: center;
  margin-block-end: 32px;
}

.page-unlock-logo {
  display: grid;
  flex: 0 0 auto;
  max-width: 112px;
  min-width: 44px;
  height: 44px;
  place-items: center;
}

.page-unlock-logo-image {
  display: block;
  max-width: 100%;
  max-height: 44px;
  object-fit: contain;
}

.page-unlock-logo-fallback {
  display: grid;
  width: 44px;
  height: 44px;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  place-items: center;
  font-size: 1.25rem;
  font-weight: 700;
}

.page-unlock-brand-title { min-width: 0; }
.page-unlock-return { margin-block-start: 24px; min-height: 44px; }

@media (max-width: 699px) {
  .page-unlock { padding: 16px; align-items: start; }
  .page-unlock-card { grid-template-columns: minmax(0, 1fr); }
  .page-unlock-context {
    border-inline-end: 0;
    border-block-end: 1px solid var(--wiki-surface-border);
  }
  .page-unlock-context,
  .page-unlock-content { padding: 24px; }
  .page-unlock-brand { margin-block-end: 24px; }
}
</style>
