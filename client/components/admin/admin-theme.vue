<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-paint-palette.svg', alt='Theme', style='width: 80px;')
          .admin-header-title
            .headline.primary--text.animated.fadeInLeft {{$t('admin:theme.title')}}
            .subtitle-1.grey--text.animated.fadeInLeft.wait-p2s {{$t('admin:theme.subtitle')}}
          v-spacer
          v-btn.animated.fadeInRight(color='success', depressed, @click='save', large, :loading='loading')
            v-icon(left) mdi-check
            span {{$t('common:actions.apply')}}
        v-form.pt-3
          v-row
            v-col(lg='6' cols='12')
              v-card.animated.fadeInUp
                v-toolbar(color='primary', dark, dense, flat)
                  v-toolbar-title.subtitle-1 {{$t('admin:theme.title')}}
                v-card-text
                  v-select(
                    :items='themes'
                    item-title='text'
                    outlined
                    prepend-icon='mdi-palette'
                    v-model='config.theme'
                    :label='$t(`admin:theme.siteTheme`)'
                    persistent-hint
                    :hint='$t(`admin:theme.siteThemeHint`)'
                    )
                    template(v-slot:item='data')
                      v-avatar
                        v-icon.blue--text(dark) mdi-image-filter-frames
                      div.v-list-item-content
                        v-list-item-title(v-html='data.item.text')
                        v-list-item-subtitle(v-html='data.item.author')
                  v-select.mt-3(
                    :items='iconsets'
                    item-title='text'
                    outlined
                    prepend-icon='mdi-paw'
                    v-model='config.iconset'
                    :label='$t(`admin:theme.iconset`)'
                    persistent-hint
                    :hint='$t(`admin:theme.iconsetHint`)'
                    )
                  v-divider.mt-3
                  v-switch(
                    inset
                    v-model='darkMode'
                    :label='$t(`admin:theme.darkMode`)'
                    color='primary'
                    persistent-hint
                    :hint='$t(`admin:theme.darkModeHint`)'
                    )

              v-card.mt-3.animated.fadeInUp.wait-p1s
                v-toolbar(color='primary', dark, dense, flat)
                  v-toolbar-title.subtitle-1 {{$t(`admin:theme.options`)}}
                v-card-text
                  v-select(
                    :items='tocPositions'
                    item-title='text'
                    outlined
                    prepend-icon='mdi-border-vertical'
                    v-model='config.tocPosition'
                    label='Table of Contents Position'
                    persistent-hint
                    hint='Select whether the table of contents is shown on the left, right or not at all.'
                    )
            v-col(lg='6' cols='12')

              v-card.animated.fadeInUp.wait-p2s
                v-toolbar(color='primary', dark, dense, flat)
                  v-toolbar-title.subtitle-1 {{$t(`admin:theme.codeInjection`)}}
                v-card-text
                  v-textarea.is-monospaced(
                    v-model='config.injectCSS'
                    :label='$t(`admin:theme.cssOverride`)'
                    outlined
                    color='primary'
                    persistent-hint
                    :hint='$t(`admin:theme.cssOverrideHint`)'
                    auto-grow
                    )
                  i18next.caption.pl-2.ml-1(path='admin:theme.cssOverrideWarning', tag='div')
                    strong.red--text(place='caution') {{$t('admin:theme.cssOverrideWarningCaution')}}
                    code(place='cssClass') .contents
                  v-textarea.is-monospaced.mt-3(
                    v-model='config.injectHead'
                    :label='$t(`admin:theme.headHtmlInjection`)'
                    outlined
                    color='primary'
                    persistent-hint
                    :hint='$t(`admin:theme.headHtmlInjectionHint`)'
                    auto-grow
                    )
                  v-textarea.is-monospaced.mt-2(
                    v-model='config.injectBody'
                    :label='$t(`admin:theme.bodyHtmlInjection`)'
                    outlined
                    color='primary'
                    persistent-hint
                    :hint='$t(`admin:theme.bodyHtmlInjectionHint`)'
                    auto-grow
                    )
</template>

<script lang='ts'>
import { wikiStore } from '@/store/index.ts'

import { fetchThemeConfig, saveThemeConfig } from '../../helpers/theming-api'
import { loadingStart, loadingStop, showNotification, pushGraphError } from '../../helpers/root-ui-store'

export default {
  data() {
    return {
      loading: false,
      themes: [
        { text: 'Default', author: 'requarks.io', value: 'default', isInstalled: true, installDate: '', updatedAt: '' }
      ],
      iconsets: [
        { text: 'Material Design Icons (default)', value: 'mdi' },
        { text: 'Font Awesome 5', value: 'fa' },
        { text: 'Font Awesome 4', value: 'fa4' }
      ],
      config: {
        theme: 'default',
        darkMode: false,
        iconset: '',
        tocPosition: 'left',
        injectCSS: '',
        injectHead: '',
        injectBody: ''
      },
      darkModeInitial: false
    }
  },
  computed: {
    darkMode: {
      get (): boolean {
        return wikiStore.site.dark
      },
      set (value: boolean) {
        wikiStore.site.dark = value
      }
    },
    headers() {
      return [
        {
          title: this.$t('admin:theme.downloadName'),
          align: 'left',
          value: 'text'
        },
        {
          title: this.$t('admin:theme.downloadAuthor'),
          align: 'left',
          value: 'author'
        },
        {
          title: this.$t('admin:theme.downloadDownload'),
          align: 'center',
          value: 'value',
          sortable: false,
          width: 100
        }
      ]
    },
    tocPositions () {
      return [
        { text: 'Left (default)', value: 'left' },
        { text: 'Right', value: 'right' },
        { text: 'Hidden', value: 'off' }
      ]
    }
  },
  watch: {
    'darkMode' (newValue, oldValue) {
      void this.$vuetify.theme.change(newValue ? 'dark' : 'light', false)
    }
  },
  mounted() {
    this.darkModeInitial = this.darkMode
    this.loadConfig().catch(() => {})
  },
  beforeUnmount() {
    this.darkMode = this.darkModeInitial
    void this.$vuetify.theme.change(this.darkModeInitial ? 'dark' : 'light', false)
  },
  methods: {
    async loadConfig () {
      loadingStart(wikiStore, 'admin-theme-refresh')
      try {
        this.config = await fetchThemeConfig(window.fetch.bind(window), 'Theme config response is invalid')
      } catch (err) {
        pushGraphError(wikiStore, err)
        throw err
      } finally {
        loadingStop(wikiStore, 'admin-theme-refresh')
      }
    },
    async save () {
      this.loading = true
      loadingStart(wikiStore, 'admin-theme-save')
      try {
        await saveThemeConfig(window.fetch.bind(window), {
          theme: this.config.theme,
          iconset: this.config.iconset,
          darkMode: this.darkMode,
          tocPosition: this.config.tocPosition,
          injectCSS: this.config.injectCSS,
          injectHead: this.config.injectHead,
          injectBody: this.config.injectBody
        }, 'Theme config update failed')
        this.darkModeInitial = this.darkMode
        showNotification(wikiStore, {
          message: 'Theme settings updated successfully.',
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        pushGraphError(wikiStore, err)
      }
      loadingStop(wikiStore, 'admin-theme-save')
      this.loading = false
    }
  }
}
</script>

<style lang='scss'>
.v-textarea.is-monospaced textarea {
  font-family: 'Roboto Mono', 'Courier New', Courier, monospace;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
}
</style>
