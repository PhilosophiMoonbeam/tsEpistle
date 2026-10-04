<template lang="pug">
  .auth-shell(:class='shellClass')
    main.auth-shell__card(:aria-busy='busy ? `true` : `false`', :aria-labelledby='headingId')
      header.auth-shell__heading
        h1(:id='headingId') {{ formTitle || eyebrow || title }}
      .auth-shell__lead(v-if='$slots.lead')
        slot(name='lead')
      slot
      footer.auth-shell__footer(v-if='footerLinkLabel')
        span {{ footerParts[0] }}
        a(
          :href='footerHref'
          :aria-disabled='footerDisabled ? `true` : undefined'
          :tabindex='footerDisabled ? -1 : undefined'
          @click='footerDisabled && $event.preventDefault()'
        ) {{ footerLinkLabel }}
        span {{ footerParts[1] }}
    section.auth-shell__identity(:style='backgroundStyle', :aria-label='title')
      header.auth-shell__brand
        .auth-shell__logo
          img(
            v-if='logoUrl && !logoImageFailed'
            :key='logoUrl'
            :src='logoUrl'
            :data-logo-source='logoUrl'
            alt=''
            @error='handleLogoError'
            @load='handleLogoLoad'
          )
          .auth-shell__logo-fallback(v-else, aria-hidden='true') {{ logoFallback }}
        .auth-shell__title
          .auth-shell__eyebrow(v-if='eyebrow') {{ eyebrow }}
          h2 {{ title }}
      .auth-shell__context(v-if='$slots.context')
        slot(name='context')
    slot(name='aside')
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'

/** Literal placeholder for the footer link inside footerSentence. */
const AUTH_SHELL_LINK_MARKER = '{{link}}'

/**
 * Shared two-zone entry frame: a task pane and an independent site-identity pane.
 * The aside stays a direct child for the optional particle-logo renderer.
 * Both panes remain in document flow on small and short viewports.
 */
