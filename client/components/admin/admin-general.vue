<template>
  <v-container fluid class="general-workspace">
    <admin-hero
      icon="mdi-tune-variant"
      :title="gt('title')"
      :description="gt('giveWorkspaceIdentityVoice')"
    >
      <template #actions>
        <v-btn
          variant="text"
          prepend-icon="mdi-refresh"
          :disabled="busy || initializing"
          :loading="loading"
          @click="reload"
          >{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ gt('reloadSavedWorkspaceSettings') }}</v-tooltip></v-btn
        >
        <v-btn v-if="dirty" variant="text" :disabled="locked" @click="reset"
          >{{ gt('resetDraft') }}</v-btn
        >
        <v-btn
          color="primary"
          variant="tonal"
          :data-commitment="dirty && !locked ? 'active' : undefined"
          prepend-icon="mdi-check"
          :disabled="locked || !dirty"
          @click="review"
          >{{ gt('reviewChanges') }}</v-btn
        >
      </template>
    </admin-hero>
    <async-state
      v-if="!saved && loading"
      state="loading"
      :title="gt('loadingWorkspaceSettings')"
    />
    <async-state
      v-else-if="!saved && loadError"
      state="error"
      :title="gt('workspaceSettingsUnavailable')"
      :message="loadError"
      :retry-label="gt('tryAgain')"
      @retry="load"
    />
    <template v-if="saved && draft">
      <v-alert v-if="loadError" type="error" variant="tonal" class="mt-5"
        >{{ loadError
        }}<v-btn variant="text" :disabled="busy" @click="reload"
          >{{ gt('reloadSavedSettings') }}</v-btn
        ></v-alert
      >
      <v-alert
        v-if="notice"
        :type="attention ? 'warning' : 'success'"
        variant="tonal"
        class="mt-5"
        >{{ notice }}</v-alert
      >
      <div class="general-status">
        <span
          ><i :class="dirty ? 'is-draft' : ''" />{{
            dirty ? gt('unsavedWorkspaceDraft') : gt('showingSavedSettings')
          }}</span
        ><span>{{
          saved.runtime.state === "applied"
            ? gt('runtimeConfigurationCurrent')
            : gt('runtimeConfigurationNeedsAttention')
        }}</span>
      </div>
      <nav class="general-tabs" :aria-label="gt('generalSections')">
        <button
          v-for="tab in sections"
          :key="tab.key"
          type="button"
          :aria-current="section === tab.key ? 'page' : undefined"
          :disabled="busy || initializing"
          @click="selectSection(tab.key)"
        >
          {{ tab.title }}
        </button>
      </nav>
      <div class="general-layout">
        <section class="general-editor">
          <template v-if="section === 'identity'">
            <div class="general-heading">
              <span class="general-kicker">{{ gt('placeKnow') }}</span>
              <h2>{{ gt('workspaceIdentity') }}</h2>
              <p>
                {{ gt('nameAddressAttributionMake') }}
              </p>
            </div>
            <div class="general-setting-group">
              <v-text-field
                v-model="draft.title"
                :label="gt('fieldLabels.title')"
                variant="outlined"
                maxlength="50"
                counter="50"
                :disabled="locked"
                :hint="gt('usedNavigationBrowserTitles')"
                persistent-hint
              />
              <v-text-field
                v-model="draft.host"
                :label="gt('fieldLabels.host')"
                variant="outlined"
                :disabled="locked"
                :hint="gt('httpSOriginUsed')"
                persistent-hint
              />
              <p class="general-note">
                {{ gt('changingAddressDoesNot') }}
              </p>
            </div>
            <div class="general-setting-group">
              <h3>{{ gt('workspaceLogo') }}</h3>
              <general-logo-manager :disabled="locked || reviewing" />
            </div>
            <div class="general-setting-group">
              <h3>{{ gt('attributionFooter') }}</h3>
              <p>
                {{ gt('setOrganizationContentAttribution') }}
              </p>
              <v-text-field
                v-model="draft.company"
                :label="gt('fieldLabels.company')"
                variant="outlined"
                maxlength="255"
                :disabled="locked"
              />
              <v-select
                v-model="draft.contentLicense"
                :items="licenses"
                :label="gt('fieldLabels.contentLicense')"
                variant="outlined"
                :disabled="locked"
              />
              <v-textarea
                v-model="draft.footerOverride"
                :label="gt('customFooter')"
                variant="outlined"
                rows="3"
                auto-grow
                maxlength="8000"
                :disabled="locked"
                :hint="gt('markdownLeaveEmptyUse')"
                persistent-hint
              />
              <div v-if="draft.footerOverride" class="general-preview-fragment">
                <span class="general-kicker">{{ gt('footerPreview') }}</span>
                <div class="general-markdown" v-html="footerPreview" />
              </div>
            </div>
          </template>
          <template v-else-if="section === 'announcement'">
            <div class="general-heading">
              <span class="general-kicker">{{ gt('sharedNoticeboard') }}</span>
              <h2>{{ gt('workspaceAnnouncement') }}</h2>
              <p>
                {{ gt('giveReadersTimelyContext') }}
              </p>
            </div>
            <div class="general-announcement-state">
              <v-icon
                :icon="
                  announcementState === 'visible'
                    ? 'mdi-bullhorn-outline'
                    : 'mdi-calendar-clock-outline'
                "
              />
              <div>
                <strong>{{ announcementLabels[announcementState] }}</strong>
                <p>{{ announcementExplanation }}</p>
              </div>
            </div>
            <div class="general-setting-group">
              <v-switch
                :model-value="draft.banner.isEnabled"
                @update:model-value="$event !== null && (draft.banner.isEnabled = $event)"
                :label="gt('publishAnnouncement')"
                color="primary"
                inset
                :disabled="locked"
                :hint="gt('announcementAppearsWikiPages')"
                persistent-hint
              />
              <v-text-field
                v-model="draft.banner.title"
                :label="gt('announcementTitle')"
                variant="outlined"
                maxlength="160"
                counter="160"
                :disabled="locked"
              />
              <v-textarea
                v-model="draft.banner.content"
                :label="gt('announcementMessage')"
                variant="outlined"
                rows="6"
                auto-grow
                maxlength="8000"
                :disabled="locked"
                :hint="gt('markdownSupportedIncludeTitle')"
                persistent-hint
              />
              <v-select
                :model-value="draft.banner.tone || 'warning'"
                :items="tones"
                :label="gt('noticeTone')"
                variant="outlined"
                :disabled="locked"
                @update:model-value="draft.banner.tone = $event"
              />
            </div>
            <div class="general-setting-group">
              <h3>{{ gt('publicationWindow') }}</h3>
              <p>
                {{ gt('useUtcUnambiguousSchedule') }}
              </p>
              <div class="general-pair">
                <v-text-field
                  :model-value="dateInput(draft.banner.startsAt)"
                  type="datetime-local"
                  step="60"
                  :label="gt('startsUtc')"
                  variant="outlined"
                  clearable
                  :disabled="locked"
                  @update:model-value="setSchedule('startsAt', $event)"
                /><v-text-field
                  :model-value="dateInput(draft.banner.endsAt)"
                  type="datetime-local"
                  step="60"
                  :label="gt('endsUtc')"
                  variant="outlined"
                  clearable
                  :disabled="locked"
                  @update:model-value="setSchedule('endsAt', $event)"
                />
              </div>
              <p class="general-note">
                {{ gt('scheduledNoticesAppearWhen') }}
              </p>
            </div>
            <div class="general-preview-fragment">
              <span class="general-kicker">{{ gt('readerPreviewUnsavedDraft') }}</span
              ><site-banner
                v-if="draft.banner.title || draft.banner.content"
                :banner="{ ...draft.banner, isEnabled: true }"
                preview
              />
              <p v-else class="general-note">
                {{ gt('addTitleMessagePreview') }}
              </p>
            </div>
          </template>
          <template v-else-if="section === 'publishing'">
            <div class="general-heading">
              <span class="general-kicker">{{ gt('readerAuthorConventions') }}</span>
              <h2>{{ gt('publishingDefaults') }}</h2>
              <p>
                {{ gt('helpPeopleDiscoverPages') }}
              </p>
            </div>
            <div class="general-setting-group">
              <h3>{{ gt('searchPresentation') }}</h3>
              <p>
                {{ gt('metadataExternalSearchEngines') }}
              </p>
              <v-textarea
                v-model="draft.description"
                :label="gt('fieldLabels.description')"
                variant="outlined"
                rows="3"
                maxlength="1000"
                :disabled="locked"
              />
              <div class="general-pair">
                <v-select
                  :model-value="indexDirective"
                  :items="indexOptions"
                  :label="gt('indexPages')"
                  variant="outlined"
                  :disabled="locked"
                  @update:model-value="setRobots('index', $event)"
                /><v-select
                  :model-value="followDirective"
                  :items="followOptions"
                  :label="gt('followPageLinks')"
                  variant="outlined"
                  :disabled="locked"
                  @update:model-value="setRobots('follow', $event)"
                />
              </div>
              <div class="general-search-preview">
                <span>{{ draft.host || gt('workspaceAddress') }}</span
                ><strong>{{ draft.title || gt('fieldLabels.title') }}</strong>
                <p>
                  {{
                    draft.description ||
                    gt('workspaceDescriptionWillAppear')
                  }}
                </p>
                <small
                  >{{ gt('illustrativeSearchPreviewSearch') }}</small
                >
              </div>
            </div>
            <div class="general-setting-group">
              <h3>{{ gt('fieldLabels.pageExtensions') }}</h3>
              <p>
                {{ gt('chooseWhichFileLike') }}
              </p>
              <v-combobox
                v-model="draft.pageExtensions"
                :label="gt('recognizedPageExtensions')"
                variant="outlined"
                multiple
                chips
                closable-chips
                :disabled="locked"
                :hint="gt('typeExtensionPressEnter')"
                persistent-hint
              />
              <div class="general-url-examples">
                <div
                  v-for="extension in draft.pageExtensions.slice(0, 6)"
                  :key="extension"
                >
                  <code>/handbook.{{ extension }}</code
                  ><v-icon icon="mdi-arrow-right" size="16" /><code
                    >/handbook</code
                  >
                </div>
                <p v-if="!draft.pageExtensions.length">
                  {{ gt('noExtensionAliasesExtensionless') }}
                </p>
              </div>
            </div>
            <div class="general-setting-group">
              <h3>{{ labels.featureGlossary }}</h3>
              <v-switch
                :model-value="draft.featureGlossary"
                @update:model-value="$event !== null && (draft.featureGlossary = $event)"
                :label="gt('enableGlossary', { defaultValue: 'Enable glossary' })"
                color="primary"
                inset
                :disabled="locked"
                :hint="gt('glossaryAvailabilityHint', { defaultValue: 'Turning this off hides the glossary and refuses glossary changes without deleting terms. Turning it back on restores access under the existing permissions.' })"
                persistent-hint
              />
            </div>
            <div class="general-setting-group">
              <h3>{{ labels.publicSocialSharing }}</h3>
              <v-switch
                :model-value="draft.publicSocialSharing"
                @update:model-value="$event !== null && (draft.publicSocialSharing = $event)"
                :label="gt('enablePublicSocialSharing')"
                color="primary"
                inset
                :disabled="locked"
                :hint="gt('publicSocialSharingHint')"
                persistent-hint
              />
            </div>
            <div class="general-setting-group">
              <h3>{{ gt('pageEditingActions') }}</h3>
              <p>
                {{ gt('chooseHowAuthorsReach') }}
              </p>
              <v-switch
                :model-value="draft.editFab"
                @update:model-value="$event !== null && (draft.editFab = $event)"
                :label="gt('showArticleEditShortcut')"
                color="primary"
                inset
                :disabled="locked"
              />
              <v-switch
                :model-value="draft.editMenuBar"
                @update:model-value="$event !== null && (draft.editMenuBar = $event)"
                :label="gt('showPageActionsMenu')"
                color="primary"
                inset
                :disabled="locked"
              />
              <v-switch
                :model-value="draft.editMenuBtn"
                @update:model-value="$event !== null && (draft.editMenuBtn = $event)"
                :label="gt('includeArticleEditShortcut')"
                color="primary"
                inset
                :disabled="locked || !draft.editMenuBar"
              />
              <v-switch
                :model-value="draft.editMenuExternalBtn"
                @update:model-value="$event !== null && (draft.editMenuExternalBtn = $event)"
                :label="gt('includeExternalSourceAction')"
                color="primary"
                inset
                :disabled="locked || !draft.editMenuBar"
              />
              <template v-if="draft.editMenuExternalBtn"
                ><v-text-field
                  v-model="draft.editMenuExternalName"
                  :label="gt('fieldLabels.editMenuExternalName')"
                  variant="outlined"
                  :disabled="locked"
                  maxlength="80"
                /><v-text-field
                  v-model="draft.editMenuExternalIcon"
                  :label="gt('fieldLabels.editMenuExternalIcon')"
                  variant="outlined"
                  :disabled="locked"
                  :hint="gt('mdiIconNameExample')"
                  persistent-hint
                /><v-text-field
                  v-model="draft.editMenuExternalUrl"
                  :label="gt('fieldLabels.editMenuExternalUrl')"
                  variant="outlined"
                  :disabled="locked"
                  :hint="gt('useFilenamePageSource')"
                  persistent-hint
                />
                <div class="general-source-preview">
                  <span class="general-kicker">{{ gt('exampleEnHandbookMd') }}</span
                  ><code>{{
                    sourcePreview ||
                    gt('enterValidSourceUrl')
                  }}</code>
                </div>
              </template>
            </div>
          </template>
          <template v-else-if="section === 'accounts'">
            <div class="general-heading">
              <span class="general-kicker">{{ gt('consistentStartingPoint') }}</span>
              <h2>{{ gt('newAccountPresentation') }}</h2>
              <p>
                {{ gt('theseDefaultsAppliedOnce') }}
              </p>
            </div>
            <div class="general-setting-group">
              <v-text-field
                v-model="draft.userDefaults.timezone"
                :label="gt('defaultTimeZone')"
                variant="outlined"
                :disabled="locked"
                :hint="gt('ianaTimeZoneExample')"
                persistent-hint
              />
              <v-select
                v-model="draft.userDefaults.dateFormat"
                :items="dateFormats"
                :label="gt('defaultDateFormat')"
                variant="outlined"
                :disabled="locked"
              />
              <v-select
                v-model="draft.userDefaults.timeFormat"
                :items="timeFormats"
                :label="gt('defaultTimeFormat')"
                variant="outlined"
                :disabled="locked"
              />
            </div>
            <p class="general-note">
              {{ gt('localeDefaultKeepsBrowsers') }}
            </p>
          </template>
          <template v-else>
            <div class="general-heading">
              <span class="general-kicker">{{ gt('workspaceDecisions') }}</span>
              <h2>{{ gt('changeHistory') }}</h2>
              <p>
                {{ gt('latest50SavedGeneral') }}
              </p>
            </div>
            <async-state
              v-if="!saved.history.length"
              state="empty"
              :title="gt('noGeneralChangesRecorded')"
              :message="gt('reviewedSavesWillAppear')"
            />
            <ol v-else class="general-activity">
              <li v-for="event in saved.history" :key="event.id">
                <div>
                  <strong>{{ event.reason }}</strong
                  ><time :datetime="event.createdAt">{{
                    date(event.createdAt)
                  }}</time>
                </div>
                <p>
                  {{
                    event.actorId
                      ? gt('account', { actorId: event.actorId, interpolation: { escapeValue: false } })
                      : gt('apiAdministrator')
                  }}
                </p>
                <ul>
                  <li v-for="field in event.fields" :key="field">
                    {{ labels[field as keyof GeneralPolicy] || field }}
                  </li>
                </ul>
              </li>
            </ol>
          </template>
        </section>
        <aside class="general-aside">
          <div class="general-identity-card">
            <span class="general-kicker">{{ gt('workspaceGlance') }}</span
            ><img
              v-if="logoUrl && !logoImageFailed"
              :key="logoUrl"
              :src="logoUrl"
              :data-logo-source="logoUrl"
              :alt="gt('currentWorkspaceLogo')"
              @error="handleLogoError"
              @load="handleLogoLoad"
            />
            <h3>{{ draft.title || gt('fieldLabels.title') }}</h3>
            <p>{{ draft.company || gt('sharedKnowledgeSpace') }}</p>
            <code :dir="draft.host ? 'ltr' : undefined">{{ draft.host || gt('publicAddressNotSet') }}</code
            ><span class="general-preview-label">{{
              dirty
                ? gt('identityPreviewUnsavedDraft')
                : gt('savedWorkspaceIdentity')
            }}</span>
          </div>
          <div class="general-panel">
            <span class="general-kicker">{{ gt('savedConfiguration') }}</span>
            <h3>
              {{
                saved.runtime.state === "applied"
                  ? gt('configurationCurrent')
                  : gt('activationNeedsAttention')
              }}
            </h3>
            <p>
              {{ gt('observedApplicationSettingsSaved', { state: saved.runtime.state === "applied" ? "match" : gt('differ'), interpolation: { escapeValue: false } }) }}
            </p>
            <p>{{ gt('lastObserved', { observedAt: date(saved.runtime.observedAt), interpolation: { escapeValue: false } }) }}</p>
            <v-btn
              v-if="saved.runtime.state !== 'applied'"
              variant="text"
              :disabled="locked || dirty"
              :loading="initializing"
              @click="initialize"
              >{{ gt('retryRuntimeActivation') }}</v-btn
            >
          </div>
          <div class="general-panel">
            <span class="general-kicker">{{ gt('relatedWorkspaces') }}</span
            ><router-link v-for="link in related" :key="link.to" :to="link.to"
              >{{ link.label }}<v-icon icon="mdi-arrow-top-right" size="16"
            /></router-link>
          </div>
        </aside>
      </div>
      <AdminNotificationSettings />
    </template>
    <v-dialog
      v-model="reviewing"
      max-width="760"
      :persistent="busy"
      aria-labelledby="general-review-title"
    >
      <v-card v-if="reviewed && saved" class="general-review"
        ><div class="general-review-heading">
          <span class="general-kicker">{{ gt('reviewBeforePublishing') }}</span>
          <h2 id="general-review-title">{{ gt('reviewWorkspaceSettings') }}</h2>
          <p>
            {{ gt('theseValuesFixedReview') }}
          </p>
        </div>
        <v-card-text
          ><dl class="general-differences">
            <div v-for="field in changes" :key="field">
              <dt>{{ labels[field] }}</dt>
              <dd>
                <span>{{ displayValue(field, saved!.policy[field]) }}</span
                ><v-icon icon="mdi-arrow-right" size="16" /><strong>{{
                  displayValue(field, reviewed![field])
                }}</strong>
              </dd>
            </div>
          </dl>
          <v-alert
            v-if="changes.includes('host')"
            type="warning"
            variant="tonal"
            class="mb-5"
            >{{ gt('generatedLinksIdentityProvider') }}</v-alert
          >
          <v-textarea
            v-model="reason"
            :label="gt('administrativeReason')"
            variant="outlined"
            rows="2"
            maxlength="1000"
            :disabled="busy"
          />
          <v-alert v-if="saveError" type="error" variant="tonal"
            >{{ saveError
            }}<v-btn
              v-if="stale"
              variant="text"
              :disabled="busy"
              @click="reloadReview"
              >{{ gt('reloadSavedSettings') }}</v-btn
            ></v-alert
          > </v-card-text
        ><v-card-actions
          ><v-btn variant="text" :disabled="busy" @click="reviewing = false"
            >{{ gt('keepEditing') }}</v-btn
          ><v-spacer /><v-btn
            color="primary"
            variant="flat"
            :data-commitment="!busy && !stale && reason.trim().length >= 3 ? 'active' : undefined"
            :disabled="busy || stale || reason.trim().length < 3"
            :loading="busy"
            @click="confirm"
            >{{ gt('saveWorkspaceSettings') }}</v-btn
          ></v-card-actions
        >
      </v-card>
    </v-dialog>
  </v-container>
