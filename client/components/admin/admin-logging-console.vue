<template>
  <section class="logging-trail-panel" aria-labelledby="logging-trail-title">
    <div class="logging-trail-head">
      <div>
        <h3 id="logging-trail-title">Live diagnostic trail</h3>
        <p>Records are streamed only while this panel is open. They may contain operational context; copy or share them carefully.</p>
      </div>
      <v-chip size="small" variant="tonal" :color="statusColor" role="status" aria-live="polite">{{ statusLabel }}</v-chip>
    </div>
    <v-alert type="warning" variant="tonal" class="mb-4">
      This is an ephemeral troubleshooting view, not a delivery receipt. Common credential patterns are redacted and messages are truncated, but
      sensitive operational context can remain.
    </v-alert>
    <div class="logging-trail-toolbar">
      <v-select
        v-model="filters"
        :items="levelOptions"
        label="Show levels"
        variant="outlined"
        density="compact"
        multiple
        chips
        hide-details
        :disabled="!active"
      />
      <div class="logging-trail-actions">
        <v-btn size="small" variant="outlined" :disabled="!active" @click="paused = !paused">{{ paused ? 'Resume' : 'Pause' }}</v-btn>
        <v-btn size="small" variant="text" :disabled="lines.length === 0" @click="clear">Clear</v-btn>
        <v-btn size="small" variant="text" :disabled="!active" @click="reconnect">Reconnect</v-btn>
      </div>
    </div>
    <p v-if="paused" class="logging-trail-note">
      Paused locally.
      {{ dropped ? `${dropped} records were not added while paused.` : 'The connection remains open, but new records are not added.' }}
    </p>
    <p v-else-if="limitReached" class="logging-trail-note">
      {{
        limitMessage || `This connection reached its ${limits.maxConnectionEvents.toLocaleString()}-event safety limit. Reconnect for a fresh view.`
      }}
    </p>
    <div
      v-if="visibleLines.length"
      ref="terminal"
      class="logging-trail-output"
      role="log"
      tabindex="0"
      :aria-live="paused ? 'off' : 'polite'"
      aria-atomic="false"
      aria-relevant="additions text"
      @scroll="trackScroll"
    >
      <ol>
        <li v-for="line in visibleLines" :key="line.id" :class="`level-${line.level}`">
          <time :datetime="line.timestamp">{{ line.displayTime }}</time>
          <strong>{{ line.level }}</strong>
          <span>{{ line.output }}</span>
        </li>
      </ol>
    </div>
    <div v-else class="logging-trail-empty">
      <v-icon>mdi-pulse</v-icon>
      <h4>{{ active ? 'Waiting for a record' : 'Live trail paused' }}</h4>
      <p>
        {{
          active
            ? 'This process has not emitted a visible record for the selected levels.'
            : 'Open the Live trail section to start a privileged stream.'
        }}
      </p>
    </div>
    <p class="logging-trail-retention">
      This browser retains at most {{ limits.maxLines }} records or {{ byteLimit }}. Clearing affects only this browser. The server does not retain a
      trail.
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, triggerRef, useTemplateRef, watch } from 'vue'

interface LiveTrailLimits {
  enabled: true
  maxLines: number
  maxBytes: number
  maxConnectionEvents: number
  message: string
}

