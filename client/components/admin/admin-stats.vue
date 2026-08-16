<template lang='pug'>
  v-container(fluid, fill-height)
    v-row
      v-col(cols='12')
        .admin-header-icon: v-icon(size='80', color="grey-lighten-2") show_chart
        .text-headline-medium.text-primary Statistics
        .text-body-large.text-grey Useful information about your wiki
        .pa-3
          fingerprint-spinner(
            :animation-duration='1500'
            :size='128'
            color='#e91e63'
            )
          .text-body-small.text-pink.mt-3 Compiling latest data...
</template>

<script lang='ts'>
import { FingerprintSpinner } from 'epic-spinners'

export default {
  components: {
    FingerprintSpinner
  },
  data() {
    return {}
  }
}
</script>

<style lang='scss'>

</style>
