<template>
  <v-container fluid class="general-workspace">
    <admin-hero
      icon="mdi-tune-variant"
      title="General"
      description="Give your workspace its identity, voice and publishing conventions."
    >
      <template #actions>
        <v-btn
          variant="text"
          prepend-icon="mdi-refresh"
          :disabled="busy || initializing"
          :loading="loading"
          @click="reload"
          >Reload settings</v-btn
        >
        <v-btn v-if="dirty" variant="text" :disabled="locked" @click="reset"
          >Reset draft</v-btn
        >
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-check"
          :disabled="locked || !dirty"
          @click="review"
          >Review changes</v-btn
        >
      </template>
    </admin-hero>
    <async-state
      v-if="!saved && loading"
      state="loading"
      title="Loading workspace settings"
    />
    <async-state
      v-else-if="!saved && loadError"
      state="error"
      title="Workspace settings are unavailable"
      :message="loadError"
      retry-label="Try again"
      @retry="load"
    />
    <template v-if="saved && draft">
      <v-alert v-if="loadError" type="error" variant="tonal" class="mt-5"
        >{{ loadError
        }}<v-btn variant="text" :disabled="busy" @click="reload"
          >Reload saved settings</v-btn
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
            dirty ? "Unsaved workspace draft" : "Showing saved settings"
          }}</span
        ><span>{{
          saved.runtime.state === "applied"
            ? "Runtime configuration current"
            : "Runtime configuration needs attention"
        }}</span>
      </div>
      <nav class="general-tabs" aria-label="General sections">
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
              <span class="general-kicker">A place to know</span>
              <h2>Workspace identity</h2>
              <p>
                The name, address and attribution that make this knowledge space
                recognizable.
              </p>
            </div>
            <div class="general-setting-group">
              <v-text-field
                v-model="draft.title"
                label="Workspace name"
                variant="outlined"
                maxlength="50"
                counter="50"
                :disabled="locked"
                hint="Used in navigation, browser titles and workspace messages."
                persistent-hint
              />
              <v-text-field
                v-model="draft.host"
                label="Public address"
                variant="outlined"
                :disabled="locked"
                hint="The HTTP(S) origin used for generated links and identity-provider callbacks. Do not include a page path."
                persistent-hint
              />
              <p class="general-note">
                Changing the address does not configure DNS, certificates or a
                reverse proxy. Review identity-provider callbacks when the
                origin changes.
              </p>
            </div>
            <div class="general-setting-group">
              <h3>Workspace logo</h3>
              <general-logo-manager :disabled="locked || reviewing" />
            </div>
            <div class="general-setting-group">
              <h3>Attribution & footer</h3>
              <p>
                Set the organization and content attribution readers see at the
                foot of a page.
              </p>
              <v-text-field
                v-model="draft.company"
                label="Organization"
                variant="outlined"
                maxlength="255"
                :disabled="locked"
              />
              <v-select
                v-model="draft.contentLicense"
                :items="licenses"
                label="Content license"
                variant="outlined"
                :disabled="locked"
              />
              <v-textarea
                v-model="draft.footerOverride"
                label="Custom footer"
                variant="outlined"
                rows="3"
                auto-grow
                maxlength="8000"
                :disabled="locked"
                hint="Markdown. Leave empty to use the standard workspace footer."
                persistent-hint
              />
              <div v-if="draft.footerOverride" class="general-preview-fragment">
                <span class="general-kicker">Footer preview</span>
                <div class="general-markdown" v-html="footerPreview" />
              </div>
            </div>
          </template>
          <template v-else-if="section === 'announcement'">
            <div class="general-heading">
              <span class="general-kicker">The shared noticeboard</span>
              <h2>Workspace announcement</h2>
              <p>
                Give readers timely context: planned maintenance, an important
                change or a useful update.
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
                v-model="draft.banner.isEnabled"
                label="Publish this announcement"
                color="primary"
                inset
                :disabled="locked"
                hint="The announcement appears on wiki pages during its publication window."
                persistent-hint
              />
              <v-text-field
                v-model="draft.banner.title"
                label="Announcement title"
                variant="outlined"
                maxlength="160"
                counter="160"
                :disabled="locked"
              />
              <v-textarea
                v-model="draft.banner.content"
                label="Announcement message"
                variant="outlined"
                rows="6"
                auto-grow
                maxlength="8000"
                :disabled="locked"
                hint="Markdown is supported. Include a title or message before publishing."
                persistent-hint
              />
              <v-select
                :model-value="draft.banner.tone || 'warning'"
                :items="tones"
                label="Notice tone"
                variant="outlined"
                :disabled="locked"
                @update:model-value="draft.banner.tone = $event"
              />
            </div>
            <div class="general-setting-group">
              <h3>Publication window</h3>
              <p>
                Use UTC for an unambiguous schedule. A blank start publishes
                immediately; a blank end keeps the notice visible until you
                disable it.
              </p>
              <div class="general-pair">
                <v-text-field
                  :model-value="dateInput(draft.banner.startsAt)"
                  type="datetime-local"
                  step="60"
                  label="Starts at (UTC)"
                  variant="outlined"
                  clearable
                  :disabled="locked"
                  @update:model-value="setSchedule('startsAt', $event)"
                /><v-text-field
                  :model-value="dateInput(draft.banner.endsAt)"
                  type="datetime-local"
                  step="60"
                  label="Ends at (UTC)"
                  variant="outlined"
                  clearable
                  :disabled="locked"
                  @update:model-value="setSchedule('endsAt', $event)"
                />
              </div>
              <p class="general-note">
                Scheduled notices appear when a reader loads a page. Notices
                already open disappear at the end time. Your preview shows the
                draft outside this window, too.
              </p>
            </div>
            <div class="general-preview-fragment">
              <span class="general-kicker">Reader preview · unsaved draft</span
              ><site-banner
                v-if="draft.banner.title || draft.banner.content"
                :banner="{ ...draft.banner, isEnabled: true }"
                preview
              />
              <p v-else class="general-note">
                Add a title or message to preview the announcement.
              </p>
            </div>
          </template>
          <template v-else-if="section === 'publishing'">
            <div class="general-heading">
              <span class="general-kicker">Reader & author conventions</span>
              <h2>Publishing defaults</h2>
              <p>
                Help people discover pages and reach their source. Content
                permissions continue to govern who can read and edit.
              </p>
            </div>
            <div class="general-setting-group">
              <h3>Search presentation</h3>
              <p>
                Metadata for external search engines. These preferences do not
                change the wiki’s internal search or page access.
              </p>
              <v-textarea
                v-model="draft.description"
                label="Search description"
                variant="outlined"
                rows="3"
                maxlength="1000"
                :disabled="locked"
              />
              <div class="general-pair">
                <v-select
                  :model-value="indexDirective"
                  :items="indexOptions"
                  label="Index pages"
                  variant="outlined"
                  :disabled="locked"
                  @update:model-value="setRobots('index', $event)"
                /><v-select
                  :model-value="followDirective"
                  :items="followOptions"
                  label="Follow page links"
                  variant="outlined"
                  :disabled="locked"
                  @update:model-value="setRobots('follow', $event)"
                />
              </div>
              <div class="general-search-preview">
                <span>{{ draft.host || "Workspace address" }}</span
                ><strong>{{ draft.title || "Workspace name" }}</strong>
                <p>
                  {{
                    draft.description ||
                    "Your workspace description will appear here."
                  }}
                </p>
                <small
                  >Illustrative search preview. Search engines choose their own
                  snippets.</small
                >
              </div>
            </div>
            <div class="general-setting-group">
              <h3>Page URL extensions</h3>
              <p>
                Choose which file-like URLs resolve to wiki pages. Removing an
                extension can change how existing links are handled.
              </p>
              <v-combobox
                v-model="draft.pageExtensions"
                label="Recognized page extensions"
                variant="outlined"
                multiple
                chips
                closable-chips
                :disabled="locked"
                hint="Type an extension and press Enter. Use letters or digits without a leading dot."
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
                  No extension aliases. Extensionless page URLs remain
                  available.
                </p>
              </div>
            </div>
            <div class="general-setting-group">
              <h3>Page editing actions</h3>
              <p>
                Choose how authors reach the editor. These controls are shown
                only where page permissions allow them.
              </p>
              <v-switch
                v-model="draft.editFab"
                label="Show a floating edit button"
                color="primary"
                inset
                :disabled="locked"
              />
              <v-switch
                v-model="draft.editMenuBar"
                label="Show the page action bar"
                color="primary"
                inset
                :disabled="locked"
              />
              <v-switch
                v-model="draft.editMenuBtn"
                label="Include the edit action"
                color="primary"
                inset
                :disabled="locked || !draft.editMenuBar"
              />
              <v-switch
                v-model="draft.editMenuExternalBtn"
                label="Include an external source action"
                color="primary"
                inset
                :disabled="locked || !draft.editMenuBar"
              />
              <template v-if="draft.editMenuExternalBtn"
                ><v-text-field
                  v-model="draft.editMenuExternalName"
                  label="External action label"
                  variant="outlined"
                  :disabled="locked"
                  maxlength="80"
                /><v-text-field
                  v-model="draft.editMenuExternalIcon"
                  label="External action icon"
                  variant="outlined"
                  :disabled="locked"
                  hint="An mdi- icon name, for example mdi-github."
                  persistent-hint
                /><v-text-field
                  v-model="draft.editMenuExternalUrl"
                  label="External source URL"
                  variant="outlined"
                  :disabled="locked"
                  hint="Use {filename} for the page source path. HTTP(S) only."
                  persistent-hint
                />
                <div class="general-source-preview">
                  <span class="general-kicker">Example · en/handbook.md</span
                  ><code>{{
                    sourcePreview ||
                    "Enter a valid source URL to preview this destination."
                  }}</code>
                </div>
              </template>
            </div>
          </template>
          <template v-else-if="section === 'accounts'">
            <div class="general-heading">
              <span class="general-kicker">A consistent starting point</span>
              <h2>New account presentation</h2>
              <p>
                These defaults are applied once when a new human account is
                created. Existing accounts keep their saved preferences, and
                each person can override these values from their profile.
              </p>
            </div>
            <div class="general-setting-group">
              <v-text-field
                v-model="draft.userDefaults.timezone"
                label="Default time zone"
                variant="outlined"
                :disabled="locked"
                hint="IANA time zone, for example UTC or Europe/London."
                persistent-hint
              />
              <v-select
                v-model="draft.userDefaults.dateFormat"
                :items="dateFormats"
                label="Default date format"
                variant="outlined"
                :disabled="locked"
              />
              <v-select
                v-model="draft.userDefaults.timeFormat"
                :items="timeFormats"
                label="Default time format"
                variant="outlined"
                :disabled="locked"
              />
            </div>
            <p class="general-note">
              Locale default keeps the browser’s language convention. Saving
              does not rewrite existing profiles or system accounts.
            </p>
          </template>
          <template v-else>
            <div class="general-heading">
              <span class="general-kicker">Workspace decisions</span>
              <h2>Change history</h2>
              <p>
                The latest 50 saved General revisions, with their administrative
                reasons. Logo processing has its own status in Identity.
              </p>
            </div>
            <async-state
              v-if="!saved.history.length"
              state="empty"
              title="No General changes recorded yet"
              message="Reviewed saves will appear here. Earlier settings changes are not reconstructed."
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
                      ? `Account ${event.actorId}`
                      : "API administrator"
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
            <span class="general-kicker">Workspace at a glance</span
            ><img v-if="logoUrl" :src="logoUrl" alt="Current workspace logo" />
            <h3>{{ draft.title || "Workspace name" }}</h3>
            <p>{{ draft.company || "Your shared knowledge space" }}</p>
            <code>{{ draft.host || "Public address not set" }}</code
            ><span class="general-preview-label">{{
              dirty
                ? "Identity preview · unsaved draft"
                : "Saved workspace identity"
            }}</span>
          </div>
          <div class="general-panel">
            <span class="general-kicker">Saved configuration</span>
            <h3>
              {{
                saved.runtime.state === "applied"
                  ? "Configuration current"
                  : "Activation needs attention"
              }}
            </h3>
            <p>
              The observed application settings
              {{
                saved.runtime.state === "applied" ? "match" : "differ from"
              }}
              the saved configuration.
            </p>
            <p>Last observed {{ date(saved.runtime.observedAt) }}</p>
            <v-btn
              variant="text"
              :disabled="locked || dirty"
              :loading="initializing"
              @click="initialize"
              >Retry runtime activation</v-btn
            >
          </div>
          <div class="general-panel">
            <span class="general-kicker">Related workspaces</span
            ><router-link v-for="link in related" :key="link.to" :to="link.to"
              >{{ link.label }}<v-icon icon="mdi-arrow-top-right" size="16"
            /></router-link>
          </div>
        </aside>
      </div>
    </template>
    <v-dialog
      v-model="reviewing"
      max-width="760"
      :persistent="busy"
      aria-labelledby="general-review-title"
    >
      <v-card v-if="reviewed && saved" class="general-review"
        ><div class="general-review-heading">
          <span class="general-kicker">Review before publishing</span>
          <h2 id="general-review-title">Review workspace settings</h2>
          <p>
            These values are fixed for this review. Saved settings apply to the
            workspace; your logo is managed separately.
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
            >Generated links and identity-provider callbacks use the new public
            address. Confirm the destination and provider configuration before
            saving.</v-alert
          >
          <v-textarea
            v-model="reason"
            label="Administrative reason"
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
              >Reload saved settings</v-btn
            ></v-alert
          > </v-card-text
        ><v-card-actions
          ><v-btn variant="text" :disabled="busy" @click="reviewing = false"
            >Keep editing</v-btn
          ><v-spacer /><v-btn
            color="primary"
            variant="flat"
            :disabled="busy || stale || reason.trim().length < 3"
            :loading="busy"
            @click="confirm"
            >Save workspace settings</v-btn
          ></v-card-actions
        >
      </v-card>
    </v-dialog>
  </v-container>
