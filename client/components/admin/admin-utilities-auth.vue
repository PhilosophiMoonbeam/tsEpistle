<template lang='pug'>
  v-card
    v-toolbar(flat, color='primary', density="compact")
      .text-body-large {{ $t('admin:utilities.authTitle') }}
    v-card-text
      .text-body-large.pb-3.text-primary Generate New Authentication Public / Private Key Certificates
      .text-body-medium This will invalidate all current session tokens and cause all users to be logged out.
      .text-body-medium.text-red You will need to log back in after the operation.
      v-btn(variant="outlined", color='primary', @click='regenCerts', :disabled='loading').ml-0.mt-3
        v-icon(start) mdi-gesture-double-tap
        span Proceed
      v-divider.my-5
      .text-body-large.pb-3.text-primary Reset Guest User
      .text-body-medium This will reset the guest user to its default parameters and permissions.
      v-btn(variant="outlined", color='primary', @click='resetGuest', :disabled='loading').ml-0.mt-3
        v-icon(start) mdi-gesture-double-tap
        span Proceed</template>

<script lang='ts'>
import _ from 'lodash'
import Cookies from 'js-cookie'
import { regenerateAuthCertificates, resetGuestUser } from '../../helpers/auth-api'
import { wikiStore } from '@/store/index.ts'

export default {
  data: () => {
    return {
      loading: false
    }
  },
  methods: {
    async regenCerts() {
      this.loading = true
      wikiStore.startLoading('admin-utilities-auth-regencerts')

      try {
        await regenerateAuthCertificates(window.fetch.bind(window))
        wikiStore.showNotification({
          message: 'New Certificates generated successfully.',
          style: 'success',
          icon: 'check'
        })
        Cookies.remove('jwt')
        _.delay(() => {
          window.location.assign('/login')
        }, 1000)
      } catch (err) {
        wikiStore.showError(err)
      }

      wikiStore.stopLoading('admin-utilities-auth-regencerts')
      this.loading = false
    },
    async resetGuest() {
      this.loading = true
      wikiStore.startLoading('admin-utilities-auth-resetguest')

      try {
        await resetGuestUser(window.fetch.bind(window))
        wikiStore.showNotification({
          message: 'Guest user was reset successfully.',
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
      }

      wikiStore.stopLoading('admin-utilities-auth-resetguest')
      this.loading = false
    }
  }
}
</script>

<style lang='scss'>

</style>
