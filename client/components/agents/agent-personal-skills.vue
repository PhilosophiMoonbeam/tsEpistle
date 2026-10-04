<template>
  <v-dialog content-class="agent-owned-overlay" :model-value="open" max-width="72rem" scrollable :fullscreen="smAndDown" aria-labelledby="personal-skills-title" :persistent="saving" @update:model-value="handleOpenUpdate">
    <v-card class="personal-skills">
      <header class="personal-skills__header">
        <span class="personal-skills__mark" aria-hidden="true"><v-icon icon="mdi-account-star-outline" size="23" /></span>
        <div class="personal-skills__heading">
          <div class="personal-skills__eyebrow">{{ $t('common:agentPersonalSkills.skillMdSource') }}</div>
          <h2 id="personal-skills-title">{{ $t('common:agentPersonalSkills.mySkillLibrary') }}</h2>
          <p>{{ $t('common:agentPersonalSkills.curateInstructionsOwnAgent') }}</p>
        </div>
        <div class="personal-skills__header-state">
          <v-chip size="small" variant="tonal" prepend-icon="mdi-account-lock-outline">{{ $t('common:agentPersonalSkills.ownerOnly') }}</v-chip>
          <v-chip v-if="loaded" size="small" variant="outlined">{{ $t('common:agentPersonalSkills.skill', { count: skills.length, interpolation: { escapeValue: false } }) }}</v-chip>
        </div>
        <v-btn icon="mdi-close" variant="text" :aria-label="$t('common:agentPersonalSkills.closePersonalSkills')" :disabled="saving" @click="requestClose" />
      </header>

      <div class="personal-skills__boundary">
        <v-icon icon="mdi-shield-outline" size="19" />
        <span><strong>{{ $t('common:agentPersonalSkills.personalLayer') }}</strong> {{ $t('common:agentPersonalSkills.skillsUntrustedReferenceMaterial') }}</span>
      </div>

      <v-card-text class="personal-skills__body">
        <v-alert v-if="networkBlocked" class="mb-4" type="warning" variant="tonal" density="compact" role="status">
          <span>{{ $t('common:agentPersonalSkills.connectionRequiredLoadChange') }}</span>
          <v-btn color="primary" prepend-icon="mdi-refresh" variant="text" :loading="connectionRetrying" :disabled="connectionRetrying" @click="emit('retry-connection')">{{ $t('common:agentPersonalSkills.retryConnection') }}</v-btn>
        </v-alert>
        <div class="personal-skills__layout">
          <aside class="personal-inventory" aria-labelledby="personal-inventory-title">
            <div class="personal-inventory__header">
              <div>
                <div class="personal-skills__eyebrow">{{ $t('common:agentPersonalSkills.inventory') }}</div>
                <h3 id="personal-inventory-title">{{ $t('common:agentPersonalSkills.installedSkills') }}</h3>
              </div>
              <v-btn color="primary" prepend-icon="mdi-plus" size="small" :disabled="loading || saving || networkBlocked" @click="requestNew">{{ $t('common:agentPersonalSkills.newSkill') }}</v-btn>
            </div>

            <v-text-field
              v-model="search"
              class="personal-inventory__search"
              :label="$t('common:agentPersonalSkills.searchPersonalSkills')"
              prepend-inner-icon="mdi-magnify"
              clearable
              hide-details
              density="comfortable"
            >
              <template #clear="{ props: clearProps }"><v-icon v-bind="clearProps" icon="mdi-close-circle" :aria-label="$t('common:agentPersonalSkills.clearSearch')" /></template>
            </v-text-field>

            <v-alert v-if="refreshError && !loaded" class="personal-inventory__error" type="error" variant="tonal" density="compact">
              {{ refreshError }}
                <template #append><v-btn variant="text" size="small" :loading="loading" :disabled="loading || networkBlocked" @click="load()">{{ $t('common:agentPersonalSkills.retry') }}</v-btn></template>
            </v-alert>

            <div v-if="loading && !loaded" class="personal-inventory__loading" :aria-label="$t('common:agentPersonalSkills.loadingPersonalSkills')" aria-busy="true">
              <v-skeleton-loader v-for="index in 4" :key="index" type="list-item-avatar-two-line" />
            </div>

            <template v-else-if="loaded">
              <v-alert v-if="refreshError || (!readAccepted && !saving && !loading)" class="personal-inventory__error" type="warning" variant="tonal" density="compact">
                {{ refreshError || $t('common:agentPersonalSkills.reloadBeforeRetry') }}
                <template #append><v-btn variant="text" size="small" :loading="loading" :disabled="loading || saving || networkBlocked" @click="load()">{{ $t('common:agentPersonalSkills.reloadSkills') }}</v-btn></template>
              </v-alert>
              <div class="personal-inventory__summary" aria-live="polite">{{ $t('common:agentPersonalSkills.shown', { filteredSkillsCount: renderedSkills.length, skillsCount: skills.length, interpolation: { escapeValue: false } }) }}</div>
              <v-list v-if="filteredSkills.length" class="personal-inventory__list" density="compact" nav :aria-label="$t('common:agentPersonalSkills.personalSkills')">
                <v-list-item
                  v-for="skill in renderedSkills"
                  :key="skill.id"
                  class="personal-skill-item"
                  :active="editingId === skill.id"
                  :aria-current="editingId === skill.id ? 'true' : undefined"
                  :aria-label="$t('common:agentPersonalSkills.editPersonalSkill', { name: skill.name, interpolation: { escapeValue: false } })"
                  :disabled="saving || loading || networkBlocked"
                  :aria-disabled="saving || loading || networkBlocked"
                  rounded="lg"
                  @click="requestEdit(skill)"
                >
                  <template #prepend>
                    <span class="personal-skill-item__icon"><v-icon icon="mdi-file-document-outline" size="18" /></span>
                  </template>
                  <v-list-item-title>{{ skill.name }}</v-list-item-title>
                  <v-list-item-subtitle>{{ skill.description || $t('common:agentPersonalSkills.noDescriptionFrontmatter') }}</v-list-item-subtitle>
                  <template #append>
                    <span class="personal-skill-item__append">
                      <span class="personal-skill-item__mode" :title="skill.isAgentDiscoverable ? $t('common:agentPersonalSkills.availableAgentAutomatically') : $t('common:agentPersonalSkills.onlyAvailableExplicitInvocation')">
                        <v-icon :icon="skill.isAgentDiscoverable ? 'mdi-radar' : 'mdi-hand-back-right-outline'" size="16" />
                        {{ skill.isAgentDiscoverable ? $t('common:agentPersonalSkills.auto') : $t('common:agentPersonalSkills.request') }}
                      </span>
                      <v-icon icon="mdi-pencil-outline" size="16" aria-hidden="true" />
                    </span>
                  </template>
                </v-list-item>
              </v-list>
              <div v-if="filteredSkills.length > 40" class="personal-inventory__summary"><v-btn variant="text" :disabled="skillPage === 0" :aria-label="$t('common:agentPersonalSkills.previousLoadedSkills')" @click="skillPage--"><v-icon icon="mdi-chevron-left" /></v-btn><span>{{ skillPage * 40 + 1 }}–{{ Math.min((skillPage + 1) * 40, filteredSkills.length) }}/{{ filteredSkills.length }}</span><v-btn variant="text" :disabled="(skillPage + 1) * 40 >= filteredSkills.length" :aria-label="$t('common:agentPersonalSkills.nextLoadedSkills')" @click="skillPage++"><v-icon icon="mdi-chevron-right" /></v-btn></div>

              <div v-if="!filteredSkills.length && skills.length" class="personal-inventory__empty">
                <v-icon icon="mdi-text-search" size="24" />
                <strong>{{ $t('common:agentPersonalSkills.noMatchingPersonalSkills') }}</strong>
                <span>{{ $t('common:agentPersonalSkills.tryAnotherNameDescription') }}</span>
                <v-btn size="small" variant="text" @click="search = ''">{{ $t('common:agentPersonalSkills.clearSearch') }}</v-btn>
              </div>

              <div v-if="!skills.length" class="personal-inventory__empty">
                <v-icon icon="mdi-file-document-plus-outline" size="28" />
                <strong>{{ $t('common:agentPersonalSkills.personalLayerEmpty') }}</strong>
                <span>{{ $t('common:agentPersonalSkills.createSkillMdDocument') }}</span>
                <v-btn size="small" color="primary" variant="tonal" prepend-icon="mdi-plus" :disabled="networkBlocked" @click="requestNew">{{ $t('common:agentPersonalSkills.createFirstSkill') }}</v-btn>
              </div>
            </template>
          </aside>

          <main v-if="loaded" ref="editorRoot" class="personal-editor" tabindex="-1" aria-labelledby="personal-editor-title">
            <div class="personal-editor__header">
              <div>
                <div class="personal-skills__eyebrow">{{ editingId ? $t('common:agentPersonalSkills.installedPersonalSkill') : $t('common:agentPersonalSkills.newPersonalSkill') }}</div>
                <h3 id="personal-editor-title">{{ editingId ? name : $t('common:agentPersonalSkills.createPersonalSkill') }}</h3>
                <p>{{ editingId ? $t('common:agentPersonalSkills.editCurrentPersonalRevision') : $t('common:agentPersonalSkills.writeReusableInstructionsScoped') }}</p>
              </div>
              <div class="personal-editor__header-actions">
                <v-chip v-if="isDirty" color="warning" size="small" variant="tonal" prepend-icon="mdi-circle-edit-outline">{{ $t('common:agentPersonalSkills.unsaved') }}</v-chip>
                <v-btn v-if="editingId" color="error" variant="text" prepend-icon="mdi-delete-outline" :disabled="saving || loading || networkBlocked || !readAccepted || editedSkillMissing" @click="beginRemove(selectedSkill, $event)">{{ $t('common:agentPersonalSkills.removeSkill') }}</v-btn>
              </div>
            </div>

            <v-alert v-if="error" class="personal-editor__error" type="error" variant="tonal" closable @click:close="error = ''">{{ error }}</v-alert>
            <v-alert v-if="editedSkillMissing" class="personal-editor__error" type="warning" variant="tonal" role="status">{{ $t('common:agentPersonalSkills.editedSkillRemoved') }}</v-alert>
            <v-alert v-if="removalNotice && !editedSkillMissing" class="personal-editor__error" type="info" variant="tonal" role="status" closable @click:close="removalNotice = ''">{{ removalNotice }}</v-alert>
            <v-progress-linear v-if="loading" indeterminate :aria-label="$t('common:agentPersonalSkills.refreshingPersonalSkills')" />

            <v-form id="personal-skill-form" class="personal-editor__form" @submit.prevent="save">
              <section class="personal-editor-section" aria-labelledby="personal-skill-details-title">
                <div class="personal-editor-section__heading">
                  <span><v-icon icon="mdi-card-account-details-outline" size="19" /></span>
                  <div><h4 id="personal-skill-details-title">{{ $t('common:agentPersonalSkills.detailsEnablement') }}</h4><p>{{ $t('common:agentPersonalSkills.nameSkillDecideWhether') }}</p></div>
                </div>
                <div class="personal-editor-section__fields">
                  <v-text-field ref="nameInput" v-model.trim="name" :rules="nameRules" :label="$t('common:agentPersonalSkills.skillName')" :disabled="Boolean(editingId) || saving || loading" :hint="$t('common:agentPersonalSkills.lowercaseLettersNumbersSingle')" persistent-hint maxlength="64" autocomplete="off" />
                  <div class="personal-discovery">
                    <v-switch v-model="isAgentDiscoverable" :label="$t('common:agentPersonalSkills.loadAutomaticallyWhenRelevant')" color="primary" inset hide-details :disabled="saving || loading" :aria-describedby="discoveryHelpId" />
                    <p :id="discoveryHelpId">{{ isAgentDiscoverable ? $t('common:agentPersonalSkills.agentMaySelectSkill') : $t('common:agentPersonalSkills.availableOnlyWhenYou') }}</p>
                  </div>
                </div>

                <dl v-if="selectedSkill" class="personal-provenance">
                  <div><dt>{{ $t('common:agentPersonalSkills.scope') }}</dt><dd>{{ $t('common:agentPersonalSkills.personalOwnerOnly') }}</dd></div>
                  <div><dt>{{ $t('common:agentPersonalSkills.lastRevised') }}</dt><dd>{{ formatUpdated(selectedSkill.updatedAt) }}</dd></div>
                  <div><dt>{{ $t('common:agentPersonalSkills.contentFingerprint') }}</dt><dd><code :title="selectedSkill.contentHash">{{ shortHash(selectedSkill.contentHash) }}</code></dd></div>
                </dl>
              </section>

              <section class="personal-editor-section personal-editor-section--code" aria-labelledby="personal-skill-code-title">
                <div class="personal-editor-section__heading">
                  <span><v-icon icon="mdi-code-tags" size="19" /></span>
                  <div><h4 id="personal-skill-code-title">{{ $t('common:agentPersonalSkills.skillMdSource') }}</h4><p>{{ $t('common:agentPersonalSkills.yamlFrontmatterDeclaresProvenance') }}</p></div>
                  <v-chip size="x-small" variant="outlined">{{ $t('common:agentPersonalSkills.plainText64Kib') }}</v-chip>
                </div>
                <v-textarea ref="markdownInput" v-model="skillMarkdown" :label="$t('common:agentPersonalSkills.exactPersonalSkillSource')" :hint="$t('common:agentPersonalSkills.frontmatterMustIncludeExact')" persistent-hint rows="18" max-rows="30" counter="65536" maxlength="65536" class="personal-editor__code" :disabled="saving || loading" spellcheck="false" :rules="markdownRules" />
              </section>
            </v-form>
          </main>
        </div>
      </v-card-text>

      <v-card-actions class="personal-skills__actions">
        <div class="personal-skills__trust-note"><v-icon icon="mdi-account-lock-outline" size="18" /><span>{{ $t('common:agentPersonalSkills.personalSkillsAffectOnly') }}</span></div>
        <v-spacer />
        <v-btn :disabled="saving" @click="requestClose">{{ $t('common:actions.close') }}</v-btn>
        <v-btn color="primary" type="submit" :loading="saving" :disabled="!loaded || !readAccepted || !formValid || loading || saving || networkBlocked || editedSkillMissing" form="personal-skill-form">{{ editingId ? $t('common:agentPersonalSkills.saveRevision') : $t('common:agentPersonalSkills.createSkill') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog content-class="agent-owned-overlay" :model-value="removing !== null" max-width="32rem" aria-labelledby="personal-remove-title" :persistent="saving" @update:model-value="value => { if (!value && !saving) cancelRemove() }">
    <v-card ref="removeDialogCard" class="personal-confirmation">
      <div class="personal-confirmation__header personal-confirmation__header--danger"><span><v-icon icon="mdi-delete-alert-outline" size="21" /></span><div><div class="personal-skills__eyebrow">{{ $t('common:agentPersonalSkills.destructiveAction') }}</div><h2 id="personal-remove-title">{{ $t('common:agentPersonalSkills.removePersonalSkill') }}</h2></div></div>
      <v-card-text>
        <v-alert class="mb-4" type="warning" variant="tonal" icon="mdi-history">{{ $t('common:agentPersonalSkills.existingRunHistoryRemains') }}</v-alert>
        <v-alert v-if="removeError" class="mb-4" type="error" variant="tonal">
          {{ removeError }}
          <template #append><v-btn v-if="!readAccepted" variant="text" size="small" :loading="loading" :disabled="loading || saving || networkBlocked" @click="load()">{{ $t('common:agentPersonalSkills.reloadSkills') }}</v-btn></template>
        </v-alert>
        <p><strong>{{ removing?.name }}</strong> {{ $t('common:agentPersonalSkills.willRemovedPersonalLibrary') }}</p>
      </v-card-text>
      <v-card-actions><v-spacer /><v-btn :disabled="saving" @click="cancelRemove">{{ $t('common:actions.cancel') }}</v-btn><v-btn color="error" prepend-icon="mdi-delete-outline" :loading="saving" :disabled="saving || networkBlocked || !readAccepted" @click="remove">{{ $t('common:agentPersonalSkills.removeSkill') }}</v-btn></v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog content-class="agent-owned-overlay" v-model="discardOpen" max-width="28rem" aria-labelledby="personal-discard-title">
    <v-card ref="discardDialogCard" class="personal-confirmation">
      <div class="personal-confirmation__header"><span><v-icon icon="mdi-file-alert-outline" size="21" /></span><div><div class="personal-skills__eyebrow">{{ $t('common:agentPersonalSkills.unsavedDraft') }}</div><h2 id="personal-discard-title">{{ $t('common:agentPersonalSkills.discardChanges') }}</h2></div></div>
      <v-card-text>{{ $t('common:agentPersonalSkills.currentPersonalSkillRevision') }}</v-card-text>
      <v-card-actions><v-spacer /><v-btn @click="discardOpen = false">{{ $t('common:agentPersonalSkills.continueEditing') }}</v-btn><v-btn color="error" variant="tonal" @click="confirmDiscard">{{ $t('common:agentPersonalSkills.discardChanges2') }}</v-btn></v-card-actions>
    </v-card>
  </v-dialog>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { useDisplay } from 'vuetify'
import {
  createPersonalAgentSkill,
  listPersonalAgentSkills,
  removePersonalAgentSkill,
  updatePersonalAgentSkill,
  type PersonalAgentSkill
} from '../../helpers/agents-api.ts'
import { createModalFocusScope, type ModalFocusScope } from '../common/modal-focus-scope'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()

const props = defineProps<{
  csrfToken: string
  ownerId?: number
  networkBlocked?: boolean
  connectionRetrying?: boolean
}>()
const emit = defineEmits<{ changed: []; 'retry-connection': [] }>()
const open = defineModel<boolean>({ required: true })
const { smAndDown } = useDisplay()
const discoveryHelpId = useId()
const skills = shallowRef<PersonalAgentSkill[]>([])
const search = ref<string | null>('')
const editingId = ref<string | null>(null)
const name = ref('my-skill')
const skillMarkdown = ref('')
const isAgentDiscoverable = ref(true)
const loading = ref(false)
const loaded = ref(false)
const saving = ref(false)
const error = ref('')
const removing = shallowRef<PersonalAgentSkill | null>(null)
const discardOpen = ref(false)
const pendingNavigation = ref<(() => void) | null>(null)
const baseline = shallowRef({ name: 'my-skill', skillMarkdown: '', isAgentDiscoverable: true })
const refreshError = ref('')
const removeError = ref('')
const removalNotice = ref('')
type ComponentRoot = { $el?: unknown }
const editorRoot = useTemplateRef<HTMLElement>('editorRoot')
const nameInput = useTemplateRef<ComponentRoot | HTMLElement>('nameInput')
const markdownInput = useTemplateRef<ComponentRoot | HTMLElement>('markdownInput')
const removeDialogCard = useTemplateRef<ComponentRoot | HTMLElement>('removeDialogCard')
const discardDialogCard = useTemplateRef<ComponentRoot | HTMLElement>('discardDialogCard')
const destructiveRestoreTarget = shallowRef<HTMLElement | null>(null)
let destructiveFocusScope: ModalFocusScope | null = null
let discardFocusScope: ModalFocusScope | null = null
let loadController: AbortController | null = null
let disposed = false
let loadGeneration = 0
let authorityGeneration = 0
const readAccepted = ref(false)
let operationGeneration = 0
const ownerKey = (): number | null => props.ownerId ?? null
const isCurrent = (generation: number, ownerId: number | null, csrfToken: string): boolean =>
  !disposed && authorityGeneration === generation && ownerKey() === ownerId && props.csrfToken === csrfToken
const selectedSkill = computed(() => skills.value.find(skill => skill.id === editingId.value) ?? null)
const editedSkillMissing = computed(() => loaded.value && Boolean(editingId.value) && !selectedSkill.value)
const networkBlocked = computed(() => props.networkBlocked === true)
const compareNames = (left: string, right: string): number => {
  const leftName = left.toLowerCase()
  const rightName = right.toLowerCase()
  if (leftName < rightName) return -1
  if (leftName > rightName) return 1
  return left < right ? -1 : left > right ? 1 : 0
}
const filteredSkills = computed(() => {
  const query = (search.value ?? '').trim().toLowerCase()
  return skills.value
    .filter(skill => !query || skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query))
    .sort((left, right) => compareNames(left.name, right.name))
})
const skillPage = ref(0)
const renderedSkills = computed(() => filteredSkills.value.slice(skillPage.value * 40, (skillPage.value + 1) * 40))
watch(filteredSkills, () => { skillPage.value = 0 })
const isDirty = computed(() => name.value !== baseline.value.name || skillMarkdown.value !== baseline.value.skillMarkdown || isAgentDiscoverable.value !== baseline.value.isAgentDiscoverable)
const nameRule = (value: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.trim()) || t('common:agentPersonalSkills.useLowercaseLettersNumbers')
const markdownRule = (value: string) => value.length <= 65536 || t('common:agentPersonalSkills.skillMdMust65')
const formValid = computed(() => Boolean(name.value.trim() && skillMarkdown.value.trim()) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name.value.trim()) && skillMarkdown.value.length <= 65536)
const nameRules = [nameRule]
const markdownRules = [markdownRule]
const fetcher = window.fetch.bind(window)
const updatedAtFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const formatUpdated = (value: string): string => updatedAtFormatter.format(new Date(value))
const shortHash = (value: string): string => value.slice(0, 12)

