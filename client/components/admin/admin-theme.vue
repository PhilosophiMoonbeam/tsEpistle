<template>
  <v-container fluid class="theme-workspace">
    <admin-hero
      icon="mdi-palette-outline"
      title="Theme"
      description="Shape a quiet, legible home for knowledge."
    >
      <template #actions>
        <v-btn
          variant="text"
          prepend-icon="mdi-refresh"
          :loading="loading"
          :disabled="busy || initializing"
          @click="reload"
          >Reload settings</v-btn
        >
        <v-btn v-if="dirty" variant="text" :disabled="locked" @click="reset"
          >Reset draft</v-btn
        >
        <v-btn
          color="primary"
          variant="flat"
          :disabled="locked || !dirty"
          @click="review"
          >Review changes</v-btn
        >
      </template>
    </admin-hero>
    <p v-if="!saved && loading" role="status" class="theme-empty">
      Loading your palette library…
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
    <template v-if="saved && draft && palette">
      <div class="theme-status">
        <span
          ><i :class="{ 'is-draft': dirty }" />{{
            dirty ? "Unsaved theme draft" : "Showing saved settings"
          }}</span
        ><span>{{
          saved.runtime.state === "applied"
            ? "Runtime configuration current"
            : "Runtime activation needs attention"
        }}</span>
      </div>
      <nav class="theme-tabs" aria-label="Theme sections">
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
              <span class="theme-kicker">01 / Color language</span>
              <h2>A palette for this place</h2>
              <p>
                Keep a collection of possibilities. Choose which one the
                workspace will use when you publish.
              </p>
            </div>
            <div class="theme-palette-list" aria-label="Palette library">
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
                <strong>{{ item.name || "Untitled palette" }}</strong
                ><small>{{
                  item.id === draft.activePaletteId
                    ? dirty
                      ? "Chosen for publishing"
                      : "Published palette"
                    : "In your library"
                }}</small>
              </button>
            </div>
            <div class="theme-inline-actions">
              <v-btn
                variant="text"
                prepend-icon="mdi-plus"
                :disabled="locked || draft.palettes.length >= maxPalettes"
                @click="addPalette(false)"
                >New palette</v-btn
              ><span>{{ draft.palettes.length }} / {{ maxPalettes }}</span>
            </div>
            <div class="theme-setting-group">
              <div class="theme-section-title">
                <h3>Edit palette</h3>
                <v-btn
                  v-if="palette.id !== draft.activePaletteId"
                  size="small"
                  variant="tonal"
                  :disabled="locked"
                  @click="draft.activePaletteId = palette.id"
                  >Use this palette</v-btn
                >
              </div>
              <v-text-field
                v-model="palette.name"
                label="Palette name"
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
                  >Duplicate</v-btn
                ><v-btn
                  size="small"
                  variant="text"
                  :disabled="locked || !savedPalette"
                  @click="restorePalette"
                  >Restore saved colors</v-btn
                ><v-btn
                  size="small"
                  variant="text"
                  :disabled="locked || draft.palettes.length === 1"
                  @click="deleteOpen = true"
                  >Delete palette</v-btn
                >
              </div>
              <div class="theme-mode-heading">
                <h3>{{ mode === "light" ? "Light" : "Dark" }} colors</h3>
                <div class="theme-segmented" aria-label="Edit color mode">
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
                >Reset {{ mode }} to original colors</v-btn
              >
            </div>
          </template>
          <template v-else-if="section === 'reader'">
            <div class="theme-heading">
              <span class="theme-kicker">02 / Reading rhythm</span>
              <h2>Make room for thought</h2>
              <p>
                Set the reading proportions across wiki pages. Reader font
                choices remain personal.
              </p>
            </div>
            <div class="theme-setting-group theme-reader-fields">
              <v-text-field
                v-model.number="draft.reading.textSize"
                type="number"
                min="14"
                max="24"
                step="1"
                label="Reader text size"
                suffix="px"
                variant="outlined"
                :disabled="locked"
                hint="14–24 px at the browser’s default zoom. Scales with browser text preferences."
                persistent-hint
              />
              <v-text-field
                v-model.number="draft.reading.lineHeight"
                type="number"
                min="1.4"
                max="2"
                step="0.01"
                label="Line spacing"
                suffix="×"
                variant="outlined"
                :disabled="locked"
                hint="1.4–2 times the text size."
                persistent-hint
              />
              <v-text-field
                v-model.number="draft.reading.copyWidth"
                type="number"
                min="48"
                max="110"
                step="1"
                label="Maximum line length"
                suffix="ch"
                variant="outlined"
                :disabled="locked"
                hint="48–110 character widths. Narrow screens adapt; focused reading stays at 72 ch or less."
                persistent-hint
              />
              <v-select
                v-model="draft.tocPosition"
                :items="tocOptions"
                label="Contents & page information"
                variant="outlined"
                :disabled="locked"
                hint="Choose a side for the page rail, or hide it. Small screens use the mobile page controls."
                persistent-hint
              />
              <v-btn
                variant="text"
                :disabled="locked"
                @click="draft.reading = { ...defaultReading }"
                >Restore reading defaults</v-btn
              >
            </div>
            <div class="theme-setting-group">
              <h3>Personal presentation</h3>
              <p>
                Each reader chooses System, Light or Dark appearance and their
                preferred font. The sample’s mode and font selectors only change
                this preview.
              </p>
              <p class="theme-note">
                Workspace colors apply to both appearances. Existing personal
                preferences are preserved.
              </p>
            </div>
            <div class="theme-setting-group">
              <h3>Icon compatibility</h3>
              <v-select
                v-model="draft.iconset"
                :items="iconOptions"
                label="Page icon library"
                variant="outlined"
                :disabled="locked"
              />
              <p class="theme-note">
                Material Design Icons are built in. Font Awesome choices load
                their legacy stylesheet from a third-party CDN for existing page
                content. The administration interface keeps its built-in icons.
              </p>
            </div>
          </template>
          <template v-else-if="section === 'code'">
            <div class="theme-heading">
              <span class="theme-kicker">03 / Finishing details</span>
              <h2>Beyond the palette</h2>
              <p>
                Extend reader pages with custom styles and HTML. Source is
                preserved exactly when saved.
              </p>
            </div>
            <v-alert type="info" variant="tonal" class="mb-5"
              >Custom HTML can run scripts on reader pages. Review it as trusted
              workspace code. This studio does not execute your draft.</v-alert
            >
            <v-alert
              v-if="!saved.capabilities.editCustomCode"
              type="warning"
              variant="tonal"
              class="mb-5"
              >Custom CSS and HTML are managed by full system administrators.
              Existing source is preserved while you edit declarative
              appearance settings.</v-alert
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
              <span class="theme-kicker">04 / Publication record</span>
              <h2>The shape of change</h2>
              <p>
                The latest 50 saved theme changes, with the administrator’s
                reason. Custom source is not copied into this activity record.
              </p>
            </div>
            <p v-if="!saved.history.length" class="theme-empty">
              No theme changes have been recorded yet.
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
                  ? "API administrator"
                  : "Administrator #" + event.actorId
              }}</small>
            </article>
          </template>
        </section>
        <aside class="theme-aside">
          <div class="theme-preview-controls">
            <div>
              <span class="theme-kicker">Live specimen</span
              ><strong>{{ palette.name || "Untitled palette" }}</strong>
            </div>
            <div class="theme-segmented" aria-label="Preview appearance">
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
            aria-label="Reader preview"
          >
            <div class="theme-specimen-nav">
              <strong>Epistle</strong><span>Knowledge, connected.</span
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
                <small>ON THIS PAGE</small><span>A shared understanding</span
                ><span>Leave a useful trail</span>
              </div>
              <article>
                <span class="theme-specimen-eyebrow">FIELD NOTES / 01</span>
                <h2>A shared understanding</h2>
                <p>
                  Good knowledge has room to breathe. A clear page helps people
                  find the thread, understand its context, and carry an idea
                  forward.
                </p>
                <h3>Leave a useful trail</h3>
                <p>
                  Write for the next reader. Link the source, explain the
                  decision, and make space for what comes next.
                </p>
                <div class="theme-specimen-callout">
                  <strong>Connected knowledge</strong
                  ><span>Useful to a person. Discoverable by an agent.</span>
                </div>
                <div class="theme-specimen-footer">
                  <span>Updated just now · Example content</span
                  ><span
                    class="theme-specimen-button"
                    :style="{
                      background: previewColors.primary,
                      color: foreground(previewColors.primary),
                    }"
                    >Explore the wiki ↗</span
                  >
                </div>
              </article>
            </div>
          </div>
          <div class="theme-preview-options">
            <v-select
              v-model="previewFont"
              :items="fontOptions"
              label="Preview font only"
              variant="outlined"
              density="compact"
              hide-details
            />
            <p>
              Previewing
              {{
                palette.id === draft.activePaletteId
                  ? "the chosen palette"
                  : "a library palette"
              }}. Custom code and icon libraries are not loaded here.
            </p>
          </div>
          <section class="theme-contrast">
            <div class="theme-section-title">
              <h3>Color contrast</h3>
              <span>{{ mode }} · on surface</span>
            </div>
            <p>
              For normal-size colored text, aim for 4.5:1. Filled controls use
              an automatically chosen black or white foreground.
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
                item.ratio >= 4.5 ? "Meets 4.5:1" : "Use with care"
              }}</span>
            </div>
            <small
              >These are calculated color pairs, not an accessibility audit of
              rendered pages or custom CSS.</small
            >
          </section>
          <section class="theme-runtime">
            <h3>Publication</h3>
            <p>
              Saved palette:
              <strong>{{
                saved.policy.palettes.find(
                  (item) => item.id === saved!.policy.activePaletteId,
                )?.name
              }}</strong>
            </p>
            <p>
              Changes reach readers on their next page load. Personal appearance
              and font preferences stay in place.
            </p>
            <v-btn
              v-if="saved.runtime.state !== 'applied'"
              variant="tonal"
              :disabled="locked || dirty"
              :loading="initializing"
              @click="initialize"
              >Retry runtime activation</v-btn
            >
          </section>
        </aside>
      </div>
      <div v-if="dirty" class="theme-savebar">
        <span
          >Theme draft · {{ changedFields.length }} changed
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
    <v-dialog v-model="deleteOpen" max-width="520"
      ><v-card v-if="draft && palette" title="Delete this palette?"
        ><v-card-text
          ><p>
            Remove “{{ palette.name }}” from this draft. You can reset the draft
            before publishing.
          </p>
          <v-select
            v-if="palette.id === draft.activePaletteId"
            v-model="replacementId"
            :items="draft.palettes.filter((item) => item.id !== palette!.id)"
            item-title="name"
            item-value="id"
            label="Replacement published palette"
            variant="outlined"
            class="mt-5" /></v-card-text
        ><v-card-actions
          ><v-spacer /><v-btn @click="deleteOpen = false">Cancel</v-btn
          ><v-btn
            :disabled="
              locked || (palette.id === draft.activePaletteId && !replacementId)
            "
            @click="deletePalette"
            >Delete from draft</v-btn
          ></v-card-actions
        ></v-card
      ></v-dialog
    >
    <v-dialog v-model="reviewing" :persistent="busy" max-width="900"
      ><v-card v-if="reviewed && saved" title="Publish theme changes"
        ><v-card-text
          ><p class="mb-5">
            Review the exact draft below. The published palette and reader
            settings affect the workspace on the next page load.
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
                <strong>Saved</strong>
                <pre tabindex="0">{{ displayValue(saved.policy[field]) }}</pre>
              </section>
              <section>
                <strong>Publishing</strong>
                <pre tabindex="0">{{ displayValue(reviewed[field]) }}</pre>
              </section>
            </div>
          </details>
          <v-textarea
            v-model="reason"
            label="Reason for this change"
            rows="2"
            variant="outlined"
            maxlength="1000"
            :disabled="busy || stale"
            class="mt-6"
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
            >Publish changes</v-btn
          ></v-card-actions
        ></v-card
      ></v-dialog
    >
  </v-container>
