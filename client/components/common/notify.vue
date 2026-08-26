<template lang='pug'>
  v-snackbar.nav-notify(
    :color='notification.style'
    location='bottom center'
    min-height='60'
    v-model='notificationState'
    :timeout='6000'
    )
    .nav-notify-content
      v-icon(size='21') mdi-{{ notification.icon }}
      span {{ notification.message }}
</template>

<script lang='ts'>
import { wikiStore, type Notification } from '@/store/index.ts'

export default {
  data() {
    return { }
  },
  computed: {
    notification(): Notification { return wikiStore.notification },
    notificationState: {
      get(): boolean { return wikiStore.notification.isActive },
      set(value: boolean) { wikiStore.notification.isActive = value }
    }
  }
}
</script>

<style lang='scss'>
.nav-notify {
  margin-bottom: calc(var(--wiki-footer-height) + 12px);

  .v-snackbar__wrapper {
    position: relative;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, .18);
    border-radius: 14px;
    box-shadow: 0 18px 48px rgba(3, 7, 18, .26);

    &::after {
      position: absolute;
      bottom: 0;
      left: 0;
      display: block;
      width: 100%;
      height: 2px;
      background-color: rgba(255, 255, 255, .46);
      animation: nav-notify-anim 6s linear;
      content: '';
    }
  }
}

.nav-notify-content {
  display: flex;
  align-items: center;
  gap: 11px;
  font-weight: 600;
  line-height: 1.4;
}

@keyframes nav-notify-anim {
  from {
    width: 100%;
  }

  to {
    width: 0;
  }
}

@media (max-width: 599px) {
  .nav-notify {
    margin-inline: 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .nav-notify .v-snackbar__wrapper::after {
    animation: none;
  }
}
</style>
