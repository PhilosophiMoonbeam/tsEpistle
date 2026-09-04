<template lang='pug'>
  v-container(fluid)
    v-row(v-if='userLoadState !== `ready`')
      v-col(cols='12')
        v-alert(v-if='userLoadState === `loading`', type='info', variant='tonal', role='status') Loading user details...
        v-alert(v-else, type='error', variant='tonal', role='alert')
          span Unable to load this user.
          v-btn.ml-2(variant="text", @click='loadUser') Retry
        v-skeleton-loader.mt-3(v-if='userLoadState === `loading`', type='article')
    v-row(v-if='recordReady')
      v-col(cols='12')
        AdminHero(
          :title='$t(`admin:users.edit`)'
          :description='user.name'
          icon='/_assets/svg/icon-male-user.svg'
          heading-id='admin-users-edit-heading'
        )
          template(v-slot:extra)
            .text-body-small.text-orange(v-if='hasUnsavedChanges') Unsaved changes — saved with Update User
          template(v-slot:status)
            i18next.pr-4.text-body-small.text-grey(path='admin:users.id', tag='div')
              strong(place='id') {{user.id}}
            template(v-if='user.isActive')
              status-indicator.mr-3(positive, pulse)
              .text-body-small.text-green {{$t('admin:users.active')}}
            template(v-else)
              status-indicator.mr-3(negative, pulse)
              .text-body-small.text-red {{$t('admin:users.inactive')}}
            template(v-if='user.isVerified')
              status-indicator.mr-3.ml-4(active, pulse)
              .text-body-small.text-blue {{$t('admin:users.verified')}}
            template(v-else)
              status-indicator.mr-3.ml-4(intermediary, pulse)
              .text-body-small.text-deep-orange {{$t('admin:users.unverified')}}
          template(v-slot:actions)
            v-btn(color='grey' icon variant="outlined" @click='navigateBack' aria-label='Back to users')
              v-icon mdi-arrow-left
            v-menu(location='bottom end')
              template(v-slot:activator='{ props }')
                v-btn(color='primary' v-bind='props' variant="tonal" :disabled='!recordReady || actionLoading !== ``')
                  span Actions
                  v-icon(end) mdi-chevron-down
              v-list(density="compact" nav)
                v-list-item(v-if='!user.isActive' @click='activateUser' :disabled='actionLoading !== ``')
                  template(v-slot:prepend)
                    v-icon(color='primary') mdi-account-key
                  v-list-item-title Activate
                v-list-item(v-else @click='deactivateUser' :disabled='user.id === currentUserId || user.isSystem || actionLoading !== ``')
                  template(v-slot:prepend)
                    v-icon(color='primary') mdi-account-cancel
                  v-list-item-title Deactivate
                v-list-item(@click='verifyUser' :disabled='user.isVerified || actionLoading !== ``')
                  template(v-slot:prepend)
                    v-icon(color='info') mdi-account-check
                  v-list-item-title Set as Verified
                v-list-item(@click='deleteUserConfirm' :disabled='user.id === currentUserId || user.isSystem || actionLoading !== ``')
                  template(v-slot:prepend)
                    v-icon(color='error') mdi-trash-can-outline
                  v-list-item-title Delete
            v-btn(color='primary' size="large" variant="flat" @click='updateUser' :disabled='!hasUnsavedChanges || actionLoading !== ``' :loading='actionLoading === `update`')
              v-icon(start) mdi-check
              span {{$t('admin:users.updateUser')}}
      v-col(cols='12', lg='6')
        v-card.animated.fadeInUp
          v-toolbar(color='primary', density="compact", flat)
            v-icon.mr-2 mdi-information-variant
            span {{$t('admin:users.basicInfo')}}
          v-list.py-0(lines="two", density="compact")
            v-list-item
              template(v-slot:prepend)
                v-avatar(size='32')
                  v-icon mdi-email-variant
              v-list-item-title {{$t('admin:users.email')}}
              v-list-item-subtitle {{ user.email }}
              template(v-slot:append, v-if='!user.isSystem && user.providerKey === `local`')
                v-menu(
                  v-model='editPop.email'
                  :close-on-content-click='false'
                  width='350'
                  max-width='calc(100vw - 32px)'
                  )
                  template(v-slot:activator='{ props }')
                    v-btn(icon, color='grey', size="x-small", v-bind='props', @click='focusField(`iptEmail`)', :disabled='actionLoading !== ``', aria-label='Edit email')
                      v-icon mdi-pencil
                  v-card
                    v-text-field(
                      ref='iptEmail'
                      v-model='user.email'
                      type='email'
                      autocomplete='email'
                      :label='$t(`admin:users.email`)'
                      variant="solo"
                      hide-details
                      :disabled='actionLoading !== ``'
                      append-icon='mdi-check'
                      @click:append='editPop.email = false'
                      @keydown.enter='editPop.email = false'
                      @keydown.esc='editPop.email = false'
                    )

            v-divider
            v-list-item
              template(v-slot:prepend)
                v-avatar(size='32')
                  v-icon mdi-account
              v-list-item-title {{$t('admin:users.displayName')}}
              v-list-item-subtitle {{ user.name }}
              template(v-slot:append)
                v-menu(
                  v-model='editPop.name'
                  :close-on-content-click='false'
                  width='350'
                  max-width='calc(100vw - 32px)'
                  )
                  template(v-slot:activator='{ props }')
                    v-btn(icon, color='grey', size="x-small", v-bind='props', @click='focusField(`iptDisplayName`)', :disabled='actionLoading !== ``', aria-label='Edit display name')
                      v-icon mdi-pencil
                  v-card
                    v-text-field(
                      ref='iptDisplayName'
                      v-model='user.name'
                      :label='$t(`admin:users.displayName`)'
                      variant="solo"
                      hide-details
                      :disabled='actionLoading !== ``'
                      append-icon='mdi-check'
                      @click:append='editPop.name = false'
                      @keydown.enter='editPop.name = false'
                      @keydown.esc='editPop.name = false'
                    )

        v-card.mt-3.animated.fadeInUp.wait-p2s(v-if='!user.isSystem')
          v-toolbar(color='primary', density="compact", flat)
            v-icon.mr-2 mdi-lock-outline
            span {{$t('admin:users.authentication')}}
          v-list.py-0(lines="two", density="compact")
            v-list-item
              template(v-slot:prepend)
                v-avatar(size='32')
                  v-icon mdi-domain
              v-list-item-title {{$t('admin:users.authProvider')}}
              v-list-item-subtitle {{ user.providerName }} #[em.text-body-small ({{ user.providerKey }})]
            template(v-if='user.providerKey === `local`')
              v-divider
              v-list-item
                template(v-slot:prepend)
                  v-avatar(size='32')
                    v-icon mdi-form-textbox-password
                v-list-item-title {{$t('admin:users.password')}}
                v-list-item-subtitle &bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;
                template(v-slot:append)
                  v-menu(
                    v-model='editPop.newPassword'
                    :close-on-content-click='false'
                    width='350'
                    max-width='calc(100vw - 32px)'
                    )
                    template(v-slot:activator='{ props: menuProps }')
                      v-tooltip(location="top")
                        template(v-slot:activator='{ props: tooltipProps }')
                          v-btn(icon, color='grey', size="x-small", v-bind='mergeActivatorProps(menuProps, tooltipProps)', @click='focusField(`iptNewPassword`)', :disabled='actionLoading !== ``', aria-label='Change password')
                            v-icon mdi-pencil
                        span {{$t('admin:users.changePassword')}}
                    v-card
                      v-text-field(
                        ref='iptNewPassword'
                        v-model='newPassword'
                        :label='$t(`admin:users.newPassword`)'
                        variant="solo"
                        hide-details
                        :disabled='actionLoading !== ``'
                        append-icon='mdi-check'
                        type='password'
                        autocomplete='new-password'
                        @click:append='editPop.newPassword = false'
                        @keydown.enter='editPop.newPassword = false'
                        @keydown.esc='editPop.newPassword = false'
                      )
                  v-tooltip(location="top")
                    template(v-slot:activator='{ props }')
                      v-btn(
                        icon
                        color='grey'
                        size='x-small'
                        v-bind='props'
                        :loading='actionLoading === `welcomeEmail`'
                        :disabled='actionLoading !== ``'
                        aria-label='Send Welcome Email'
                        @click='sendWelcomeEmail'
                        )
                        v-icon mdi-email
                    span Send Welcome Email
            template(v-if='user.providerIs2FACapable')
              v-divider
              v-list-item
                template(v-slot:prepend)
                  v-avatar(size='32')
                    v-icon mdi-two-factor-authentication
                v-list-item-title {{$t('admin:users.tfa')}}
                v-list-item-subtitle.text-green(v-if='user.tfaIsActive') Active
                v-list-item-subtitle.text-red(v-else) Inactive
                template(v-slot:append)
                  v-tooltip(location="top")
                    template(v-slot:activator='{ props }')
                      v-btn(icon, color='grey', size="x-small", v-bind='props', @click='toggle2FA', :disabled='actionLoading !== ``', :loading='actionLoading === `toggle2fa`', aria-label='Toggle two-factor authentication')
                        v-icon mdi-power
                    span {{$t('admin:users.toggle2FA')}}
            template(v-if='user.providerId')
              v-divider
              v-list-item
                template(v-slot:prepend)
                  v-avatar(size='32')
                    v-icon mdi-music-accidental-sharp
                v-list-item-title {{$t('admin:users.authProviderId')}}
                v-list-item-subtitle {{ user.providerId }}
        v-card.mt-3.animated.fadeInUp.wait-p4s
          v-toolbar(color='primary', density="compact", flat)
            v-icon.mr-2 mdi-account-group
            span {{$t('admin:users.groups')}}
          v-list(density="compact")
            template(v-for='(group, idx) in user.groups', :key='`group-` + group.id')
              v-list-item
                template(v-slot:prepend)
                  v-avatar(size='32')
                    v-icon mdi-account-group-outline
                v-list-item-title {{group.name}}
                template(v-slot:append, v-if='!user.isSystem')
                  v-btn(icon, color='red', size="x-small", @click='unassignGroup(group.id)', :disabled='actionLoading !== ``', :aria-label='`Remove from ${group.name}`')
                    v-icon mdi-close
              v-divider(v-if='idx < user.groups.length - 1')
          v-alert.mx-3(v-if='user.groups.length < 1', variant="outlined", color="grey-darken-1", icon='mdi-alert')
            .text-body-small {{$t('admin:users.noGroupAssigned')}}
          v-card-chin(v-if='!user.isSystem')
            v-spacer
            v-select(
              :items='groups'
              v-model='newGroup'
              :label='$t(`admin:users.selectGroup`)'
              item-value='id'
              item-title='name'
              :item-props='group => ({ disabled: group.isSystem })'
              variant="solo"
              flat
              hide-details
              style='max-width: 300px;'
              density="compact"
            )
            v-btn.ml-2.px-4(variant="flat", color='primary', @click='assignGroup', :disabled='newGroup <= 0 || actionLoading !== ``')
              v-icon(start) mdi-clipboard-account-outline
              span {{$t('admin:users.groupAssign')}}
          .text-body-small.text-orange.px-4.pb-2 Membership changes are staged until you select Update User.
          v-system-bar(window, color="surface-variant")
            v-spacer
            .text-body-small {{$t('admin:users.groupAssignNotice')}}

      v-col(cols='12', lg='6')
        v-card.animated.fadeInUp.wait-p2s
          v-toolbar(color='primary', density="compact", flat)
            v-icon.mr-2 mdi-account-badge-outline
            span {{$t('admin:users.extendedMetadata')}}
          v-list.py-0(lines="two", density="compact")
            v-list-item
              template(v-slot:prepend)
                v-avatar(size='32')
                  v-icon mdi-map-marker
              v-list-item-title {{$t('admin:users.location')}}
              v-list-item-subtitle {{ user.location }}
              template(v-slot:append)
                v-menu(
                  v-model='editPop.location'
                  :close-on-content-click='false'
                  width='350'
                  max-width='calc(100vw - 32px)'
                  )
                  template(v-slot:activator='{ props }')
                    v-btn(icon, color='grey', size="x-small", v-bind='props', @click='focusField(`iptLocation`)', :disabled='actionLoading !== ``', aria-label='Edit location')
                      v-icon mdi-pencil
                  v-card
                    v-text-field(
                      ref='iptLocation'
                      v-model='user.location'
                      :label='$t(`admin:users.location`)'
                      variant="solo"
                      hide-details
                      :disabled='actionLoading !== ``'
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
              v-list-item-title {{$t('admin:users.jobTitle')}}
              v-list-item-subtitle {{ user.jobTitle }}
              template(v-slot:append)
                v-menu(
                  v-model='editPop.jobTitle'
                  :close-on-content-click='false'
                  width='350'
                  max-width='calc(100vw - 32px)'
                  )
                  template(v-slot:activator='{ props }')
                    v-btn(icon, color='grey', size="x-small", v-bind='props', @click='focusField(`iptJobTitle`)', :disabled='actionLoading !== ``', aria-label='Edit job title')
                      v-icon mdi-pencil
                  v-card
                    v-text-field(
                      ref='iptJobTitle'
                      v-model='user.jobTitle'
                      :label='$t(`admin:users.jobTitle`)'
                      variant="solo"
                      hide-details
                      :disabled='actionLoading !== ``'
                      append-icon='mdi-check'
                      @click:append='editPop.jobTitle = false'
                      @keydown.enter='editPop.jobTitle = false'
                      @keydown.esc='editPop.jobTitle = false'
                    )
            v-divider
            v-list-item
              template(v-slot:prepend)
                v-avatar(size='32')
                  v-icon mdi-map-clock-outline
              v-list-item-title {{$t('admin:users.timezone')}}
              v-list-item-subtitle {{ user.timezone }}
              template(v-slot:append)
                v-menu(
                  v-model='editPop.timezone'
                  :close-on-content-click='false'
                  width='350'
                  max-width='calc(100vw - 32px)'
                  )
                  template(v-slot:activator='{ props }')
                    v-btn(icon, color='grey', size="x-small", v-bind='props', @click='focusField(`iptTimezone`)', :disabled='actionLoading !== ``', aria-label='Edit timezone')
                      v-icon mdi-pencil
                  v-card
                    v-select(
                      ref='iptTimezone'
                      :items='timezones'
                      v-model='user.timezone'
                      :label='$t(`admin:users.timezone`)'
                      variant="solo"
                      density="compact"
                      hide-details
                      :disabled='actionLoading !== ``'
                      append-icon='mdi-check'
                      @click:append='editPop.timezone = false'
                      @keydown.enter='editPop.timezone = false'
                      @keydown.esc='editPop.timezone = false'
                    )

        v-card.mt-3.animated.fadeInUp.wait-p4s
          v-toolbar(color='teal', density="compact", flat)
            v-toolbar-title
              .text-body-large {{$t('profile:activity.title')}}
          v-card-text.text-grey-darken-2
            .text-body-small.text-grey {{$t('profile:activity.joinedOn')}}
            .text-body-medium: strong {{ $helpers.formatMoment(user.createdAt, 'LLLL') }}
            .text-body-small.text-grey.mt-3 {{$t('profile:activity.lastUpdatedOn')}}
            .text-body-medium: strong {{ $helpers.formatMoment(user.updatedAt, 'LLLL') }}
            .text-body-small.text-grey.mt-3 {{$t('profile:activity.lastLoginOn')}}
            .text-body-medium: strong {{ $helpers.formatMoment(user.lastLoginAt, 'LLLL') }}
    v-dialog(v-model='deleteUserDialog', max-width='500', aria-label='Delete user')
      v-card
        .dialog-header.is-red {{$t('admin:users.deleteConfirmTitle')}}
        v-card-text.pt-5
          i18next(path='admin:users.deleteConfirmText', tag='span')
            strong(place='username') {{ user.email }}
          .mt-3 {{$t('admin:users.deleteConfirmReplaceWarn')}}
          v-divider.my-3
          .d-flex.align-center.mt-3
            v-btn.text-none(color='primary', variant="flat", @click='deleteSearchUserDialog = true', :disabled='actionLoading !== ``')
              v-icon(start) mdi-clipboard-account
              | Select User...
            .text-body-small.pl-3
              strong ID {{deleteReplaceUser.id}}
              .text-body-small {{deleteReplaceUser.name}}
              em {{deleteReplaceUser.email}}
        v-card-chin
          v-spacer
          v-btn(variant="text", @click='deleteUserDialog = false', :disabled='actionLoading !== ``') {{$t('common:actions.cancel')}}
          v-btn(color='red', @click='deleteUser', :disabled='actionLoading !== ``', :loading='actionLoading === `delete`') {{$t('common:actions.delete')}}

        user-search(v-model='deleteSearchUserDialog', @select='assignDeleteUser')
</template>
<script lang='ts'>
import { markRaw, mergeProps } from 'vue'
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'
import StatusIndicator from '@/components/common/status-indicator.vue'

import UserSearch from '../common/user-search.vue'

import { fetchGroupOptions, type GroupOption } from '../../helpers/groups-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import {
  deleteAdminUser,
  fetchUserDetails,
  setAdminUserActive,
  sendAdminUserWelcomeEmail,
  setAdminUserTfa,
  updateAdminUser,
  verifyAdminUser,
  type AdminUserDetail,
  type UserGroup,
  type UserSearchRow
} from '../../helpers/users-api'

