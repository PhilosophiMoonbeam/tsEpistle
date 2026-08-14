<template lang='pug'>
  v-app(:dark='$vuetify.theme.current.dark').source
    nav-header
    v-main
      v-toolbar(color='primary', dark)
        i18next.subheading(v-if='versionId > 0', path='common:page.viewingSourceVersion', tag='div')
          strong(place='date', :title='$helpers.formatMoment(versionDate, `LLL`)') {{ $helpers.formatMoment(versionDate, 'lll') }}
          strong(place='path') /{{path}}
        i18next.subheading(v-else, path='common:page.viewingSource', tag='div')
          strong(place='path') /{{path}}
        template(v-if='$vuetify.display.mdAndUp')
          v-spacer
          .caption.blue--text.text--lighten-3 {{$t('common:page.id', { id: pageId })}}
          .caption.blue--text.text--lighten-3.ml-4(v-if='versionId > 0') {{$t('common:page.versionId', { id: versionId })}}
          v-btn.ml-4(v-if='versionId > 0', depressed, color='blue darken-1', @click='goHistory')
            v-icon mdi-history
          v-btn.ml-4(depressed, color='blue darken-1', @click='goDownload')
            v-icon(left) mdi-download
            span {{$t('common:actions.download')}}
          v-btn.ml-4(depressed, color='blue darken-1', @click='goLive') {{$t('common:page.returnNormalView')}}
      v-card(tile)
        v-card-text
          v-card.grey.radius-7(flat, :class='$vuetify.theme.current.dark ? `darken-4` : `lighten-4`')
            v-card-text
              pre
                slot

    nav-footer
    notify
    search-results
</template>

<script lang='ts'>
import { getPageDownloadPath } from '../helpers/page-actions'
import { wikiStore } from '@/store/index.ts'
import { decodeBase64Json } from '../helpers/base64'

export default {
  props: {
    pageId: {
      type: Number,
      default: 0
    },
    locale: {
      type: String,
      default: 'en'
    },
    path: {
      type: String,
      default: 'home'
    },
    visibility: {
      type: String,
      default: 'public'
    },
    versionId: {
      type: Number,
      default: 0
    },
    versionDate: {
      type: String,
      default: ''
    },
    effectivePermissions: {
      type: String,
      default: ''
    }
  },
  data() {
    return {}
  },
  created () {
    wikiStore.page.id = this.pageId
    wikiStore.page.locale = this.locale
    wikiStore.page.path = this.path
    wikiStore.page.visibility = this.visibility === 'private' ? 'private' : 'public'

    wikiStore.page.mode = 'source'

    if (this.effectivePermissions) {
      wikiStore.page.effectivePermissions = decodeBase64Json(this.effectivePermissions)
    }
  },
  methods: {
    goLive() {
      const scope = this.visibility === 'private' ? '/_private' : ''
      window.location.assign(`${scope}/${this.locale}/${this.path}`)
    },
    goDownload () {
      window.location.assign(getPageDownloadPath(this.locale, this.path, this.versionId, this.visibility === 'private' ? 'private' : 'public'))
    },
    goHistory () {
      const scope = this.visibility === 'private' ? '/_private' : ''
      window.location.assign(`/h${scope}/${this.locale}/${this.path}`)
    }
  }
}
</script>

<style lang='scss'>

.source {
  pre > code {
    box-shadow: none;
    background-color: transparent;
    color: mc('grey', '800');
    font-family: 'Roboto Mono', sans-serif;
    font-weight: 400;
    font-size: 1rem;

    @at-root .theme--dark.source pre > code {
      background-color: mc('grey', '900');
      color: mc('grey', '400');
    }

    &::before {
      display: none;
    }
  }
}

</style>
