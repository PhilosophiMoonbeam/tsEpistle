<template>
  <v-container fluid class="locale-workspace">
    <admin-hero icon="mdi-translate" title="Locale" description="Make your knowledge feel at home in every language.">
      <template #actions>
        <v-btn variant="text" prepend-icon="mdi-refresh" :disabled="busy || loading" @click="reload">Reload settings</v-btn>
        <v-btn color="primary" :disabled="locked || !dirty" @click="review">Review changes</v-btn>
      </template>
    </admin-hero>
    <async-state
      v-if="loading && !saved"
      state="loading"
      title="Loading language workspace"
      message="Reading installed packages, routing settings and operation history."
    />
    <async-state
      v-else-if="loadError && !saved"
      state="error"
      title="Locale could not be loaded"
      :message="loadError"
      retry-label="Try again"
      @retry="load()"
    />
    <v-alert v-else-if="loadError" type="error" variant="tonal" class="mb-5">{{ loadError }}</v-alert>
    <v-alert v-if="stale && !busy" type="warning" variant="tonal" class="mb-5"
      >The saved language state changed or an operation outcome is unconfirmed. Reload saved settings before another publication.</v-alert
    >
    <v-alert v-if="notice" :type="attention ? 'warning' : 'success'" variant="tonal" class="mb-5">{{ notice }}</v-alert>
    <template v-if="saved && draft">
      <div class="locale-status">
        <span><i :class="{ 'is-draft': dirty }" />{{ dirty ? 'Unsaved language draft' : 'Showing saved languages' }}</span
        ><span>{{ saved.runtime.state === 'applied' ? 'Runtime language current' : 'Runtime activation needs attention' }}</span>
      </div>
      <nav class="locale-tabs" aria-label="Locale sections">
        <button
          v-for="tab in sections"
          :key="tab.key"
          type="button"
          :aria-current="section === tab.key ? 'page' : undefined"
          :disabled="busy"
          @click="selectSection(tab.key)"
        >
          {{ tab.title }}
        </button>
      </nav>
      <div class="locale-layout">
        <section class="locale-editor">
          <template v-if="section === 'languages'">
            <div class="locale-heading">
              <span class="locale-kicker">01 / A multilingual home</span>
              <h2>Welcome every reader</h2>
              <p>Choose the language readers meet first. Add interface packages, then decide which languages belong in the workspace.</p>
            </div>
            <div class="locale-default">
              <div>
                <h3>Default language</h3>
                <p>Used for unprefixed page addresses and the workspace’s default interface.</p>
              </div>
              <v-select
                v-model="draft.locale"
                :items="installed"
                item-title="displayName"
                item-value="code"
                label="Default language"
                variant="outlined"
                density="comfortable"
                hide-details
                :disabled="locked"
              />
            </div>
            <div class="locale-section-head">
              <div>
                <h3>Installed languages</h3>
                <p>
                  {{
                    draft.namespacing
                      ? 'Select the languages offered in the reader’s language menu.'
                      : 'Multilingual routing is off. Other installed packages remain available for later use.'
                  }}
                </p>
              </div>
              <v-btn variant="text" append-icon="mdi-arrow-right" @click="selectSection('library')">Find a language</v-btn>
            </div>
            <div class="locale-installed">
              <article
                v-for="locale in installed"
                :key="locale.code"
                class="locale-language"
                :class="{ 'is-default': locale.code === draft.locale }"
              >
                <span class="locale-code" aria-hidden="true">{{ locale.code }}</span>
                <div class="locale-language-body">
                  <h4>{{ locale.nativeName }} <span v-if="locale.code === draft.locale" class="locale-badge">Default</span></h4>
                  <p>{{ locale.name }} · {{ locale.isRTL ? 'Right to left' : 'Left to right' }}</p>
                  <div class="locale-language-counts">
                    <span>{{ locale.pages }} public pages</span><span>{{ locale.linkedTranslations }} in translation sets</span
                    ><span>{{ locale.menuItems }} menu items</span>
                  </div>
                </div>
                <v-checkbox
                  :model-value="enabled(locale.code)"
                  :disabled="locked || !draft.namespacing || locale.code === draft.locale"
                  :aria-label="`Offer ${locale.name} to readers`"
                  hide-details
                  density="compact"
                  @update:model-value="toggleLanguage(locale.code, $event === true)"
                />
              </article>
            </div>
            <div class="locale-note">
              <v-icon icon="mdi-information-outline" size="20" />
              <p>
                Installing a language translates supported interface labels. Wiki pages are translated separately by their authors;
                installing a package does not create translated pages.
              </p>
            </div>
            <div class="locale-section-head">
              <div>
                <h3>Keep translations connected</h3>
                <p>
                  Use page translation sets to link related versions. Each version keeps its own content, publication status and page
                  permissions.
                </p>
              </div>
              <v-btn variant="text" to="/pages" append-icon="mdi-arrow-right">Manage pages</v-btn>
            </div>
          </template>
          <template v-else-if="section === 'routing'">
            <div class="locale-heading">
              <span class="locale-kicker">02 / Language & location</span>
              <h2>A clear address for every language</h2>
              <p>Choose how readers move between languages. Routing changes retain existing pages and custom navigation.</p>
            </div>
            <div class="locale-setting">
              <div>
                <h3>Multilingual workspace</h3>
                <p>Offer the selected reading languages and use an explicit language prefix in page addresses.</p>
              </div>
              <v-switch
                v-model="draft.namespacing"
                :disabled="locked"
                aria-label="Multilingual workspace"
                hide-details
                color="primary"
                inset
              />
            </div>
            <div class="locale-paths">
              <div>
                <span>Default home</span><code>{{ localeReadingPath(draft) }}</code>
              </div>
              <div v-for="locale in readingLanguages.filter((row) => row.code !== draft?.locale)" :key="locale.code">
                <span>{{ locale.nativeName }}</span
                ><code>{{ localeReadingPath(draft, locale.code) }}</code>
              </div>
            </div>
            <v-alert v-if="draft.namespacing" type="info" variant="tonal" class="my-5"
              >Unprefixed page addresses redirect to {{ draft.locale }}. A language prefix identifies a page’s language; it does not
              translate the page.</v-alert
            >
            <div class="locale-setting">
              <div>
                <h3>Automatic interface updates</h3>
                <p>Let the daily language synchronization refresh the default and enabled language packages. Page content is unchanged.</p>
                <p v-if="saved.catalog.offline" class="locale-muted">Updates are paused while offline mode is active.</p>
              </div>
              <v-switch
                v-model="draft.autoUpdate"
                :disabled="locked"
                aria-label="Automatic interface updates"
                hide-details
                color="primary"
                inset
              />
            </div>
            <div class="locale-related">
              <v-icon icon="mdi-compass-outline" size="23" />
              <div>
                <h3>Give each language its own menu</h3>
                <p>Curate destinations and audience visibility in Navigation. Disabled languages keep their saved menus.</p>
              </div>
              <v-btn variant="text" to="/navigation" append-icon="mdi-arrow-right">Navigation</v-btn>
            </div>
          </template>
          <template v-else-if="section === 'library'">
            <div class="locale-heading">
              <span class="locale-kicker">03 / Interface packages</span>
              <h2>A library of languages</h2>
              <p>
                Install a language before offering it to readers. Package operations run durably on the server and remain visible in
                Activity.
              </p>
            </div>
            <v-alert v-if="saved.catalog.offline" type="info" variant="tonal" class="mb-5"
              >Offline mode pauses remote catalog and package requests. Reviewed local translation files remain available and do not make
              network requests.</v-alert
            >
            <div class="locale-library-toolbar">
              <v-text-field
                v-model="search"
                label="Find a language"
                prepend-inner-icon="mdi-magnify"
                variant="outlined"
                density="compact"
                hide-details
                clearable
              /><v-select
                v-model="packageFilter"
                :items="packageFilters"
                label="Package filter"
                variant="outlined"
                density="compact"
                hide-details
              /><v-btn variant="text" prepend-icon="mdi-refresh" :disabled="!canOperate" @click="openOperation('catalog')"
                >Refresh catalog</v-btn
              >
            </div>
            <p class="locale-catalog-source">
              {{ filteredPackages.length }} languages · {{ saved.catalog.source || 'Source unavailable' }} ·
              {{ saved.catalog.observedAt ? 'Catalog checked ' + date(saved.catalog.observedAt) : 'Cached catalog; refresh time unknown' }}
            </p>
            <section class="locale-local-import" aria-labelledby="locale-local-import-title">
              <div class="locale-local-import__heading">
                <v-icon icon="mdi-file-upload-outline" size="23" />
                <div>
                  <span class="locale-kicker">Reviewed local package</span>
                  <h3 id="locale-local-import-title">Install from a translation file</h3>
                  <p>Choose a supported language, review its key changes, then queue publication through the locale worker.</p>
                </div>
              </div>
              <div class="locale-local-import__form">
                <label class="locale-local-import__file" for="locale-local-file">
                  <span>Flat UTF-8 JSON file · maximum 8 MiB</span>
                  <input
                    id="locale-local-file"
                    ref="localFileInput"
                    type="file"
                    accept=".json,application/json"
                    :disabled="!canUploadLocalFile"
                    @change="selectLocalFile"
                  />
                  <small v-if="localFile">{{ localFile.name }} · {{ byteSize(localFile.size) }}</small>
                  <small v-else>Filename is only a label; it does not select the language.</small>
                </label>
                <v-select
                  v-model="localCode"
                  :items="uploadLocales"
                  item-title="displayName"
                  item-value="code"
                  label="Target language"
                  variant="outlined"
                  density="comfortable"
                  :disabled="!canUploadLocalFile || (localReview !== null && localFile === null)"
                  @update:model-value="clearLocalReview"
                />
                <v-textarea
                  v-model="localReason"
                  label="Reason for installing this file"
                  variant="outlined"
                  rows="2"
                  maxlength="1000"
                  counter
                  :disabled="!canUploadLocalFile || (localReview !== null && localFile === null)"
                  @update:model-value="clearLocalReview"
                />
              </div>
              <v-alert v-if="localUploadError" type="error" variant="tonal" class="mb-3">{{ localUploadError }}</v-alert>
              <div class="locale-local-import__actions">
                <span v-if="localReview" class="locale-muted">Review expires {{ date(localReview.expiresAt) }}</span>
                <v-btn
                  color="primary"
                  variant="tonal"
                  :disabled="!canReviewLocalFile"
                  :loading="busy"
                  @click="reviewLocalUpload"
                  >Review file</v-btn
                >
              </div>
              <div v-if="localReview" class="locale-local-import__review">
                <div class="locale-local-import__identity">
                  <span class="locale-code" aria-hidden="true">{{ localReview.code }}</span>
                  <div>
                    <h4>{{ localReview.nativeName }} <small>({{ localReview.code }})</small></h4>
                    <p>{{ localReview.name }} · SHA-256 <code>{{ localReview.digest }}</code></p>
                    <p>Reason: {{ localReview.reason }}</p>
                  </div>
                </div>
                <div class="locale-local-import__counts" aria-label="Translation key changes">
                  <span><strong>{{ localReview.changes.added.length }}</strong> added</span>
                  <span><strong>{{ localReview.changes.changed.length }}</strong> changed</span>
                  <span><strong>{{ localReview.changes.removed.length }}</strong> removed</span>
                </div>
                <details
                  v-for="change in reviewChangeTypes"
                  :key="change.key"
                  class="locale-local-import__change-list"
                  @toggle="toggleReviewChanges(change.key, $event)"
                >
                  <summary>{{ change.label }} · {{ localReview.changes[change.key].length }} keys</summary>
                  <ul v-if="openReviewChange === change.key">
                    <li v-for="key in localReview.changes[change.key]" :key="key"><code>{{ key }}</code></li>
                  </ul>
                </details>
                <p class="locale-muted">The staged bytes, administrator, reason and installed-package fingerprint are bound to this review.</p>
                <div class="locale-local-import__actions">
                  <v-btn
                    color="primary"
                    variant="flat"
                    :disabled="!canCommitLocalFile"
                    :loading="busy"
                    @click="commitLocalUpload"
                    >Commit and queue publication</v-btn
                  >
                </div>
              </div>
            </section>
            <p v-if="dirty" class="locale-muted">Save or reset the language draft before starting a package operation.</p>
            <div v-if="filteredPackages.length" class="locale-package-list">
              <article v-for="locale in filteredPackages" :key="locale.code" class="locale-package-row">
                <span class="locale-code" aria-hidden="true">{{ locale.code }}</span>
                <div class="locale-package-name">
                  <h3>{{ locale.nativeName }}</h3>
                  <p>{{ locale.name }} · {{ locale.isRTL ? 'RTL' : 'LTR' }}</p>
                  <span v-if="locale.isInstalled" class="locale-badge">{{
                    updateAvailable(locale) ? 'Update available' : 'Installed'
                  }}</span>
                </div>
                <div class="locale-coverage">
                  <strong>{{ locale.availability }}<small>%</small></strong
                  ><span>Upstream interface coverage</span>
                  <div class="locale-coverage-track" aria-hidden="true"><i :style="{ width: locale.availability + '%' }" /></div>
                </div>
                <v-btn
                  :variant="locale.isInstalled ? 'text' : 'tonal'"
                  :disabled="!canOperate || !locale.availableRemotely"
                  :aria-label="`${locale.isInstalled ? 'Refresh' : 'Install'} ${locale.name} package`"
                  @click="openOperation('install', locale)"
                  >{{ locale.isInstalled ? 'Refresh package' : 'Install' }}</v-btn
                >
              </article>
            </div>
            <async-state
              v-else
              state="empty"
              title="No matching languages"
              message="Try another name or package filter. Refresh the catalog to check the configured source."
            />
            <div class="locale-note">
              <v-icon icon="mdi-translate" size="20" />
              <p>
                Coverage is reported by the upstream translation catalog. It does not measure translated wiki pages or newer tsEpistle
                labels. Missing supported strings fall back to bundled English.
              </p>
            </div>
          </template>
          <template v-else>
            <div class="locale-heading">
              <span class="locale-kicker">04 / Changes & operations</span>
              <h2>A traceable language workspace</h2>
              <p>Follow server work and review why the workspace changed. Queued operations continue when this page closes.</p>
            </div>
            <h3 class="mb-4">Package operations</h3>
            <div v-if="saved.operations.length" class="locale-operations">
              <article v-for="operation in saved.operations" :key="operation.id" class="locale-operation">
                <v-icon :icon="operationIcon(operation.state)" size="22" />
                <div>
                  <h4>
                    {{
                      operation.kind === 'catalog'
                        ? 'Refresh language catalog'
                        : operation.kind === 'local'
                          ? 'Install reviewed local file · ' + operation.code
                          : 'Install / refresh ' + operation.code
                    }}
                  </h4>
                  <p>
                    {{ date(operation.createdAt) }} · Attempt {{ operation.attempts }}
                    <span v-if="operation.message">· {{ operation.message }}</span>
                  </p>
                </div>
                <span class="locale-badge">{{ stateName(operation.state) }}</span>
              </article>
            </div>
            <p v-else class="locale-muted">
              No recorded package operations. Installed packages from before this workspace have no reconstructed operation history.
            </p>
            <h3 class="mt-8 mb-4">Administrative changes</h3>
            <div v-if="saved.history.length" class="locale-history">
              <article v-for="event in saved.history" :key="event.id">
                <span class="locale-history-mark" />
                <div>
                  <h4>{{ event.reason }}</h4>
                  <p>{{ event.fields.map(fieldName).join(' · ') }}</p>
                  <small
                    >{{ date(event.createdAt) }} · {{ event.actorId ? 'Administrator #' + event.actorId : 'System / API'
                    }}<span v-if="event.kind !== 'settings'">
                      · {{ event.appliedAt ? 'Published ' + date(event.appliedAt) : 'Requested' }}</span
                    ></small
                  >
                </div>
              </article>
            </div>
            <p v-else class="locale-muted">No recorded settings changes yet. The latest 50 administrative changes will appear here.</p>
          </template>
        </section>
        <aside class="locale-aside" aria-label="Language workspace overview">
          <span class="locale-kicker">Reader language menu</span>
          <div class="locale-specimen">
            <div>
              <v-icon icon="mdi-web" size="20" /><strong>{{ languageName(draft.locale) }}</strong>
            </div>
            <ul v-if="draft.namespacing">
              <li v-for="locale in readingLanguages" :key="locale.code" :dir="locale.isRTL ? 'rtl' : 'ltr'">
                <span>{{ locale.nativeName }}</span
                ><v-icon v-if="locale.code === draft.locale" icon="mdi-check" size="17" />
              </li>
            </ul>
            <p v-else>One default language. Multilingual routing is off.</p>
            <small>Illustrative reader menu</small>
          </div>
          <dl class="locale-summary">
            <div>
              <dt>Installed packages</dt>
              <dd>{{ installed.length }}</dd>
            </div>
            <div>
              <dt>Reading languages</dt>
              <dd>{{ readingLanguages.length }}</dd>
            </div>
            <div>
              <dt>Automatic updates</dt>
              <dd>{{ saved.catalog.offline ? 'Paused offline' : draft.autoUpdate ? 'Daily' : 'Off' }}</dd>
            </div>
          </dl>
          <div v-if="activeOperation" class="locale-running" role="status">
            <v-progress-circular indeterminate size="20" width="2" />
            <div>
              <strong>{{ stateName(activeOperation.state) }}</strong>
              <p>{{ activeOperation.kind === 'catalog' ? 'Language catalog refresh' : 'Package: ' + activeOperation.code }}</p>
              <v-btn variant="text" size="small" @click="selectSection('activity')">View operation</v-btn>
            </div>
          </div>
          <div class="locale-publication">
            <h3>Publication</h3>
            <p>
              Language settings take effect for readers on their next page load. An installed package becomes a reading language only when
              selected here.
            </p>
            <v-btn v-if="dirty" variant="outlined" :disabled="busy" @click="reset">Reset draft</v-btn
            ><v-btn v-if="saved.runtime.state !== 'applied'" variant="tonal" :disabled="locked || dirty" @click="initialize"
              >Retry runtime activation</v-btn
            >
          </div>
        </aside>
      </div>
    </template>
    <v-dialog v-model="reviewing" max-width="760" :persistent="busy" scrollable>
      <v-card class="locale-dialog"
        ><v-card-title><h2>Review language settings</h2></v-card-title
        ><v-card-text
          ><p>Confirm the saved and proposed settings before publication.</p>
          <div v-if="saved && reviewed" class="locale-review">
            <div v-for="field in changedFields" :key="field">
              <h3>{{ fieldName(field) }}</h3>
              <div>
                <section>
                  <small>Saved</small>
                  <p>{{ reviewValue(saved.policy, field) }}</p>
                </section>
                <section>
                  <small>Proposed</small>
                  <p>{{ reviewValue(reviewed, field) }}</p>
                </section>
              </div>
            </div>
          </div>
          <v-textarea
            v-model="reason"
            label="Reason for this change"
            variant="outlined"
            rows="2"
            maxlength="1000"
            counter
            :disabled="busy"
          /><v-alert v-if="saveError" type="error" variant="tonal">{{ saveError }}</v-alert></v-card-text
        ><v-card-actions
          ><v-btn v-if="stale" variant="text" :disabled="busy" @click="reload">Reload saved settings</v-btn><v-spacer /><v-btn
            :disabled="busy"
            @click="reviewing = false"
            >Back to draft</v-btn
          ><v-btn color="primary" variant="flat" :disabled="locked || reason.trim().length < 3" :loading="busy" @click="confirm"
            >Publish languages</v-btn
          ></v-card-actions
        ></v-card
      >
    </v-dialog>
    <v-dialog v-model="operationOpen" max-width="600" :persistent="busy" scrollable>
      <v-card class="locale-dialog"
        ><v-card-title
          ><h2>
            {{
              operationKind === 'catalog'
                ? 'Refresh language catalog'
                : operationLocale?.isInstalled
                  ? 'Refresh interface package'
                  : 'Install interface package'
            }}
          </h2></v-card-title
        ><v-card-text
          ><template v-if="operationKind === 'install' && operationLocale"
            ><div class="locale-operation-subject">
              <span class="locale-code">{{ operationLocale.code }}</span>
              <div>
                <h3>{{ operationLocale.nativeName }}</h3>
                <p>{{ operationLocale.name }} · {{ operationLocale.isRTL ? 'Right to left' : 'Left to right' }}</p>
              </div>
            </div>
            <p>
              The server will fetch the latest package from {{ saved?.catalog.source }}. This replaces supported interface strings for this
              language. Page content and reading-language selection remain unchanged.
            </p></template
          >
          <p v-else>
            Check {{ saved?.catalog.source }} for available interface packages and their reported coverage. Refreshing the catalog does not
            install or update packages.
          </p>
          <p>Progress and the result are recorded in Activity. The worker can retry transient failures.</p>
          <v-textarea
            v-model="operationReason"
            label="Reason for this operation"
            variant="outlined"
            rows="2"
            maxlength="1000"
            counter
            :disabled="busy"
          /><v-alert v-if="saveError" type="error" variant="tonal">{{ saveError }}</v-alert></v-card-text
        ><v-card-actions
          ><v-btn v-if="stale" :disabled="busy" @click="reload">Reload saved settings</v-btn><v-spacer /><v-btn
            :disabled="busy"
            @click="operationOpen = false"
            >Cancel</v-btn
          ><v-btn
            color="primary"
            variant="flat"
            :disabled="!canOperate || operationReason.trim().length < 3"
            :loading="busy"
            @click="startOperation"
            >Queue operation</v-btn
          ></v-card-actions
        ></v-card
      >
    </v-dialog>
  </v-container>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import AsyncState from '@/components/common/async-state.vue'