</template>
<script setup lang="ts">
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
const ThemeCodeEditor = defineAsyncComponent(
  () => import("./theme-code-editor.vue"),
);
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Theme administration is unavailable.";
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
  background: "Background",
  surface: "Surface",
  primary: "Primary",
  secondary: "Secondary",
  accent: "Accent",
  info: "Information",
  success: "Success",
  warning: "Warning",
  error: "Error",
};
const sections = [
  { key: "palettes", title: "Palette library" },
  { key: "reader", title: "Reader & layout" },
  { key: "code", title: "Custom code" },
  { key: "activity", title: "Activity" },
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
  { title: "Left rail", value: "left" },
  { title: "Right rail", value: "right" },
  { title: "Hidden", value: "off" },
];
const iconOptions = [
  { title: "Material Design Icons", value: "mdi" },
  { title: "Font Awesome 5 (legacy CDN)", value: "fa" },
  { title: "Font Awesome 4 (legacy CDN)", value: "fa4" },
];
const fontOptions = [
  { title: "Blend · serif headings, sans body", value: "blend" },
  { title: "Newsreader · serif", value: "newsreader" },
  { title: "Roboto Flex · sans serif", value: "roboto-flex" },
];
const codeFields = [
  {
    key: "injectCSS",
    title: "Custom CSS",
    language: "css",
    description:
      "Styles for reader and editor pages. Scope content rules to .contents. Not applied to administration.",
  },
  {
    key: "injectHead",
    title: "Head HTML",
    language: "html",
    description:
      "Markup inserted into the reader page head, such as metadata or trusted scripts.",
  },
  {
    key: "injectBody",
    title: "Body HTML",
    language: "html",
    description:
      "Markup inserted into the reader page body. Use only code you trust.",
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
  if (
    busy.value ||
    initializing.value ||
    (dirty.value && !window.confirm("Discard unsaved theme changes?"))
  )
    return;
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
  next.name = duplicate ? next.name.slice(0, 70) + " copy" : "New palette";
  draft.value.palettes.push(next);
  selectedId.value = next.id;
}
function restorePalette() {
  if (!locked.value && palette.value && savedPalette.value)
    palette.value.colors = copy(savedPalette.value.colors);
}
function resetMode() {
  if (
    !locked.value &&
    palette.value &&
    window.confirm(`Reset ${mode.value} colors to the original palette?`)
  )
    palette.value.colors[mode.value] = { ...DEFAULT_THEME_COLORS[mode.value] };
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
      ? "Theme saved. Runtime activation needs attention."
      : "Theme published. Readers see these settings on their next page load.";
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
    !window.confirm("Discard this review and load saved theme settings?")
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
        ? "Runtime theme configuration applied."
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
const date = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
const displayValue = (value: unknown) =>
  typeof value === "string"
    ? value || "(empty)"
    : JSON.stringify(value, null, 2);
const canLeave = () =>
  !busy.value &&
  !initializing.value &&
  ((!dirty.value && !(reviewing.value && reason.value)) ||
    window.confirm("Discard unsaved theme changes?"));
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
<style lang="scss" src="./theme-workspace.scss"></style>
