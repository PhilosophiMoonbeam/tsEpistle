<template>
  <v-container fluid class="navigation-workspace">
    <admin-hero
      icon="mdi-compass-outline"
      title="Navigation"
      description="Give every reader a clear way into your knowledge."
      ><template #actions
        ><v-btn
          variant="text"
          prepend-icon="mdi-refresh"
          :loading="loading"
          :disabled="busy || initializing"
          @click="reload"
          >{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">Reload saved navigation</v-tooltip></v-btn
        ><v-btn v-if="dirty" variant="text" :disabled="locked" @click="reset"
          >Reset draft</v-btn
        ><v-btn
          color="primary"
          variant="flat"
          :disabled="locked || !dirty"
          @click="review"
          >Review changes</v-btn
        ></template
      ></admin-hero
    >
    <p v-if="!saved && loading" class="navigation-empty" role="status">
      Loading navigation, locales and audiences…
    </p>
    <v-alert v-if="loadError" type="error" variant="tonal"
      >{{ loadError
      }}<v-btn variant="text" :disabled="busy" @click="reload"
        >Reload saved settings</v-btn
      ></v-alert
    >
    <v-alert
      v-if="notice"
      :type="attention ? 'warning' : 'success'"
      variant="tonal"
      class="mt-4"
      >{{ notice }}</v-alert
    >
    <template v-if="saved && draft">
      <div class="navigation-status">
        <span
          ><i :class="{ 'is-draft': dirty }" />{{
            dirty ? "Unsaved navigation draft" : "Showing saved navigation"
          }}</span
        ><span>{{
          saved.runtime.state === "applied"
            ? "Runtime configuration current"
            : "Runtime activation needs attention"
        }}</span>
      </div>
      <nav class="navigation-tabs" aria-label="Navigation sections">
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
      <div class="navigation-layout">
        <section class="navigation-editor">
          <template v-if="section === 'structure'">
            <div class="navigation-heading">
              <span class="navigation-kicker"
                >01 / A useful wayfinding system</span
              >
              <h2>Arrange the essentials</h2>
              <p>
                Build a purposeful menu for each language. Group related links,
                establish a reading order and keep audiences in view.
              </p>
            </div>
            <v-alert v-if="!customMode" type="info" variant="tonal" class="mb-5"
              >{{
                draft.mode === "NONE"
                  ? "The sidebar is hidden."
                  : "The sidebar currently shows the page directory."
              }}
              Custom menus remain editable here. Choose a custom-menu display
              mode to show them.</v-alert
            >
            <div class="navigation-toolbar">
              <v-select
                v-model="currentLocale"
                :items="localeOptions"
                item-title="title"
                item-value="code"
                label="Menu locale"
                variant="outlined"
                density="compact"
                hide-details
                :disabled="locked"
              /><v-btn
                variant="text"
                prepend-icon="mdi-content-copy"
                :disabled="locked || !copyOptions.length"
                @click="openCopy"
                >Copy from locale</v-btn
              ><v-btn
                variant="text"
                class="navigation-preview-jump"
                @click="
                  previewPanel?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start',
                  })
                "
                >Preview this menu</v-btn
              >
            </div>
            <p v-if="!currentLocaleEnabled" class="navigation-note mb-5">
              This locale is retained for editing but is not enabled for
              readers. Manage language availability in
              <router-link to="/locale">Locale</router-link>.
            </p>
            <div class="navigation-builder">
              <section class="navigation-structure" aria-label="Menu structure">
                <div class="navigation-section-title">
                  <h3>Menu order</h3>
                  <span>{{ currentItems.length }} / {{ maxItems }}</span>
                </div>
                <div class="navigation-home">
                  <v-icon icon="mdi-home-outline" size="18" /><span>Home</span
                  ><small>Built in</small>
                </div>
                <navigation-outline
                  :items="currentItems"
                  :selected="selectedId"
                  :disabled="locked"
                  @select="selectedId = $event"
                  @reorder="setItems"
                />
                <div v-if="!currentItems.length" class="navigation-empty">
                  <v-icon icon="mdi-sign-direction" size="28" />
                  <h3>A starting point</h3>
                  <p>
                    Add a page link, then organize related destinations with
                    headings.
                  </p>
                </div>
                <div class="navigation-add">
                  <v-btn
                    variant="tonal"
                    prepend-icon="mdi-plus"
                    :disabled="locked || currentItems.length >= maxItems"
                    @click="addItem('link')"
                    >Add link</v-btn
                  ><v-menu
                    ><template #activator="{ props }"
                      ><v-btn
                        v-bind="props"
                        variant="text"
                        icon="mdi-dots-horizontal"
                        aria-label="Add a heading or divider"
                        :disabled="
                          locked || currentItems.length >= maxItems
                        " /></template
                    ><v-list
                      ><v-list-item
                        title="Add heading"
                        prepend-icon="mdi-format-title"
                        @click="addItem('header')" /><v-list-item
                        title="Add divider"
                        prepend-icon="mdi-minus"
                        @click="addItem('divider')" /></v-list
                  ></v-menu>
                </div>
                <p class="navigation-note">
                  Drag a handle, or focus it and press Space to reorder with the
                  arrow keys.
                </p>
              </section>
              <section
                class="navigation-item-editor"
                aria-label="Selected menu item"
              >
                <template v-if="selected"
                  ><div class="navigation-section-title">
                    <h3>
                      {{
                        selected.kind === "link"
                          ? "Link details"
                          : selected.kind === "header"
                            ? "Section heading"
                            : "Divider"
                      }}
                    </h3>
                    <span
                      >{{ selectedIndex + 1 }} of
                      {{ currentItems.length }}</span
                    >
                  </div>
                  <div class="navigation-item-position">
                    <v-btn
                      size="small"
                      variant="text"
                      prepend-icon="mdi-arrow-up"
                      :disabled="locked || selectedIndex === 0"
                      @click="moveItem(-1)"
                      >Move up</v-btn
                    ><v-btn
                      size="small"
                      variant="text"
                      prepend-icon="mdi-arrow-down"
                      :disabled="
                        locked || selectedIndex === currentItems.length - 1
                      "
                      @click="moveItem(1)"
                      >Move down</v-btn
                    >
                  </div>
                  <v-text-field
                    v-if="selected.kind !== 'divider'"
                    v-model="selected.label"
                    label="Menu label"
                    maxlength="255"
                    counter="255"
                    variant="outlined"
                    :disabled="locked"
                  />
                  <template v-if="selected.kind === 'link'"
                    ><v-text-field
                      v-model="selected.icon"
                      label="Icon"
                      variant="outlined"
                      :disabled="locked"
                      hint="An mdi- icon name, or a Font Awesome class from your Theme icon library."
                      persistent-hint
                      ><template #append-inner
                        ><v-icon
                          :icon="selected.icon || 'mdi-link-variant'"
                          size="20" /></template></v-text-field
                    ><v-select
                      v-model="selected.targetType"
                      :items="targetOptions"
                      label="Destination type"
                      variant="outlined"
                      :disabled="locked"
                      class="mt-5"
                    /><v-text-field
                      v-model="selected.target"
                      :label="
                        selected.targetType === 'page'
                          ? 'Page path'
                          : 'External address'
                      "
                      variant="outlined"
                      :disabled="locked"
                      :error-messages="
                        selected.target && !destination
                          ? ['Enter a valid destination for this link type.']
                          : []
                      "
                      :hint="
                        selected.targetType === 'page'
                          ? 'A workspace path, such as /en/guide. Anchors and query strings are supported.'
                          : 'HTTP(S), mailto: or tel:. External destinations are not fetched by this editor.'
                      "
                      persistent-hint
                    /><v-btn
                      v-if="selected.targetType === 'page'"
                      class="mt-3"
                      variant="text"
                      prepend-icon="mdi-file-search-outline"
                      :disabled="locked"
                      @click="selectPageOpen = true"
                      >Choose a page</v-btn
                    >
                    <p v-if="destination" class="navigation-destination">
                      <span>Destination</span><code>{{ destination }}</code>
                    </p></template
                  >
                  <p
                    v-else-if="selected.kind === 'divider'"
                    class="navigation-note"
                  >
                    Separate related groups of links. Redundant separators are
                    omitted from the reader’s menu.
                  </p>
                  <div class="navigation-setting-group">
                    <h3>Audience</h3>
                    <v-radio-group
                      v-model="selected.visibilityMode"
                      :disabled="locked"
                      hide-details
                      label="Who sees this item?"
                      ><v-radio
                        label="Everyone who can open the workspace"
                        value="all" /><v-radio
                        label="Members of selected groups"
                        value="restricted" /></v-radio-group
                    ><v-select
                      v-if="selected.visibilityMode === 'restricted'"
                      v-model="selected.visibilityGroups"
                      :items="saved.groups"
                      item-title="name"
                      item-value="id"
                      label="Audience groups"
                      variant="outlined"
                      multiple
                      chips
                      closable-chips
                      :disabled="locked"
                      class="mt-5"
                    />
                    <p
                      v-if="
                        selected.visibilityMode === 'restricted' &&
                        !selected.visibilityGroups.length
                      "
                      class="navigation-note mt-3"
                    >
                      No group is selected. This item will be hidden from every
                      audience.
                    </p>
                    <p class="navigation-note mt-4">
                      Menu visibility does not grant access to a page. Page
                      permissions and publication rules still apply.
                    </p>
                  </div>
                  <div class="navigation-item-actions">
                    <v-btn
                      variant="text"
                      prepend-icon="mdi-content-copy"
                      :disabled="locked || currentItems.length >= maxItems"
                      @click="duplicateItem"
                      >Duplicate item</v-btn
                    ><v-btn
                      variant="text"
                      prepend-icon="mdi-delete-outline"
                      :disabled="locked"
                      @click="removeItem"
                      >Remove item</v-btn
                    >
                  </div>
                </template>
                <div v-else class="navigation-empty">
                  <v-icon icon="mdi-cursor-default-click-outline" size="28" />
                  <h3>Choose an item</h3>
                  <p>
                    Select a link, heading or divider to refine its destination
                    and audience.
                  </p>
                </div>
              </section>
            </div>
          </template>
          <template v-else-if="section === 'display'">
            <div class="navigation-heading">
              <span class="navigation-kicker"
                >02 / Paths into the workspace</span
              >
              <h2>Choose how readers explore</h2>
              <p>
                Balance a curated menu with the page directory. Switching
                display mode keeps every locale’s custom structure.
              </p>
            </div>
            <fieldset class="navigation-mode-grid" :disabled="locked">
              <legend class="navigation-sr-only">Sidebar display mode</legend>
              <label
                v-for="option in modeOptions"
                :key="option.value"
                :class="{ 'is-selected': draft.mode === option.value }"
                ><input
                  v-model="draft.mode"
                  type="radio"
                  name="navigation-display-mode"
                  :value="option.value"
                /><v-icon :icon="option.icon" size="22" /><strong>{{
                  option.title
                }}</strong
                ><span>{{ option.description }}</span></label
              >
            </fieldset>
            <div class="navigation-setting-group">
              <h3>Where Browse begins</h3>
              <v-switch
                v-model="draft.expandParent"
                inset
                :disabled="locked"
                label="Open the current page’s parent directory"
                color="primary"
                hide-details
              />
              <p class="navigation-note mt-3">
                When off, Browse starts at the site root. This setting applies
                to Page directory and Menu + directory modes.
              </p>
            </div>
            <div class="navigation-setting-group">
              <div class="navigation-section-title">
                <h3>Locale coverage</h3>
                <router-link to="/locale">Manage languages ↗</router-link>
              </div>
              <p class="navigation-note mb-5">
                Each language has its own menu. Copying a structure preserves
                the original labels and destinations until you edit them.
              </p>
              <div
                v-for="locale in localeOptions"
                :key="locale.code"
                class="navigation-locale-row"
              >
                <div>
                  <strong>{{ locale.name }}</strong
                  ><small
                    >{{ locale.code }} ·
                    {{
                      locale.enabled
                        ? "Enabled for readers"
                        : "Not enabled for readers"
                    }}</small
                  >
                </div>
                <span
                  >{{
                    draft.tree.find((tree) => tree.locale === locale.code)
                      ?.items.length || 0
                  }}
                  items</span
                ><v-btn
                  size="small"
                  variant="text"
                  :disabled="locked"
                  @click="editLocale(locale.code)"
                  >Edit menu</v-btn
                ><v-btn
                  v-if="draft.tree.some((tree) => tree.locale === locale.code)"
                  icon="mdi-delete-outline"
                  size="small"
                  variant="text"
                  :aria-label="'Remove menu for ' + locale.name"
                  :disabled="locked"
                  @click="removeLocale(locale.code)"
                />
              </div>
            </div>
          </template>
          <template v-else
            ><div class="navigation-heading">
              <span class="navigation-kicker">03 / Publication record</span>
              <h2>A considered path forward</h2>
              <p>
                The latest 50 navigation publications, with the administrator’s
                reason and affected language structures.
              </p>
            </div>
            <p v-if="!saved.history.length" class="navigation-empty">
              No navigation changes have been recorded yet.
            </p>
            <article
              v-for="event in saved.history"
              :key="event.id"
              class="navigation-event"
            >
              <time>{{ date(event.createdAt) }}</time>
              <h3>{{ event.reason }}</h3>
              <p>{{ event.fields.map(fieldLabel).join(" · ") }}</p>
              <small>{{
                event.actorId === null
                  ? "API administrator"
                  : "Administrator #" + event.actorId
              }}</small>
            </article></template
          >
        </section>
        <aside ref="previewPanel" class="navigation-preview-panel">
          <div class="navigation-preview-heading">
            <span class="navigation-kicker">Audience preview</span
            ><strong>{{ currentLocale }} / {{ modeName(draft.mode) }}</strong>
          </div>
          <v-select
            v-model="previewAudience"
            :items="audienceOptions"
            label="Preview as"
            variant="outlined"
            density="compact"
            hide-details
          /><v-select
            v-if="previewAudience === 'groups'"
            v-model="previewGroups"
            :items="saved.groups"
            item-title="name"
            item-value="id"
            label="Preview groups"
            variant="outlined"
            multiple
            chips
            closable-chips
            class="mt-4"
            hide-details
          /><navigation-preview
            :items="currentItems"
            :groups="audienceGroups"
            :mode="draft.mode"
            :locale="currentLocale"
          />
          <p v-if="customMode" class="navigation-note">
            {{ visibleItems.filter((item) => item.kind === "link").length }} of
            {{ currentItems.filter((item) => item.kind === "link").length }}
            custom links visible to this audience. Empty headings and redundant
            separators are omitted.
          </p>
          <p v-else class="navigation-note">
            Custom links are retained but are not shown in this display mode.
          </p>
          <p class="navigation-note mt-3">
            This previews menu visibility, not page access. Destinations remain
            subject to their own permissions.
          </p>
          <div class="navigation-setting-group">
            <h3>Publication</h3>
            <p class="navigation-note">
              Readers receive the saved menu on their next page load. Unsaved
              changes stay in this editor.
            </p>
            <v-btn
              v-if="saved.runtime.state !== 'applied'"
              class="mt-4"
              variant="tonal"
              :loading="initializing"
              :disabled="locked || dirty"
              @click="initialize"
              >Retry runtime activation</v-btn
            >
          </div>
        </aside>
      </div>
      <div v-if="dirty" class="navigation-savebar">
        <span
          >Navigation draft · {{ changedFields.length }} changed
          {{ changedFields.length === 1 ? "area" : "areas" }}</span
        ><v-btn variant="text" :disabled="locked" @click="reset">Reset</v-btn
        ><v-btn
          color="primary"
          variant="flat"
          :disabled="locked"
          @click="review"
          >Review changes</v-btn
        >
      </div>
    </template>
    <page-selector
      v-model="selectPageOpen"
      mode="select"
      :must-exist="true"
      :open-handler="selectPage"
      path="home"
      :locale="currentLocale"
    />
    <v-dialog v-model="copyOpen" max-width="580"
      ><v-card title="Copy a locale menu"
        ><v-card-text
          ><p class="mb-5">
            Copy into {{ currentLocale }}. Labels, destinations and audience
            groups retain their source values. Changes stay in this draft until
            you publish.
          </p>
          <v-select
            v-model="copySource"
            :items="copyOptions"
            item-title="title"
            item-value="code"
            label="Source locale"
            variant="outlined"
          /><v-radio-group v-model="copyMode" label="How to copy"
            ><v-radio label="Append to this menu" value="append" /><v-radio
              label="Replace this menu"
              value="replace"
          /></v-radio-group>
          <p>
            {{ copyCount }} source items · {{ currentItems.length }} current
            items
          </p>
          <v-alert
            v-if="copyMode === 'replace'"
            type="info"
            variant="tonal"
            class="mt-4"
            >The current draft menu for {{ currentLocale }} will be replaced.
            Reset the draft to recover the saved menu.</v-alert
          ></v-card-text
        ><v-card-actions
          ><v-btn @click="copyOpen = false">Cancel</v-btn><v-spacer /><v-btn
            variant="flat"
            color="primary"
            :disabled="locked || !copyCount || copyTotal > maxItems"
            @click="copyLocale"
            >Copy {{ copyCount }} items</v-btn
          ></v-card-actions
        ></v-card
      ></v-dialog
    >
    <v-dialog v-model="reviewing" :persistent="busy" max-width="950"
      ><v-card v-if="saved && reviewed" title="Publish navigation changes"
        ><v-card-text
          ><p class="mb-5">
            Review the complete affected structures. Item order, destinations
            and audiences below are the exact draft being published.
          </p>
          <details
            v-for="field in reviewFields"
            :key="field"
            class="navigation-review-field"
            open
          >
            <summary>{{ fieldLabel(field) }}</summary>
            <div>
              <section>
                <strong>Saved</strong>
                <pre tabindex="0">{{ reviewValue(saved.policy, field) }}</pre>
              </section>
              <section>
                <strong>Publishing</strong>
                <pre tabindex="0">{{ reviewValue(reviewed, field) }}</pre>
              </section>
            </div>
          </details>
          <v-textarea
            v-model="reason"
            label="Reason for this change"
            variant="outlined"
            rows="2"
            maxlength="1000"
            :disabled="busy || stale"
            class="mt-5"
            hint="3–1,000 characters. Recorded with this publication."
            persistent-hint
          /><v-alert
            v-if="saveError"
            type="error"
            variant="tonal"
            class="mt-4"
            >{{ saveError }}</v-alert
          ></v-card-text
        ><v-card-actions
          ><v-btn :disabled="busy" @click="reviewing = false"
            >Back to draft</v-btn
          ><v-spacer /><v-btn
            v-if="stale"
            :disabled="busy"
            @click="reloadReview"
            >Reload saved settings</v-btn
          ><v-btn
            color="primary"
            variant="flat"
            :loading="busy"
            :disabled="locked || reason.trim().length < 3"
            @click="confirm"
            >Publish navigation</v-btn
          ></v-card-actions
        ></v-card
      ></v-dialog
    >
  </v-container>
