<template lang='pug'>
  v-container.profile-workspace(fluid)
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
      :retry-label='$t("common:page.tryAgain")'
      @retry='loadProfile'
    )
    template(v-else-if='user')
      admin-hero(
        :title='$t("profile:title")'
        :description='$t("profile:subtitle")'
        :eyebrow='$t("profile:hero.eyebrow", { defaultValue: "Account" })'
        icon='mdi-account-circle-outline'
        heading-id='profile-title'
      )
        template(#extra)
          .profile-identity
            v-avatar(v-if='picture.kind === `initials`', size='40', color='primary')
              span.text-title-small.text-on-primary.font-weight-bold {{ picture.initials }}
            v-avatar(v-else, size='40')
              v-img(:src='picture.url', alt='')
            .profile-identity__copy
              strong {{ savedDraft ? savedDraft.name : user.name }}
              span {{ user.email }}

      .profile-layout
        .profile-column
          section.profile-section(aria-labelledby='profile-info-title')
            header.profile-section__header
              h2#profile-info-title.profile-section__title {{ $t('profile:myInfo') }}
              p.profile-section__hint {{ $t('profile:myInfoHint', { defaultValue: 'Shown to other people on pages, mentions and Discussion.' }) }}
            .profile-section__body.profile-fields
              .profile-field(@keydown.esc.capture='revertField(`name`, $event)')
                v-text-field(
                  ref='field-name'
                  v-model='user.name'
                  :label='$t(`profile:displayName`)'
                  :error-messages='issueMessage(`name`)'
                  :readonly='saving'
                  hide-details='auto'
                  variant='outlined'
                  density='comfortable'
                  autocomplete='name'
                  maxlength='255'
                  prepend-inner-icon='mdi-account-outline'
                )
              .profile-field(@keydown.esc.capture='revertField(`handle`, $event)')
                v-text-field(
                  ref='field-handle'
                  v-model='user.handle'
                  :label='$t(`profile:mentionHandle`, { defaultValue: `Mention handle` })'
                  :hint='$t(`profile:mentionHandleHint`, { defaultValue: `3–32 lowercase letters, numbers, underscores or hyphens. Leave blank to disable mentions.` })'
                  :error-messages='issueMessage(`handle`)'
                  :readonly='saving'
                  persistent-hint
                  prefix='@'
                  maxlength='32'
                  autocomplete='off'
                  spellcheck='false'
                  variant='outlined'
                  density='comfortable'
                )
              .profile-field(@keydown.esc.capture='revertField(`location`, $event)')
                v-text-field(
                  v-model='user.location'
                  :label='$t(`profile:location`)'
                  :readonly='saving'
                  variant='outlined'
                  density='comfortable'
                  hide-details='auto'
                  prepend-inner-icon='mdi-map-marker-outline'
                )
              .profile-field(@keydown.esc.capture='revertField(`jobTitle`, $event)')
                v-text-field(
                  v-model='user.jobTitle'
                  :label='$t(`profile:jobTitle`)'
                  :readonly='saving'
                  variant='outlined'
                  density='comfortable'
                  hide-details='auto'
                  autocomplete='organization-title'
                  prepend-inner-icon='mdi-briefcase-outline'
                )

          section.profile-section(aria-labelledby='profile-preferences-title')
            header.profile-section__header
              h2#profile-preferences-title.profile-section__title {{ $t('profile:preferences') }}
              p.profile-section__hint {{ $t('profile:preferencesHint', { defaultValue: 'Changes preview at once. Save to keep them.' }) }}
            .profile-section__body.profile-fields
              .profile-field.profile-field--wide(@keydown.esc.capture='revertField(`timezone`, $event)')
                v-autocomplete(
                  v-model='user.timezone'
                  v-model:menu='openMenus.timezone'
                  :items='timezoneItems'
                  :label='$t(`profile:timezone`)'
                  :hint='$t(`profile:timezoneHint`, { defaultValue: `Type a city or region to filter.` })'
                  :no-data-text='$t(`profile:timezoneNoMatch`, { defaultValue: `No matching time zone` })'
                  :readonly='saving'
                  persistent-hint
                  auto-select-first
                  variant='outlined'
                  density='comfortable'
                  prepend-inner-icon='mdi-map-clock-outline'
                )
              .profile-field(@keydown.esc.capture='revertField(`dateFormat`, $event)')
                v-select(
                  v-model='user.dateFormat'
                  v-model:menu='openMenus.dateFormat'
                  :items='dateFormats'
                  :label='$t(`profile:dateFormat`)'
                  :readonly='saving'
                  variant='outlined'
                  density='comfortable'
                  hide-details
                  prepend-inner-icon='mdi-calendar-month-outline'
                )
              .profile-field(@keydown.esc.capture='revertField(`timeFormat`, $event)')
                v-select(
                  v-model='user.timeFormat'
                  v-model:menu='openMenus.timeFormat'
                  :items='timeFormats'
                  :label='$t(`profile:timeFormat`, { defaultValue: `Time format` })'
                  :readonly='saving'
                  variant='outlined'
                  density='comfortable'
                  hide-details
                  prepend-inner-icon='mdi-clock-time-four-outline'
                )
              .profile-field(@keydown.esc.capture='revertField(`appearance`, $event)')
                v-select(
                  v-model='user.appearance'
                  v-model:menu='openMenus.appearance'
                  :items='appearances'
                  :label='$t(`profile:appearance`)'
                  :readonly='saving'
                  variant='outlined'
                  density='comfortable'
                  hide-details
                  prepend-inner-icon='mdi-palette-outline'
                )

          section.profile-section(aria-labelledby='profile-reading-title')
            header.profile-section__header
              h2#profile-reading-title.profile-section__title {{ $t('profile:readingPreferences', { defaultValue: 'Reading preferences' }) }}
              p.profile-section__hint {{ $t('profile:readingPreferencesHint', { defaultValue: 'Apply to articles after you save.' }) }}
            .profile-section__body
              .profile-toggle-row(@keydown.esc.capture='revertField(`reduceMotion`, $event)')
                v-switch(
                  v-model='user.reduceMotion'
                  :label='$t(`profile:reduceMotion`, { defaultValue: `Reduce motion` })'
                  :hint='$t(`profile:reduceMotionHint`, { defaultValue: `Reduce decorative motion; device accessibility settings are always respected.` })'
                  :readonly='saving'
                  persistent-hint
                  color='primary'
                  inset
                )
              v-divider
              .profile-toggle-row(@keydown.esc.capture='revertField(`underlineLinks`, $event)')
                v-switch(
                  v-model='user.underlineLinks'
                  :label='$t(`profile:underlineLinks`, { defaultValue: `Underline article links` })'
                  :hint='$t(`profile:underlineLinksHint`, { defaultValue: `Keep article links underlined for easier recognition.` })'
                  :readonly='saving'
                  persistent-hint
                  color='primary'
                  inset
                )
              v-divider
              .profile-fields.profile-fields--spaced
                .profile-field(@keydown.esc.capture='revertField(`contentTextSize`, $event)')
                  v-select(
                    v-model='user.contentTextSize'
                    v-model:menu='openMenus.contentTextSize'
                    :items='contentTextSizes'
                    :label='$t(`profile:contentTextSize`, { defaultValue: `Article text size` })'
                    :hint='$t(`profile:contentTextSizeHint`, { defaultValue: `Change prose size without scaling application controls or code.` })'
                    :readonly='saving'
                    persistent-hint
                    variant='outlined'
                    density='comfortable'
                  )
                .profile-field(@keydown.esc.capture='revertField(`communicationLocale`, $event)')
                  v-select(
                    v-model='communicationLocaleSelection'
                    v-model:menu='openMenus.communicationLocale'
                    :items='communicationLocaleOptions'
                    :label='$t(`profile:communicationLocale`, { defaultValue: `Communication language` })'
                    :hint='$t(`profile:communicationLocaleHint`, { defaultValue: `Choose an installed language for account messages, or use the site language.` })'
                    :readonly='saving'
                    persistent-hint
                    variant='outlined'
                    density='comfortable'
                  )

        .profile-column
          section.profile-section(aria-labelledby='profile-avatar-title')
            header.profile-section__header
              h2#profile-avatar-title.profile-section__title {{ $t('profile:avatar.title', { defaultValue: 'Profile avatar' }) }}
              p.profile-section__hint {{ $t('profile:avatar.saveHint', { defaultValue: 'Avatar changes save at once.' }) }}
            .profile-section__body
              .profile-avatar-editor
                .profile-avatar-preview
                  v-avatar(v-if='picture.kind === `initials`', size='88', color='primary')
                    span.text-headline-medium.text-on-primary.font-weight-bold {{ picture.initials }}
                  v-avatar(v-else, size='88')
                    v-img(:src='picture.url', alt='')
                .profile-avatar-actions
                  input.profile-avatar-input(
                    ref='avatarInput'
                    type='file'
                    accept='image/jpeg,image/png,image/webp'
                    tabindex='-1'
                    aria-hidden='true'
                    :disabled='avatarLoading'
                    @change='handleAvatarSelected'
                  )
                  .profile-avatar-buttons
                    v-btn(
                      ref='avatarUploadButton'
                      type='button'
                      variant='outlined'
                      color='primary'
                      :loading='avatarAction === `upload`'
                      :disabled='avatarLoading'
                      :aria-busy='avatarLoading'
                      :aria-label='$t(`profile:avatar.upload`, { defaultValue: `Upload avatar` })'
                      @click='openAvatarPicker'
                    )
                      v-icon(start) mdi-upload
                      span {{$t('profile:avatar.upload', { defaultValue: 'Upload avatar' })}}
                    v-btn(
                      v-if='hasInternalAvatar'
                      type='button'
                      variant='text'
                      color='error'
                      :loading='avatarAction === `remove`'
                      :disabled='avatarLoading'
                      :aria-busy='avatarLoading'
                      :aria-label='$t(`profile:avatar.remove`, { defaultValue: `Remove avatar` })'
                      @click='removeAvatar'
                    )
                      v-icon(start) mdi-delete-outline
                      span {{$t('profile:avatar.remove', { defaultValue: 'Remove avatar' })}}
                  p.profile-muted.text-body-small {{ $t('profile:avatar.help', { defaultValue: 'PNG, JPEG, or WebP up to 1 MB. Provider avatars return after the next sign-in when removed.' }) }}
                  v-alert(
                    v-if='avatarError'
                    type='error'
                    variant='tonal'
                    density='compact'
                    role='alert'
                  ) {{ avatarError }}
                  v-alert(
                    v-if='avatarSuccess'
                    type='success'
                    variant='tonal'
                    density='compact'
                    role='status'
                  ) {{ avatarSuccess }}

          section.profile-section(aria-labelledby='profile-auth-title')
            header.profile-section__header
              h2#profile-auth-title.profile-section__title {{ $t('profile:auth.title') }}
            .profile-section__body
              .profile-auth-provider
                .profile-auth-provider__mark
                  v-icon(aria-hidden='true') mdi-shield-lock-outline
                .profile-auth-provider__copy
                  span.profile-muted.text-label-large {{ $t('profile:auth.provider') }}
                  span.profile-auth-provider__name.text-body-large {{ user.providerName }}
              form#change-password-form.profile-password-form(
                v-if='user.providerKey === `local`'
                @submit.prevent='changePassword'
                :aria-busy='changePassLoading'
                aria-labelledby='profile-password-title'
              )
                h3#profile-password-title.profile-subsection-title {{ $t('profile:auth.changePassword') }}
                p.profile-muted.text-body-small {{ $t('profile:auth.changePasswordHint', { defaultValue: 'Saved on its own. Other profile changes are not affected.' }) }}
                v-alert.mb-3(
                  v-if='passwordErrorSummary'
                  type='error'
                  variant='tonal'
                  role='alert'
                ) {{ passwordErrorSummary }}
                v-text-field(
                  ref='iptCurrentPass'
                  v-model='currentPass'
                  variant='outlined'
                  density='comfortable'
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
                      :aria-label='passwordToggleLabel(hideCurrentPass, $t(`profile:auth.currentPassword`))'
                      :disabled='changePassLoading'
                      @click='hideCurrentPass = !hideCurrentPass'
                    )
                      v-icon(aria-hidden='true') {{ hideCurrentPass ? 'mdi-eye-outline' : 'mdi-eye-off-outline' }}
                v-text-field(
                  ref='iptNewPass'
                  v-model='newPass'
                  variant='outlined'
                  density='comfortable'
                  :label='$t(`profile:auth.newPassword`)'
                  :type='hideNewPass ? "password" : "text"'
                  :error-messages='passwordErrors.password'
                  :hint='passwordHint'
                  persistent-hint
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
                      :aria-label='passwordToggleLabel(hideNewPass, $t(`profile:auth.newPassword`))'
                      :disabled='changePassLoading'
                      @click='hideNewPass = !hideNewPass'
                    )
                      v-icon(aria-hidden='true') {{ hideNewPass ? 'mdi-eye-outline' : 'mdi-eye-off-outline' }}
                v-text-field(
                  ref='iptVerifyPass'
                  v-model='verifyPass'
                  variant='outlined'
                  density='comfortable'
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
                      :aria-label='passwordToggleLabel(hideVerifyPass, $t(`profile:auth.verifyPassword`))'
                      :disabled='changePassLoading'
                      @click='hideVerifyPass = !hideVerifyPass'
                    )
                      v-icon(aria-hidden='true') {{ hideVerifyPass ? 'mdi-eye-outline' : 'mdi-eye-off-outline' }}
                .profile-password-form__actions
                  v-btn(
                    color='primary'
                    variant='flat'
                    type='submit'
                    :loading='changePassLoading'
                    :disabled='changePassLoading'
                    prepend-icon='mdi-lock-reset'
                  ) {{ $t('profile:auth.changePassword') }}

          section.profile-section(aria-labelledby='profile-groups-title')
            header.profile-section__header
              h2#profile-groups-title.profile-section__title {{ $t('profile:groups.title') }}
            .profile-section__body
              ul.profile-groups(v-if='user.groups.length')
                li(v-for='grp of user.groups', :key='`grp-id-` + grp')
                  v-chip(label, variant='tonal', size='small', prepend-icon='mdi-account-group-outline') {{ grp }}
              p.profile-muted.text-body-medium(v-else) {{ $t('profile:groups.empty', { defaultValue: 'No groups assigned' }) }}

          section.profile-section(aria-labelledby='profile-activity-title')
            header.profile-section__header
              h2#profile-activity-title.profile-section__title {{ $t('profile:activity.title') }}
            dl.profile-section__body.profile-activity
              div
                dt {{ $t('profile:activity.joinedOn') }}
                dd {{ $helpers.formatMoment(user.createdAt, 'LLLL') }}
              div
                dt {{ $t('profile:activity.lastUpdatedOn') }}
                dd {{ $helpers.formatMoment(user.updatedAt, 'LLLL') }}
              div
                dt {{ $t('profile:activity.lastLoginOn') }}
                dd {{ $helpers.formatMoment(user.lastLoginAt, 'LLLL') }}
              div
                dt {{ $t('profile:activity.pagesCreated') }}
                dd {{ user.pagesTotal }}

      .profile-save-dock(
        role='region'
        :aria-label='$t("profile:dock.label", { defaultValue: "Profile changes" })'
        :class='{ "profile-save-dock--dirty": dirty }'
      )
        p.profile-save-dock__copy(role='status' aria-live='polite' aria-atomic='true')
          v-icon(size='18' aria-hidden='true') {{ dirty ? 'mdi-circle-edit-outline' : 'mdi-check-circle-outline' }}
          span#profile-save-state {{ dockMessage }}
        .profile-save-dock__actions
          v-btn(
            v-if='dirty'
            variant='text'
            :disabled='saving'
            prepend-icon='mdi-undo-variant'
            @click='resetDraft'
          ) {{ $t('profile:dock.reset', { defaultValue: 'Reset' }) }}
          v-btn.profile-save-dock__save(
            color='primary'
            variant='flat'
            prepend-icon='mdi-check'
            :loading='saving'
            :aria-disabled='canSave ? undefined : "true"'
            aria-describedby='profile-save-state'
            :class='{ "profile-save-dock__save--inactive": !canSave }'
            @click='saveDraft'
          ) {{ $t('profile:dock.save', { defaultValue: 'Save changes' }) }}

    v-dialog(
      v-model='discardOpen'
      max-width='440'
      aria-labelledby='profile-discard-title'
    )
      v-card.profile-discard-dialog
        v-card-title#profile-discard-title(tag='h2') {{ $t('profile:discard.title', { defaultValue: 'Discard unsaved changes?' }) }}
        v-card-text {{ discardMessage }}
        v-card-actions
          v-spacer
          v-btn(variant='text' @click='cancelDiscard') {{ $t('profile:discard.keep', { defaultValue: 'Keep editing' }) }}
          v-btn(color='error' variant='flat' @click='confirmDiscard') {{ $t('profile:discard.confirm', { defaultValue: 'Discard changes' }) }}
