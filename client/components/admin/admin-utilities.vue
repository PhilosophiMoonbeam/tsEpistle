<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        AdminHero(
          :title='$t(`admin:utilities.title`)'
          :description='$t(`admin:utilities.subtitle`)'
          icon='/_assets/svg/icon-maintenance.svg'
          heading-id='admin-utilities-heading'
        )

      v-col(lg='3', cols='12')
        v-card.animated.fadeInUp
          v-toolbar(flat, color='primary', density="compact")
            .text-body-large {{$t('admin:utilities.tools')}}
          v-select.d-lg-none(
            label='Select utility'
            :items='tools'
            item-value='key'
            :item-title='toolTitle'
            :item-disabled='toolDisabled'
            v-model='selectedTool'
            variant='outlined'
            hide-details
            density='compact'
          )
          v-list.d-none.d-lg-block(lines="two", density="compact").py-0
            template(v-for='(tool, idx) in tools', :key='tool.key')
              v-list-item(
                @click='selectedTool = tool.key'
                :disabled='!tool.isAvailable'
                :active='selectedTool === tool.key'
                :aria-current='selectedTool === tool.key ? "page" : undefined'
              )
                template(v-slot:prepend)
                  v-avatar
                    v-icon(:color='!tool.isAvailable ? `grey-lighten-1` : (selectedTool === tool.key ? `primary` : `grey-darken-1`)') {{ tool.icon }}
                v-list-item-title.text-body-medium(:class='!tool.isAvailable ? `text-grey` : (selectedTool === tool.key ? `text-primary` : ``)') {{ $t('admin:utilities.' + tool.i18nKey + 'Title') }}
                v-list-item-subtitle: .text-body-small(:class='!tool.isAvailable ? `text-grey-lighten-1` : (selectedTool === tool.key ? `text-primary` : ``)') {{ $t('admin:utilities.' + tool.i18nKey + 'Subtitle') }}
                template(v-slot:append)
                  v-avatar(v-if='selectedTool === tool.key')
                    v-icon.animated.fadeInLeft(color='primary', size="large") mdi-chevron-right
              v-divider(v-if='idx < tools.length - 1')

      v-col.animated.fadeInUp.wait-p2s(cols='12', lg='9')
        transition(name='admin-router')
          component(:is='selectedTool')
</template>

<script lang='ts'>

export default {
  components: {
    UtilityAuth: () => import('./admin-utilities-auth.vue'),
    UtilityContent: () => import('./admin-utilities-content.vue'),
    UtilityCache: () => import('./admin-utilities-cache.vue'),
    UtilityExport: () => import('./admin-utilities-export.vue'),
    UtilityImportv1: () => import('./admin-utilities-importv1.vue'),
    UtilityTelemetry: () => import('./admin-utilities-telemetry.vue')
  },
  data() {
    return {
      selectedTool: 'UtilityAuth',
      tools: [
        {
          key: 'UtilityAuth',
          icon: 'mdi-lock-open-outline',
          i18nKey: 'auth',
          isAvailable: true
        },
        {
          key: 'UtilityContent',
          icon: 'mdi-content-duplicate',
          i18nKey: 'content',
          isAvailable: true
        },
        {
          key: 'UtilityExport',
          icon: 'mdi-database-export',
          i18nKey: 'export',
          isAvailable: true
        },
        {
          key: 'UtilityCache',
          icon: 'mdi-database-refresh',
          i18nKey: 'cache',
          isAvailable: true
        },
        // {
        //   key: 'UtilityGraphEndpoint',
        //   icon: 'mdi-graphql',
        //   i18nKey: 'graphEndpoint',
        //   isAvailable: false
        // },
        {
          key: 'UtilityImportv1',
          icon: 'mdi-database-import',
          i18nKey: 'importv1',
          isAvailable: true
        },
        {
          key: 'UtilityTelemetry',
          icon: 'mdi-math-compass',
          i18nKey: 'telemetry',
          isAvailable: true
        }
      ]
    }
  },
  methods: {
    toolTitle(tool: { i18nKey: string }) {
      return this.$t(`admin:utilities.${tool.i18nKey}Title`)
    },
    toolDisabled(tool: { isAvailable: boolean }) {
      return !tool.isAvailable
    }
  }
}
</script>

<style lang='scss'>

</style>
