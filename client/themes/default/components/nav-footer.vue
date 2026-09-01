<template lang="pug">
  v-footer.nav-footer(:color='bgColor', app)
    .footer-attribution
      .footer-attribution__legal(v-if='footerOverride')
        span(v-html='footerOverrideRender')
      .footer-attribution__legal(v-else-if='company && company.length > 0 && contentLicense !== ``')
        span(v-if='contentLicense === `alr`') {{ $t('common:footer.copyright', { company: company, year: currentYear, interpolation: { escapeValue: false } }) }}
        span(v-else) {{ $t('common:footer.license', { company: company, license: $t('common:license.' + contentLicense), interpolation: { escapeValue: false } }) }}
      .footer-attribution__meta
        span.footer-attribution__product {{ product.name }} {{ product.version }}
        span.footer-attribution__separator(aria-hidden='true')
        a(:href='product.sourceUrl', target='_blank', rel='noopener noreferrer') Source Code
</template>

<script lang='ts'>
import { wikiStore } from '@/store/index.ts'
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({
  html: false,
  breaks: false,
  linkify: true
})

export default {
  props: {
    color: {
      type: String,
      default: 'surface'
    },
    darkColor: {
      type: String,
      default: 'surface'
    }
  },
  data() {
    return {
      currentYear: (new Date()).getFullYear()
    }
  },
  computed: {
    company () {
      return wikiStore.site.company
    },
    contentLicense () {
      return wikiStore.site.contentLicense
    },
    footerOverride () {
      return wikiStore.site.footerOverride
    },
    product () {
      return wikiStore.site.product
    },
    footerOverrideRender () {
      if (!this.footerOverride) { return '' }
      return md.renderInline(this.footerOverride)
    },
    bgColor() {
      if (!this.$vuetify.theme.current.dark) {
        return this.color
      } else {
        return this.darkColor
      }
    }
  }
}
</script>

<style lang="scss">
.nav-footer {
  --nav-footer-accent-direction: 90deg;
  overflow: visible;
  height: auto;
  min-height: var(--wiki-footer-height);
  padding: var(--wiki-space-1) var(--wiki-page-gutter) calc(var(--wiki-space-1) + env(safe-area-inset-bottom));
  border-top: 1px solid var(--wiki-surface-border);
  background:
    linear-gradient(
      var(--nav-footer-accent-direction),
      color-mix(in srgb, var(--wiki-accent-warm) 4%, var(--wiki-surface-raised)),
      var(--wiki-surface-raised) 38%,
      var(--wiki-surface-raised) 68%,
      color-mix(in srgb, var(--wiki-accent-spectral) 4%, var(--wiki-surface-raised))
    ) !important;
  box-shadow: 0 calc(var(--wiki-space-1) * -1) var(--wiki-space-8) color-mix(in srgb, var(--wiki-shadow-color) 42%, transparent);

  &::before {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    height: 1px;
    background: linear-gradient(
      var(--nav-footer-accent-direction),
      transparent,
      color-mix(in srgb, var(--wiki-accent-warm) 28%, transparent) 28%,
      color-mix(in srgb, var(--wiki-accent-spectral) 28%, transparent) 72%,
      transparent
    );
    pointer-events: none;
    content: '';
  }
}

.footer-attribution {
  display: flex;
  width: min(100%, var(--wiki-shell-max));
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: var(--wiki-space-3);
  margin-inline: auto;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
  font-family: var(--wiki-font-body);
  font-size: var(--wiki-label-size);
  line-height: 1.5;
  text-align: center;

  &__legal {
    min-width: 0;
    padding-inline-end: var(--wiki-space-3);
    border-inline-end: 1px solid var(--wiki-surface-border);
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
    overflow-wrap: anywhere;
  }

  &__meta {
    display: inline-flex;
    min-width: 0;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: var(--wiki-space-2);
  }

  &__product {
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 78%, transparent);
    font-family: var(--wiki-font-mono);
    font-size: var(--wiki-label-size);
    font-weight: var(--wiki-label-weight);
    letter-spacing: .025em;
  }

  &__separator {
    display: inline-block;
    width: 1px;
    height: .875rem;
    background: var(--wiki-surface-border-strong);
  }

  a {
    border-radius: var(--wiki-radius-xs);
    color: var(--wiki-accent-warm);
    font-weight: 650;
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--wiki-accent-warm) 34%, transparent);
    text-decoration-thickness: .0625rem;
    text-underline-offset: .2em;
    transition:
      color var(--wiki-motion-fast) var(--wiki-motion-ease),
      text-decoration-color var(--wiki-motion-fast) var(--wiki-motion-ease);

    &:hover {
      color: var(--wiki-accent-spectral);
      text-decoration-color: currentColor;
    }

    &:focus-visible {
      color: var(--wiki-accent-spectral);
      text-decoration-color: currentColor;
    }
  }
}

.v-locale--is-rtl .nav-footer {
  --nav-footer-accent-direction: 270deg;
}

.v-theme--dark .nav-footer {
  border-top-color: var(--wiki-surface-border-strong);
  box-shadow: 0 calc(var(--wiki-space-1) * -1) var(--wiki-space-8) color-mix(in srgb, rgb(var(--v-theme-background)) 48%, transparent);
}

@media (max-width: 959px) {
  .footer-attribution {
    flex-direction: column;
    gap: var(--wiki-space-1);

    &__legal {
      padding-inline-end: 0;
      border-inline-end: 0;
    }
  }
}

@media (max-width: 599px) {
  .nav-footer {
    padding: var(--wiki-space-1) var(--wiki-space-4) calc(var(--wiki-space-1) + env(safe-area-inset-bottom));
  }

  .footer-attribution {
    font-size: var(--wiki-label-size);
    line-height: 1.45;

    &__meta {
      column-gap: var(--wiki-space-2);
      row-gap: var(--wiki-space-1);
    }

    &__separator {
      height: var(--wiki-space-3);
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .footer-attribution a {
    transition-duration: .01ms !important;
  }
}

@media (forced-colors: active) {
  .nav-footer {
    border-top-color: CanvasText;
  }

  .nav-footer::before {
    display: none;
  }

  .footer-attribution__separator {
    background: CanvasText;
  }
}

</style>
