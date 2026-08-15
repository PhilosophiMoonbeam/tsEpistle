<template lang='pug'>
  v-dialog(v-model='isShown', width='90vw', max-width='1200')
    .dialog-header
      span Live Console
      v-spacer
      .caption.blue--text.text--lighten-3.mr-3 Streaming...
      v-progress-circular(
        indeterminate
        color='blue lighten-3'
        :size='20'
        :width='2'
        aria-label='Streaming logs'
        )
    pre.consoleTerm(ref='consoleContainer') {{output}}
    v-toolbar(flat, color='grey darken-3', dark)
      v-spacer
      v-btn(outline, @click='clear')
        v-icon(left) cancel_presentation
        span Clear
      v-btn(outline, @click='close')
        v-icon(left) close
        span Close
</template>

<script lang='ts'>
import { wikiStore } from '@/store/index.ts'
export default {
  emits: ['update:modelValue'],
  data() {
    return {
      liveSource: null as EventSource | null,
      output: ''
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
    }
  },
  watch: {
    modelValue(newValue: boolean) {
      if (newValue) {
        setTimeout(() => {
          this.output = 'Connecting to console output...'
          this.attach()
        }, 100)
      } else {
        this.liveSource?.close()
        this.liveSource = null
      }
    }
  },
  beforeUnmount() {
    this.liveSource?.close()
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

.consoleTerm {
  background-color: #000;
  padding: 16px;
  width: 100%;
  height: 415px;
  margin: 0;
  overflow: auto;
  color: #fff;
  white-space: pre-wrap;
}

</style>
