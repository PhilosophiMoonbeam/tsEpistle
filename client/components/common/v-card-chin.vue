<template lang='pug'>
  .v-card-chin
    v-divider.my-0
    v-card-actions(:class='current.dark ? "bg-grey-darken-4" : "bg-grey-lighten-4"')
      slot
</template>

<script setup lang='ts'>
import { useTheme } from 'vuetify'

const { current } = useTheme()
</script>
