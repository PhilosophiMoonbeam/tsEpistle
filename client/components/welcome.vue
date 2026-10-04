<template lang='pug'>
  v-app
    auth-shell.welcome(
      :title='$t(`welcome.title`)'
      heading-id='welcome-title'
      :eyebrow='siteTitle'
      :logo-url='logoUrl'
    )
      template(#lead)
        p {{ $t('welcome.subtitle') }}
      .welcome-actions
        v-btn(color='primary', variant='flat', size='large', :href='`/e/` + locale + `/home`', prepend-icon='mdi-plus') {{ $t('welcome.createhome') }}
        v-btn(color='primary', variant='outlined', size='large', href='/a', prepend-icon='mdi-shield-crown-outline') {{ $t('welcome.goadmin') }}
</template>

<script setup lang='ts'>
import { computed } from 'vue'
import { wikiStore } from '@/store/index.ts'
import AuthShell from './common/auth-shell.vue'

const {
  locale = 'en'
} = defineProps<{
  locale?: string
}>()

const logoUrl = computed(() => wikiStore.site.logoUrl)
const siteTitle = computed(() => wikiStore.site.title)
</script>

<style lang='scss'>
.welcome-actions {
  display: grid;
  gap: var(--wiki-space-3);
  margin-top: var(--wiki-space-2);

  .v-btn {
    min-height: var(--wiki-control-height);
    border-radius: var(--wiki-control-radius);
    font-weight: 680;
    text-transform: none;
  }
}
</style>