interface LiveLine {
  id: number
  timestamp: string
  level: string
  displayTime: string
  output: string
  bytes: number
}
const props = defineProps<{ active: boolean; limits: LiveTrailLimits }>()
const lines = shallowRef<LiveLine[]>([])
const filters = ref(['error', 'warn', 'info', 'verbose', 'debug', 'silly'])
const paused = ref(false)
const dropped = ref(0)
const connection = ref<'closed' | 'connecting' | 'live' | 'reconnecting' | 'error' | 'limited' | 'revoked'>('closed')
const limitReached = ref(false)
const limitMessage = ref('')
const terminal = useTemplateRef<HTMLElement>('terminal')
const isPinned = ref(true)
let source: EventSource | null = null
let generation = 0
let nextLineId = 0
let retainedBytes = 0
const levelOptions = ['error', 'warn', 'info', 'verbose', 'debug', 'silly']
const encoder = new TextEncoder()
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const visibleLines = computed(() => lines.value.filter((line) => filters.value.includes(line.level)))
const byteLimit = computed(() => `${Math.round(props.limits.maxBytes / 1024)} KiB`)
const statusLabel = computed(() => {
  switch (connection.value) {
    case 'connecting':
      return 'Connecting'
    case 'live':
      return paused.value ? 'Paused' : 'Live'
    case 'reconnecting':
      return 'Reconnecting'
    case 'limited':
      return 'Connection limit reached'
    case 'revoked':
      return 'Access changed'
    case 'error':
      return 'Unavailable'
    default:
      return 'Closed'
  }
})
const statusColor = computed(() => {
  if (connection.value === 'live') return paused.value ? 'warning' : 'success'
  if (connection.value === 'connecting' || connection.value === 'reconnecting') return 'info'
  if (connection.value === 'closed') return 'grey'
  return 'warning'
})
const lineBytes = (timestamp: string, level: string, output: string) => encoder.encode(`${timestamp} ${level} ${output}\n`).byteLength
const disconnect = () => {
  generation += 1
  source?.close()
  source = null
  if (connection.value !== 'limited' && connection.value !== 'revoked') connection.value = 'closed'
}
const clear = () => {
  lines.value = []
  retainedBytes = 0
  dropped.value = 0
  limitReached.value = false
  limitMessage.value = ''
}
const trackScroll = () => {
  const element = terminal.value
  if (!element) return
  isPinned.value = element.scrollHeight - element.scrollTop - element.clientHeight < 28
}
const scrollToNewest = () => {
  if (!isPinned.value) return
  void nextTick(() => {
    if (terminal.value) terminal.value.scrollTop = terminal.value.scrollHeight
  })
}
const append = (timestamp: string, level: string, output: string) => {
  if (paused.value) {
    dropped.value += 1
    return
  }
  const bytes = lineBytes(timestamp, level, output)
  lines.value.push({ id: ++nextLineId, timestamp, displayTime: timeFormatter.format(new Date(timestamp)), level, output, bytes })
  retainedBytes += bytes
  while (lines.value.length > props.limits.maxLines || retainedBytes > props.limits.maxBytes) {
    const oldest = lines.value.shift()
    if (oldest) retainedBytes -= oldest.bytes
  }
  triggerRef(lines)
  scrollToNewest()
}
const receive = (raw: string) => {
  try {
    const value = JSON.parse(raw) as { timestamp?: unknown; level?: unknown; output?: unknown }
    if (typeof value.output !== 'string') return
    const timestamp = typeof value.timestamp === 'string' && Number.isFinite(Date.parse(value.timestamp)) ? value.timestamp : new Date().toISOString()
    const level = typeof value.level === 'string' && levelOptions.includes(value.level) ? value.level : 'info'
    append(timestamp, level, value.output)
  } catch {
    append(new Date().toISOString(), 'info', 'The live trail sent a malformed record that was not displayed.')
  }
}
const connect = () => {
  if (!props.active) return
  disconnect()
  const current = ++generation
  connection.value = 'connecting'
  limitReached.value = false
  limitMessage.value = ''
  const next = new EventSource('/_api/logging/live')
  source = next
  next.onopen = () => {
    if (generation === current && source === next) connection.value = 'live'
  }
  next.onmessage = (event) => {
    if (generation === current && source === next) receive(event.data)
  }
  next.addEventListener('limit', () => {
    if (generation !== current || source !== next) return
    limitReached.value = true
    connection.value = 'limited'
    limitMessage.value = `This connection reached its ${props.limits.maxConnectionEvents.toLocaleString()}-event safety limit. Reconnect for a fresh view.`
    next.close()
    source = null
  })
  next.addEventListener('access-revoked', () => {
    if (generation !== current || source !== next) return
    connection.value = 'revoked'
    next.close()
    source = null
  })
  next.addEventListener('overflow', () => {
    if (generation !== current || source !== next) return
    limitReached.value = true
    connection.value = 'limited'
    limitMessage.value = 'This connection ended because it could not keep up with incoming records. Reconnect for a fresh view.'
    next.close()
    source = null
  })
  next.addEventListener('unavailable', () => {
    if (generation !== current || source !== next) return
    connection.value = 'error'
  })
  next.onerror = () => {
    if (generation !== current || source !== next) return
    connection.value = next.readyState === EventSource.CLOSED ? 'error' : 'reconnecting'
  }
}
const reconnect = () => {
  clear()
  connect()
}

