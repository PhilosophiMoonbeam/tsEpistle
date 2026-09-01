<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        AdminHero(
          :title='$t(`admin:security.title`)'
          :description='$t(`admin:security.subtitle`)'
          icon='/_assets/svg/icon-private.svg'
          heading-id='admin-security-heading'
        )
          template(v-slot:actions)
            v-btn(color='success', variant='flat', @click='save', size='large', :disabled='!configLoaded')
              v-icon(start) mdi-check
              span {{$t('common:actions.apply')}}
        v-alert.mt-3(v-if='configLoading', variant='outlined', color='info', role='status')
          v-progress-circular(indeterminate, size='20', width='2', color='primary', aria-label='Loading security configuration')
          span.ml-3 Loading security configuration
        v-alert.mt-3(v-else-if='configLoadError', variant='outlined', color='error', role='alert')
          span Security configuration could not be loaded.
          v-btn.ml-3(variant='outlined', color='primary', size='small', @click='loadConfig') Retry
        v-form.pt-3(v-else-if='configLoaded')
          v-row
            v-col(lg='6' cols='12')
              v-card.animated.fadeInUp
                v-toolbar(color='error', density="compact", flat)
                  v-toolbar-title.text-body-large Security
                v-card-info(color='error')
                  span Make sure to understand the implications before turning on / off a security feature.
                v-card-text
                  .text-label-small.text-medium-emphasis.mb-3 Protection settings
                  v-switch(
                    inset
                    label='Block Open Redirect'
                    color='primary'
                    v-model='config.securityOpenRedirect'
                    persistent-hint
                    hint='Prevents user controlled URLs from directing to websites outside of your wiki. This provides Open Redirect protection.'
                    )

                  v-switch.mt-3(
                    inset
                    label='Block IFrame Embedding'
                    color='primary'
                    v-model='config.securityIframe'
                    persistent-hint
                    hint='Prevents other websites from embedding your wiki in an iframe. This provides clickjacking protection.'
                    )

                  v-switch(
                    inset
                    label='Same Origin Referrer Policy'
                    color='primary'
                    v-model='config.securityReferrerPolicy'
                    persistent-hint
                    hint='Limits the referrer header to same origin.'
                    )

                  v-switch(
                    inset
                    label='Trust X-Forwarded-* Proxy Headers'
                    color='warning'
                    v-model='config.securityTrustProxy'
                    persistent-hint
                    hint='Enable when a reverse proxy such as nginx, Apache, or Cloudflare sits in front of tsFranki. Turn off otherwise.'
                    )

                  //- v-divider.mt-3
                  //- v-switch(
                  //-   inset
                  //-   label='Subresource Integrity (SRI)'
                  //-   color='red-darken-2'
                  //-   v-model='config.securitySRI'
                  //-   persistent-hint
                  //-   hint='This ensure that resources such as CSS and JS files are not altered during delivery.'
                  //-   disabled
                  //-   )

                  v-divider.mt-3
                  v-switch(
                    inset
                    label='Enforce HSTS'
                    color='primary'
                    v-model='config.securityHSTS'
                    persistent-hint
                    :hint='`This ensures the connection cannot be established through an insecure HTTP connection.`'
                    )
                  v-select.mt-5(
                    variant="outlined"
                    label='HSTS Max Age'
                    :items='hstsDurations'
                    item-title='text'
                    v-model='config.securityHSTSDuration'
                    prepend-icon='mdi-subdirectory-arrow-right'
                    :disabled='!config.securityHSTS'
                    hint='Defines the duration for which the server should only deliver content through HTTPS.'
                    persistent-hint
                    aria-describedby='hsts-warning'
                    style='max-width: 450px;'
                  )
                  .pl-11.mt-3#hsts-warning
                    .text-body-small It's a good idea to start with small values and make sure that nothing breaks on your wiki before moving to longer values.

                  //- v-divider.mt-3
                  //- v-switch(
                  //-   inset
                  //-   label='Enforce CSP'
                  //-   color='red-darken-2'
                  //-   v-model='config.securityCSP'
                  //-   persistent-hint
                  //-   hint='Restricts scripts to pre-approved content sources.'
                  //-   disabled
                  //-   )
                  //- v-textarea.mt-5(
                  //-   label='CSP Directives'
                  //-   variant='outlined'
                  //-   v-model='config.securityCSPDirectives'
                  //-   prepend-icon='mdi-subdirectory-arrow-right'
                  //-   persistent-hint
                  //-   hint='One directive per line.'
                  //-   disabled
                  //- )

            v-col(lg='6' cols='12')
              v-card.animated.fadeInUp.wait-p2s
                v-toolbar(color='primary', density="compact", flat)
                  v-toolbar-title.text-body-large {{ $t('admin:security.uploads') }}
                div.v-card-info(color='info')
                  span {{$t('admin:security.uploadsInfo')}}
                v-card-text
                  v-text-field.mt-3(
                    variant="outlined"
                    :label='$t(`admin:security.maxUploadSize`)'
                    required
                    v-model='config.uploadMaxFileSize'
                    prepend-icon='mdi-progress-upload'
                    :hint='$t(`admin:security.maxUploadSizeHint`)'
                    persistent-hint
                    :suffix='$t(`admin:security.maxUploadSizeSuffix`)'
                    style='max-width: 450px;'
                    )
                  v-text-field.mt-3(
                    variant="outlined"
                    :label='$t(`admin:security.maxUploadBatch`)'
                    required
                    v-model='config.uploadMaxFiles'
                    prepend-icon='mdi-upload-lock'
                    :hint='$t(`admin:security.maxUploadBatchHint`)'
                    persistent-hint
                    :suffix='$t(`admin:security.maxUploadBatchSuffix`)'
                    style='max-width: 450px;'
                    )
                  v-divider.mt-3
                  v-switch(
                    inset
                    label='Scan and Sanitize SVG Uploads'
                    color='primary'
                    v-model='config.uploadScanSVG'
                    persistent-hint
                    hint='Should SVG uploads be scanned for vulnerabilities and stripped of any potentially unsafe content.'
                    )
                  v-divider.mt-3
                  v-switch(
                    inset
                    label='Force Download of Unsafe Extensions'
                    color='primary'
                    v-model='config.uploadForceDownload'
                    persistent-hint
                    hint='Should non-image files be forced as downloads when accessed directly. This prevents potential XSS attacks via unsafe file extensions uploads.'
                    )

              v-card.mt-3.animated.fadeInUp.wait-p2s
                v-toolbar(flat, color='primary', density="compact")
                  .text-body-large {{$t('admin:security.login')}}
                //- v-card-info(color='blue')
                //-   span {{$t('admin:security.loginInfo')}}
                .text-label-small.text-grey.pa-4 {{$t('admin:security.loginScreen')}}
                .px-4.pb-3
                  v-text-field(
                    variant="outlined"
                    :label='$t(`admin:security.loginBgUrl`)'
                    v-model='config.authLoginBgUrl'
                    :hint='$t(`admin:security.loginBgUrlHint`)'
                    persistent-hint
                    prepend-icon='mdi-image-area'
                  )
                    template(v-slot:append-inner)
                      v-tooltip(location='top')
                        template(v-slot:activator='{ props }')
                          v-btn(icon, size='small', v-bind='props', aria-label='Browse login background media', @click='browseLoginBg')
                            v-icon mdi-folder-image
                        span Browse login background media
                  v-switch(
                    inset
                    :label='$t(`admin:security.bypassLogin`)'
                    color='primary'
                    v-model='config.authAutoLogin'
                    prepend-icon='mdi-fast-forward'
                    persistent-hint
                    :hint='$t(`admin:security.bypassLoginHint`)'
                    )
                  v-switch(
                    inset
                    :label='$t(`admin:security.hideLocalLogin`)'
                    color='primary'
                    v-model='config.authHideLocal'
                    prepend-icon='mdi-eye-off-outline'
                    persistent-hint
                    :hint='$t(`admin:security.hideLocalLoginHint`)'
                    )
                v-divider.mt-3
                .text-label-small.text-grey.pa-4 {{$t('admin:security.loginSecurity')}}
                .px-4.pb-3
                  v-switch.mt-0(
                    inset
                    :label='$t(`admin:security.enforce2fa`)'
                    color='primary'
                    v-model='config.authEnforce2FA'
                    prepend-icon='mdi-two-factor-authentication'
                    :hint='$t(`admin:security.enforce2faHint`)'
                    persistent-hint
                  )
                v-divider.mt-3
                .text-label-small.text-grey.pa-4 {{$t('admin:security.jwt')}}
                .px-4.pb-3
                  v-text-field(
                    v-model='config.authJwtAudience'
                    variant="outlined"
                    prepend-icon='mdi-account-group-outline'
                    :label='$t(`admin:auth.jwtAudience`)'
                    :hint='$t(`admin:auth.jwtAudienceHint`)'
                    persistent-hint
                  )
                  v-text-field.mt-3(
                    v-model='config.authJwtExpiration'
                    variant="outlined"
                    prepend-icon='mdi-clock-outline'
                    :label='$t(`admin:auth.tokenExpiration`)'
                    :hint='$t(`admin:auth.tokenExpirationHint`)'
                    persistent-hint
                  )
                  v-text-field.mt-3(
                    v-model='config.authJwtRenewablePeriod'
                    variant="outlined"
                    prepend-icon='mdi-update'
                    :label='$t(`admin:auth.tokenRenewalPeriod`)'
                    :hint='$t(`admin:auth.tokenRenewalPeriodHint`)'
                    persistent-hint
                  )

    component(:is='activeModal')</template>