</template>
<script lang="ts">
import { wikiStore } from "@/store/index.ts";
import AsyncState from "@/components/common/async-state.vue";
import SiteBanner from "../common/site-banner.vue";
import GeneralLogoManager from "./general-logo-manager.vue";
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
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const sections = [
  { key: "identity", title: "Identity" },
  { key: "announcement", title: "Announcement" },
  { key: "publishing", title: "Publishing" },
  { key: "accounts", title: "Accounts" },
  { key: "activity", title: "Activity" },
];
export default {
  components: { AsyncState, SiteBanner, GeneralLogoManager },
  data() {
    return {
      saved: null as GeneralWorkspace | null,
      draft: null as GeneralPolicy | null,
      reviewed: null as GeneralPolicy | null,
      changes: [] as Array<keyof GeneralPolicy>,
      labels: generalFieldLabels,
      sections,
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
      disposed: false,
      reviewing: false,
      reason: "",
      reviewFingerprint: "",
      now: Date.now(),
      clockTimer: undefined as number | undefined,
      announcementLabels: {
        disabled: "Not published",
        scheduled: "Scheduled to appear",
        ended: "Publication window ended",
        visible: "Visible during the current window",
      },
      tones: [
        { title: "Information", value: "info" },
        { title: "Notice", value: "warning" },
        { title: "Critical update", value: "critical" },
      ],
      indexOptions: [
        { title: "Search engine default", value: "" },
        { title: "Allow indexing", value: "index" },
        { title: "Request no indexing", value: "noindex" },
      ],
      followOptions: [
        { title: "Search engine default", value: "" },
        { title: "Allow following links", value: "follow" },
        { title: "Request no following", value: "nofollow" },
      ],
      related: [
        { label: "Editors & authoring defaults", to: "/editor" },
        { label: "Page discussions", to: "/comments" },
        { label: "Theme & appearance", to: "/theme" },
        { label: "Navigation", to: "/navigation" },
        { label: "Analytics", to: "/analytics" },
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
        return "The message remains available for editing.";
      if (this.announcementState === "scheduled")
        return "Readers receive this notice on page loads after its start time.";
      if (this.announcementState === "ended")
        return "Choose a new publication window to show this notice again.";
      return this.dirty
        ? "This is the draft’s current schedule. Review and save to publish your changes."
        : "The saved announcement is available to readers loading a wiki page.";
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
        { title: "Locale default", value: "" },
        { title: "DD/MM/YYYY", value: "DD/MM/YYYY" },
        { title: "DD.MM.YYYY", value: "DD.MM.YYYY" },
        { title: "MM/DD/YYYY", value: "MM/DD/YYYY" },
        { title: "YYYY-MM-DD", value: "YYYY-MM-DD" },
        { title: "YYYY/MM/DD", value: "YYYY/MM/DD" },
      ];
    },
    timeFormats() {
      return [
        { title: "Locale default", value: "locale" },
        { title: "12-hour (AM/PM)", value: "12h" },
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
  beforeRouteLeave(): boolean {
    return this.canLeave();
  },
  beforeRouteUpdate(to, from): boolean {
    return (
      !this.busy &&
      !this.initializing &&
      (to.path === from.path || this.canLeave())
    );
  },
  methods: {
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
      if (this.dirty && !window.confirm("Discard unsaved workspace changes?"))
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
      return new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
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
      if (typeof value === "boolean") return value ? "Shown" : "Hidden";
      if (field === "banner") {
        const banner = value as SiteBannerConfig;
        return [
          banner.isEnabled ? "Published during its window" : "Not published",
          banner.title || "No title",
          banner.content || "No message",
          "Tone: " + (banner.tone || "warning"),
          "Starts: " + (banner.startsAt || "Immediately"),
          "Ends: " + (banner.endsAt || "Until disabled"),
        ].join("\n");
      }
      if (field === "userDefaults") {
        const defaults = value as GeneralPolicy["userDefaults"];
        return [
          "Time zone: " + defaults.timezone,
          "Date format: " + (defaults.dateFormat || "Locale default"),
          "Time format: " + defaults.timeFormat,
        ].join("\n");
      }
      if (Array.isArray(value)) return value.join(", ") || "None selected";
      if (field === "contentLicense")
        return this.$t("common:license." + (value || "none"));
      return String(value || "Not set");
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
          "Workspace settings saved." +
          (result.activation === "needs-attention"
            ? " Runtime activation needs attention."
            : "");
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
              ? " The outcome is unconfirmed. Reload before saving again."
              : "");
          if (this.stale) {
            this.notice =
              "Reload saved settings before another review. Your draft is retained.";
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
        !window.confirm(
          "Discard this review and load saved workspace settings?",
        )
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
            ? "Runtime workspace configuration applied."
            : "Runtime activation needs attention. Review server diagnostics.";
        this.attention = result.activation !== "applied";
        await this.load();
      } catch (error) {
        this.notice = getErrorMessage(error);
        this.attention = true;
      } finally {
        this.initializing = false;
      }
    },
    canLeave(): boolean {
      return (
        !this.busy &&
        !this.initializing &&
        ((!this.dirty && !(this.reviewing && this.reason)) ||
          window.confirm("Discard unsaved workspace changes?"))
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
