<template>
  <v-container
    fluid
    class="theme-workspace"
    :class="{ 'has-admin-draft-bar': dirty }"
    :style="{ '--admin-draft-bar-height': draftBarHeight }"
  >
    <admin-hero
      icon="mdi-palette-outline"
      :title="tr('title')"
      :description="tr('manageThemeSettings')"
    >
      <template #actions>
        <v-btn
          variant="text"
          prepend-icon="mdi-refresh"
          :loading="loading"
          :disabled="busy || initializing"
          @click="reload"
          >{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ tr('reloadSavedThemeSettings') }}</v-tooltip></v-btn
        >
        <v-btn v-if="dirty" variant="text" :disabled="locked" @click="reset"
          >{{ tr('resetDraft') }}</v-btn
        >
        <v-btn
          color="primary"
          variant="tonal"
          :data-commitment="dirty && !locked ? 'active' : undefined"
          :disabled="locked || !dirty"
          @click="review"
          >{{ tr('reviewChanges') }}</v-btn
        >
      </template>
    </admin-hero>
    <p v-if="!saved && loading" role="status" class="theme-empty">
      {{ tr('loadingPaletteLibrary') }}
    </p>
    <v-alert v-if="loadError" type="error" variant="tonal"
      >{{ loadError
      }}<v-btn variant="text" :disabled="busy" @click="reload"
        >{{ tr('reloadSavedSettings') }}</v-btn
      ></v-alert
    >
    <v-alert
      v-if="notice"
      :type="attention ? 'warning' : 'success'"
      variant="tonal"
      class="mt-4"
      >{{ notice }}</v-alert
    >
    <template v-if="saved && draft && palette">
      <div class="theme-status">
        <span
          ><i :class="{ 'is-draft': dirty }" />{{
            dirty ? tr('unsavedThemeDraft') : tr('showingSavedSettings')
          }}</span
        ><span>{{
          saved.runtime.state === "applied"
            ? tr('runtimeConfigurationCurrent')
            : tr('runtimeActivationNeedsAttention2')
        }}</span>
      </div>
      <nav ref="sectionNavigation" class="theme-tabs" :aria-label="tr('themeSections')">
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
      <div class="theme-layout">
        <section class="theme-editor">
          <template v-if="section === 'palettes'">
            <div class="theme-heading">
              <h2>{{ tr('paletteLibrary') }}</h2>
              <p>
                {{ tr('paletteLibraryHelp') }}
              </p>
            </div>
            <div class="theme-palette-list wiki-surface-well" :aria-label="tr('paletteLibrary')">
              <button
                v-for="item in draft.palettes"
                :key="item.id"
                type="button"
                :aria-pressed="palette.id === item.id"
                :disabled="locked"
                @click="selectedId = item.id"
              >
                <span class="theme-swatches" aria-hidden="true"
                  ><i
                    v-for="key in [
                      'background',
                      'surface',
                      'primary',
                      'secondary',
                    ] as const"
                    :key="key"
                    :style="{ background: item.colors[mode][key] }"
                /></span>
                <strong>{{ item.name || tr('untitledPalette') }}</strong
                ><small>{{
                  item.id === draft.activePaletteId
                    ? dirty
                      ? tr('chosenPublishing')
                      : tr('publishedPalette')
                    : tr('library')
                }}</small>
              </button>
            </div>
            <div class="theme-inline-actions">
              <v-btn
                variant="text"
                prepend-icon="mdi-plus"
                :disabled="locked || draft.palettes.length >= maxPalettes"
                @click="addPalette(false)"
                >{{ tr('newPalette') }}</v-btn
              ><span>{{ draft.palettes.length }} / {{ maxPalettes }}</span>
            </div>
            <div class="theme-setting-group">
              <div class="theme-section-title">
                <h3>{{ tr('editPalette') }}</h3>
                <v-btn
                  v-if="palette.id !== draft.activePaletteId"
                  size="small"
                  variant="tonal"
                  :disabled="locked"
                  @click="draft.activePaletteId = palette.id"
                  >{{ tr('usePalette') }}</v-btn
                >
              </div>
              <v-text-field
                v-model="palette.name"
                :label="tr('paletteName')"
                variant="outlined"
                maxlength="80"
                counter="80"
                :disabled="locked"
              />
              <div class="theme-inline-actions">
                <v-btn
                  size="small"
                  variant="text"
                  :disabled="locked || draft.palettes.length >= maxPalettes"
                  @click="addPalette(true)"
                  >{{ tr('duplicate') }}</v-btn
                ><v-btn
                  size="small"
                  variant="text"
                  :disabled="locked || !savedPalette"
                  @click="restorePalette"
                  >{{ tr('restoreSavedColors') }}</v-btn
                ><v-btn
                  size="small"
                  variant="text"
                  :disabled="locked || draft.palettes.length === 1"
                  @click="deleteOpen = true"
                  >{{ tr('deletePalette') }}</v-btn
                >
              </div>
              <div class="theme-mode-heading">
                <h3>{{ tr('colors', { value: mode === "light" ? tr('light') : tr('dark'), interpolation: { escapeValue: false } }) }}</h3>
                <div class="theme-segmented" :aria-label="tr('editColorMode')">
                  <button
                    v-for="item in modes"
                    :key="item"
                    type="button"
                    :aria-pressed="mode === item"
                    @click="mode = item"
                  >
                    {{ item }}
                  </button>
                </div>
              </div>
              <fieldset :disabled="locked" class="theme-color-grid">
                <theme-color-field
                  v-for="key in colorKeys"
                  :key="key"
                  v-model="palette.colors[mode][key]"
                  :label="colorLabels[key]"
                />
              </fieldset>
              <v-btn
                class="mt-3"
                size="small"
                variant="text"
                :disabled="locked"
                @click="resetMode"
                >{{ tr('resetOriginalColors', { mode, interpolation: { escapeValue: false } }) }}</v-btn
              >
            </div>
          </template>
          <template v-else-if="section === 'reader'">
            <div class="theme-heading">
              <h2>{{ tr('readerLayout') }}</h2>
              <p>
                {{ tr('setReadingProportionsAcross') }}
              </p>
            </div>
            <div class="theme-setting-group theme-reader-fields">
              <v-text-field
                v-model.number="draft.reading.textSize"
                type="number"
                min="14"
                max="24"
                step="1"
                :label="tr('readerTextSize')"
                :suffix="tr('px')"
                variant="outlined"
                :disabled="locked"
                :hint="tr('n1424PxBrowsers')"
                persistent-hint
              />
              <v-text-field
                v-model.number="draft.reading.lineHeight"
                type="number"
                min="1.4"
                max="2"
                step="0.01"
                :label="tr('lineSpacing')"
                suffix="×"
                variant="outlined"
                :disabled="locked"
                :hint="tr('n142Times')"
                persistent-hint
              />
              <v-text-field
                v-model.number="draft.reading.copyWidth"
                type="number"
                min="48"
                max="110"
                step="1"
                :label="tr('maximumLineLength')"
                :suffix="tr('ch')"
                variant="outlined"
                :disabled="locked"
                :hint="tr('n48110CharacterWidths')"
                persistent-hint
              />
              <v-select
                v-model="draft.tocPosition"
                :items="tocOptions"
                :label="tr('contentsPageInformation')"
                variant="outlined"
                :disabled="locked"
                :hint="tr('chooseSidePageRail')"
                persistent-hint
              />
              <v-btn
                variant="text"
                :disabled="locked"
                @click="draft.reading = { ...defaultReading }"
                >{{ tr('restoreReadingDefaults') }}</v-btn
              >
            </div>
            <div class="theme-setting-group">
              <h3>Code appearance</h3>
              <v-select
                v-model="draft.codeTheme"
                :items="codeThemeOptions"
                label="Prism code theme"
                variant="outlined"
                :disabled="locked"
                hint="Native follows the workspace palette. Paper and Midnight use fixed, readable code colors. Changes publish only after review."
                persistent-hint
              />
              <v-btn
                variant="text"
                :disabled="locked || draft.codeTheme === saved.policy.codeTheme"
                @click="draft.codeTheme = saved.policy.codeTheme"
              >Restore saved code appearance</v-btn>
            </div>
            <div class="theme-setting-group">
              <h3>{{ tr('navigationFeedback', { defaultValue: 'Navigation feedback' }) }}</h3>
              <v-switch
                :model-value="draft.pageTransitions"
                @update:model-value="$event !== null && (draft.pageTransitions = $event)"
                :label="tr('pageTransitions', { defaultValue: 'Animate page transitions' })"
                :hint="tr('pageTransitionsHint', { defaultValue: 'Use a brief entrance when navigating between pages. The reader’s reduced-motion preference always takes priority.' })"
                :disabled="locked"
                color="primary"
                persistent-hint
              />
              <v-switch
                :model-value="draft.showPageProgress"
                @update:model-value="$event !== null && (draft.showPageProgress = $event)"
                :label="tr('showPageProgress', { defaultValue: 'Show navigation loading cue' })"
                :hint="tr('showPageProgressHint', { defaultValue: 'Show a decorative top-edge cue while the next page loads. Reading-position progress and the accessible loading indicator remain unchanged.' })"
                :disabled="locked"
                color="primary"
                persistent-hint
              />
            </div>
            <div class="theme-setting-group">
              <h3>{{ tr('personalPresentation') }}</h3>
              <p>
                {{ tr('eachReaderChoosesSystem') }}
              </p>
              <p class="theme-note">
                {{ tr('workspaceColorsApplyBoth') }}
              </p>
            </div>
            <div class="theme-setting-group">
              <h3>{{ tr('iconCompatibility') }}</h3>
              <v-select
                v-model="draft.iconset"
                :items="iconOptions"
                :label="tr('pageIconLibrary')"
                variant="outlined"
                :disabled="locked"
              />
              <p class="theme-note">
                {{ tr('materialDesignIconsBuilt') }}
              </p>
            </div>
          </template>
          <template v-else-if="section === 'code'">
            <div class="theme-heading">
              <h2>{{ tr('customCode') }}</h2>
              <p>
                {{ tr('extendReaderPagesCustom') }}
              </p>
            </div>
            <v-alert type="info" variant="tonal" class="mb-5"
              >{{ tr('customHtmlCanRun') }}</v-alert
            >
            <v-alert
              v-if="!saved.capabilities.editCustomCode"
              type="warning"
              variant="tonal"
              class="mb-5"
              >{{ tr('customCssHtmlManaged') }}</v-alert
            >
            <div
              v-for="field in codeFields"
              :key="field.key"
              class="theme-setting-group"
            >
              <div class="theme-section-title">
                <h3>{{ field.title }}</h3>
                <span class="theme-note"
                  >{{ draft[field.key].length.toLocaleString() }} / 65,536</span
                >
              </div>
              <p>{{ field.description }}</p>
              <theme-code-editor
                v-model="draft[field.key]"
                :language="field.language"
                :label="field.title"
                :disabled="codeLocked"
              />
            </div>
          </template>
          <template v-else>
            <div class="theme-heading">
              <h2>{{ tr('activity') }}</h2>
              <p>
                {{ tr('latest50SavedTheme') }}
              </p>
            </div>
            <p v-if="!saved.history.length" class="theme-empty wiki-surface-well">
              {{ tr('noThemeChangesHave') }}
            </p>
            <article
              v-for="event in saved.history"
              :key="event.id"
              class="theme-event"
            >
              <time>{{ date(event.createdAt) }}</time>
              <h3>{{ event.reason }}</h3>
              <p>
                {{
                  event.fields
                    .map(
                      (field) =>
                        fieldLabels[field as keyof ThemePolicy] || field,
                    )
                    .join(" · ")
                }}
              </p>
              <small>{{
                event.actorId === null
                  ? tr('apiAdministrator')
                  : tr('administrator', { actorId: event.actorId, interpolation: { escapeValue: false } })
              }}</small>
            </article>
          </template>
        </section>
        <aside class="theme-aside">
          <div class="theme-preview-controls">
            <div>
              <span class="theme-kicker">{{ tr('liveSpecimen') }}</span
              ><strong>{{ palette.name || tr('untitledPalette') }}</strong>
            </div>
            <div class="theme-segmented" :aria-label="tr('previewAppearance')">
              <button
                v-for="item in modes"
                :key="item"
                type="button"
                :aria-pressed="mode === item"
                @click="mode = item"
              >
                {{ item }}
              </button>
            </div>
          </div>
          <div
            class="theme-specimen"
            :style="previewStyle"
            :aria-label="tr('readerPreview')"
          >
            <div class="theme-specimen-nav">
              <strong>{{ tr('epistle') }}</strong><span>{{ tr('knowledgeConnected') }}</span
              ><i :style="{ background: previewColors.primary }" />
            </div>
            <p
              v-if="draft.tocPosition !== 'off'"
              class="theme-specimen-adaptation"
            >
              {{ tr('narrowPreview') }}
            </p>
            <div
              class="theme-specimen-body"
              :class="'theme-specimen-body--' + draft.tocPosition"
            >
              <div
                v-if="draft.tocPosition !== 'off'"
                class="theme-specimen-toc"
              >
                <small>{{ $t('common:page.onThisPage') }}</small><span>{{ tr('sharedUnderstanding') }}</span
                ><span>{{ tr('leaveUsefulTrail') }}</span>
              </div>
              <article>
                <span class="theme-specimen-eyebrow">{{ tr('fieldNotes01') }}</span>
                <h2>{{ tr('sharedUnderstanding') }}</h2>
                <p>
                  {{ tr('goodKnowledgeHasRoom') }}
                </p>
                <h3>{{ tr('leaveUsefulTrail') }}</h3>
                <p>
                  {{ tr('writeNextReaderLink') }}
                </p>
                <div class="theme-specimen-callout">
                  <strong>{{ tr('connectedKnowledge') }}</strong
                  ><span>{{ tr('usefulPersonDiscoverableAgent') }}</span>
                </div>
                <div class="theme-specimen-footer">
                  <span>{{ tr('updatedJustNowExample') }}</span
                  ><span
                    class="theme-specimen-button"
                    :style="{
                      background: previewColors.primary,
                      color: foreground(previewColors.primary),
                    }"
                    >{{ tr('exploreWiki') }}</span
                  >
                </div>
              </article>
            </div>
          </div>
          <section
            class="theme-code-preview"
            :data-wiki-code-theme="draft.codeTheme"
            :data-wiki-code-mode="mode"
            :style="codePreviewStyle"
            aria-label="Prism code appearance preview"
          >
            <h3>Code preview</h3>
            <p class="theme-note">Draft only · JavaScript · {{ codeThemeOptions.find(item => item.value === draft?.codeTheme)?.title }}</p>
            <p v-if="codePreviewLoading" role="status">Loading syntax preview…</p>
            <p v-if="codePreviewError" role="alert">
              {{ codePreviewError }}
              <v-btn variant="text" @click="loadCodePreview">Retry preview</v-btn>
            </p>
            <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: This bounded source/report viewport needs a tab stop for keyboard scrolling. -->
            <!-- biome-ignore lint/a11y/useSemanticElements: This named scroll region must remain preformatted source with syntax-highlighted code. -->
            <pre class="prismjs language-javascript" tabindex="0" aria-label="JavaScript example"  role="region"><code v-if="codePreviewHtml" class="language-javascript" v-html="codePreviewHtml"></code><code v-else class="language-javascript">{{ codePreviewSource }}</code></pre>
          </section>
          <div class="theme-preview-options">
            <v-select
              v-model="previewFont"
              :items="fontOptions"
              :label="tr('previewFontOnly')"
              variant="outlined"
              density="compact"
              hide-details
            />
            <p>
              {{ tr('previewingCustomCodeIcon', { value: palette.id === draft.activePaletteId
                  ? tr('chosenPalette')
                  : tr('libraryPalette'), interpolation: { escapeValue: false } }) }}
            </p>
          </div>
          <section class="theme-contrast">
            <div class="theme-section-title">
              <h3>{{ tr('colorContrast') }}</h3>
              <span>{{ tr('surface2', { mode, interpolation: { escapeValue: false } }) }}</span>
            </div>
            <p>
              {{ tr('normalSizeColoredText') }}
            </p>
            <div
              v-for="item in contrastChecks"
              :key="item.key"
              class="theme-contrast-row"
            >
              <span
                ><i :style="{ background: previewColors[item.key] }" />{{
                  colorLabels[item.key]
                }}</span
              ><strong>{{ item.ratio.toFixed(2) }}:1</strong
              ><span>{{
                item.ratio >= 4.5 ? tr('meets451') : tr('useCare')
              }}</span>
            </div>
            <small
              >{{ tr('theseCalculatedColorPairs') }}</small
            >
          </section>
          <section class="theme-runtime">
            <h3>{{ tr('publication') }}</h3>
            <p>
              {{ tr('savedPalette') }}
              <strong>{{
                saved.policy.palettes.find(
                  (item) => item.id === saved!.policy.activePaletteId,
                )?.name
              }}</strong>
            </p>
            <p>
              {{ tr('changesReachReadersTheir') }}
            </p>
            <v-btn
              v-if="saved.runtime.state !== 'applied'"
              variant="tonal"
              :disabled="locked || dirty"
              :loading="initializing"
              @click="initialize"
              >{{ tr('retryRuntimeActivation') }}</v-btn
            >
          </section>
        </aside>
      </div>
      <div v-if="dirty" ref="draftBar" class="theme-savebar">
        <span
          >{{ tr('themeDraftImpact', { count: changedFields.length }) }}</span
        ><v-btn variant="text" :disabled="locked" @click="reset">{{ tr('reset') }}</v-btn
        ><v-btn
          color="primary"
          variant="tonal"
          :data-commitment="dirty && !locked ? 'active' : undefined"
          :disabled="locked"
          @click="review"
          >{{ tr('reviewChanges') }}</v-btn
        >
      </div>
    </template>
    <v-dialog v-model="deleteOpen" max-width="520"
      ><v-card v-if="draft && palette" :title="tr('deletePalette2')"
        ><v-card-text
          ><p>
            {{ tr('removeDraftYouCan', { name: palette.name, interpolation: { escapeValue: false } }) }}
          </p>
          <v-select
            v-if="palette.id === draft.activePaletteId"
            v-model="replacementId"
            :items="draft.palettes.filter((item) => item.id !== palette!.id)"
            item-title="name"
            item-value="id"
            :label="tr('replacementPublishedPalette')"
            variant="outlined"
            class="mt-5" /></v-card-text
        ><v-card-actions
          ><v-spacer /><v-btn @click="deleteOpen = false">{{ $t('common:actions.cancel') }}</v-btn
          ><v-btn
            :disabled="
              locked || (palette.id === draft.activePaletteId && !replacementId)
            "
            @click="deletePalette"
            >{{ tr('deleteDraft') }}</v-btn
          ></v-card-actions
        ></v-card
      ></v-dialog
    >
    <v-dialog v-model="reviewing" :persistent="busy" max-width="900"
      ><v-card v-if="reviewed && saved" :title="tr('publishThemeChanges')"
        ><v-card-text
          ><p class="mb-5">
            {{ tr('reviewExactDraftBelow') }}
          </p>
          <details
            v-for="field in reviewFields"
            :key="field"
            class="theme-review-field"
            open
          >
            <summary>{{ fieldLabels[field] }}</summary>
            <div>
              <section>
                <strong>{{ tr('saved') }}</strong>
                <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: This bounded source/report viewport needs a tab stop for keyboard scrolling. -->
                <pre class="wiki-surface-well" tabindex="0">{{ displayValue(saved.policy[field]) }}</pre>
              </section>
              <section>
                <strong>{{ tr('publishing') }}</strong>
                <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: This bounded source/report viewport needs a tab stop for keyboard scrolling. -->
                <pre class="wiki-surface-well" tabindex="0">{{ displayValue(reviewed[field]) }}</pre>
              </section>
            </div>
          </details>
          <v-textarea
            v-model="reason"
            :label="tr('reasonChange')"
            rows="2"
            variant="outlined"
            maxlength="1000"
            :disabled="busy || stale"
            class="mt-6"
            :hint="tr('n31000Characters')"
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
            >{{ tr('backDraft') }}</v-btn
          ><v-spacer /><v-btn
            v-if="stale"
            :disabled="busy"
            @click="reloadReview"
            >{{ tr('reloadSavedSettings') }}</v-btn
          ><v-btn
            color="primary"
            variant="tonal"
            :data-commitment="dirty && !locked && reason.trim().length >= 3 ? 'active' : undefined"
            :loading="busy"
            :disabled="locked || reason.trim().length < 3"
            @click="confirm"
            >{{ tr('publishChanges') }}</v-btn
          ></v-card-actions
        ></v-card
      ></v-dialog
    >
  </v-container>
