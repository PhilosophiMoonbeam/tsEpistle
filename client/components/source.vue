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
          v-btn(variant='tonal', color='primary', size='small', @click='copySource', :aria-label='$t(`common:actions.copy`)')
            v-icon(:start='$vuetify.display.mdAndUp') mdi-content-copy
            span(v-if='$vuetify.display.mdAndUp') {{$t('common:actions.copy')}}
          v-btn(variant='tonal', color='primary', size='small', @click='goDownload', :aria-label='$t(`common:actions.download`)')
            v-icon(:start='$vuetify.display.mdAndUp') mdi-download
            span(v-if='$vuetify.display.mdAndUp') {{$t('common:actions.download')}}
          v-btn(variant='flat', color='primary', size='small', @click='goLive', :aria-label='$t(`common:page.returnNormalView`)')
            v-icon(v-if='$vuetify.display.smAndDown') mdi-close
            span(v-else) {{$t('common:page.returnNormalView')}}
      v-container.source-shell(fluid)
        article.source-code-card
          pre(tabindex='0' aria-labelledby='source-title')
            code(v-text='sourceContent')
    nav-footer
    notify
    search-results
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { getPageDownloadPath } from '../helpers/page-actions'
import { wikiStore } from '@/store/index.ts'
import { decodeBase64Json, decodeBase64Text } from '../helpers/base64'

export default defineComponent({
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
    },
    contentBase64: {
      type: String,
      required: true
    }
  },
  data () {
    return {
      sourceContent: decodeBase64Text(this.contentBase64)
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
    async copySource () {
      try {
        await navigator.clipboard.writeText(this.sourceContent)
        wikiStore.showNotification({
          style: 'success',
          message: 'Source copied to clipboard.',
          icon: 'content-copy'
        })
      } catch {
        wikiStore.showNotification({
          style: 'red',
          message: 'Copy failed. Select the source text and copy it manually.',
          icon: 'alert'
        })
      }
    },
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
})
</script>

<style lang='scss'>
.source {
  .v-application__wrap {
    min-height: 100dvh;
  }

  .nav-footer {
    flex: 0 0 auto;
  }
}

.source-main {
  min-height: 0;
  background:
    radial-gradient(circle at 88% 0%, rgba(var(--v-theme-primary), .07), transparent 30rem),
    rgb(var(--v-theme-background));
}

/* Shared with the standard navigation header: keep source controls legible over a scrolling page. */
.source-toolbar {
  --source-toolbar-tint: linear-gradient(90deg, color-mix(in srgb, var(--wiki-accent-warm) 8%, transparent), transparent 42%, color-mix(in srgb, var(--wiki-accent-spectral) 6%, transparent));
  min-height: 86px !important;
  padding-inline: var(--wiki-page-gutter);
  border-bottom: 1px solid var(--wiki-surface-border) !important;
  background-color: var(--wiki-chrome-surface) !important;
  background-image: var(--source-toolbar-tint) !important;
  box-shadow: 0 3px 10px color-mix(in srgb, var(--wiki-shadow-color) 35%, transparent) !important;
  backdrop-filter: var(--wiki-chrome-blur) !important;
  -webkit-backdrop-filter: var(--wiki-chrome-blur) !important;

  @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    border-bottom-color: var(--wiki-glass-border) !important;
  }
}

.source-toolbar .v-toolbar__content {
  background: transparent !important;
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
  gap: var(--wiki-space-3);
  margin-top: 3px;
  color: rgb(var(--v-theme-on-surface));
  font-size: var(--wiki-type-micro);
  opacity: .56;
}

.source-toolbar-actions {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
  min-width: 0;

  .v-btn {
    border-radius: var(--wiki-control-radius);
  }
}

.source-shell {
  width: min(100%, var(--wiki-content-max));
  margin: 0 auto;
  padding: var(--wiki-space-6) var(--wiki-page-gutter) var(--wiki-space-12) !important;
}

.source-code-card {
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-md);

  pre {
    overflow-x: auto;
    overflow-y: visible;
    margin: 0;
    padding: clamp(18px, 3vw, 30px);
    white-space: pre;
  }

  pre > code {
    display: block;
    min-width: max-content;
    background: transparent;
    box-shadow: none;
    color: rgb(var(--v-theme-on-surface));
    font-family: var(--wiki-font-mono);
    font-size: .875rem;
    font-weight: 400;
    line-height: 1.65;
    white-space: inherit;

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
      padding: 16px;
    }
  }
}

@media (max-width: 360px) {
  .source-toolbar {
    min-height: 0 !important;
    padding-block: 8px;
  }

  .source-toolbar .v-toolbar__content {
    height: auto !important;
    min-height: 0;
    flex-wrap: wrap;
    row-gap: 8px;
  }

  .source-toolbar .v-spacer {
    display: none;
  }

  .source-toolbar-copy,
  .source-toolbar-actions {
    flex: 1 1 100%;
    max-width: none;
  }

  .source-toolbar-actions {
    justify-content: flex-end;
  }
}
</style>