</template>

<script lang='ts'>
import { passwordPolicyMixin } from '../../helpers/password-policy.ts'
import { newPasswordIssue } from '../../../shared/security-policy.ts'
import AsyncState from '@/components/common/async-state.vue'
import PasswordStrength from '../common/password-strength.vue'
import { wikiStore } from '@/store/index.ts'
import {
  changeProfilePassword,
  fetchProfile,
  removeProfileAvatar,
  updateProfile,
  updateProfilePreferences,
  uploadProfileAvatar,
  type Profile
} from '../../helpers/users-api.ts'
import { fetchLocales, type LocaleRow } from '../../helpers/locales-api.ts'
import validateValues from '../../../shared/validation'
import { resolveThemeName } from '../../helpers/theme.ts'
import { applyUserPresentation } from '../../helpers/index.ts'
import { getErrorMessage } from '../../helpers/root-ui-store.ts'
import {
  changedProfileFields,
  PROFILE_DETAIL_FIELDS,
  PROFILE_PREFERENCE_FIELDS,
  profileDraftIssues,
  restoreProfileDraft,
  restoreProfileField,
  snapshotProfileDraft,
  timezoneOptions,
  type ProfileDraft,
  type ProfileDraftField,
  type ProfileDraftIssue,
  type TimezoneOption
} from './profile-draft.ts'
import type { RouteLocationNormalized } from 'vue-router'

