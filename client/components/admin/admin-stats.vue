<template lang='pug'>
  v-container(fluid)
    AdminHero(
      icon='mdi-chart-box-outline'
      title='Statistics'
      description='Useful information about your wiki'
      heading-id='admin-stats-title'
    )
    v-row.mt-4
      v-col(cols='12')
        async-state(
          state='empty'
          title='Statistics are not available'
          message='This statistics view is not connected to a data source yet.'
        )
</template>

<script setup lang='ts'>
import AsyncState from '@/components/common/async-state.vue'
</script>

