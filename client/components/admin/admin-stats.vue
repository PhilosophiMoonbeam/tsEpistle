<template lang='pug'>
  v-container.fill-height.d-flex.align-center.flex-wrap(fluid)
    v-row
      v-col(cols='12')
        .admin-header-icon: v-icon(size='80', color='primary') mdi-chart-box-outline
        .text-headline-medium.text-primary Statistics
        .text-body-large.text-medium-emphasis Useful information about your wiki
        async-state(
          state='empty'
          title='Statistics are not available'
          message='This statistics view is not connected to a data source yet.'
        )
</template>

<script lang='ts'>
import AsyncState from '@/components/common/async-state.vue'

export default {
  components: {
    AsyncState
  }
}
</script>