import {
  LocalePolicySchema,
  LocaleFileReviewSchema,
  MAX_LOCALE_FILE_BYTES,
  localeChangedFields,
  localeReadingPath,
  type LocaleFileReview,
  type LocalePackage,
  type LocalePolicy,
  type LocaleWorkspace,
} from '../../../shared/locale-policy.ts'
import {
  commitLocaleFile,
  fetchLocaleWorkspace,
  queueLocaleOperation,
  retryLocaleRuntime,
  reviewLocaleFile,
  saveLocaleWorkspace,
} from '../../helpers/locale-workspace-api.ts'
const route = useRoute(),
  router = useRouter(),
  sections = [
    { key: 'languages', title: 'Languages' },
    { key: 'routing', title: 'Routing' },
    { key: 'library', title: 'Package library' },
    { key: 'activity', title: 'Activity' },
  ]
const section = computed(() => (sections.some((tab) => tab.key === route.query.section) ? String(route.query.section) : 'languages'))
const saved = ref<LocaleWorkspace | null>(null),
  draft = ref<LocalePolicy | null>(null),
  reviewed = ref<LocalePolicy | null>(null)
const loading = ref(false),
  busy = ref(false),
  stale = ref(false),
  loadError = ref(''),
  notice = ref(''),
  attention = ref(false),
  saveError = ref('')
