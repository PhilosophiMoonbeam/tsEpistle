<template lang='pug'>
  v-app
    auth-shell.welcome(
      :title='siteTitle'
      :form-title='$t(`welcome.title`)'
      heading-id='welcome-title'
      :logo-url='logoUrl'
    )
      template(#lead)
        p {{ $t('welcome.subtitle') }}
      nav.welcome-actions(:aria-label='$t(`welcome.title`)')
        v-btn(color='primary', variant='flat', size='large', :href='`/e/` + locale + `/home`', prepend-icon='mdi-plus', block) {{ $t('welcome.createhome') }}
        v-btn(color='primary', variant='outlined', size='large', href='/a', prepend-icon='mdi-shield-crown-outline', block) {{ $t('welcome.goadmin') }}
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
  gap: var(--wiki-space-4);
  margin-top: var(--wiki-space-6);
  padding-top: var(--wiki-space-5);
  border-top: 1px solid var(--wiki-surface-border);

  .v-btn {
    min-height: var(--wiki-control-height);
    border-radius: var(--wiki-control-radius);
    padding-block: var(--wiki-space-3);
    font-weight: 680;
    text-transform: none;

    &.v-btn--variant-outlined {
      color: var(--wiki-accent-ink);
    }
  }
}
</style>