const templateFor = (skillName: string): string => `${t('common:agentPersonalSkills.nameDescriptionExplainWhen', { skillName, interpolation: { escapeValue: false } })}
`

const setBaseline = (): void => { baseline.value = { name: name.value, skillMarkdown: skillMarkdown.value, isAgentDiscoverable: isAgentDiscoverable.value } }
const applyNew = (): void => {
  editingId.value = null; name.value = 'my-skill'; skillMarkdown.value = templateFor(name.value); isAgentDiscoverable.value = true; error.value = ''; removalNotice.value = ''; setBaseline()
}
const applyEdit = (skill: PersonalAgentSkill): void => {
  editingId.value = skill.id; name.value = skill.name; skillMarkdown.value = skill.skillMarkdown; isAgentDiscoverable.value = skill.isAgentDiscoverable; error.value = ''; removalNotice.value = ''; setBaseline()
}
const requestNavigation = (action: () => void): void => {
  if (saving.value) return
  if (isDirty.value) { pendingNavigation.value = action; discardOpen.value = true } else action()
}
const componentElement = (component: ComponentRoot | HTMLElement | null): HTMLElement | null => {
  if (component instanceof HTMLElement) return component
  return component?.$el instanceof HTMLElement ? component.$el : null
}
const revealEditor = async (): Promise<void> => {
  if (!smAndDown.value) return
  await nextTick()
  const editor = editorRoot.value
  if (!editor) return
  editor.scrollIntoView({ block: 'start' })
  const field = componentElement(editingId.value ? markdownInput.value : nameInput.value)
    ?.querySelector<HTMLElement>(editingId.value ? 'textarea' : 'input')
  ;(field ?? editor).focus({ preventScroll: true })
}
const requestNew = (): void => requestNavigation(() => { applyNew(); void revealEditor() })
const requestEdit = (skill: PersonalAgentSkill): void => requestNavigation(() => { applyEdit(skill); void revealEditor() })
const requestClose = (): void => requestNavigation(() => { open.value = false })
const handleOpenUpdate = (value: boolean): void => {
  if (value) {
    open.value = true
    return
  }
  requestClose()
}
const confirmDiscard = (): void => {
  discardOpen.value = false
  const action = pendingNavigation.value
  pendingNavigation.value = null
  action?.()
}
const load = async (selectedId?: string, committedMessage?: string): Promise<boolean> => {
  if (disposed || networkBlocked.value) return false
  const authority = authorityGeneration
  const ownerId = ownerKey()
  const csrfToken = props.csrfToken
  const preserveEditor = isDirty.value
  loadController?.abort()
  const controller = new AbortController()
  loadController = controller
  const generation = ++loadGeneration
  loading.value = true
  readAccepted.value = false
  refreshError.value = ''
  try {
    const nextSkills = await listPersonalAgentSkills(fetcher, csrfToken, controller.signal)
    if (!isCurrent(authority, ownerId, csrfToken) || generation !== loadGeneration || loadController !== controller) return false
    skills.value = nextSkills
    loaded.value = true
    readAccepted.value = true
    const pendingRemoval = removing.value
    const latestRemoval = pendingRemoval ? nextSkills.find(skill => skill.id === pendingRemoval.id) ?? null : null
    if (pendingRemoval) removing.value = latestRemoval
    const selected = skills.value.find(skill => skill.id === selectedId) ?? skills.value.find(skill => skill.id === editingId.value)
    if (!preserveEditor && !isDirty.value) {
      if (selected) applyEdit(selected)
      else applyNew()
    }
    if (pendingRemoval && !latestRemoval) {
      removeError.value = ''
      removalNotice.value = t('common:agentPersonalSkills.removeTargetNoLongerAvailable')
      destructiveRestoreTarget.value = editorRoot.value
    }
    return true
  } catch (caught) {
    if (!isCurrent(authority, ownerId, csrfToken) || generation !== loadGeneration || loadController !== controller || controller.signal.aborted) return false
    readAccepted.value = false
    const reason = caught instanceof Error ? caught.message : loaded.value ? t('common:agentPersonalSkills.personalSkillsCouldNot') : t('common:agentPersonalSkills.personalSkillsCouldNot2')
    refreshError.value = loaded.value ? t('common:agentPersonalSkills.showingLastLoadedPersonal', { prefix: committedMessage ? `${committedMessage} ` : '', reason, interpolation: { escapeValue: false } }) : reason
    return false
  } finally {
    if (isCurrent(authority, ownerId, csrfToken) && generation === loadGeneration && loadController === controller) {
      loading.value = false
      loadController = null
    }
  }
}
const save = async (): Promise<void> => {
  if (disposed || networkBlocked.value || !readAccepted.value || saving.value || loading.value || !formValid.value || editedSkillMissing.value) return
  const authority = authorityGeneration
  const ownerId = ownerKey()
  const csrfToken = props.csrfToken
  const operation = ++operationGeneration
  saving.value = true
  readAccepted.value = false
  error.value = ''
  const markdown = skillMarkdown.value
  const discoverable = isAgentDiscoverable.value
  const current = selectedSkill.value
  try {
    const saved = current
      ? await updatePersonalAgentSkill(fetcher, csrfToken, current.id, { expectedVersionId: current.versionId, skillMarkdown: markdown, isAgentDiscoverable: discoverable })
      : await createPersonalAgentSkill(fetcher, csrfToken, { name: name.value, skillMarkdown: markdown, isAgentDiscoverable: discoverable })
    if (!isCurrent(authority, ownerId, csrfToken) || operationGeneration !== operation) return
    skills.value = [...skills.value.filter(skill => skill.id !== saved.id), saved]
    applyEdit(saved)
    emit('changed')
    await load(saved.id, t('common:agentPersonalSkills.skillWasSaved'))
  } catch (caught) {
    if (!isCurrent(authority, ownerId, csrfToken) || operationGeneration !== operation) return
    error.value = caught instanceof Error ? caught.message : t('common:agentPersonalSkills.personalSkillCouldNot')
    readAccepted.value = false
  } finally {
    if (isCurrent(authority, ownerId, csrfToken) && operationGeneration === operation) saving.value = false
  }
}
const beginRemove = (skill: PersonalAgentSkill | null, event: MouseEvent): void => {
  if (!skill || disposed || networkBlocked.value || !readAccepted.value || saving.value || loading.value) return
  removeError.value = ''
  removalNotice.value = ''
  destructiveRestoreTarget.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  removing.value = skill
}
const cancelRemove = (): void => {
  if (saving.value) return
  removing.value = null
  removeError.value = ''
}
const remove = async (): Promise<void> => {
  const skill = removing.value
  if (!skill || disposed || networkBlocked.value || !readAccepted.value || saving.value || loading.value) return
  const authority = authorityGeneration
  const ownerId = ownerKey()
  const csrfToken = props.csrfToken
  const operation = ++operationGeneration
  saving.value = true
  readAccepted.value = false
  removeError.value = ''
  try {
    await removePersonalAgentSkill(fetcher, csrfToken, skill.id, skill.versionId)
    if (!isCurrent(authority, ownerId, csrfToken) || operationGeneration !== operation) return
    skills.value = skills.value.filter(candidate => candidate.id !== skill.id)
    applyNew()
    destructiveRestoreTarget.value = editorRoot.value
    removing.value = null
    emit('changed')
    await load(undefined, t('common:agentPersonalSkills.skillWasRemoved'))
  } catch (caught) {
    if (!isCurrent(authority, ownerId, csrfToken) || operationGeneration !== operation) return
    removeError.value = caught instanceof Error ? caught.message : t('common:agentPersonalSkills.personalSkillCouldNot2')
    readAccepted.value = false
  } finally {
    if (isCurrent(authority, ownerId, csrfToken) && operationGeneration === operation) saving.value = false
  }
}
watch(removing, async skill => {
  if (!skill) {
    await nextTick()
    if (disposed || removing.value) return
    destructiveFocusScope?.deactivate({ restoreFocus: true })
    destructiveFocusScope = null
    destructiveRestoreTarget.value = null
    return
  }
  await nextTick()
  if (disposed || removing.value !== skill) return
  const root = componentElement(removeDialogCard.value)
  if (!root) return
  destructiveFocusScope?.deactivate({ restoreFocus: false })
  destructiveFocusScope = createModalFocusScope({
    root,
    restoreTarget: () => destructiveRestoreTarget.value,
    onEscape: () => {
      if (!saving.value) cancelRemove()
    }
  })
})
watch(discardOpen, async isOpen => {
  if (!isOpen) {
    await nextTick()
    if (disposed || discardOpen.value) return
    discardFocusScope?.deactivate({ restoreFocus: true })
    discardFocusScope = null
    return
  }
  await nextTick()
  if (disposed || discardOpen.value !== isOpen) return
  const root = componentElement(discardDialogCard.value)
  if (!root) return
  discardFocusScope?.deactivate({ restoreFocus: false })
  discardFocusScope = createModalFocusScope({
    root,
    restoreTarget: () => editorRoot.value,
    onEscape: () => { discardOpen.value = false }
  })
})
watch(name, (next, previous) => {
  if (editingId.value || next === previous) return
  const frontmatter = skillMarkdown.value.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!frontmatter) return
  const sourceName = frontmatter[1].match(/^name:[ \t]*([^\r\n]*)/m)
  if (!sourceName || sourceName[1].trim() !== previous) return
  const updatedFrontmatter = frontmatter[0].replace(/^name:[^\r\n]*/m, `name: ${next}`)
  skillMarkdown.value = updatedFrontmatter + skillMarkdown.value.slice(frontmatter[0].length)
})
watch(networkBlocked, (blocked, wasBlocked) => {
  if (blocked) {
    loadGeneration += 1
    loadController?.abort()
    loadController = null
    loading.value = false
    readAccepted.value = false
    return
  }
  if (wasBlocked && open.value && !saving.value) void load(editingId.value ?? undefined)
})
watch(() => props.ownerId, (ownerId, previousOwnerId) => {
  if (ownerId === previousOwnerId) return
  authorityGeneration += 1
  operationGeneration += 1
  loadGeneration += 1
  loadController?.abort()
  loadController = null
  loading.value = false
  saving.value = false
  readAccepted.value = false
  loaded.value = false
  skills.value = []
  search.value = ''
  editingId.value = null
  applyNew()
  error.value = ''
  refreshError.value = ''
  removeError.value = ''
  removing.value = null
  discardOpen.value = false
  pendingNavigation.value = null
  if (open.value && !networkBlocked.value) void load()
})
watch(() => props.csrfToken, (csrfToken, previousCsrfToken) => {
  if (csrfToken === previousCsrfToken) return
  authorityGeneration += 1
  operationGeneration += 1
  loadGeneration += 1
  loadController?.abort()
  loadController = null
  saving.value = false
  readAccepted.value = false
})
watch(open, value => { if (value && !networkBlocked.value) void load(editingId.value ?? undefined) }, { immediate: true })
onBeforeUnmount(() => {
  disposed = true
  authorityGeneration += 1
  operationGeneration += 1
  loadGeneration++
  loadController?.abort()
  loadController = null
  destructiveFocusScope?.deactivate({ restoreFocus: false })
  discardFocusScope?.deactivate({ restoreFocus: false })
})
</script>

