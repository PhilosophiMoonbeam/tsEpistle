<template>
  <v-container fluid class="theme-workspace">
    <admin-hero
      icon="mdi-palette-outline"
      :title="$t('admin:theme.title')"
      :description="$t('admin:theme.shapeQuietLegibleHome')"
    >
      <template #actions>
        <v-btn
          variant="text"
          prepend-icon="mdi-refresh"
          :loading="loading"
          :disabled="busy || initializing"
          @click="reload"
          >{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ $t('admin:theme.reloadSavedThemeSettings') }}</v-tooltip></v-btn
        >
        <v-btn v-if="dirty" variant="text" :disabled="locked" @click="reset"
          >{{ $t('admin:theme.resetDraft') }}</v-btn
        >
        <v-btn
          color="primary"
          variant="flat"
          :disabled="locked || !dirty"
          @click="review"
          >{{ $t('admin:theme.reviewChanges') }}</v-btn
        >
      </template>
    </admin-hero>
    <p v-if="!saved && loading" role="status" class="theme-empty">
      {{ $t('admin:theme.loadingPaletteLibrary') }}
    </p>
    <v-alert v-if="loadError" type="error" variant="tonal"
      >{{ loadError
      }}<v-btn variant="text" :disabled="busy" @click="reload"
        >{{ $t('admin:theme.reloadSavedSettings') }}</v-btn
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
            dirty ? $t('admin:theme.unsavedThemeDraft') : $t('admin:theme.showingSavedSettings')
          }}</span
        ><span>{{
          saved.runtime.state === "applied"
            ? $t('admin:theme.runtimeConfigurationCurrent')
            : $t('admin:theme.runtimeActivationNeedsAttention2')
        }}</span>
      </div>
      <nav class="theme-tabs" :aria-label="$t('admin:theme.themeSections')">
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
              <span class="theme-kicker">{{ $t('admin:theme.n01ColorLanguage') }}</span>
              <h2>{{ $t('admin:theme.palettePlace') }}</h2>
              <p>
                {{ $t('admin:theme.keepCollectionPossibilitiesChoose') }}
              </p>
            </div>
            <div class="theme-palette-list" :aria-label="$t('admin:theme.paletteLibrary')">
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
                <strong>{{ item.name || $t('admin:theme.untitledPalette') }}</strong
                ><small>{{
                  item.id === draft.activePaletteId
                    ? dirty
                      ? $t('admin:theme.chosenPublishing')
                      : $t('admin:theme.publishedPalette')
                    : $t('admin:theme.library')
                }}</small>
              </button>
            </div>
            <div class="theme-inline-actions">
              <v-btn
                variant="text"
                prepend-icon="mdi-plus"
                :disabled="locked || draft.palettes.length >= maxPalettes"
                @click="addPalette(false)"
                >{{ $t('admin:theme.newPalette') }}</v-btn
              ><span>{{ draft.palettes.length }} / {{ maxPalettes }}</span>
            </div>
            <div class="theme-setting-group">
              <div class="theme-section-title">
                <h3>{{ $t('admin:theme.editPalette') }}</h3>
                <v-btn
                  v-if="palette.id !== draft.activePaletteId"
                  size="small"
                  variant="tonal"
                  :disabled="locked"
                  @click="draft.activePaletteId = palette.id"
                  >{{ $t('admin:theme.usePalette') }}</v-btn
                >
              </div>
              <v-text-field
                v-model="palette.name"
                :label="$t('admin:theme.paletteName')"
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
                  >{{ $t('admin:theme.duplicate') }}</v-btn
                ><v-btn
                  size="small"
                  variant="text"
                  :disabled="locked || !savedPalette"
                  @click="restorePalette"
                  >{{ $t('admin:theme.restoreSavedColors') }}</v-btn
                ><v-btn
                  size="small"
                  variant="text"
                  :disabled="locked || draft.palettes.length === 1"
                  @click="deleteOpen = true"
                  >{{ $t('admin:theme.deletePalette') }}</v-btn
                >
              </div>
              <div class="theme-mode-heading">
                <h3>{{ $t('admin:theme.colors', { value: mode === "light" ? $t('admin:theme.light') : $t('admin:theme.dark'), interpolation: { escapeValue: false } }) }}</h3>
                <div class="theme-segmented" :aria-label="$t('admin:theme.editColorMode')">
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
                >{{ $t('admin:theme.resetOriginalColors', { mode, interpolation: { escapeValue: false } }) }}</v-btn
              >
            </div>
          </template>
          <template v-else-if="section === 'reader'">
            <div class="theme-heading">
              <span class="theme-kicker">{{ $t('admin:theme.n02ReadingRhythm') }}</span>
              <h2>{{ $t('admin:theme.makeRoomThought') }}</h2>
              <p>
                {{ $t('admin:theme.setReadingProportionsAcross') }}
              </p>
            </div>
            <div class="theme-setting-group theme-reader-fields">
              <v-text-field
                v-model.number="draft.reading.textSize"
                type="number"
                min="14"
                max="24"
                step="1"
                :label="$t('admin:theme.readerTextSize')"
                :suffix="$t('admin:theme.px')"
                variant="outlined"
                :disabled="locked"
                :hint="$t('admin:theme.n1424PxBrowsers')"
                persistent-hint
              />
              <v-text-field
                v-model.number="draft.reading.lineHeight"
                type="number"
                min="1.4"
                max="2"
                step="0.01"
                :label="$t('admin:theme.lineSpacing')"
                suffix="×"
                variant="outlined"
                :disabled="locked"
                :hint="$t('admin:theme.n142Times')"
                persistent-hint
              />
              <v-text-field
                v-model.number="draft.reading.copyWidth"
                type="number"
                min="48"
                max="110"
                step="1"
                :label="$t('admin:theme.maximumLineLength')"
                :suffix="$t('admin:theme.ch')"
                variant="outlined"
                :disabled="locked"
                :hint="$t('admin:theme.n48110CharacterWidths')"
                persistent-hint
              />
              <v-select
                v-model="draft.tocPosition"
                :items="tocOptions"
                :label="$t('admin:theme.contentsPageInformation')"
                variant="outlined"
                :disabled="locked"
                :hint="$t('admin:theme.chooseSidePageRail')"
                persistent-hint
              />
              <v-btn
                variant="text"
                :disabled="locked"
                @click="draft.reading = { ...defaultReading }"
                >{{ $t('admin:theme.restoreReadingDefaults') }}</v-btn
              >
            </div>
            <div class="theme-setting-group">
              <h3>{{ $t('admin:theme.personalPresentation') }}</h3>
              <p>
                {{ $t('admin:theme.eachReaderChoosesSystem') }}
              </p>
              <p class="theme-note">
                {{ $t('admin:theme.workspaceColorsApplyBoth') }}
              </p>
            </div>
            <div class="theme-setting-group">
              <h3>{{ $t('admin:theme.iconCompatibility') }}</h3>
              <v-select
                v-model="draft.iconset"
                :items="iconOptions"
                :label="$t('admin:theme.pageIconLibrary')"
                variant="outlined"
                :disabled="locked"
              />
              <p class="theme-note">
                {{ $t('admin:theme.materialDesignIconsBuilt') }}
              </p>
            </div>
          </template>
          <template v-else-if="section === 'code'">
            <div class="theme-heading">
              <span class="theme-kicker">{{ $t('admin:theme.n03FinishingDetails') }}</span>
              <h2>{{ $t('admin:theme.beyondPalette') }}</h2>
              <p>
                {{ $t('admin:theme.extendReaderPagesCustom') }}
              </p>
            </div>
            <v-alert type="info" variant="tonal" class="mb-5"
              >{{ $t('admin:theme.customHtmlCanRun') }}</v-alert
            >
            <v-alert
              v-if="!saved.capabilities.editCustomCode"
              type="warning"
              variant="tonal"
              class="mb-5"
              >{{ $t('admin:theme.customCssHtmlManaged') }}</v-alert
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
              <span class="theme-kicker">{{ $t('admin:theme.n04PublicationRecord') }}</span>
              <h2>{{ $t('admin:theme.shapeChange') }}</h2>
              <p>
                {{ $t('admin:theme.latest50SavedTheme') }}
              </p>
            </div>
            <p v-if="!saved.history.length" class="theme-empty">
              {{ $t('admin:theme.noThemeChangesHave') }}
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
                  ? $t('admin:theme.apiAdministrator')
                  : $t('admin:theme.administrator', { actorId: event.actorId, interpolation: { escapeValue: false } })
              }}</small>
            </article>
          </template>
        </section>
        <aside class="theme-aside">
          <div class="theme-preview-controls">
            <div>
              <span class="theme-kicker">{{ $t('admin:theme.liveSpecimen') }}</span
              ><strong>{{ palette.name || $t('admin:theme.untitledPalette') }}</strong>
            </div>
            <div class="theme-segmented" :aria-label="$t('admin:theme.previewAppearance')">
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
            :aria-label="$t('admin:theme.readerPreview')"
          >
            <div class="theme-specimen-nav">
              <strong>{{ $t('admin:theme.epistle') }}</strong><span>{{ $t('admin:theme.knowledgeConnected') }}</span
              ><i :style="{ background: previewColors.primary }" />
            </div>
            <div
              class="theme-specimen-body"
              :class="'theme-specimen-body--' + draft.tocPosition"
            >
              <div
                v-if="draft.tocPosition !== 'off'"
                class="theme-specimen-toc"
              >
                <small>{{ $t('admin:theme.page') }}</small><span>{{ $t('admin:theme.sharedUnderstanding') }}</span
                ><span>{{ $t('admin:theme.leaveUsefulTrail') }}</span>
              </div>
              <article>
                <span class="theme-specimen-eyebrow">{{ $t('admin:theme.fieldNotes01') }}</span>
                <h2>{{ $t('admin:theme.sharedUnderstanding') }}</h2>
                <p>
                  {{ $t('admin:theme.goodKnowledgeHasRoom') }}
                </p>
                <h3>{{ $t('admin:theme.leaveUsefulTrail') }}</h3>
                <p>
                  {{ $t('admin:theme.writeNextReaderLink') }}
                </p>
                <div class="theme-specimen-callout">
                  <strong>{{ $t('admin:theme.connectedKnowledge') }}</strong
                  ><span>{{ $t('admin:theme.usefulPersonDiscoverableAgent') }}</span>
                </div>
                <div class="theme-specimen-footer">
                  <span>{{ $t('admin:theme.updatedJustNowExample') }}</span
                  ><span
                    class="theme-specimen-button"
                    :style="{
                      background: previewColors.primary,
                      color: foreground(previewColors.primary),
                    }"
                    >{{ $t('admin:theme.exploreWiki') }}</span
                  >
                </div>
              </article>
            </div>
          </div>
          <div class="theme-preview-options">
            <v-select
              v-model="previewFont"
              :items="fontOptions"
              :label="$t('admin:theme.previewFontOnly')"
              variant="outlined"
              density="compact"
              hide-details
            />
            <p>
              {{ $t('admin:theme.previewingCustomCodeIcon', { value: palette.id === draft.activePaletteId
                  ? $t('admin:theme.chosenPalette')
                  : $t('admin:theme.libraryPalette'), interpolation: { escapeValue: false } }) }}
            </p>
          </div>
          <section class="theme-contrast">
            <div class="theme-section-title">
              <h3>{{ $t('admin:theme.colorContrast') }}</h3>
              <span>{{ $t('admin:theme.surface2', { mode, interpolation: { escapeValue: false } }) }}</span>
            </div>
            <p>
              {{ $t('admin:theme.normalSizeColoredText') }}
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
                item.ratio >= 4.5 ? $t('admin:theme.meets451') : $t('admin:theme.useCare')
              }}</span>
            </div>
            <small
              >{{ $t('admin:theme.theseCalculatedColorPairs') }}</small
            >
          </section>
          <section class="theme-runtime">
            <h3>{{ $t('admin:theme.publication') }}</h3>
            <p>
              {{ $t('admin:theme.savedPalette') }}
              <strong>{{
                saved.policy.palettes.find(
                  (item) => item.id === saved!.policy.activePaletteId,
                )?.name
              }}</strong>
            </p>
            <p>
              {{ $t('admin:theme.changesReachReadersTheir') }}
            </p>
            <v-btn
              v-if="saved.runtime.state !== 'applied'"
              variant="tonal"
              :disabled="locked || dirty"
              :loading="initializing"
              @click="initialize"
              >{{ $t('admin:theme.retryRuntimeActivation') }}</v-btn
            >
          </section>
        </aside>
      </div>
      <div v-if="dirty" class="theme-savebar">
        <span
          >{{ $t('admin:theme.themeDraftImpact', { count: changedFields.length }) }}</span
        ><v-btn variant="text" :disabled="locked" @click="reset">{{ $t('admin:theme.reset') }}</v-btn
        ><v-btn
          color="primary"
          variant="flat"
          :disabled="locked"
          @click="review"
          >{{ $t('admin:theme.reviewChanges') }}</v-btn
        >
      </div>
    </template>
    <v-dialog v-model="deleteOpen" max-width="520"
      ><v-card v-if="draft && palette" :title="$t('admin:theme.deletePalette2')"
        ><v-card-text
          ><p>
            {{ $t('admin:theme.removeDraftYouCan', { name: palette.name, interpolation: { escapeValue: false } }) }}
          </p>
          <v-select
            v-if="palette.id === draft.activePaletteId"
            v-model="replacementId"
            :items="draft.palettes.filter((item) => item.id !== palette!.id)"
            item-title="name"
            item-value="id"
            :label="$t('admin:theme.replacementPublishedPalette')"
            variant="outlined"
            class="mt-5" /></v-card-text
        ><v-card-actions
          ><v-spacer /><v-btn @click="deleteOpen = false">{{ $t('common:actions.cancel') }}</v-btn
          ><v-btn
            :disabled="
              locked || (palette.id === draft.activePaletteId && !replacementId)
            "
            @click="deletePalette"
            >{{ $t('admin:theme.deleteDraft') }}</v-btn
          ></v-card-actions
        ></v-card
      ></v-dialog
    >
    <v-dialog v-model="reviewing" :persistent="busy" max-width="900"
      ><v-card v-if="reviewed && saved" :title="$t('admin:theme.publishThemeChanges')"
        ><v-card-text
          ><p class="mb-5">
            {{ $t('admin:theme.reviewExactDraftBelow') }}
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
                <strong>{{ $t('admin:theme.saved') }}</strong>
                <pre tabindex="0">{{ displayValue(saved.policy[field]) }}</pre>
              </section>
              <section>
                <strong>{{ $t('admin:theme.publishing') }}</strong>
                <pre tabindex="0">{{ displayValue(reviewed[field]) }}</pre>
              </section>
            </div>
          </details>
          <v-textarea
            v-model="reason"
            :label="$t('admin:theme.reasonChange')"
            rows="2"
            variant="outlined"
            maxlength="1000"
            :disabled="busy || stale"
            class="mt-6"
            :hint="$t('admin:theme.n31000Characters')"
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
            >{{ $t('admin:theme.backDraft') }}</v-btn
          ><v-spacer /><v-btn
            v-if="stale"
            :disabled="busy"
            @click="reloadReview"
            >{{ $t('admin:theme.reloadSavedSettings') }}</v-btn
          ><v-btn
            color="primary"
            variant="flat"
            :loading="busy"
            :disabled="locked || reason.trim().length < 3"
            @click="confirm"
            >{{ $t('admin:theme.publishChanges') }}</v-btn
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
  defineAsyncComponent,
  onMounted,
  onBeforeUnmount,
  ref,
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
  contrastRatio,
  contrastForeground,
} from "../../helpers/theme.ts";
import { applyReaderLayout } from "../../helpers/reader-layout.ts";
import { wikiStore } from "../../store/index.ts";
import {
  fetchThemeWorkspace,
  saveThemeWorkspace,
  retryThemeRuntime,
} from "../../helpers/theme-workspace-api.ts";
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const ThemeCodeEditor = defineAsyncComponent(
  () => import("./theme-code-editor.vue"),
);
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : t('admin:theme.themeAdministrationUnavailable');
const route = useRoute(),
  router = useRouter(),
  theme = useTheme();
