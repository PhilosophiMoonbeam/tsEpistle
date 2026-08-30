<template lang='pug'>
  v-dialog(v-model='isShown', width='calc(100vw - 2rem)', max-width='1200')
    v-card.logging-console
      .dialog-header
        .text-title-large Live Console
        v-spacer
        v-chip(
          size='small'
          variant='tonal'
          :color='connectionStatusColor'
          :aria-label='connectionStatusLabel'
        )
          v-progress-circular(
            v-if='connectionState === "connecting" || connectionState === "error"'
            indeterminate
            :color='connectionStatusColor'
            :size='14'
            :width='2'
          )
          span {{ connectionStatusLabel }}
      pre.consoleTerm(ref='consoleContainer', :aria-label='`Live console output: ${connectionStatusLabel}`') {{output}}
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
  data() {
    return {
      liveSource: null as EventSource | null,
      output: '',
      connectionState: 'closed' as 'closed' | 'connecting' | 'live' | 'error'
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
    modelValue(newValue: boolean) {
      if (newValue) {
        this.connectionState = 'connecting'
        setTimeout(() => {
          if (this.modelValue) {
            this.output = 'Connecting to console output...'
            this.attach()
          }
        }, 100)
      } else {
        this.liveSource?.close()
        this.liveSource = null
        this.connectionState = 'closed'
      }
    }
  },
  beforeUnmount() {
    this.liveSource?.close()
    this.connectionState = 'closed'
  },
  methods: {
    clear() {
      this.output = ''
    },
    close() {
      this.isShown = false
    },
    attach() {
      this.liveSource?.close()
      this.liveSource = new EventSource('/_api/logging/live')
      this.liveSource.onopen = () => {
        this.connectionState = 'live'
      }
      this.liveSource.onmessage = (event: MessageEvent<string>) => {
        try {
          const item = JSON.parse(event.data) as { level?: unknown, output?: unknown }
          const level = typeof item.level === 'string' ? item.level : 'log'
          const message = typeof item.output === 'string' ? item.output : event.data
          this.output += `${this.output ? '\n' : ''}${level}: ${message}`
          this.$nextTick(() => {
            const container = this.$refs.consoleContainer as HTMLElement
            container.scrollTop = container.scrollHeight
          })
        } catch {
          this.output += `${this.output ? '\n' : ''}${event.data}`
        }
      }
      this.liveSource.onerror = () => {
        this.connectionState = 'error'
        wikiStore.showNotification({
          style: 'red',
          message: 'Live console connection failed.',
          icon: 'warning'
        })
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