</template>
<script setup lang="ts">
import { helpers } from '../../helpers/index.ts'
import { confirmDiscard, requestConfirmation } from "../common/confirm-dialog.ts";
import {
  nextTick,
  computed,
  defineAsyncComponent,
  onMounted,
  onBeforeUnmount,
  ref,
  watch,
} from "vue";
import {
  useRoute,
  useRouter,
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
} from "vue-router";
import { useTheme } from "vuetify";
import ThemeColorField from "./theme-color-field.vue";
import {
  ThemePolicySchema,
  themeFieldLabels,
  themeChangedFields,
  defaultReaderLayout,
  type ThemePolicy,
  type ThemeWorkspace,
} from "../../../shared/theme-policy.ts";
import {
  THEME_COLOR_KEYS,
  DEFAULT_THEME_COLORS,
  normalizeThemeColors,
  type ThemeColorKey,
} from "../../../shared/theme-colors.ts";
import {
  MAX_THEME_PALETTES,
  createDefaultThemePalette,
} from "../../../shared/theme-palettes.ts";
import {
  applyWikiThemeColors,
  createInkColorMap,
  contrastRatio,
  contrastForeground,
} from "../../helpers/theme.ts";
import { applyReaderLayout } from "../../helpers/reader-layout.ts";
import { applyCodeTheme, CODE_THEME_PREVIEW_SOURCE, renderCodeThemePreview } from "../../helpers/code-appearance.ts";
import { rememberOfflinePresentation } from "../../helpers/offline-presentation.ts";
import { wikiStore } from "../../store/index.ts";
import {
  fetchThemeWorkspace,
  saveThemeWorkspace,
  retryThemeRuntime,
} from "../../helpers/theme-workspace-api.ts";
import { useTranslate } from '../../helpers/use-translate.ts'

