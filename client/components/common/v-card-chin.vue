<template lang='pug'>
  div
    v-divider.my-0
    v-card-actions(:class='$vuetify.theme.current.dark ? "bg-grey-darken-4" : "bg-grey-lighten-4"')
      slot
</template>

<script lang='ts'>
export default { }
</script>
