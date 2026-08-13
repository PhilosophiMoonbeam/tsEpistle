<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-row()
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-new-post.svg', alt='Mail', style='width: 80px;')
          .admin-header-title
            .headline.primary--text.animated.fadeInLeft {{ $t('admin:mail.title') }}
            .subtitle-1.grey--text.animated.fadeInLeft.wait-p4s {{ $t('admin:mail.subtitle') }}
          v-spacer
          v-btn.animated.fadeInDown(color='success', depressed, @click='save', large)
            v-icon(left) mdi-check
            span {{$t('common:actions.apply')}}
        v-form.pt-3
          v-row
            v-col(lg='6' cols='12')
              v-form
                v-card.animated.fadeInUp
                  v-toolbar(color='primary', dark, dense, flat)
                    v-toolbar-title.subtitle-1 {{ $t('admin:mail.configuration') }}
                  .overline.pa-4.grey--text {{ $t('admin:mail.sender') }}
                  .px-4
                    v-text-field(
                      outlined
                      v-model='config.senderName'
                      :label='$t(`admin:mail.senderName`)'
                      required
                      :counter='255'
                      prepend-icon='mdi-mailbox'
                      )
                    v-text-field(
                      outlined
                      v-model='config.senderEmail'
                      :label='$t(`admin:mail.senderEmail`)'
                      required
                      :counter='255'
                      prepend-icon='mdi-mailbox'
                      )
                  v-divider
                  .overline.pa-4.grey--text {{ $t('admin:mail.smtp') }}
                  .px-4
                    v-text-field(
                      outlined
                      v-model='config.host'
                      :label='$t(`admin:mail.smtpHost`)'
                      required
                      :counter='255'
                      prepend-icon='mdi-memory'
                      )
                    v-text-field(
                      outlined
                      v-model='config.port'
                      :label='$t(`admin:mail.smtpPort`)'
                      required
                      prepend-icon='mdi-serial-port'
                      persistent-hint
                      :hint='$t(`admin:mail.smtpPortHint`)'
                      style='max-width: 300px;'
                      )
                    v-text-field(
                      outlined
                      v-model='config.name'
                      :label='$t(`admin:mail.smtpName`)'
                      required
                      :counter='255'
                      prepend-icon='mdi-server'
                      persistent-hint
                      :hint='$t(`admin:mail.smtpNameHint`)'
                      )
                    v-switch(
                      v-model='config.secure'
                      :label='$t(`admin:mail.smtpTLS`)'
                      color='primary'
                      persistent-hint
                      :hint='$t(`admin:mail.smtpTLSHint`)'
                      prepend-icon='mdi-security-network'
                      inset
                      )
                    v-switch(
                      v-model='config.verifySSL'
                      :label='$t(`admin:mail.smtpVerifySSL`)'
                      color='primary'
                      persistent-hint
                      :hint='$t(`admin:mail.smtpVerifySSLHint`)'
                      prepend-icon='mdi-security-network'
                      inset
                      )
                    v-text-field.mt-8(
                      outlined
                      v-model='config.user'
                      :label='$t(`admin:mail.smtpUser`)'
                      required
                      :counter='255'
                      prepend-icon='mdi-shield-account-outline'
                      )
                    v-text-field(
                      outlined
                      v-model='config.pass'
                      :label='$t(`admin:mail.smtpPwd`)'
                      required
                      prepend-icon='mdi-form-textbox-password'
                      type='password'
                      )

            v-col(lg='6' cols='12')
              v-card.animated.fadeInUp.wait-p2s
                v-form
                  v-toolbar(color='primary', dark, dense, flat)
                    v-toolbar-title.subtitle-1 {{ $t('admin:mail.dkim') }}
                  div.v-card-info
                    span {{ $t('admin:mail.dkimHint') }}
                  .pa-4
                    v-switch(
                      v-model='config.useDKIM'
                      :label='$t(`admin:mail.dkimUse`)'
                      color='primary'
                      prepend-icon='mdi-key'
                      inset
                      )
                    v-text-field(
                      outlined
                      v-model='config.dkimDomainName'
                      :label='$t(`admin:mail.dkimDomainName`)'
                      :counter='255'
                      prepend-icon='mdi-key'
                      :disabled='!config.useDKIM'
                      )
                    v-text-field(
                      outlined
                      v-model='config.dkimKeySelector'
                      :label='$t(`admin:mail.dkimKeySelector`)'
                      :counter='255'
                      prepend-icon='mdi-key'
                      :disabled='!config.useDKIM'
                      )
                    v-textarea(
                      outlined
                      v-model='config.dkimPrivateKey'
                      :label='$t(`admin:mail.dkimPrivateKey`)'
                      prepend-icon='mdi-key'
                      persistent-hint
                      :hint='$t(`admin:mail.dkimPrivateKeyHint`)'
                      :disabled='!config.useDKIM'
                      )

              v-card.mt-3.animated.fadeInUp.wait-p3s
                v-form
                  v-toolbar(color='teal', dark, dense, flat)
                    v-toolbar-title.subtitle-1 {{ $t('admin:mail.test') }}
                  .pa-4
                    .body-2.grey--text.text--darken-2 {{ $t('admin:mail.testHint') }}
                    v-text-field.mt-3(
                      outlined
                      v-model='testEmail'
                      :label='$t(`admin:mail.testRecipient`)'
                      :counter='255'
                      prepend-icon='mdi-email-outline'
                      :disabled='testLoading'
                      )
                  div.v-card-chin
                    v-spacer
                    v-btn.px-4(color='teal', dark, @click='sendTest', :loading='testLoading')
                      v-icon(left) mdi-send
                      span {{ $t('admin:mail.testSend') }}