const tr = useTranslate('admin:theme')
const ThemeCodeEditor = defineAsyncComponent(
  () => import("./theme-code-editor.vue"),
);
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : tr('themeAdministrationUnavailable');
const route = useRoute(),
  router = useRouter(),
  theme = useTheme();
type ThemeDraft = Omit<ThemePolicy, "reading"> & {
  reading: { [Field in keyof ThemePolicy["reading"]]: number | string };
};
const saved = ref<ThemeWorkspace | null>(null),
  draft = ref<ThemeDraft | null>(null),
  reviewed = ref<ThemePolicy | null>(null);
const loading = ref(false),
  busy = ref(false),
  initializing = ref(false),
  stale = ref(false),
  reviewing = ref(false),
  deleteOpen = ref(false);
const loadError = ref(""),
  saveError = ref(""),
  notice = ref(""),
  attention = ref(false),
  reason = ref(""),
  reviewFingerprint = ref(""),
  selectedId = ref(""),
  replacementId = ref("");
const codePreviewSource = CODE_THEME_PREVIEW_SOURCE;
const codePreviewHtml = ref(""),
  codePreviewLoading = ref(false),
  codePreviewError = ref("");
const codePreviewController = new AbortController();
const codeThemeOptions = [
  { title: "Native · workspace palette", value: "native" },
  { title: "Paper · light", value: "paper" },
  { title: "Midnight · dark", value: "midnight" },
];
const customCodeFields = ["injectCSS", "injectHead", "injectBody"] as const;
type CustomCodeField = (typeof customCodeFields)[number];
const mode = ref<"light" | "dark">(theme.current.value.dark ? "dark" : "light"),
  previewFont = ref(wikiStore.user.fontFamily);
