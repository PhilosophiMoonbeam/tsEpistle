<template>
  <v-container fluid class="navigation-workspace" :class="{ 'has-admin-draft-bar': dirty }" :style="{ '--admin-draft-bar-height': `${draftBarHeight}px` }">
    <admin-hero
      icon="mdi-compass-outline"
      :title="nt('title')"
      :description="nt('giveEveryReaderClear')"
      ><template #actions
        ><v-btn
          variant="text"
          prepend-icon="mdi-refresh"
          :loading="loading"
          :disabled="busy || initializing"
          @click="reload"
          >{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ nt('reloadSavedNavigation') }}</v-tooltip></v-btn
        ><v-btn v-if="dirty" variant="text" :disabled="locked" @click="reset"
          >{{ nt('resetDraft') }}</v-btn
        ><v-btn
          :data-commitment="dirty && !locked ? 'active' : undefined"
          variant="tonal"
          :disabled="locked || !dirty"
          @click="review"
          >{{ nt('reviewChanges') }}</v-btn
        ></template
      ></admin-hero
    >
    <p v-if="!saved && loading" class="navigation-empty" role="status">
      {{ nt('loadingNavigationLocalesAudiences') }}
    </p>
    <v-alert v-if="loadError" type="error" variant="tonal"
      >{{ loadError
      }}<v-btn variant="text" :disabled="busy" @click="reload"
        >{{ nt('reloadSavedSettings') }}</v-btn
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
            dirty ? nt('unsavedNavigationDraft') : nt('showingSavedNavigation')
          }}</span
        ><span>{{
          saved.runtime.state === "applied"
            ? nt('runtimeConfigurationCurrent')
            : nt('runtimeActivationNeedsAttention2')
        }}</span>
      </div>
      <nav ref="sectionNav" class="navigation-tabs" :aria-label="nt('navigationSections')">
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
              <h2>{{ nt('menuStructure') }}</h2>
            </div>
            <v-alert v-if="!customMode" type="info" variant="tonal" class="mb-5"
              >{{ nt('customMenusRemainEditable', { mode: draft.mode === "NONE"
                  ? nt('sidebarHidden')
                  : nt('sidebarCurrentlyShowsPage'), interpolation: { escapeValue: false } }) }}</v-alert
            >
            <div class="navigation-toolbar">
              <v-select
                v-model="currentLocale"
                :items="localeOptions"
                item-title="title"
                item-value="code"
                :label="nt('menuLocale')"
                variant="outlined"
                density="compact"
                hide-details
                :disabled="locked"
              /><v-btn
                variant="text"
                prepend-icon="mdi-content-copy"
                :disabled="locked || !copyOptions.length"
                @click="openCopy"
                >{{ nt('copyLocale') }}</v-btn
              ><v-btn
                data-testid="navigation-move-repair-open"
                variant="text"
                prepend-icon="mdi-link-variant"
                :disabled="locked || dirty || !draft.tree.some(tree => tree.locale === currentLocale)"
                @click="openMoveRepair"
                >Repair moved page links</v-btn
              ><v-btn
                variant="text"
                class="navigation-preview-jump"
                @click="
                  previewPanel?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start',
                  })
                "
                >{{ nt('previewMenu') }}</v-btn
              >
            </div>
            <p v-if="!currentLocaleEnabled" class="navigation-note mb-5">
              {{ nt('localeRetainedEditingBut') }}
              <router-link to="/locale">{{ nt('locale') }}</router-link>.
            </p>
            <div ref="builder" class="navigation-builder" :class="{ 'has-selection': !!selected }">
              <section class="navigation-structure" :aria-label="nt('menuStructure')">
                <div class="navigation-section-title">
                  <h3>{{ nt('menuOrder') }}</h3>
                  <span>{{ currentItems.length }} / {{ maxItems }}</span>
                </div>
                <div class="navigation-home">
                  <v-icon icon="mdi-home-outline" size="18" /><span>{{ nt('navType.home') }}</span
                  ><small>{{ nt('built') }}</small>
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
                  <h3>{{ nt('startingPoint') }}</h3>
                  <p>
                    {{ nt('addPageLinkThen') }}
                  </p>
                </div>
                <p v-if="currentItems.length && !selected" class="navigation-note">
                  {{ nt('selectLinkHeadingDivider') }}
                </p>
                <div class="navigation-add">
                  <v-btn
                    class="navigation-add-link"
                    variant="tonal"
                    prepend-icon="mdi-plus"
                    :disabled="locked || currentItems.length >= maxItems"
                    @click="addItem('link')"
                    >{{ nt('addLink') }}</v-btn
                  ><v-menu
                    ><template #activator="{ props }"
                      ><v-btn
                        v-bind="props"
                        variant="text"
                        icon="mdi-dots-horizontal"
                        :aria-label="nt('addHeadingDivider')"
                        :disabled="
                          locked || currentItems.length >= maxItems
                        " /></template
                    ><v-list
                      ><v-list-item
                        :title="nt('addHeading')"
                        prepend-icon="mdi-format-title"
                        @click="addItem('header')" /><v-list-item
                        :title="nt('addDivider')"
                        prepend-icon="mdi-minus"
                        @click="addItem('divider')" /></v-list
                  ></v-menu>
                </div>
                <p class="navigation-note">
                  {{ nt('dragHandleFocusPress') }}
                </p>
              </section>
              <section
                v-if="selected"
                class="navigation-item-editor"
                :aria-label="nt('selectedMenuItem')"
              >
                <template v-if="selected"
                  ><div class="navigation-section-title">
                    <h3>
                      {{
                        selected.kind === "link"
                          ? nt('linkDetails')
                          : selected.kind === "header"
                            ? nt('sectionHeading')
                            : nt('divider')
                      }}
                    </h3>
                    <span
                      >{{ nt('of', { value: selectedIndex + 1, currentItemsCount: currentItems.length, interpolation: { escapeValue: false } }) }}</span
                    >
                  </div>
                  <div class="navigation-item-position">
                    <v-btn
                      size="small"
                      variant="text"
                      prepend-icon="mdi-arrow-up"
                      :disabled="locked || selectedIndex === 0"
                      @click="moveItem(-1)"
                      >{{ nt('moveUp') }}</v-btn
                    ><v-btn
                      size="small"
                      variant="text"
                      prepend-icon="mdi-arrow-down"
                      :disabled="
                        locked || selectedIndex === currentItems.length - 1
                      "
                      @click="moveItem(1)"
                      >{{ nt('moveDown') }}</v-btn
                    >
                  </div>
                  <v-text-field
                    v-if="selected.kind !== 'divider'"
                    v-model="selected.label"
                    :label="nt('menuLabel')"
                    maxlength="255"
                    counter="255"
                    variant="outlined"
                    :disabled="locked"
                  />
                  <template v-if="selected.kind === 'link'"
                    ><v-text-field
                      v-model="selected.icon"
                      :label="nt('icon')"
                      variant="outlined"
                      :disabled="locked"
                      :hint="nt('mdiIconNameFont')"
                      persistent-hint
                      ><template #append-inner
                        ><v-icon
                          :icon="selected.icon || 'mdi-link-variant'"
                          size="20" /></template></v-text-field
                    ><v-select
                      v-model="selected.targetType"
                      :items="targetOptions"
                      :label="nt('destinationType')"
                      variant="outlined"
                      :disabled="locked"
                      class="mt-5"
                    /><v-text-field
                      v-model="selected.target"
                      :label="
                        selected.targetType === 'page'
                          ? nt('pagePath')
                          : nt('externalAddress')
                      "
                      variant="outlined"
                      :disabled="locked"
                      :error-messages="
                        selected.target && !destination
                          ? [nt('enterValidDestinationLink')]
                          : []
                      "
                      :hint="
                        selected.targetType === 'page'
                          ? nt('workspacePathSuchEn')
                          : nt('httpSMailtoTel')
                      "
                      persistent-hint
                    /><v-btn
                      v-if="selected.targetType === 'page'"
                      class="mt-3"
                      variant="text"
                      prepend-icon="mdi-file-search-outline"
                      :disabled="locked"
                      @click="selectPageOpen = true"
                      >{{ nt('choosePage') }}</v-btn
                    >
                    <p v-if="destination" class="navigation-destination">
                      <span>{{ nt('destination') }}</span><code>{{ destination }}</code>
                    </p></template
                  >
                  <p
                    v-else-if="selected.kind === 'divider'"
                    class="navigation-note"
                  >
                    {{ nt('separateRelatedGroupsLinks') }}
                  </p>
                  <div class="navigation-setting-group">
                    <h3>{{ nt('audience') }}</h3>
                    <v-radio-group
                      :model-value="selected.visibilityMode"
                      @update:model-value="$event !== null && (selected.visibilityMode = $event)"
                      :disabled="locked"
                      hide-details
                      :label="nt('whoSeesItem')"
                      ><v-radio
                        :label="nt('everyoneWhoCanOpen')"
                        value="all" /><v-radio
                        :label="nt('membersSelectedGroups')"
                        value="restricted" /></v-radio-group
                    ><v-select
                      v-if="selected.visibilityMode === 'restricted'"
                      v-model="selected.visibilityGroups"
                      :items="saved.groups"
                      item-title="name"
                      item-value="id"
                      :label="nt('audienceGroups')"
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
                      {{ nt('noGroupSelectedItem') }}
                    </p>
                    <p class="navigation-note mt-4">
                      {{ nt('menuVisibilityDoesNot') }}
                    </p>
                  </div>
                  <div class="navigation-item-actions">
                    <v-btn
                      variant="text"
                      prepend-icon="mdi-content-copy"
                      :disabled="locked || currentItems.length >= maxItems"
                      @click="duplicateItem"
                      >{{ nt('duplicateItem') }}</v-btn
                    ><v-btn
                      variant="text"
                      prepend-icon="mdi-delete-outline"
                      :disabled="locked"
                      @click="removeItem"
                      >{{ nt('removeItem') }}</v-btn
                    >
                  </div>
                </template>
              </section>
            </div>
          </template>
          <template v-else-if="section === 'display'">
            <div class="navigation-heading">
              <h2>{{ nt('displayLocales') }}</h2>
              <p>{{ nt('balanceCuratedMenuPage') }}</p>
            </div>
            <fieldset class="navigation-mode-grid" :disabled="locked">
              <legend class="navigation-sr-only">{{ nt('sidebarDisplayMode') }}</legend>
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
              <h3>{{ nt('whereBrowseBegins') }}</h3>
              <v-switch
                :model-value="draft.expandParent"
                @update:model-value="$event !== null && (draft.expandParent = $event)"
                inset
                :disabled="locked"
                :label="nt('openCurrentPagesParent')"
                color="primary"
                hide-details
              />
              <p class="navigation-note mt-3">
                {{ nt('whenOffBrowseStarts') }}
              </p>
            </div>
            <div class="navigation-setting-group">
              <div class="navigation-section-title">
                <h3>{{ nt('localeCoverage') }}</h3>
                <router-link to="/locale">{{ nt('manageLanguages') }}</router-link>
              </div>
              <p class="navigation-note mb-5">
                {{ nt('eachLanguageHasOwn') }}
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
                        ? nt('enabledReaders')
                        : nt('notEnabledReaders')
                    }}</small
                  >
                </div>
                <span
                  >{{ nt('items', { tree: draft.tree.find((tree) => tree.locale === locale.code)
                      ?.items.length || 0, interpolation: { escapeValue: false } }) }}</span
                ><v-btn
                  size="small"
                  variant="text"
                  :disabled="locked"
                  @click="editLocale(locale.code)"
                  >{{ nt('editMenu') }}</v-btn
                ><v-btn
                  v-if="draft.tree.some((tree) => tree.locale === locale.code)"
                  icon="mdi-delete-outline"
                  size="small"
                  variant="text"
                  :aria-label="nt('removeMenu2', { name: locale.name, interpolation: { escapeValue: false } })"
                  :disabled="locked"
                  @click="removeLocale(locale.code)"
                />
              </div>
            </div>
          </template>
          <template v-else
            ><div class="navigation-heading">
              <h2>{{ nt('activity') }}</h2>
              <p>{{ nt('latest50NavigationPublications') }}</p>
            </div>
            <p v-if="!saved.history.length" class="navigation-empty">
              {{ nt('noNavigationChangesHave') }}
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
                  ? nt('apiAdministrator')
                  : nt('administrator', { actorId: event.actorId, interpolation: { escapeValue: false } })
              }}</small>
            </article></template
          >
        </section>
        <aside ref="previewPanel" class="navigation-preview-panel">
          <div class="navigation-preview-heading">
            <span class="navigation-kicker">{{ nt('audiencePreview') }}</span
            ><strong>{{ currentLocale }} / {{ modeName(draft.mode) }}</strong>
          </div>
          <v-select
            v-model="previewAudience"
            :items="audienceOptions"
            :label="nt('preview')"
            variant="outlined"
            density="compact"
            hide-details
          /><v-select
            v-if="previewAudience === 'groups'"
            v-model="previewGroups"
            :items="saved.groups"
            item-title="name"
            item-value="id"
            :label="nt('previewGroups')"
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
            {{ nt('customLinksVisibleAudience', { visibleItems: visibleItems.filter((item) => item.kind === "link").length, currentItems: currentItems.filter((item) => item.kind === "link").length, interpolation: { escapeValue: false } }) }}
          </p>
          <p v-else class="navigation-note">
            {{ nt('customLinksRetainedBut') }}
          </p>
          <p class="navigation-note mt-3">
            {{ nt('previewsMenuVisibilityNot') }}
          </p>
          <div class="navigation-setting-group">
            <h3>{{ nt('publication') }}</h3>
            <p class="navigation-note">
              {{ nt('readersReceiveSavedMenu') }}
            </p>
            <v-btn
              v-if="saved.runtime.state !== 'applied'"
              class="mt-4"
              variant="tonal"
              :loading="initializing"
              :disabled="locked || dirty"
              @click="initialize"
              >{{ nt('retryRuntimeActivation') }}</v-btn
            >
          </div>
        </aside>
      </div>
      <div v-if="dirty" ref="draftBar" class="navigation-savebar">
        <span
          >{{ nt('navigationDraftImpact', { count: changedFields.length }) }}</span
        ><v-btn variant="text" :disabled="locked" @click="reset">{{ nt('reset') }}</v-btn
        ><v-btn
          :data-commitment="dirty && !locked ? 'active' : undefined"
          variant="tonal"
          :disabled="locked"
          @click="review"
          >{{ nt('reviewChanges') }}</v-btn
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
    <page-selector
      v-model="repairPickerOpen"
      mode="select"
      :must-exist="true"
      :allow-locale-change="true"
      :open-handler="selectMovedPage"
      path="home"
      :locale="currentLocale"
    />
    <v-dialog v-model="repairOpen" :persistent="busy" max-width="900" scrollable @update:model-value="!$event && closeMoveRepair()">
      <v-card title="Repair moved page links" data-testid="navigation-move-repair">
        <v-card-text>
          <p>Review links in the {{ repairMenuLocale }} custom menu after the selected page's latest recorded move. Only selected destinations change. Labels, icons, audiences, order and menu locale stay unchanged. Page content is not edited.</p>
          <p class="navigation-note mt-3">Only explicit locale-qualified public paths are supported. External links, relative or ambiguous paths and unrelated prefixes are left untouched.</p>
          <p v-if="repairLoading" role="status" class="mt-4">Checking the current page, move history and saved navigation…</p>
          <template v-if="moveReview">
            <dl class="mt-4">
              <dt>Recorded old public identity</dt><dd class="navigation-move-target"><code>/{{ moveReview.oldIdentity.locale }}/{{ moveReview.oldIdentity.path }}</code></dd>
              <dt>Current public identity</dt><dd class="navigation-move-target"><code>/{{ moveReview.newIdentity.locale }}/{{ moveReview.newIdentity.path }}</code></dd>
              <dt>Current page revision</dt><dd>{{ moveReview.sourceRevision }}</dd>
            </dl>
            <p v-if="!moveReview.items.length" role="status" class="mt-4">No supported links to that old identity were found in this menu. Nothing will be saved.</p>
            <v-checkbox
              v-for="item in moveReview.items"
              :key="navigationRepairItemKey(item)"
              :model-value="repairSelected"
              @update:model-value="repairSelected = $event ?? []"
              :value="navigationRepairItemKey(item)"
              :disabled="busy || repairStale"
              hide-details
              data-testid="navigation-move-repair-item"
            >
              <template #label><span class="navigation-move-target">{{ item.locale }} · {{ item.itemId }}<br><code>{{ item.oldTarget }}</code><br>→ <code>{{ item.newTarget }}</code></span></template>
            </v-checkbox>
            <v-textarea
              v-model="repairReason"
              label="Administrative reason"
              variant="outlined"
              rows="2"
              maxlength="1000"
              hint="3–1000 characters"
              persistent-hint
              :disabled="busy || repairStale"
              class="mt-5"
              data-testid="navigation-move-repair-reason"
            />
          </template>
          <v-alert v-if="repairError" type="error" variant="tonal" class="mt-4" role="alert">{{ repairError }}</v-alert>
        </v-card-text>
        <v-card-actions class="navigation-move-actions">
          <v-btn :disabled="busy" @click="closeMoveRepair">Cancel</v-btn>
          <v-btn v-if="!repairStale" :disabled="busy || repairLoading" @click="chooseAnotherMovedPage">Choose another page</v-btn>
          <v-spacer />
          <v-btn v-if="repairStale" :disabled="busy" @click="reloadMoveRepair">Reload and review again</v-btn>
          <v-btn
            :data-commitment="!busy && !repairLoading && !repairStale && moveReview && repairSelected.length && repairReason.trim().length >= 3 ? 'active' : undefined"
            variant="tonal"
            :loading="busy"
            :disabled="busy || repairLoading || repairStale || !moveReview || !repairSelected.length || repairReason.trim().length < 3"
            data-testid="navigation-move-repair-save"
            @click="commitMoveRepair"
          >Publish selected link repairs</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog v-model="copyOpen" max-width="580"
      ><v-card :title="nt('copyLocaleMenu')"
        ><v-card-text
          ><p class="mb-5">
            {{ nt('copyIntoLabelsDestinations', { currentLocale, interpolation: { escapeValue: false } }) }}
          </p>
          <v-select
            v-model="copySource"
            :items="copyOptions"
            item-title="title"
            item-value="code"
            :label="nt('sourceLocale2')"
            variant="outlined"
          /><v-radio-group :model-value="copyMode" @update:model-value="$event !== null && (copyMode = $event)" :label="nt('howCopy')"
            ><v-radio :label="nt('appendMenu')" value="append" /><v-radio
              :label="nt('replaceMenu')"
              value="replace"
          /></v-radio-group>
          <p>
            {{ nt('sourceItemsCurrentItems', { copyCount, currentItemsCount: currentItems.length, interpolation: { escapeValue: false } }) }}
          </p>
          <v-alert
            v-if="copyMode === 'replace'"
            type="info"
            variant="tonal"
            class="mt-4"
            >{{ nt('currentDraftMenuWill', { currentLocale, interpolation: { escapeValue: false } }) }}</v-alert
          ></v-card-text
        ><v-card-actions
          ><v-btn @click="copyOpen = false">{{ $t('common:actions.cancel') }}</v-btn><v-spacer /><v-btn
            variant="flat"
            color="primary"
            :disabled="locked || !copyCount || copyTotal > maxItems"
            @click="copyLocale"
            >{{ nt('copyItems', { copyCount, interpolation: { escapeValue: false } }) }}</v-btn
          ></v-card-actions
        ></v-card
      ></v-dialog
    >
    <v-dialog v-model="reviewing" :persistent="busy" max-width="950"
      ><v-card v-if="saved && reviewed" :title="nt('publishNavigationChanges')"
        ><v-card-text
          ><p class="mb-5">
            {{ nt('reviewCompleteAffectedStructures') }}
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
                <strong>{{ nt('saved') }}</strong>
                <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: This bounded source/report viewport needs a tab stop for keyboard scrolling. -->
                <pre  tabindex="0" >{{ reviewValue(saved.policy, field) }}</pre>
              </section>
              <section>
                <strong>{{ nt('publishing') }}</strong>
                <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: This bounded source/report viewport needs a tab stop for keyboard scrolling. -->
                <pre  tabindex="0" >{{ reviewValue(reviewed, field) }}</pre>
              </section>
            </div>
          </details>
          <v-textarea
            v-model="reason"
            :label="nt('reasonChange')"
            variant="outlined"
            rows="2"
            maxlength="1000"
            :disabled="busy || stale"
            class="mt-5"
            :hint="nt('n31000Characters')"
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
            >{{ nt('backDraft') }}</v-btn
          ><v-spacer /><v-btn
            v-if="stale"
            :disabled="busy"
            @click="reloadReview"
            >{{ nt('reloadSavedSettings') }}</v-btn
          ><v-btn
            :data-commitment="dirty && !locked && reason.trim().length >= 3 ? 'active' : undefined"
            variant="tonal"
            :loading="busy"
            :disabled="locked || reason.trim().length < 3"
            @click="confirm"
            >{{ nt('publishNavigation') }}</v-btn
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
  nextTick,
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
  reviewMovedNavigationPage,
  repairMovedNavigationPage,
} from "../../helpers/navigation-workspace-api.ts";
import { navigationRepairItemKey, type NavigationMoveReview } from "../../../shared/navigation-move-repair.ts";
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const nt = useTranslate('admin:navigation')
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : nt('navigationAdministrationUnavailable');
const route = useRoute(),
  router = useRouter(),
  previewPanel = useTemplateRef<HTMLElement>("previewPanel"),
  builder = useTemplateRef<HTMLElement>("builder"),
  draftBar = useTemplateRef<HTMLElement>("draftBar"),
  sectionNav = useTemplateRef<HTMLElement>("sectionNav");