type EditableAdminUser = Omit<AdminUserDetail, 'createdAt' | 'updatedAt'> & {
  createdAt: string | null
  updatedAt: string | null
}

type UserEditorFieldRef = 'iptEmail' | 'iptDisplayName' | 'iptNewPassword' | 'iptLocation' | 'iptJobTitle' | 'iptTimezone'

type FocusableRef = {
  focus: () => void
}

const getRouteUserId = (routeId: string | string[]): string => Array.isArray(routeId) ? routeId[0] || '' : routeId

const createEmptyUser = (): EditableAdminUser => ({
  id: 0,
  email: '',
  name: '',
  location: '',
  jobTitle: '',
  timezone: '',
  groups: [] as UserGroup[],
  isActive: false,
  isVerified: false,
  providerKey: '',
  providerName: '',
  providerId: null,
  providerIs2FACapable: false,
  isSystem: false,
  createdAt: null,
  updatedAt: null,
  lastLoginAt: null,
  tfaIsActive: false
})

const TIMEZONES = Object.freeze([
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
  { title: '(GMT+09:00) Tokyo', value: 'Asia/Tokyo' },
  { title: '(GMT+09:30) Central Time - Darwin', value: 'Australia/Darwin' },
  { title: '(GMT+10:00) Dumont D\'Urville', value: 'Antarctica/DumontDUrville' },
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

export default {
  i18nOptions: {
    namespaces: ['admin', 'profile']
  },
  components: {
    StatusIndicator,
    UserSearch
  },
  data () {
    return {
      userLoadRequestId: 0,
      groupsLoadRequestId: 0,
      userLoadState: 'loading' as 'loading' | 'ready' | 'error',
      actionLoading: '',
      userSnapshot: '',
      deleteUserDialog: false,
      deleteSearchUserDialog: false,
      deleteReplaceUser: {
        id: 1,
        name: '',
        email: ''
      },
      editPop: {
        email: false,
        name: false,
        location: false,
        jobTitle: false,
        timezone: false,
        newPassword: false,
      },
      newGroup: 0,
      groups: [] as GroupOption[],
      newPassword: '',
      user: createEmptyUser(),
      timezones: TIMEZONES
    }
  },
  computed: {
    currentUserId(): number { return wikiStore.user.id },
    recordReady(): boolean { return this.userLoadState === 'ready' && this.user.id > 0 },
    hasUnsavedChanges(): boolean {
      return this.recordReady && this.userSnapshot !== JSON.stringify({
        email: this.user.email,
        name: this.user.name,
        newPassword: this.newPassword,
        groups: this.user.groups.map(group => group.id),
        location: this.user.location,
        jobTitle: this.user.jobTitle,
        timezone: this.user.timezone
      })
    }
  },
  watch: {
    '$route.params.id' () {
      this.resetUserEditorState()
      this.user = createEmptyUser()
      this.loadUser()
    }
  },
  methods: {
    isCurrentUserAction (requestId: number, userId: number): boolean {
      return requestId === this.userLoadRequestId && this.recordReady && this.user.id === userId
    },
    navigateBack () {
      if (this.hasUnsavedChanges && !window.confirm('Discard unsaved user changes?')) return
      this.$router.push('/users')
    },
    resetUserEditorState () {
      this.userLoadState = 'loading'
      this.userSnapshot = ''
      this.actionLoading = ''
      this.newPassword = ''
      this.newGroup = 0
      this.deleteUserDialog = false
      this.deleteSearchUserDialog = false
      this.deleteReplaceUser = {
        id: 1,
        name: '',
        email: ''
      }
      this.editPop = {
        email: false,
        name: false,
        location: false,
        jobTitle: false,
        timezone: false,
        newPassword: false,
      }
    },
    async loadUser () {
      const requestId = ++this.userLoadRequestId
      const routeUserId = getRouteUserId(this.$route.params.id)
      this.userLoadState = 'loading'

      wikiStore.startLoading('admin-users-refresh')
      try {
        const user = await fetchUserDetails(window.fetch.bind(window), routeUserId, 'User detail response is invalid')
        if (requestId !== this.userLoadRequestId || routeUserId !== getRouteUserId(this.$route.params.id)) return false
        this.user = user
        this.newPassword = ''
        this.userSnapshot = JSON.stringify({
          email: user.email,
          name: user.name,
          newPassword: '',
          groups: user.groups.map(group => group.id),
          location: user.location,
          jobTitle: user.jobTitle,
          timezone: user.timezone
        })
        this.userLoadState = user.id > 0 ? 'ready' : 'error'
        return this.userLoadState === 'ready'
      } catch (err) {
        if (requestId !== this.userLoadRequestId || routeUserId !== getRouteUserId(this.$route.params.id)) return false
        this.user = createEmptyUser()
        this.userLoadState = 'error'
        wikiStore.showError(err)
        return false
      } finally {
        wikiStore.stopLoading('admin-users-refresh')
      }
    },
    async loadGroups() {
      const requestId = ++this.groupsLoadRequestId
      wikiStore.startLoading('admin-groups-refresh')
      try {
        const groups = await fetchGroupOptions(window.fetch.bind(window), 'Groups response is invalid')
        if (requestId !== this.groupsLoadRequestId) return
        this.groups = markRaw(groups)
      } catch (err) {
        if (requestId !== this.groupsLoadRequestId) return
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      } finally {
        wikiStore.stopLoading('admin-groups-refresh')
      }
    },
    /**
     * Activate a user (if previously deactivated)
     */
    async activateUser () {
      if (!this.recordReady || this.actionLoading !== '') return
      this.actionLoading = 'activate'
      const requestId = this.userLoadRequestId
      const userId = this.user.id
      wikiStore.startLoading('admin-users-activate')
      try {
        await setAdminUserActive(window.fetch.bind(window), userId, true)
        if (!this.isCurrentUserAction(requestId, userId)) return
        wikiStore.showNotification({
          style: 'success',
          message: this.$t('admin:users.userActivateSuccess'),
          icon: 'check'
        })
        this.user.isActive = true
      } catch (err) {
        if (!this.isCurrentUserAction(requestId, userId)) return
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'warning'
        })
      } finally {
        wikiStore.stopLoading('admin-users-activate')
        if (this.isCurrentUserAction(requestId, userId)) this.actionLoading = ''
      }
    },
    /**
     * Deactivate a currently active user
     */
    async deactivateUser () {
      if (!this.recordReady || this.actionLoading !== '') return
      this.actionLoading = 'deactivate'
      const requestId = this.userLoadRequestId
      const userId = this.user.id
      wikiStore.startLoading('admin-users-deactivate')
      try {
        await setAdminUserActive(window.fetch.bind(window), userId, false)
        if (!this.isCurrentUserAction(requestId, userId)) return
        wikiStore.showNotification({
          style: 'success',
          message: this.$t('admin:users.userDeactivateSuccess'),
          icon: 'check'
        })
        this.user.isActive = false
      } catch (err) {
        if (!this.isCurrentUserAction(requestId, userId)) return
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'warning'
        })
      } finally {
        wikiStore.stopLoading('admin-users-deactivate')
        if (this.isCurrentUserAction(requestId, userId)) this.actionLoading = ''
      }
    },
    /**
     * Delete a user
     */
    deleteUserConfirm () {
      if (!this.recordReady || this.actionLoading !== '') return
      this.deleteReplaceUser = {
        id: this.currentUserId,
        name: wikiStore.user.name,
        email: wikiStore.user.email
      }
      this.deleteUserDialog = true
    },
    async deleteUser () {
      if (!this.recordReady || this.actionLoading !== '') return
      this.actionLoading = 'delete'
      const requestId = this.userLoadRequestId
      const userId = this.user.id
      wikiStore.startLoading('admin-users-delete')
      try {
        await deleteAdminUser(window.fetch.bind(window), userId, this.deleteReplaceUser.id)
        if (!this.isCurrentUserAction(requestId, userId)) return
        wikiStore.showNotification({
          style: 'success',
          message: this.$t('admin:users.userDeleteSuccess'),
          icon: 'check'
        })
        this.$router.push('/users')
      } catch (err) {
        if (!this.isCurrentUserAction(requestId, userId)) return
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'warning'
        })
      } finally {
        if (this.isCurrentUserAction(requestId, userId)) {
          this.deleteUserDialog = false
          this.actionLoading = ''
        }
        wikiStore.stopLoading('admin-users-delete')
      }
    },
    assignDeleteUser (selUsr: UserSearchRow) {
      if (this.actionLoading !== '') return
      if (selUsr.id === this.user.id) {
        wikiStore.showNotification({
          style: 'red',
          message: 'You cannot select the account you\'re about to delete!',
          icon: 'warning'
        })
      } else if (selUsr.id === 2) {
        wikiStore.showNotification({
          style: 'red',
          message: 'You cannot use the guest account for this operation.',
          icon: 'warning'
        })
      } else {
        this.deleteReplaceUser = selUsr
      }
    },
    /**
     * Update a user
     */
    async updateUser() {
      if (!this.recordReady || !this.hasUnsavedChanges || this.actionLoading !== '') return
      this.actionLoading = 'update'
      const requestId = this.userLoadRequestId
      const userId = this.user.id
      wikiStore.startLoading('admin-users-update')
      try {
        await updateAdminUser(window.fetch.bind(window), userId, {
          email: this.user.email,
          name: this.user.name,
          newPassword: this.newPassword,
          groups: this.user.groups.map(group => group.id),
          location: this.user.location,
          jobTitle: this.user.jobTitle,
          timezone: this.user.timezone
        })
        if (!this.isCurrentUserAction(requestId, userId)) return
        this.newPassword = ''
        wikiStore.showNotification({
          style: 'success',
          message: this.$t('admin:users.userUpdateSuccess'),
          icon: 'check'
        })
        this.$router.push('/users')
      } catch (err) {
        if (!this.isCurrentUserAction(requestId, userId)) return
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'warning'
        })
      } finally {
        wikiStore.stopLoading('admin-users-update')
        if (this.isCurrentUserAction(requestId, userId)) this.actionLoading = ''
      }
    },
    /**
     * Focus an input after delay
     */
    focusField (ipt: UserEditorFieldRef) {
      this.$nextTick(() => {
        _.delay(() => {
          ;(this.$refs[ipt] as FocusableRef | undefined)?.focus()
        }, 200)
      })
    },
    mergeActivatorProps(menuProps: Parameters<typeof mergeProps>[number], tooltipProps: Parameters<typeof mergeProps>[number]) {
      return mergeProps(menuProps, tooltipProps)
    },
    /**
     * Assign group to user
     */
    assignGroup() {
      if (!this.recordReady || this.newGroup <= 0 || this.actionLoading !== '') return
      if (_.some(this.user.groups, ['id', this.newGroup])) {
        wikiStore.showNotification({
          message: this.$t('admin:users.userAlreadyAssignedToGroup'),
          style: 'error',
          icon: 'alert'
        })
      } else {
        const group = this.groups.find(group => group.id === this.newGroup)
        if (group) {
          this.user.groups.push(group)
        }
        this.newGroup = 0
      }
    },
    /**
     * Unassign group from user
     */
    unassignGroup(gid: number) {
      if (!this.recordReady || gid <= 0 || this.actionLoading !== '') return
      this.user.groups = this.user.groups.filter(group => group.id !== gid)
    },
    /**
     * Manually set user as verified
     */
    async verifyUser () {
      if (!this.recordReady || this.actionLoading !== '') return
      this.actionLoading = 'verify'
      const requestId = this.userLoadRequestId
      const userId = this.user.id
      wikiStore.startLoading('admin-users-verify')
      try {
        await verifyAdminUser(window.fetch.bind(window), userId)
        if (!this.isCurrentUserAction(requestId, userId)) return
        wikiStore.showNotification({
          style: 'success',
          message: this.$t('admin:users.userVerifySuccess'),
          icon: 'check'
        })
        this.user.isVerified = true
      } catch (err) {
        if (!this.isCurrentUserAction(requestId, userId)) return
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'warning'
        })
      } finally {
        wikiStore.stopLoading('admin-users-verify')
        if (this.isCurrentUserAction(requestId, userId)) this.actionLoading = ''
      }
    },
    /**
     * Send or resend the account invitation without changing the user.
     */
    async sendWelcomeEmail () {
      if (!this.recordReady || this.actionLoading !== '') return
      this.actionLoading = 'welcomeEmail'
      const requestId = this.userLoadRequestId
      const userId = this.user.id
      try {
        await sendAdminUserWelcomeEmail(window.fetch.bind(window), userId)
        if (!this.isCurrentUserAction(requestId, userId)) return
        wikiStore.showNotification({
          style: 'success',
          message: 'Welcome email sent successfully.',
          icon: 'email-check'
        })
      } catch (err) {
        if (!this.isCurrentUserAction(requestId, userId)) return
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'email-alert'
        })
      } finally {
        if (this.isCurrentUserAction(requestId, userId)) this.actionLoading = ''
      }
    },
    /**
     * Toggle 2FA State
     */
    async toggle2FA () {
      if (!this.recordReady || this.actionLoading !== '') return
      this.actionLoading = 'toggle2fa'
      const requestId = this.userLoadRequestId
      const userId = this.user.id
      wikiStore.startLoading('admin-users-toggle2fa')
      const enabled = !this.user.tfaIsActive
      try {
        await setAdminUserTfa(window.fetch.bind(window), userId, enabled)
        if (!this.isCurrentUserAction(requestId, userId)) return
        wikiStore.showNotification({
          style: 'success',
          message: this.$t(enabled ? 'admin:users.userTFAEnableSuccess' : 'admin:users.userTFADisableSuccess'),
          icon: 'check'
        })
        this.user.tfaIsActive = enabled
      } catch (err) {
        if (!this.isCurrentUserAction(requestId, userId)) return
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'warning'
        })
      } finally {
        wikiStore.stopLoading('admin-users-toggle2fa')
        if (this.isCurrentUserAction(requestId, userId)) this.actionLoading = ''
      }
    }
  },
  created() {
    this.loadGroups()
    this.loadUser()
  },
  beforeUnmount() {
    this.groupsLoadRequestId++
    this.userLoadRequestId++
  }
}
</script>

<style lang='scss'>

</style>