const modes = ["light", "dark"] as const,
  maxPalettes = MAX_THEME_PALETTES,
  colorKeys = THEME_COLOR_KEYS,
  fieldLabels = themeFieldLabels,
  defaultReading = defaultReaderLayout;
const colorLabels: Record<ThemeColorKey, string> = {
  background: tr('background'),
  surface: tr('surface'),
  primary: tr('primary'),
  secondary: tr('secondary'),
  accent: tr('accent'),
  info: tr('information'),
  success: tr('success'),
  warning: tr('warning'),
  error: tr('error'),
};
const sections = [
  { key: "palettes", title: tr('paletteLibrary') },
  { key: "reader", title: tr('readerLayout') },
  { key: "code", title: tr('customCode') },
  { key: "activity", title: tr('activity') },
];
const section = computed(
  () =>
    sections.find((item) => "#" + item.key === route.hash)?.key || "palettes",
);
const palette = computed(
  () =>
    draft.value?.palettes.find((item) => item.id === selectedId.value) ||
    draft.value?.palettes[0],
);
const savedPalette = computed(() =>
  saved.value?.policy.palettes.find((item) => item.id === palette.value?.id),
);
const changedFields = computed(() => {
  if (!saved.value || !draft.value) return [];
  const fields = themeChangedFields(saved.value.policy, {
    ...draft.value,
    reading: saved.value.policy.reading,
  });
  if (
    JSON.stringify(saved.value.policy.reading) !==
    JSON.stringify(draft.value.reading)
  ) {
    fields.push("reading");
    const order = Object.keys(themeFieldLabels);
    fields.sort((left, right) => order.indexOf(left) - order.indexOf(right));
  }
  return fields;
});
const dirty = computed(() => changedFields.value.length > 0);
const draftBar = ref<HTMLElement | null>(null);
const sectionNavigation = ref<HTMLElement | null>(null);
const draftBarHeight = ref("5rem");
let draftBarObserver: ResizeObserver | undefined;
watch(draftBar, (element) => {
  draftBarObserver?.disconnect();
  if (!element) {
    draftBarHeight.value = "5rem";
    return;
  }
  const measure = () => {
    draftBarHeight.value = `${element.getBoundingClientRect().height}px`;
  };
  measure();
  draftBarObserver = new ResizeObserver(measure);
  draftBarObserver.observe(element);
}, { flush: "post" });
const locked = computed(
  () =>
    loading.value ||
    busy.value ||
    initializing.value ||
    stale.value ||
    !saved.value,
);
const codeLocked = computed(
  () => locked.value || !saved.value?.capabilities.editCustomCode,
);
const reviewFields = computed(() =>
  saved.value && reviewed.value
    ? themeChangedFields(saved.value.policy, reviewed.value)
    : [],
);
const previewColors = computed(
  () => normalizeThemeColors(palette.value?.colors)[mode.value],
);
const foreground = contrastForeground;
const previewStyle = computed(() => ({
  "--specimen-bg": previewColors.value.background,
  "--specimen-surface": previewColors.value.surface,
  "--specimen-ink": foreground(previewColors.value.surface),
  "--specimen-primary": previewColors.value.primary,
  "--specimen-font":
    previewFont.value === "newsreader"
      ? "var(--wiki-font-newsreader)"
      : "var(--wiki-font-roboto-flex)",
  "--specimen-display":
    previewFont.value === "roboto-flex"
      ? "var(--wiki-font-roboto-flex)"
      : "var(--wiki-font-newsreader)",
  "--specimen-size": (Number(draft.value?.reading.textSize) || 17) / 16 + "rem",
  "--specimen-leading": String(Number(draft.value?.reading.lineHeight) || 1.68),
  "--specimen-width": (Number(draft.value?.reading.copyWidth) || 101) + "ch",
}));
const codePreviewStyle = computed(() => {
  const colors = previewColors.value;
  const inks = createInkColorMap(colors, [colors.surface]);
  const ink = foreground(colors.surface);
  return {
    "--wiki-code-native-bg": colors.surface,
    "--wiki-code-native-fg": ink,
    "--wiki-code-native-comment": ink,
    "--wiki-code-native-keyword": inks["primary-ink"],
    "--wiki-code-native-string": inks["success-ink"],
    "--wiki-code-native-number": inks["info-ink"],
    "--wiki-code-native-function": inks["secondary-ink"],
  };
});
const contrastChecks = computed(() =>
  (
    [
      "primary",
      "secondary",
      "accent",
      "info",
      "success",
      "warning",
      "error",
    ] as const
  ).map((key) => ({
    key,
    ratio: contrastRatio(previewColors.value[key], previewColors.value.surface),
  })),
);
const tocOptions = [
  { title: tr('automaticContents'), value: "auto" },
  { title: tr('leftRail'), value: "left" },
  { title: tr('rightRail'), value: "right" },
  { title: tr('hidden'), value: "off" },
];
const iconOptions = [
  { title: tr('materialDesignIcons'), value: "mdi" },
  { title: tr('fontAwesome5Legacy'), value: "fa" },
  { title: tr('fontAwesome4Legacy'), value: "fa4" },
];
const fontOptions = [
  { title: tr('blendSerifHeadingsSans'), value: "blend" },
  { title: tr('newsreaderSerif'), value: "newsreader" },
  { title: tr('robotoFlexSansSerif'), value: "roboto-flex" },
];
const codeFields = [
  {
    key: "injectCSS",
    title: tr('customCss'),
    language: "css",
    description:
      tr('stylesReaderEditorPages'),
  },
  {
    key: "injectHead",
    title: tr('headHtml'),
    language: "html",
    description:
      tr('markupInsertedIntoReader'),
  },
  {
    key: "injectBody",
    title: tr('bodyHtml'),
    language: "html",
    description:
      tr('markupInsertedIntoReader2'),
  },
] as const;
const preserveCustomCode = (
  policy: ThemePolicy,
  savedPolicy: ThemePolicy,
  editCustomCode: boolean,
): ThemePolicy => {
  if (editCustomCode) return policy;
  const next = copy(policy);
  for (const field of customCodeFields)
    next[field as CustomCodeField] = savedPolicy[field as CustomCodeField];
  return next;
};
let sequence = 0,
  disposed = false;