<style scoped>
.personal-skills, .personal-confirmation { overflow: hidden; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius) !important; background: var(--wiki-surface-raised) !important; color: rgb(var(--v-theme-on-surface)); }
.personal-skills__header, .personal-confirmation__header { display: flex; align-items: center; gap: 1rem; padding: 1rem 1.25rem; border-bottom: 1px solid var(--wiki-surface-border); background: var(--wiki-surface-raised); }
.personal-skills__mark, .personal-editor-section__heading > span, .personal-confirmation__header > span { display: grid; flex: 0 0 auto; width: 2.75rem; height: 2.75rem; place-items: center; border-radius: var(--wiki-control-radius); color: var(--wiki-primary-ink); background: var(--wiki-surface-sunken); }
.personal-skills__heading { flex: 1; min-width: 0; }
.personal-skills__eyebrow { color: var(--wiki-text-muted); font-size: .8125rem; font-weight: 600; }
.personal-skills h2, .personal-skills h3, .personal-skills h4, .personal-confirmation h2 { margin: .25rem 0; font-family: var(--wiki-font-heading); font-weight: 700; line-height: 1.4; overflow-wrap: anywhere; }
.personal-skills h2 { font-size: 1.125rem; }
.personal-skills h3, .personal-confirmation h2 { font-size: 1rem; }
.personal-skills h4 { font-size: .9375rem; }
.personal-skills__heading p, .personal-editor__header p, .personal-editor-section__heading p, .personal-discovery p { margin: .25rem 0; color: var(--wiki-text-muted); font-size: .875rem; line-height: 1.5; }
.personal-skills__header-state, .personal-editor__header-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.personal-skills__boundary, .personal-skills__trust-note { display: flex; align-items: start; gap: .5rem; color: var(--wiki-text-muted); font-size: .875rem; line-height: 1.5; }
.personal-skills__boundary { padding: .75rem 1.25rem; border-bottom: 1px solid var(--wiki-surface-border); background: var(--wiki-surface-sunken); }
.personal-skills__boundary .v-icon, .personal-skills__trust-note .v-icon { flex: 0 0 auto; color: var(--wiki-primary-ink); }
.personal-skills__body { padding: 0 !important; }
.personal-skills__layout { display: grid; min-height: min(40rem, 72dvh); grid-template-columns: minmax(17rem, 21rem) minmax(0, 1fr); }
.personal-inventory { display: flex; min-width: 0; flex-direction: column; padding: 1rem; border-inline-end: 1px solid var(--wiki-surface-border); background: var(--wiki-surface-sunken); }
.personal-inventory__header, .personal-editor__header { display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
.personal-inventory__header { margin-bottom: .75rem; }
.personal-inventory__search { margin-bottom: .5rem; }
.personal-inventory__search :deep(.v-field), .personal-editor__code :deep(.v-field) { border-radius: var(--wiki-control-radius); background: var(--wiki-surface-raised); }
.personal-inventory__summary { padding: .5rem 0; color: var(--wiki-text-muted); font-size: .8125rem; font-variant-numeric: tabular-nums; }
.personal-inventory__list { max-height: 32rem; min-height: 0; overflow-y: auto; padding: 0; background: var(--wiki-surface-raised); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); }
.personal-skill-item { min-height: 3.5rem; margin: 0; border-radius: 0 !important; border-bottom: 1px solid var(--wiki-surface-border); }
.personal-skill-item.v-list-item--active { border-inline-start: 3px solid var(--wiki-primary-ink); background: var(--wiki-surface-sunken); }
.personal-skill-item:focus-visible, .personal-editor:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: -2px; }
.personal-skill-item__icon { color: var(--wiki-primary-ink); margin-inline-end: .5rem; }
.personal-skill-item :deep(.v-list-item-title), .personal-skill-item :deep(.v-list-item-subtitle) { white-space: normal; overflow-wrap: anywhere; }
.personal-skill-item :deep(.v-list-item-title) { font-size: .875rem; font-weight: 650; }
.personal-skill-item :deep(.v-list-item-subtitle) { font-size: .8125rem; opacity: 1; color: var(--wiki-text-muted); }
.personal-skill-item__append { display: flex; align-items: center; gap: .5rem; color: var(--wiki-text-muted); }
.personal-skill-item__mode { display: flex; align-items: center; gap: .25rem; font-size: .8125rem; }
.personal-inventory__empty, .personal-inventory__loading { display: grid; gap: .75rem; padding: 1.5rem .5rem; color: var(--wiki-text-muted); font-size: .875rem; }
.personal-inventory__empty strong { color: rgb(var(--v-theme-on-surface)); }
.personal-inventory__error { margin-block: .75rem; }
.personal-editor { min-width: 0; background: var(--wiki-surface-raised); }
.personal-editor__header { padding: 1rem 1.25rem; border-bottom: 1px solid var(--wiki-surface-border); flex-wrap: wrap; }
.personal-editor__header > div { min-width: 0; }
.personal-editor__form { padding: 1.25rem; }
.personal-editor__error { margin: 1rem 1.25rem 0; }
.personal-editor-section + .personal-editor-section { margin-top: 1.25rem; padding-top: 1.25rem; border-top: 1px solid var(--wiki-surface-border); }
.personal-editor-section__heading { display: flex; align-items: start; gap: .75rem; margin-bottom: 1rem; flex-wrap: wrap; }
.personal-editor-section__heading > div { flex: 1; min-width: 0; }
.personal-editor-section__fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(15rem, .8fr); gap: 1rem; }
.personal-discovery { padding: .5rem .75rem; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); background: var(--wiki-surface-sunken); }
.personal-provenance { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 1rem 0 0; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); background: var(--wiki-surface-sunken); }
.personal-provenance > div { min-width: 0; padding: .75rem; }
.personal-provenance dt { color: var(--wiki-text-muted); font-size: .8125rem; margin-bottom: .25rem; }
.personal-provenance dd { margin: 0; font-size: .875rem; overflow-wrap: anywhere; }
.personal-provenance code, .personal-editor__code :deep(textarea) { font-family: var(--wiki-font-mono); }
.personal-editor__code :deep(textarea) { font-size: .875rem; line-height: 1.6; tab-size: 2; }
.personal-skills__actions { display: flex; flex-wrap: wrap; gap: .5rem; padding: .75rem 1rem !important; border-top: 1px solid var(--wiki-surface-border); background: var(--wiki-surface-sunken); }
.personal-skills__trust-note { flex: 1 1 20rem; min-width: 0; }
.personal-skills :deep(.v-btn), .personal-confirmation :deep(.v-btn) { min-height: 2.75rem; border-radius: var(--wiki-control-radius); }
.personal-confirmation__header--danger > span { color: rgb(var(--v-theme-error)); }
@media (max-width: 839.98px) {
  .personal-skills { border: 0; border-radius: 0 !important; }
  .personal-skills__layout, .personal-editor-section__fields, .personal-provenance { grid-template-columns: 1fr; }
  .personal-skills__header { flex-wrap: wrap; }
  .personal-skills__header-state { flex-basis: 100%; }
  .personal-inventory { border-inline-end: 0; border-bottom: 1px solid var(--wiki-surface-border); }
  .personal-inventory__list { max-height: 14rem; }
}
@media (max-width: 560px) {
  .personal-skills__header, .personal-skills__boundary, .personal-editor__header, .personal-editor__form { padding: 1rem; }
  .personal-inventory__header { align-items: stretch; flex-direction: column; }
  .personal-skills__actions > .v-btn { flex: 1 1 auto; }
}
@media (forced-colors: active) { .personal-skill-item.v-list-item--active { outline: 2px solid Highlight; outline-offset: -2px; } }
</style>