export default defineComponent({
  props: {
    title: { type: String, required: true },
    formTitle: { type: String, default: '' },
    headingId: { type: String, default: 'auth-shell-title' },
    eyebrow: { type: String, default: '' },
    logoUrl: { type: String, default: '' },
    backgroundUrl: { type: String, default: '' },
    busy: { type: Boolean, default: false },
    size: { type: String as PropType<'compact' | 'wide'>, default: 'compact' },
    /** Sentence around the footer link. Mark the link position with the literal text {{link}}. */
    footerSentence: { type: String, default: '' },
    footerLinkLabel: { type: String, default: '' },
    footerHref: { type: String, default: '' },
    footerDisabled: { type: Boolean, default: false }
  },
  data () {
    return { failedLogoUrl: null as string | null }
  },
  computed: {
    shellClass (): Record<string, boolean> {
      return { 'auth-shell--wide': this.size === 'wide' }
    },
    backgroundStyle (): Record<string, string> {
      return this.backgroundUrl ? { backgroundImage: `url(${JSON.stringify(this.backgroundUrl)})` } : {}
    },
    logoImageFailed (): boolean {
      return this.failedLogoUrl === this.logoUrl
    },
    logoFallback (): string {
      const title = this.title.trim()
      return title ? title.charAt(0).toUpperCase() : '?'
    },
    footerParts (): [string, string] {
      const sentence = this.footerSentence || AUTH_SHELL_LINK_MARKER
      const index = sentence.indexOf(AUTH_SHELL_LINK_MARKER)
      if (index < 0) return [`${sentence} `, '']
      return [sentence.slice(0, index), sentence.slice(index + AUTH_SHELL_LINK_MARKER.length)]
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

<style lang="scss">
.auth-shell {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 38rem) minmax(0, 1fr);
  align-content: start;
  min-height: 100vh;
  min-height: 100dvh;
  gap: var(--wiki-space-6);
  padding: var(--wiki-space-6);
  background: var(--wiki-surface-sunken);
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-body);
  isolation: isolate;

  &__card {
    position: relative;
    z-index: 1;
    align-self: start;
    min-width: 0;
    min-height: calc(100dvh - var(--wiki-space-12));
    padding: clamp(var(--wiki-space-5), 4vw, var(--wiki-space-10));
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-panel-radius);
    background: var(--wiki-surface-raised);
  }

  &__heading {
    margin-bottom: var(--wiki-space-6);
    padding-bottom: var(--wiki-space-5);
    border-bottom: 1px solid var(--wiki-surface-border);

    h1 {
      margin: 0;
      overflow-wrap: anywhere;
      font-family: var(--wiki-font-heading);
      font-size: 1.5rem;
      font-weight: 700;
      line-height: 1.3;
    }
  }

  &__identity {
    display: flex;
    min-width: 0;
    flex-direction: column;
    justify-content: space-between;
    gap: var(--wiki-space-8);
    padding: var(--wiki-space-6);
    border-radius: var(--wiki-panel-radius);
    background-position: center;
    background-size: cover;
  }

  &__brand {
    position: relative;
    z-index: 1;
    display: flex;
    gap: var(--wiki-space-4);
    align-items: center;
    padding: var(--wiki-space-4);
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-panel-radius);
    background: var(--wiki-surface-raised);
  }

  &__logo {
    display: grid;
    flex: 0 0 3rem;
    width: 3rem;
    height: 3rem;
    place-items: center;

    > img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
  }

  &__logo-fallback {
    display: grid;
    width: 100%;
    height: 100%;
    place-items: center;
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-control-radius);
    background: var(--wiki-surface-sunken);
    font-size: 1.25rem;
    font-weight: 700;
  }

  &__title {
    min-width: 0;

    h2 {
      margin: var(--wiki-space-1) 0 0;
      overflow-wrap: anywhere;
      font-family: var(--wiki-font-heading);
      font-size: 1.125rem;
      font-weight: 700;
      line-height: 1.4;
    }
  }

  &__eyebrow {
    color: var(--wiki-text-muted);
    font-size: .875rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  &__lead,
  &__context {
    color: var(--wiki-text-muted);
    font-size: .9375rem;
    line-height: 1.6;
    overflow-wrap: anywhere;

    a {
      color: var(--wiki-accent-ink);
      text-underline-offset: var(--wiki-space-1);
    }

    p {
      margin: 0;
    }
  }

  &__lead {
    margin-bottom: var(--wiki-space-5);
  }

  &__context {
    position: relative;
    z-index: 1;
    padding: var(--wiki-space-5);
    border-inline-start: 2px solid var(--wiki-surface-border-strong);
    background: var(--wiki-surface-sunken);
  }

  &__card > .v-alert {
    margin-bottom: var(--wiki-space-4) !important;
    border-radius: var(--wiki-control-radius);
  }

  .v-field {
    border-radius: var(--wiki-control-radius);
  }

  .v-input__details {
    overflow-wrap: anywhere;
  }

  .v-btn {
    min-height: var(--wiki-control-height);
    border-radius: var(--wiki-control-radius);
    letter-spacing: 0;
    text-transform: none;

    &:not(.v-btn--icon) {
      height: auto;
      padding-block: var(--wiki-space-3);
    }

    .v-btn__content {
      white-space: normal;
      overflow-wrap: anywhere;
    }
  }

  &__footer {
    margin-top: var(--wiki-space-6);
    padding-top: var(--wiki-space-5);
    border-top: 1px solid var(--wiki-surface-border);
    color: var(--wiki-text-muted);
    font-size: .875rem;
    line-height: 1.6;
    overflow-wrap: anywhere;

    a {
      display: inline-flex;
      min-height: var(--wiki-control-height);
      align-items: center;
      color: var(--wiki-accent-ink);
      font-weight: 650;
      text-underline-offset: var(--wiki-space-1);

      &:focus-visible {
        border-radius: var(--wiki-control-radius);
        outline: 2px solid var(--wiki-focus-color);
        outline-offset: 2px;
      }

      &[aria-disabled='true'] {
        color: var(--wiki-text-muted);
        cursor: not-allowed;
      }
    }
  }

  &--wide {
    grid-template-columns: minmax(0, 2fr) minmax(16rem, 1fr);
  }
}

@media (max-width: 959px) {
  .auth-shell {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--wiki-space-4);
    padding: var(--wiki-space-4);

    &__identity {
      grid-row: 1;
      padding: 0;
      gap: var(--wiki-space-3);
      background-image: none !important;
    }

    &__card {
      min-height: 0;
      padding: var(--wiki-space-6);
    }

    &__context {
      padding: var(--wiki-space-3) var(--wiki-space-4);
    }
  }
}

@media (max-width: 599px) {
  .auth-shell {
    padding: var(--wiki-space-3);

    &__card {
      padding: var(--wiki-space-5) var(--wiki-space-4);
    }

    &__brand {
      padding: var(--wiki-space-3);
    }

    &__heading {
      margin-bottom: var(--wiki-space-5);

      h1 {
        font-size: 1.25rem;
      }
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .auth-shell *,
  .auth-shell *::before,
  .auth-shell *::after {
    transition-duration: .01ms !important;
    animation-duration: .01ms !important;
  }
}

@media (forced-colors: active) {
  .auth-shell__card,
  .auth-shell__brand {
    border-color: CanvasText;
    background: Canvas;
  }
}

@media print {
  .auth-shell {
    display: block;
    padding: 0;
    background: transparent;

    &__card {
      min-height: 0;
      border: 0;
    }

    &__identity {
      display: none;
    }
  }
}
</style>
