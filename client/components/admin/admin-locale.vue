<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        admin-hero(
          icon='/_assets/svg/icon-globe-earth.svg'
          :title='$t(`admin:locale.title`)'
          :description='$t(`admin:locale.subtitle`)'
        )
          template(v-slot:actions)
            v-btn(
              icon
              variant="outlined"
              color='grey'
              href='https://docs.requarks.io/locales'
              target='_blank'
              rel='noopener noreferrer'
              aria-label='Open locale documentation'
              title='Open locale documentation'
            )
              v-icon(aria-hidden='true') mdi-help-circle
            v-btn(
              color='success'
              variant="flat"
              @click='save'
              size="large"
              :loading='loading'
              :disabled='!canSave'
            )
              v-icon(start, aria-hidden='true') mdi-check
              span {{$t('common:actions.apply')}}
        v-form
          v-row
            v-col(xl='6' lg='5' cols='12')
              v-card.wiki-form.animated.fadeInUp
                v-toolbar(color='primary', density="compact", flat)
                  v-toolbar-title.text-body-large {{ $t('admin:locale.settings') }}
                v-card-text
                  async-state(v-if='!configLoaded && !configError', state='loading', title='Loading locale settings', message='Fetching current locale configuration.')
                  v-select(
                    variant="outlined"
                    :items='installedLocales'
                    prepend-icon='mdi-web'
                    v-model='selectedLocale'
                    item-value='code'
                    item-title='nativeName'
                    :label='namespacing ? $t("admin:locale.base.labelWithNS") : $t("admin:locale.base.label")'
                    persistent-hint
                    :hint='$t("admin:locale.base.hint")'
                    :disabled='!configLoaded || !localesLoaded'
                    :error-messages='configError || localesError'
                  )
                    template(v-slot:item='{ props, item }')
                      v-list-item(v-bind='props')
                        template(v-slot:prepend)
                          v-avatar.bg-blue.text-white(rounded='0', size='40') {{ (item.raw || item).code?.toUpperCase() }}
                        template(v-slot:title) {{ (item.raw || item).name }}
                        template(v-slot:subtitle) {{ (item.raw || item).nativeName }}
                  v-alert.mt-3(v-if='configError || localesError', variant='outlined', color='error', icon='mdi-alert')
                    span(v-if='configError') Locale configuration could not be loaded.
                    span(v-else) Installed locales could not be loaded.
                    v-btn.ml-2(variant='text', size='small', @click='loadBootstrap') Retry
                  v-divider.mt-3
                  v-switch(
                    inset
                    v-model='autoUpdate'
                    :label='$t("admin:locale.autoUpdate.label")'
                    color='primary'
                    persistent-hint
                    :hint='namespacing ? $t("admin:locale.autoUpdate.hintWithNS") : $t("admin:locale.autoUpdate.hint")'
                    :disabled='!configLoaded || !localesLoaded'
                  )

              v-card.wiki-form.mt-3.animated.fadeInUp.wait-p2s
                v-toolbar(color='primary', density="compact", flat)
                  v-toolbar-title.text-body-large {{ $t('admin:locale.namespacing') }}
                v-card-text
                  v-switch(
                    inset
                    v-model='namespacing'
                    :label='$t("admin:locale.namespaces.label")'
                    color='primary'
                    persistent-hint
                    :hint='$t("admin:locale.namespaces.hint")'
                    :disabled='!configLoaded || !localesLoaded'
                    )
                  v-alert.mt-3(
                    v-if='namespacing && configLoaded'
                    variant="outlined"
                    color='warning'
                    icon='mdi-alert'
                    )
                    span {{ $t('admin:locale.namespacingPrefixWarning.title', { langCode: selectedLocale }) }}
                    .text-body-small.text-medium-emphasis {{ $t('admin:locale.namespacingPrefixWarning.subtitle') }}
                  v-divider.mt-3.mb-4
                  v-select(
                    variant="outlined"
                    :disabled='!namespacing || !configLoaded || !localesLoaded'
                    :items='installedLocales'
                    prepend-icon='mdi-web'
                    multiple
                    chips
                    closable-chips
                    v-model='namespaces'
                    item-value='code'
                    item-title='name'
                    :label='$t("admin:locale.activeNamespaces.label")'
                    persistent-hint
                    :hint='$t("admin:locale.activeNamespaces.hint")'
                    )
                    template(v-slot:item='{ props, item }')
                      v-list-item(v-bind='props')
                        template(v-slot:prepend)
                          v-avatar.bg-blue.text-white(rounded='0', size='40') {{ (item.raw || item).code?.toUpperCase() }}
                        template(v-slot:title) {{ (item.raw || item).name }}
                        template(v-slot:subtitle) {{ (item.raw || item).nativeName }}
                        template(v-slot:append)
                          v-icon(
                            :icon='namespaces.includes((item.raw || item).code) ? `mdi-checkbox-marked` : `mdi-checkbox-blank-outline`'
                            :color='namespaces.includes((item.raw || item).code) ? `primary` : undefined'
                            aria-hidden='true'
                          )
            v-col(xl='6' lg='7' cols='12')
              v-card.animated.fadeInUp.wait-p4s
                v-toolbar(color='teal', density="compact", flat)
                  v-toolbar-title.text-body-large {{ $t('admin:locale.downloadTitle') }}
                v-data-table.admin-responsive-table(
                  :headers='headers'
                  :items='locales'
                  :loading='localesLoading'
                  :hide-default-header='$vuetify.display.smAndDown'
                  hide-default-footer
                  item-value='code'
                  :items-per-page='1000'
                )
                  template(v-slot:item='props')
                    tr(v-if='$vuetify.display.mdAndUp')
                      td
                        v-chip.text-white(label, color='teal', size="small") {{ props.item.code }}
                      td: strong {{ props.item.name }}
                      td {{ props.item.nativeName }}
                      td.text-center
                        v-icon(v-if='props.item.isRTL', aria-label='Right-to-left locale') mdi-check
                      td
                        .d-flex.align-center
                          v-progress-circular(:model-value='props.item.availability', width='2', size='20', :color='props.item.availability <= 33 ? `error` : (props.item.availability <= 66) ? `warning` : `success`', :aria-label='`${props.item.name} translation availability`', :aria-valuetext='`${props.item.availability}%`')
                          .text-body-small.mx-2 {{ props.item.availability }}%
                      td.text-center
                        v-progress-circular(v-if='props.item.isDownloading', indeterminate, color='primary', size='20', :width='2', :aria-label='`Downloading ${props.item.name}`')
                        v-btn(v-else-if='props.item.isInstalled && props.item.installDate < props.item.updatedAt', icon, size="small", @click='download(props.item)', :aria-label='`Update ${props.item.name} locale`', :title='`Update ${props.item.name} locale`')
                          v-icon.text-primary(aria-hidden='true') mdi-cached
                        v-btn(v-else-if='props.item.isInstalled', icon, size="small", @click='download(props.item)', :aria-label='`Reinstall ${props.item.name} locale`', :title='`Reinstall ${props.item.name} locale`')
                          v-icon.text-success(aria-hidden='true') mdi-check-bold
                        v-btn(v-else, icon, size="small", @click='download(props.item)', :aria-label='`Download ${props.item.name} locale`', :title='`Download ${props.item.name} locale`')
                          v-icon(aria-hidden='true') mdi-cloud-download
                    tr.admin-mobile-table-row(v-else)
                      td(:colspan='headers.length')
                        .admin-mobile-record
                          .admin-mobile-record-title {{ props.item.nativeName }}
                          .admin-mobile-record-meta {{ props.item.name }} ({{ props.item.code }})
                          .d-flex.align-center.mt-2
                            v-progress-circular(:model-value='props.item.availability', width='2', size='20', :color='props.item.availability <= 33 ? `error` : (props.item.availability <= 66) ? `warning` : `success`', :aria-label='`${props.item.name} translation availability`', :aria-valuetext='`${props.item.availability}%`')
                            span.ml-2 {{ props.item.availability }}%
                            v-spacer
                            v-progress-circular(v-if='props.item.isDownloading', indeterminate, color='primary', size='20', :width='2', :aria-label='`Downloading ${props.item.name}`')
                            v-btn(v-else-if='props.item.isInstalled && props.item.installDate < props.item.updatedAt', icon, size="small", @click='download(props.item)', :aria-label='`Update ${props.item.name} locale`', :title='`Update ${props.item.name} locale`')
                              v-icon.text-primary(aria-hidden='true') mdi-cached
                            v-btn(v-else-if='props.item.isInstalled', icon, size="small", @click='download(props.item)', :aria-label='`Reinstall ${props.item.name} locale`', :title='`Reinstall ${props.item.name} locale`')
                              v-icon.text-success(aria-hidden='true') mdi-check-bold
                            v-btn(v-else, icon, size="small", @click='download(props.item)', :aria-label='`Download ${props.item.name} locale`', :title='`Download ${props.item.name} locale`')
                              v-icon(aria-hidden='true') mdi-cloud-download
                  template(v-slot:no-data)
                    async-state(v-if='localesLoading', state='loading', title='Loading locales', message='Fetching available locales.')
                    async-state(v-else-if='localesError', state='error', title='Locales could not be loaded', :message='localesError', retry-label='Try again', @retry='loadBootstrap')
                    async-state(v-else, state='empty', title='No locales available', message='No locale packages are available to install.')