const draftBarHeight = ref(80);
let draftBarObserver: ResizeObserver | undefined;
watch(draftBar, (element) => {
  draftBarObserver?.disconnect();
  if (!element) return;
  const measure = () => { draftBarHeight.value = element.getBoundingClientRect().height; };
  measure();
  draftBarObserver = new ResizeObserver(measure);
  draftBarObserver.observe(element);
}, { flush: "post" });
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
const repairOpen = ref(false), repairPickerOpen = ref(false), repairLoading = ref(false),
  moveReview = ref<NavigationMoveReview | null>(null), repairSelected = ref<string[]>([]),
  repairReason = ref(""), repairError = ref(""), repairStale = ref(false),
  repairMenuLocale = ref(""), repairPageId = ref(0);
let repairOwner = 0, repairController: AbortController | undefined;
const sections = [
  { key: "structure", title: nt('menuStructure') },
  { key: "display", title: nt('displayLocales') },
  { key: "activity", title: nt('activity') },
];
const modeOptions = [
  {
    value: "MIXED",
    title: nt('menuDirectory'),
    icon: "mdi-view-split-vertical",
    description: nt('curatedLinksBrowseAlongside'),
  },
  {
    value: "STATIC",
    title: nt('customMenu'),
    icon: "mdi-format-list-bulleted",
    description: nt('focusedSetHandPicked'),
  },
  {
    value: "TREE",
    title: nt('pageDirectory'),
    icon: "mdi-file-tree-outline",
    description: nt('exploreHierarchyAccessiblePages'),
  },
  {
    value: "NONE",
    title: nt('hiddenSidebar'),
    icon: "mdi-dock-left",
    description: nt('leaveMoreRoomPage'),
  },
];
const targetOptions = [
  { title: nt('wikiPage'), value: "page" },
  { title: nt('externalLink'), value: "external" },
  { title: nt('externalLinkNewTab'), value: "externalblank" },
];
const audienceOptions = [
  { title: nt('visitorGuestAccount'), value: "visitor" },
  { title: nt('selectedGroups'), value: "groups" },
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
    repairOpen.value ||
    repairPickerOpen.value ||
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
const localeSelections = new Map<string, string>();
async function focusOutline() {
  await nextTick();
  if (disposed) return;
  const target = builder.value?.querySelector<HTMLElement>(
    '.navigation-outline-select[aria-pressed="true"]:not(:disabled), .navigation-add-link:not(:disabled)',
  ) || sectionNav.value?.querySelector<HTMLElement>('button[aria-current]:not(:disabled)');
  target?.focus();
}
watch(currentLocale, (locale, previousLocale) => {
  localeSelections.set(previousLocale, selectedId.value);
  const previousSelection = localeSelections.get(locale);
  selectedId.value = currentItems.value.find(item => item.id === previousSelection)?.id || "";
});
watch([currentLocale, selected], async () => {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !builder.value?.contains(active)) return;
  await nextTick();
  if (!active.isConnected) void focusOutline();
});
async function load() {
  closeMoveRepair();
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
      currentItems.value.find((item) => item.id === selectedId.value)?.id || "";
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
    !(await confirmDiscard(nt('discardUnsavedNavigationChanges')))
  )
    return;
  if (busy.value || initializing.value) return;
  await load();
}
function reset() {
  if (!locked.value && saved.value) {
    draft.value = copy(saved.value.policy);
    selectedId.value = currentItems.value.find(item => item.id === selectedId.value)?.id || "";
    void focusOutline();
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
      kind === "link" ? nt('newLink') : kind === "header" ? nt('newSection') : "",
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
    title: nt('removeDraft', { label: selected.value.label || nt('divider2'), interpolation: { escapeValue: false } }),
    confirmLabel: nt('remove'),
    tone: "destructive",
  });
  if (!confirmed || locked.value || selectedId.value !== targetId) return;
  const index = selectedIndex.value;
  setItems(currentItems.value.filter((item) => item.id !== selectedId.value));
  selectedId.value =
    currentItems.value[Math.min(index, currentItems.value.length - 1)]?.id ||
    "";
  void focusOutline();
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
function closeMoveRepair() {
  if (busy.value) return;
  repairOwner++;
  repairController?.abort();
  repairController = undefined;
  repairOpen.value = false;
  repairPickerOpen.value = false;
  repairLoading.value = false;
  moveReview.value = null;
  repairSelected.value = [];
  repairReason.value = "";
  repairError.value = "";
  repairStale.value = false;
}
function openMoveRepair() {
  if (locked.value || dirty.value || disposed) return;
  repairMenuLocale.value = currentLocale.value;
  repairPickerOpen.value = true;
}
function chooseAnotherMovedPage() {
  closeMoveRepair();
  openMoveRepair();
}
async function selectMovedPage(value: { id: number; visibility?: "public" | "private" }) {
  if (disposed || busy.value || loading.value || stale.value || dirty.value || !repairPickerOpen.value) return;
  repairOpen.value = true;
  repairPickerOpen.value = false;
  moveReview.value = null;
  repairSelected.value = [];
  repairReason.value = "";
  repairError.value = "";
  if (value.visibility !== "public" || !value.id) {
    repairError.value = "Choose a currently readable, published, unlocked public page with a recorded move.";
    return;
  }
  repairPageId.value = value.id;
  const owner = ++repairOwner;
  repairController?.abort();
  const controller = new AbortController();
  repairController = controller;
  repairLoading.value = true;
  try {
    const result = await reviewMovedNavigationPage(value.id, repairMenuLocale.value, controller.signal);
    if (disposed || owner !== repairOwner || controller.signal.aborted || !repairOpen.value) return;
    moveReview.value = result;
    if (result.fingerprint !== saved.value?.fingerprint) {
      repairStale.value = true;
      repairError.value = "Saved navigation changed. Reload and review again before publishing.";
    }
  } catch (error) {
    if (!disposed && owner === repairOwner && !controller.signal.aborted) {
      repairError.value = errorMessage(error);
      const status = error && typeof error === "object" ? Reflect.get(error, "status") : 0;
      repairStale.value = !status || [401, 403, 409].includes(Number(status)) || Number(status) >= 500;
    }
  } finally {
    if (!disposed && owner === repairOwner) repairLoading.value = false;
  }
}
async function reloadMoveRepair() {
  if (busy.value) return;
  const pageId = repairPageId.value, locale = repairMenuLocale.value;
  await load();
  if (disposed || stale.value || !saved.value) return;
  repairMenuLocale.value = locale;
  repairPickerOpen.value = true;
  await selectMovedPage({ id: pageId, visibility: "public" });
}
async function commitMoveRepair() {
  if (disposed || busy.value || repairLoading.value || repairStale.value || !moveReview.value || !repairSelected.value.length || repairReason.value.trim().length < 3) return;
  const owner = repairOwner, reviewed = moveReview.value;
  const selected = reviewed.items.filter(item => repairSelected.value.includes(navigationRepairItemKey(item))).map(item => ({ locale: item.locale, itemId: item.itemId }));
  busy.value = true;
  repairError.value = "";
  const controller = new AbortController();
  repairController = controller;
  try {
    const result = await repairMovedNavigationPage(reviewed, selected, repairReason.value.trim(), controller.signal);
    if (disposed || owner !== repairOwner || controller.signal.aborted) return;
    busy.value = false;
    closeMoveRepair();
    attention.value = result.activation !== "applied";
    notice.value = attention.value ? "Selected links saved; runtime activation needs attention." : "Selected links repaired and published to readers.";
    await load();
  } catch (error) {
    if (!disposed && owner === repairOwner && !controller.signal.aborted) {
      const status = error && typeof error === "object" ? Reflect.get(error, "status") : 0;
      repairStale.value = !status || [401, 403, 409].includes(Number(status)) || Number(status) >= 500;
      repairError.value = errorMessage(error) + (!status ? " The save outcome is unconfirmed. Reload before repeating it." : "");
      if (repairStale.value) stale.value = true;
    }
  } finally {
    if (!disposed && owner === repairOwner) busy.value = false;
  }
}
function editLocale(code: string) {
  currentLocale.value = code;
  selectSection("structure");
}
async function removeLocale(code: string) {
  if (locked.value || !draft.value) return;
  const confirmed = await requestConfirmation({
    title: nt('removeCustomMenuDraft', { code, interpolation: { escapeValue: false } }),
    message: nt('languageItselfRemainsInstalled'),
    confirmLabel: nt('removeMenu'),
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
      ? nt('navigationSavedRuntimeActivation')
      : nt('navigationPublishedReadersSee');
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
          ? ` ${nt('outcomeUnconfirmedReloadBefore')}`
          : "");
      if (stale.value) {
        notice.value =
          nt('reloadSavedSettingsBefore');
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
    !(await confirmDiscard(nt('discardReviewLoadSaved'))) ||
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
        ? nt('runtimeNavigationConfigurationApplied')
        : nt('runtimeActivationNeedsAttention');
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
    ? nt('sidebarDisplay')
    : field === "expandParent"
      ? nt('browseStartingPoint')
      : nt('menu', { field: field.replace("locale:", ""), interpolation: { escapeValue: false } });
const reviewValue = (policy: NavigationPolicy, field: string) =>
  field === "mode"
    ? modeName(policy.mode)
    : field === "expandParent"
      ? policy.expandParent
        ? nt('currentPagesParent')
        : nt('siteRoot')
      : JSON.stringify(
          policy.tree.find(
            (tree) => tree.locale === field.replace("locale:", ""),
          )?.items ?? nt('noCustomMenu'),
          null,
          2,
        );
const date = (value: string) => {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? t('admin:locale.dateUnavailable')
    : timestamp.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
};
const canLeave = async () =>
  !busy.value &&
  !initializing.value &&
  ((!dirty.value && !(reviewing.value && reason.value) && !(repairOpen.value && (repairReason.value || repairSelected.value.length))) ||
    (await confirmDiscard(nt('discardUnsavedNavigationChanges'))));
function beforeUnload(event: BeforeUnloadEvent) {
  if (
    busy.value ||
    initializing.value ||
    dirty.value ||
    (reviewing.value && reason.value) ||
    (repairOpen.value && (repairReason.value || repairSelected.value.length))
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
  repairOwner++;
  repairController?.abort();
  draftBarObserver?.disconnect();
  window.removeEventListener("beforeunload", beforeUnload);
});
</script>
<style lang="scss" src="./navigation-workspace.scss"></style>
<style scoped>
.navigation-move-target { overflow-wrap: anywhere; min-width: 0; white-space: normal; }
.navigation-move-actions { flex-wrap: wrap; }
</style>