</template>

<script lang='ts'>
import _ from 'lodash'

import { fetchMailConfig, saveMailConfig, sendMailTest } from '../../helpers/mail-api'
import { wikiStore } from '@/store/index.ts'

export default {
  data() {
    return {
      config: {
        senderName: '',
        senderEmail: '',
        host: '',
        port: 0,
        name: '',
        secure: false,
        verifySSL: false,
        user: '',
        pass: '',
        useDKIM: false,
        dkimDomainName: '',
        dkimKeySelector: '',
        dkimPrivateKey: ''
      },
      testEmail: '',
      testLoading: false
    }
  },
  methods: {
    async save () {
      try {
        wikiStore.startLoading('admin-mail-update')
        await saveMailConfig(window.fetch.bind(window), {
          senderName: this.config.senderName || '',
          senderEmail: this.config.senderEmail || '',
          host: this.config.host || '',
          port: _.toSafeInteger(this.config.port) || 0,
          name: this.config.name || '',
          secure: this.config.secure || false,
          verifySSL: this.config.verifySSL || false,
          user: this.config.user || '',
          pass: this.config.pass || '',
          useDKIM: this.config.useDKIM || false,
          dkimDomainName: this.config.dkimDomainName || '',
          dkimKeySelector: this.config.dkimKeySelector || '',
          dkimPrivateKey: this.config.dkimPrivateKey || ''
        }, 'Mail configuration update failed')
        wikiStore.showNotification({
          style: 'success',
          message: this.$t('admin:mail.saveSuccess'),
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-mail-update')
      }
    },
    async loadConfig () {
      try {
        wikiStore.startLoading('admin-mail-refresh')
        this.config = _.cloneDeep(await fetchMailConfig(window.fetch.bind(window)))
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-mail-refresh')
      }
    },
    async sendTest () {
      try {
        wikiStore.startLoading('admin-mail-test')
        await sendMailTest(window.fetch.bind(window), this.testEmail, 'An unexpected error occurred.')
        this.testEmail = ''
        wikiStore.showNotification({
          style: 'success',
          message: this.$t('admin:mail.sendTestSuccess'),
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-mail-test')
      }
    }
  },
  created () {
    this.loadConfig()
  }
}
</script>

<style lang='scss'>

</style>
