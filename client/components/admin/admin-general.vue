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
                  .logo-preview
                    .text-label-large.mb-2 {{ $t('admin:general.logo') }}
                    v-avatar(size='100', rounded='0')
                      v-img(
                        :key='logoRefreshKey'
                        :src='config.logoUrl'
                        alt='Current site logo preview'
                        lazy-src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNcWQ8AAdcBKrJda2oAAAAASUVORK5CYII='
                        aspect-ratio='1'
                      )
                  .logo-field
                    v-text-field(
                      variant="outlined"
                      :label='$t(`admin:general.logoUrl`)'
                      v-model='config.logoUrl'
                      :hint='$t(`admin:general.logoUrlHint`)'
                      persistent-hint
                      append-icon='mdi-folder-image'
                      @click:append='browseLogo'
                      @keyup.enter='refreshLogo'
                    )
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
                      item-title='text'
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
                      item-title='text'
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
    component(:is='activeModal')
</template>

<script lang='ts'>
import { defineAsyncComponent } from 'vue'
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'
import { onEditorInsert, offEditorInsert, type EditorInsertPayload } from '../../helpers/editor-insert-events'
import { fetchSiteConfig, saveSiteConfig, type SiteConfig } from '../../helpers/site-api'
import { loadingStart, loadingStop, pushGraphError, setLoading, showNotification } from '../../helpers/root-ui-store'
import SiteBanner from '../common/site-banner.vue'

const titleRegex = /[<>"]/i

export default {
  i18nOptions: { namespaces: 'editor' },
  components: {
    SiteBanner,
    editorModalMedia: defineAsyncComponent(() => import('../editor/editor-modal-media.vue'))
  },
  data(): {
    config: SiteConfig,
    persistedConfig: SiteConfig | null,
    metaRobots: Array<{ text: string, value: string }>,
    logoRefreshKey: number,
    initialLoading: boolean,
    loaded: boolean,
    saving: boolean,
    formValid: boolean | null,
    loadRequestId: number,
    saveRequestId: number
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
      logoRefreshKey: 0,
      initialLoading: true,
      loaded: false,
      saving: false,
      formValid: null,
      loadRequestId: 0,
      saveRequestId: 0,
      metaRobots: [
        { text: 'Index', value: 'index' },
        { text: 'Follow', value: 'follow' },
        { text: 'No Index', value: 'noindex' },
        { text: 'No Follow', value: 'nofollow' }
      ]
    }
  },
  computed: {
    siteTitle: {
      get() { return wikiStore.site.title },
      set(value: string) { wikiStore.site.title = value }
    },
    logoUrl: {
      get() { return wikiStore.site.logoUrl },
      set(value: string) { wikiStore.site.logoUrl = value }
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
    activeModal: {
      get() { return wikiStore.editor.activeModal },
      set(value: string) { wikiStore.editor.activeModal = value }
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
        { value: '', text: this.$t('common:license.none') },
        { value: 'alr', text: this.$t('common:license.alr') },
        { value: 'cc0', text: this.$t('common:license.cc0') },
        { value: 'ccby', text: this.$t('common:license.ccby') },
        { value: 'ccbysa', text: this.$t('common:license.ccbysa') },
        { value: 'ccbynd', text: this.$t('common:license.ccbynd') },
        { value: 'ccbync', text: this.$t('common:license.ccbync') },
        { value: 'ccbyncsa', text: this.$t('common:license.ccbyncsa') },
        { value: 'ccbyncnd', text: this.$t('common:license.ccbyncnd') }
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
        logoUrl: _.get(this.config, 'logoUrl', ''),
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
        this.logoUrl = this.config.logoUrl ?? ''
      } catch (err) {
        if (requestId === this.saveRequestId) pushGraphError(wikiStore, err)
      } finally {
        if (requestId === this.saveRequestId) this.saving = false
        loadingStop(wikiStore, 'admin-site-update')
      }
    },
    browseLogo () {
      wikiStore.editor.editorKey = 'common'
      this.activeModal = 'editorModalMedia'
    },
    refreshLogo () {
      this.logoRefreshKey++
    },
    handleEditorInsert (opts: EditorInsertPayload) {
      if (typeof opts.path === 'string') {
        this.config.logoUrl = opts.path
      }
    }
  },
  mounted () {
    this.loadConfig()
    onEditorInsert(this.handleEditorInsert)
  },
  beforeUnmount() {
    this.loadRequestId++
    this.saveRequestId++
    offEditorInsert(this.handleEditorInsert)
  }
}
</script>

<style lang='scss'>

  .logo-preview {
    display: inline-flex;
    flex-direction: column;
    gap: .5rem;
    margin: .5rem 1rem 1.5rem;
    vertical-align: top;
  }

  .logo-field {
    display: inline-block;
    width: calc(100% - 150px);
    margin: .5rem 1rem 1.5rem 0;
    vertical-align: top;
  }

  @media (max-width: 600px) {
    .logo-preview,
    .logo-field {
      display: block;
      width: auto;
      margin: .5rem 1rem 1rem;
    }
  }
</style>
