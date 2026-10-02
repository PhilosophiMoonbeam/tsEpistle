<template>
  <v-container fluid class="identity-workspace">
    <admin-hero
      icon="mdi-shield-account-outline"
      :title="
        selected
          ? selected.displayName || 'New sign-in method'
          : 'Authentication'
      "
      :description="
        selected
          ? selected.description ||
            'Configure how this identity provider connects people to the workspace.'
          : 'Manage sign-in methods and how new accounts join.'
      "
    >
      <template #actions
        ><v-btn
          v-if="selected"
          variant="text"
          prepend-icon="mdi-arrow-left"
          :disabled="busy"
          @click="selectProvider('')"
          >All providers</v-btn
        ><v-btn
          variant="text"
          prepend-icon="mdi-refresh"
          :disabled="busy"
          :loading="loading"
          @click="reload"
          >Reload policy</v-btn
        ><v-btn v-if="dirty" variant="text" :disabled="busy" @click="reset"
          >Reset draft</v-btn
        ><v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-check"
          :disabled="!dirty || locked"
          @click="review"
          >Review changes</v-btn
        ></template
      >
    </admin-hero>
    <async-state
      v-if="!saved && loading"
      state="loading"
      title="Loading sign-in policy"
    /><async-state
      v-else-if="!saved && loadError"
      state="error"
      title="Authentication is unavailable"
      :message="loadError"
      retry-label="Try again"
      @retry="load"
    />
    <template v-if="saved">
      <v-alert v-if="loadError" type="error" variant="tonal" class="mt-5"
        >{{ loadError
        }}<v-btn variant="text" @click="load">Try again</v-btn></v-alert
      ><v-alert
        v-if="notice"
        :type="attention ? 'warning' : 'success'"
        variant="tonal"
        class="mt-5"
        >{{ notice }}</v-alert
      >
      <div class="identity-status">
        <span>{{
          dirty ? 'Unsaved policy draft' : 'Showing saved sign-in policy'
        }}</span
        ><span>{{ enabledCount }} enabled · {{ accountCount }} accounts</span>
      </div>
      <nav
        v-if="!selected"
        class="identity-tabs"
        aria-label="Authentication sections"
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
            <span class="identity-kicker">Identity & access</span>
            <h2>Sign-in methods</h2>
            <p>
              Keep everyday access simple, with a dependable local recovery
              route.
            </p>
          </div>
          <v-btn
            variant="outlined"
            prepend-icon="mdi-plus"
            :disabled="locked"
            @click="catalog = true"
            >Add provider</v-btn
          >
        </div>
        <form class="identity-search" @submit.prevent>
          <v-text-field
            v-model="search"
            label="Find a provider by name or purpose"
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
                {{ provider.displayName || 'Untitled provider' }}
              </button>
              <p>
                {{
                  provider.description ||
                  definition(provider.strategyKey)?.description ||
                  'Provider definition unavailable.'
                }}
              </p>
              <div class="identity-meta">
                <span>{{
                  definition(provider.strategyKey)?.title ||
                  provider.strategyKey
                }}</span
                ><span v-if="provider.key === 'local'">Recovery route</span
                ><span>{{
                  provider.selfRegistration
                    ? 'New accounts allowed'
                    : 'Existing accounts only'
                }}</span>
              </div>
            </div>
            <div class="identity-provider-count">
              <strong>{{
                savedProvider(provider.key)?.accountCount ?? 0
              }}</strong
              ><span>accounts</span>
            </div>
            <span
              class="identity-runtime"
              :class="'is-' + runtime(provider.key).state"
              >{{ statusTitle(runtime(provider.key).state) }}</span
            ><v-btn
              variant="text"
              icon="mdi-arrow-right"
              :aria-label="'Configure ' + provider.displayName"
              @click="selectProvider(provider.key)"
            />
          </li>
        </ul>
        <async-state
          v-else
          state="empty"
          title="No matching providers"
          message="Try another name or clear the search."
        />
        <div class="identity-boundary">
          <v-icon icon="mdi-information-outline" size="19" />
          <p>
            Initialization confirms that a sign-in method loaded in this
            application. Complete a real sign-in with your identity provider to
            verify the full connection.
          </p>
          <v-btn
            variant="text"
            :disabled="dirty || locked"
            :loading="initializing"
            @click="initialize"
            >Retry initialization</v-btn
          >
        </div>
      </template>
      <template v-else-if="!selected && section === 'order'">
        <div class="identity-heading">
          <div>
            <span class="identity-kicker">The arrival experience</span>
            <h2>Login order</h2>
            <p>
              Put the method most people use first. Changes remain in your
              policy draft until reviewed.
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
                    ? 'Shown on the sign-in page'
                    : 'Disabled · hidden from sign-in'
                }}</small>
              </div>
              <v-btn
                icon="mdi-arrow-up"
                size="small"
                variant="text"
                :aria-label="'Move ' + provider.displayName + ' up'"
                :disabled="locked || index === 0"
                @click="move(index, -1)"
              /><v-btn
                icon="mdi-arrow-down"
                size="small"
                variant="text"
                :aria-label="'Move ' + provider.displayName + ' down'"
                :disabled="locked || index === drafts.length - 1"
                @click="move(index, 1)"
              />
            </li>
          </ol>
          <aside class="identity-preview">
            <span class="identity-kicker">Sign-in choices preview</span>
            <h3>Welcome back</h3>
            <p>Choose how to sign in.</p>
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
              >A preview of enabled methods and their order. Provider forms and
              your theme appear on the actual sign-in page.</small
            >
          </aside>
        </div>
      </template>
      <template v-else-if="!selected && section === 'activity'">
        <div class="identity-heading">
          <div>
            <span class="identity-kicker">Administrative record</span>
            <h2>Policy activity</h2>
            <p>
              The latest 50 reviewed changes. Credentials are never included.
            </p>
          </div>
        </div>
        <async-state
          v-if="!saved.history.length"
          state="empty"
          title="No recorded policy changes"
          message="Reviewed saves will appear here."
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
                  ? 'Account #' + event.actorId
                  : 'API administrator'
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
                  · {{ change.sessionsEnded }} account sessions ended</span
                >
              </li>
            </ul>
          </li>
        </ol>
      </template>
      <template v-else-if="selected">
        <nav class="identity-tabs" aria-label="Provider settings">
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
                  <h2>Connection</h2>
                  <p>
                    {{
                      selectedDefinition?.description ||
                      'This provider definition is unavailable. Its stored configuration is retained.'
                    }}
                  </p>
                </div>
              </div>
              <div class="identity-fields">
                <v-text-field
                  v-model="selected.displayName"
                  label="Sign-in display name"
                  maxlength="255"
                  variant="outlined"
                  :disabled="locked"
                /><v-textarea
                  v-model="selected.description"
                  label="Purpose"
                  maxlength="1000"
                  rows="2"
                  auto-grow
                  variant="outlined"
                  :disabled="locked"
                  hint="Help administrators understand who this connection serves."
                  persistent-hint
                /><v-switch
                  v-model="selected.isEnabled"
                  label="Enable this sign-in method"
                  color="primary"
                  inset
                  :disabled="
                    locked ||
                    selected.key === 'local' ||
                    !selectedDefinition?.available
                  "
                  :hint="
                    selected.key === 'local'
                      ? 'Local sign-in stays enabled for recovery.'
                      : 'Enable after configuring the connection. Saving initializes the provider.'
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
                      ><strong>Advanced protocol settings</strong
                      ><small
                        >Signing, transport, assertions and provider-specific
                        options.</small
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
                    >Who joins, and with what access</span
                  >
                  <h2>Account enrollment</h2>
                  <p>
                    These settings govern new accounts. Existing accounts retain
                    their membership unless directory mapping is enabled.
                  </p>
                </div>
              </div>
              <v-switch
                v-model="selected.selfRegistration"
                label="Allow new accounts through this provider"
                color="primary"
                inset
                :disabled="locked"
                :hint="
                  selected.key === 'local'
                    ? 'People may register a local account. Email verification remains part of local registration.'
                    : 'A successful provider sign-in may create a workspace account.'
                "
                persistent-hint
              />
              <div
                v-if="selected.selfRegistration"
                class="identity-fields mt-6"
              >
                <v-combobox
                  v-model="selected.domainWhitelist"
                  label="Allowed email domains"
                  variant="outlined"
                  multiple
                  chips
                  closable-chips
                  :disabled="locked"
                  hint="Exact domains, such as example.org. Leave empty to accept any email domain."
                  persistent-hint
                /><v-autocomplete
                  v-model="selected.autoEnrollGroups"
                  :items="enrollmentGroups"
                  item-title="name"
                  item-value="id"
                  label="Initial groups"
                  variant="outlined"
                  multiple
                  chips
                  closable-chips
                  :disabled="locked"
                  hint="New accounts receive these groups. System identities and script authority are excluded."
                  persistent-hint
                />
                <p class="identity-note">
                  {{
                    selected.autoEnrollGroups.length
                      ? 'Review the permissions of each selected group before opening enrollment.'
                      : 'New accounts will start without group permissions.'
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
                <h3>Directory group mapping</h3>
                <v-switch
                  v-model="selected.config.mapGroups"
                  label="Synchronize groups from the identity provider"
                  color="primary"
                  inset
                  :disabled="locked"
                />
                <p class="identity-note">
                  When a group claim is present, names are matched exactly to
                  workspace groups. Matching memberships are added and other
                  memberships are removed at sign-in. This can include
                  administrative groups. Missing claims leave memberships
                  unchanged; an empty claim removes them. Older account sessions
                  end when membership changes.
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
                    >Connect the identity service</span
                  >
                  <h2>Integration details</h2>
                  <p>
                    Use the configured public workspace address when setting up
                    your provider.
                  </p>
                </div>
              </div>
              <dl class="identity-integration">
                <div>
                  <dt>Workspace origin</dt>
                  <dd>
                    {{ origin || 'Set the public workspace URL in General.' }}
                  </dd>
                </div>
                <div v-if="!selectedDefinition?.useForm">
                  <dt>Callback URL</dt>
                  <dd>
                    {{
                      origin
                        ? origin + '/login/' + selected.key + '/callback'
                        : 'Workspace URL required'
                    }}
                  </dd>
                </div>
                <div>
                  <dt>Sign-in page</dt>
                  <dd>
                    {{ origin ? origin + '/login' : 'Workspace URL required' }}
                  </dd>
                </div>
                <div>
                  <dt>Provider identifier</dt>
                  <dd>{{ selected.key }}</dd>
                </div>
              </dl>
              <p class="identity-note">
                {{
                  selectedDefinition?.useForm
                    ? 'This provider uses a sign-in form in the workspace. A redirect callback is not required for the form.'
                    : 'Allow this exact callback in your identity provider. Follow its protocol-specific configuration for client credentials, assertions, claims and logout behavior.'
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
                >Provider reference</v-btn
              ><v-btn class="mt-5 ml-2" to="/general" variant="text"
                >Workspace URL settings</v-btn
              >
            </template>
          </section>
          <aside class="identity-aside">
            <div class="identity-panel">
              <span class="identity-kicker">Saved provider</span>
              <h3>{{ statusTitle(runtime(selected.key).state) }}</h3>
              <p class="identity-note">
                {{
                  savedProvider(selected.key)
                    ? 'Initialization reflects this application’s last observed saved revision.'
                    : 'This new provider exists only in your draft.'
                }}
              </p>
              <dl class="identity-facts">
                <div>
                  <dt>Accounts</dt>
                  <dd>{{ savedProvider(selected.key)?.accountCount ?? 0 }}</dd>
                </div>
                <div>
                  <dt>Active accounts</dt>
                  <dd>
                    {{ savedProvider(selected.key)?.activeAccountCount ?? 0 }}
                  </dd>
                </div>
                <div>
                  <dt>Last initialization</dt>
                  <dd>
                    {{
                      runtime(selected.key).checkedAt
                        ? date(runtime(selected.key).checkedAt!)
                        : 'Not observed'
                    }}
                  </dd>
                </div>
              </dl>
              <v-btn
                variant="text"
                :disabled="dirty || locked"
                :loading="initializing"
                @click="initialize"
                >Retry initialization</v-btn
              >
            </div>
            <div v-if="selected.key !== 'local'" class="identity-panel">
              <h3>Retire this connection</h3>
              <p class="identity-note">
                {{
                  savedProvider(selected.key)?.accountCount
                    ? 'This provider has accounts. Disable sign-in or resolve those accounts before removing the provider.'
                    : 'Removal is staged in your policy draft and takes effect after review.'
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
                >Remove provider</v-btn
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
          <h2 id="identity-catalog-title">Add a sign-in provider</h2>
          <p>Choose a connection, configure it, then enable it when ready.</p>
        </div>
        <v-card-text
          ><v-text-field
            v-model="catalogSearch"
            label="Search provider catalog"
            variant="outlined"
            prepend-inner-icon="mdi-magnify"
            clearable /><async-state
            v-if="!catalogItems.length"
            state="empty"
            title="No matching connections"
            message="Try a provider name or protocol, such as OpenID Connect or LDAP." />
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
                  >Unavailable in this deployment</em
                ></span
              ><v-icon icon="mdi-plus" size="20" />
            </button></div></v-card-text
        ><v-card-actions
          ><v-spacer /><v-btn variant="text" @click="catalog = false"
            >Cancel</v-btn
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
          <h2 id="identity-review-title">Review sign-in policy</h2>
          <p>
            Confirm the changes to connection settings, enrollment and login
            order.
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
            >Connection or enablement changes end existing sessions for
            {{ reviewedSessions }} account(s). They must sign in again.</v-alert
          ><v-textarea
            v-model="reason"
            label="Administrative reason"
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
              >Reload saved policy</v-btn
            ></v-alert
          ></v-card-text
        ><v-card-actions
          ><v-btn variant="text" :disabled="busy" @click="reviewing = false"
            >Keep editing</v-btn
          ><v-spacer /><v-btn
            color="primary"
            variant="flat"
            :disabled="reason.trim().length < 3 || conflict || stale"
            :loading="busy"
            @click="confirm"
            >Save sign-in policy</v-btn
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
    { key: 'providers', title: 'Providers' },
    { key: 'order', title: 'Login order' },
    { key: 'activity', title: 'Activity' }
  ],
  providerSections = [
    { key: 'connection', title: 'Connection' },
    { key: 'enrollment', title: 'Enrollment' },
    { key: 'integration', title: 'Integration' }
  ]
const labels: Record<string, string> = {
  displayName: 'Sign-in display name',
  description: 'Purpose',
  isEnabled: 'Sign-in availability',
  selfRegistration: 'New-account admission',
  domainWhitelist: 'Allowed email domains',
  autoEnrollGroups: 'Initial groups',
  order: 'Login order'
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
      sections,
      providerSections,
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
          title: 'Service connection',
          description:
            'The addresses and credentials used to establish sign-in.',
          fields: basic
        },
        {
          key: 'profile',
          title: 'Account profile',
          description: 'How the provider identifies and describes each person.',
          fields: profile
        },
        {
          key: 'advanced',
          title: 'Advanced protocol settings',
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
            ready: 'Initialized',
            failed: 'Needs attention',
            disabled: 'Disabled',
            unavailable: 'Unavailable',
            pending: 'Not initialized'
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
        : (labels[field] ?? field)
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
        !(await confirmDiscard('Discard unsaved sign-in policy changes?'))
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
      if (this.busy) return
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
        return provider.isEnabled ? 'Enabled' : 'Disabled'
      if (key === 'selfRegistration')
        return provider.selfRegistration
          ? 'New accounts allowed'
          : 'Existing accounts only'
      if (key === 'domainWhitelist')
        return provider.domainWhitelist.length
          ? provider.domainWhitelist.join(', ')
          : 'Any email domain'
      if (key === 'autoEnrollGroups')
        return provider.autoEnrollGroups.length
          ? provider.autoEnrollGroups
              .map(
                (id) =>
                  this.saved?.groups.find((g) => g.id === id)?.name ??
                  'Group #' + id
              )
              .join(', ')
          : 'No initial groups'
      if (key === 'displayName') return provider.displayName
      return provider.description || 'No purpose specified'
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
          'Complete the provider name and any replacement credentials before reviewing.'
        this.attention = true
        this.selectProvider(invalid.key)
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
            p.isEnabled ? 'Sign-in will be enabled' : 'Starts disabled',
            p.selfRegistration
              ? 'New accounts allowed'
              : 'Existing accounts only'
          )
          if (p.selfRegistration)
            fields.push(
              'Allowed email domains · ' +
                this.reviewValue(p, 'domainWhitelist'),
              'Initial groups · ' + this.reviewValue(p, 'autoEnrollGroups')
            )
          for (const [key, secret] of Object.entries(p.secrets))
            if (secret.action === 'replace')
              fields.push(
                this.fieldTitle(p.key, 'config.' + key) + ' · new credential'
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
                fields.push(labels[key]! + ' · position ' + (index + 1))
            } else if (JSON.stringify(current[key]) !== JSON.stringify(p[key]))
              fields.push(
                labels[key] +
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
                    ? 'clear credential'
                    : 'replace credential')
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
            description: current ? 'Update saved provider' : 'Create provider',
            fields
          })
      }
      for (const p of this.saved.providers)
        if (!this.reviewed.some((row) => row.key === p.key))
          this.reviewedChanges.push({
            key: p.key,
            name: p.displayName,
            description: 'Remove provider',
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
          'Sign-in policy saved.' +
          (result.sessionsEnded
            ? ` Existing sessions ended for ${result.sessionsEnded} account(s).`
            : '') +
          (result.activation === 'needs-attention'
            ? ' Some sign-in methods need initialization attention.'
            : '')
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
              'Reload the saved policy before reviewing another change. Your draft is retained.'
            this.attention = true
          }
          this.saveError =
            getErrorMessage(error) +
            (!status
              ? ' The outcome is unconfirmed. Reload before repeating this save.'
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
          'Discard this draft and load the current sign-in policy?'
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
            ? 'Enabled sign-in methods initialized.'
            : 'Initialization needs attention. Review the provider states and server diagnostics.'
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
          (await confirmDiscard('Discard unsaved sign-in policy changes?')))
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
