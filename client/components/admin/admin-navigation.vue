<template>
  <v-container fluid class="navigation-workspace">
    <admin-hero
      icon="mdi-compass-outline"
      :title="$t('admin:navigation.title')"
      :description="$t('admin:navigation.giveEveryReaderClear')"
      ><template #actions
        ><v-btn
          variant="text"
          prepend-icon="mdi-refresh"
          :loading="loading"
          :disabled="busy || initializing"
          @click="reload"
          >{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ $t('admin:navigation.reloadSavedNavigation') }}</v-tooltip></v-btn
        ><v-btn v-if="dirty" variant="text" :disabled="locked" @click="reset"
          >{{ $t('admin:navigation.resetDraft') }}</v-btn
        ><v-btn
          color="primary"
          variant="flat"
          :disabled="locked || !dirty"
          @click="review"
          >{{ $t('admin:navigation.reviewChanges') }}</v-btn
        ></template
      ></admin-hero
    >
    <p v-if="!saved && loading" class="navigation-empty" role="status">
      {{ $t('admin:navigation.loadingNavigationLocalesAudiences') }}
    </p>
    <v-alert v-if="loadError" type="error" variant="tonal"
      >{{ loadError
      }}<v-btn variant="text" :disabled="busy" @click="reload"
        >{{ $t('admin:navigation.reloadSavedSettings') }}</v-btn
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
            dirty ? $t('admin:navigation.unsavedNavigationDraft') : $t('admin:navigation.showingSavedNavigation')
          }}</span
        ><span>{{
          saved.runtime.state === "applied"
            ? $t('admin:navigation.runtimeConfigurationCurrent')
            : $t('admin:navigation.runtimeActivationNeedsAttention2')
        }}</span>
      </div>
      <nav class="navigation-tabs" :aria-label="$t('admin:navigation.navigationSections')">
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
                >{{ $t('admin:navigation.n01UsefulWayfindingSystem') }}</span
              >
              <h2>{{ $t('admin:navigation.arrangeEssentials') }}</h2>
              <p>
                {{ $t('admin:navigation.buildPurposefulMenuEach') }}
              </p>
            </div>
            <v-alert v-if="!customMode" type="info" variant="tonal" class="mb-5"
              >{{ $t('admin:navigation.customMenusRemainEditable', { mode: draft.mode === "NONE"
                  ? $t('admin:navigation.sidebarHidden')
                  : $t('admin:navigation.sidebarCurrentlyShowsPage'), interpolation: { escapeValue: false } }) }}</v-alert
            >
            <div class="navigation-toolbar">
              <v-select
                v-model="currentLocale"
                :items="localeOptions"
                item-title="title"
                item-value="code"
                :label="$t('admin:navigation.menuLocale')"
                variant="outlined"
                density="compact"
                hide-details
                :disabled="locked"
              /><v-btn
                variant="text"
                prepend-icon="mdi-content-copy"
                :disabled="locked || !copyOptions.length"
                @click="openCopy"
                >{{ $t('admin:navigation.copyLocale') }}</v-btn
              ><v-btn
                variant="text"
                class="navigation-preview-jump"
                @click="
                  previewPanel?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start',
                  })
                "
                >{{ $t('admin:navigation.previewMenu') }}</v-btn
              >
            </div>
            <p v-if="!currentLocaleEnabled" class="navigation-note mb-5">
              {{ $t('admin:navigation.localeRetainedEditingBut') }}
              <router-link to="/locale">{{ $t('admin:navigation.locale') }}</router-link>.
            </p>
            <div class="navigation-builder">
              <section class="navigation-structure" :aria-label="$t('admin:navigation.menuStructure')">
                <div class="navigation-section-title">
                  <h3>{{ $t('admin:navigation.menuOrder') }}</h3>
                  <span>{{ currentItems.length }} / {{ maxItems }}</span>
                </div>
                <div class="navigation-home">
                  <v-icon icon="mdi-home-outline" size="18" /><span>{{ $t('admin:navigation.navType.home') }}</span
                  ><small>{{ $t('admin:navigation.built') }}</small>
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
                  <h3>{{ $t('admin:navigation.startingPoint') }}</h3>
                  <p>
                    {{ $t('admin:navigation.addPageLinkThen') }}
                  </p>
                </div>
                <div class="navigation-add">
                  <v-btn
                    variant="tonal"
                    prepend-icon="mdi-plus"
                    :disabled="locked || currentItems.length >= maxItems"
                    @click="addItem('link')"
                    >{{ $t('admin:navigation.addLink') }}</v-btn
                  ><v-menu
                    ><template #activator="{ props }"
                      ><v-btn
                        v-bind="props"
                        variant="text"
                        icon="mdi-dots-horizontal"
                        :aria-label="$t('admin:navigation.addHeadingDivider')"
                        :disabled="
                          locked || currentItems.length >= maxItems
                        " /></template
                    ><v-list
                      ><v-list-item
                        :title="$t('admin:navigation.addHeading')"
                        prepend-icon="mdi-format-title"
                        @click="addItem('header')" /><v-list-item
                        :title="$t('admin:navigation.addDivider')"
                        prepend-icon="mdi-minus"
                        @click="addItem('divider')" /></v-list
                  ></v-menu>
                </div>
                <p class="navigation-note">
                  {{ $t('admin:navigation.dragHandleFocusPress') }}
                </p>
              </section>
              <section
                class="navigation-item-editor"
                :aria-label="$t('admin:navigation.selectedMenuItem')"
              >
                <template v-if="selected"
                  ><div class="navigation-section-title">
                    <h3>
                      {{
                        selected.kind === "link"
                          ? $t('admin:navigation.linkDetails')
                          : selected.kind === "header"
                            ? $t('admin:navigation.sectionHeading')
                            : $t('admin:navigation.divider')
                      }}
                    </h3>
                    <span
                      >{{ $t('admin:navigation.of', { value: selectedIndex + 1, currentItemsCount: currentItems.length, interpolation: { escapeValue: false } }) }}</span
                    >
                  </div>
                  <div class="navigation-item-position">
                    <v-btn
                      size="small"
                      variant="text"
                      prepend-icon="mdi-arrow-up"
                      :disabled="locked || selectedIndex === 0"
                      @click="moveItem(-1)"
                      >{{ $t('admin:navigation.moveUp') }}</v-btn
                    ><v-btn
                      size="small"
                      variant="text"
                      prepend-icon="mdi-arrow-down"
                      :disabled="
                        locked || selectedIndex === currentItems.length - 1
                      "
                      @click="moveItem(1)"
                      >{{ $t('admin:navigation.moveDown') }}</v-btn
                    >
                  </div>
                  <v-text-field
                    v-if="selected.kind !== 'divider'"
                    v-model="selected.label"
                    :label="$t('admin:navigation.menuLabel')"
                    maxlength="255"
                    counter="255"
                    variant="outlined"
                    :disabled="locked"
                  />
                  <template v-if="selected.kind === 'link'"
                    ><v-text-field
                      v-model="selected.icon"
                      :label="$t('admin:navigation.icon')"
                      variant="outlined"
                      :disabled="locked"
                      :hint="$t('admin:navigation.mdiIconNameFont')"
                      persistent-hint
                      ><template #append-inner
                        ><v-icon
                          :icon="selected.icon || 'mdi-link-variant'"
                          size="20" /></template></v-text-field
                    ><v-select
                      v-model="selected.targetType"
                      :items="targetOptions"
                      :label="$t('admin:navigation.destinationType')"
                      variant="outlined"
                      :disabled="locked"
                      class="mt-5"
                    /><v-text-field
                      v-model="selected.target"
                      :label="
                        selected.targetType === 'page'
                          ? $t('admin:navigation.pagePath')
                          : $t('admin:navigation.externalAddress')
                      "
                      variant="outlined"
                      :disabled="locked"
                      :error-messages="
                        selected.target && !destination
                          ? [$t('admin:navigation.enterValidDestinationLink')]
                          : []
                      "
                      :hint="
                        selected.targetType === 'page'
                          ? $t('admin:navigation.workspacePathSuchEn')
                          : $t('admin:navigation.httpSMailtoTel')
                      "
                      persistent-hint
                    /><v-btn
                      v-if="selected.targetType === 'page'"
                      class="mt-3"
                      variant="text"
                      prepend-icon="mdi-file-search-outline"
                      :disabled="locked"
                      @click="selectPageOpen = true"
                      >{{ $t('admin:navigation.choosePage') }}</v-btn
                    >
                    <p v-if="destination" class="navigation-destination">
                      <span>{{ $t('admin:navigation.destination') }}</span><code>{{ destination }}</code>
                    </p></template
                  >
                  <p
                    v-else-if="selected.kind === 'divider'"
                    class="navigation-note"
                  >
                    {{ $t('admin:navigation.separateRelatedGroupsLinks') }}
                  </p>
                  <div class="navigation-setting-group">
                    <h3>{{ $t('admin:navigation.audience') }}</h3>
                    <v-radio-group
                      v-model="selected.visibilityMode"
                      :disabled="locked"
                      hide-details
                      :label="$t('admin:navigation.whoSeesItem')"
                      ><v-radio
                        :label="$t('admin:navigation.everyoneWhoCanOpen')"
                        value="all" /><v-radio
                        :label="$t('admin:navigation.membersSelectedGroups')"
                        value="restricted" /></v-radio-group
                    ><v-select
                      v-if="selected.visibilityMode === 'restricted'"
                      v-model="selected.visibilityGroups"
                      :items="saved.groups"
                      item-title="name"
                      item-value="id"
                      :label="$t('admin:navigation.audienceGroups')"
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
                      {{ $t('admin:navigation.noGroupSelectedItem') }}
                    </p>
                    <p class="navigation-note mt-4">
                      {{ $t('admin:navigation.menuVisibilityDoesNot') }}
                    </p>
                  </div>
                  <div class="navigation-item-actions">
                    <v-btn
                      variant="text"
                      prepend-icon="mdi-content-copy"
                      :disabled="locked || currentItems.length >= maxItems"
                      @click="duplicateItem"
                      >{{ $t('admin:navigation.duplicateItem') }}</v-btn
                    ><v-btn
                      variant="text"
                      prepend-icon="mdi-delete-outline"
                      :disabled="locked"
                      @click="removeItem"
                      >{{ $t('admin:navigation.removeItem') }}</v-btn
                    >
                  </div>
                </template>
                <div v-else class="navigation-empty">
                  <v-icon icon="mdi-cursor-default-click-outline" size="28" />
                  <h3>{{ $t('admin:navigation.chooseItem') }}</h3>
                  <p>
                    {{ $t('admin:navigation.selectLinkHeadingDivider') }}
                  </p>
                </div>
              </section>
            </div>
          </template>
          <template v-else-if="section === 'display'">
            <div class="navigation-heading">
              <span class="navigation-kicker"
                >{{ $t('admin:navigation.n02PathsIntoWorkspace') }}</span
              >
              <h2>{{ $t('admin:navigation.chooseHowReadersExplore') }}</h2>
              <p>
                {{ $t('admin:navigation.balanceCuratedMenuPage') }}
              </p>
            </div>
            <fieldset class="navigation-mode-grid" :disabled="locked">
              <legend class="navigation-sr-only">{{ $t('admin:navigation.sidebarDisplayMode') }}</legend>
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
              <h3>{{ $t('admin:navigation.whereBrowseBegins') }}</h3>
              <v-switch
                v-model="draft.expandParent"
                inset
                :disabled="locked"
                :label="$t('admin:navigation.openCurrentPagesParent')"
                color="primary"
                hide-details
              />
              <p class="navigation-note mt-3">
                {{ $t('admin:navigation.whenOffBrowseStarts') }}
              </p>
            </div>
            <div class="navigation-setting-group">
              <div class="navigation-section-title">
                <h3>{{ $t('admin:navigation.localeCoverage') }}</h3>
                <router-link to="/locale">{{ $t('admin:navigation.manageLanguages') }}</router-link>
              </div>
              <p class="navigation-note mb-5">
                {{ $t('admin:navigation.eachLanguageHasOwn') }}
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
                        ? $t('admin:navigation.enabledReaders')
                        : $t('admin:navigation.notEnabledReaders')
                    }}</small
                  >
                </div>
                <span
                  >{{ $t('admin:navigation.items', { tree: draft.tree.find((tree) => tree.locale === locale.code)
                      ?.items.length || 0, interpolation: { escapeValue: false } }) }}</span
                ><v-btn
                  size="small"
                  variant="text"
                  :disabled="locked"
                  @click="editLocale(locale.code)"
                  >{{ $t('admin:navigation.editMenu') }}</v-btn
                ><v-btn
                  v-if="draft.tree.some((tree) => tree.locale === locale.code)"
                  icon="mdi-delete-outline"
                  size="small"
                  variant="text"
                  :aria-label="$t('admin:navigation.removeMenu2', { name: locale.name, interpolation: { escapeValue: false } })"
                  :disabled="locked"
                  @click="removeLocale(locale.code)"
                />
              </div>
            </div>
          </template>
          <template v-else
            ><div class="navigation-heading">
              <span class="navigation-kicker">{{ $t('admin:navigation.n03PublicationRecord') }}</span>
              <h2>{{ $t('admin:navigation.consideredPathForward') }}</h2>
              <p>
                {{ $t('admin:navigation.latest50NavigationPublications') }}
              </p>
            </div>
            <p v-if="!saved.history.length" class="navigation-empty">
              {{ $t('admin:navigation.noNavigationChangesHave') }}
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
                  ? $t('admin:navigation.apiAdministrator')
                  : $t('admin:navigation.administrator', { actorId: event.actorId, interpolation: { escapeValue: false } })
              }}</small>
            </article></template
          >
        </section>
        <aside ref="previewPanel" class="navigation-preview-panel">
          <div class="navigation-preview-heading">
            <span class="navigation-kicker">{{ $t('admin:navigation.audiencePreview') }}</span
            ><strong>{{ currentLocale }} / {{ modeName(draft.mode) }}</strong>
          </div>
          <v-select
            v-model="previewAudience"
            :items="audienceOptions"
            :label="$t('admin:navigation.preview')"
            variant="outlined"
            density="compact"
            hide-details
          /><v-select
            v-if="previewAudience === 'groups'"
            v-model="previewGroups"
            :items="saved.groups"
            item-title="name"
            item-value="id"
            :label="$t('admin:navigation.previewGroups')"
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
            {{ $t('admin:navigation.customLinksVisibleAudience', { visibleItems: visibleItems.filter((item) => item.kind === "link").length, currentItems: currentItems.filter((item) => item.kind === "link").length, interpolation: { escapeValue: false } }) }}
          </p>
          <p v-else class="navigation-note">
            {{ $t('admin:navigation.customLinksRetainedBut') }}
          </p>
          <p class="navigation-note mt-3">
            {{ $t('admin:navigation.previewsMenuVisibilityNot') }}
          </p>
          <div class="navigation-setting-group">
            <h3>{{ $t('admin:navigation.publication') }}</h3>
            <p class="navigation-note">
              {{ $t('admin:navigation.readersReceiveSavedMenu') }}
            </p>
            <v-btn
              v-if="saved.runtime.state !== 'applied'"
              class="mt-4"
              variant="tonal"
              :loading="initializing"
              :disabled="locked || dirty"
              @click="initialize"
              >{{ $t('admin:navigation.retryRuntimeActivation') }}</v-btn
            >
          </div>
        </aside>
      </div>
      <div v-if="dirty" class="navigation-savebar">
        <span
          >{{ $t('admin:navigation.navigationDraftChanged', { changedFieldsCount: changedFields.length, changedFields: changedFields.length === 1 ? "area" : "areas", interpolation: { escapeValue: false } }) }}</span
        ><v-btn variant="text" :disabled="locked" @click="reset">{{ $t('admin:navigation.reset') }}</v-btn
        ><v-btn
          color="primary"
          variant="flat"
          :disabled="locked"
          @click="review"
          >{{ $t('admin:navigation.reviewChanges') }}</v-btn
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
      ><v-card :title="$t('admin:navigation.copyLocaleMenu')"
        ><v-card-text
          ><p class="mb-5">
            {{ $t('admin:navigation.copyIntoLabelsDestinations', { currentLocale, interpolation: { escapeValue: false } }) }}
          </p>
          <v-select
            v-model="copySource"
            :items="copyOptions"
            item-title="title"
            item-value="code"
            :label="$t('admin:navigation.sourceLocale2')"
            variant="outlined"
          /><v-radio-group v-model="copyMode" :label="$t('admin:navigation.howCopy')"
            ><v-radio :label="$t('admin:navigation.appendMenu')" value="append" /><v-radio
              :label="$t('admin:navigation.replaceMenu')"
              value="replace"
          /></v-radio-group>
          <p>
            {{ $t('admin:navigation.sourceItemsCurrentItems', { copyCount, currentItemsCount: currentItems.length, interpolation: { escapeValue: false } }) }}
          </p>
          <v-alert
            v-if="copyMode === 'replace'"
            type="info"
            variant="tonal"
            class="mt-4"
            >{{ $t('admin:navigation.currentDraftMenuWill', { currentLocale, interpolation: { escapeValue: false } }) }}</v-alert
          ></v-card-text
        ><v-card-actions
          ><v-btn @click="copyOpen = false">{{ $t('common:actions.cancel') }}</v-btn><v-spacer /><v-btn
            variant="flat"
            color="primary"
            :disabled="locked || !copyCount || copyTotal > maxItems"
            @click="copyLocale"
            >{{ $t('admin:navigation.copyItems', { copyCount, interpolation: { escapeValue: false } }) }}</v-btn
          ></v-card-actions
        ></v-card
      ></v-dialog
    >
    <v-dialog v-model="reviewing" :persistent="busy" max-width="950"
      ><v-card v-if="saved && reviewed" :title="$t('admin:navigation.publishNavigationChanges')"
        ><v-card-text
          ><p class="mb-5">
            {{ $t('admin:navigation.reviewCompleteAffectedStructures') }}
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
                <strong>{{ $t('admin:navigation.saved') }}</strong>
                <pre tabindex="0">{{ reviewValue(saved.policy, field) }}</pre>
              </section>
              <section>
                <strong>{{ $t('admin:navigation.publishing') }}</strong>
                <pre tabindex="0">{{ reviewValue(reviewed, field) }}</pre>
              </section>
            </div>
          </details>
          <v-textarea
            v-model="reason"
            :label="$t('admin:navigation.reasonChange')"
            variant="outlined"
            rows="2"
            maxlength="1000"
            :disabled="busy || stale"
            class="mt-5"
            :hint="$t('admin:navigation.n31000Characters')"
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
            >{{ $t('admin:navigation.backDraft') }}</v-btn
          ><v-spacer /><v-btn
            v-if="stale"
            :disabled="busy"
            @click="reloadReview"
            >{{ $t('admin:navigation.reloadSavedSettings') }}</v-btn
          ><v-btn
            color="primary"
            variant="flat"
            :loading="busy"
            :disabled="locked || reason.trim().length < 3"
            @click="confirm"
            >{{ $t('admin:navigation.publishNavigation') }}</v-btn
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
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : t('admin:navigation.navigationAdministrationUnavailable');
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
  { key: "structure", title: t('admin:navigation.menuStructure') },
  { key: "display", title: t('admin:navigation.displayLocales') },
  { key: "activity", title: t('admin:navigation.activity') },
];
const modeOptions = [
  {
    value: "MIXED",
    title: t('admin:navigation.menuDirectory'),
    icon: "mdi-view-split-vertical",
    description: t('admin:navigation.curatedLinksBrowseAlongside'),
  },
  {
    value: "STATIC",
    title: t('admin:navigation.customMenu'),
    icon: "mdi-format-list-bulleted",
    description: t('admin:navigation.focusedSetHandPicked'),
  },
  {
    value: "TREE",
    title: t('admin:navigation.pageDirectory'),
    icon: "mdi-file-tree-outline",
    description: t('admin:navigation.exploreHierarchyAccessiblePages'),
  },
  {
    value: "NONE",
    title: t('admin:navigation.hiddenSidebar'),
    icon: "mdi-dock-left",
    description: t('admin:navigation.leaveMoreRoomPage'),
  },
];
const targetOptions = [
  { title: t('admin:navigation.wikiPage'), value: "page" },
  { title: t('admin:navigation.externalLink'), value: "external" },
  { title: t('admin:navigation.externalLinkNewTab'), value: "externalblank" },
];
const audienceOptions = [
  { title: t('admin:navigation.visitorGuestAccount'), value: "visitor" },
  { title: t('admin:navigation.selectedGroups'), value: "groups" },
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
    !(await confirmDiscard(t('admin:navigation.discardUnsavedNavigationChanges')))
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
      kind === "link" ? t('admin:navigation.newLink') : kind === "header" ? t('admin:navigation.newSection') : "",
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
    title: t('admin:navigation.removeDraft', { label: selected.value.label || "this divider", interpolation: { escapeValue: false } }),
    confirmLabel: t('admin:navigation.remove'),
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
    title: t('admin:navigation.removeCustomMenuDraft', { code, interpolation: { escapeValue: false } }),
    message: t('admin:navigation.languageItselfRemainsInstalled'),
    confirmLabel: t('admin:navigation.removeMenu'),
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
      ? t('admin:navigation.navigationSavedRuntimeActivation')
      : t('admin:navigation.navigationPublishedReadersSee');
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
          ? ` ${t('admin:navigation.outcomeUnconfirmedReloadBefore')}`
          : "");
      if (stale.value) {
        notice.value =
          t('admin:navigation.reloadSavedSettingsBefore');
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
    !(await confirmDiscard(t('admin:navigation.discardReviewLoadSaved'))) ||
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
        ? t('admin:navigation.runtimeNavigationConfigurationApplied')
        : t('admin:navigation.runtimeActivationNeedsAttention');
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
    ? t('admin:navigation.sidebarDisplay')
    : field === "expandParent"
      ? t('admin:navigation.browseStartingPoint')
      : t('admin:navigation.menu', { field: field.replace("locale:", ""), interpolation: { escapeValue: false } });
const reviewValue = (policy: NavigationPolicy, field: string) =>
  field === "mode"
    ? modeName(policy.mode)
    : field === "expandParent"
      ? policy.expandParent
        ? t('admin:navigation.currentPagesParent')
        : t('admin:navigation.siteRoot')
      : JSON.stringify(
          policy.tree.find(
            (tree) => tree.locale === field.replace("locale:", ""),
          )?.items ?? t('admin:navigation.noCustomMenu'),
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
    (await confirmDiscard(t('admin:navigation.discardUnsavedNavigationChanges'))));
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
