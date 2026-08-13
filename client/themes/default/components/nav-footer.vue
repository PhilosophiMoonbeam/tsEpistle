<template lang="pug">
  v-footer.justify-center(:color='bgColor', inset)
    .caption.grey--text(:class='$vuetify.theme.current.dark ? `text--lighten-1` : `text--darken-1`')
      template(v-if='footerOverride')
        span(v-html='footerOverrideRender + ` |&nbsp;`')
      template(v-else-if='company && company.length > 0 && contentLicense !== ``')
        span(v-if='contentLicense === `alr`') {{ $t('common:footer.copyright', { company: company, year: currentYear, interpolation: { escapeValue: false } }) }} |&nbsp;
        span(v-else) {{ $t('common:footer.license', { company: company, license: $t('common:license.' + contentLicense), interpolation: { escapeValue: false } }) }} |&nbsp;
      span {{ $t('common:footer.poweredBy') }} #[a(href='https://wiki.js.org', ref='nofollow') Wiki.js]
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
      default: 'grey lighten-3'
    },
    darkColor: {
      type: String,
      default: 'grey darken-3'
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
  .v-footer {
    a {
      text-decoration: none;
    }

    &.altbg {
      background: mc('theme', 'primary');

      span {
        color: mc('blue', '300');
      }

      a {
        color: mc('blue', '200');
      }
    }
  }
</style>
