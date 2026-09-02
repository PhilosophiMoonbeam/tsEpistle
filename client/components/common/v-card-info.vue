<template lang='pug'>
  .v-card-info(:class='`v-card-info--` + color')
    v-card-text.d-flex.align-center
      v-icon(:icon='icon', :color='color', start)
      slot
</template>

<script lang='ts'>
export default {
  props: {
    color: {
      type: String,
      default: 'info',
      validator: (value: string) => value === 'info' || value === 'error'
    },
    icon: {
      type: String,
      default: 'mdi-information-outline'
    }
  },
}
</script>

<style lang="scss">
.v-card-info {
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

  .v-card-text {
    color: rgb(var(--v-theme-on-surface));
  }

  &--info {
    border-bottom-color: color-mix(in srgb, rgb(var(--v-theme-info)) 32%, transparent);

    .v-card-text {
      background: color-mix(in srgb, rgb(var(--v-theme-info)) 12%, rgb(var(--v-theme-surface)));
    }
  }

  &--error {
    border-bottom-color: color-mix(in srgb, rgb(var(--v-theme-error)) 32%, transparent);

    .v-card-text {
      background: color-mix(in srgb, rgb(var(--v-theme-error)) 12%, rgb(var(--v-theme-surface)));
    }
  }
}
</style>