const saved = ref<ThemeWorkspace | null>(null),
  draft = ref<ThemePolicy | null>(null),
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
const customCodeFields = ["injectCSS", "injectHead", "injectBody"] as const;
type CustomCodeField = (typeof customCodeFields)[number];
const mode = ref<"light" | "dark">("light"),
  previewFont = ref(wikiStore.user.fontFamily);
const modes = ["light", "dark"] as const,
  maxPalettes = MAX_THEME_PALETTES,
  colorKeys = THEME_COLOR_KEYS,
  fieldLabels = themeFieldLabels,
  defaultReading = defaultReaderLayout;
const colorLabels: Record<ThemeColorKey, string> = {
  background: t('admin:theme.background'),
  surface: t('admin:theme.surface'),
  primary: t('admin:theme.primary'),
  secondary: t('admin:theme.secondary'),
  accent: t('admin:theme.accent'),
  info: t('admin:theme.information'),
  success: t('admin:theme.success'),
  warning: t('admin:theme.warning'),
  error: t('admin:theme.error'),
};
const sections = [
  { key: "palettes", title: t('admin:theme.paletteLibrary') },
  { key: "reader", title: t('admin:theme.readerLayout') },
  { key: "code", title: t('admin:theme.customCode') },
  { key: "activity", title: t('admin:theme.activity') },
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
const changedFields = computed(() =>
  saved.value && draft.value
    ? themeChangedFields(saved.value.policy, draft.value)
    : [],
);
const dirty = computed(() => changedFields.value.length > 0);
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
  { title: t('admin:theme.leftRail'), value: "left" },
  { title: t('admin:theme.rightRail'), value: "right" },
  { title: t('admin:theme.hidden'), value: "off" },
];
const iconOptions = [
  { title: t('admin:theme.materialDesignIcons'), value: "mdi" },
  { title: t('admin:theme.fontAwesome5Legacy'), value: "fa" },
  { title: t('admin:theme.fontAwesome4Legacy'), value: "fa4" },
];
const fontOptions = [
  { title: t('admin:theme.blendSerifHeadingsSans'), value: "blend" },
  { title: t('admin:theme.newsreaderSerif'), value: "newsreader" },
  { title: t('admin:theme.robotoFlexSansSerif'), value: "roboto-flex" },
];
const codeFields = [
  {
    key: "injectCSS",
    title: t('admin:theme.customCss'),
    language: "css",
    description:
      t('admin:theme.stylesReaderEditorPages'),
  },
  {
    key: "injectHead",
    title: t('admin:theme.headHtml'),
    language: "html",
    description:
      t('admin:theme.markupInsertedIntoReader'),
  },
  {
    key: "injectBody",
    title: t('admin:theme.bodyHtml'),
    language: "html",
    description:
      t('admin:theme.markupInsertedIntoReader2'),
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
  if (dirty.value && !(await confirmDiscard(t('admin:theme.discardUnsavedThemeChanges'))))
    return;
  if (busy.value || initializing.value) return;
  await load();
}
function reset() {
  if (!locked.value && saved.value) {
    draft.value = copy(saved.value.policy);
    notice.value = "";
    selectedId.value = saved.value.policy.activePaletteId;
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
  next.name = duplicate ? t('admin:theme.copy', { name: next.name.slice(0, 70), interpolation: { escapeValue: false } }) : t('admin:theme.newPalette');
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
    title: t('admin:theme.resetColorsOriginalPalette', { target, interpolation: { escapeValue: false } }),
    confirmLabel: t('admin:theme.resetColors'),
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
      siteConfig.themeColors = copy(colors);
      siteConfig.readerLayout = copy(published.reading);
      siteConfig.tocPosition = published.tocPosition;
    }
    reviewing.value = false;
    reviewed.value = null;
    reason.value = "";
    attention.value = result.activation !== "applied";
    notice.value = attention.value
      ? t('admin:theme.themeSavedRuntimeActivation')
      : t('admin:theme.themePublishedReadersSee');
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
          ? ` ${t('admin:theme.outcomeUnconfirmedReloadBefore')}`
          : "");
      if (stale.value) {
        notice.value =
          t('admin:theme.reloadSavedSettingsBefore');
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
      t('admin:theme.discardReviewLoadSaved'),
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
        ? t('admin:theme.runtimeThemeConfigurationApplied')
        : t('admin:theme.runtimeActivationNeedsAttention');
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
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
const displayValue = (value: unknown) =>
  typeof value === "string"
    ? value || "(empty)"
    : JSON.stringify(value, null, 2);
const canLeave = async () =>
  !busy.value &&
  !initializing.value &&
  ((!dirty.value && !(reviewing.value && reason.value)) ||
    (await confirmDiscard(t('admin:theme.discardUnsavedThemeChanges'))));
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
  sequence++;
  window.removeEventListener("beforeunload", beforeUnload);
});
</script>
<style lang="scss" src="./theme-workspace.scss"></style>