</template>
<script lang='ts'>
import { markRaw } from 'vue'
import AsyncState from '@/components/common/async-state.vue'

import { fetchLocales, fetchLocaleConfig, saveLocaleConfig, downloadLocale, type LocaleRow } from '../../helpers/locales-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'

type LocaleTableRow = LocaleRow & {
  isDownloading: boolean
}

const createAbortableFetch = (signal: AbortSignal) => (
  input: RequestInfo | URL,
  init?: RequestInit
) => window.fetch(input, { ...init, signal })

export default {
  components: { AsyncState },
  data() {
    return {
      loading: false,
      locales: [] as LocaleTableRow[],
      selectedLocale: 'en',
      autoUpdate: false,
      namespacing: false,
      namespaces: [] as string[],
      configLoaded: false,
      configError: '',
      localesLoaded: false,
      localesLoading: false,
      localesError: '',
      loadController: null as AbortController | null,
      saveController: null as AbortController | null,
      downloadControllers: markRaw(new Map<string, AbortController>()),
      reloadTimer: null as number | null,
      isUnmounted: false
    }
  },
  computed: {
    installedLocales() {
      return this.locales.filter(locale => locale.isInstalled)
    },
    canSave() {
      return !this.loading && this.configLoaded && this.localesLoaded &&
        this.installedLocales.some(locale => locale.code === this.selectedLocale)
    },
    headers() {
      return [
        {
          title: this.$t('admin:locale.code'),
          align: 'start',
          key: 'code',
          value: 'code',
          width: 90
        },
        {
          title: this.$t('admin:locale.name'),
          align: 'start',
          key: 'name',
          value: 'name'
        },
        {
          title: this.$t('admin:locale.nativeName'),
          align: 'start',
          key: 'nativeName',
          value: 'nativeName'
        },
        {
          title: this.$t('admin:locale.rtl'),
          align: 'center',
          key: 'isRTL',
          value: 'isRTL',
          sortable: false,
          width: 10
        },
        {
          title: this.$t('admin:locale.availability'),
          align: 'center',
          key: 'availability',
          value: 'availability',
          sortable: false,
          width: 120
        },
        {
          title: this.$t('admin:locale.download'),
          align: 'center',
          key: 'isInstalled',
          value: 'isInstalled',
          sortable: false,
          width: 100
        }
      ]
    }
  },
  methods: {
    async loadBootstrap() {
      if (this.localesLoading) return
      const controller = new AbortController()
      this.loadController = controller
      this.localesLoading = true
      this.configError = ''
      this.localesError = ''
      wikiStore.startLoading('admin-locale-refresh')
      try {
        const [localesResult, configResult] = await Promise.allSettled([
          fetchLocales(createAbortableFetch(controller.signal), 'Locales response is invalid'),
          fetchLocaleConfig(createAbortableFetch(controller.signal), 'Locale config response is invalid')
        ])
        if (controller.signal.aborted) return

        if (localesResult.status === 'fulfilled') {
          this.locales = localesResult.value.map(lc => ({ ...lc, isDownloading: false }))
          this.localesLoaded = true
        } else {
          this.localesLoaded = false
          this.localesError = getErrorMessage(localesResult.reason)
          wikiStore.showNotification({
            style: 'red',
            message: this.localesError,
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
          this.configError = getErrorMessage(configResult.reason)
          wikiStore.showNotification({
            style: 'red',
            message: this.configError,
            icon: 'alert'
          })
        }
      } finally {
        if (this.loadController === controller) {
          this.loadController = null
          if (!this.isUnmounted) this.localesLoading = false
        }
        wikiStore.stopLoading('admin-locale-refresh')
      }
    },
    async download(lc: LocaleTableRow) {
      if (lc.isDownloading) return
      const controller = new AbortController()
      this.downloadControllers.set(lc.code, controller)
      lc.isDownloading = true
      try {
        await downloadLocale(createAbortableFetch(controller.signal), lc.code, 'Locale download failed')
        if (controller.signal.aborted) return
        lc.isInstalled = true
        lc.updatedAt = new Date().toISOString()
        lc.installDate = lc.updatedAt
        wikiStore.showNotification({
          message: `Locale ${lc.name} has been installed successfully.`,
          style: 'success',
          icon: 'get_app'
        })
      } catch (err) {
        if (!controller.signal.aborted) {
          wikiStore.showNotification({
            message: `Error: ${getErrorMessage(err)}`,
            style: 'error',
            icon: 'warning'
          })
        }
      } finally {
        if (this.downloadControllers.get(lc.code) === controller) {
          this.downloadControllers.delete(lc.code)
          if (!this.isUnmounted) lc.isDownloading = false
        }
      }
    },
    async save() {
      if (!this.canSave || this.loading) return
      const controller = new AbortController()
      this.saveController = controller
      this.loading = true
      try {
        await saveLocaleConfig(createAbortableFetch(controller.signal), {
          locale: this.selectedLocale,
          autoUpdate: this.autoUpdate,
          namespacing: this.namespacing,
          namespaces: this.namespaces
        }, 'Locale settings update failed')
        if (controller.signal.aborted) return

        // Change UI language
        void this.$i18n.changeLanguage(this.selectedLocale)
        this.$moment.locale(this.selectedLocale)

        // Check for RTL
        const curLocale = this.locales.find(locale => locale.code === this.selectedLocale)
        this.$vuetify.locale.rtl[this.selectedLocale] = Boolean(curLocale?.isRTL)

        wikiStore.showNotification({
          message: 'Locale settings updated successfully.',
          style: 'success',
          icon: 'check'
        })

        this.reloadTimer = window.setTimeout(() => {
          this.reloadTimer = null
          window.location.reload()
        }, 1000)
      } catch (err) {
        if (!controller.signal.aborted) {
          wikiStore.showNotification({
            message: `Error: ${getErrorMessage(err)}`,
            style: 'error',
            icon: 'warning'
          })
        }
      } finally {
        if (this.saveController === controller) {
          this.saveController = null
          if (!this.isUnmounted) this.loading = false
        }
      }
    }
  },
  created() {
    this.loadBootstrap()
  },
  beforeUnmount() {
    this.isUnmounted = true
    this.loadController?.abort()
    this.saveController?.abort()
    this.downloadControllers.forEach(controller => controller.abort())
    this.downloadControllers.clear()
    if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer)
  }
}
</script>