</template>
<script lang="ts">
import { confirmDiscard } from "../common/confirm-dialog.ts";
import { wikiStore } from "@/store/index.ts";
import AsyncState from "@/components/common/async-state.vue";
import SiteBanner from "../common/site-banner.vue";
import GeneralLogoManager from "./general-logo-manager.vue";
import AdminNotificationSettings from "./admin-notification-settings.vue";
import { helpers } from "../../helpers/index.ts";
import {
  fetchGeneralWorkspace,
  saveGeneralWorkspace,
  retryGeneralRuntime,
} from "../../helpers/general-workspace-api.ts";
import {
  generalFieldLabels,
  generalChangedFields,
  validateGeneralPolicy,
  externalSourceUrl,
  type GeneralPolicy,
  type GeneralWorkspace,
} from "../../../shared/general-policy.ts";
import {
  siteBannerState,
  type SiteBannerConfig,
} from "../../../shared/site-banner.ts";
import { renderFooterMarkdown } from "../../helpers/footer-markdown.ts";
import { getErrorMessage } from "../../helpers/root-ui-store.ts";
import { useTranslate } from '../../helpers/use-translate.ts'
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const sections = [
  { key: "identity", title: "admin:general.identity" },
  { key: "announcement", title: "admin:general.fieldLabels.banner" },
  { key: "publishing", title: "admin:general.publishing" },
  { key: "accounts", title: "admin:general.accounts" },
  { key: "activity", title: "admin:general.activity" },
];
export default {
  components: { AsyncState, SiteBanner, GeneralLogoManager, AdminNotificationSettings },
  setup() {
    return { gt: useTranslate('admin:general') };
  },
  data() {
    return {
      saved: null as GeneralWorkspace | null,
      draft: null as GeneralPolicy | null,
      reviewed: null as GeneralPolicy | null,
      changes: [] as Array<keyof GeneralPolicy>,
      labels: Object.fromEntries(Object.entries(generalFieldLabels).map(([key, value]) => [key, this.$t(`admin:general.fieldLabels.${key}`, { defaultValue: value })])) as typeof generalFieldLabels,
      sections: sections.map((item) => ({ ...item, title: this.$t(item.title) })),
      section: "identity",
      loading: false,
      busy: false,
      initializing: false,
      stale: false,
      loadError: "",
      saveError: "",
      notice: "",
      attention: false,
      sequence: 0,
      failedLogoUrl: null as string | null,
      disposed: false,
      reviewing: false,
      reason: "",
      reviewFingerprint: "",
      now: Date.now(),
      clockTimer: undefined as number | undefined,
      announcementLabels: {
        disabled: this.gt('notPublished'),
        scheduled: this.gt('scheduledAppear'),
        ended: this.gt('publicationWindowEnded'),
        visible: this.gt('visibleDuringCurrentWindow'),
      },
      tones: [
        { title: this.gt('information'), value: "info" },
        { title: this.gt('notice'), value: "warning" },
        { title: this.gt('criticalUpdate'), value: "critical" },
      ],
      indexOptions: [
        { title: this.gt('searchEngineDefault'), value: "" },
        { title: this.gt('allowIndexing'), value: "index" },
        { title: this.gt('requestNoIndexing'), value: "noindex" },
      ],
      followOptions: [
        { title: this.gt('searchEngineDefault'), value: "" },
        { title: this.gt('allowFollowingLinks'), value: "follow" },
        { title: this.gt('requestNoFollowing'), value: "nofollow" },
      ],
      related: [
        { label: this.gt('editorsAuthoringDefaults'), to: "/editor" },
        { label: this.gt('pageDiscussions'), to: "/comments" },
        { label: this.gt('themeAppearance'), to: "/theme" },
        { label: this.gt('navigation'), to: "/navigation" },
        { label: this.gt('analytics'), to: "/analytics" },
      ],
    };
  },
  computed: {
    dirty(): boolean {
      return Boolean(
        this.saved &&
        this.draft &&
        generalChangedFields(this.saved.policy, this.draft).length,
      );
    },
    locked(): boolean {
      return this.busy || this.initializing || this.loading || this.stale;
    },
    logoUrl(): string {
      return wikiStore.site.logoUrl;
    },
    logoImageFailed(): boolean {
      return this.failedLogoUrl === this.logoUrl;
    },
    footerPreview(): string {
      return renderFooterMarkdown(this.draft?.footerOverride || "");
    },
    sourcePreview(): string {
      return externalSourceUrl(
        this.draft?.editMenuExternalUrl || "",
        "en/handbook.md",
      );
    },
    announcementState(): ReturnType<typeof siteBannerState> {
      return this.draft
        ? siteBannerState(this.draft.banner, this.now)
        : "disabled";
    },
    announcementExplanation(): string {
      if (this.announcementState === "disabled")
        return this.gt('messageRemainsAvailableEditing');
      if (this.announcementState === "scheduled")
        return this.gt('readersReceiveNoticePage');
      if (this.announcementState === "ended")
        return this.gt('chooseNewPublicationWindow');
      return this.dirty
        ? this.gt('draftsCurrentScheduleReview')
        : this.gt('savedAnnouncementAvailableReaders');
    },
    indexDirective(): string {
      return (
        this.draft?.robots.find((value) =>
          ["index", "noindex"].includes(value),
        ) || ""
      );
    },
    followDirective(): string {
      return (
        this.draft?.robots.find((value) =>
          ["follow", "nofollow"].includes(value),
        ) || ""
      );
    },
    licenses() {
      return [
        "",
        "alr",
        "cc0",
        "ccby",
        "ccbysa",
        "ccbynd",
        "ccbync",
        "ccbyncsa",
        "ccbyncnd",
      ].map((value) => ({
        value,
        title: this.$t("common:license." + (value || "none")),
      }));
    },
    dateFormats() {
      return [
        { title: this.gt('localeDefault'), value: "" },
        { title: "DD/MM/YYYY", value: "DD/MM/YYYY" },
        { title: "DD.MM.YYYY", value: "DD.MM.YYYY" },
        { title: "MM/DD/YYYY", value: "MM/DD/YYYY" },
        { title: "YYYY-MM-DD", value: "YYYY-MM-DD" },
        { title: "YYYY/MM/DD", value: "YYYY/MM/DD" },
      ];
    },
    timeFormats() {
      return [
        { title: this.gt('localeDefault'), value: "locale" },
        { title: this.gt('n12HourAmPm'), value: "12h" },
        { title: "24-hour", value: "24h" },
      ];
    },
  },
  watch: {
    "$route.hash": {
      immediate: true,
      handler(hash: string) {
        this.section = sections.some((section) => section.key === hash.slice(1))
          ? hash.slice(1)
          : "identity";
      },
    },
  },
  mounted() {
    void this.load();
    this.clockTimer = window.setInterval(() => {
      this.now = Date.now();
    }, 30000);
    window.addEventListener("beforeunload", this.beforeUnload);
  },
  beforeUnmount() {
    this.disposed = true;
    this.sequence++;
    window.clearInterval(this.clockTimer);
    window.removeEventListener("beforeunload", this.beforeUnload);
  },
  beforeRouteLeave(): Promise<boolean> {
    return this.canLeave();
  },
  async beforeRouteUpdate(to, from): Promise<boolean> {
    return (
      !this.busy &&
      !this.initializing &&
      (to.path === from.path || (await this.canLeave()))
    );
  },
  methods: {
    handleLogoError(event: Event): void {
      const image = event.currentTarget;
      if (!(image instanceof HTMLImageElement)) return;
      const source = image.getAttribute("data-logo-source");
      if (!source || source !== this.logoUrl) return;
      this.failedLogoUrl = source;
    },
    handleLogoLoad(event: Event): void {
      const image = event.currentTarget;
      if (!(image instanceof HTMLImageElement)) return;
      const source = image.getAttribute("data-logo-source");
      if (!source || source !== this.logoUrl) return;
      if (this.failedLogoUrl === source) this.failedLogoUrl = null;
    },
    async load() {
      if (this.busy) return;
      const seq = ++this.sequence;
      this.loading = true;
      this.loadError = "";
      try {
        const result = await fetchGeneralWorkspace();
        if (this.disposed || seq !== this.sequence) return;
        this.saved = result;
        this.draft = copy(result.policy);
        this.stale = false;
      } catch (error) {
        if (!this.disposed && seq === this.sequence) {
          this.loadError = getErrorMessage(error);
          this.stale = true;
        }
      } finally {
        if (!this.disposed && seq === this.sequence) this.loading = false;
      }
    },
    async reload() {
      if (this.busy || this.initializing) return;
      if (this.dirty && !(await confirmDiscard(this.gt('discardUnsavedWorkspaceChanges'))))
        return;
      await this.load();
    },
    reset() {
      if (this.locked || !this.saved) return;
      this.draft = copy(this.saved.policy);
      this.notice = "";
    },
    selectSection(key: string) {
      if (!this.busy && !this.initializing)
        void this.$router.replace({
          query: this.$route.query,
          hash: key === "identity" ? "" : "#" + key,
        });
    },
    date(value: string) {
      return Number.isNaN(new Date(value).valueOf()) ? "Invalid Date" : String(helpers.formatMoment(value, "L LT"));
    },
    dateInput(value?: string | null): string {
      return value ? value.slice(0, 16) : "";
    },
    setSchedule(key: "startsAt" | "endsAt", value: string | null) {
      if (!this.draft || this.locked) return;
      this.draft.banner[key] = value
        ? value.length === 16
          ? value + ":00Z"
          : value + "Z"
        : null;
    },
    setRobots(kind: "index" | "follow", value: string) {
      if (!this.draft || this.locked) return;
      const pair =
        kind === "index" ? ["index", "noindex"] : ["follow", "nofollow"];
      this.draft.robots = [
        ...this.draft.robots.filter((item) => !pair.includes(item)),
        ...(value ? [value] : []),
      ];
    },
    displayValue(
      field: keyof GeneralPolicy,
      value: GeneralPolicy[keyof GeneralPolicy],
    ): string {
      if (typeof value === "boolean") return value ? this.gt('shown') : this.gt('hidden');
      if (field === "banner") {
        const banner = value as SiteBannerConfig;
        return [
          banner.isEnabled ? this.gt('publishedDuringWindow') : this.gt('notPublished'),
          banner.title || this.gt('noTitle'),
          banner.content || this.gt('noMessage'),
          this.gt('tone', { tone: this.tones.find((tone) => tone.value === (banner.tone || "warning"))!.title, interpolation: { escapeValue: false } }),
          this.gt('starts', { startsAt: (banner.startsAt || this.gt('immediately')), interpolation: { escapeValue: false } }),
          this.gt('ends', { endsAt: (banner.endsAt || this.gt('untilDisabled')), interpolation: { escapeValue: false } }),
        ].join("\n");
      }
      if (field === "userDefaults") {
        const defaults = value as GeneralPolicy["userDefaults"];
        return [
          this.gt('timeZone', { timezone: defaults.timezone, interpolation: { escapeValue: false } }),
          this.gt('dateFormat', { dateFormat: (defaults.dateFormat || this.gt('localeDefault')), interpolation: { escapeValue: false } }),
          this.gt('timeFormat', { timeFormat: defaults.timeFormat, interpolation: { escapeValue: false } }),
        ].join("\n");
      }
      if (Array.isArray(value)) return value.join(", ") || this.gt('noneSelected');
      if (field === "contentLicense")
        return this.$t("common:license." + (value || "none"));
      return String(value || this.gt('notSet'));
    },
    review() {
      if (this.locked || !this.saved || !this.draft || !this.dirty) return;
      const validated = validateGeneralPolicy(this.draft);
      if (!validated.ok) {
        this.notice = validated.issues.join(" ");
        this.attention = true;
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      this.reviewed = copy(validated.value);
      this.changes = generalChangedFields(this.saved.policy, this.reviewed);
      if (!this.changes.length) {
        this.draft = copy(this.saved.policy);
        return;
      }
      this.reviewFingerprint = this.saved.fingerprint;
      this.reason = "";
      this.saveError = "";
      this.notice = "";
      this.reviewing = true;
    },
    async confirm() {
      if (
        this.locked ||
        !this.reviewing ||
        !this.reviewed ||
        this.reason.trim().length < 3
      )
        return;
      this.busy = true;
      this.saveError = "";
      try {
        const result = await saveGeneralWorkspace(
          this.reviewed,
          this.reviewFingerprint,
          this.reason.trim(),
        );
        if (this.disposed) return;
        this.saved = {
          ...this.saved!,
          policy: copy(this.reviewed),
          runtime: { ...this.saved!.runtime, state: "needs-attention" },
        };
        this.draft = copy(this.reviewed);
        Object.assign(wikiStore.site, {
          title: this.reviewed.title,
          company: this.reviewed.company,
          contentLicense: this.reviewed.contentLicense,
          footerOverride: this.reviewed.footerOverride,
          banner: copy(this.reviewed.banner),
        });
        this.reviewing = false;
        this.reviewed = null;
        this.reason = "";
        this.notice =
          this.gt('workspaceSettingsSaved', { activation: (result.activation === "needs-attention"
            ? ` ${this.gt('runtimeActivationNeedsAttention')}`
            : ""), interpolation: { escapeValue: false } });
        this.attention = result.activation === "needs-attention";
        this.busy = false;
        this.stale = true;
        await this.load();
      } catch (error) {
        if (!this.disposed) {
          const status =
            error && typeof error === "object"
              ? Reflect.get(error, "status")
              : 0;
          this.stale =
            !status ||
            Number(status) >= 500 ||
            [401, 403, 409].includes(status);
          this.saveError =
            getErrorMessage(error) +
            (!status
              ? ` ${this.gt('outcomeUnconfirmedReloadBefore')}`
              : "");
          if (this.stale) {
            this.notice =
              this.gt('reloadSavedSettingsBefore');
            this.attention = true;
          }
        }
      } finally {
        if (!this.disposed) this.busy = false;
      }
    },
    async reloadReview() {
      if (
        this.busy ||
        !(await confirmDiscard(
          this.gt('discardReviewLoadSaved'),
        ))
      )
        return;
      this.reviewing = false;
      await this.load();
    },
    async initialize() {
      if (this.locked || this.dirty || !this.saved) return;
      this.initializing = true;
      try {
        const result = await retryGeneralRuntime(this.saved.fingerprint);
        this.notice =
          result.activation === "applied"
            ? this.gt('runtimeWorkspaceConfigurationApplied')
            : this.gt('runtimeActivationNeedsAttention2');
        this.attention = result.activation !== "applied";
        await this.load();
      } catch (error) {
        this.notice = getErrorMessage(error);
        this.attention = true;
      } finally {
        this.initializing = false;
      }
    },
    async canLeave(): Promise<boolean> {
      return (
        !this.busy &&
        !this.initializing &&
        ((!this.dirty && !(this.reviewing && this.reason)) ||
          (await confirmDiscard(this.gt('discardUnsavedWorkspaceChanges'))))
      );
    },
    beforeUnload(event: BeforeUnloadEvent) {
      if (
        this.busy ||
        this.initializing ||
        this.dirty ||
        (this.reviewing && this.reason)
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    },
  },
};
</script>
<style lang="scss" src="./general-workspace.scss"></style>