const reviewing = ref(false),
  reason = ref(''),
  reviewFingerprint = ref(''),
  operationOpen = ref(false),
  operationReason = ref(''),
  operationKind = ref<'catalog' | 'install'>('catalog'),
  operationLocale = ref<LocalePackage | null>(null)
const localFile = ref<File | null>(null),
  localFileInput = ref<HTMLInputElement | null>(null),
  localCode = ref<string | null>(null),
  localReason = ref(''),
  localReview = ref<LocaleFileReview | null>(null),
  localUploadError = ref(''),
  openReviewChange = ref<'added' | 'changed' | 'removed' | null>(null),
  reviewChangeTypes = [
    { key: 'added', label: 'Added keys' },
    { key: 'changed', label: 'Changed keys' },
    { key: 'removed', label: 'Removed keys' },
  ] as const
const search = ref(''),
  packageFilter = ref('all'),
  packageFilters = [
    { title: 'All packages', value: 'all' },
    { title: 'Installed', value: 'installed' },
    { title: 'Not installed', value: 'available' },
    { title: 'Updates available', value: 'updates' },
  ]
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const normalizedDraft = computed(() => (draft.value ? LocalePolicySchema.safeParse(draft.value) : null))
const dirty = computed(() =>
  Boolean(
    saved.value &&
    draft.value &&
    localeChangedFields(saved.value.policy, normalizedDraft.value?.success ? normalizedDraft.value.data : draft.value).length,
  ),
)
const locked = computed(() => loading.value || busy.value || stale.value)
const installed = computed(() =>
  (saved.value?.locales || [])
    .filter((locale) => locale.isInstalled)
    .map((locale) => ({ ...locale, displayName: `${locale.nativeName} (${locale.code})` })),
)
const readingLanguages = computed(() =>
  installed.value.filter(
    (locale) => locale.code === draft.value?.locale || (draft.value?.namespacing && draft.value.namespaces.includes(locale.code)),
  ),
)
const activeOperation = computed(() => saved.value?.operations.find((operation) => ['pending', 'running'].includes(operation.state)))
const canOperate = computed(() =>
  Boolean(saved.value && !locked.value && !dirty.value && !activeOperation.value && !saved.value.catalog.offline),
)
const uploadLocales = computed(() =>
  (saved.value?.locales || [])
    .filter((locale) => locale.code !== 'en')
    .map((locale) => ({
      code: locale.code,
      displayName: `${locale.nativeName} (${locale.code}) · ${locale.isInstalled ? 'installed' : 'catalog'}`,
    })),
)
const canUploadLocalFile = computed(() =>
  Boolean(saved.value && !locked.value && !dirty.value && !activeOperation.value),
)
const canReviewLocalFile = computed(() =>
  Boolean(
    canUploadLocalFile.value &&
    localFile.value &&
    localFile.value.size <= MAX_LOCALE_FILE_BYTES &&
    localCode.value &&
    localReason.value.trim().length >= 3,
  ),
)
const canCommitLocalFile = computed(() =>
  Boolean(
    saved.value &&
    !locked.value &&
    !dirty.value &&
    !activeOperation.value &&
    localReview.value &&
    Date.parse(localReview.value.expiresAt) > Date.now(),
  ),
)
const hasLocalDraft = computed(() =>
  Boolean(localFile.value || localCode.value || localReason.value.trim() || localReview.value),
)
const updateAvailable = (locale: LocalePackage) =>
  locale.isInstalled && locale.updatedAt && locale.installDate && Date.parse(locale.updatedAt) > Date.parse(locale.installDate)
