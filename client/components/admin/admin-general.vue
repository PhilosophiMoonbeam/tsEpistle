<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        admin-hero(
          icon='/_assets/svg/icon-categorize.svg'
          :title='$t(`admin:general.title`)'
          :description='$t(`admin:general.subtitle`)'
        )
          template(v-slot:status)
            v-chip(v-if='dirty', color='warning', variant='tonal', size='small') Unsaved changes
          template(v-slot:actions)
            v-btn(
              type='submit'
              form='general-form'
              color='success'
              variant="flat"
              size="large"
              :loading='saving'
              :disabled='!loaded || initialLoading || saving || !dirty || !formValid'
            )
              v-icon(start) mdi-check
              span {{$t('common:actions.apply')}}
        v-form#general-form(
          @submit.prevent='save'
          v-model='formValid'
          :disabled='initialLoading || !loaded || saving'
        )
          v-row
            v-col(lg='6' cols='12')
                v-card.animated.fadeInUp
                  v-toolbar(color='primary', density="compact", flat)
                    v-toolbar-title.text-body-large {{ $t('admin:general.siteInfo') }}
                  .text-label-small.text-grey.pa-4 {{$t('admin:general.general')}}
                  .px-3.pb-3
                    v-text-field(
                      variant="outlined"
                      :label='$t(`admin:general.siteUrl`)'
                      :rules='hostRules'
                      required
                      :counter='255'
                      v-model='config.host'
                      prepend-icon='mdi-label-variant-outline'
                      :hint='$t(`admin:general.siteUrlHint`)'
                      persistent-hint
                    )
                    v-text-field.mt-3(
                      variant="outlined"
                      :label='$t(`admin:general.siteTitle`)'
                      :rules='titleRules'
                      required
                      :counter='50'
                      v-model='config.title'
                      prepend-icon='mdi-earth'
                      :hint='$t(`admin:general.siteTitleHint`)'
                      persistent-hint
                    )
                  .text-label-small.text-grey.pa-4 {{$t('admin:general.logo')}}
                  .logo-manager.px-4.pb-4
                    .logo-preview-grid
                      .logo-preview-card
                        .logo-preview-heading {{ $t('admin:general.logoActive') }}
                        .logo-preview-frame
                          v-img(
                            v-if='activeLogoUrl'
                            :src='activeLogoUrl'
                            :alt='$t(`admin:general.logoActivePreviewAlt`)'
                          )
                          v-icon(v-else size='42' color='grey') mdi-image-off-outline
                        v-chip.mt-3(
                          v-if='activeLogoUrl'
                          color='success'
                          variant='tonal'
                          size='small'
                        ) {{ $t('admin:general.logoStatusActive') }}
                      .logo-preview-card(v-if='candidateVisible')
                        .logo-preview-heading {{ $t('admin:general.logoCandidate') }}
                        .logo-preview-frame
                          v-img(
                            v-if='candidatePreviewUrl'
                            :src='candidatePreviewUrl'
                            :alt='$t(`admin:general.logoCandidatePreviewAlt`)'
                          )
                          v-icon(v-else size='42' color='grey') mdi-image-sync-outline
                        v-chip.mt-3(
                          :color='candidateStatusColor'
                          variant='tonal'
                          size='small'
                          aria-live='polite'
                        )
                          v-progress-circular(
                            v-if='logoUploading || candidateIsProcessing'
                            indeterminate
                            size='14'
                            width='2'
                            class='mr-2'
                          )
                          | {{ $t(candidateStatusKey) }}
                        v-btn.mt-3(
                          v-if='candidateHasFailed'
                          color='primary'
                          variant='tonal'
                          size='small'
                          :loading='logoRetrying'
                          :disabled='logoUploading || logoRetrying'
                          @click='retryLogo'
                        )
                          v-icon(start) mdi-refresh
                          | {{ $t('admin:general.logoRetry') }}
                    .logo-drop-target(
                      :class='{ "logo-drop-target--active": logoDragActive, "logo-drop-target--disabled": logoUploading || logoRetrying }'
                      role='button'
                      tabindex='0'
                      :aria-label='$t(`admin:general.logoPickerLabel`)'
                      :aria-disabled='logoUploading || logoRetrying'
                      @click='openLogoPicker'
                      @keydown.enter.prevent='openLogoPicker'
                      @keydown.space.prevent='openLogoPicker'
                      @dragenter.prevent='onLogoDragEnter'
                      @dragover.prevent
                      @dragleave.prevent='onLogoDragLeave'
                      @drop.prevent='onLogoDrop'
                    )
                      input.logo-file-input(
                        ref='logoFileInput'
                        type='file'
                        accept='image/png,image/jpeg,image/webp'
                        :disabled='logoUploading || logoRetrying'
                        @change='onLogoFileChange'
                        @click.stop
                      )
                      v-icon.logo-drop-icon(size='34') mdi-image-plus-outline
                      .logo-drop-copy
                        .text-body-large.font-weight-medium {{ $t('admin:general.logoPickerTitle') }}
                        .text-body-small.text-medium-emphasis {{ $t('admin:general.logoPickerHint') }}
                    .logo-message.logo-message--error(
                      v-if='logoErrorKey'
                      role='alert'
                    ) {{ $t(logoErrorKey) }}
                    p.logo-disclosure.text-body-small.text-medium-emphasis
                      v-icon.mr-2(size='18') mdi-earth
                      | {{ $t('admin:general.logoPublicUsage') }}
                  .text-label-small.text-grey.pa-4 {{$t('admin:general.footerCopyright')}}
                  .px-3.pb-3
                    v-text-field(
                      variant="outlined"
                      :label='$t(`admin:general.companyName`)'
                      v-model='config.company'
                      :counter='255'
                      prepend-icon='mdi-domain'
                      persistent-hint
                      :hint='$t(`admin:general.companyNameHint`)'
                      )
                    v-select.mt-3(
                      variant="outlined"
                      :label='$t(`admin:general.contentLicense`)'
                      :items='contentLicenses'
                      v-model='config.contentLicense'
                      prepend-icon='mdi-creative-commons'
                      :return-object='false'
                      :hint='$t(`admin:general.contentLicenseHint`)'
                      persistent-hint
                    )
                    v-text-field.mt-3(
                      variant="outlined"
                      :label='$t(`admin:general.footerOverride`)'
                      v-model='config.footerOverride'
                      prepend-icon='mdi-page-layout-footer'
                      append-icon='mdi-language-markdown'
                      persistent-hint
                      :hint='$t(`admin:general.footerOverrideHint`)'
                      )
                  v-divider
                  .text-label-small.text-grey.pa-4 SEO
                  .px-3.pb-3
                    v-text-field(
                      variant="outlined"
                      :label='$t(`admin:general.siteDescription`)'
                      :counter='255'
                      v-model='config.description'
                      prepend-icon='mdi-compass'
                      :hint='$t(`admin:general.siteDescriptionHint`)'
                      persistent-hint
                      )
                    v-select.mt-3(
                      variant="outlined"
                      :label='$t(`admin:general.metaRobots`)'
                      multiple
                      :items='metaRobots'
                      v-model='config.robots'
                      prepend-icon='mdi-compass'
                      :return-object='false'
                      :hint='$t(`admin:general.metaRobotsHint`)'
                      persistent-hint
                      )

                v-card.mt-5.animated.fadeInUp.wait-p4s
                  v-toolbar(color='warning', density='compact', flat)
                    v-toolbar-title.text-body-large {{ $t('admin:general.siteBanner') }}
                  v-card-text
                    v-switch.mt-0(
                      inset
                      color='warning'
                      v-model='config.banner.isEnabled'
                      :label='$t(`admin:general.siteBannerEnabled`)'
                      :hint='$t(`admin:general.siteBannerEnabledHint`)'
                      persistent-hint
                    )
                    v-text-field.mt-3(
                      variant='outlined'
                      v-model='config.banner.title'
                      :label='$t(`admin:general.siteBannerTitle`)'
                      :hint='$t(`admin:general.siteBannerTitleHint`)'
                      :counter='160'
                      prepend-icon='mdi-format-title'
                      persistent-hint
                    )
                    v-textarea.mt-3(
                      variant='outlined'
                      v-model='config.banner.content'
                      :label='$t(`admin:general.siteBannerContent`)'
                      :hint='$t(`admin:general.siteBannerContentHint`)'
                      :counter='8000'
                      prepend-icon='mdi-language-markdown'
                      auto-grow
                      rows='4'
                      persistent-hint
                    )
                    template(v-if='config.banner.isEnabled && (config.banner.title || config.banner.content)')
                      .text-label-small.text-grey.mb-2 {{ $t('admin:general.siteBannerPreview') }}
                      site-banner(:banner='config.banner')

            v-col(lg='6' cols='12')
              v-card.animated.fadeInUp.wait-p4s
                v-toolbar(color='indigo', density="compact", flat)
                  v-toolbar-title.text-body-large Features
                v-card-text
                  //- v-switch(
                  //-   inset
                  //-   label='Asset Image Optimization'
                  //-   color='indigo'
                  //-   v-model='config.featureTinyPNG'
                  //-   persistent-hint
                  //-   hint='Image optimization tool to reduce filesize and bandwidth costs.'
                  //-   disabled
                  //-   )
                  //- v-text-field.mt-3(
                  //-   variant='outlined'
                  //-   label='TinyPNG API Key'
                  //-   :counter='255'
                  //-   v-model='config.description'
                  //-   prepend-icon='mdi-subdirectory-arrow-right'
                  //-   hint='Get your API key at https://tinypng.com/developers'
                  //-   persistent-hint
                  //-   disabled
                  //-   )

                  //- v-divider.mt-3
                  //- v-switch(
                  //-   inset
                  //-   label='Page Ratings'
                  //-   color='indigo'
                  //-   v-model='config.featurePageRatings'
                  //-   persistent-hint
                  //-   hint='Allow users to rate pages.'
                  //-   disabled
                  //-   )

                  //- v-divider.mt-3
                  v-switch.mt-0(
                    inset
                    label='Comments'
                    color='indigo'
                    v-model='config.featurePageComments'
                    persistent-hint
                    hint='Allow users to leave comments on pages.'
                    )

                  //- v-divider.mt-3
                  //- v-switch(
                  //-   inset
                  //-   label='Personal Wikis'
                  //-   color='indigo'
                  //-   v-model='config.featurePersonalWikis'
                  //-   persistent-hint
                  //-   hint='Allow users to have their own personal wiki.'
                  //-   disabled
                  //-   )

              v-card.mt-5.animated.fadeInUp.wait-p6s
                v-toolbar(color='primary', density="compact", flat)
                  v-toolbar-title.text-body-large URL Handling
                v-card-text
                  v-text-field(
                    variant="outlined"
                    :label='$t(`admin:general.pageExtensions`)'
                    v-model='config.pageExtensions'
                    prepend-icon='mdi-format-text-wrapping-overflow'
                    :hint='$t(`admin:general.pageExtensionsHint`)'
                    persistent-hint
                    )

              v-card.mt-5.animated.fadeInUp.wait-p7s
                v-toolbar(color='primary', density="compact", flat)
                  v-toolbar-title.text-body-large {{$t('admin:general.editShortcuts')}}
                v-card-text
                  v-switch.mt-0(
                    inset
                    :label='$t(`admin:general.editFab`)'
                    color='primary'
                    v-model='config.editFab'
                    persistent-hint
                    :hint='$t(`admin:general.editFabHint`)'
                    )
                v-divider
                .text-label-small.text-grey.pa-4 {{$t('admin:general.editMenuBar')}}
                .px-3.pb-3
                  v-switch.mt-0.ml-1(
                    inset
                    :label='$t(`admin:general.displayEditMenuBar`)'
                    color='primary'
                    v-model='config.editMenuBar'
                    persistent-hint
                    :hint='$t(`admin:general.displayEditMenuBarHint`)'
                    )
                  v-switch.mt-4.ml-1(
                    v-if='config.editMenuBar'
                    inset
                    :label='$t(`admin:general.displayEditMenuBtn`)'
                    color='primary'
                    v-model='config.editMenuBtn'
                    persistent-hint
                    :hint='$t(`admin:general.displayEditMenuBtnHint`)'
                    )
                  v-switch.mt-4.ml-1(
                    v-if='config.editMenuBar'
                    inset
                    :label='$t(`admin:general.displayEditMenuExternalBtn`)'
                    color='primary'
                    v-model='config.editMenuExternalBtn'
                    persistent-hint
                    :hint='$t(`admin:general.displayEditMenuExternalBtnHint`)'
                    )
                template(v-if='config.editMenuBar && config.editMenuExternalBtn')
                  v-divider
                  .text-label-small.text-grey.pa-4 External Edit Button
                  .px-3.pb-3
                    v-text-field(
                      variant="outlined"
                      :label='$t(`admin:general.editMenuExternalName`)'
                      v-model='config.editMenuExternalName'
                      prepend-icon='mdi-format-title'
                      :hint='$t(`admin:general.editMenuExternalNameHint`)'
                      persistent-hint
                      )
                    v-text-field.mt-3(
                      variant="outlined"
                      :label='$t(`admin:general.editMenuExternalIcon`)'
                      v-model='config.editMenuExternalIcon'
                      prepend-icon='mdi-dice-5'
                      :hint='$t(`admin:general.editMenuExternalIconHint`)'
                      persistent-hint
                      )
                    v-text-field.mt-3(
                      variant="outlined"
                      :label='$t(`admin:general.editMenuExternalUrl`)'
                      v-model='config.editMenuExternalUrl'
                      prepend-icon='mdi-near-me'
                      :hint='$t(`admin:general.editMenuExternalUrlHint`)'
                      persistent-hint
                      )

        .d-flex.flex-wrap.justify-end.ga-2.mt-5.sticky-action-row
          v-btn(
            type='submit'
            form='general-form'
            color='success'
            variant='flat'
            size='large'
            :loading='saving'
            :disabled='!loaded || initialLoading || saving || !dirty || !formValid'
          )
            v-icon(start) mdi-check
            span {{$t('common:actions.apply')}}
