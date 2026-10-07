<template>
  <v-container fluid class="identity-workspace">
    <admin-hero
      icon="mdi-shield-account-outline"
      :title="
        selected
          ? selected.displayName || $t('admin:auth.newSignMethod')
          : $t('admin:auth.title')
      "
      :description="
        selected
          ? selected.description ||
            $t('admin:auth.configureHowIdentityProvider')
          : $t('admin:auth.manageSignMethodsHow')
      "
    >
      <template #actions
        ><v-btn
          v-if="selected"
          variant="text"
          prepend-icon="mdi-arrow-left"
          :disabled="busy"
          @click="selectProvider('')"
          >{{ $t('admin:auth.allProviders') }}</v-btn
        ><v-btn
          variant="text"
          prepend-icon="mdi-refresh"
          :disabled="busy"
          :loading="loading"
          @click="reload"
          >{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ $t('admin:auth.reloadSavedSignPolicy') }}</v-tooltip></v-btn
        ><v-btn v-if="dirty" variant="text" :disabled="busy" @click="reset"
          >{{ $t('admin:auth.resetDraft') }}</v-btn
        ><v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-check"
          :disabled="!dirty || locked"
          @click="review"
          >{{ $t('admin:auth.reviewChanges') }}</v-btn
        ></template
      >
    </admin-hero>
    <async-state
      v-if="!saved && loading"
      state="loading"
      :title="$t('admin:auth.loadingSignPolicy')"
    /><async-state
      v-else-if="!saved && loadError"
      state="error"
      :title="$t('admin:auth.authenticationUnavailable')"
      :message="loadError"
      :retry-label="$t('admin:auth.tryAgain')"
      @retry="load"
    />
    <template v-if="saved">
      <v-alert v-if="loadError" type="error" variant="tonal" class="mt-5"
        >{{ loadError
        }}<v-btn variant="text" @click="load">{{ $t('admin:auth.tryAgain') }}</v-btn></v-alert
      ><v-alert
        v-if="notice"
        id="identity-notice"
        tabindex="-1"
        :type="attention ? 'warning' : 'success'"
        variant="tonal"
        class="mt-5"
        >{{ notice }}</v-alert
      >
      <div class="identity-status">
        <span>{{
          dirty ? $t('admin:auth.unsavedPolicyDraft') : $t('admin:auth.showingSavedSignPolicy')
        }}</span
        ><span>{{ $t('admin:auth.enabledAccounts', { enabledCount, accountCount, interpolation: { escapeValue: false } }) }}</span>
      </div>
      <nav
        v-if="!selected"
        class="identity-tabs"
        :aria-label="$t('admin:auth.authenticationSections')"
      >
        <button
          v-for="item in sections"
          :key="item.key"
          type="button"
          :aria-current="section === item.key ? 'page' : undefined"
          :disabled="busy"
          @click="setSection(item.key)"
        >
          {{ item.title }}
        </button>
      </nav>
      <template v-if="!selected && section === 'providers'">
        <div class="identity-heading">
          <div>
            <span class="identity-kicker">{{ $t('admin:auth.identityAccess') }}</span>
            <h2>{{ $t('admin:auth.signMethods') }}</h2>
            <p>
              {{ $t('admin:auth.keepEverydayAccessSimple') }}
            </p>
          </div>
          <v-btn
            variant="outlined"
            prepend-icon="mdi-plus"
            :disabled="locked"
            @click="catalog = true"
            >{{ $t('admin:auth.addProvider') }}</v-btn
          >
        </div>
        <form class="identity-search" @submit.prevent>
          <v-text-field
            v-model="search"
            :label="$t('admin:auth.findProviderNamePurpose')"
            variant="outlined"
            prepend-inner-icon="mdi-magnify"
            hide-details
            clearable
          />
        </form>
        <ul v-if="filtered.length" class="identity-register">
          <li v-for="provider in filtered" :key="provider.key">
            <div class="identity-provider-icon">
              <v-icon
                :icon="
                  provider.key === 'local'
                    ? 'mdi-key-outline'
                    : 'mdi-shield-account-outline'
                "
              />
            </div>
            <div class="identity-provider-copy">
              <button type="button" @click="selectProvider(provider.key)">
                {{ provider.displayName || $t('admin:auth.untitledProvider') }}
              </button>
              <p>
                {{
                  provider.description ||
                  definition(provider.strategyKey)?.description ||
                  $t('admin:auth.providerDefinitionUnavailable')
                }}
              </p>
              <div class="identity-meta">
                <span>{{
                  definition(provider.strategyKey)?.title ||
                  provider.strategyKey
                }}</span
                ><span v-if="provider.key === 'local'">{{ $t('admin:auth.recoveryRoute') }}</span
                ><span>{{
                  provider.selfRegistration
                    ? $t('admin:auth.newAccountsAllowed')
                    : $t('admin:auth.existingAccountsOnly')
                }}</span>
              </div>
            </div>
            <div class="identity-provider-count">
              <strong>{{
                savedProvider(provider.key)?.accountCount ?? 0
              }}</strong
              ><span>{{ $t('admin:auth.accounts') }}</span>
            </div>
            <span
              class="identity-runtime"
              :class="'is-' + runtime(provider.key).state"
              >{{ statusTitle(runtime(provider.key).state) }}</span
            ><v-btn
              variant="text"
              icon="mdi-arrow-right"
              :aria-label="$t('admin:auth.configure', { displayName: provider.displayName, interpolation: { escapeValue: false } })"
              @click="selectProvider(provider.key)"
            />
          </li>
        </ul>
        <async-state
          v-else
          state="empty"
          :title="$t('admin:auth.noMatchingProviders')"
          :message="$t('admin:auth.tryAnotherNameClear')"
        />
        <div class="identity-boundary">
          <v-icon icon="mdi-information-outline" size="19" />
          <p>
            {{ $t('admin:auth.initializationConfirmsSignMethod') }}
          </p>
          <v-btn
            variant="text"
            :disabled="dirty || locked"
            :loading="initializing"
            @click="initialize"
            >{{ $t('admin:auth.retryInitialization') }}</v-btn
          >
        </div>
      </template>
      <template v-else-if="!selected && section === 'order'">
        <div class="identity-heading">
          <div>
            <span class="identity-kicker">{{ $t('admin:auth.arrivalExperience') }}</span>
            <h2>{{ $t('admin:auth.loginOrder') }}</h2>
            <p>
              {{ $t('admin:auth.putMethodMostPeople') }}
            </p>
          </div>
        </div>
        <div class="identity-order-layout">
          <ol class="identity-order-list">
            <li v-for="(provider, index) in drafts" :key="provider.key">
              <span class="identity-order-number">{{ index + 1 }}</span>
              <div>
                <strong>{{ provider.displayName }}</strong
                ><small>{{
                  provider.isEnabled
                    ? $t('admin:auth.shownSignPage')
                    : $t('admin:auth.disabledHiddenSign')
                }}</small>
              </div>
              <v-btn
                icon="mdi-arrow-up"
                size="small"
                variant="text"
                :aria-label="$t('admin:auth.moveUp', { displayName: provider.displayName, interpolation: { escapeValue: false } })"
                :disabled="locked || index === 0"
                @click="move(index, -1)"
              /><v-btn
                icon="mdi-arrow-down"
                size="small"
                variant="text"
                :aria-label="$t('admin:auth.moveDown', { displayName: provider.displayName, interpolation: { escapeValue: false } })"
                :disabled="locked || index === drafts.length - 1"
                @click="move(index, 1)"
              />
            </li>
          </ol>
          <aside class="identity-preview">
            <span class="identity-kicker">{{ $t('admin:auth.signChoicesPreview') }}</span>
            <h3>{{ $t('admin:auth.welcomeBack') }}</h3>
            <p>{{ $t('admin:auth.chooseHowSign') }}</p>
            <div
              v-for="provider in drafts.filter((p) => p.isEnabled)"
              :key="provider.key"
              class="identity-preview-choice"
            >
              <v-icon
                :icon="
                  provider.key === 'local'
                    ? 'mdi-key-outline'
                    : 'mdi-shield-account-outline'
                "
                size="19"
              />{{ provider.displayName }}
            </div>
            <small
              >{{ $t('admin:auth.previewEnabledMethodsTheir') }}</small
            >
          </aside>
        </div>
      </template>
      <template v-else-if="!selected && section === 'activity'">
        <div class="identity-heading">
          <div>
            <span class="identity-kicker">{{ $t('admin:auth.administrativeRecord') }}</span>
            <h2>{{ $t('admin:auth.policyActivity') }}</h2>
            <p>
              {{ $t('admin:auth.latest50ReviewedChanges') }}
            </p>
          </div>
        </div>
        <async-state
          v-if="!saved.history.length"
          state="empty"
          :title="$t('admin:auth.noRecordedPolicyChanges')"
          :message="$t('admin:auth.reviewedSavesWillAppear')"
        />
        <ol v-else class="identity-activity">
          <li v-for="event in saved.history" :key="event.id">
            <div>
              <strong>{{ event.reason }}</strong
              ><time>{{ date(event.createdAt) }}</time>
            </div>
            <p>
              {{
                event.actorId
                  ? $t('admin:auth.account', { actorId: event.actorId, interpolation: { escapeValue: false } })
                  : $t('admin:auth.apiAdministrator')
              }}
            </p>
            <ul>
              <li v-for="change in event.changes" :key="change.key">
                {{ change.name }} · {{ change.action
                }}<span v-if="change.fields.length">
                  ·
                  {{
                    change.fields
                      .map((field) => fieldTitle(change.key, field))
                      .join(', ')
                  }}</span
                ><span v-if="change.sessionsEnded">
                  {{ $t('admin:auth.accountSessionsEnded', { sessionsEnded: change.sessionsEnded, interpolation: { escapeValue: false } }) }}</span
                >
              </li>
            </ul>
          </li>
        </ol>
      </template>
      <template v-else-if="selected">
        <nav class="identity-tabs" :aria-label="$t('admin:auth.providerSettings')">
          <button
            v-for="item in providerSections"
            :key="item.key"
            type="button"
            :aria-current="providerSection === item.key ? 'page' : undefined"
            :disabled="busy"
            @click="setProviderSection(item.key)"
          >
            {{ item.title }}
          </button>
        </nav>
        <div class="identity-provider-layout">
          <section class="identity-editor">
            <template v-if="providerSection === 'connection'">
              <div class="identity-heading">
                <div>
                  <span class="identity-kicker">{{
                    selectedDefinition?.title || selected.strategyKey
                  }}</span>
                  <h2>{{ $t('admin:auth.connection') }}</h2>
                  <p>
                    {{
                      selectedDefinition?.description ||
                      $t('admin:auth.providerDefinitionUnavailableStored')
                    }}
                  </p>
                </div>
              </div>
              <div class="identity-fields">
                <v-text-field
                  v-model="selected.displayName"
                  :label="$t('admin:auth.signDisplayName')"
                  maxlength="255"
                  variant="outlined"
                  :disabled="locked"
                /><v-textarea
                  v-model="selected.description"
                  :label="$t('admin:auth.purpose')"
                  maxlength="1000"
                  rows="2"
                  auto-grow
                  variant="outlined"
                  :disabled="locked"
                  :hint="$t('admin:auth.helpAdministratorsUnderstandWho')"
                  persistent-hint
                /><v-switch
                  v-model="selected.isEnabled"
                  :label="$t('admin:auth.enableSignMethod')"
                  color="primary"
                  inset
                  :disabled="
                    locked ||
                    selected.key === 'local' ||
                    !selectedDefinition?.available
                  "
                  :hint="
                    selected.key === 'local'
                      ? $t('admin:auth.localSignStaysEnabled')
                      : $t('admin:auth.enableAfterConfiguringConnection')
                  "
                  persistent-hint
                />
              </div>
              <template v-for="group in connectionGroups" :key="group.key"
                ><section
                  v-if="group.fields.length"
                  class="identity-field-group"
                >
                  <button
                    v-if="group.key === 'advanced'"
                    class="identity-disclosure"
                    type="button"
                    :aria-expanded="advanced"
                    @click="advanced = !advanced"
                  >
                    <span
                      ><strong>{{ $t('admin:auth.advancedProtocolSettings') }}</strong
                      ><small
                        >{{ $t('admin:auth.signingTransportAssertionsProvider') }}</small
                      ></span
                    ><v-icon
                      :icon="advanced ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                    />
                  </button>
                  <div v-else class="identity-field-group-heading">
                    <h3>{{ group.title }}</h3>
                    <p>{{ group.description }}</p>
                  </div>
                  <auth-fields
                    v-if="group.key !== 'advanced' || advanced"
                    :model-value="selected"
                    :fields="group.fields"
                    :configured-secrets="
                      savedProvider(selected.key)?.configuredSecrets ?? []
                    "
                    :disabled="locked"
                    @update:model-value="updateProvider"
                  /></section
              ></template>
            </template>
            <template v-else-if="providerSection === 'enrollment'">
              <div class="identity-heading">
                <div>
                  <span class="identity-kicker"
                    >{{ $t('admin:auth.whoJoinsWhatAccess') }}</span
                  >
                  <h2>{{ $t('admin:auth.accountEnrollment') }}</h2>
                  <p>
                    {{ $t('admin:auth.theseSettingsGovernNew') }}
                  </p>
                </div>
              </div>
              <v-switch
                v-model="selected.selfRegistration"
                :label="$t('admin:auth.allowNewAccountsThrough')"
                color="primary"
                inset
                :disabled="locked"
                :hint="
                  selected.key === 'local'
                    ? $t('admin:auth.peopleMayRegisterLocal')
                    : $t('admin:auth.successfulProviderSignMay')
                "
                persistent-hint
              />
              <div
                v-if="selected.selfRegistration"
                class="identity-fields mt-6"
              >
                <v-combobox
                  v-model="selected.domainWhitelist"
                  :label="$t('admin:auth.allowedEmailDomains')"
                  variant="outlined"
                  multiple
                  chips
                  closable-chips
                  :disabled="locked"
                  :hint="$t('admin:auth.exactDomainsSuchExample')"
                  persistent-hint
                /><v-autocomplete
                  v-model="selected.autoEnrollGroups"
                  :items="enrollmentGroups"
                  item-title="name"
                  item-value="id"
                  :label="$t('admin:auth.initialGroups')"
                  variant="outlined"
                  multiple
                  chips
                  closable-chips
                  :disabled="locked"
                  :hint="$t('admin:auth.newAccountsReceiveThese')"
                  persistent-hint
                />
                <p class="identity-note">
                  {{
                    selected.autoEnrollGroups.length
                      ? $t('admin:auth.reviewPermissionsEachSelected')
                      : $t('admin:auth.newAccountsWillStart')
                  }}
                </p>
              </div>
              <div
                v-if="
                  selectedDefinition?.fields.some(
                    (field) => field.key === 'mapGroups'
                  )
                "
                class="identity-mapping"
              >
                <h3>{{ $t('admin:auth.directoryGroupMapping') }}</h3>
                <v-switch
                  v-model="selected.config.mapGroups"
                  :label="$t('admin:auth.synchronizeGroupsIdentityProvider')"
                  color="primary"
                  inset
                  :disabled="locked"
                />
                <p class="identity-note">
                  {{ $t('admin:auth.whenGroupClaimPresent') }}
                </p>
                <auth-fields
                  v-if="selected.config.mapGroups"
                  :model-value="selected"
                  :fields="mappingFields"
                  :configured-secrets="
                    savedProvider(selected.key)?.configuredSecrets ?? []
                  "
                  :disabled="locked"
                  @update:model-value="updateProvider"
                />
              </div>
            </template>
            <template v-else>
              <div class="identity-heading">
                <div>
                  <span class="identity-kicker"
                    >{{ $t('admin:auth.connectIdentityService') }}</span
                  >
                  <h2>{{ $t('admin:auth.integrationDetails') }}</h2>
                  <p>
                    {{ $t('admin:auth.useConfiguredPublicWorkspace') }}
                  </p>
                </div>
              </div>
              <dl class="identity-integration">
                <div>
                  <dt>{{ $t('admin:auth.workspaceOrigin') }}</dt>
                  <dd>
                    {{ origin || $t('admin:auth.setPublicWorkspaceUrl') }}
                  </dd>
                </div>
                <div v-if="!selectedDefinition?.useForm">
                  <dt>{{ $t('admin:auth.callbackUrl2') }}</dt>
                  <dd>
                    {{
                      origin
                        ? origin + '/login/' + selected.key + '/callback'
                        : $t('admin:auth.workspaceUrlRequired')
                    }}
                  </dd>
                </div>
                <div>
                  <dt>{{ $t('admin:auth.signPage') }}</dt>
                  <dd>
                    {{ origin ? origin + '/login' : $t('admin:auth.workspaceUrlRequired') }}
                  </dd>
                </div>
                <div>
                  <dt>{{ $t('admin:auth.providerIdentifier') }}</dt>
                  <dd>{{ selected.key }}</dd>
                </div>
              </dl>
              <p class="identity-note">
                {{
                  selectedDefinition?.useForm
                    ? $t('admin:auth.providerUsesSignForm')
                    : $t('admin:auth.allowExactCallbackIdentity')
                }}
              </p>
              <v-btn
                v-if="selectedDefinition?.website"
                class="mt-5"
                :href="selectedDefinition.website"
                target="_blank"
                rel="noopener noreferrer"
                variant="outlined"
                append-icon="mdi-open-in-new"
                >{{ $t('admin:auth.providerReference') }}</v-btn
              ><v-btn class="mt-5 ml-2" to="/general" variant="text"
                >{{ $t('admin:auth.workspaceUrlSettings') }}</v-btn
              >
            </template>
          </section>
          <aside class="identity-aside">
            <div class="identity-panel">
              <span class="identity-kicker">{{ $t('admin:auth.savedProvider') }}</span>
              <h3>{{ statusTitle(runtime(selected.key).state) }}</h3>
              <p class="identity-note">
                {{
                  savedProvider(selected.key)
                    ? $t('admin:auth.initializationReflectsApplicationsLast')
                    : $t('admin:auth.newProviderExistsOnly')
                }}
              </p>
              <dl class="identity-facts">
                <div>
                  <dt>{{ $t('admin:auth.accounts2') }}</dt>
                  <dd>{{ savedProvider(selected.key)?.accountCount ?? 0 }}</dd>
                </div>
                <div>
                  <dt>{{ $t('admin:auth.activeAccounts') }}</dt>
                  <dd>
                    {{ savedProvider(selected.key)?.activeAccountCount ?? 0 }}
                  </dd>
                </div>
                <div>
                  <dt>{{ $t('admin:auth.lastInitialization') }}</dt>
                  <dd>
                    {{
                      runtime(selected.key).checkedAt
                        ? date(runtime(selected.key).checkedAt!)
                        : $t('admin:auth.notObserved')
                    }}
                  </dd>
                </div>
              </dl>
              <v-btn
                variant="text"
                :disabled="dirty || locked"
                :loading="initializing"
                @click="initialize"
                >{{ $t('admin:auth.retryInitialization') }}</v-btn
              >
            </div>
            <div v-if="selected.key !== 'local'" class="identity-panel">
              <h3>{{ $t('admin:auth.retireConnection') }}</h3>
              <p class="identity-note">
                {{
                  savedProvider(selected.key)?.accountCount
                    ? $t('admin:auth.providerHasAccountsDisable')
                    : $t('admin:auth.removalStagedPolicyDraft')
                }}
              </p>
              <v-btn
                class="mt-4"
                color="error"
                variant="outlined"
                :disabled="
                  locked || Boolean(savedProvider(selected.key)?.accountCount)
                "
                @click="removeProvider"
                >{{ $t('admin:auth.removeProvider') }}</v-btn
              >
            </div>
          </aside>
        </div>
      </template>
    </template>
    <v-dialog
      v-model="catalog"
      max-width="820"
      :fullscreen="$vuetify.display.smAndDown"
      aria-labelledby="identity-catalog-title"
      ><v-card class="identity-dialog"
        ><div class="identity-dialog-heading">
          <h2 id="identity-catalog-title">{{ $t('admin:auth.addSignProvider') }}</h2>
          <p>{{ $t('admin:auth.chooseConnectionConfigureThen') }}</p>
        </div>
        <v-card-text
          ><v-text-field
            v-model="catalogSearch"
            :label="$t('admin:auth.searchProviderCatalog')"
            variant="outlined"
            prepend-inner-icon="mdi-magnify"
            clearable /><async-state
            v-if="!catalogItems.length"
            state="empty"
            :title="$t('admin:auth.noMatchingConnections')"
            :message="$t('admin:auth.tryProviderNameProtocol')" />
          <div v-else class="identity-catalog">
            <button
              v-for="item in catalogItems"
              :key="item.key"
              type="button"
              :disabled="!item.available || locked"
              @click="addProvider(item)"
            >
              <v-icon icon="mdi-shield-account-outline" /><span
                ><strong>{{ item.title }}</strong
                ><small>{{ item.description }}</small
                ><em v-if="!item.available"
                  >{{ $t('admin:auth.unavailableDeployment') }}</em
                ></span
              ><v-icon icon="mdi-plus" size="20" />
            </button></div></v-card-text
        ><v-card-actions
          ><v-spacer /><v-btn variant="text" @click="catalog = false"
            >{{ $t('common:actions.cancel') }}</v-btn
          ></v-card-actions
        ></v-card
      ></v-dialog
    >
    <v-dialog
      v-model="reviewing"
      max-width="760"
      :fullscreen="$vuetify.display.smAndDown"
      :persistent="busy"
      aria-labelledby="identity-review-title"
      ><v-card class="identity-dialog"
        ><div class="identity-dialog-heading">
          <h2 id="identity-review-title">{{ $t('admin:auth.reviewSignPolicy') }}</h2>
          <p>
            {{ $t('admin:auth.confirmChangesConnectionSettings') }}
          </p>
        </div>
        <v-card-text
          ><ul class="identity-review-list">
            <li v-for="change in reviewedChanges" :key="change.key">
              <h3>{{ change.name }}</h3>
              <p>{{ change.description }}</p>
              <ul>
                <li v-for="field in change.fields" :key="field">{{ field }}</li>
              </ul>
            </li>
          </ul>
          <v-alert
            v-if="reviewedSessions"
            type="warning"
            variant="tonal"
            class="my-5"
            >{{ $t('admin:auth.connectionEnablementChangesEnd', { reviewedSessions, interpolation: { escapeValue: false } }) }}</v-alert
          ><v-textarea
            v-model="reason"
            :label="$t('admin:auth.administrativeReason')"
            variant="outlined"
            rows="2"
            maxlength="1000"
            :disabled="busy"
          /><v-alert v-if="saveError" type="error" variant="tonal"
            >{{ saveError
            }}<v-btn
              v-if="conflict"
              variant="text"
              :disabled="busy"
              @click="reloadReview"
              >{{ $t('admin:auth.reloadSavedPolicy') }}</v-btn
            ></v-alert
          ></v-card-text
        ><v-card-actions
          ><v-btn variant="text" :disabled="busy" @click="reviewing = false"
            >{{ $t('admin:auth.keepEditing') }}</v-btn
          ><v-spacer /><v-btn
            color="primary"
            variant="flat"
            :disabled="reason.trim().length < 3 || conflict || stale"
            :loading="busy"
            @click="confirm"
            >{{ $t('admin:auth.saveSignPolicy') }}</v-btn
          ></v-card-actions
        ></v-card
      ></v-dialog
    >
  </v-container>