const filteredPackages = computed(() =>
  (saved.value?.locales || []).filter(
    (locale) =>
      `${locale.name} ${locale.nativeName} ${locale.code}`.toLocaleLowerCase().includes((search.value || '').trim().toLocaleLowerCase()) &&
      (packageFilter.value === 'all' ||
        (packageFilter.value === 'installed' && locale.isInstalled) ||
        (packageFilter.value === 'available' && !locale.isInstalled) ||
        (packageFilter.value === 'updates' && updateAvailable(locale))),
  ),
)
const changedFields = computed(() => (saved.value && reviewed.value ? localeChangedFields(saved.value.policy, reviewed.value) : []))
const languageName = (code: string) => saved.value?.locales.find((locale) => locale.code === code)?.nativeName || code
const enabled = (code: string) => code === draft.value?.locale || Boolean(draft.value?.namespacing && draft.value.namespaces.includes(code))
function toggleLanguage(code: string, checked: boolean) {
  if (locked.value || !draft.value || code === draft.value.locale) return
  draft.value.namespaces = checked
    ? [...new Set([...draft.value.namespaces, code])]
    : draft.value.namespaces.filter((value) => value !== code)
}
function selectSection(key: string) {
  void router.replace({ query: { ...route.query, section: key } })
}
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'The request could not be completed.')
let sequence = 0,
  disposed = false,
  poll: ReturnType<typeof setTimeout> | undefined
