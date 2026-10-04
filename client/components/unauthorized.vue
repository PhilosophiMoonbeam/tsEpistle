<template lang='pug'>
  v-app.unauthorized-app
    nav-header
    v-main
      main.workbench-state(aria-labelledby='unauthorized-title')
        .workbench-state-panel
          header.workbench-state-context
            v-icon(size='28', aria-hidden='true') mdi-shield-lock-outline
            h1#unauthorized-title.text-headline-medium.ma-0 {{$t('unauthorized.title')}}
            p.text-body-large {{$t('unauthorized.action.' + action)}}
          .workbench-state-actions(role='group', :aria-label='$t(`unauthorized.actions`)')
            //- Signed-in people switch accounts from the account menu instead.
            v-btn.workbench-state-action(
              v-if='showLogin'
              :href='loginHref'
              size='large'
              color='primary'
              variant='flat'
              prepend-icon='mdi-login'
            ) {{$t('unauthorized.login')}}
            v-btn.workbench-state-action(
              size='large'
              color='primary'
              :variant='showLogin ? `outlined` : `flat`'
              :prepend-icon='$vuetify.locale.isRtl ? "mdi-arrow-right" : "mdi-arrow-left"'
              @click='goBack'
            ) {{$t('unauthorized.goback')}}
            v-btn.workbench-state-action(
              href='/'
              size='large'
              color='primary'
              variant='outlined'
              prepend-icon='mdi-home-outline'
            ) {{$t('unauthorized.gohome')}}
    search-results
</template>

<script setup lang='ts'>
import { computed } from 'vue'
import { goBackOrHome } from '../helpers/state-page-actions'
import { wikiStore } from '../store/index.ts'

const {
  action = 'view'
} = defineProps<{
  action?: string
}>()

// Wait for the session check so signed-in people never see a stray Log in.
const showLogin = computed(() => wikiStore.authRefreshSettled === true && wikiStore.user.authenticated !== true)
const loginHref = '/login'

const goBack = (): void => goBackOrHome('/')
</script>
