<template lang='pug'>
  .v-card-info(:class='`is-` + color')
    v-card-text.d-flex.align-center(:class='colors.cls')
      v-icon(:color='colors.icon', start) {{icon}}
      slot
</template>

<script lang='ts'>
export default {
  props: {
    color: {
      type: String,
      default: 'blue'
    },
    icon: {
      type: String,
      default: 'mdi-information-outline'
    }
  },
  computed: {
    colors () {
      switch (this.color) {
        case 'blue':
          return {
            cls: this.$vuetify.theme.current.dark ? 'bg-grey-darken-4 text-blue-lighten-4' : 'bg-blue-lighten-5 text-blue-darken-3',
            icon: 'blue-lighten-3'
          }
        case 'red':
          return {
            cls: this.$vuetify.theme.current.dark ? 'bg-grey-darken-4 text-red-lighten-4' : 'bg-red-lighten-5 text-red-darken-2',
            icon: 'red-lighten-3'
          }
        default:
          return {
            cls: this.$vuetify.theme.current.dark ? 'bg-grey-darken-4' : 'bg-grey-lighten-4',
            icon: 'grey-darken-2'
          }
      }
    }
  }
}
</script>

<style lang="scss">
.v-card-info {
  border-bottom: 1px solid #EEE;

  &.is-blue {
    border-bottom-color: mc('blue', '100');

    @at-root .v-theme--dark & {
      border-bottom-color: rgba(mc('blue', '100'), .3);
    }
  }

  &.is-red {
    border-bottom-color: mc('red', '100');

    @at-root .v-theme--dark & {
      border-bottom-color: rgba(mc('red', '100'), .3);
    }
  }
}
</style>
