<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-row()
      v-col(cols='12')
        .admin-header
          img(src='/_assets/svg/icon-maintenance.svg', alt='Utilities', style='width: 80px;')
          .admin-header-title
            .headline.primary--text {{$t('admin:utilities.title')}}
            .subtitle-1.grey--text {{$t('admin:utilities.subtitle')}}

      v-col(lg='3', cols='12')
        v-card.animated.fadeInUp
          v-toolbar(flat, color='primary', dark, dense)
            .subtitle-1 {{$t('admin:utilities.tools')}}
          v-list(two-line, dense).py-0
            template(v-for='(tool, idx) in tools', :key='tool.key')
              v-list-item(@click='selectedTool = tool.key', :disabled='!tool.isAvailable')
                v-avatar
                  v-icon(:color='!tool.isAvailable ? `grey lighten-1` : (selectedTool === tool.key ? `blue ` : `grey darken-1`)') {{ tool.icon }}
                div.v-list-item-content
                  v-list-item-title.body-2(:class='!tool.isAvailable ? `grey--text` : (selectedTool === tool.key ? `primary--text` : ``)') {{ $t('admin:utilities.' + tool.i18nKey + 'Title') }}
                  v-list-item-subtitle: .caption(:class='!tool.isAvailable ? `grey--text text--lighten-1` : (selectedTool === tool.key ? `blue--text ` : ``)') {{ $t('admin:utilities.' + tool.i18nKey + 'Subtitle') }}
                v-avatar(v-if='selectedTool === tool.key')
                  v-icon.animated.fadeInLeft(color='primary', large) mdi-chevron-right
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
  }
}
</script>

<style lang='scss'>

</style>
