<template lang="pug">
  .auth-shell(:class='shellClass', :style='backgroundStyle')
    main.auth-shell__card(:aria-busy='busy ? `true` : `false`', :aria-labelledby='headingId')
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
          h1(:id='headingId') {{ title }}
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
    slot(name='aside')
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'

/** Literal placeholder for the footer link inside footerSentence. */
const AUTH_SHELL_LINK_MARKER = '{{link}}'

/**
 * Shared frame for sign-in, registration, first-run setup and welcome pages:
 * one background, one card position, one brand block and one footer link.
 * Text is supplied by the caller so the shell also works without i18n.
 */
export default defineComponent({
  props: {
    title: { type: String, required: true },
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
  display: flex;
  min-height: 100vh;
  min-height: 100dvh;
  align-items: center;
  overflow: hidden auto;
  padding: var(--wiki-space-10) clamp(var(--wiki-space-6), 6vw, var(--wiki-space-12));
  background-color: rgb(var(--v-theme-background));
  background-position: center;
  background-size: cover;
  color: rgb(var(--v-theme-on-background));
  font-family: var(--wiki-font-body);
  isolation: isolate;

  &::before {
    position: absolute;
    z-index: -2;
    inset: 0;
    background:
      radial-gradient(
        circle at 72% 50%,
        var(
          --login-logo-aura,
          color-mix(in srgb, var(--wiki-accent-spectral) 24%, transparent)
        ),
        transparent 38rem
      ),
      linear-gradient(
        108deg,
        color-mix(in srgb, rgb(var(--v-theme-background)) 94%, transparent),
        color-mix(in srgb, rgb(var(--v-theme-background)) 76%, transparent) 62%,
        color-mix(in srgb, rgb(var(--v-theme-background)) 90%, transparent)
      );
    content: '';
    pointer-events: none;
  }

  &::after {
    position: absolute;
    z-index: -1;
    inset: var(--wiki-space-8);
    border: 1px solid color-mix(in srgb, var(--wiki-accent-spectral) 14%, transparent);
    border-radius: var(--wiki-hero-radius);
    background-image:
      linear-gradient(var(--wiki-surface-border) 1px, transparent 1px),
      linear-gradient(90deg, var(--wiki-surface-border) 1px, transparent 1px);
    background-size: var(--wiki-grid-size) var(--wiki-grid-size);
    content: '';
    mask-image: linear-gradient(90deg, transparent 38%, rgb(var(--v-theme-on-surface)));
    opacity: .42;
    pointer-events: none;
  }

  &__card {
    position: relative;
    width: min(100%, 30rem);
    max-height: calc(100dvh - var(--wiki-space-12));
    margin: 0;
    padding: var(--wiki-space-8);
    overflow-y: auto;
    border: 1px solid var(--wiki-surface-border-strong);
    border-radius: var(--wiki-hero-radius);
    background: var(--wiki-surface-raised);
    box-shadow: var(--wiki-shadow-lg), var(--wiki-shadow-inset);

    @supports ((backdrop-filter: blur(16px)) or (-webkit-backdrop-filter: blur(16px))) {
      background: color-mix(in srgb, rgb(var(--v-theme-surface)) 92%, transparent);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
    }
  }

  &__brand {
    display: flex;
    gap: var(--wiki-space-4);
    align-items: center;
    margin-bottom: var(--wiki-space-5);
  }

  &__logo {
    position: relative;
    display: flex;
    flex: 0 0 3.25rem;
    width: 3.25rem;
    height: 3.25rem;
    padding: var(--wiki-space-2);
    box-sizing: border-box;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 24%, var(--wiki-surface-border));
    border-radius: var(--wiki-control-radius);
    background:
      linear-gradient(
        145deg,
        color-mix(in srgb, var(--wiki-accent-warm) 11%, var(--wiki-surface-raised)),
        color-mix(in srgb, var(--wiki-accent-spectral) 7%, var(--wiki-surface-raised))
      );
    box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);

    > img {
      display: block;
      width: 100%;
      max-width: 100%;
      height: 100%;
      max-height: 100%;
      object-fit: contain;
      object-position: center;
    }
  }

  &__logo-fallback {
    display: grid;
    width: 100%;
    height: 100%;
    place-items: center;
    color: rgb(var(--v-theme-on-surface));
    font-size: 1.25rem;
    font-weight: 720;
    line-height: 1;
  }

  &__title {
    min-width: 0;

    h1 {
      margin: var(--wiki-space-1) 0 0;
      overflow-wrap: anywhere;
      color: rgb(var(--v-theme-on-surface));
      font-size: 1.25rem;
      font-weight: 720;
      letter-spacing: -.035em;
      line-height: var(--wiki-leading-heading);
    }
  }

  &__eyebrow {
    color: var(--wiki-accent-ink);
    font-size: var(--wiki-label-size);
    font-weight: var(--wiki-label-weight);
    letter-spacing: .1em;
    line-height: 1rem;
    text-transform: uppercase;
  }

  &__lead {
    margin: 0 0 var(--wiki-space-4);
    color: var(--wiki-text-muted);
    font-size: .875rem;
    line-height: 1.55;

    p {
      margin: 0;
    }
  }

  &__card > .v-alert {
    margin-bottom: var(--wiki-space-4) !important;
    border: 1px solid color-mix(in srgb, rgb(var(--v-theme-error)) 28%, transparent);
  }

  &__footer {
    display: block;
    margin: var(--wiki-space-6) calc(-1 * var(--wiki-space-8)) calc(-1 * var(--wiki-space-8));
    padding: var(--wiki-space-4) var(--wiki-space-8);
    border-top: 1px solid var(--wiki-surface-border);
    background: var(--wiki-surface-sunken);
    color: var(--wiki-text-muted);
    font-size: .8125rem;
    line-height: 1.5;
    text-align: center;

    a {
      color: var(--wiki-accent-ink);
      font-weight: 650;
      text-decoration-thickness: .0625rem;
      text-underline-offset: var(--wiki-space-1);

      &:hover,
      &:focus-visible {
        text-decoration-thickness: .125rem;
      }

      &:focus-visible {
        border-radius: var(--wiki-radius-xs);
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
    align-items: flex-start;
    justify-content: center;

    &::after {
      mask-image: linear-gradient(to bottom, rgb(var(--v-theme-on-surface)), transparent 88%);
    }

    .auth-shell__card {
      width: min(100%, 61.25rem);
      max-height: none;
      overflow: visible;
    }
  }
}

@media (prefers-reduced-transparency: reduce) {
  .auth-shell__card {
    background: var(--wiki-surface-raised);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}

@media (max-width: 599px) {
  .auth-shell {
    align-items: stretch;
    padding: 0;
    background-image: none !important;

    &::after {
      inset: 0;
      border: 0;
      border-radius: 0;
      opacity: .2;
    }

    &__card,
    &--wide .auth-shell__card {
      width: 100%;
      max-height: none;
      min-height: 100dvh;
      padding: var(--wiki-space-6) var(--wiki-space-5);
      border: 0;
      border-radius: 0;
      background: color-mix(in srgb, rgb(var(--v-theme-surface)) 96%, rgb(var(--v-theme-background)));
      box-shadow: none;
    }

    &__brand {
      margin-bottom: var(--wiki-space-4);
    }

    &__footer {
      margin: var(--wiki-space-6) calc(-1 * var(--wiki-space-5)) calc(-1 * var(--wiki-space-6));
      padding-inline: var(--wiki-space-5);
    }
  }
}

@media (max-height: 650px) and (min-width: 600px) {
  .auth-shell {
    align-items: flex-start;
    padding-block: var(--wiki-space-3);

    &__card {
      max-height: calc(100dvh - var(--wiki-space-6));
      padding: var(--wiki-space-4) var(--wiki-space-6);
    }

    &--wide .auth-shell__card {
      max-height: none;
    }

    &__brand {
      margin-bottom: var(--wiki-space-1);
    }

    &__logo {
      flex-basis: 2.5rem;
      width: 2.5rem;
      height: 2.5rem;
    }

    &__footer {
      margin: var(--wiki-space-3) calc(-1 * var(--wiki-space-6)) calc(-1 * var(--wiki-space-4));
      padding: var(--wiki-space-2) var(--wiki-space-6);
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
  .auth-shell__card {
    border-color: CanvasText;
    background: Canvas;
  }
}

@media print {
  .auth-shell {
    padding: 0;
    background: transparent !important;

    &::before,
    &::after {
      display: none;
    }

    &__card {
      max-height: none;
      border: 0;
      box-shadow: none;
    }
  }
}
</style>
