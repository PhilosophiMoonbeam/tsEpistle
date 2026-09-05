<template lang='pug'>
  v-container(fluid)
    async-state(
      v-if='profileLoading'
      state='loading'
      :title='$t("profile:loading", { defaultValue: "Loading profile" })'
      :message='$t("profile:loadingMessage", { defaultValue: "Fetching your account settings." })'
    )
    async-state(
      v-else-if='profileError'
      state='error'
      :title='$t("profile:loadError", { defaultValue: "Profile could not be loaded" })'
      :message='profileError'
      :retry-label='$t("common:actions.retry", { defaultValue: "Try again" })'
      @retry='loadProfile'
    )
    v-row(v-else)
      v-col(cols='12')
        .profile-header
          img.animated.fadeInUp(src='/_assets/svg/icon-profile.svg', alt='', style='width: 80px;')
          .profile-header-title
            h1.text-headline-medium.text-primary.animated.fadeInLeft {{$t('profile:title')}}
            .text-body-large.text-grey.animated.fadeInLeft {{$t('profile:subtitle')}}
          v-spacer
          v-btn.animated.fadeInDown(
            color='primary'
            variant="flat"
            @click='saveProfile'
            :loading='saveLoading'
            :disabled='!profileReady'
            size="large"
            prepend-icon='mdi-check'
          ) {{$t('common:actions.save')}}
          //- v-btn.animated.fadeInDown.mr-0(variant='outlined', color='primary', disabled)
          //-   v-icon(start) mdi-earth
          //-   span {{$t('profile:viewPublicProfile')}}
      v-col(lg='6' cols='12')
        v-card.animated.fadeInUp
          v-toolbar(color='blue-grey', density="compact", flat)
            v-toolbar-title.text-body-large(tag='h2') {{$t('profile:myInfo')}}
          v-list(lines="two", density="compact")
            v-list-item
              template(v-slot:prepend)
                v-avatar(size='32')
                  v-icon mdi-account
              v-list-item-title {{$t('profile:displayName')}}
              v-list-item-subtitle {{ user.name }}
              template(v-slot:append)
                v-menu(
                  v-model='editPop.name'
                  :close-on-content-click='false'
                  min-width='min(350px, calc(100vw - 24px))'
                  location='start'
                  )
                  template(v-slot:activator='{ props }')
                    v-btn(variant="text", color='grey', size="small", v-bind='props', :aria-label='$t(`common:actions.edit`) + ` ` + $t(`profile:displayName`)' @click='focusField(`iptDisplayName`)')
                      v-icon(start) mdi-pencil
                      span {{ $t('common:actions.edit') }}
                  v-card
                    v-text-field(
                      ref='iptDisplayName'
                      v-model='user.name'
                      :label='$t(`profile:displayName`)'
                      variant="solo"
                      hide-details
                      append-icon='mdi-check'
                      @click:append='editPop.name = false'
                      @keydown.enter='editPop.name = false'
                      @keydown.esc='editPop.name = false'
                    )
            v-divider
            v-list-item
              template(v-slot:prepend)
                v-avatar(size='32')
                  v-icon mdi-map-marker
              v-list-item-title {{$t('profile:location')}}
              v-list-item-subtitle {{ user.location }}
              template(v-slot:append)
                v-menu(
                  v-model='editPop.location'
                  :close-on-content-click='false'
                  min-width='min(350px, calc(100vw - 24px))'
                  location='start'
                  )
                  template(v-slot:activator='{ props }')
                    v-btn(variant="text", color='grey', size="small", v-bind='props', :aria-label='$t(`common:actions.edit`) + ` ` + $t(`profile:location`)' @click='focusField(`iptLocation`)')
                      v-icon(start) mdi-pencil
                      span {{ $t('common:actions.edit') }}
                  v-card
                    v-text-field(
                      ref='iptLocation'
                      v-model='user.location'
                      :label='$t(`profile:location`)'
                      variant="solo"
                      hide-details
                      append-icon='mdi-check'
                      @click:append='editPop.location = false'
                      @keydown.enter='editPop.location = false'
                      @keydown.esc='editPop.location = false'
                    )
            v-divider
            v-list-item
              template(v-slot:prepend)
                v-avatar(size='32')
                  v-icon mdi-briefcase
              v-list-item-title {{$t('profile:jobTitle')}}
              v-list-item-subtitle {{ user.jobTitle }}
              template(v-slot:append)
                v-menu(
                  v-model='editPop.jobTitle'
                  :close-on-content-click='false'
                  min-width='min(350px, calc(100vw - 24px))'
                  location='start'
                  )
                  template(v-slot:activator='{ props }')
                    v-btn(variant="text", color='grey', size="small", v-bind='props', :aria-label='$t(`common:actions.edit`) + ` ` + $t(`profile:jobTitle`)' @click='focusField(`iptJobTitle`)')
                      v-icon(start) mdi-pencil
                      span {{ $t('common:actions.edit') }}
                  v-card
                    v-text-field(
                      ref='iptJobTitle'
                      v-model='user.jobTitle'
                      :label='$t(`profile:jobTitle`)'
                      variant="solo"
                      hide-details
                      append-icon='mdi-check'
                      @click:append='editPop.jobTitle = false'
                      @keydown.enter='editPop.jobTitle = false'
                      @keydown.esc='editPop.jobTitle = false'
                    )

        v-card.mt-3.animated.fadeInUp.wait-p2s
          v-toolbar(color='blue-grey', density="compact", flat)
            v-toolbar-title.text-body-large(tag='h2') {{$t('profile:auth.title')}}
          v-card-text.pt-0
            v-list-subheader.pl-0: span.text-label-large {{$t('profile:auth.provider')}}
            v-toolbar.profile-auth-provider(
              flat
              density="compact"
              )
              .profile-auth-provider__mark
                v-icon(aria-hidden='true') mdi-shield-lock
              .profile-auth-provider__name.text-body-large {{ user.providerName }}
            //- v-divider.mt-3
            //- v-list-subheader.pl-0: span.text-label-large Two-Factor Authentication (2FA)
            //- .text-body-small.mb-2 2FA adds an extra layer of security by requiring a unique code generated on your smartphone when signing in.
            //- v-btn.ml-0(color='purple-darken-4', disabled) Enable 2FA
            //- v-btn.ml-0(color='purple-darken-4', variant='flat', disabled) Disable 2FA
            template(v-if='user.providerKey === `local`')
              form#change-password-form(@submit.prevent='changePassword' :aria-busy='changePassLoading')
                v-divider.mt-3
                v-list-subheader.pl-0: span.text-label-large {{$t('profile:auth.changePassword')}}
                v-alert.mb-3(
                  v-if='passwordErrorSummary'
                  type='error'
                  variant='tonal'
                  role='alert'
                ) {{ passwordErrorSummary }}
                v-text-field(
                  ref='iptCurrentPass'
                  v-model='currentPass'
                  variant="outlined"
                  :label='$t(`profile:auth.currentPassword`)'
                  :type='hideCurrentPass ? "password" : "text"'
                  :error-messages='passwordErrors.current'
                  prepend-inner-icon='mdi-form-textbox-password'
                  autocomplete='current-password'
                  :disabled='changePassLoading'
                  )
                  template(v-slot:append-inner)
                    v-btn(
                      icon
                      variant='text'
                      size='small'
                      type='button'
                      :aria-label='(hideCurrentPass ? $t(`common:header.view`) : $t(`common:actions.close`)) + ` ` + $t(`profile:auth.currentPassword`)'
                      :disabled='changePassLoading'
                      @click='hideCurrentPass = !hideCurrentPass'
                    )
                      v-icon {{ hideCurrentPass ? 'mdi-eye-outline' : 'mdi-eye-off-outline' }}
                v-text-field(
                  ref='iptNewPass'
                  v-model='newPass'
                  variant="outlined"
                  :label='$t(`profile:auth.newPassword`)'
                  :type='hideNewPass ? "password" : "text"'
                  :error-messages='passwordErrors.password'
                  prepend-inner-icon='mdi-form-textbox-password'
                  autocomplete='new-password'
                  counter='255'
                  loading
                  :disabled='changePassLoading'
                  )
                  template(v-slot:loader)
                    password-strength(v-model='newPass')
                  template(v-slot:append-inner)
                    v-btn(
                      icon
                      variant='text'
                      size='small'
                      type='button'
                      :aria-label='(hideNewPass ? $t(`common:header.view`) : $t(`common:actions.close`)) + ` ` + $t(`profile:auth.newPassword`)'
                      :disabled='changePassLoading'
                      @click='hideNewPass = !hideNewPass'
                    )
                      v-icon {{ hideNewPass ? 'mdi-eye-outline' : 'mdi-eye-off-outline' }}
                v-text-field(
                  ref='iptVerifyPass'
                  v-model='verifyPass'
                  variant="outlined"
                  :label='$t(`profile:auth.verifyPassword`)'
                  :type='hideVerifyPass ? "password" : "text"'
                  :error-messages='passwordErrors.verifyPassword'
                  prepend-inner-icon='mdi-form-textbox-password'
                  autocomplete='new-password'
                  :disabled='changePassLoading'
                  )
                  template(v-slot:append-inner)
                    v-btn(
                      icon
                      variant='text'
                      size='small'
                      type='button'
                      :aria-label='(hideVerifyPass ? $t(`common:header.view`) : $t(`common:actions.close`)) + ` ` + $t(`profile:auth.verifyPassword`)'
                      :disabled='changePassLoading'
                      @click='hideVerifyPass = !hideVerifyPass'
                    )
                      v-icon {{ hideVerifyPass ? 'mdi-eye-outline' : 'mdi-eye-off-outline' }}
          v-card-chin(v-if='user.providerKey === `local`')
            v-spacer
            v-btn.px-4(color="primary", variant="flat", :loading='changePassLoading', :disabled='changePassLoading', type='submit', form='change-password-form')
              v-icon(start) mdi-progress-check
              span {{$t('profile:auth.changePassword')}}
      v-col(lg='6' cols='12')
        //- v-card
        //-   v-toolbar.text-white(color='blue-grey', density='compact', flat)
        //-     v-toolbar-title
        //-       .text-body-large Picture
        //-   v-card-title
        //-     v-avatar.bg-blue(v-if='picture.kind === `initials`', size='40')
        //-       span.text-white.text-body-large {{picture.initials}}
        //-     v-avatar(v-else-if='picture.kind === `image`', size='40')
        //-       v-img(:src='picture.url')
        //-     v-btn.mx-4(variant='outlined') Upload Picture
        //-     v-btn(variant='outlined', disabled) Remove Picture
        v-card.animated.fadeInUp.wait-p2s
          v-toolbar(color='blue-grey', density="compact", flat)
            v-toolbar-title.text-body-large(tag='h2') {{$t('profile:preferences')}}
          v-list(lines="two", density="compact")
            v-list-item
              template(v-slot:prepend)
                v-avatar(size='32')
                  v-icon mdi-map-clock-outline
              v-list-item-title {{$t('profile:timezone')}}
              v-list-item-subtitle {{ user.timezone }}
              template(v-slot:append)
                v-menu(
                  v-model='editPop.timezone'
                  :close-on-content-click='false'
                  min-width='min(350px, calc(100vw - 24px))'
                  max-width='min(350px, calc(100vw - 24px))'
                  location='start'
                  )
                  template(v-slot:activator='{ props }')
                    v-btn(variant="text", color='grey', size="small", v-bind='props', :aria-label='$t(`common:actions.edit`) + ` ` + $t(`profile:timezone`)' @click='focusField(`iptTimezone`)')
                      v-icon(start) mdi-pencil
                      span {{ $t('common:actions.edit') }}
                  v-card(flat)
                    v-select(
                      ref='iptTimezone'
                      :items='timezones'
                      v-model='user.timezone'
                      :label='$t(`profile:timezone`)'
                      variant="solo"
                      flat
                      density="compact"
                      hide-details
                      @keydown.enter='editPop.timezone = false'
                      @keydown.esc='editPop.timezone = false'
                      style='height: 38px;'
                    )
                    v-card-chin
                      v-spacer
                      v-btn(
                        size="small"
                        variant="text"
                        color='primary'
                        @click='editPop.timezone = false'
                        )
                        v-icon(start) mdi-check
                        span {{$t('common:actions.ok')}}
            v-divider
            v-list-item
              template(v-slot:prepend)
                v-avatar(size='32')
                  v-icon mdi-calendar-month-outline
              v-list-item-title {{$t('profile:dateFormat')}}
              v-list-item-subtitle {{ user.dateFormat && user.dateFormat.length > 0 ? user.dateFormat : $t('profile:localeDefault') }}
              template(v-slot:append)
                v-menu(
                  v-model='editPop.dateFormat'
                  :close-on-content-click='false'
                  min-width='min(350px, calc(100vw - 24px))'
                  max-width='min(350px, calc(100vw - 24px))'
                  location='start'
                  )
                  template(v-slot:activator='{ props }')
                    v-btn(variant="text", color='grey', size="small", v-bind='props', :aria-label='$t(`common:actions.edit`) + ` ` + $t(`profile:dateFormat`)' @click='focusField(`iptDateFormat`)')
                      v-icon(start) mdi-pencil
                      span {{ $t('common:actions.edit') }}
                  v-card(flat)
                    v-select(
                      ref='iptDateFormat'
                      :items='dateFormats'
                      v-model='user.dateFormat'
                      :label='$t(`profile:dateFormat`)'
                      variant="solo"
                      flat
                      density="compact"
                      hide-details
                      @keydown.enter='editPop.dateFormat = false'
                      @keydown.esc='editPop.dateFormat = false'
                      style='height: 38px;'
                    )
                    v-card-chin
                      v-spacer
                      v-btn(
                        size="small"
                        variant="text"
                        color='primary'
                        @click='editPop.dateFormat = false'
                        )
                        v-icon(start) mdi-check
                        span {{$t('common:actions.ok')}}
            v-divider
            v-list-item
              template(v-slot:prepend)
                v-avatar(size='32')
                  v-icon mdi-palette
              v-list-item-title {{$t('profile:appearance')}}
              v-list-item-subtitle {{ currentAppearance }}
              template(v-slot:append)
                v-menu(
                  v-model='editPop.appearance'
                  :close-on-content-click='false'
                  min-width='min(350px, calc(100vw - 24px))'
                  max-width='min(350px, calc(100vw - 24px))'
                  location='start'
                  )
                  template(v-slot:activator='{ props }')
                    v-btn(variant="text", color='grey', size="small", v-bind='props', :aria-label='$t(`common:actions.edit`) + ` ` + $t(`profile:appearance`)' @click='focusField(`iptAppearance`)')
                      v-icon(start) mdi-pencil
                      span {{ $t('common:actions.edit') }}
                  v-card(flat)
                    v-select(
                      ref='iptAppearance'
                      :items='appearances'
                      v-model='user.appearance'
                      :label='$t(`profile:appearance`)'
                      variant="solo"
                      flat
                      density="compact"
                      hide-details
                      @keydown.enter='editPop.appearance = false'
                      @keydown.esc='editPop.appearance = false'
                      style='height: 38px;'
                    )
                    v-card-chin
                      v-spacer
                      v-btn(
                        size="small"
                        variant="text"
                        color='primary'
                        @click='editPop.appearance = false'
                        )
                        v-icon(start) mdi-check
                        span {{$t('common:actions.ok')}}

        v-card.mt-3.animated.fadeInUp.wait-p3s
          v-toolbar(color='primary', density="compact", flat)
            v-toolbar-title.text-body-large(tag='h2') {{$t('profile:groups.title')}}
          v-list(density="compact")
            template(v-if='user.groups.length')
              template(v-for='(grp, idx) of user.groups', :key='`grp-id-` + grp')
                v-list-item
                  template(v-slot:prepend)
                    v-avatar(size='32')
                      v-icon mdi-account-group
                  v-list-item-title.text-body-medium {{grp}}
                v-divider(v-if='idx < user.groups.length - 1')
            v-list-item(v-else)
              v-list-item-title.text-body-medium.text-medium-emphasis {{ $t('profile:groups.empty', { defaultValue: 'No groups assigned' }) }}

        v-card.mt-3.animated.fadeInUp.wait-p4s
          v-toolbar(color='teal', density="compact", flat)
            v-toolbar-title.text-body-large(tag='h2') {{$t('profile:activity.title')}}
          v-card-text.text-grey-darken-2
            .text-body-small.text-grey {{$t('profile:activity.joinedOn')}}
            .text-body-medium: strong {{ $helpers.formatMoment(user.createdAt, 'LLLL') }}
            .text-body-small.text-grey.mt-3 {{$t('profile:activity.lastUpdatedOn')}}
            .text-body-medium: strong {{ $helpers.formatMoment(user.updatedAt, 'LLLL') }}
            .text-body-small.text-grey.mt-3 {{$t('profile:activity.lastLoginOn')}}
            .text-body-medium: strong {{ $helpers.formatMoment(user.lastLoginAt, 'LLLL') }}
            .text-body-small.text-grey.mt-3 {{$t('profile:activity.pagesCreated')}}
            .text-body-medium: strong {{ user.pagesTotal }}
