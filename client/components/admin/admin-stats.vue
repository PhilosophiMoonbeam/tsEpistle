<template lang='pug'>
  v-container(fluid)
    AdminHero(
      icon='mdi-chart-box-outline'
      :title='$t(`admin:stats.title`)'
      :description='$t(`admin:stats.usefulInformationAboutWiki`)'
      heading-id='admin-stats-title'
    )
    v-row
      v-col(cols='12')
        async-state(
          state='empty'
          :title='$t(`admin:stats.statisticsNotAvailable`)'
          :message='$t(`admin:stats.statisticsViewNotConnected`)'
        )
</template>

<script setup lang='ts'>
import AsyncState from '@/components/common/async-state.vue'
</script>