</template>
<script setup lang="ts">
import { confirmDiscard, requestConfirmation } from "../common/confirm-dialog.ts";
import {
  computed,
  ref,
  watch,
  onMounted,
  onBeforeUnmount,
  useTemplateRef,
} from "vue";
import {
  useRoute,
  useRouter,
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
} from "vue-router";
import NavigationOutline from "./navigation-outline.vue";
import NavigationPreview from "./navigation-preview.vue";
import {
  NavigationPolicySchema,
  navigationChangedFields,
  navigationMenuItems,
  navigationDestination,
  MAX_NAVIGATION_ITEMS,
  type NavigationPolicy,
  type NavigationItem,
  type NavigationWorkspace,
} from "../../../shared/navigation-policy.ts";
import {
  fetchNavigationWorkspace,
  saveNavigationWorkspace,
  retryNavigationRuntime,
} from "../../helpers/navigation-workspace-api.ts";
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Navigation administration is unavailable.";
const route = useRoute(),
  router = useRouter(),
  previewPanel = useTemplateRef<HTMLElement>("previewPanel");
const saved = ref<NavigationWorkspace | null>(null),
  draft = ref<NavigationPolicy | null>(null),
  reviewed = ref<NavigationPolicy | null>(null);
const loading = ref(false),
  busy = ref(false),
  initializing = ref(false),
  stale = ref(false),
  reviewing = ref(false),
  copyOpen = ref(false),
  selectPageOpen = ref(false);