</template>

<script lang='ts'>
import AsyncState from '@/components/common/async-state.vue'
import { wikiStore } from '@/store/index.ts'
import { changeProfilePassword, fetchProfile, updateProfile, type Profile } from '../../helpers/users-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import _ from 'lodash'
import Cookies from 'js-cookie'
import validateValues from '../../../shared/validation'
import type moment from 'moment'
import PasswordStrength from '../common/password-strength.vue'
import { resolveThemeName } from '../../helpers/theme.ts'

type ProfileFieldRef =
  | 'iptDisplayName'
  | 'iptLocation'
  | 'iptJobTitle'
  | 'iptTimezone'
  | 'iptDateFormat'
  | 'iptAppearance'

function focusComponent (ref: unknown): void {
  if (!ref || typeof ref !== 'object') return
  const candidate = ref as { focus?: unknown }
  if (typeof candidate.focus === 'function') candidate.focus()
}

/* global siteConfig */

export default {
  i18nOptions: {
    namespaces: ['profile', 'auth']
  },
  components: {
    AsyncState,
    PasswordStrength
  },
  data() {
    return {
      saveLoading: false,
      changePassLoading: false,
      profileLoading: true,
      profileError: '',
      user: null as Profile | null,
      currentPass: '',
      newPass: '',
      verifyPass: '',
      hideCurrentPass: true,
      hideNewPass: true,
      hideVerifyPass: true,
      passwordErrors: {
        current: [] as string[],
        password: [] as string[],
        verifyPassword: [] as string[]
      },
      editPop: {
        name: false,
        location: false,
        jobTitle: false,
        timezone: false,
        dateFormat: false,
        appearance: false
      },
      timezones: Object.freeze([
        { title: '(GMT-11:00) Niue', value: 'Pacific/Niue' },
        { title: '(GMT-11:00) Pago Pago', value: 'Pacific/Pago_Pago' },
        { title: '(GMT-10:00) Hawaii Time', value: 'Pacific/Honolulu' },
        { title: '(GMT-10:00) Rarotonga', value: 'Pacific/Rarotonga' },
        { title: '(GMT-10:00) Tahiti', value: 'Pacific/Tahiti' },
        { title: '(GMT-09:30) Marquesas', value: 'Pacific/Marquesas' },
        { title: '(GMT-09:00) Alaska Time', value: 'America/Anchorage' },
        { title: '(GMT-09:00) Gambier', value: 'Pacific/Gambier' },
        { title: '(GMT-08:00) Pacific Time', value: 'America/Los_Angeles' },
        { title: '(GMT-08:00) Pacific Time - Tijuana', value: 'America/Tijuana' },
        { title: '(GMT-08:00) Pacific Time - Vancouver', value: 'America/Vancouver' },
        { title: '(GMT-08:00) Pacific Time - Whitehorse', value: 'America/Whitehorse' },
        { title: '(GMT-08:00) Pitcairn', value: 'Pacific/Pitcairn' },
        { title: '(GMT-07:00) Mountain Time', value: 'America/Denver' },
        { title: '(GMT-07:00) Mountain Time - Arizona', value: 'America/Phoenix' },
        { title: '(GMT-07:00) Mountain Time - Chihuahua, Mazatlan', value: 'America/Mazatlan' },
        { title: '(GMT-07:00) Mountain Time - Dawson Creek', value: 'America/Dawson_Creek' },
        { title: '(GMT-07:00) Mountain Time - Edmonton', value: 'America/Edmonton' },
        { title: '(GMT-07:00) Mountain Time - Hermosillo', value: 'America/Hermosillo' },
        { title: '(GMT-07:00) Mountain Time - Yellowknife', value: 'America/Yellowknife' },
        { title: '(GMT-06:00) Belize', value: 'America/Belize' },
        { title: '(GMT-06:00) Central Time', value: 'America/Chicago' },
        { title: '(GMT-06:00) Central Time - Mexico City', value: 'America/Mexico_City' },
        { title: '(GMT-06:00) Central Time - Regina', value: 'America/Regina' },
        { title: '(GMT-06:00) Central Time - Tegucigalpa', value: 'America/Tegucigalpa' },
        { title: '(GMT-06:00) Central Time - Winnipeg', value: 'America/Winnipeg' },
        { title: '(GMT-06:00) Costa Rica', value: 'America/Costa_Rica' },
        { title: '(GMT-06:00) El Salvador', value: 'America/El_Salvador' },
        { title: '(GMT-06:00) Galapagos', value: 'Pacific/Galapagos' },
        { title: '(GMT-06:00) Guatemala', value: 'America/Guatemala' },
        { title: '(GMT-06:00) Managua', value: 'America/Managua' },
        { title: '(GMT-05:00) America Cancun', value: 'America/Cancun' },
        { title: '(GMT-05:00) Bogota', value: 'America/Bogota' },
        { title: '(GMT-05:00) Easter Island', value: 'Pacific/Easter' },
        { title: '(GMT-05:00) Eastern Time', value: 'America/New_York' },
        { title: '(GMT-05:00) Eastern Time - Iqaluit', value: 'America/Iqaluit' },
        { title: '(GMT-05:00) Eastern Time - Toronto', value: 'America/Toronto' },
        { title: '(GMT-05:00) Guayaquil', value: 'America/Guayaquil' },
        { title: '(GMT-05:00) Havana', value: 'America/Havana' },
        { title: '(GMT-05:00) Jamaica', value: 'America/Jamaica' },
        { title: '(GMT-05:00) Lima', value: 'America/Lima' },
        { title: '(GMT-05:00) Nassau', value: 'America/Nassau' },
        { title: '(GMT-05:00) Panama', value: 'America/Panama' },
        { title: '(GMT-05:00) Port-au-Prince', value: 'America/Port-au-Prince' },
        { title: '(GMT-05:00) Rio Branco', value: 'America/Rio_Branco' },
        { title: '(GMT-04:00) Atlantic Time - Halifax', value: 'America/Halifax' },
        { title: '(GMT-04:00) Barbados', value: 'America/Barbados' },
        { title: '(GMT-04:00) Bermuda', value: 'Atlantic/Bermuda' },
        { title: '(GMT-04:00) Boa Vista', value: 'America/Boa_Vista' },
        { title: '(GMT-04:00) Caracas', value: 'America/Caracas' },
        { title: '(GMT-04:00) Curacao', value: 'America/Curacao' },
        { title: '(GMT-04:00) Grand Turk', value: 'America/Grand_Turk' },
        { title: '(GMT-04:00) Guyana', value: 'America/Guyana' },
        { title: '(GMT-04:00) La Paz', value: 'America/La_Paz' },
        { title: '(GMT-04:00) Manaus', value: 'America/Manaus' },
        { title: '(GMT-04:00) Martinique', value: 'America/Martinique' },
        { title: '(GMT-04:00) Port of Spain', value: 'America/Port_of_Spain' },
        { title: '(GMT-04:00) Porto Velho', value: 'America/Porto_Velho' },
        { title: '(GMT-04:00) Puerto Rico', value: 'America/Puerto_Rico' },
        { title: '(GMT-04:00) Santo Domingo', value: 'America/Santo_Domingo' },
        { title: '(GMT-04:00) Thule', value: 'America/Thule' },
        { title: '(GMT-03:30) Newfoundland Time - St. Johns', value: 'America/St_Johns' },
        { title: '(GMT-03:00) Araguaina', value: 'America/Araguaina' },
        { title: '(GMT-03:00) Asuncion', value: 'America/Asuncion' },
        { title: '(GMT-03:00) Belem', value: 'America/Belem' },
        { title: '(GMT-03:00) Buenos Aires', value: 'America/Argentina/Buenos_Aires' },
        { title: '(GMT-03:00) Campo Grande', value: 'America/Campo_Grande' },
        { title: '(GMT-03:00) Cayenne', value: 'America/Cayenne' },
        { title: '(GMT-03:00) Cuiaba', value: 'America/Cuiaba' },
        { title: '(GMT-03:00) Fortaleza', value: 'America/Fortaleza' },
        { title: '(GMT-03:00) Godthab', value: 'America/Godthab' },
        { title: '(GMT-03:00) Maceio', value: 'America/Maceio' },
        { title: '(GMT-03:00) Miquelon', value: 'America/Miquelon' },
        { title: '(GMT-03:00) Montevideo', value: 'America/Montevideo' },
        { title: '(GMT-03:00) Palmer', value: 'Antarctica/Palmer' },
        { title: '(GMT-03:00) Paramaribo', value: 'America/Paramaribo' },
        { title: '(GMT-03:00) Punta Arenas', value: 'America/Punta_Arenas' },
        { title: '(GMT-03:00) Recife', value: 'America/Recife' },
        { title: '(GMT-03:00) Rothera', value: 'Antarctica/Rothera' },
        { title: '(GMT-03:00) Salvador', value: 'America/Bahia' },
        { title: '(GMT-03:00) Santiago', value: 'America/Santiago' },
        { title: '(GMT-03:00) Sao Paulo', value: 'America/Sao_Paulo' },
        { title: '(GMT-03:00) Stanley', value: 'Atlantic/Stanley' },
        { title: '(GMT-02:00) Noronha', value: 'America/Noronha' },
        { title: '(GMT-02:00) South Georgia', value: 'Atlantic/South_Georgia' },
        { title: '(GMT-01:00) Azores', value: 'Atlantic/Azores' },
        { title: '(GMT-01:00) Cape Verde', value: 'Atlantic/Cape_Verde' },
        { title: '(GMT-01:00) Scoresbysund', value: 'America/Scoresbysund' },
        { title: '(GMT+00:00) Abidjan', value: 'Africa/Abidjan' },
        { title: '(GMT+00:00) Accra', value: 'Africa/Accra' },
        { title: '(GMT+00:00) Bissau', value: 'Africa/Bissau' },
        { title: '(GMT+00:00) Canary Islands', value: 'Atlantic/Canary' },
        { title: '(GMT+00:00) Casablanca', value: 'Africa/Casablanca' },
        { title: '(GMT+00:00) Danmarkshavn', value: 'America/Danmarkshavn' },
        { title: '(GMT+00:00) Dublin', value: 'Europe/Dublin' },
        { title: '(GMT+00:00) El Aaiun', value: 'Africa/El_Aaiun' },
        { title: '(GMT+00:00) Faeroe', value: 'Atlantic/Faroe' },
        { title: '(GMT+00:00) GMT (no daylight saving)', value: 'Etc/GMT' },
        { title: '(GMT+00:00) Lisbon', value: 'Europe/Lisbon' },
        { title: '(GMT+00:00) London', value: 'Europe/London' },
        { title: '(GMT+00:00) Monrovia', value: 'Africa/Monrovia' },
        { title: '(GMT+00:00) Reykjavik', value: 'Atlantic/Reykjavik' },
        { title: '(GMT+01:00) Algiers', value: 'Africa/Algiers' },
        { title: '(GMT+01:00) Amsterdam', value: 'Europe/Amsterdam' },
        { title: '(GMT+01:00) Andorra', value: 'Europe/Andorra' },
        { title: '(GMT+01:00) Berlin', value: 'Europe/Berlin' },
        { title: '(GMT+01:00) Brussels', value: 'Europe/Brussels' },
        { title: '(GMT+01:00) Budapest', value: 'Europe/Budapest' },
        { title: '(GMT+01:00) Central European Time - Belgrade', value: 'Europe/Belgrade' },
        { title: '(GMT+01:00) Central European Time - Prague', value: 'Europe/Prague' },
        { title: '(GMT+01:00) Ceuta', value: 'Africa/Ceuta' },
        { title: '(GMT+01:00) Copenhagen', value: 'Europe/Copenhagen' },
        { title: '(GMT+01:00) Gibraltar', value: 'Europe/Gibraltar' },
        { title: '(GMT+01:00) Lagos', value: 'Africa/Lagos' },
        { title: '(GMT+01:00) Luxembourg', value: 'Europe/Luxembourg' },
        { title: '(GMT+01:00) Madrid', value: 'Europe/Madrid' },
        { title: '(GMT+01:00) Malta', value: 'Europe/Malta' },
        { title: '(GMT+01:00) Monaco', value: 'Europe/Monaco' },
        { title: '(GMT+01:00) Ndjamena', value: 'Africa/Ndjamena' },
        { title: '(GMT+01:00) Oslo', value: 'Europe/Oslo' },
        { title: '(GMT+01:00) Paris', value: 'Europe/Paris' },
        { title: '(GMT+01:00) Rome', value: 'Europe/Rome' },
        { title: '(GMT+01:00) Stockholm', value: 'Europe/Stockholm' },
        { title: '(GMT+01:00) Tirane', value: 'Europe/Tirane' },
        { title: '(GMT+01:00) Tunis', value: 'Africa/Tunis' },
        { title: '(GMT+01:00) Vienna', value: 'Europe/Vienna' },
        { title: '(GMT+01:00) Warsaw', value: 'Europe/Warsaw' },
        { title: '(GMT+01:00) Zurich', value: 'Europe/Zurich' },
        { title: '(GMT+02:00) Amman', value: 'Asia/Amman' },
        { title: '(GMT+02:00) Athens', value: 'Europe/Athens' },
        { title: '(GMT+02:00) Beirut', value: 'Asia/Beirut' },
        { title: '(GMT+02:00) Bucharest', value: 'Europe/Bucharest' },
        { title: '(GMT+02:00) Cairo', value: 'Africa/Cairo' },
        { title: '(GMT+02:00) Chisinau', value: 'Europe/Chisinau' },
        { title: '(GMT+02:00) Damascus', value: 'Asia/Damascus' },
        { title: '(GMT+02:00) Gaza', value: 'Asia/Gaza' },
        { title: '(GMT+02:00) Helsinki', value: 'Europe/Helsinki' },
        { title: '(GMT+02:00) Jerusalem', value: 'Asia/Jerusalem' },
        { title: '(GMT+02:00) Johannesburg', value: 'Africa/Johannesburg' },
        { title: '(GMT+02:00) Khartoum', value: 'Africa/Khartoum' },
        { title: '(GMT+02:00) Kyiv', value: 'Europe/Kyiv' },
        { title: '(GMT+02:00) Maputo', value: 'Africa/Maputo' },
        { title: '(GMT+02:00) Moscow-01 - Kaliningrad', value: 'Europe/Kaliningrad' },
        { title: '(GMT+02:00) Nicosia', value: 'Asia/Nicosia' },
        { title: '(GMT+02:00) Riga', value: 'Europe/Riga' },
        { title: '(GMT+02:00) Sofia', value: 'Europe/Sofia' },
        { title: '(GMT+02:00) Tallinn', value: 'Europe/Tallinn' },
        { title: '(GMT+02:00) Tripoli', value: 'Africa/Tripoli' },
        { title: '(GMT+02:00) Vilnius', value: 'Europe/Vilnius' },
        { title: '(GMT+02:00) Windhoek', value: 'Africa/Windhoek' },
        { title: '(GMT+03:00) Baghdad', value: 'Asia/Baghdad' },
        { title: '(GMT+03:00) Istanbul', value: 'Europe/Istanbul' },
        { title: '(GMT+03:00) Minsk', value: 'Europe/Minsk' },
        { title: '(GMT+03:00) Moscow+00 - Moscow', value: 'Europe/Moscow' },
        { title: '(GMT+03:00) Nairobi', value: 'Africa/Nairobi' },
        { title: '(GMT+03:00) Qatar', value: 'Asia/Qatar' },
        { title: '(GMT+03:00) Riyadh', value: 'Asia/Riyadh' },
        { title: '(GMT+03:00) Syowa', value: 'Antarctica/Syowa' },
        { title: '(GMT+03:30) Tehran', value: 'Asia/Tehran' },
        { title: '(GMT+04:00) Baku', value: 'Asia/Baku' },
        { title: '(GMT+04:00) Dubai', value: 'Asia/Dubai' },
        { title: '(GMT+04:00) Mahe', value: 'Indian/Mahe' },
        { title: '(GMT+04:00) Mauritius', value: 'Indian/Mauritius' },
        { title: '(GMT+04:00) Moscow+01 - Samara', value: 'Europe/Samara' },
        { title: '(GMT+04:00) Reunion', value: 'Indian/Reunion' },
        { title: '(GMT+04:00) Tbilisi', value: 'Asia/Tbilisi' },
        { title: '(GMT+04:00) Yerevan', value: 'Asia/Yerevan' },
        { title: '(GMT+04:30) Kabul', value: 'Asia/Kabul' },
        { title: '(GMT+05:00) Aqtau', value: 'Asia/Aqtau' },
        { title: '(GMT+05:00) Aqtobe', value: 'Asia/Aqtobe' },
        { title: '(GMT+05:00) Ashgabat', value: 'Asia/Ashgabat' },
        { title: '(GMT+05:00) Dushanbe', value: 'Asia/Dushanbe' },
        { title: '(GMT+05:00) Karachi', value: 'Asia/Karachi' },
        { title: '(GMT+05:00) Kerguelen', value: 'Indian/Kerguelen' },
        { title: '(GMT+05:00) Maldives', value: 'Indian/Maldives' },
        { title: '(GMT+05:00) Mawson', value: 'Antarctica/Mawson' },
        { title: '(GMT+05:00) Moscow+02 - Yekaterinburg', value: 'Asia/Yekaterinburg' },
        { title: '(GMT+05:00) Tashkent', value: 'Asia/Tashkent' },
        { title: '(GMT+05:30) Colombo', value: 'Asia/Colombo' },
        { title: '(GMT+05:30) India Standard Time', value: 'Asia/Kolkata' },
        { title: '(GMT+05:45) Kathmandu', value: 'Asia/Kathmandu' },
        { title: '(GMT+06:00) Almaty', value: 'Asia/Almaty' },
        { title: '(GMT+06:00) Bishkek', value: 'Asia/Bishkek' },
        { title: '(GMT+06:00) Chagos', value: 'Indian/Chagos' },
        { title: '(GMT+06:00) Dhaka', value: 'Asia/Dhaka' },
        { title: '(GMT+06:00) Moscow+03 - Omsk', value: 'Asia/Omsk' },
        { title: '(GMT+06:00) Thimphu', value: 'Asia/Thimphu' },
        { title: '(GMT+06:00) Vostok', value: 'Antarctica/Vostok' },
        { title: '(GMT+06:30) Cocos', value: 'Indian/Cocos' },
        { title: '(GMT+06:30) Rangoon', value: 'Asia/Yangon' },
        { title: '(GMT+07:00) Bangkok', value: 'Asia/Bangkok' },
        { title: '(GMT+07:00) Christmas', value: 'Indian/Christmas' },
        { title: '(GMT+07:00) Davis', value: 'Antarctica/Davis' },
        { title: '(GMT+07:00) Hanoi', value: 'Asia/Saigon' },
        { title: '(GMT+07:00) Hovd', value: 'Asia/Hovd' },
        { title: '(GMT+07:00) Jakarta', value: 'Asia/Jakarta' },
        { title: '(GMT+07:00) Moscow+04 - Krasnoyarsk', value: 'Asia/Krasnoyarsk' },
        { title: '(GMT+08:00) Brunei', value: 'Asia/Brunei' },
        { title: '(GMT+08:00) China Time - Beijing', value: 'Asia/Shanghai' },
        { title: '(GMT+08:00) Choibalsan', value: 'Asia/Choibalsan' },
        { title: '(GMT+08:00) Hong Kong', value: 'Asia/Hong_Kong' },
        { title: '(GMT+08:00) Kuala Lumpur', value: 'Asia/Kuala_Lumpur' },
        { title: '(GMT+08:00) Macau', value: 'Asia/Macau' },
        { title: '(GMT+08:00) Makassar', value: 'Asia/Makassar' },
        { title: '(GMT+08:00) Manila', value: 'Asia/Manila' },
        { title: '(GMT+08:00) Moscow+05 - Irkutsk', value: 'Asia/Irkutsk' },
        { title: '(GMT+08:00) Singapore', value: 'Asia/Singapore' },
        { title: '(GMT+08:00) Taipei', value: 'Asia/Taipei' },
        { title: '(GMT+08:00) Ulaanbaatar', value: 'Asia/Ulaanbaatar' },
        { title: '(GMT+08:00) Western Time - Perth', value: 'Australia/Perth' },
        { title: '(GMT+08:30) Pyongyang', value: 'Asia/Pyongyang' },
        { title: '(GMT+09:00) Dili', value: 'Asia/Dili' },
        { title: '(GMT+09:00) Jayapura', value: 'Asia/Jayapura' },
        { title: '(GMT+09:00) Moscow+06 - Yakutsk', value: 'Asia/Yakutsk' },
        { title: '(GMT+09:00) Palau', value: 'Pacific/Palau' },
        { title: '(GMT+09:00) Seoul', value: 'Asia/Seoul' },
        { title: '(GMT+10:00) Eastern Time - Brisbane', value: 'Australia/Brisbane' },
        { title: '(GMT+10:00) Guam', value: 'Pacific/Guam' },
        { title: '(GMT+10:00) Moscow+07 - Vladivostok', value: 'Asia/Vladivostok' },
        { title: '(GMT+10:00) Port Moresby', value: 'Pacific/Port_Moresby' },
        { title: '(GMT+10:00) Truk', value: 'Pacific/Chuuk' },
        { title: '(GMT+10:30) Central Time - Adelaide', value: 'Australia/Adelaide' },
        { title: '(GMT+11:00) Casey', value: 'Antarctica/Casey' },
        { title: '(GMT+11:00) Eastern Time - Hobart', value: 'Australia/Hobart' },
        { title: '(GMT+11:00) Eastern Time - Melbourne, Sydney', value: 'Australia/Sydney' },
        { title: '(GMT+11:00) Efate', value: 'Pacific/Efate' },
        { title: '(GMT+11:00) Guadalcanal', value: 'Pacific/Guadalcanal' },
        { title: '(GMT+11:00) Kosrae', value: 'Pacific/Kosrae' },
        { title: '(GMT+11:00) Moscow+08 - Magadan', value: 'Asia/Magadan' },
        { title: '(GMT+11:00) Norfolk', value: 'Pacific/Norfolk' },
        { title: '(GMT+11:00) Noumea', value: 'Pacific/Noumea' },
        { title: '(GMT+11:00) Ponape', value: 'Pacific/Pohnpei' },
        { title: '(GMT+12:00) Funafuti', value: 'Pacific/Funafuti' },
        { title: '(GMT+12:00) Kwajalein', value: 'Pacific/Kwajalein' },
        { title: '(GMT+12:00) Majuro', value: 'Pacific/Majuro' },
        { title: '(GMT+12:00) Moscow+09 - Petropavlovsk-Kamchatskiy', value: 'Asia/Kamchatka' },
        { title: '(GMT+12:00) Nauru', value: 'Pacific/Nauru' },
        { title: '(GMT+12:00) Tarawa', value: 'Pacific/Tarawa' },
        { title: '(GMT+12:00) Wake', value: 'Pacific/Wake' },
        { title: '(GMT+12:00) Wallis', value: 'Pacific/Wallis' },
        { title: '(GMT+13:00) Auckland', value: 'Pacific/Auckland' },
        { title: '(GMT+13:00) Enderbury', value: 'Pacific/Enderbury' },
        { title: '(GMT+13:00) Fakaofo', value: 'Pacific/Fakaofo' },
        { title: '(GMT+13:00) Fiji', value: 'Pacific/Fiji' },
        { title: '(GMT+13:00) Tongatapu', value: 'Pacific/Tongatapu' },
        { title: '(GMT+14:00) Apia', value: 'Pacific/Apia' },
        { title: '(GMT+14:00) Kiritimati', value: 'Pacific/Kiritimati' }
      ])
    }
  },
  computed: {
    profileReady () {
      return this.user !== null
    },
    passwordErrorSummary () {
      return this.passwordErrors.current[0] || this.passwordErrors.password[0] || this.passwordErrors.verifyPassword[0] || ''
    },
    dateFormats () {
      return [
        { title: this.$t('profile:localeDefault'), value: '' },
        { title: 'DD/MM/YYYY', value: 'DD/MM/YYYY' },
        { title: 'DD.MM.YYYY', value: 'DD.MM.YYYY' },
        { title: 'MM/DD/YYYY', value: 'MM/DD/YYYY' },
        { title: 'YYYY-MM-DD', value: 'YYYY-MM-DD' },
        { title: 'YYYY/MM/DD', value: 'YYYY/MM/DD' }
      ]
    },
    appearances () {
      return [
        { title: this.$t('profile:appearanceDefault'), value: '' },
        { title: this.$t('profile:appearanceSystem', { defaultValue: 'Match Device' }), value: 'system' },
        { title: this.$t('profile:appearanceLight'), value: 'light' },
        { title: this.$t('profile:appearanceDark'), value: 'dark' }
      ]
    },
    currentAppearance () {
      return _.get(_.find(this.appearances, ['value', this.user?.appearance]), 'title', false) || this.$t('profile:appearanceDefault')
    },
  },
  watch: {
    'user.appearance': function (newValue: string, _oldValue: string) {
      if (!this.user) return
      void this.$vuetify.theme.change(resolveThemeName(newValue, siteConfig.darkMode))
    },
    'user.dateFormat': function (newValue: string, _oldValue: string) {
      if (!this.user) return
      if (newValue === '') {
        this.$moment.updateLocale(this.$moment.locale(), null)
      } else {
        const localeConfig = {
          longDateFormat: {
            L: newValue
          }
        } as moment.LocaleSpecification
        this.$moment.updateLocale(this.$moment.locale(), localeConfig)
      }
    },
    'user.timezone': function (newValue: string, _oldValue: string) {
      if (!this.user) return
      if (newValue === '') {
        this.$moment.tz.setDefault()
      } else {
        this.$moment.tz.setDefault(newValue)
      }
    }
  },
  mounted() {
    this.loadProfile()
  },
  methods: {
    async loadProfile (): Promise<boolean> {
      this.profileLoading = true
      this.profileError = ''
      wikiStore.startLoading('profile-refresh')
      try {
        this.user = await fetchProfile(window.fetch.bind(window))
        return true
      } catch (err) {
        this.user = null
        this.profileError = getErrorMessage(err)
        wikiStore.showError(err)
        return false
      } finally {
        this.profileLoading = false
        wikiStore.stopLoading('profile-refresh')
      }
    },
    /**
     * Focus an input after delay
     */
    focusField (ipt: ProfileFieldRef) {
      this.$nextTick(() => {
        _.delay(() => {
          focusComponent(this.$refs[ipt])
        }, 200)
      })
    },
    /**
     * Save User Profile
     */
    async saveProfile () {
      const profile = this.user
      if (!profile || this.saveLoading) return
      this.saveLoading = true
      wikiStore.startLoading('profile-save')

      try {
        const token = await updateProfile(window.fetch.bind(window), {
          name: profile.name,
          location: profile.location,
          jobTitle: profile.jobTitle,
          timezone: profile.timezone,
          dateFormat: profile.dateFormat,
          appearance: profile.appearance
        })
        Cookies.set('jwt', token, { expires: 365, secure: window.location.protocol === 'https:' })
        wikiStore.user.name = profile.name
        wikiStore.user.appearance = profile.appearance
        wikiStore.showNotification({
          message: this.$t('profile:save.success'),
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('profile-save')
        this.saveLoading = false
      }
    },
    /**
     * Change Password
     */
    async changePassword () {
      if (this.changePassLoading) return
      this.passwordErrors = {
        current: [],
        password: [],
        verifyPassword: []
      }
      const validation = validateValues({
        current: this.currentPass,
        password: this.newPass,
        verifyPassword: this.verifyPass
      }, {
        current: {
          presence: {
            message: this.$t('auth:missingPassword'),
            allowEmpty: false
          },
          length: {
            minimum: 6,
            tooShort: this.$t('auth:passwordTooShort')
          }
        },
        password: {
          presence: {
            message: this.$t('auth:missingPassword'),
            allowEmpty: false
          },
          length: {
            minimum: 6,
            tooShort: this.$t('auth:passwordTooShort')
          }
        },
        verifyPassword: {
          equality: {
            attribute: 'password',
            message: this.$t('auth:passwordNotMatch')
          }
        }
      }, { fullMessages: false })

      if (validation) {
        this.passwordErrors = {
          current: validation.current ?? [],
          password: validation.password ?? [],
          verifyPassword: validation.verifyPassword ?? []
        }
        if (validation.current) {
          wikiStore.showNotification({
            style: 'red',
            message: validation.current[0],
            icon: 'warning'
          })
          focusComponent(this.$refs.iptCurrentPass)
        } else if (validation.password) {
          wikiStore.showNotification({
            style: 'red',
            message: validation.password[0],
            icon: 'warning'
          })
          focusComponent(this.$refs.iptNewPass)
        } else if (validation.verifyPassword) {
          wikiStore.showNotification({
            style: 'red',
            message: validation.verifyPassword[0],
            icon: 'warning'
          })
          focusComponent(this.$refs.iptVerifyPass)
        }
      } else {
        this.changePassLoading = true
        wikiStore.startLoading('profile-changepassword')

        try {
          const token = await changeProfilePassword(
            window.fetch.bind(window),
            this.currentPass,
            this.newPass
          )
          this.currentPass = ''
          this.newPass = ''
          this.verifyPass = ''
          Cookies.set('jwt', token, { expires: 365, secure: window.location.protocol === 'https:' })
          wikiStore.showNotification({
            message: this.$t('profile:auth.changePassSuccess'),
            style: 'success',
            icon: 'check'
          })
        } catch (err) {
          wikiStore.showError(err)
        } finally {
          wikiStore.stopLoading('profile-changepassword')
          this.changePassLoading = false
        }
      }
    }
  }
}
</script>

<style lang='scss'>
.profile-auth-provider {
  border: 1px solid color-mix(in srgb, var(--wiki-ambient-accent) 24%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  background:
    linear-gradient(110deg, color-mix(in srgb, var(--wiki-ambient-accent) 9%, transparent), transparent 60%),
    color-mix(in srgb, var(--wiki-surface-raised) 92%, transparent);
  color: rgb(var(--v-theme-on-surface));
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);

  .v-toolbar__content {
    gap: var(--wiki-space-3);
    padding-inline: var(--wiki-space-3);
  }

  &__mark {
    display: grid;
    width: calc(var(--wiki-control-height) - var(--wiki-space-2));
    height: calc(var(--wiki-control-height) - var(--wiki-space-2));
    flex: 0 0 auto;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--wiki-ambient-accent) 24%, var(--wiki-surface-border));
    border-radius: var(--wiki-control-radius);
    background: color-mix(in srgb, var(--wiki-ambient-accent) 10%, transparent);
    color: var(--wiki-accent-warm);
    box-shadow: var(--wiki-shadow-inset);
  }

  &__name {
    min-width: 0;
  }
}
</style>
