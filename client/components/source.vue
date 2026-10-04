<template lang='pug'>
  v-app.source
    nav-header
    v-main.source-main
      header.source-toolbar
        .source-toolbar-copy
          .source-eyebrow {{$t('common:header.viewSource')}}
          i18next#source-title.source-toolbar-title(v-if='versionId > 0', path='common:page.viewingSourceVersion', tag='h1')
            strong(place='date', :title='String($helpers.formatMoment(versionDate, `LLL`))') {{ $helpers.formatMoment(versionDate, 'lll') }}
            strong(place='path') /{{path}}
          i18next#source-title.source-toolbar-title(v-else, path='common:page.viewingSource', tag='h1')
            strong(place='path') /{{path}}
          .source-toolbar-meta
            span {{$t('common:page.id', { id: pageId })}}
            span(v-if='versionId > 0') {{$t('common:page.versionId', { id: versionId })}}
            span {{ sourceLines.length }} {{ $t('common:pageSource.lineCountLabel') }}
        v-btn(variant='flat', color='primary', prepend-icon='mdi-arrow-left', :aria-label='$t(`common:pageSource.backToPage`)', @click='goLive') {{$t('common:pageSource.backToPage')}}
      v-container.source-shell(fluid)
        article.source-code-card
          .source-document-toolbar(role='group', :aria-label='$t(`common:header.viewSource`)')
            .source-document-path(dir='ltr') {{locale}}/{{path}}
            .source-toolbar-actions
              v-btn(variant='text', prepend-icon='mdi-history', :aria-label='$t(`common:header.history`)', @click='goHistory') {{$t('common:header.history')}}
              v-btn(variant='text', prepend-icon='mdi-content-copy', :aria-label='$t(`common:actions.copy`)', @click='copySource') {{$t('common:actions.copy')}}
              v-btn(variant='text', prepend-icon='mdi-download', :aria-label='$t(`common:actions.download`)', @click='goDownload') {{$t('common:actions.download')}}
              v-btn(:variant='wrapLines ? `tonal` : `text`', prepend-icon='mdi-wrap', :aria-label='$t(`common:pageSource.wrapLines`)', :aria-pressed='wrapLines ? `true` : `false`', @click='toggleWrap') {{$t('common:pageSource.wrapLines')}}
          //- Line numbers are CSS counters, so copying the text never includes them.
          pre.source-code(
            tabindex='0'
            aria-labelledby='source-title'
            :class='{ "is-wrapped": wrapLines }'
            :style='{ "--source-gutter": `${String(sourceLines.length).length + 1}ch` }'
          )
            code
              span.source-line(v-for='line of sourceLines', :key='line.number') {{ line.text }}
    nav-footer
    notify
    search-results
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { getPageDownloadPath } from '../helpers/page-actions'
import { wikiStore } from '@/store/index.ts'
import { decodeBase64Json, decodeBase64Text } from '../helpers/base64'

const WRAP_PREFERENCE_KEY = 'wiki.source.wrapLines'

function readWrapPreference (): boolean {
  try {
    return window.localStorage.getItem(WRAP_PREFERENCE_KEY) === '1'
  } catch {
    return false
  }
}

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
      sourceContent: decodeBase64Text(this.contentBase64),
      wrapLines: readWrapPreference()
    }
  },
  computed: {
    /** One entry per source line; each keeps its own line break so textContent equals the source. */
    sourceLines (): Array<{ number: number; text: string }> {
      const parts = this.sourceContent.split('\n')
      if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
      const lastIndex = parts.length - 1
      const trailingBreak = this.sourceContent.endsWith('\n')
      return parts.map((text, index) => ({
        number: index + 1,
        text: index < lastIndex || trailingBreak ? `${text}\n` : text
      }))
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
    toggleWrap () {
      this.wrapLines = !this.wrapLines
      try {
        window.localStorage.setItem(WRAP_PREFERENCE_KEY, this.wrapLines ? '1' : '0')
      } catch {
        // Storage can be unavailable (private mode); the toggle still works for this view.
      }
    },
    async copySource () {
      try {
        await navigator.clipboard.writeText(this.sourceContent)
        wikiStore.showNotification({
          style: 'success',
          message: String(this.$t('common:pageSource.copied')),
          icon: 'content-copy'
        })
      } catch {
        wikiStore.showNotification({
          style: 'red',
          message: String(this.$t('common:pageSource.copyFailed')),
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
.source .v-application__wrap { min-height: 100dvh; }
.source-main { min-height: 0; background: rgb(var(--v-theme-background)); }
.source-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--wiki-space-4);
  padding: var(--wiki-space-5) var(--wiki-page-gutter);
  border-bottom: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-raised);
}
.source-toolbar-copy { min-width: 0; flex: 1 1 24rem; }
.source-eyebrow { color: var(--wiki-text-muted); font-size: .8125rem; font-weight: 600; }
.source-toolbar-title {
  margin: var(--wiki-space-1) 0;
  color: rgb(var(--v-theme-on-surface));
  font-size: 1.125rem;
  font-weight: 500;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.source-toolbar-meta { display: flex; flex-wrap: wrap; gap: var(--wiki-space-3); color: var(--wiki-text-muted); font-size: .8125rem; }
.source-shell { width: min(100%, var(--wiki-content-max)); margin: 0 auto; padding: var(--wiki-space-5) var(--wiki-page-gutter) var(--wiki-space-10) !important; }
.source-code-card {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
}
.source-document-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-2) var(--wiki-space-3);
  border-bottom: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-sunken);
}
.source-document-path { min-width: 0; overflow-wrap: anywhere; font-family: var(--wiki-font-mono); font-size: .8125rem; color: var(--wiki-text-muted); }
.source-toolbar-actions { display: flex; flex-wrap: wrap; gap: var(--wiki-space-1); }
.source .v-btn { border-radius: var(--wiki-control-radius); text-transform: none; letter-spacing: normal; }
.source-code {
  overflow: auto;
  max-height: 72dvh;
  margin: 0;
  padding: var(--wiki-space-4) var(--wiki-space-3);
  white-space: pre;
  counter-reset: source-line;
  direction: ltr;
  text-align: left;
  &:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: -2px; }
  &.is-wrapped { white-space: pre-wrap; overflow-wrap: anywhere; > code { min-width: 0; } }
  > code {
    display: block;
    min-width: max-content;
    background: transparent;
    box-shadow: none;
    color: rgb(var(--v-theme-on-surface));
    font-family: var(--wiki-font-mono);
    font-size: .875rem;
    font-weight: 400;
    line-height: 1.7;
    white-space: inherit;
    &::before { display: none; }
  }
}
.source-line {
  display: block;
  position: relative;
  padding-inline-start: calc(var(--source-gutter, 4ch) + 1.25rem);
  &::before {
    position: absolute;
    inset-inline-start: 0;
    width: var(--source-gutter, 4ch);
    color: var(--wiki-text-muted);
    content: counter(source-line);
    counter-increment: source-line;
    font-variant-numeric: tabular-nums;
    text-align: end;
    user-select: none;
  }
}
@media (max-width: 599px) {
  .source-toolbar { padding: var(--wiki-space-4) var(--wiki-space-3); }
  .source-shell { padding: var(--wiki-space-3) var(--wiki-space-2) var(--wiki-space-6) !important; }
  .source .v-btn { min-height: 44px; min-width: 44px; }
  .source-toolbar-actions { width: 100%; }
}
@media print {
  .source-toolbar-actions { display: none; }
  .source-code { max-height: none; overflow: visible; }
}
</style>
