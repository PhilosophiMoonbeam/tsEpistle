<template lang='pug'>
  v-card-actions.v-card-chin(:class='current.dark ? "bg-grey-darken-4" : "bg-grey-lighten-4"')
    slot
</template>

<script setup lang='ts'>
import { useTheme } from 'vuetify'

const { current } = useTheme()
</script>

<style scoped>
.v-card-chin {
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
</style>
