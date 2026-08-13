<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-row()
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-globe-earth.svg', alt='Locale', style='width: 80px;')
          .admin-header-title
            .headline.primary--text.animated.fadeInLeft {{ $t('admin:locale.title') }}
            .subtitle-1.grey--text.animated.fadeInLeft.wait-p4s {{ $t('admin:locale.subtitle') }}
          v-spacer
          v-btn.animated.fadeInDown.wait-p3s(icon, outlined, color='grey', href='https://docs.requarks.io/locales', target='_blank')
            v-icon mdi-help-circle
          v-btn.animated.fadeInDown.ml-3(color='success', depressed, @click='save', large, :loading='loading', :disabled='!configLoaded')
            v-icon(left) mdi-check
            span {{$t('common:actions.apply')}}
        v-form.pt-3
          v-row
            v-col(xl='6' lg='5' cols='12')
              v-card.wiki-form.animated.fadeInUp
                v-toolbar(color='primary', dark, dense, flat)
                  v-toolbar-title.subtitle-1 {{ $t('admin:locale.settings') }}
                v-card-text
                  v-select(
                    outlined
                    :items='installedLocales'
                    prepend-icon='mdi-web'
                    v-model='selectedLocale'
                    item-value='code'
                    item-title='nativeName'
                    :label='namespacing ? $t("admin:locale.base.labelWithNS") : $t("admin:locale.base.label")'
                    persistent-hint
                    :hint='$t("admin:locale.base.hint")'
                  )
                    template(v-slot:item='data')
                      template(v-if='typeof data.item !== "object"')
                        div.v-list-item-content(v-text='data.item')
                      template(v-else)
                        v-avatar
                          v-avatar.blue.white--text(tile, size='40', v-html='data.item.code.toUpperCase()')
                        div.v-list-item-content
                          v-list-item-title(v-html='data.item.name')
                          v-list-item-subtitle(v-html='data.item.nativeName')
                  v-divider.mt-3
                  v-switch(
                    inset
                    v-model='autoUpdate'
                    :label='$t("admin:locale.autoUpdate.label")'
                    color='primary'
                    persistent-hint
                    :hint='namespacing ? $t("admin:locale.autoUpdate.hintWithNS") : $t("admin:locale.autoUpdate.hint")'
                  )

              v-card.wiki-form.mt-3.animated.fadeInUp.wait-p2s
                v-toolbar(color='primary', dark, dense, flat)
                  v-toolbar-title.subtitle-1 {{ $t('admin:locale.namespacing') }}
                v-card-text
                  v-switch(
                    inset
                    v-model='namespacing'
                    :label='$t("admin:locale.namespaces.label")'
                    color='primary'
                    persistent-hint
                    :hint='$t("admin:locale.namespaces.hint")'
                    )
                  v-alert.mt-3(
                    outlined
                    color='orange'
                    :value='true'
                    icon='mdi-alert'
                    )
                    span {{ $t('admin:locale.namespacingPrefixWarning.title', { langCode: selectedLocale }) }}
                    .caption.grey--text {{ $t('admin:locale.namespacingPrefixWarning.subtitle') }}
                  v-divider.mt-3.mb-4
                  v-select(
                    outlined
                    :disabled='!namespacing'
                    :items='installedLocales'
                    prepend-icon='mdi-web'
                    multiple
                    chips
                    deletable-chips
                    v-model='namespaces'
                    item-value='code'
                    item-title='name'
                    :label='$t("admin:locale.activeNamespaces.label")'
                    persistent-hint
                    small-chips
                    :hint='$t("admin:locale.activeNamespaces.hint")'
                    )
                    template(v-slot:item='data')
                      template(v-if='typeof data.item !== "object"')
                        div.v-list-item-content(v-text='data.item')
                      template(v-else)
                        v-avatar
                          v-avatar.blue.white--text(tile, size='40', v-html='data.item.code.toUpperCase()')
                        div.v-list-item-content
                          v-list-item-title(v-html='data.item.name')
                          v-list-item-subtitle(v-html='data.item.nativeName')
                        div.v-list-item-action
                          v-checkbox(:input-value='data.attrs.inputValue', color='primary', value)
            v-col(xl='6' lg='7' cols='12')
              v-card.animated.fadeInUp.wait-p4s
                v-toolbar(color='teal', dark, dense, flat)
                  v-toolbar-title.subtitle-1 {{ $t('admin:locale.downloadTitle') }}
                v-data-table(
                  :headers='headers',
                  :items='locales',
                  hide-default-footer,
                  item-key='code',
                  :items-per-page='1000'
                  )
                  template(v-slot:item.code='{ item }')
                    v-chip.white--text(label, color='teal', small) {{item.code}}
                  template(v-slot:item.name='{ item }')
                    strong {{item.name}}
                  template(v-slot:item.isRTL='{ item }')
                    v-icon(v-if='item.isRTL') mdi-check
                  template(v-slot:item.availability='{ item }')
                    .d-flex.align-center.pl-4
                      v-progress-circular(:value='item.availability', width='2', size='20', :color='item.availability <= 33 ? `red` : (item.availability <= 66) ? `orange` : `green`')
                      .caption.mx-2(:class='item.availability <= 33 ? `red--text` : (item.availability <= 66) ? `orange--text` : `green--text`') {{item.availability}}%
                  template(v-slot:item.isInstalled='{ item }')
                    v-progress-circular(v-if='item.isDownloading', indeterminate, color='blue', size='20', :width='2')
                    v-btn(v-else-if='item.isInstalled && item.installDate < item.updatedAt', icon, small, @click='download(item)')
                      v-icon.blue--text mdi-cached
                    v-btn(v-else-if='item.isInstalled', icon, small, @click='download(item)')
                      v-icon.green--text mdi-check-bold
                    v-btn(v-else, icon, small, @click='download(item)')
                      v-icon.grey--text mdi-cloud-download
              v-card.wiki-form.mt-3.animated.fadeInUp.wait-p5s
                v-toolbar(color='teal', dark, dense, flat)
                  v-toolbar-title.subtitle-1 {{ $t('admin:locale.sideload') }}
                  v-spacer
                  v-chip(label, color='white', small).teal--text coming soon
                v-card-text
                  div {{ $t('admin:locale.sideloadHelp') }}
                  v-btn.ml-0.mt-3(color='teal', disabled) {{ $t('common:actions.browse') }}