<script lang='ts'>
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'
import { onEditorInsert, offEditorInsert, type EditorInsertPayload } from '../../helpers/editor-insert-events'
import { fetchSiteConfig, saveSiteConfig, type SiteConfig } from '../../helpers/site-api'
import { loadingStart, loadingStop, pushGraphError, setLoading, showNotification } from '../../helpers/root-ui-store'

type SecurityConfig = Required<Pick<SiteConfig,
  | 'uploadMaxFileSize'
  | 'uploadMaxFiles'
  | 'uploadScanSVG'
  | 'uploadForceDownload'
  | 'securityOpenRedirect'
  | 'securityIframe'
  | 'securityReferrerPolicy'
  | 'securityTrustProxy'
  | 'securitySRI'
  | 'securityHSTS'
  | 'securityHSTSDuration'
  | 'securityCSP'
  | 'securityCSPDirectives'
  | 'authAutoLogin'
  | 'authEnforce2FA'
  | 'authHideLocal'
  | 'authLoginBgUrl'
  | 'authJwtAudience'
  | 'authJwtExpiration'
  | 'authJwtRenewablePeriod'
>>


export default {
  i18nOptions: { namespaces: 'editor' },
  components: {
    editorModalMedia: () => import('../editor/editor-modal-media.vue')
  },
  data() {
    return {
      config: {
        uploadMaxFileSize: 0,
        uploadMaxFiles: 0,
        uploadScanSVG: true,
        uploadForceDownload: true,
        securityOpenRedirect: true,
        securityIframe: true,
        securityReferrerPolicy: true,
        securityTrustProxy: false,
        securitySRI: true,
        securityHSTS: false,
        securityHSTSDuration: 0,
        securityCSP: false,
        securityCSPDirectives: '',
        authAutoLogin: false,
        authEnforce2FA: false,
        authHideLocal: false,
        authLoginBgUrl: '',
        authJwtAudience: 'urn:wiki.js',
        authJwtExpiration: '30m',
        authJwtRenewablePeriod: '14d'
      } as SecurityConfig,
      configLoading: false,
      configLoaded: false,
      configLoadError: false,
      hstsDurations: [
        { value: 300, text: '5 minutes' },
        { value: 86400, text: '1 day' },
        { value: 604800, text: '1 week' },
        { value: 2592000, text: '1 month' },
        { value: 31536000, text: '1 year' },
        { value: 63072000, text: '2 years' }
      ]
    }
  },
  computed: {
    activeModal: {
      get (): string {
        return wikiStore.editor.activeModal
      },
      set (value: string) {
        wikiStore.editor.activeModal = value
      }
    }
  },
  methods: {
    siteConfigPayload (): Record<string, unknown> {
      return {
        authAutoLogin: _.get(this.config, 'authAutoLogin', false),
        authEnforce2FA: _.get(this.config, 'authEnforce2FA', false),
        authHideLocal: _.get(this.config, 'authHideLocal', false),
        authLoginBgUrl: _.get(this.config, 'authLoginBgUrl', ''),
        authJwtAudience: _.get(this.config, 'authJwtAudience', ''),
        authJwtExpiration: _.get(this.config, 'authJwtExpiration', ''),
        authJwtRenewablePeriod: _.get(this.config, 'authJwtRenewablePeriod', ''),
        uploadMaxFileSize: _.toSafeInteger(_.get(this.config, 'uploadMaxFileSize', 0)),
        uploadMaxFiles: _.toSafeInteger(_.get(this.config, 'uploadMaxFiles', 0)),
        uploadScanSVG: _.get(this.config, 'uploadScanSVG', false),
        uploadForceDownload: _.get(this.config, 'uploadForceDownload', false),
        securityOpenRedirect: _.get(this.config, 'securityOpenRedirect', false),
        securityIframe: _.get(this.config, 'securityIframe', false),
        securityReferrerPolicy: _.get(this.config, 'securityReferrerPolicy', false),
        securityTrustProxy: _.get(this.config, 'securityTrustProxy', false),
        securitySRI: _.get(this.config, 'securitySRI', false),
        securityHSTS: _.get(this.config, 'securityHSTS', false),
        securityHSTSDuration: _.get(this.config, 'securityHSTSDuration', 0),
        securityCSP: _.get(this.config, 'securityCSP', false),
        securityCSPDirectives: _.get(this.config, 'securityCSPDirectives', '')
      }
    },
    async loadConfig () {
      this.configLoading = true
      this.configLoadError = false
      setLoading(wikiStore, 'admin-security-refresh', true)
      try {
        this.config = _.cloneDeep(await fetchSiteConfig(window.fetch.bind(window))) as SecurityConfig
        this.configLoaded = true
      } catch (err) {
        this.configLoaded = false
        this.configLoadError = true
        pushGraphError(wikiStore, err)
      } finally {
        this.configLoading = false
        setLoading(wikiStore, 'admin-security-refresh', false)
      }
    },
    async save () {
      if (!this.configLoaded) return
      loadingStart(wikiStore, 'admin-site-update')
      try {
        await saveSiteConfig(window.fetch.bind(window), this.siteConfigPayload())
        showNotification(wikiStore, {
          style: 'success',
          message: 'Configuration saved successfully.',
          icon: 'check'
        })
      } catch (err) {
        pushGraphError(wikiStore, err)
      } finally {
        loadingStop(wikiStore, 'admin-site-update')
      }
    },
    browseLoginBg () {
      wikiStore.editor.editorKey = 'common'
      this.activeModal = 'editorModalMedia'
    },
    handleEditorInsert (opts: EditorInsertPayload) {
      if (typeof opts.path === 'string') {
        this.config.authLoginBgUrl = opts.path
      }
    },
  },
  mounted () {
    this.loadConfig()
    onEditorInsert(this.handleEditorInsert)
  },
  beforeUnmount() {
    offEditorInsert(this.handleEditorInsert)
  }
}
</script>

<style lang='scss'>

</style>
