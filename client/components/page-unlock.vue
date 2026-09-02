<template lang='pug'>
  v-app.page-unlock-app
    main.page-unlock
      v-card.page-unlock-card(variant='flat')
        v-card-text.page-unlock-content
          .page-unlock-brand
            .page-unlock-logo
              v-avatar(rounded='0', size='40')
                img(:src='logoUrl', alt='')
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

/* global siteConfig */

export default defineComponent({
  data() {
    return {
      hidePassword: true
    }
  },
  computed: {
    siteTitle (): string {
      return siteConfig.title
    },
    logoUrl (): string {
      return siteConfig.logoUrl
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
  border: 1px solid rgba(var(--v-border-color), .14);
  border-radius: var(--wiki-panel-radius);
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 96%, rgb(var(--v-theme-background)));
  box-shadow: 0 18px 48px rgba(20, 28, 50, .1);
}

.page-unlock-content {
  padding: clamp(24px, 5vw, 36px);
}

.page-unlock-brand {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 26px;
}

.page-unlock-logo {
  display: grid;
  width: 52px;
  height: 52px;
  flex: 0 0 52px;
  place-items: center;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 22%, transparent);
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, rgb(var(--v-theme-surface)));
}

.page-unlock-brand-title {
  min-width: 0;
  overflow-wrap: anywhere;
}

.page-unlock-eyebrow {
  color: rgb(var(--v-theme-primary));
  font-size: .66rem;
  font-weight: 760;
  letter-spacing: .12em;
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
    padding: 28px 20px;
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
