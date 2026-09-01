<template lang='pug'>
  v-toolbar.duration-picker.radius-7(
    flat
    color='surface-variant'
    role='group'
    :aria-label='$t("common:duration.every")'
  )
    .duration-picker__every.text-body-medium {{$t('common:duration.every')}}
    .duration-picker__fields
      .duration-picker__field
        v-text-field(
          variant="solo"
          hide-details
          flat
          reverse
          type="number"
          inputmode="numeric"
          min="0"
          step="1"
          :label='$t("common:duration.minutes")'
          v-model='minutes'
          )
        .duration-picker__unit(aria-hidden="true") {{$t('common:duration.minutes')}}
      .duration-picker__field
        v-text-field(
          variant="solo"
          hide-details
          flat
          reverse
          type="number"
          inputmode="numeric"
          min="0"
          step="1"
          :label='$t("common:duration.hours")'
          v-model='hours'
          )
        .duration-picker__unit(aria-hidden="true") {{$t('common:duration.hours')}}
      .duration-picker__field
        v-text-field(
          variant="solo"
          hide-details
          flat
          reverse
          type="number"
          inputmode="numeric"
          min="0"
          step="1"
          :label='$t("common:duration.days")'
          v-model='days'
          )
        .duration-picker__unit(aria-hidden="true") {{$t('common:duration.days')}}
      .duration-picker__field
        v-text-field(
          variant="solo"
          hide-details
          flat
          reverse
          type="number"
          inputmode="numeric"
          min="0"
          step="1"
          :label='$t("common:duration.months")'
          v-model='months'
          )
        .duration-picker__unit(aria-hidden="true") {{$t('common:duration.months')}}
      .duration-picker__field
        v-text-field(
          variant="solo"
          hide-details
          flat
          reverse
          type="number"
          inputmode="numeric"
          min="0"
          step="1"
          :label='$t("common:duration.years")'
          v-model='years'
          )
        .duration-picker__unit(aria-hidden="true") {{$t('common:duration.years')}}

</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import moment from 'moment'

type DurationUnit = 'minutes' | 'hours' | 'days' | 'months' | 'years'

function parseDurationUnit (value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null
  const numericValue = Number(value)
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : null
}

export default defineComponent({
  emits: ['update:modelValue'],
  props: {
    modelValue: {
      type: String,
      default: 'PT5M'
    }
  },
  data() {
    return {
      duration: moment.duration(this.modelValue)
    }
  },
  computed: {
    years: {
      get() { return this.duration.years() || 0 },
      set(val: string | number) {
        const numericValue = parseDurationUnit(val)
        if (numericValue === null) return
        this.rebuild(numericValue, 'years')
      }
    },
    months: {
      get() { return this.duration.months() || 0 },
      set(val: string | number) {
        const numericValue = parseDurationUnit(val)
        if (numericValue === null) return
        this.rebuild(numericValue, 'months')
      }
    },
    days: {
      get() { return this.duration.days() || 0 },
      set(val: string | number) {
        const numericValue = parseDurationUnit(val)
        if (numericValue === null) return
        this.rebuild(numericValue, 'days')
      }
    },
    hours: {
      get() { return this.duration.hours() || 0 },
      set(val: string | number) {
        const numericValue = parseDurationUnit(val)
        if (numericValue === null) return
        this.rebuild(numericValue, 'hours')
      }
    },
    minutes: {
      get() { return this.duration.minutes() || 0 },
      set(val: string | number) {
        const numericValue = parseDurationUnit(val)
        if (numericValue === null) return
        this.rebuild(numericValue, 'minutes')
      }
    }
  },
  watch: {
    modelValue(newValue: string) {
      this.duration = moment.duration(newValue)
    }
  },
  methods: {
    rebuild(val: number, unit: DurationUnit) {
      if (!Number.isFinite(val) || val < 0) return
      const newDuration = {
        minutes: this.duration.minutes(),
        hours: this.duration.hours(),
        days: this.duration.days(),
        months: this.duration.months(),
        years: this.duration.years()
      }
      newDuration[unit] = val
      this.duration = moment.duration(newDuration)
      this.$emit('update:modelValue', this.duration.toISOString())
    }
  }
})
</script>

<style lang='scss'>
.duration-picker {
  height: auto !important;
  min-height: 64px;
  padding: 12px 16px;
  align-items: center;
  background: rgb(var(--v-theme-surface-variant)) !important;
}

.duration-picker__every {
  flex: 0 0 auto;
  margin-inline-end: 12px;
}

.duration-picker__fields {
  min-width: 0;
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
}

.duration-picker__field {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.duration-picker__field .v-input {
  min-width: 0;
  flex: 1 1 auto;
}

.duration-picker__unit {
  flex: 0 0 auto;
  color: rgba(var(--v-theme-on-surface), .72);
}

@media (max-width: 600px) {
  .duration-picker {
    align-items: stretch;
    flex-wrap: wrap;
  }

  .duration-picker__every {
    flex-basis: 100%;
    margin-block-end: 8px;
  }

  .duration-picker__fields {
    flex-basis: 100%;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px 12px;
  }

  .duration-picker__field {
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
  }

  .duration-picker__field .v-input {
    width: 100%;
  }
}
</style>