</template>

<script lang='ts'>
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'
import { fetchSiteConfig, saveSiteConfig, type SiteConfig } from '../../helpers/site-api'
import {
  fetchSiteLogoStatus,
  retrySiteLogo,
  SiteLogoApiError,
  SITE_LOGO_MAX_BYTES,
  uploadSiteLogo,
  type SiteLogoErrorCode,
  type SiteLogoStatus
} from '../../helpers/site-logo-api'
import { loadingStart, loadingStop, pushGraphError, setLoading, showNotification } from '../../helpers/root-ui-store'
import SiteBanner from '../common/site-banner.vue'

const titleRegex = /[<>"]/i
const logoErrorMessageKeys: Record<SiteLogoErrorCode, string> = {
  UNSUPPORTED_IMAGE: 'admin:general.logoErrorUnsupported',
  IMAGE_TOO_LARGE: 'admin:general.logoErrorTooLarge',
  INVALID_IMAGE: 'admin:general.logoErrorInvalid',
  NO_VISIBLE_PIXELS: 'admin:general.logoErrorNoVisiblePixels',
  UNSUITABLE_LOGO: 'admin:general.logoErrorUnsuitable',
  PROCESSING_FAILED: 'admin:general.logoErrorProcessing',
  ARTIFACT_TOO_LARGE: 'admin:general.logoErrorArtifactTooLarge',
  MANAGED_LOGO_CONFLICT: 'admin:general.logoErrorConflict'
}


export default {
  i18nOptions: { namespaces: 'editor' },
  components: {
    SiteBanner
  },
  data(): {
    config: SiteConfig,
    persistedConfig: SiteConfig | null,
    metaRobots: Array<{ title: string, value: string }>,
    initialLoading: boolean,
    loaded: boolean,
    saving: boolean,
    formValid: boolean | null,
    loadRequestId: number,
    saveRequestId: number,
    logoStatus: SiteLogoStatus | null,
    logoUploading: boolean,
    logoRetrying: boolean,
    logoDragActive: boolean,
    logoDragDepth: number,
    logoErrorKey: string | null,
    candidatePreviewUrl: string,
    logoPollTimer: number | null,
    logoRequestId: number,
    logoRequestController: AbortController | null,
    logoDisposed: boolean
  } {
    return {
      config: {
        host: '',
        title: '',
        description: '',
        robots: [],
        analyticsService: '',
        analyticsId: '',
        company: '',
        contentLicense: '',
        footerOverride: '',
        banner: {
          isEnabled: false,
          title: '',
          content: ''
        },
        logoUrl: '',
        featureAnalytics: false,
        featurePageRatings: false,
        featurePageComments: false,
        featurePersonalWikis: false,
        featureTinyPNG: false,
        pageExtensions: '',
        editFab: false,
        editMenuBar: false,
        editMenuBtn: false,
        editMenuExternalBtn: false,
        editMenuExternalName: '',
        editMenuExternalIcon: '',
        editMenuExternalUrl: ''
      },
      persistedConfig: null,
      initialLoading: true,
      loaded: false,
      saving: false,
      formValid: null,
      loadRequestId: 0,
      saveRequestId: 0,
      logoStatus: null,
      logoUploading: false,
      logoRetrying: false,
      logoDragActive: false,
      logoDragDepth: 0,
      logoErrorKey: null,
      candidatePreviewUrl: '',
      logoPollTimer: null,
      logoRequestId: 0,
      logoRequestController: null,
      logoDisposed: false,
      metaRobots: [
        { title: 'Index', value: 'index' },
        { title: 'Follow', value: 'follow' },
        { title: 'No Index', value: 'noindex' },
        { title: 'No Follow', value: 'nofollow' }
      ]
    }
  },
  computed: {
    siteTitle: {
      get() { return wikiStore.site.title },
      set(value: string) { wikiStore.site.title = value }
    },
    activeLogoUrl () {
      return this.logoStatus?.active?.logoUrl || this.config.logoUrl || ''
    },
    candidateVisible () {
      return Boolean(
        this.logoUploading ||
        this.candidatePreviewUrl ||
        (this.logoStatus?.candidate && this.logoStatus.candidate.status !== 'ready')
      )
    },
    candidateIsProcessing () {
      const status = this.logoStatus?.candidate?.status
      return status === 'pending' || status === 'running'
    },
    candidateHasFailed () {
      return this.logoStatus?.candidate?.status === 'failed'
    },
    candidateStatusKey () {
      if (this.logoUploading) return 'admin:general.logoStatusUploading'
      if (this.logoErrorKey || this.logoStatus?.candidate?.status === 'failed') return 'admin:general.logoStatusFailed'
      return 'admin:general.logoStatusProcessing'
    },
    candidateStatusColor () {
      return this.logoErrorKey || this.logoStatus?.candidate?.status === 'failed' ? 'error' : 'info'
    },
    company: {
      get() { return wikiStore.site.company },
      set(value: string) { wikiStore.site.company = value }
    },
    contentLicense: {
      get() { return wikiStore.site.contentLicense },
      set(value: string) { wikiStore.site.contentLicense = value }
    },
    footerOverride: {
      get() { return wikiStore.site.footerOverride },
      set(value: string) { wikiStore.site.footerOverride = value }
    },
    dirty () {
      return this.persistedConfig !== null && !_.isEqual(this.siteConfigPayload(), this.persistedConfig)
    },
    hostRules () {
      return [
        (value: string) => Boolean(value?.trim()) || 'Required',
        (value: string) => /^https?:\/\/.+/i.test(value) || 'Enter a valid URL (https://...)'
      ]
    },
    titleRules () {
      return [
        (value: string) => Boolean(value?.trim()) || 'Required',
        (value: string) => !titleRegex.test(value) || this.$t('admin:general.siteTitleInvalidChars')
      ]
    },
    contentLicenses () {
      return [
        { value: '', title: this.$t('common:license.none') },
        { value: 'alr', title: this.$t('common:license.alr') },
        { value: 'cc0', title: this.$t('common:license.cc0') },
        { value: 'ccby', title: this.$t('common:license.ccby') },
        { value: 'ccbysa', title: this.$t('common:license.ccbysa') },
        { value: 'ccbynd', title: this.$t('common:license.ccbynd') },
        { value: 'ccbync', title: this.$t('common:license.ccbync') },
        { value: 'ccbyncsa', title: this.$t('common:license.ccbyncsa') },
        { value: 'ccbyncnd', title: this.$t('common:license.ccbyncnd') }
      ]
    }
  },
  methods: {
    siteConfigPayload () {
      return {
        host: _.get(this.config, 'host', ''),
        title: _.get(this.config, 'title', ''),
        description: _.get(this.config, 'description', ''),
        robots: _.get(this.config, 'robots', []),
        analyticsService: _.get(this.config, 'analyticsService', ''),
        analyticsId: _.get(this.config, 'analyticsId', ''),
        company: _.get(this.config, 'company', ''),
        contentLicense: _.get(this.config, 'contentLicense', ''),
        footerOverride: _.get(this.config, 'footerOverride', ''),
        banner: _.get(this.config, 'banner', { isEnabled: false, title: '', content: '' }),
        pageExtensions: _.get(this.config, 'pageExtensions', ''),
        featurePageRatings: _.get(this.config, 'featurePageRatings', false),
        featurePageComments: _.get(this.config, 'featurePageComments', false),
        featurePersonalWikis: _.get(this.config, 'featurePersonalWikis', false),
        editFab: _.get(this.config, 'editFab', false),
        editMenuBar: _.get(this.config, 'editMenuBar', false),
        editMenuBtn: _.get(this.config, 'editMenuBtn', false),
        editMenuExternalBtn: _.get(this.config, 'editMenuExternalBtn', false),
        editMenuExternalName: _.get(this.config, 'editMenuExternalName', ''),
        editMenuExternalIcon: _.get(this.config, 'editMenuExternalIcon', ''),
        editMenuExternalUrl: _.get(this.config, 'editMenuExternalUrl', '')
      }
    },
    async loadConfig () {
      const requestId = ++this.loadRequestId
      this.initialLoading = true
      this.loaded = false
      setLoading(wikiStore, 'admin-site-refresh', true)
      try {
        const loaded = _.cloneDeep(await fetchSiteConfig(window.fetch.bind(window)))
        if (requestId !== this.loadRequestId) return
        this.config = loaded
        this.persistedConfig = _.cloneDeep(this.siteConfigPayload())
        this.loaded = true
      } catch (err) {
        if (requestId === this.loadRequestId) pushGraphError(wikiStore, err)
      } finally {
        if (requestId === this.loadRequestId) this.initialLoading = false
        setLoading(wikiStore, 'admin-site-refresh', false)
      }
    },
    async save () {
      if (!this.loaded || this.initialLoading || this.saving || !this.dirty || !this.formValid) return
      const title = _.get(this.config, 'title', '')
      if (titleRegex.test(title)) {
        showNotification(wikiStore, {
          style: 'error',
          message: this.$t('admin:general.siteTitleInvalidChars'),
          icon: 'alert'
        })
        return
      }
      const requestId = ++this.saveRequestId
      this.saving = true
      loadingStart(wikiStore, 'admin-site-update')
      try {
        const payload = this.siteConfigPayload()
        await saveSiteConfig(window.fetch.bind(window), payload)
        if (requestId !== this.saveRequestId) return
        this.persistedConfig = _.cloneDeep(payload)
        showNotification(wikiStore, {
          style: 'success',
          message: this.$t('admin:general.saveSuccess'),
          icon: 'check'
        })
        this.siteTitle = this.config.title ?? ''
        this.company = this.config.company ?? ''
        this.contentLicense = this.config.contentLicense ?? ''
        this.footerOverride = this.config.footerOverride ?? ''
        wikiStore.site.banner = _.cloneDeep(this.config.banner)
      } catch (err) {
        if (requestId === this.saveRequestId) pushGraphError(wikiStore, err)
      } finally {
        if (requestId === this.saveRequestId) this.saving = false
        loadingStop(wikiStore, 'admin-site-update')
      }
    },
    clearLogoPoll () {
      if (this.logoPollTimer !== null) {
        window.clearTimeout(this.logoPollTimer)
        this.logoPollTimer = null
      }
    },
    scheduleLogoPoll () {
      this.clearLogoPoll()
      if (this.logoDisposed || !this.candidateIsProcessing) return
      this.logoPollTimer = window.setTimeout(() => {
        this.logoPollTimer = null
        this.refreshLogoStatus()
      }, 1500)
    },
    applyLogoStatus (status: SiteLogoStatus) {
      this.logoStatus = status
      this.logoErrorKey = status.candidate?.status === 'failed'
        ? this.logoErrorMessageKey(status.candidate.errorCode)
        : null
      if (!status.candidate || status.candidate.status === 'ready') this.clearCandidatePreview()
      if (status.candidate?.status === 'pending' || status.candidate?.status === 'running') {
        this.scheduleLogoPoll()
      } else {
        this.clearLogoPoll()
      }
    },
    logoErrorMessageKey (code: SiteLogoErrorCode | null) {
      return code ? logoErrorMessageKeys[code] : 'admin:general.logoErrorGeneric'
    },
    logoRequestErrorKey (error: unknown) {
      return error instanceof SiteLogoApiError
        ? this.logoErrorMessageKey(error.code)
        : 'admin:general.logoErrorGeneric'
    },
    async refreshLogoStatus () {
      const requestId = ++this.logoRequestId
      this.logoRequestController?.abort()
      const controller = new AbortController()
      this.logoRequestController = controller
      try {
        const status = await fetchSiteLogoStatus(window.fetch.bind(window), controller.signal)
        if (requestId !== this.logoRequestId || this.logoDisposed) return
        this.applyLogoStatus(status)
      } catch (error) {
        if (requestId === this.logoRequestId && !this.logoDisposed && !controller.signal.aborted) {
          this.clearLogoPoll()
          this.logoErrorKey = this.logoRequestErrorKey(error)
        }
      }
    },
    openLogoPicker () {
      if (this.logoUploading || this.logoRetrying) return
      ;(this.$refs.logoFileInput as HTMLInputElement | undefined)?.click()
    },
    onLogoDragEnter () {
      if (this.logoUploading || this.logoRetrying) return
      this.logoDragDepth++
      this.logoDragActive = true
    },
    onLogoDragLeave () {
      this.logoDragDepth = Math.max(0, this.logoDragDepth - 1)
      this.logoDragActive = this.logoDragDepth > 0
    },
    onLogoDrop (event: DragEvent) {
      this.logoDragDepth = 0
      this.logoDragActive = false
      if (this.logoUploading || this.logoRetrying) return
      this.acceptLogoFiles(event.dataTransfer?.files)
    },
    onLogoFileChange (event: Event) {
      const input = event.target as HTMLInputElement
      this.acceptLogoFiles(input.files)
      input.value = ''
    },
    acceptLogoFiles (files: FileList | null | undefined) {
      if (!files || files.length !== 1) {
        this.logoErrorKey = 'admin:general.logoErrorOneFile'
        return
      }
      const file = files.item(0)
      if (!file) {
        this.logoErrorKey = 'admin:general.logoErrorOneFile'
      } else if (file.size > SITE_LOGO_MAX_BYTES) {
        this.logoErrorKey = 'admin:general.logoErrorTooLarge'
      } else {
        this.uploadSelectedLogo(file)
      }
    },
    replaceCandidatePreview (file: File) {
      this.clearCandidatePreview()
      this.candidatePreviewUrl = URL.createObjectURL(file)
    },
    clearCandidatePreview () {
      if (!this.candidatePreviewUrl) return
      URL.revokeObjectURL(this.candidatePreviewUrl)
      this.candidatePreviewUrl = ''
    },
    async uploadSelectedLogo (file: File) {
      this.clearLogoPoll()
      const requestId = ++this.logoRequestId
      this.logoRequestController?.abort()
      const controller = new AbortController()
      this.logoRequestController = controller
      this.logoErrorKey = null
      this.logoUploading = true
      this.replaceCandidatePreview(file)
      try {
        const status = await uploadSiteLogo(window.fetch.bind(window), file, controller.signal)
        if (requestId !== this.logoRequestId || this.logoDisposed) return
        this.applyLogoStatus(status)
      } catch (error) {
        if (requestId === this.logoRequestId && !this.logoDisposed && !controller.signal.aborted) {
          this.logoErrorKey = this.logoRequestErrorKey(error)
        }
      } finally {
        if (requestId === this.logoRequestId && !this.logoDisposed) this.logoUploading = false
      }
    },
    async retryLogo () {
      if (this.logoUploading || this.logoRetrying) return
      this.clearLogoPoll()
      const requestId = ++this.logoRequestId
      this.logoRequestController?.abort()
      const controller = new AbortController()
      this.logoRequestController = controller
      this.logoErrorKey = null
      this.logoRetrying = true
      try {
        const status = await retrySiteLogo(window.fetch.bind(window), controller.signal)
        if (requestId !== this.logoRequestId || this.logoDisposed) return
        this.applyLogoStatus(status)
      } catch (error) {
        if (requestId === this.logoRequestId && !this.logoDisposed && !controller.signal.aborted) {
          this.logoErrorKey = this.logoRequestErrorKey(error)
        }
      } finally {
        if (requestId === this.logoRequestId && !this.logoDisposed) this.logoRetrying = false
      }
    }
  },
  mounted () {
    this.loadConfig()
    this.refreshLogoStatus()
  },
  beforeUnmount() {
    this.logoDisposed = true
    this.loadRequestId++
    this.saveRequestId++
    this.logoRequestId++
    this.logoRequestController?.abort()
    this.logoRequestController = null
    this.clearLogoPoll()
    this.clearCandidatePreview()
  }
}
</script>

<style lang='scss'>

  .logo-manager {
    --logo-manager-border: rgba(var(--v-border-color), var(--v-border-opacity));
  }
  .logo-preview-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
    margin-bottom: 1rem;
  }
  .logo-preview-card {
    min-width: 0;
    padding: 1rem;
    border: 1px solid var(--logo-manager-border);
    border-radius: 12px;
    background: rgba(var(--v-theme-surface-variant), .24);
  }
  .logo-preview-heading {
    margin-bottom: .75rem;
    color: rgba(var(--v-theme-on-surface), .72);
    font-size: .75rem;
    font-weight: 700;
    letter-spacing: .08em;
    text-transform: uppercase;
  }
  .logo-preview-frame {
    display: grid;
    width: 100%;
    height: 112px;
    place-items: center;
    overflow: hidden;
    border-radius: 8px;
    background:
      linear-gradient(45deg, rgba(var(--v-theme-on-surface), .05) 25%, transparent 25%) 0 0 / 16px 16px,
      linear-gradient(-45deg, rgba(var(--v-theme-on-surface), .05) 25%, transparent 25%) 0 8px / 16px 16px,
      linear-gradient(45deg, transparent 75%, rgba(var(--v-theme-on-surface), .05) 75%) 8px -8px / 16px 16px,
      linear-gradient(-45deg, transparent 75%, rgba(var(--v-theme-on-surface), .05) 75%) -8px 0 / 16px 16px;
  }
  .logo-preview-frame > .v-img {
    width: 100%;
    height: 100%;
  }
  .logo-drop-target {
    position: relative;
    display: flex;
    align-items: center;
    gap: 1rem;
    min-height: 96px;
    padding: 1rem 1.25rem;
    border: 1.5px dashed rgba(var(--v-theme-primary), .5);
    border-radius: 12px;
    background: rgba(var(--v-theme-primary), .045);
    cursor: pointer;
    transition: border-color .16s ease, background-color .16s ease, transform .16s ease;
  }
  .logo-drop-target:hover,
  .logo-drop-target:focus-visible,
  .logo-drop-target--active {
    border-color: rgb(var(--v-theme-primary));
    background: rgba(var(--v-theme-primary), .1);
    outline: none;
    transform: translateY(-1px);
  }
  .logo-drop-target:focus-visible {
    box-shadow: 0 0 0 3px rgba(var(--v-theme-primary), .22);
  }
  .logo-drop-target--disabled {
    cursor: wait;
    opacity: .58;
    transform: none;
  }
  .logo-file-input {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .logo-drop-icon {
    flex: 0 0 auto;
    color: rgb(var(--v-theme-primary));
  }
  .logo-drop-copy {
    min-width: 0;
  }
  .logo-message {
    margin-top: .75rem;
    font-size: .875rem;
  }
  .logo-message--error {
    color: rgb(var(--v-theme-error));
  }
  .logo-disclosure {
    display: flex;
    align-items: flex-start;
    margin: 1rem 0 0;
    line-height: 1.5;
  }
  @media (max-width: 600px) {
    .logo-preview-grid {
      grid-template-columns: 1fr;
    }
    .logo-drop-target {
      align-items: flex-start;
    }
  }
</style>
