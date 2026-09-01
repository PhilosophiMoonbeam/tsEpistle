<template lang='pug'>
  v-card
    v-toolbar(flat, color='primary', density="compact")
      .text-body-large {{ $t('admin:utilities.authTitle') }}
    v-card-text
      .text-body-large.pb-3.text-primary Generate New Authentication Public / Private Key Certificates
      .text-body-medium This will invalidate all current session tokens and cause all users to be logged out.
      .text-body-medium.text-error You will need to log back in after the operation.
      v-btn(variant="outlined", color='error', @click='openConfirmation("certificates")', :loading='activeOperation === "certificates"', :disabled='loading && activeOperation !== "certificates"').ml-0.mt-3
        v-icon(start) mdi-certificate-outline
        span Regenerate certificates
      v-divider.my-5
      .text-body-large.pb-3.text-primary Reset Guest User
      .text-body-medium This will reset the guest user to its default parameters and permissions.
      v-btn(variant="outlined", color='warning', @click='openConfirmation("guest")', :loading='activeOperation === "guest"', :disabled='loading && activeOperation !== "guest"').ml-0.mt-3
        v-icon(start) mdi-account-alert-outline
        span Reset guest user
    v-dialog(v-model='confirmationDialog', max-width='520', persistent, aria-labelledby='authentication-confirmation-title')
      v-card
        v-card-title#authentication-confirmation-title {{ confirmationTitle }}
        v-card-text
          .text-body-medium {{ confirmationText }}
        v-card-actions
          v-btn(variant="text", @click='confirmationDialog = false', :disabled='loading') Cancel
          v-spacer
          v-btn(:color='confirmAction === "certificates" ? "error" : "warning"', @click='confirmAction === "certificates" ? regenCerts() : resetGuest()', :loading='loading') {{ confirmAction === "certificates" ? "Regenerate certificates" : "Reset guest user" }}
    v-dialog(v-model='resultDialog', max-width='520', persistent, aria-labelledby='authentication-result-title')
      v-card
        v-card-title.text-success#authentication-result-title Authentication certificates regenerated
        v-card-text(aria-live='polite') {{ resultMessage }}

</template>

<script lang='ts'>
import Cookies from 'js-cookie'
import { regenerateAuthCertificates, resetGuestUser } from '../../helpers/auth-api'
import { wikiStore } from '@/store/index.ts'

type AuthAction = '' | 'certificates' | 'guest'

export default {
  data: () => ({
    loading: false,
    activeOperation: '' as AuthAction,
    confirmAction: '' as AuthAction,
    confirmationDialog: false,
    resultDialog: false,
    resultMessage: ''
  }),
  computed: {
    confirmationTitle (): string {
      return this.confirmAction === 'certificates'
        ? 'Regenerate authentication certificates?'
        : 'Reset guest user?'
    },
    confirmationText (): string {
      return this.confirmAction === 'certificates'
        ? 'This will invalidate every current session, log out all users, and redirect this administrator to sign-in.'
        : 'This will replace the guest user’s current parameters and permissions with the defaults.'
    }
  },
  methods: {
    openConfirmation (action: Exclude<AuthAction, ''>) {
      if (this.loading) return
      this.confirmAction = action
      this.confirmationDialog = true
    },
    async regenCerts () {
      if (this.loading) return
      this.loading = true
      this.activeOperation = 'certificates'
      wikiStore.startLoading('admin-utilities-auth-regencerts')

      try {
        await regenerateAuthCertificates(window.fetch.bind(window))
        Cookies.remove('jwt')
        this.confirmationDialog = false
        this.resultMessage = 'Certificates regenerated. Redirecting to sign-in.'
        this.resultDialog = true
        window.setTimeout(() => window.location.assign('/login'), 1500)
      } catch (err) {
        wikiStore.showError(err)
        this.confirmationDialog = false
      } finally {
        wikiStore.stopLoading('admin-utilities-auth-regencerts')
        this.loading = false
        this.activeOperation = ''
      }
    },
    async resetGuest () {
      if (this.loading) return
      this.loading = true
      this.activeOperation = 'guest'
      wikiStore.startLoading('admin-utilities-auth-resetguest')

      try {
        await resetGuestUser(window.fetch.bind(window))
        this.confirmationDialog = false
        wikiStore.showNotification({
          message: 'Guest user was reset successfully.',
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
        this.confirmationDialog = false
      } finally {
        wikiStore.stopLoading('admin-utilities-auth-resetguest')
        this.loading = false
        this.activeOperation = ''
      }
    }
  }
}
</script>

<style lang='scss'>

</style>