const loadError = ref(""),
  saveError = ref(""),
  notice = ref(""),
  attention = ref(false),
  reason = ref(""),
  reviewFingerprint = ref(""),
  selectedId = ref(""),
  currentLocale = ref(siteConfig.lang);
const copySource = ref(""),
  copyMode = ref<"append" | "replace">("append"),
  previewAudience = ref("visitor"),
  previewGroups = ref<number[]>([]);
const sections = [
  { key: "structure", title: "Menu structure" },
  { key: "display", title: "Display & locales" },
  { key: "activity", title: "Activity" },
];
const modeOptions = [
  {
    value: "MIXED",
    title: "Menu + directory",
    icon: "mdi-view-split-vertical",
    description: "Curated links, with Browse alongside.",
  },
  {
    value: "STATIC",
    title: "Custom menu",
    icon: "mdi-format-list-bulleted",
    description: "A focused set of hand-picked destinations.",
  },
  {
    value: "TREE",
    title: "Page directory",
    icon: "mdi-file-tree-outline",
    description: "Explore the hierarchy of accessible pages.",
  },
  {
    value: "NONE",
    title: "Hidden sidebar",
    icon: "mdi-dock-left",
    description: "Leave more room for the page itself.",
  },
];
const targetOptions = [
  { title: "Wiki page", value: "page" },
  { title: "External link", value: "external" },
  { title: "External link in a new tab", value: "externalblank" },
];
const audienceOptions = [
  { title: "Visitor / guest account", value: "visitor" },
  { title: "Selected groups", value: "groups" },
];
const section = computed(
  () =>
    sections.find((item) => "#" + item.key === route.hash)?.key || "structure",
);
const locked = computed(
  () =>
    loading.value ||
    busy.value ||
    initializing.value ||
    stale.value ||
    !saved.value,
);
const changedFields = computed(() =>
  saved.value && draft.value
    ? navigationChangedFields(saved.value.policy, draft.value)
    : [],
);
const dirty = computed(() => changedFields.value.length > 0);
const reviewFields = computed(() =>
  saved.value && reviewed.value
    ? navigationChangedFields(saved.value.policy, reviewed.value)
    : [],
);
const currentItems = computed(
  () =>
    draft.value?.tree.find((tree) => tree.locale === currentLocale.value)
      ?.items || [],
);
const selected = computed(() =>
  currentItems.value.find((item) => item.id === selectedId.value),
);
const selectedIndex = computed(() =>
  currentItems.value.findIndex((item) => item.id === selectedId.value),
);
const destination = computed(() =>
  navigationDestination(selected.value?.targetType, selected.value?.target),
);
const customMode = computed(() =>
  ["MIXED", "STATIC"].includes(draft.value?.mode || ""),
);
const maxItems = MAX_NAVIGATION_ITEMS;
const localeOptions = computed(() => {
  const locales = new Map(
    saved.value?.locales.map((locale) => [locale.code, locale]),
  );
  for (const tree of draft.value?.tree || [])
    if (!locales.has(tree.locale))
      locales.set(tree.locale, {
        code: tree.locale,
        name: tree.locale,
        nativeName: tree.locale,
        enabled: false,
      });
  if (saved.value && !locales.has(saved.value.defaultLocale))
    locales.set(saved.value.defaultLocale, {
      code: saved.value.defaultLocale,
      name: saved.value.defaultLocale,
      nativeName: saved.value.defaultLocale,
      enabled: true,
    });
  return [...locales.values()]
    .map((locale) => ({
      ...locale,
      title: `${locale.nativeName} (${locale.code})`,
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
});
const currentLocaleEnabled = computed(
  () =>
    localeOptions.value.find((locale) => locale.code === currentLocale.value)
      ?.enabled,
);
const copyOptions = computed(() =>
  localeOptions.value.filter(
    (locale) =>
      locale.code !== currentLocale.value &&
      draft.value?.tree.some(
        (tree) => tree.locale === locale.code && tree.items.length,
      ),
  ),
);
const copyCount = computed(
  () =>
    draft.value?.tree.find((tree) => tree.locale === copySource.value)?.items
      .length || 0,
);
const copyTotal = computed(
  () =>
    copyCount.value +
    (copyMode.value === "append" ? currentItems.value.length : 0),
);
const audienceGroups = computed(() =>
  previewAudience.value === "visitor"
    ? saved.value?.guestGroups || []
    : previewGroups.value,
);
const visibleItems = computed(() =>
  navigationMenuItems(currentItems.value, audienceGroups.value),
);
let sequence = 0,
  disposed = false;
watch(currentLocale, () => {
  selectedId.value = currentItems.value[0]?.id || "";
});
async function load() {
  if (busy.value) return;
  const seq = ++sequence;
  loading.value = true;
  loadError.value = "";
  try {
    const result = await fetchNavigationWorkspace();
    if (disposed || seq !== sequence) return;
    saved.value = result;
    draft.value = copy(result.policy);
    stale.value = false;
    if (
      !localeOptions.value.some((locale) => locale.code === currentLocale.value)
    )
      currentLocale.value = result.defaultLocale;
    selectedId.value =
      currentItems.value.find((item) => item.id === selectedId.value)?.id ||
      currentItems.value[0]?.id ||
      "";
  } catch (error) {
    if (!disposed && seq === sequence) {
      loadError.value = errorMessage(error);
      stale.value = true;
    }
  } finally {
    if (!disposed && seq === sequence) loading.value = false;
  }
}
async function reload() {
  if (busy.value || initializing.value) return;
  if (
    dirty.value &&
    !(await confirmDiscard("Discard unsaved navigation changes?"))
  )
    return;
  if (busy.value || initializing.value) return;
  await load();
}
function reset() {
  if (!locked.value && saved.value) {
    draft.value = copy(saved.value.policy);
    selectedId.value = currentItems.value[0]?.id || "";
    notice.value = "";
  }
}
function selectSection(key: string) {
  void router.replace({
    query: route.query,
    hash: key === "structure" ? "" : "#" + key,
  });
}
function setItems(items: NavigationItem[]) {
  if (locked.value || !draft.value) return;
  const tree = draft.value.tree.find(
    (tree) => tree.locale === currentLocale.value,
  );
  if (tree) tree.items = items;
  else draft.value.tree.push({ locale: currentLocale.value, items });
}
function addItem(kind: NavigationItem["kind"]) {
  if (locked.value || currentItems.value.length >= maxItems) return;
  const item: NavigationItem = {
    id: crypto.randomUUID(),
    kind,
    label:
      kind === "link" ? "New link" : kind === "header" ? "New section" : "",
    icon: kind === "link" ? "mdi-link-variant" : "",
    targetType: "page",
    target: "",
    visibilityMode: "all",
    visibilityGroups: [],
  };
  setItems([...currentItems.value, item]);
  selectedId.value = item.id;
}
function duplicateItem() {
  if (locked.value || !selected.value || currentItems.value.length >= maxItems)
    return;
  const item = { ...copy(selected.value), id: crypto.randomUUID() };
  const items = [...currentItems.value];
  items.splice(selectedIndex.value + 1, 0, item);
  setItems(items);
  selectedId.value = item.id;
}
async function removeItem() {
  if (locked.value || !selected.value) return;
  const targetId = selectedId.value;
  const confirmed = await requestConfirmation({
    title: `Remove ${selected.value.label || "this divider"} from the draft?`,
    confirmLabel: "Remove",
    tone: "destructive",
  });
  if (!confirmed || locked.value || selectedId.value !== targetId) return;
  const index = selectedIndex.value;
  setItems(currentItems.value.filter((item) => item.id !== selectedId.value));
  selectedId.value =
    currentItems.value[Math.min(index, currentItems.value.length - 1)]?.id ||
    "";
}
function moveItem(direction: number) {
  if (locked.value || !selected.value) return;
  const from = selectedIndex.value,
    to = from + direction;
  if (to < 0 || to >= currentItems.value.length) return;
  const items = [...currentItems.value];
  items.splice(to, 0, ...items.splice(from, 1));
  setItems(items);
}
function selectPage(value: { path: string; locale: string; visibility?: "public" | "private" }) {
  if (!locked.value && selected.value?.kind === "link")
    selected.value.target = `${value.visibility === "private" ? "/_private" : ""}/${value.locale}/${value.path}`;
}
function editLocale(code: string) {
  currentLocale.value = code;
  selectSection("structure");
}
async function removeLocale(code: string) {
  if (locked.value || !draft.value) return;
  const confirmed = await requestConfirmation({
    title: `Remove the custom menu for ${code} from this draft?`,
    message: "The language itself remains installed.",
    confirmLabel: "Remove menu",
    tone: "destructive",
  });
  if (!confirmed || locked.value || !draft.value) return;
  draft.value.tree = draft.value.tree.filter((tree) => tree.locale !== code);
}
function openCopy() {
  copySource.value = copyOptions.value[0]?.code || "";
  copyMode.value = "append";
  copyOpen.value = true;
}
function copyLocale() {
  if (
    locked.value ||
    !draft.value ||
    !copyCount.value ||
    copyTotal.value > maxItems ||
    copySource.value === currentLocale.value
  )
    return;
  const source =
    draft.value.tree.find((tree) => tree.locale === copySource.value)?.items ||
    [];
  const items = copy(source).map((item) => ({
    ...item,
    id: crypto.randomUUID(),
  }));
  setItems(
    copyMode.value === "replace" ? items : [...currentItems.value, ...items],
  );
  selectedId.value = items[0]?.id || "";
  copyOpen.value = false;
}
function review() {
  if (locked.value || !draft.value || !saved.value || !dirty.value) return;
  const validation = NavigationPolicySchema.safeParse(draft.value);
  if (!validation.success) {
    notice.value = validation.error.issues
      .map((issue) => issue.message)
      .join(" ");
    attention.value = true;
    window.scrollTo({ top: 0 });
    return;
  }
  if (!navigationChangedFields(saved.value.policy, validation.data).length) {
    draft.value = copy(saved.value.policy);
    return;
  }
  reviewed.value = copy(validation.data);
  reviewFingerprint.value = saved.value.fingerprint;
  reason.value = "";
  saveError.value = "";
  notice.value = "";
  reviewing.value = true;
}
async function confirm() {
  if (
    locked.value ||
    !reviewing.value ||
    !reviewed.value ||
    !saved.value ||
    reason.value.trim().length < 3
  )
    return;
  busy.value = true;
  saveError.value = "";
  try {
    const result = await saveNavigationWorkspace(
      copy(reviewed.value),
      reviewFingerprint.value,
      reason.value.trim(),
    );
    if (disposed) return;
    saved.value = {
      ...saved.value,
      policy: copy(reviewed.value),
      runtime: { ...saved.value.runtime, state: "needs-attention" },
    };
    draft.value = copy(reviewed.value);
    reviewing.value = false;
    reviewed.value = null;
    reason.value = "";
    attention.value = result.activation !== "applied";
    notice.value = attention.value
      ? "Navigation saved. Runtime activation needs attention."
      : "Navigation published. Readers see the new menu on their next page load.";
    busy.value = false;
    stale.value = true;
    await load();
  } catch (error) {
    if (!disposed) {
      const status =
        error && typeof error === "object" ? Reflect.get(error, "status") : 0;
      stale.value =
        !status || Number(status) >= 500 || [401, 403, 409].includes(status);
      saveError.value =
        errorMessage(error) +
        (!status
          ? " The outcome is unconfirmed. Reload before publishing again."
          : "");
      if (stale.value) {
        notice.value =
          "Reload saved settings before another review. Your draft is retained.";
        attention.value = true;
      }
    }
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function reloadReview() {
  if (
    busy.value ||
    !(await confirmDiscard("Discard this review and load saved navigation?")) ||
    busy.value
  )
    return;
  reviewing.value = false;
  await load();
}
async function initialize() {
  if (locked.value || dirty.value || !saved.value) return;
  initializing.value = true;
  try {
    const result = await retryNavigationRuntime(saved.value.fingerprint);
    notice.value =
      result.activation === "applied"
        ? "Runtime navigation configuration applied."
        : "Runtime activation needs attention. Review server diagnostics.";
    attention.value = result.activation !== "applied";
    await load();
  } catch (error) {
    notice.value = errorMessage(error);
    attention.value = true;
  } finally {
    initializing.value = false;
  }
}
const modeName = (value: string) =>
  modeOptions.find((mode) => mode.value === value)?.title || value;
const fieldLabel = (field: string) =>
  field === "mode"
    ? "Sidebar display"
    : field === "expandParent"
      ? "Browse starting point"
      : "Menu for " + field.replace("locale:", "");
const reviewValue = (policy: NavigationPolicy, field: string) =>
  field === "mode"
    ? modeName(policy.mode)
    : field === "expandParent"
      ? policy.expandParent
        ? "Current page’s parent"
        : "Site root"
      : JSON.stringify(
          policy.tree.find(
            (tree) => tree.locale === field.replace("locale:", ""),
          )?.items ?? "No custom menu",
          null,
          2,
        );
const date = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
const canLeave = async () =>
  !busy.value &&
  !initializing.value &&
  ((!dirty.value && !(reviewing.value && reason.value)) ||
    (await confirmDiscard("Discard unsaved navigation changes?")));
function beforeUnload(event: BeforeUnloadEvent) {
  if (
    busy.value ||
    initializing.value ||
    dirty.value ||
    (reviewing.value && reason.value)
  ) {
    event.preventDefault();
    event.returnValue = "";
  }
}
onBeforeRouteLeave(canLeave);
onBeforeRouteUpdate((to, from) => to.path === from.path || canLeave());
onMounted(() => {
  void load();
  window.addEventListener("beforeunload", beforeUnload);
});
onBeforeUnmount(() => {
  disposed = true;
  sequence++;
  window.removeEventListener("beforeunload", beforeUnload);
});
</script>
<style lang="scss" src="./navigation-workspace.scss"></style>
