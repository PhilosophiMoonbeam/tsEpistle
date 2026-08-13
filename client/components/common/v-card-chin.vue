<template lang='pug'>
  div
    v-divider.my-0
    v-card-actions(:class='$vuetify.theme.current.dark ? "grey darken-4-l5" : "grey lighten-4"')
      slot
</template>

<script lang='ts'>
export default { }
</script>
