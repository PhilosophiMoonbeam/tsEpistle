<template lang="pug">
  v-footer.nav-footer(:color='bgColor', :app='app')
    .footer-attribution
      .footer-attribution__legal(v-if='footerOverride')
        span(v-html='footerOverrideRender')
      .footer-attribution__legal(v-else-if='company && company.length > 0 && contentLicense !== ``')
        span(v-if='contentLicense === `alr`') {{ $t('common:footer.copyright', { company: company, year: currentYear, interpolation: { escapeValue: false } }) }}
        span(v-else) {{ $t('common:footer.license', { company: company, license: $t('common:license.' + contentLicense), interpolation: { escapeValue: false } }) }}
      p.footer-attribution__meta
        span.footer-attribution__product {{ product.name }} {{ product.version }}
        span.footer-attribution__separator(aria-hidden='true')
        a(:href='product.sourceRepository', target='_blank', rel='noopener noreferrer') {{ $t('common:footer.sourceCode') }}
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { wikiStore } from '@/store/index.ts'
import { renderFooterMarkdown } from '../../../helpers/footer-markdown.ts'

export default defineComponent({
  props: {
    color: {
      type: String,
      default: 'surface'
    },
    darkColor: {
      type: String,
      default: 'surface'
    },
    app: {
      type: Boolean,
      default: true
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
      return renderFooterMarkdown(this.footerOverride)
    },
    bgColor() {
      if (!this.$vuetify.theme.current.dark) {
        return this.color
      } else {
        return this.darkColor
      }
    }
  }
})
</script>

<style lang="scss">
.nav-footer {
  --nav-footer-accent-direction: 90deg;
  overflow: visible;
  height: auto;
  min-height: var(--wiki-footer-height);
  padding: 0 var(--wiki-page-gutter) env(safe-area-inset-bottom);
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
  flex-wrap: wrap;
  gap: 8px;
  margin-inline: auto;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
  font-family: var(--wiki-font-body);
  font-size: .625rem;
  line-height: 1.2;
  text-align: center;

  &__legal {
    min-width: 0;
    padding-inline-end: 8px;
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
    column-gap: 6px;
    row-gap: 2px;
    margin: 0;
  }

  &__product {
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 78%, transparent);
    font-family: var(--wiki-font-mono);
    font-size: .625rem;
    font-weight: var(--wiki-label-weight);
    letter-spacing: .025em;
  }

  &__separator {
    display: inline-block;
    width: 1px;
    height: 10px;
    background: var(--wiki-surface-border-strong);
  }

  a {
    border-radius: var(--wiki-radius-xs);
    color: var(--wiki-accent-ink);
    font-weight: 650;
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--wiki-accent-warm) 34%, transparent);
    text-decoration-thickness: .0625rem;
    text-underline-offset: .2em;
    transition:
      color var(--wiki-motion-fast) var(--wiki-motion-ease),
      text-decoration-color var(--wiki-motion-fast) var(--wiki-motion-ease);

    &:hover {
      color: var(--wiki-accent-ink);
      text-decoration-color: currentColor;
    }

    &:focus-visible {
      color: var(--wiki-accent-ink);
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
    gap: 2px;

    &__legal {
      padding-inline-end: 0;
      border-inline-end: 0;
    }
  }
}

@media (max-width: 599px) {
  .nav-footer {
    padding: 0 var(--wiki-space-4) env(safe-area-inset-bottom);
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

@media print {
  .nav-footer {
    position: static !important;
    box-shadow: none !important;
    background: transparent !important;
    border-top: 1px solid currentColor;
    padding-block: 2px !important;

    &::before {
      display: none;
    }
  }

  .footer-attribution {
    color: inherit;

    &__legal {
      border-inline-end-color: currentColor;
      color: inherit;
    }

    &__product {
      color: inherit;
    }

    &__separator {
      background: currentColor;
    }

    a {
      color: inherit;
      text-decoration: underline;
    }
  }
}

</style>
