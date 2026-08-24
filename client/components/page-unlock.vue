<template lang='pug'>
  v-app
    .page-unlock
      v-card.page-unlock-card(elevation='5', max-width='480')
        v-card-text.pa-8.text-center
          v-icon.mb-4(color='primary', size='64') mdi-lock-outline
          h1.text-headline-medium.mb-2 Protected page
          p.text-body-large.text-medium-emphasis.mb-6 Enter the page password to continue to {{ pageTitle }}.
          v-alert.mb-4(v-if='error', type='error', variant='tonal') {{ error }}
          form(:action='`/_unlock/${pageId}`', method='post')
            input(type='hidden', name='returnTo', :value='returnTo')
            v-text-field(
              name='password'
              type='password'
              label='Page password'
              autocomplete='current-password'
              autofocus
              required
              variant='outlined'
            )
            v-btn.mt-2(
              type='submit'
              color='primary'
              size='large'
              block
            ) Unlock page
</template>

<script lang='ts'>
import { defineComponent } from 'vue'

export default defineComponent({
  props: {
    pageId: {
      type: Number,
      required: true
    },
    pageTitle: {
      type: String,
      default: 'this page'
    },
    returnTo: {
      type: String,
      default: '/'
    },
    error: {
      type: String,
      default: ''
    }
  }
})
</script>

<style lang='scss' scoped>
.page-unlock {
  align-items: center;
  background: linear-gradient(145deg, #0d47a1, #4527a0);
  display: flex;
  justify-content: center;
  min-height: 100vh;
  min-height: 100dvh;
  padding: 24px;
}

.page-unlock-card {
  width: 100%;
}
</style>
