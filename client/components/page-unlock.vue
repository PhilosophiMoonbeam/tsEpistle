<template lang='pug'>
  v-app.page-unlock-app
    main.page-unlock
      v-card.page-unlock-card(variant='flat')
        v-card-text.page-unlock-content
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
            .page-unlock-brand-title
              .page-unlock-eyebrow Secure page access
              .text-title-large {{ siteTitle }}
          .page-unlock-context
            v-icon(color='primary', size='32') mdi-lock-outline
            h1.text-headline-small Protected page
          p.text-body-large.text-medium-emphasis.mb-6 Enter the page password to continue to {{ pageTitle }}.
          v-alert#page-unlock-error.mb-4(
            v-if='error'
            type='error'
            variant='tonal'
            role='alert'
          ) {{ error }}
          template(v-if='validPageId')
            form(:action='`/_unlock/${validPageId}`', method='post')
              input(type='hidden', name='returnTo', :value='returnTo')
              v-text-field(
                name='password'
                :type='hidePassword ? "password" : "text"'
                label='Page password'
                autocomplete='current-password'
                autofocus
                required
                variant='outlined'
                :aria-describedby='error ? "page-unlock-error" : undefined'
                :aria-invalid='error ? "true" : undefined'
              )
                template(v-slot:append-inner)
                  v-btn(
                    icon
                    variant='text'
                    size='small'
                    type='button'
                    :aria-label='hidePassword ? "Show password" : "Hide password"'
                    @click='hidePassword = !hidePassword'
                  )
                    v-icon {{ hidePassword ? 'mdi-eye-outline' : 'mdi-eye-off-outline' }}
              v-btn.mt-2(
                type='submit'
                color='primary'
                size='large'
                block
              ) Unlock page
          template(v-else)
            v-alert.mb-4(type='error', variant='tonal', role='alert') This protected page is unavailable.
          v-btn.page-unlock-return(
            variant='text'
            color='primary'
            href='/'
          ) Return home
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { wikiStore } from '@/store/index.ts'

export default defineComponent({
  data() {
    return {
      failedLogoUrl: null as string | null,
      hidePassword: true
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
      default: 'this page'
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
  methods: {
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
  display: flex;
  min-height: 100vh;
  min-height: 100dvh;
  align-items: center;
  justify-content: center;
  overflow: auto;
  padding: var(--wiki-page-gutter);
  background: rgb(var(--v-theme-background));
}

.page-unlock-card {
  width: min(100%, 480px);
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-lg), var(--wiki-shadow-inset);
}

.page-unlock-content {
  padding: clamp(24px, 5vw, 36px);
}

.page-unlock-brand {
  display: flex;
  min-width: 0;
  gap: var(--wiki-space-3);
  align-items: center;
  margin-bottom: var(--wiki-space-6);
}

.page-unlock-logo {
  position: relative;
  display: inline-flex;
  flex: 0 1 auto;
  width: max-content;
  min-width: 52px;
  max-width: 128px;
  height: 52px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 4px;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 22%, transparent);
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, rgb(var(--v-theme-surface)));
}

.page-unlock-logo-image {
  display: block;
  width: auto;
  max-width: 100%;
  height: 42px;
  max-height: 42px;
  object-fit: contain;
  object-position: center;
}

.page-unlock-logo-fallback {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  color: rgb(var(--v-theme-on-surface));
  font-size: 1.25rem;
  font-weight: 720;
  line-height: 1;
}

.page-unlock-brand-title {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.page-unlock-eyebrow {
  color: var(--wiki-accent-ink);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .08em;
  text-transform: uppercase;
}

.page-unlock-context {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 8px;
}

.page-unlock-context h1 {
  margin: 0;
}

.page-unlock-return {
  margin-top: 12px;
  color: var(--wiki-accent-ink) !important;
}

@media (max-width: 599px) {
  .page-unlock {
    align-items: stretch;
    padding: 0;
  }

  .page-unlock-card {
    width: 100%;
    min-height: 100dvh;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }

  .page-unlock-content {
    padding-block:
      calc(var(--wiki-space-6) + var(--wiki-space-1) + env(safe-area-inset-top))
      calc(var(--wiki-space-6) + var(--wiki-space-1) + env(safe-area-inset-bottom));
    padding-inline:
      calc(var(--wiki-space-4) + var(--wiki-space-1) + env(safe-area-inset-left))
      calc(var(--wiki-space-4) + var(--wiki-space-1) + env(safe-area-inset-right));
  }
}

@media (prefers-reduced-motion: reduce) {
  .page-unlock *,
  .page-unlock *::before,
  .page-unlock *::after {
    transition-duration: .01ms !important;
    animation-duration: .01ms !important;
  }
}
</style>
