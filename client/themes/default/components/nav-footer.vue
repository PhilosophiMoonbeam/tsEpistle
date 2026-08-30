<template lang="pug">
  v-footer.nav-footer.justify-center(:color='bgColor', app)
    .text-body-small.footer-attribution
      template(v-if='footerOverride')
        span(v-html='footerOverrideRender + ` |&nbsp;`')
      template(v-else-if='company && company.length > 0 && contentLicense !== ``')
        span(v-if='contentLicense === `alr`') {{ $t('common:footer.copyright', { company: company, year: currentYear, interpolation: { escapeValue: false } }) }} |&nbsp;
        span(v-else) {{ $t('common:footer.license', { company: company, license: $t('common:license.' + contentLicense), interpolation: { escapeValue: false } }) }} |&nbsp;
      span {{ product.name }} {{ product.version }} |&nbsp;
      a(:href='product.sourceUrl', target='_blank', rel='noopener noreferrer') Source Code
      span &nbsp;| Derived from #[a(href='https://github.com/Requarks/wiki', target='_blank', rel='nofollow noopener noreferrer') Wiki.js]
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
  height: auto;
  min-height: var(--wiki-footer-height);
  padding: 12px var(--wiki-page-gutter);
  border-top: 1px solid rgba(var(--v-border-color), .09);
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 96%, rgb(var(--v-theme-background))) !important;
  box-shadow: none;
}

.footer-attribution {
  color: rgba(var(--v-theme-on-surface), .66);
  font-family: 'WikiAgentSans', 'Roboto', sans-serif;
  line-height: 1.7;
  text-align: center;

  a {
    color: rgb(var(--v-theme-primary));
    font-weight: 620;
    text-decoration: none;
    text-underline-offset: .18em;

    &:hover,
    &:focus-visible {
      text-decoration: underline;
    }
  }
}

@media (max-width: 599px) {
  .nav-footer {
    padding: 10px 18px;
  }

  .footer-attribution {
    font-size: .7rem !important;
    line-height: 1.55;
  }
}
</style>