async function loadCodePreview() {
  if (disposed || codePreviewLoading.value) return;
  codePreviewLoading.value = true;
  codePreviewError.value = "";
  try {
    const html = await renderCodeThemePreview(codePreviewController.signal);
    if (!disposed && !codePreviewController.signal.aborted && html !== null)
      codePreviewHtml.value = html;
  } catch {
    if (!disposed && !codePreviewController.signal.aborted)
      codePreviewError.value = "Syntax preview could not load. Your draft has not been changed.";
  } finally {
    if (!disposed) codePreviewLoading.value = false;
  }
}
watch(() => Boolean(saved.value), ready => { if (ready) void loadCodePreview(); });
async function load() {
  if (busy.value) return;
  const seq = ++sequence;
  loading.value = true;
  loadError.value = "";
  try {
    const result = await fetchThemeWorkspace();
    if (disposed || seq !== sequence) return;
    saved.value = result;
    draft.value = copy(result.policy);
    stale.value = false;
    if (!result.policy.palettes.some((item) => item.id === selectedId.value))
      selectedId.value = result.policy.activePaletteId;
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
  if (dirty.value && !(await confirmDiscard(tr('discardUnsavedThemeChanges'))))
    return;
  if (busy.value || initializing.value) return;
  await load();
}
function reset() {
  if (!locked.value && saved.value) {
    const restoreFocus = draftBar.value?.contains(document.activeElement);
    draft.value = copy(saved.value.policy);
    notice.value = "";
    selectedId.value = saved.value.policy.activePaletteId;
    if (restoreFocus) {
      void nextTick(() => {
        sectionNavigation.value?.querySelector<HTMLButtonElement>("[aria-current]")?.focus();
      });
    }
  }
}
function selectSection(key: string) {
  void router.replace({
    query: route.query,
    hash: key === "palettes" ? "" : "#" + key,
  });
}
function addPalette(duplicate: boolean) {
  if (
    locked.value ||
    !draft.value ||
    !palette.value ||
    draft.value.palettes.length >= maxPalettes
  )
    return;
  const next = duplicate ? copy(palette.value) : createDefaultThemePalette();
  next.id = "palette-" + crypto.randomUUID();
  next.name = duplicate ? tr('copy', { name: next.name.slice(0, 70), interpolation: { escapeValue: false } }) : tr('newPalette');
  draft.value.palettes.push(next);
  selectedId.value = next.id;
}
function restorePalette() {
  if (!locked.value && palette.value && savedPalette.value)
    palette.value.colors = copy(savedPalette.value.colors);
}
async function resetMode() {
  if (locked.value || !palette.value) return;
  const target = mode.value;
  const confirmed = await requestConfirmation({
    title: tr('resetColorsOriginalPalette', { target, interpolation: { escapeValue: false } }),
    confirmLabel: tr('resetColors'),
    tone: "destructive",
  });
  if (confirmed && !locked.value && palette.value)
    palette.value.colors[target] = { ...DEFAULT_THEME_COLORS[target] };
}
function deletePalette() {
  if (
    locked.value ||
    !draft.value ||
    !palette.value ||
    draft.value.palettes.length === 1
  )
    return;
  const id = palette.value.id;
  if (id === draft.value.activePaletteId) {
    if (
      !draft.value.palettes.some(
        (item) => item.id === replacementId.value && item.id !== id,
      )
    )
      return;
    draft.value.activePaletteId = replacementId.value;
  }
  draft.value.palettes = draft.value.palettes.filter((item) => item.id !== id);
  selectedId.value = draft.value.activePaletteId;
  replacementId.value = "";
  deleteOpen.value = false;
}
function review() {
  if (locked.value || !draft.value || !saved.value || !dirty.value) return;
  const validation = ThemePolicySchema.safeParse(draft.value);
  if (!validation.success) {
    notice.value = validation.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join(" ");
    attention.value = true;
    window.scrollTo({ top: 0 });
    return;
  }
  const candidate = preserveCustomCode(
    validation.data,
    saved.value.policy,
    saved.value.capabilities.editCustomCode,
  );
  if (!themeChangedFields(saved.value.policy, candidate).length) {
    draft.value = copy(saved.value.policy);
    return;
  }
  reviewed.value = copy(candidate);
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
    const published = preserveCustomCode(
      copy(reviewed.value),
      saved.value.policy,
      saved.value.capabilities.editCustomCode,
    );
    const result = await saveThemeWorkspace(
      published,
      reviewFingerprint.value,
      reason.value.trim(),
    );
    if (disposed) return;
    saved.value = {
      ...saved.value,
      policy: copy(published),
      runtime: { ...saved.value.runtime, state: "needs-attention" },
    };
    draft.value = copy(published);
    if (result.activation === "applied") {
      const colors = published.palettes.find(
        (item) => item.id === published.activePaletteId,
      )!.colors;
      applyWikiThemeColors(theme, colors);
      applyReaderLayout(published.reading);
      applyCodeTheme(published.codeTheme);
      siteConfig.themeColors = copy(colors);
      siteConfig.readerLayout = copy(published.reading);
      siteConfig.codeTheme = published.codeTheme;
      siteConfig.tocPosition = published.tocPosition;
      wikiStore.site.tocPosition = published.tocPosition;
      rememberOfflinePresentation(wikiStore.user.appearance);
    }
    reviewing.value = false;
    reviewed.value = null;
    reason.value = "";
    attention.value = result.activation !== "applied";
    notice.value = attention.value
      ? tr('themeSavedRuntimeActivation')
      : tr('themePublishedReadersSee');
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
          ? ` ${tr('outcomeUnconfirmedReloadBefore')}`
          : "");
      if (stale.value) {
        notice.value =
          tr('reloadSavedSettingsBefore');
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
    !(await confirmDiscard(
      tr('discardReviewLoadSaved'),
    )) ||
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
    const result = await retryThemeRuntime(saved.value.fingerprint);
    notice.value =
      result.activation === "applied"
        ? tr('runtimeThemeConfigurationApplied')
        : tr('runtimeActivationNeedsAttention');
    attention.value = result.activation !== "applied";
    await load();
  } catch (error) {
    notice.value = errorMessage(error);
    attention.value = true;
  } finally {
    initializing.value = false;
  }
}
const date = (value: string) =>
  Number.isNaN(new Date(value).valueOf()) ? 'Invalid Date' : String(helpers.formatMoment(value, 'L LT'));
const displayValue = (value: unknown) =>
  typeof value === "string"
    ? value || "(empty)"
    : JSON.stringify(value, null, 2);
const canLeave = async () =>
  !busy.value &&
  !initializing.value &&
  ((!dirty.value && !(reviewing.value && reason.value)) ||
    (await confirmDiscard(tr('discardUnsavedThemeChanges'))));
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
onBeforeRouteUpdate(async (to, from) => to.path === from.path || canLeave());
onMounted(() => {
  void load();
  window.addEventListener("beforeunload", beforeUnload);
});
onBeforeUnmount(() => {
  disposed = true;
  draftBarObserver?.disconnect();
  sequence++;
  codePreviewController.abort();
  window.removeEventListener("beforeunload", beforeUnload);
});
</script>
<style lang="scss" src="./theme-workspace.scss"></style>
