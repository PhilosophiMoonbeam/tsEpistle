<template lang="pug">
  v-footer.nav-footer(:color='bgColor', role='contentinfo')
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
  flex: none;
  min-height: var(--wiki-footer-height);
  margin-top: auto;
  padding: var(--wiki-space-2) var(--wiki-page-gutter) calc(var(--wiki-space-2) + env(safe-area-inset-bottom));
  border-block-start: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-raised);
  box-shadow: none;
}

.footer-attribution {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--wiki-space-2) var(--wiki-space-4);
  width: min(100%, var(--wiki-shell-max));
  min-width: 0;
  margin-inline: auto;
  color: var(--wiki-text-muted);
  font-family: var(--wiki-font-body);
  font-size: .75rem;
  line-height: 1.5;

  &__legal {
    flex: 1 1 24rem;
    min-width: 0;
    overflow-wrap: anywhere;

    p { margin: 0; }
  }

  &__meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--wiki-space-2);
    min-width: 0;
    margin: 0;
    margin-inline-start: auto;
  }

  &__product {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  &__separator {
    width: 1px;
    height: 1rem;
    background: var(--wiki-surface-border-strong);
  }

  a {
    border-radius: var(--wiki-control-radius);
    color: var(--wiki-accent-ink);
    font-weight: 550;
    text-decoration: underline;
    text-underline-offset: .2em;
    overflow-wrap: anywhere;

    &:focus-visible {
      outline: 2px solid var(--wiki-focus-color, var(--wiki-accent-ink));
      outline-offset: 2px;
    }
  }
}

@media (max-width: 599px) {
  .footer-attribution {
    align-items: start;

    &__meta {
      justify-content: start;
      margin-inline-start: 0;
    }

    a {
      display: inline-flex;
      align-items: center;
      min-height: 2.75rem;
    }
  }
}

@media (forced-colors: active) {
  .nav-footer { border-block-start-color: CanvasText; }
  .footer-attribution__separator { background: CanvasText; }
}

@media print {
  .nav-footer {
    position: static !important;
    padding-block: 2px !important;
    border-block-start-color: currentColor;
    background: transparent !important;
  }

  .footer-attribution,
  .footer-attribution a { color: inherit; }
  .footer-attribution__separator { background: currentColor; }
}
</style>
