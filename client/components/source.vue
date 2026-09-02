<template lang='pug'>
  v-app.source
    nav-header
    v-main.source-main
      v-toolbar.source-toolbar(color='surface', flat)
        .source-toolbar-copy
          .source-eyebrow {{$t('common:header.viewSource')}}
          i18next#source-title.source-toolbar-title(v-if='versionId > 0', path='common:page.viewingSourceVersion', tag='h1')
            strong(place='date', :title='$helpers.formatMoment(versionDate, `LLL`)') {{ $helpers.formatMoment(versionDate, 'lll') }}
            strong(place='path') /{{path}}
          i18next#source-title.source-toolbar-title(v-else, path='common:page.viewingSource', tag='h1')
            strong(place='path') /{{path}}
          .source-toolbar-meta(v-if='$vuetify.display.mdAndUp')
            span {{$t('common:page.id', { id: pageId })}}
            span(v-if='versionId > 0') {{$t('common:page.versionId', { id: versionId })}}
        v-spacer
        .source-toolbar-actions
          v-btn(
            v-if='versionId > 0'
            variant='tonal'
            color='primary'
            size='small'
            @click='goHistory'
            :aria-label='$t(`common:header.history`)'
          )
            v-icon(:start='$vuetify.display.mdAndUp') mdi-history
            span(v-if='$vuetify.display.mdAndUp') {{$t('common:header.history')}}
          v-btn(variant='tonal', color='primary', size='small', @click='goDownload', :aria-label='$t(`common:actions.download`)')
            v-icon(:start='$vuetify.display.mdAndUp') mdi-download
            span(v-if='$vuetify.display.mdAndUp') {{$t('common:actions.download')}}
          v-btn(variant='flat', color='primary', size='small', @click='goLive', :aria-label='$t(`common:page.returnNormalView`)')
            v-icon(v-if='$vuetify.display.smAndDown') mdi-close
            span(v-else) {{$t('common:page.returnNormalView')}}
      v-container.source-shell(fluid)
        article.source-code-card
          pre(tabindex='0' aria-labelledby='source-title')
            slot
    nav-footer
    notify
    search-results</template>

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
.source-main {
  background:
    radial-gradient(circle at 88% 0%, rgba(var(--v-theme-primary), .07), transparent 30rem),
    rgb(var(--v-theme-background));
}

.source-toolbar {
  min-height: 86px !important;
  padding-inline: var(--wiki-page-gutter);
  border-bottom: 1px solid rgba(var(--v-border-color), .11) !important;
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 96%, rgb(var(--v-theme-background))) !important;
}

.source-toolbar-copy {
  min-width: 0;
  padding-block: 14px;
}

.source-eyebrow {
  color: rgb(var(--v-theme-primary));
  font-size: .66rem;
  font-weight: 760;
  letter-spacing: .12em;
  text-transform: uppercase;
}

.source-toolbar-title {
  overflow: hidden;
  margin: 3px 0 0;
  color: rgb(var(--v-theme-on-surface));
  font-size: 1rem;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-toolbar-meta {
  display: flex;
  gap: 12px;
  margin-top: 3px;
  color: rgb(var(--v-theme-on-surface));
  font-size: .72rem;
  opacity: .56;
}

.source-toolbar-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;

  .v-btn {
    border-radius: 10px;
  }
}

.source-shell {
  width: min(100%, var(--wiki-content-max));
  margin: 0 auto;
  padding: 24px var(--wiki-page-gutter) 48px !important;
}

.source-code-card {
  overflow: hidden;
  border: 1px solid rgba(var(--v-border-color), .12);
  border-radius: var(--wiki-panel-radius);
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 96%, rgb(var(--v-theme-background)));
  box-shadow: 0 10px 32px rgba(15, 23, 42, .055);

  pre {
    overflow: auto;
    max-height: calc(100dvh - 230px);
    margin: 0;
    padding: clamp(18px, 3vw, 30px);
  }

  pre > code {
    background: transparent;
    box-shadow: none;
    color: rgb(var(--v-theme-on-surface));
    font-family: var(--wiki-font-mono);
    font-size: .875rem;
    font-weight: 400;
    line-height: 1.65;

    &::before {
      display: none;
    }
  }
}

@media (max-width: 599px) {
  .source-toolbar {
    min-height: 76px !important;
  }

  .source-toolbar-copy {
    max-width: calc(100vw - 168px);
  }

  .source-toolbar-actions {
    gap: 4px;

    .v-btn {
      min-width: 44px;
      min-height: 44px;
      padding-inline: 6px;
    }
  }

  .source-shell {
    padding: 12px var(--wiki-page-gutter) 36px !important;
  }

  .source-code-card {
    border-radius: var(--wiki-panel-radius);

    pre {
      max-height: calc(100dvh - 190px);
      padding: 16px;
    }
  }
}
</style>