watch(
  () => props.active,
  (active) => {
    if (active) connect()
    else disconnect()
  },
  { immediate: true }
)
onBeforeUnmount(disconnect)
</script>

<style lang="scss">
.logging-trail-panel {
  padding: 26px;
  border: 1px solid var(--logging-line);
  border-radius: 10px;
  background: rgb(var(--v-theme-surface));
}
.logging-trail-head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 18px;
}
.logging-trail-head h3 {
  font-size: 19px;
  font-weight: 650;
}
.logging-trail-head p {
  max-width: 680px;
  margin-top: 5px;
  color: var(--logging-muted);
  font-size: 13px;
  line-height: 1.7;
}
.logging-trail-toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 14px;
}
.logging-trail-toolbar > .v-input {
  flex: 1 1 auto;
  min-width: 0;
}
.logging-trail-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 6px;
}
.logging-trail-note,
.logging-trail-retention {
  color: var(--logging-muted);
  font-size: 12px;
  line-height: 1.7;
}
.logging-trail-note {
  margin: 12px 0;
}
.logging-trail-retention {
  margin-top: 14px;
}
.logging-trail-output {
  max-height: min(58dvh, 620px);
  overflow: auto;
  border: 1px solid var(--logging-line);
  border-radius: 8px;
  background: color-mix(in srgb, rgb(var(--v-theme-background)) 90%, #000);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.65;
}
.logging-trail-output ol {
  margin: 0;
  padding: 0;
  list-style: none;
}
.logging-trail-output li {
  display: grid;
  grid-template-columns: max-content 64px minmax(0, 1fr);
  gap: 12px;
  padding: 9px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--logging-line) 80%, transparent);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.logging-trail-output time {
  color: var(--logging-muted);
  white-space: nowrap;
}
.logging-trail-output strong {
  color: rgb(var(--v-theme-primary));
  font-weight: 650;
  text-transform: uppercase;
}
.logging-trail-output .level-error strong {
  color: rgb(var(--v-theme-error));
}
.logging-trail-output .level-warn strong {
  color: rgb(var(--v-theme-warning));
}
.v-theme--light .logging-trail-output strong {
  color: #005a88;
}
.v-theme--light .logging-trail-output .level-error strong {
  color: #9b0024;
}
.v-theme--light .logging-trail-output .level-warn strong {
  color: #704000;
}
.logging-trail-empty {
  padding: 38px 20px;
  border: 1px dashed var(--logging-line);
  border-radius: 8px;
  color: var(--logging-muted);
  text-align: center;
}
.logging-trail-empty h4 {
  margin: 12px 0 8px;
  color: rgb(var(--v-theme-on-surface));
  font-size: 16px;
}
.logging-trail-empty p {
  max-width: 430px;
  margin: 0 auto;
  font-size: 13px;
  line-height: 1.75;
}
@include until($tablet) {
  .logging-trail-panel {
    padding: 20px;
  }
  .logging-trail-head,
  .logging-trail-toolbar {
    align-items: stretch;
    flex-direction: column;
  }
  .logging-trail-actions {
    justify-content: stretch;
  }
  .logging-trail-actions .v-btn {
    flex: 1 1 0;
  }
  .logging-trail-output li {
    grid-template-columns: 1fr;
    gap: 3px;
  }
}
</style>