</template>

<script lang='ts'>
import _ from 'lodash'

import { fetchLocales, fetchLocaleConfig, saveLocaleConfig, downloadLocale, type LocaleRow } from '../../helpers/locales-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'

type LocaleTableRow = LocaleRow & {
  isDownloading: boolean
}

export default {
  data() {
    return {
      loading: false,
      locales: [] as LocaleTableRow[],
      selectedLocale: 'en',
      autoUpdate: false,
      namespacing: false,
      namespaces: [] as string[],
      configLoaded: false
    }
  },
  computed: {
    installedLocales() {
      return _.filter(this.locales, ['isInstalled', true])
    },
    headers() {
      return [
        {
          text: this.$t('admin:locale.code'),
          align: 'left',
          value: 'code',
          width: 90
        },
        {
          text: this.$t('admin:locale.name'),
          align: 'left',
          value: 'name'
        },
        {
          text: this.$t('admin:locale.nativeName'),
          align: 'left',
          value: 'nativeName'
        },
        {
          text: this.$t('admin:locale.rtl'),
          align: 'center',
          value: 'isRTL',
          sortable: false,
          width: 10
        },
        {
          text: this.$t('admin:locale.availability'),
          align: 'center',
          value: 'availability',
          sortable: false,
          width: 120
        },
        {
          text: this.$t('admin:locale.download'),
          align: 'center',
          value: 'isInstalled',
          sortable: false,
          width: 100
        }
      ]
    }
  },
  methods: {
    async loadBootstrap() {
      wikiStore.startLoading('admin-locale-refresh')

      const [localesResult, configResult] = await Promise.allSettled([
        fetchLocales(window.fetch.bind(window), 'Locales response is invalid'),
        fetchLocaleConfig(window.fetch.bind(window), 'Locale config response is invalid')
      ])

      if (localesResult.status === 'fulfilled') {
        this.locales = localesResult.value.map(lc => ({ ...lc, isDownloading: false }))
      } else {
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(localesResult.reason),
          icon: 'alert'
        })
      }

      if (configResult.status === 'fulfilled') {
        this.selectedLocale = configResult.value.locale
        this.autoUpdate = configResult.value.autoUpdate
        this.namespacing = configResult.value.namespacing
        this.namespaces = configResult.value.namespaces
        this.configLoaded = true
      } else {
        this.configLoaded = false
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(configResult.reason),
          icon: 'alert'
        })
      }

      wikiStore.stopLoading('admin-locale-refresh')
    },
    async download(lc: LocaleTableRow) {
      lc.isDownloading = true
      try {
        await downloadLocale(window.fetch.bind(window), lc.code, 'Locale download failed')
        lc.isInstalled = true
        lc.updatedAt = new Date().toISOString()
        lc.installDate = lc.updatedAt
        wikiStore.showNotification({
          message: `Locale ${lc.name} has been installed successfully.`,
          style: 'success',
          icon: 'get_app'
        })
      } catch (err) {
        wikiStore.showNotification({
          message: `Error: ${getErrorMessage(err)}`,
          style: 'error',
          icon: 'warning'
        })
      }
      lc.isDownloading = false
    },
    async save() {
      if (!this.configLoaded) {
        return
      }

      this.loading = true
      try {
        await saveLocaleConfig(window.fetch.bind(window), {
          locale: this.selectedLocale,
          autoUpdate: this.autoUpdate,
          namespacing: this.namespacing,
          namespaces: this.namespaces
        }, 'Locale settings update failed')

        // Change UI language
        void this.$i18n.changeLanguage(this.selectedLocale)
        this.$moment.locale(this.selectedLocale)

        // Check for RTL
        const curLocale = _.find(this.locales, ['code', this.selectedLocale])
        this.$vuetify.locale.rtl[this.selectedLocale] = Boolean(curLocale && curLocale.isRTL)

        wikiStore.showNotification({
          message: 'Locale settings updated successfully.',
          style: 'success',
          icon: 'check'
        })

        _.delay(() => {
          window.location.reload()
        }, 1000)
      } catch (err) {
        wikiStore.showNotification({
          message: `Error: ${getErrorMessage(err)}`,
          style: 'error',
          icon: 'warning'
        })
      }
      this.loading = false
    }
  },
  created() {
    this.loadBootstrap()
  }
}
</script>