type MenuField = 'timezone' | 'dateFormat' | 'timeFormat' | 'appearance' | 'contentTextSize' | 'communicationLocale'

function focusComponent (ref: unknown): void {
  if (!ref || typeof ref !== 'object') return
  const candidate = ref as { focus?: unknown }
  if (typeof candidate.focus === 'function') candidate.focus()
}

/* global siteConfig */

export default {
  mixins: [passwordPolicyMixin],
  i18nOptions: {
    namespaces: ['profile', 'auth']
  },
  components: {
    AsyncState,
    PasswordStrength
  },
  beforeRouteLeave (to: RouteLocationNormalized): boolean {
    return this.canLeave(to)
  },
  data() {
    return {
      saving: false,
      changePassLoading: false,
      profileLoading: true,
      profileError: '',
      user: null as Profile | null,
      savedDraft: null as ProfileDraft | null,
      installedCommunicationLocales: [] as LocaleRow[],
      avatarAction: '' as '' | 'upload' | 'remove',
      avatarError: '',
      avatarSuccess: '',
      avatarRevision: 0,
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
      openMenus: {
        timezone: false,
        dateFormat: false,
        timeFormat: false,
        appearance: false,
        contentTextSize: false,
        communicationLocale: false
      } as Record<MenuField, boolean>,
      discardOpen: false,
      pendingLeave: '' as string,
      allowLeave: false
    }
  },
  computed: {
    picture () {
      const profilePictureUrl = this.user?.pictureUrl
      const pictureUrl = this.user !== null && (typeof profilePictureUrl === 'string' || profilePictureUrl === null)
        ? profilePictureUrl || ''
        : typeof wikiStore.user.pictureUrl === 'string' ? wikiStore.user.pictureUrl : ''
      const userId = this.user?.id || wikiStore.user.id
      if (pictureUrl.length > 1) {
        return {
          kind: 'image' as const,
          url: (pictureUrl === 'internal') ? `/_userav/${userId}?v=${this.avatarRevision}` : pictureUrl
        }
      }
      const label = this.savedDraft?.name || this.user?.email || wikiStore.user.name || wikiStore.user.email || 'User'
      const parts = label.trim().split(/\s+/)
      const initials = ((parts[0]?.charAt(0) || 'U') + (parts.length > 1 ? parts[parts.length - 1]?.charAt(0) || '' : '')).toUpperCase()
      return { kind: 'initials' as const, initials }
    },
    hasInternalAvatar () {
      return this.user !== null ? this.user.pictureUrl === 'internal' : wikiStore.user.pictureUrl === 'internal'
    },
    avatarLoading () {
      return this.avatarAction !== ''
    },
    changedFields (): ProfileDraftField[] {
      return this.user && this.savedDraft ? changedProfileFields(this.savedDraft, this.user) : []
    },
    dirty (): boolean {
      return this.changedFields.length > 0
    },
    draftIssues (): Partial<Record<'name' | 'handle', ProfileDraftIssue>> {
      return this.user ? profileDraftIssues(this.user) : {}
    },
    issueCount (): number {
      return Object.keys(this.draftIssues).length
    },
    canSave (): boolean {
      return this.dirty && this.issueCount === 0 && !this.saving
    },
    dockMessage (): string {
      if (this.saving) return this.$t('profile:dock.saving', { defaultValue: 'Saving changes…' })
      if (!this.dirty) return this.$t('profile:dock.clean', { defaultValue: 'No unsaved changes' })
      if (this.issueCount > 0) {
        return this.issueCount === 1
          ? this.$t('profile:dock.fixOne', { defaultValue: 'Fix 1 field before saving' })
          : this.$t('profile:dock.fixMany', { defaultValue: 'Fix {{count}} fields before saving', count: this.issueCount })
      }
      const count = this.changedFields.length
      return count === 1
        ? this.$t('profile:dock.unsavedOne', { defaultValue: '1 unsaved change' })
        : this.$t('profile:dock.unsavedMany', { defaultValue: '{{count}} unsaved changes', count })
    },
    discardMessage (): string {
      const count = this.changedFields.length
      return count === 1
        ? this.$t('profile:discard.messageOne', { defaultValue: 'You have 1 unsaved change. Theme and date previews return to your saved settings.' })
        : this.$t('profile:discard.messageMany', { defaultValue: 'You have {{count}} unsaved changes. Theme and date previews return to your saved settings.', count })
    },
    passwordErrorSummary () {
      return this.passwordErrors.current[0] || this.passwordErrors.password[0] || this.passwordErrors.verifyPassword[0] || ''
    },
    timezoneItems (): TimezoneOption[] {
      return timezoneOptions(this.savedDraft?.timezone ?? '')
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
    timeFormats () {
      return [
        { title: this.$t('profile:timeLocaleDefault', { defaultValue: 'Use locale default' }), value: 'locale' },
        { title: this.$t('profile:time12h', { defaultValue: '12-hour (AM/PM)' }), value: '12h' },
        { title: this.$t('profile:time24h', { defaultValue: '24-hour' }), value: '24h' }
      ]
    },
    contentTextSizes () {
      return [
        { title: this.$t('profile:contentTextSizeDefault', { defaultValue: 'Default' }), value: 'default' },
        { title: this.$t('profile:contentTextSizeLarge', { defaultValue: 'Large' }), value: 'large' },
        { title: this.$t('profile:contentTextSizeLarger', { defaultValue: 'Larger' }), value: 'larger' }
      ]
    },
    communicationLocaleOptions () {
      return [
        {
          title: this.$t('profile:communicationLocaleSiteDefault', { defaultValue: 'Site language ({{lang}})', lang: siteConfig.lang }),
          value: '__site_default__'
        },
        ...this.installedCommunicationLocales.map(locale => ({
          title: `${locale.nativeName} (${locale.code})`,
          value: locale.code
        }))
      ]
    },
    communicationLocaleSelection: {
      get (): string {
        return this.user?.communicationLocale ?? '__site_default__'
      },
      set (value: string) {
        if (this.user) this.user.communicationLocale = value === '__site_default__' ? null : value
      }
    },
    appearances () {
      return [
        { title: this.$t('profile:appearanceDefault'), value: '' },
        { title: this.$t('profile:appearanceSystem', { defaultValue: 'Match Device' }), value: 'system' },
        { title: this.$t('profile:appearanceLight'), value: 'light' },
        { title: this.$t('profile:appearanceDark'), value: 'dark' }
      ]
    }
  },
  watch: {
    // Theme and date/time changes preview at once; Reset, discard and unmount restore the saved values.
    'user.appearance': function (newValue: string) {
      if (!this.user) return
      void this.$vuetify.theme.change(resolveThemeName(newValue, siteConfig.darkMode))
    },
    'user.dateFormat': function () {
      if (!this.user) return
      applyUserPresentation(this.user)
    },
    'user.timeFormat': function () {
      if (!this.user) return
      applyUserPresentation(this.user)
    },
    'user.timezone': function () {
      if (!this.user) return
      applyUserPresentation(this.user)
    }
  },
  mounted() {
    window.addEventListener('beforeunload', this.beforeUnload)
    this.loadProfile()
  },
  beforeUnmount() {
    window.removeEventListener('beforeunload', this.beforeUnload)
    // Leaving with an unsaved preview must not keep the previewed theme or date format.
    if (this.dirty && this.savedDraft) this.applySavedPresentation(this.savedDraft)
  },
  methods: {
    async loadProfile (): Promise<boolean> {
      this.profileLoading = true
      this.profileError = ''
      wikiStore.startLoading('profile-refresh')
      try {
        const fetchImpl = window.fetch.bind(window)
        const [profile, locales] = await Promise.all([fetchProfile(fetchImpl), fetchLocales(fetchImpl).catch((): LocaleRow[] => [])])
        this.installedCommunicationLocales = locales.filter(locale => locale.isInstalled)
        this.savedDraft = snapshotProfileDraft(profile)
        this.user = profile
        if (wikiStore.user.id === profile.id) wikiStore.user.pictureUrl = profile.pictureUrl ?? ''
        applyUserPresentation(profile)
        return true
      } catch (err) {
        this.user = null
        this.savedDraft = null
        this.profileError = getErrorMessage(err)
        wikiStore.showError(err)
        return false
      } finally {
        this.profileLoading = false
        wikiStore.stopLoading('profile-refresh')
      }
    },
    issueMessage (field: 'name' | 'handle'): string[] {
      const issue = this.draftIssues[field]
      if (!issue) return []
      if (issue === 'nameRequired') return [this.$t('profile:issues.nameRequired', { defaultValue: 'Enter a display name.' })]
      if (issue === 'nameTooLong') return [this.$t('profile:issues.nameTooLong', { defaultValue: 'Use 255 characters or fewer.' })]
      return [this.$t('profile:issues.handleInvalid', { defaultValue: 'Use 3–32 letters, numbers, underscores or hyphens.' })]
    },
    passwordToggleLabel (hidden: boolean, field: string): string {
      const action = hidden
        ? this.$t('auth:showPassword', { defaultValue: 'Show password' })
        : this.$t('auth:hidePassword', { defaultValue: 'Hide password' })
      return `${action}: ${field}`
    },
    /**
     * Esc restores the saved value of the focused field. An open option list closes first.
     */
    revertField (field: ProfileDraftField, event: KeyboardEvent) {
      if (!this.user || !this.savedDraft || this.saving) return
      if (field in this.openMenus && this.openMenus[field as MenuField]) return
      if (restoreProfileField(this.user, this.savedDraft, field)) {
        event.preventDefault()
        event.stopPropagation()
      }
    },
    applySavedPresentation (saved: ProfileDraft) {
      void this.$vuetify.theme.change(resolveThemeName(saved.appearance, siteConfig.darkMode))
      applyUserPresentation(saved)
    },
    resetDraft () {
      if (!this.user || !this.savedDraft || this.saving) return
      restoreProfileDraft(this.user, this.savedDraft)
    },
    canLeave (to: RouteLocationNormalized): boolean {
      if (this.allowLeave || !this.dirty) return true
      if (this.saving) return false
      this.pendingLeave = to.fullPath
      this.discardOpen = true
      return false
    },
    cancelDiscard () {
      this.discardOpen = false
      this.pendingLeave = ''
    },
    confirmDiscard () {
      const target = this.pendingLeave
      this.discardOpen = false
      this.pendingLeave = ''
      this.resetDraft()
      if (!target) return
      this.allowLeave = true
      void Promise.resolve(this.$router.push(target)).finally(() => {
        this.allowLeave = false
      })
    },
    beforeUnload (event: BeforeUnloadEvent) {
      if (!this.dirty) return
      event.preventDefault()
      event.returnValue = ''
    },
    focusField (field: 'name' | 'handle') {
      this.$nextTick(() => focusComponent(this.$refs[`field-${field}`]))
    },
    openAvatarPicker () {
      if (this.avatarLoading) return
      const input = this.$refs.avatarInput as HTMLInputElement | undefined
      input?.click()
    },
    async handleAvatarSelected (event: Event) {
      const input = event.target as HTMLInputElement
      const file = input.files?.[0]
      input.value = ''
      if (!file || this.avatarLoading) return
      await this.uploadAvatar(file)
    },
    async uploadAvatar (file: File) {
      if (this.avatarLoading) return
      this.avatarAction = 'upload'
      this.avatarError = ''
      this.avatarSuccess = ''
      wikiStore.startLoading('profile-avatar')
      try {
        const result = await uploadProfileAvatar(window.fetch.bind(window), file)
        await wikiStore.refreshAuth()
        if (this.user) {
          this.user.pictureUrl = result.pictureUrl
          if (wikiStore.user.id === this.user.id) wikiStore.user.pictureUrl = result.pictureUrl ?? ''
        }
        this.avatarRevision += 1
        this.avatarSuccess = this.$t('profile:avatar.uploadSuccess', { defaultValue: 'Avatar uploaded successfully.' })
      } catch (err) {
        this.avatarError = getErrorMessage(err)
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('profile-avatar')
        this.avatarAction = ''
      }
    },
    async removeAvatar () {
      if (this.avatarLoading || !this.hasInternalAvatar) return
      this.avatarAction = 'remove'
      this.avatarError = ''
      this.avatarSuccess = ''
      wikiStore.startLoading('profile-avatar')
      try {
        const result = await removeProfileAvatar(window.fetch.bind(window))
        await wikiStore.refreshAuth()
        if (this.user) {
          this.user.pictureUrl = result.pictureUrl
          if (wikiStore.user.id === this.user.id) wikiStore.user.pictureUrl = result.pictureUrl ?? ''
        }
        this.avatarRevision += 1
        this.avatarSuccess = this.$t('profile:avatar.removeSuccess', { defaultValue: 'Avatar removed successfully.' })
      } catch (err) {
        this.avatarError = getErrorMessage(err)
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('profile-avatar')
        this.avatarAction = ''
      }
    },
    /**
     * Save every changed profile field from the dock. Details and reading preferences use
     * separate endpoints; a partial failure keeps only the unsaved part dirty.
     */
    async saveDraft () {
      const profile = this.user
      const saved = this.savedDraft
      if (!profile || !saved || this.saving || !this.dirty) return
      if (this.issueCount > 0) {
        this.focusField(this.draftIssues.name ? 'name' : 'handle')
        return
      }
      const draft = snapshotProfileDraft(profile)
      const detailsChanged = PROFILE_DETAIL_FIELDS.some(field => draft[field] !== saved[field])
      const preferencesChanged = PROFILE_PREFERENCE_FIELDS.some(field => draft[field] !== saved[field])
      let committed: ProfileDraft = { ...saved }
      this.saving = true
      wikiStore.startLoading('profile-save')
      try {
        const fetchImpl = window.fetch.bind(window)
        if (detailsChanged) {
          await updateProfile(fetchImpl, {
            name: draft.name,
            handle: draft.handle,
            location: draft.location,
            jobTitle: draft.jobTitle,
            timezone: draft.timezone,
            dateFormat: draft.dateFormat,
            timeFormat: draft.timeFormat,
            appearance: draft.appearance
          })
          // Match the server's normalization so the saved snapshot compares equal.
          const normalized = {
            name: draft.name.trim(),
            handle: draft.handle.trim().toLowerCase(),
            location: draft.location.trim(),
            jobTitle: draft.jobTitle.trim()
          }
          Object.assign(profile, normalized)
          committed = {
            ...committed,
            ...normalized,
            timezone: draft.timezone,
            dateFormat: draft.dateFormat,
            timeFormat: draft.timeFormat,
            appearance: draft.appearance
          }
          this.savedDraft = committed
        }
        if (preferencesChanged) {
          await updateProfilePreferences(fetchImpl, {
            reduceMotion: draft.reduceMotion,
            underlineLinks: draft.underlineLinks,
            contentTextSize: draft.contentTextSize,
            communicationLocale: draft.communicationLocale
          })
          committed = {
            ...committed,
            reduceMotion: draft.reduceMotion,
            underlineLinks: draft.underlineLinks,
            contentTextSize: draft.contentTextSize,
            communicationLocale: draft.communicationLocale
          }
          this.savedDraft = committed
        }
        await wikiStore.refreshAuth()
        if (detailsChanged) {
          wikiStore.user.name = profile.name
          wikiStore.user.appearance = profile.appearance
        }
        wikiStore.showNotification({
          message: this.$t('profile:save.success'),
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('profile-save')
        this.saving = false
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
            minimum: this.passwordMinimum,
            tooShort: this.passwordHint
          }
        },
        verifyPassword: {
          equality: {
            attribute: 'password',
            message: this.$t('auth:passwordNotMatch')
          }
        }
      }, { fullMessages: false })

      const passwordIssue = newPasswordIssue(this.newPass, this.passwordMinimum)
      if (passwordIssue) { this.passwordErrors.password = [passwordIssue]; return }
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
          await changeProfilePassword(
            window.fetch.bind(window),
            this.currentPass,
            this.newPass
          )
          this.currentPass = ''
          this.newPass = ''
          this.verifyPass = ''
          await wikiStore.refreshAuth()
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
.profile-workspace {
  --profile-radius: .65rem;
  padding-bottom: var(--wiki-space-6);
}

.profile-identity {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--wiki-space-3);

  &__copy {
    display: grid;
    min-width: 0;
    gap: .1rem;

    > strong {
      overflow: hidden;
      color: rgb(var(--v-theme-on-surface));
      font-size: .92rem;
      font-weight: 650;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    > span {
      overflow: hidden;
      color: var(--wiki-text-muted);
      font-size: .82rem;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
}

.profile-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
  align-items: start;
  gap: var(--wiki-space-5);
}

.profile-column {
  display: grid;
  min-width: 0;
  gap: var(--wiki-space-5);
}

.profile-section {
  min-width: 0;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--profile-radius);
  background: var(--wiki-surface-raised);

  &__header {
    padding: var(--wiki-space-4) var(--wiki-space-5) var(--wiki-space-3);
    border-bottom: 1px solid var(--wiki-surface-border);
  }

  &__title {
    margin: 0;
    color: rgb(var(--v-theme-on-surface));
    font-size: 1rem;
    font-weight: 680;
    letter-spacing: -.01em;
    line-height: 1.35;
  }

  &__hint {
    margin: var(--wiki-space-1) 0 0;
    color: var(--wiki-text-muted);
    font-size: .82rem;
    line-height: 1.5;
  }

  &__body {
    padding: var(--wiki-space-4) var(--wiki-space-5) var(--wiki-space-5);
  }
}

.profile-subsection-title {
  margin: var(--wiki-space-5) 0 var(--wiki-space-1);
  color: rgb(var(--v-theme-on-surface));
  font-size: .92rem;
  font-weight: 650;
}

.profile-muted {
  margin: 0;
  color: var(--wiki-text-muted);
}

.profile-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
  gap: var(--wiki-space-4);

  &--spaced {
    padding-top: var(--wiki-space-4);
  }
}

.profile-field {
  min-width: 0;

  // Long zone names stay readable instead of truncating in a half-width column.
  &--wide {
    grid-column: 1 / -1;
  }
}

.profile-toggle-row {
  padding-block: var(--wiki-space-2);

  .v-selection-control {
    justify-content: space-between;
    flex-direction: row-reverse;
    gap: var(--wiki-space-3);
  }

  .v-label {
    color: rgb(var(--v-theme-on-surface));
    font-size: .92rem;
    font-weight: 600;
    opacity: 1;
  }

  // The default off track is a faint tint; give it a visible edge (WCAG 1.4.11).
  .v-selection-control:not(.v-selection-control--dirty) .v-switch__track {
    background-color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 12%, var(--wiki-surface-raised));
    box-shadow: inset 0 0 0 1px var(--wiki-text-muted);
    opacity: 1;
  }

  .v-messages {
    color: var(--wiki-text-muted);
    opacity: 1;
  }
}

.profile-auth-provider {
  display: flex;
  align-items: center;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
  color: rgb(var(--v-theme-on-surface));

  &__mark {
    display: grid;
    width: calc(var(--wiki-control-height) - var(--wiki-space-2));
    height: calc(var(--wiki-control-height) - var(--wiki-space-2));
    flex: 0 0 auto;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--wiki-ambient-accent) 28%, transparent);
    border-radius: var(--wiki-control-radius);
    background: color-mix(in srgb, var(--wiki-ambient-accent) 11%, var(--wiki-surface-raised));
    color: var(--wiki-accent-ink);
  }

  &__copy {
    display: grid;
    min-width: 0;
  }

  &__name {
    overflow-wrap: anywhere;
  }
}

