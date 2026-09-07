<template lang="pug">
v-container.extensions-workspace(fluid)
  section.extensions-heading(aria-labelledby='extensions-title')
    div.extensions-heading-copy
      span.extensions-kicker Optional capabilities
      h1#extensions-title Extensions
      p See which optional tools are available to the wiki and where to configure them.
    div.extensions-heading-meta
      dl.extensions-heading-facts
        div
          dt Bundled
          dd.extensions-stat {{ workspace?.extensions.length ?? 0 }}
        div
          dt Usable now
          dd.extensions-stat {{ usableCount }}
        div
          dt Observed
          dd: time(:datetime='workspace?.observedAt') {{ workspace ? dateTime(workspace.observedAt) : '—' }}
      div.extensions-heading-actions
        v-btn(variant='outlined' color='primary' size='small' prepend-icon='mdi-refresh' :loading='loading' :disabled='loading' @click='refresh') Refresh observations
        p.extensions-boundary
          v-icon(icon='mdi-shield-lock-outline' size='16' aria-hidden='true')
          span Availability is checked in this process. Installation is managed with the application image.
  async-state(v-if='loading && !workspace' state='loading' title='Reading the deployed extension library' message='Checking the bundled definitions and their bounded process observations.')
  async-state(v-else-if='error && !workspace' state='error' title='Extension observations could not be read' :message='error' retry-label='Try again' @retry='refresh')
  template(v-else-if='workspace && workspace.extensions.length')
    v-alert(v-if='error' type='warning' variant='tonal' closable class='mb-5' @click:close='dismissError')
      | The last refresh could not be confirmed. The records below are the earlier observation; retry before acting on them.

    section.extensions-library(aria-labelledby='extensions-library-title')
      aside.extensions-library-nav
        .extensions-library-heading
          div
            span.extensions-kicker Deployment observations
            h2#extensions-library-title Library
          span {{ filteredExtensions.length }} shown
        v-text-field(
          v-model='search'
          label='Search extensions'
          prepend-inner-icon='mdi-magnify'
          variant='outlined'
          density='comfortable'
          clearable
          hide-details
        )
        v-select.extensions-status-filter(
          v-model='statusFilter'
          :items='statusFilters'
          label='Observed state'
          variant='outlined'
          density='comfortable'
          hide-details
        )
        p.extensions-filter-note Search matches the title, purpose, dependencies and recovery guidance.
        ul.extensions-library-list(v-if='filteredExtensions.length' aria-label='Filtered extensions')
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
        v-alert(v-else type='info' variant='outlined' density='comfortable' icon='mdi-filter-variant-remove') No extension records match this filter.
      article#extension-detail.extensions-detail(v-if='selectedExtension' :aria-label='`${selectedExtension.title} deployment details`')
        header.extensions-detail-header
          div
            span.extensions-kicker {{ selectedExtension.key }} / deployment boundary
            h2 {{ selectedExtension.title }}
            p {{ selectedExtension.description }}
          .extensions-state-chips
            v-chip(label size='small' :color='observationPresentations[selectedExtension.observation.state].color' :prepend-icon='observationPresentations[selectedExtension.observation.state].icon') {{ observationPresentations[selectedExtension.observation.state].label }}
            v-chip(label size='small' variant='outlined' :color='compatibilityPresentations[selectedExtension.observation.compatibility].color') {{ compatibilityPresentations[selectedExtension.observation.compatibility].label }}
        section.extensions-evidence
          h3 Observed process evidence
          p {{ selectedExtension.observation.evidence }}
          time(:datetime='selectedExtension.observation.checkedAt') Checked {{ dateTime(selectedExtension.observation.checkedAt) }}
        section.extensions-installation
          span.extensions-section-number 01
          div
            h3 Installation boundary & setup
            p {{ selectedExtension.installation.detail }}
            dl
              div
                dt Owned by
                dd {{ boundaryLabels[selectedExtension.installation.boundary] }}
        section.extensions-grid
          section
            span.extensions-section-number 02
            h3 Capabilities & configuration
            ul.extensions-fact-list
              li(v-for='capability in selectedExtension.capabilities' :key='capability.title')
                strong {{ capability.title }}
                p {{ capability.detail }}
                v-btn(v-if='capability.configuration' :to='linkTarget(capability.configuration)' variant='text' color='primary' size='small' append-icon='mdi-arrow-right') {{ capability.configuration.label }}
          section
            span.extensions-section-number 03
            h3 Dependencies
            ul.extensions-fact-list
              li(v-for='dependency in selectedExtension.dependencies' :key='dependency.title')
                strong {{ dependency.title }}
                p {{ dependency.detail }}
        section.extensions-recovery
          span.extensions-section-number 04
          div
            h3 If a tool is missing
            p {{ selectedExtension.installation.recovery }}
            p.extensions-recovery-note After updating the application image, refresh to check availability again.
      v-alert(v-else-if='requestedExtensionIsFilteredOut' type='info' variant='outlined' icon='mdi-filter-variant') The selected extension is outside the current filter. Clear or change the filter to inspect it.
      v-alert(v-else-if='requestedExtensionIsUnavailable' type='warning' variant='outlined' icon='mdi-alert-circle-outline') The selected extension is not reported by this deployed application image. Choose an available extension to inspect it.
      v-alert(v-else type='info' variant='outlined' icon='mdi-puzzle-outline') Select an extension to inspect its deployment boundary.
  async-state(v-else state='empty' title='No extension definitions are bundled' message='This application image did not report any optional extension definitions.')
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

const route = useRoute()
const router = useRouter()
const workspace = shallowRef<ExtensionsWorkspace | null>(null)
const loading = ref(true)
const error = ref('')
const search = ref('')
const statusFilter = ref('all')
const statusFilters = [
  { title: 'All observations', value: 'all' },
  { title: 'Usable in this process', value: 'usable' },
  { title: 'Missing from this process', value: 'missing' },
  { title: 'Not provided here', value: 'not-provided' },
  { title: 'Observation unknown', value: 'unknown' }
]

let disposed = false
let sequence = 0
let controller: AbortController | null = null

const filteredExtensions = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
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
  usable: { label: 'Usable in this process', color: 'success', icon: 'mdi-check-circle-outline' },
  missing: { label: 'Missing from this process', color: 'warning', icon: 'mdi-package-variant-remove' },
  'not-provided': { label: 'Not provided here', color: 'info', icon: 'mdi-information-outline' },
  unknown: { label: 'Observation unknown', color: 'warning', icon: 'mdi-help-circle-outline' }
} satisfies Record<ExtensionWorkspaceExtension['observation']['state'], { label: string; color: string; icon: string }>

const compatibilityPresentations = {
  verified: { label: 'Compatibility observed', color: 'success' },
  'not-applicable': { label: 'No in-process compatibility check', color: 'info' },
  unknown: { label: 'Compatibility unconfirmed', color: 'warning' }
} satisfies Record<ExtensionWorkspaceExtension['observation']['compatibility'], { label: string; color: string }>

const boundaryLabels = {
  'application-image': 'Reviewed application image',
  'application-package': 'Production application package',
  'separate-image': 'Separate deployed image'
} satisfies Record<ExtensionWorkspaceExtension['installation']['boundary'], string>

const dateTime = (value: string) => {
  const date = new Date(value)
  return Number.isFinite(date.valueOf())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : 'Unknown time'
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
    error.value = cause instanceof Error ? cause.message : 'Extension observations could not be loaded.'
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