</template>
<script lang="ts">
import { confirmDiscard } from '../common/confirm-dialog.ts'
import AsyncState from '@/components/common/async-state.vue'
import AuthFields from './admin-auth-fields.vue'
import type {
  AuthenticationWorkspace,
  AuthenticationProviderDraft,
  AuthenticationDefinition,
  AuthenticationRuntime
} from '../../../shared/authentication-policy.ts'
import {
  fetchAuthenticationWorkspace,
  saveAuthenticationWorkspace,
  retryAuthenticationInitialization,
  authenticationDraft,
  authenticationSignature
} from '../../helpers/authentication-workspace-api.ts'
import { getErrorMessage } from '../../helpers/root-ui-store.ts'
const sections = [
    { key: 'providers', title: 'admin:auth.providers' },
    { key: 'order', title: 'admin:auth.loginOrder' },
    { key: 'activity', title: 'admin:auth.activity' }
  ],
  providerSections = [
    { key: 'connection', title: 'admin:auth.connection' },
    { key: 'enrollment', title: 'admin:auth.enrollment' },
    { key: 'integration', title: 'admin:auth.integration' }
  ]
const labels: Record<string, string> = {
  displayName: 'admin:auth.signDisplayName',
  description: 'admin:auth.purpose',
  isEnabled: 'admin:auth.signAvailability',
  selfRegistration: 'admin:auth.newAccountAdmission',
  domainWhitelist: 'admin:auth.allowedEmailDomains',
  autoEnrollGroups: 'admin:auth.initialGroups',
  order: 'admin:auth.loginOrder'
}
export default {
  components: { AsyncState, AuthFields },
  data() {
    return {
      saved: null as AuthenticationWorkspace | null,
      drafts: [] as AuthenticationProviderDraft[],
      loading: false,
      busy: false,
      initializing: false,
      stale: false,
      loadError: '',
      saveError: '',
      notice: '',
      attention: false,
      sequence: 0,
      disposed: false,
      search: '',
      section: 'providers',
      selectedKey: '',
      providerSection: 'connection',
      sections: sections.map((item) => ({ ...item, title: this.$t(item.title) })),
      providerSections: providerSections.map((item) => ({ ...item, title: this.$t(item.title) })),
      catalog: false,
      catalogSearch: '',
      advanced: false,
      reviewing: false,
      reason: '',
      conflict: false,
      reviewed: [] as AuthenticationProviderDraft[],
      reviewFingerprint: '',
      reviewedChanges: [] as Array<{
        key: string
        name: string
        description: string
        fields: string[]
      }>,
      reviewedSessions: 0
    }
  },
  computed: {
    dirty(): boolean {
      return (
        Boolean(this.saved) &&
        authenticationSignature(this.drafts) !==
          authenticationSignature(this.saved!.providers)
      )
    },
    locked(): boolean {
      return this.busy || this.initializing || this.loading || this.stale
    },
    selected(): AuthenticationProviderDraft | undefined {
      return this.drafts.find((p) => p.key === this.selectedKey)
    },
    selectedDefinition(): AuthenticationDefinition | undefined {
      return this.definition(this.selected?.strategyKey ?? '')
    },
    mappingFields() {
      return (
        this.selectedDefinition?.fields.filter((field) =>
          /^(groupsClaim|mappingGroups|groupSearch|groupNameField|groupDnProperty)/.test(
            field.key
          )
        ) ?? []
      )
    },
    connectionGroups() {
      const fields =
          this.selectedDefinition?.fields.filter(
            (field) =>
              field.key !== 'mapGroups' && !this.mappingFields.includes(field)
          ) ?? [],
        profile = fields.filter((field) =>
          /^(mapping|emailClaim|displayNameClaim|pictureClaim)/.test(field.key)
        ),
        basic = fields.filter(
          (field) =>
            !profile.includes(field) &&
            /^(client|url$|entryPoint$|issuer$|audience$|cert$|authorizationURL$|tokenURL$|userInfoURL$|bindDn$|bindCredentials$|searchBase$|searchFilter$)/.test(
              field.key
            )
        )
      return [
        {
          key: 'service',
          title: this.$t('admin:auth.serviceConnection'),
          description:
            this.$t('admin:auth.addressesCredentialsUsedEstablish'),
          fields: basic
        },
        {
          key: 'profile',
          title: this.$t('admin:auth.accountProfile'),
          description: this.$t('admin:auth.howProviderIdentifiesDescribes'),
          fields: profile
        },
        {
          key: 'advanced',
          title: this.$t('admin:auth.advancedProtocolSettings'),
          description: '',
          fields: fields.filter(
            (field) => !basic.includes(field) && !profile.includes(field)
          )
        }
      ]
    },
    enabledCount(): number {
      return this.drafts.filter((p) => p.isEnabled).length
    },
    accountCount(): number {
      return this.saved?.providers.reduce((n, p) => n + p.accountCount, 0) ?? 0
    },
    filtered() {
      const query = (this.search || '').toLowerCase()
      return this.drafts.filter((p) =>
        (
          p.displayName +
          ' ' +
          p.description +
          ' ' +
          this.definition(p.strategyKey)?.title
        )
          .toLowerCase()
          .includes(query)
      )
    },
    catalogItems() {
      const query = (this.catalogSearch || '').toLowerCase()
      return (
        this.saved?.definitions.filter(
          (d) =>
            d.key !== 'local' &&
            (d.title + ' ' + d.description).toLowerCase().includes(query)
        ) ?? []
      )
    },
    enrollmentGroups() {
      return this.saved?.groups.filter((g) => !g.system) ?? []
    },
    origin(): string {
      try {
        const url = new URL(this.saved?.host ?? '')
        return ['http:', 'https:'].includes(url.protocol) ? url.origin : ''
      } catch {
        return ''
      }
    }
  },
  watch: {
    '$route.hash': {
      immediate: true,
      handler(value: string) {
        const q = new URLSearchParams(value.slice(1))
        this.selectedKey = q.get('provider') ?? ''
        this.providerSection = providerSections.some(
          (t) => t.key === q.get('tab')
        )
          ? q.get('tab')!
          : 'connection'
        this.section = sections.some((t) => t.key === q.get('section'))
          ? q.get('section')!
          : 'providers'
      }
    }
  },
  created() {
    void this.load()
  },
  mounted() {
    window.addEventListener('beforeunload', this.beforeUnload)
  },
  beforeUnmount() {
    this.disposed = true
    this.sequence++
    window.removeEventListener('beforeunload', this.beforeUnload)
  },
  beforeRouteLeave(): Promise<boolean> {
    return this.canLeave()
  },
  async beforeRouteUpdate(to, from): Promise<boolean> {
    return (
      !this.busy &&
      !this.initializing &&
      (to.path === from.path || (await this.canLeave()))
    )
  },
  methods: {
    definition(key: string) {
      return this.saved?.definitions.find((d) => d.key === key)
    },
    savedProvider(key: string) {
      return this.saved?.providers.find((p) => p.key === key)
    },
    runtime(key: string): AuthenticationRuntime {
      return (
        this.savedProvider(key)?.runtime ?? {
          state: 'pending',
          checkedAt: null,
          revision: ''
        }
      )
    },
    statusTitle(state: string) {
      return (
        (
          {
            ready: this.$t('admin:auth.initialized'),
            failed: this.$t('admin:auth.needsAttention'),
            disabled: this.$t('admin:auth.disabled'),
            unavailable: this.$t('admin:auth.unavailable'),
            pending: this.$t('admin:auth.notInitialized')
          } as Record<string, string>
        )[state] ?? state
      )
    },
    date(value: string) {
      return new Date(value).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short'
      })
    },
    fieldTitle(key: string, field: string) {
      const provider =
        this.savedProvider(key) ?? this.drafts.find((p) => p.key === key)
      return field.startsWith('config.')
        ? (this.definition(provider?.strategyKey ?? '')?.fields.find(
            (p) => p.key === field.slice(7)
          )?.title ?? field.slice(7))
        : (labels[field] ? this.$t(labels[field]!) : field)
    },
    async load() {
      if (this.busy) return
      const sequence = ++this.sequence
      this.loading = true
      this.loadError = ''
      try {
        const result = await fetchAuthenticationWorkspace()
        if (!this.disposed && sequence === this.sequence) {
          this.saved = result
          this.drafts = result.providers.map(authenticationDraft)
          this.stale = false
        }
      } catch (error) {
        if (!this.disposed && sequence === this.sequence) {
          this.loadError = getErrorMessage(error)
          this.stale = true
        }
      } finally {
        if (!this.disposed && sequence === this.sequence) this.loading = false
      }
    },
    async reload() {
      if (this.locked && !this.stale) return
      if (
        this.dirty &&
        !(await confirmDiscard(this.$t('admin:auth.discardUnsavedSignPolicy')))
      )
        return
      await this.load()
    },
    reset() {
      if (this.locked || !this.saved) return
      this.drafts = this.saved.providers.map(authenticationDraft)
      if (!this.selected) this.selectProvider('')
    },
    updateHash() {
      const q = new URLSearchParams()
      if (this.selectedKey) {
        q.set('provider', this.selectedKey)
        q.set('tab', this.providerSection)
      } else if (this.section !== 'providers') q.set('section', this.section)
      void this.$router.replace({
        query: this.$route.query,
        hash: q.size ? '#' + q : ''
      })
    },
    selectProvider(key: string) {
      if (this.busy || (key && key === this.selectedKey)) return
      this.selectedKey = key
      this.advanced = false
      this.providerSection = 'connection'
      this.section = 'providers'
      this.updateHash()
    },
    setSection(key: string) {
      this.section = key
      this.updateHash()
    },
    setProviderSection(key: string) {
      this.providerSection = key
      this.updateHash()
    },
    move(index: number, offset: number) {
      if (this.locked) return
      const rows = [...this.drafts],
        item = rows.splice(index, 1)[0]!
      rows.splice(index + offset, 0, item)
      this.drafts = rows
    },
    updateProvider(provider: AuthenticationProviderDraft) {
      if (!this.locked)
        this.drafts = this.drafts.map((item) =>
          item.key === provider.key ? provider : item
        )
    },
    addProvider(definition: AuthenticationDefinition) {
      if (this.locked || !definition.available) return
      const provider: AuthenticationProviderDraft = {
        key: crypto.randomUUID(),
        strategyKey: definition.key,
        displayName: definition.title,
        description: '',
        isEnabled: false,
        selfRegistration: false,
        domainWhitelist: [],
        autoEnrollGroups: [],
        config: {},
        secrets: {}
      }
      for (const field of definition.fields) {
        if (field.sensitive) provider.secrets[field.key] = { action: 'keep' }
        else provider.config[field.key] = field.default
      }
      this.drafts.push(provider)
      this.catalog = false
      this.selectProvider(provider.key)
    },
    removeProvider() {
      if (
        !this.selected ||
        this.locked ||
        this.selected.key === 'local' ||
        this.savedProvider(this.selected.key)?.accountCount
      )
        return
      const key = this.selected.key
      this.drafts = this.drafts.filter((p) => p.key !== key)
      this.selectProvider('')
    },

    reviewValue(provider: AuthenticationProviderDraft, key: string): string {
      if (key === 'isEnabled')
        return provider.isEnabled ? this.$t('admin:auth.enabled') : this.$t('admin:auth.disabled')
      if (key === 'selfRegistration')
        return provider.selfRegistration
          ? this.$t('admin:auth.newAccountsAllowed')
          : this.$t('admin:auth.existingAccountsOnly')
      if (key === 'domainWhitelist')
        return provider.domainWhitelist.length
          ? provider.domainWhitelist.join(', ')
          : this.$t('admin:auth.anyEmailDomain')
      if (key === 'autoEnrollGroups')
        return provider.autoEnrollGroups.length
          ? provider.autoEnrollGroups
              .map(
                (id) =>
                  this.saved?.groups.find((g) => g.id === id)?.name ??
                  this.$t('admin:auth.group', { id, interpolation: { escapeValue: false } })
              )
              .join(', ')
          : this.$t('admin:auth.noInitialGroups')
      if (key === 'displayName') return provider.displayName
      return provider.description || this.$t('admin:auth.noPurposeSpecified')
    },
    review() {
      if (this.locked || !this.dirty || !this.saved) return
      const invalid = this.drafts.find(
        (p) =>
          !p.displayName.trim() ||
          p.displayName.trim().length > 255 ||
          p.description.length > 1000 ||
          Object.values(p.secrets).some(
            (secret) => secret.action === 'replace' && !secret.value
          )
      )
      if (invalid) {
        this.notice =
          this.$t('admin:auth.completeProviderNameAny')
        this.attention = true
        this.selectProvider(invalid.key)
        this.$nextTick(() => {
          if (this.disposed) return
          const feedback = document.getElementById('identity-notice')
          feedback?.focus()
          feedback?.scrollIntoView({ block: 'nearest' })
        })
        return
      }
      this.reviewed = this.drafts.map(authenticationDraft)
      this.reviewFingerprint = this.saved.fingerprint
      this.reviewedChanges = []
      this.reviewedSessions = 0
      for (const [index, p] of this.reviewed.entries()) {
        const current = this.savedProvider(p.key),
          fields: string[] = []
        if (!current) {
          fields.push(
            p.isEnabled ? this.$t('admin:auth.signWillEnabled') : this.$t('admin:auth.startsDisabled'),
            p.selfRegistration
              ? this.$t('admin:auth.newAccountsAllowed')
              : this.$t('admin:auth.existingAccountsOnly')
          )
          if (p.selfRegistration)
            fields.push(
              this.$t('admin:auth.allowedEmailDomains2', { p: this.reviewValue(p, 'domainWhitelist'), interpolation: { escapeValue: false } }),
              this.$t('admin:auth.initialGroups2', { p: this.reviewValue(p, 'autoEnrollGroups'), interpolation: { escapeValue: false } })
            )
          for (const [key, secret] of Object.entries(p.secrets))
            if (secret.action === 'replace')
              fields.push(
                this.$t('admin:auth.newCredential', { key: this.fieldTitle(p.key, 'config.' + key), interpolation: { escapeValue: false } })
              )
        } else {
          for (const key of Object.keys(labels) as Array<
            keyof AuthenticationProviderDraft | 'order'
          >) {
            if (key === 'order') {
              if (
                this.saved.providers.findIndex((row) => row.key === p.key) !==
                index
              )
                fields.push(this.$t('admin:auth.position', { tValue: this.$t(labels[key]!), value: (index + 1), interpolation: { escapeValue: false } }))
            } else if (JSON.stringify(current[key]) !== JSON.stringify(p[key]))
              fields.push(
                this.$t(labels[key]!) +
                  ' · ' +
                  this.reviewValue(current, key) +
                  ' → ' +
                  this.reviewValue(p, key)
              )
          }
          for (const [key, value] of Object.entries(p.config))
            if (JSON.stringify(current.config[key]) !== JSON.stringify(value))
              fields.push(this.fieldTitle(p.key, 'config.' + key))
          for (const [key, secret] of Object.entries(p.secrets))
            if (secret.action !== 'keep')
              fields.push(
                this.fieldTitle(p.key, 'config.' + key) +
                  ' · ' +
                  (secret.action === 'clear'
                    ? this.$t('admin:auth.clearCredential')
                    : this.$t('admin:auth.replaceCredential'))
              )
          if (
            current.isEnabled !== p.isEnabled ||
            JSON.stringify(current.config) !== JSON.stringify(p.config) ||
            Object.values(p.secrets).some((s) => s.action !== 'keep')
          )
            this.reviewedSessions += current.accountCount
        }
        if (fields.length)
          this.reviewedChanges.push({
            key: p.key,
            name: p.displayName,
            description: current ? this.$t('admin:auth.updateSavedProvider') : this.$t('admin:auth.createProvider'),
            fields
          })
      }
      for (const p of this.saved.providers)
        if (!this.reviewed.some((row) => row.key === p.key))
          this.reviewedChanges.push({
            key: p.key,
            name: p.displayName,
            description: this.$t('admin:auth.removeProvider'),
            fields: []
          })
      this.reason = ''
      this.saveError = ''
      this.conflict = false
      this.notice = ''
      this.reviewing = true
    },
    async confirm() {
      if (
        !this.reviewing ||
        this.busy ||
        this.loading ||
        this.initializing ||
        this.conflict ||
        this.stale ||
        this.reason.trim().length < 3
      )
        return
      this.busy = true
      this.saveError = ''
      try {
        const result = await saveAuthenticationWorkspace(
          this.reviewed,
          this.reason.trim(),
          this.reviewFingerprint
        )
        if (this.disposed) return
        this.reviewing = false
        this.reason = ''
        const providers = this.reviewed.map((p) => ({
          ...this.savedProvider(p.key),
          ...authenticationDraft(p),
          accountCount: this.savedProvider(p.key)?.accountCount ?? 0,
          activeAccountCount:
            this.savedProvider(p.key)?.activeAccountCount ?? 0,
          configuredSecrets: Object.entries(p.secrets)
            .filter(
              ([key, secret]) =>
                secret.action === 'replace' ||
                (secret.action === 'keep' &&
                  this.savedProvider(p.key)?.configuredSecrets.includes(key))
            )
            .map(([key]) => key),
          secrets: Object.fromEntries(
            Object.keys(p.secrets).map((key) => [
              key,
              { action: 'keep' as const }
            ])
          ),
          runtime: { state: 'pending' as const, checkedAt: null, revision: '' }
        }))
        this.saved = { ...this.saved!, providers }
        this.drafts = providers.map(authenticationDraft)
        this.reviewed = []
        this.notice =
          this.$t('admin:auth.signPolicySaved', { value: (result.sessionsEnded
            ? ` ${this.$t('admin:auth.sessionsEndedSentence', { count: result.sessionsEnded })}`
            : ''), activation: (result.activation === 'needs-attention'
            ? ' Some sign-in methods need initialization attention.'
            : ''), interpolation: { escapeValue: false } })
        this.attention = result.activation === 'needs-attention'
        if (result.currentSessionEnded) {
          window.location.assign('/login')
          return
        }
        this.busy = false
        this.stale = true
        await this.load()
      } catch (error) {
        if (!this.disposed) {
          const status =
            error && typeof error === 'object'
              ? Reflect.get(error, 'status')
              : 0
          this.conflict = !status || [401, 403, 409].includes(status)
          if (this.conflict) {
            this.stale = true
            this.notice =
              this.$t('admin:auth.reloadSavedPolicyBefore')
            this.attention = true
          }
          this.saveError =
            getErrorMessage(error) +
            (!status
              ? ` ${this.$t('admin:auth.outcomeUnconfirmedReloadBefore')}`
              : '')
        }
      } finally {
        if (!this.disposed) this.busy = false
      }
    },
    async reloadReview() {
      if (
        this.busy ||
        !(await confirmDiscard(
          this.$t('admin:auth.discardDraftLoadCurrent')
        ))
      )
        return
      this.reviewing = false
      await this.load()
    },
    async initialize() {
      if (this.dirty || this.locked || !this.saved) return
      this.initializing = true
      try {
        const result = await retryAuthenticationInitialization(
          this.saved.fingerprint
        )
        this.notice =
          result.activation === 'applied'
            ? this.$t('admin:auth.enabledSignMethodsInitialized')
            : this.$t('admin:auth.initializationNeedsAttentionReview')
        this.attention = result.activation !== 'applied'
        await this.load()
      } catch (error) {
        this.notice = getErrorMessage(error)
        this.attention = true
      } finally {
        this.initializing = false
      }
    },
    async canLeave(): Promise<boolean> {
      return (
        !this.busy &&
        !this.initializing &&
        ((!this.dirty && !(this.reviewing && this.reason)) ||
          (await confirmDiscard(this.$t('admin:auth.discardUnsavedSignPolicy'))))
      )
    },
    beforeUnload(event: BeforeUnloadEvent) {
      if (
        this.busy ||
        this.initializing ||
        this.dirty ||
        (this.reviewing && this.reason)
      ) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
  }
}
</script>
<style lang="scss" src="./authentication-workspace.scss"></style>