.profile-password-form {
  display: grid;
  gap: var(--wiki-space-2);

  > p {
    margin-bottom: var(--wiki-space-2);
  }

  &__actions {
    display: flex;
    justify-content: flex-end;
    padding-top: var(--wiki-space-2);
  }
}

.profile-avatar-editor {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--wiki-space-4);
}

.profile-avatar-preview {
  flex: 0 0 auto;
}

.profile-avatar-actions {
  display: flex;
  min-width: 0;
  flex: 1 1 14rem;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--wiki-space-2);
}

.profile-avatar-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
}

.profile-avatar-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.profile-groups {
  display: flex;
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.profile-activity {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
  gap: var(--wiki-space-4);
  margin: 0;

  dt {
    color: var(--wiki-text-muted);
    font-size: .78rem;
  }

  dd {
    margin: .15rem 0 0;
    color: rgb(var(--v-theme-on-surface));
    font-size: .92rem;
    font-weight: 600;
  }
}

.profile-save-dock {
  position: sticky;
  bottom: calc(var(--wiki-footer-height) + .75rem);
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: .75rem;
  margin-top: var(--wiki-space-6);
  padding: .8rem 1rem;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--profile-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-sm);

  // Pinned to the viewport only while there is something to save, so a clean
  // dock does not cover content on small screens.
  &:not(&--dirty) {
    position: static;
    box-shadow: none;
  }

  &--dirty {
    border-color: color-mix(in srgb, rgb(var(--v-theme-warning)) 55%, var(--wiki-surface-border));
    box-shadow: var(--wiki-shadow-md);
  }

  &__copy {
    display: flex;
    align-items: center;
    gap: .5rem;
    margin: 0;
    color: var(--wiki-text-muted);
    font-size: .85rem;
  }

  &--dirty &__copy {
    color: rgb(var(--v-theme-on-surface));
    font-weight: 600;
  }

  &__actions {
    display: flex;
    flex-wrap: wrap;
    gap: .5rem;
  }

  // Kept focusable so the status line stays reachable; the click is blocked in code.
  &__save--inactive {
    opacity: .62;
    cursor: not-allowed;
  }
}

@media (max-width: 1100px) {
  .profile-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 599px) {
  .profile-section {
    &__header {
      padding: var(--wiki-space-3) var(--wiki-space-4) var(--wiki-space-2);
    }

    &__body {
      padding: var(--wiki-space-3) var(--wiki-space-4) var(--wiki-space-4);
    }
  }

  .profile-save-dock {
    &__actions,
    &__actions .v-btn {
      flex: 1 1 auto;
    }
  }
}

@media (forced-colors: active) {
  .profile-section,
  .profile-save-dock,
  .profile-auth-provider,
  .profile-auth-provider__mark {
    border-color: CanvasText;
  }
}
</style>