function schedulePoll() {
  clearTimeout(poll)
  if (!disposed && activeOperation.value)
    poll = setTimeout(() => {
      void load(true)
    }, 3000)
}
async function load(background = false) {
  if (busy.value) return
  const seq = ++sequence
  if (!background) loading.value = true
  try {
    const result = await fetchLocaleWorkspace()
    if (disposed || seq !== sequence) return
    const staged = result.localFileReview ? LocaleFileReviewSchema.safeParse(result.localFileReview) : null,
      stagedReview = staged?.success ? staged.data : null
    if (background && (dirty.value || reviewing.value || operationOpen.value || hasLocalDraft.value) && saved.value) {
      if (
        result.fingerprint !== saved.value.fingerprint ||
        (localReview.value !== null && stagedReview?.id !== localReview.value.id)
      )
        stale.value = true
      saved.value = { ...result, policy: saved.value.policy, fingerprint: saved.value.fingerprint }
    } else {
      saved.value = result
      draft.value = copy(result.policy)
      localReview.value = stagedReview
      localCode.value = stagedReview?.code ?? null
      localReason.value = stagedReview?.reason ?? ''
      stale.value = false
    }
    loadError.value = ''
  } catch (error) {
    if (!disposed && seq === sequence) loadError.value = errorMessage(error)
  } finally {
    if (!disposed && seq === sequence) {
      loading.value = false
      schedulePoll()
    }
  }
}
async function reload() {
  if (
    busy.value ||
    ((dirty.value || hasLocalDraft.value) &&
      !window.confirm('Discard this draft and reload? An unexpired server-reviewed file remains available to commit.'))
  )
    return
  reviewing.value = false
  operationOpen.value = false
  localFile.value = null
  localReview.value = null
  localCode.value = null
  localReason.value = ''
  if (localFileInput.value) localFileInput.value.value = ''
  await load()
}
function reset() {
  if (busy.value || !saved.value) return
  draft.value = copy(saved.value.policy)
  saveError.value = ''
  notice.value = ''
}
function review() {
  if (locked.value || !dirty.value || !saved.value || !draft.value) return
  const result = LocalePolicySchema.safeParse(draft.value)
  if (!result.success) {
    notice.value = result.error.issues.map((issue) => issue.message).join(' ')
    attention.value = true
    return
  }
  reviewed.value = copy(result.data)
  reviewFingerprint.value = saved.value.fingerprint
  reason.value = ''
  saveError.value = ''
  reviewing.value = true
}
function writeFailure(error: unknown) {
  const status = error && typeof error === 'object' ? Number(Reflect.get(error, 'status')) : 0
  stale.value = !status || status >= 500 || [401, 403, 409].includes(status)
  saveError.value = errorMessage(error) + (stale.value ? ' Reload saved settings before another attempt.' : '')
}
async function confirm() {
  if (locked.value || !saved.value || !reviewed.value || reason.value.trim().length < 3) return
  busy.value = true
  saveError.value = ''
  try {
    const result = await saveLocaleWorkspace(copy(reviewed.value), reviewFingerprint.value, reason.value.trim())
    if (disposed) return
    saved.value = { ...saved.value, policy: copy(reviewed.value), runtime: { ...saved.value.runtime, state: 'needs-attention' } }
    draft.value = copy(reviewed.value)
    reviewing.value = false
    reviewed.value = null
    attention.value = result.activation !== 'applied'
    notice.value = attention.value
      ? 'Languages saved. Runtime activation needs attention.'
      : 'Languages published. Readers see the settings on their next page load.'
    stale.value = true
    busy.value = false
    await load()
  } catch (error) {
    if (!disposed) writeFailure(error)
  } finally {
    if (!disposed) busy.value = false
  }
}
function openOperation(kind: 'install' | 'catalog', locale?: LocalePackage) {
  if (!canOperate.value || !saved.value) return
  operationKind.value = kind
  operationLocale.value = locale || null
  operationReason.value = ''
  reviewFingerprint.value = saved.value.fingerprint
  saveError.value = ''
  operationOpen.value = true
}
async function startOperation() {
  if (!canOperate.value || operationReason.value.trim().length < 3) return
  busy.value = true
  saveError.value = ''
  try {
    await queueLocaleOperation(operationKind.value, operationLocale.value?.code, reviewFingerprint.value, operationReason.value.trim())
    if (disposed) return
    operationOpen.value = false
    notice.value = 'Language operation queued. Follow its progress in Activity.'
    attention.value = false
    stale.value = true
    busy.value = false
    selectSection('activity')
    await load()
  } catch (error) {
    if (!disposed) writeFailure(error)
  } finally {
    if (!disposed) busy.value = false
  }
}
function clearLocalReview() {
  localReview.value = null
  openReviewChange.value = null
}
function selectLocalFile(event: Event) {
  const input = event.currentTarget
  if (!(input instanceof HTMLInputElement)) return
  const file = input.files?.[0] ?? null
  clearLocalReview()
  localUploadError.value = ''
  localFile.value = file
  if (file && file.size > MAX_LOCALE_FILE_BYTES) {
    localUploadError.value = 'The selected language file exceeds the 8 MiB limit.'
    localFile.value = null
    input.value = ''
  }
}
function toggleReviewChanges(kind: 'added' | 'changed' | 'removed', event: Event) {
  const details = event.currentTarget
  if (details instanceof HTMLDetailsElement) openReviewChange.value = details.open ? kind : null
}
const byteSize = (size: number) =>
  size < 1024 ? `${size} bytes` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1024 / 1024).toFixed(2)} MiB`
function localWriteFailure(error: unknown) {
  const status = error && typeof error === 'object' ? Number(Reflect.get(error, 'status')) : 0
  localUploadError.value = errorMessage(error)
  if (!status || status >= 500 || [401, 403, 409].includes(status)) stale.value = true
}
async function reviewLocalUpload() {
  if (!canReviewLocalFile.value || !saved.value || !localFile.value || !localCode.value) return
  busy.value = true
  localUploadError.value = ''
  try {
    const result = await reviewLocaleFile(localFile.value, localCode.value, saved.value.fingerprint, localReason.value.trim())
    if (disposed) return
    localReview.value = LocaleFileReviewSchema.parse(result)
    localCode.value = localReview.value.code
    localReason.value = localReview.value.reason
    openReviewChange.value = null
  } catch (error) {
    if (!disposed) localWriteFailure(error)
  } finally {
    if (!disposed) busy.value = false
  }
}
async function commitLocalUpload() {
  if (!canCommitLocalFile.value || !localReview.value) return
  busy.value = true
  localUploadError.value = ''
  try {
    await commitLocaleFile(localReview.value.id)
    if (disposed) return
    localFile.value = null
    localReview.value = null
    localCode.value = null
    localReason.value = ''
    if (localFileInput.value) localFileInput.value.value = ''
    notice.value = 'Reviewed local language file queued for publication. Follow its result in Activity.'
    attention.value = false
    stale.value = true
    busy.value = false
    selectSection('activity')
    await load()
  } catch (error) {
    if (!disposed) localWriteFailure(error)
  } finally {
    if (!disposed) busy.value = false
  }
}
async function initialize() {
  if (locked.value || dirty.value || !saved.value) return
  busy.value = true
  try {
    const result = await retryLocaleRuntime(saved.value.fingerprint)
    if (disposed) return
    attention.value = result.activation !== 'applied'
    notice.value = attention.value
      ? 'Runtime activation needs attention. Review server diagnostics.'
      : 'Runtime language resources applied.'
    busy.value = false
    await load()
  } catch (error) {
    notice.value = errorMessage(error)
    attention.value = true
  } finally {
    busy.value = false
  }
}
const fieldName = (field: string) =>
  ({
    locale: 'Default language',
    namespacing: 'Multilingual routing',
    namespaces: 'Reading languages',
    autoUpdate: 'Automatic interface updates',
    catalog: 'Language catalog',
  })[field] || field.replace('package:', 'Package: ')
const reviewValue = (policy: LocalePolicy, field: string) =>
  field === 'locale'
    ? `${languageName(policy.locale)} (${policy.locale})`
    : field === 'namespaces'
      ? policy.namespaces.map(languageName).join(', ') || 'No additional languages'
      : field === 'namespacing'
        ? policy.namespacing
          ? 'Enabled · language-prefixed addresses'
          : 'Off · one default language'
        : policy.autoUpdate
          ? 'Daily updates'
          : 'Manual updates'
const date = (value: string) =>
  Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
    : 'Date unavailable'
const stateName = (state: string) =>
  ({ pending: 'Queued', running: 'Running', succeeded: 'Completed', failed: 'Failed', cancelled: 'Cancelled' })[state] || state
const operationIcon = (state: string) =>
  ({
    pending: 'mdi-clock-outline',
    running: 'mdi-progress-clock',
    succeeded: 'mdi-check-circle-outline',
    failed: 'mdi-alert-circle-outline',
    cancelled: 'mdi-cancel',
  })[state] || 'mdi-circle-outline'
const preventUnload = (event: BeforeUnloadEvent) => {
  if (dirty.value || busy.value || hasLocalDraft.value) event.preventDefault()
}
onBeforeRouteLeave(() =>
  !(dirty.value || busy.value || hasLocalDraft.value) ||
  (!busy.value && window.confirm('Discard unsaved language changes or the selected local file?'))
)
onMounted(() => {
  window.addEventListener('beforeunload', preventUnload)
  void load()
})
onBeforeUnmount(() => {
  disposed = true
  sequence++
  clearTimeout(poll)
  window.removeEventListener('beforeunload', preventUnload)
})
</script>
<style src="./locale-workspace.scss" lang="scss"></style>
<style scoped lang="scss">
.locale-local-import {
  margin-block: 24px 30px;
  padding: 22px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.14);
  border-radius: 16px;
  background: rgba(var(--v-theme-surface), 0.62);
}

.locale-local-import__heading,
.locale-local-import__identity {
  display: flex;
  align-items: flex-start;
  gap: 15px;
}

.locale-local-import__heading {
  margin-bottom: 20px;

  h3 {
    margin: 5px 0 3px;
  }

  p,
  small {
    margin: 0;
    color: rgba(var(--v-theme-on-surface), 0.68);
  }
}

.locale-local-import__form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;

  > :last-child {
    grid-column: 1 / -1;
  }
}

.locale-local-import__file {
  display: grid;
  grid-column: 1 / -1;
  gap: 8px;
  padding: 14px 16px;
  border: 1px dashed rgba(var(--v-theme-on-surface), 0.3);
  border-radius: 10px;

  span {
    font-weight: 600;
  }

  small {
    color: rgba(var(--v-theme-on-surface), 0.66);
  }
}

.locale-local-import__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 14px;
}

.locale-local-import__review {
  margin-top: 20px;
  padding-top: 18px;
  border-top: 1px solid rgba(var(--v-theme-on-surface), 0.14);

  h4,
  p {
    margin: 0 0 5px;
  }

  p,
  small {
    color: rgba(var(--v-theme-on-surface), 0.7);
  }

  code {
    overflow-wrap: anywhere;
  }
}

.locale-local-import__identity {
  align-items: center;
}

.locale-local-import__counts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-block: 16px 12px;

  span {
    padding: 6px 10px;
    border: 1px solid rgba(var(--v-theme-on-surface), 0.13);
    border-radius: 999px;
    color: rgba(var(--v-theme-on-surface), 0.74);
  }
}

.locale-local-import__change-list {
  border-top: 1px solid rgba(var(--v-theme-on-surface), 0.12);

  summary {
    padding: 11px 2px;
    cursor: pointer;
    font-weight: 600;
  }

  ul {
    max-height: 230px;
    margin: 0 0 14px;
    padding-inline-start: 22px;
    overflow: auto;
  }

  li {
    margin-block: 3px;
    overflow-wrap: anywhere;
  }
}

@media (max-width: 600px) {
  .locale-local-import {
    padding: 17px;
  }

  .locale-local-import__form {
    grid-template-columns: minmax(0, 1fr);

    > :last-child {
      grid-column: auto;
    }
  }
}
</style>
