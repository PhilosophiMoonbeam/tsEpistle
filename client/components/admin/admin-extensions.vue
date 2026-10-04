<template lang="pug">
v-container.extensions-workspace(fluid)
  admin-hero(
    :title='$t(`admin:extensions.title`)'
    :description='$t(`admin:extensions.seeWhichOptionalTools`)'
    :eyebrow='$t(`admin:extensions.operations`)'
    icon='mdi-puzzle-plus-outline'
    heading-id='extensions-title'
  )
    template(#extra)
      dl.extensions-heading-facts
        div
          dt {{ $t(`admin:extensions.bundled`) }}
          dd.extensions-stat {{ workspace?.extensions.length ?? 0 }}
        div
          dt {{ $t(`admin:extensions.usableNow`) }}
          dd.extensions-stat {{ usableCount }}
        div
          dt {{ $t(`admin:extensions.observed`) }}
          dd: time(:datetime='workspace?.observedAt') {{ workspace ? dateTime(workspace.observedAt) : '—' }}
      p.extensions-boundary
        v-icon(icon='mdi-shield-lock-outline' size='16' aria-hidden='true')
        span {{ $t(`admin:extensions.availabilityCheckedProcessInstallation`) }}
    template(#actions)
      v-btn(variant='text' prepend-icon='mdi-refresh' :loading='loading' :disabled='loading' @click='refresh')
        | {{ $t('admin:shell.reload') }}
        v-tooltip(activator='parent' location='bottom') {{ $t(`admin:extensions.reloadExtensionObservations`) }}
  async-state(v-if='loading && !workspace' state='loading' :title='$t(`admin:extensions.readingDeployedExtensionLibrary`)' :message='$t(`admin:extensions.checkingBundledDefinitionsTheir`)')
  async-state(v-else-if='error && !workspace' state='error' :title='$t(`admin:extensions.extensionObservationsCouldNot2`)' :message='error' :retry-label='$t(`admin:extensions.tryAgain`)' @retry='refresh')
  template(v-else-if='workspace && workspace.extensions.length')
    v-alert(v-if='error' type='warning' variant='tonal' closable class='mb-5' @click:close='dismissError')
      | {{ $t(`admin:extensions.lastRefreshCouldNot`) }}

    section.extensions-library(aria-labelledby='extensions-library-title')
      aside.extensions-library-nav
        .extensions-library-heading
          div
            span.extensions-kicker {{ $t(`admin:extensions.deploymentObservations`) }}
            h2#extensions-library-title {{ $t(`admin:extensions.library`) }}
          span {{ $t(`admin:extensions.shown`, { filteredExtensionsCount: filteredExtensions.length, interpolation: { escapeValue: false } }) }}
        v-text-field(
          v-model='search'
          :label='$t(`admin:extensions.searchExtensions`)'
          prepend-inner-icon='mdi-magnify'
          variant='outlined'
          density='comfortable'
          clearable
          hide-details
        )
        v-select.extensions-status-filter(
          v-model='statusFilter'
          :items='statusFilters'
          :label='$t(`admin:extensions.observedState`)'
          variant='outlined'
          density='comfortable'
          hide-details
        )
        p.extensions-filter-note {{ $t(`admin:extensions.searchMatchesTitlePurpose`) }}
        ul.extensions-library-list(v-if='filteredExtensions.length' :aria-label='$t(`admin:extensions.filteredExtensions`)')
          li(v-for='extension in filteredExtensions' :key='extension.key')
            button.extensions-library-row(
              type='button'
              :class='{ "is-selected": selectedExtension?.key === extension.key }'
              :aria-current='selectedExtension?.key === extension.key ? `true` : undefined'
              @click='selectExtension(extension.key)'
              @keydown='moveSelection($event, extension.key)'
            )
              v-icon(:icon='observationPresentations[extension.observation.state].icon' :color='observationPresentations[extension.observation.state].color' size='19')
              span.extensions-library-copy
                strong {{ extension.title }}
                small {{ observationPresentations[extension.observation.state].label }}
              v-icon(icon='mdi-chevron-right' size='18' aria-hidden='true')
        v-alert(v-else type='info' variant='outlined' density='comfortable' icon='mdi-filter-variant-remove') {{ $t(`admin:extensions.noExtensionRecordsMatch`) }}
      article#extension-detail.extensions-detail(v-if='selectedExtension' :aria-label='$t(`admin:extensions.deploymentDetails`, { title: selectedExtension.title, interpolation: { escapeValue: false } })')
        header.extensions-detail-header
          div
            span.extensions-kicker {{ $t(`admin:extensions.deploymentBoundary`, { key: selectedExtension.key, interpolation: { escapeValue: false } }) }}
            h2 {{ selectedExtension.title }}
            p {{ selectedExtension.description }}
          .extensions-state-chips
            v-chip(label size='small' :color='observationPresentations[selectedExtension.observation.state].color' :prepend-icon='observationPresentations[selectedExtension.observation.state].icon') {{ observationPresentations[selectedExtension.observation.state].label }}
            v-chip(label size='small' variant='outlined' :color='compatibilityPresentations[selectedExtension.observation.compatibility].color') {{ compatibilityPresentations[selectedExtension.observation.compatibility].label }}
        section.extensions-evidence
          h3 {{ $t(`admin:extensions.observedProcessEvidence`) }}
          p {{ selectedExtension.observation.evidence }}
          time(:datetime='selectedExtension.observation.checkedAt') {{ $t(`admin:extensions.checked`, { checkedAt: dateTime(selectedExtension.observation.checkedAt), interpolation: { escapeValue: false } }) }}
        section.extensions-installation
          span.extensions-section-number 01
          div
            h3 {{ $t(`admin:extensions.installationBoundarySetup`) }}
            p {{ selectedExtension.installation.detail }}
            dl
              div
                dt {{ $t(`admin:extensions.owned`) }}
                dd {{ boundaryLabels[selectedExtension.installation.boundary] }}
        section.extensions-grid
          section
            span.extensions-section-number 02
            h3 {{ $t(`admin:extensions.capabilitiesConfiguration`) }}
            ul.extensions-fact-list
              li(v-for='capability in selectedExtension.capabilities' :key='capability.title')
                strong {{ capability.title }}
                p {{ capability.detail }}
                v-btn(v-if='capability.configuration' :to='linkTarget(capability.configuration)' variant='text' color='primary' size='small' append-icon='mdi-arrow-right') {{ capability.configuration.label }}
          section
            span.extensions-section-number 03
            h3 {{ $t(`admin:extensions.dependencies`) }}
            ul.extensions-fact-list
              li(v-for='dependency in selectedExtension.dependencies' :key='dependency.title')
                strong {{ dependency.title }}
                p {{ dependency.detail }}
        section.extensions-recovery
          span.extensions-section-number 04
          div
            h3 {{ $t(`admin:extensions.ifToolMissing`) }}
            p {{ selectedExtension.installation.recovery }}
            p.extensions-recovery-note {{ $t(`admin:extensions.afterUpdatingApplicationImage`) }}
      v-alert(v-else-if='requestedExtensionIsFilteredOut' type='info' variant='outlined' icon='mdi-filter-variant') {{ $t(`admin:extensions.selectedExtensionOutsideCurrent`) }}
      v-alert(v-else-if='requestedExtensionIsUnavailable' type='warning' variant='outlined' icon='mdi-alert-circle-outline') {{ $t(`admin:extensions.selectedExtensionNotReported`) }}
      v-alert(v-else type='info' variant='outlined' icon='mdi-puzzle-outline') {{ $t(`admin:extensions.selectExtensionInspectDeployment`) }}
  async-state(v-else state='empty' :title='$t(`admin:extensions.noExtensionDefinitionsBundled`)' :message='$t(`admin:extensions.applicationImageDidNot`)')
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AsyncState from '@/components/common/async-state.vue'
import type {
  ExtensionWorkspaceLink,
  ExtensionWorkspaceExtension,
  ExtensionsWorkspace,
  OptionalExtensionKey
} from '../../../shared/extensions-workspace.ts'
import { fetchExtensionsWorkspace } from '../../helpers/extensions-workspace-api.ts'
import './extensions-workspace.scss'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()

const route = useRoute()
const router = useRouter()
const workspace = shallowRef<ExtensionsWorkspace | null>(null)
const loading = ref(true)
const error = ref('')
const search = ref<string | null>('')
const statusFilter = ref('all')
const statusFilters = [
  { title: t('admin:extensions.allObservations'), value: 'all' },
  { title: t('admin:extensions.usableProcess'), value: 'usable' },
  { title: t('admin:extensions.missingProcess'), value: 'missing' },
  { title: t('admin:extensions.notProvidedHere'), value: 'not-provided' },
  { title: t('admin:extensions.observationUnknown'), value: 'unknown' }
]

let disposed = false
let sequence = 0
let controller: AbortController | null = null

const filteredExtensions = computed(() => {
  const query = (search.value || '').trim().toLocaleLowerCase()
  return (workspace.value?.extensions || []).filter((extension) => {
    const text = [
      extension.key,
      extension.title,
      extension.description,
      extension.installation.detail,
      extension.installation.recovery,
      ...extension.capabilities.flatMap((item) => [item.title, item.detail]),
      ...extension.dependencies.flatMap((item) => [item.title, item.detail])
    ]
      .join(' ')
      .toLocaleLowerCase()
    return (statusFilter.value === 'all' || extension.observation.state === statusFilter.value) && (!query || text.includes(query))
  })
})

const requestedExtensionKey = computed(() => (typeof route.query.extension === 'string' ? route.query.extension : ''))

const selectedExtension = computed(() => {
  const key = requestedExtensionKey.value
  return key ? filteredExtensions.value.find((extension) => extension.key === key) : filteredExtensions.value[0]
})

const requestedExtensionIsFilteredOut = computed(() =>
  Boolean(
    requestedExtensionKey.value &&
    workspace.value?.extensions.some((extension) => extension.key === requestedExtensionKey.value) &&
    !selectedExtension.value
  )
)

const requestedExtensionIsUnavailable = computed(() =>
  Boolean(
    requestedExtensionKey.value && workspace.value && !workspace.value.extensions.some((extension) => extension.key === requestedExtensionKey.value)
  )
)

const usableCount = computed(() => workspace.value?.extensions.filter((extension) => extension.observation.state === 'usable').length || 0)

const observationPresentations = {
  usable: { label: t('admin:extensions.usableProcess'), color: 'success', icon: 'mdi-check-circle-outline' },
  missing: { label: t('admin:extensions.missingProcess'), color: 'warning', icon: 'mdi-package-variant-remove' },
  'not-provided': { label: t('admin:extensions.notProvidedHere'), color: 'info', icon: 'mdi-information-outline' },
  unknown: { label: t('admin:extensions.observationUnknown'), color: 'warning', icon: 'mdi-help-circle-outline' }
} satisfies Record<ExtensionWorkspaceExtension['observation']['state'], { label: string; color: string; icon: string }>

const compatibilityPresentations = {
  verified: { label: t('admin:extensions.compatibilityObserved'), color: 'success' },
  'not-applicable': { label: t('admin:extensions.noProcessCompatibilityCheck'), color: 'info' },
  unknown: { label: t('admin:extensions.compatibilityUnconfirmed'), color: 'warning' }
} satisfies Record<ExtensionWorkspaceExtension['observation']['compatibility'], { label: string; color: string }>

const boundaryLabels = {
  'application-image': t('admin:extensions.reviewedApplicationImage'),
  'application-package': t('admin:extensions.productionApplicationPackage'),
  'separate-image': t('admin:extensions.separateDeployedImage')
} satisfies Record<ExtensionWorkspaceExtension['installation']['boundary'], string>

const dateTime = (value: string) => {
  const date = new Date(value)
  return Number.isFinite(date.valueOf())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : t('admin:extensions.unknownTime')
}

const linkTarget = (link: ExtensionWorkspaceLink) => ({
  path: link.path,
  ...(link.query ? { query: link.query } : {}),
  ...(link.hash ? { hash: `#${link.hash}` } : {})
})

const dismissError = () => {
  error.value = ''
}
const selectExtension = (key: OptionalExtensionKey) => {
  void router.replace({ query: { ...route.query, extension: key } })
}

const moveSelection = (event: KeyboardEvent, key: OptionalExtensionKey) => {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !filteredExtensions.value.length) return
  event.preventDefault()
  const current = filteredExtensions.value.findIndex((extension) => extension.key === key)
  const index =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? filteredExtensions.value.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + filteredExtensions.value.length) % filteredExtensions.value.length
  const next = filteredExtensions.value[index]
  if (!next) return
  selectExtension(next.key)
  requestAnimationFrame(() => document.querySelectorAll<HTMLElement>('.extensions-library-row')[index]?.focus())
}

const refresh = async () => {
  const request = ++sequence
  controller?.abort()
  const activeController = new AbortController()
  controller = activeController
  loading.value = true
  error.value = ''
  try {
    const next = await fetchExtensionsWorkspace((input, init) => window.fetch(input, { ...init, signal: activeController.signal }))
    if (disposed || request !== sequence) return
    workspace.value = next
  } catch (cause) {
    if (disposed || request !== sequence || activeController.signal.aborted) return
    error.value = cause instanceof Error ? cause.message : t('admin:extensions.extensionObservationsCouldNot')
  } finally {
    if (!disposed && request === sequence) loading.value = false
  }
}

onMounted(() => {
  void refresh()
})

onBeforeUnmount(() => {
  disposed = true
  sequence++
  controller?.abort()
})
</script>
