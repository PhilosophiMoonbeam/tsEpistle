<template lang='pug'>
  v-dialog(v-model='isShown', width='calc(100vw - 2rem)', max-width='1200', aria-labelledby='logging-console-title', @after-enter='attach')
    v-card.logging-console
      .dialog-header
        #logging-console-title.text-title-large Live Console
        v-spacer
        v-chip(
          size='small'
          variant='tonal'
          :color='connectionStatusColor'
          :aria-label='connectionStatusLabel'
          role='status'
          aria-live='polite'
        )
          v-progress-circular(
            v-if='connectionState === "connecting" || connectionState === "error"'
            indeterminate
            :color='connectionStatusColor'
            :size='14'
            :width='2'
            aria-hidden='true'
          )
          span {{ connectionStatusLabel }}
      pre.consoleTerm(
        ref='consoleContainer'
        role='log'
        tabindex='0'
        aria-live='polite'
        aria-atomic='false'
        aria-relevant='additions text'
        :aria-label='`Live console output: ${connectionStatusLabel}`'
      ) {{output}}
      v-card-actions.logging-console-actions
        v-spacer
        v-btn(variant="text", @click='clear')
          v-icon(start) cancel_presentation
          span Clear
        v-btn(color='primary', variant="flat", @click='close')
          v-icon(start) close
          span Close
</template>

<script lang='ts'>
import { wikiStore } from '@/store/index.ts'
export default {
  emits: ['update:modelValue'],
  data() {
    return {
      liveSource: null as EventSource | null,
      output: '',
      connectionState: 'closed' as 'closed' | 'connecting' | 'live' | 'error',
      scrollPending: false
    }
  },
  props: {
    modelValue: {
      type: Boolean,
      default: false
    }
  },
  computed: {
    isShown: {
      get() { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    },
    connectionStatusLabel() {
      switch (this.connectionState) {
        case 'connecting':
          return 'Connecting…'
        case 'live':
          return 'Live'
        case 'error':
          return 'Reconnecting…'
        default:
          return 'Closed'
      }
    },
    connectionStatusColor() {
      switch (this.connectionState) {
        case 'live':
          return 'success'
        case 'error':
          return 'error'
        case 'connecting':
          return 'info'
        default:
          return 'grey'
      }
    }
  },
  watch: {
    modelValue: {
      immediate: true,
      handler (newValue: boolean) {
        if (newValue) {
          this.disconnect()
          this.connectionState = 'connecting'
          this.output = 'Connecting to console output...'
        } else {
          this.disconnect()
        }
      }
    }
  },
  beforeUnmount() {
    this.disconnect()
  },
  methods: {
    clear() {
      this.output = ''
    },
    close() {
      this.isShown = false
    },
    disconnect() {
      this.liveSource?.close()
      this.liveSource = null
      this.connectionState = 'closed'
    },
    appendOutput(message: string) {
      this.output += `${this.output ? '\n' : ''}${message}`
      if (this.scrollPending) return

      this.scrollPending = true
      this.$nextTick(() => {
        this.scrollPending = false
        const container = this.$refs.consoleContainer
        if (container instanceof HTMLElement) {
          container.scrollTop = container.scrollHeight
        }
      })
    },
    attach() {
      if (!this.modelValue) return

      this.liveSource?.close()
      this.liveSource = new EventSource('/_api/logging/live')
      const source = this.liveSource
      this.liveSource.onopen = () => {
        if (this.liveSource === source) this.connectionState = 'live'
      }
      this.liveSource.onmessage = (event: MessageEvent<string>) => {
        if (this.liveSource !== source) return
        try {
          const item = JSON.parse(event.data) as { level?: unknown, output?: unknown }
          const level = typeof item.level === 'string' ? item.level : 'log'
          const message = typeof item.output === 'string' ? item.output : event.data
          this.appendOutput(`${level}: ${message}`)
        } catch {
          this.appendOutput(event.data)
        }
      }
      this.liveSource.onerror = () => {
        if (this.liveSource !== source) return
        const wasAlreadyReconnecting = this.connectionState === 'error'
        this.connectionState = 'error'
        if (!wasAlreadyReconnecting) {
          wikiStore.showNotification({
            style: 'red',
            message: 'Live console connection failed.',
            icon: 'warning'
          })
        }
      }
    }
  }
}
</script>

<style lang='scss'>
.logging-console {
  display: flex;
  max-height: calc(100dvh - 2rem);
  overflow: hidden;
  flex-direction: column;
}

.dialog-header {
  display: flex;
  align-items: center;
  gap: .75rem;
  min-width: 0;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid rgba(var(--v-border-color), .14);
  background: rgb(var(--v-theme-surface));
}

.consoleTerm {
  flex: 1 1 auto;
  min-height: min(24rem, 55dvh);
  max-height: calc(100dvh - 10rem);
  padding: 1rem 1.25rem;
  margin: 0;
  overflow: auto;
  border-bottom: 1px solid rgba(var(--v-border-color), .14);
  background: color-mix(in srgb, rgb(var(--v-theme-background)) 88%, #000);
  color: rgb(var(--v-theme-on-background));
  font-family: 'Roboto Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .8125rem;
  line-height: 1.5;
  white-space: pre;
}

.logging-console-actions {
  flex: 0 0 auto;
  justify-content: flex-end;
  gap: .5rem;
  padding: .75rem 1.25rem;
  background: rgb(var(--v-theme-surface));
}

@media (max-width: 599.98px) {
  .dialog-header {
    padding: .75rem 1rem;
  }

  .consoleTerm {
    min-height: min(18rem, 52dvh);
    padding: .75rem 1rem;
  }

  .logging-console-actions {
    padding: .625rem 1rem;
  }
}

</style>
