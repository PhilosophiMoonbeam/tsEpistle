<template>
  <div class="security-duration">
    <v-text-field
      :model-value="modelValue / unit"
      :label="label"
      type="number"
      min="0"
      step="any"
      variant="outlined"
      :disabled="disabled"
      :hint="hint"
      persistent-hint
      @update:model-value="update"
    /><v-select
      v-model="unit"
      :items="units"
      :label="$t('admin:securityDuration.unit', { label, interpolation: { escapeValue: false } })"
      variant="outlined"
      :disabled="disabled"
    />
  </div>
</template>
<script lang="ts">
export default {
  props: {
    modelValue: { type: Number, required: true },
    label: { type: String, required: true },
    hint: String,
    disabled: Boolean
  },
  emits: ['update:modelValue'],
  data() {
    return {
      unit: 1,
      units: [
        { title: this.$t('admin:securityDuration.seconds'), value: 1 },
        { title: this.$t('admin:securityDuration.minutes'), value: 60 },
        { title: this.$t('admin:securityDuration.hours'), value: 3600 },
        { title: this.$t('admin:securityDuration.days'), value: 86400 }
      ]
    }
  },
  created() {
    this.unit =
      [86400, 3600, 60].find(
        (unit) => this.modelValue > 0 && this.modelValue % unit === 0
      ) ?? 1
  },
  methods: {
    update(value: string) {
      if (!this.disabled)
        this.$emit('update:modelValue', Number(value) * this.unit)
    }
  }
}
</script>
