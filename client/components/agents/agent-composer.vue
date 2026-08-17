<template>
  <v-form class="agent-composer" @submit.prevent="submit">
    <v-textarea
      v-model="draft"
      label="Message Wiki Agent"
      placeholder="Ask about pages you can access"
      rows="2"
      max-rows="8"
      auto-grow
      counter="32000"
      :disabled="disabled"
      @keydown.enter.exact.prevent="submit"
      @keydown.ctrl.enter.prevent="submit"
      @keydown.meta.enter.prevent="submit"
    />
    <div class="agent-composer__actions d-flex align-center ga-2">
      <span class="agent-composer__hint text-body-small text-medium-emphasis">Enter to send · Shift+Enter for a new line</span>
      <v-spacer />
      <v-btn v-if="canStop" color="warning" variant="outlined" prepend-icon="mdi-stop" @click="$emit('stop')">Stop</v-btn>
      <v-btn type="submit" color="primary" prepend-icon="mdi-send" :loading="sending" :disabled="disabled || !draft.trim()">Send</v-btn>
    </div>
  </v-form>
</template>

<script setup lang="ts">
import { ref } from 'vue'
const props = defineProps<{ disabled: boolean; sending: boolean; canStop: boolean }>()
const emit = defineEmits<{ send: [content: string]; stop: [] }>()
const draft = ref('')
const submit = () => {
  if (props.disabled || !draft.value.trim()) return
  const content = draft.value
  draft.value = ''
  emit('send', content)
}
</script>

<style scoped>
.agent-composer__actions { flex-wrap: wrap; }
@media (max-width: 520px) {
  .agent-composer__hint { order: 2; text-align: center; width: 100%; }
}
</style>
