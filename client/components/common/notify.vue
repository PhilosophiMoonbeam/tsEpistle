<template lang='pug'>
  v-snackbar.nav-notify(
    :color='notification.style'
    location="top"
    min-height="68"
    v-model='notificationState'
    :timeout='6000'
    )
    .text-left
      v-icon.mr-3 mdi-{{ notification.icon }}
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
  top: -64px;
  padding-top: 0;
  z-index: 999;

  .v-snackbar__wrapper {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
    position: relative;
    margin-top: 0;

    &::after {
      content: '';
      display: block;
      width: 100%;
      height: 2px;
      background-color: rgba(255,255,255,.4);
      position: absolute;
      bottom: 0;
      left: 0;
      animation: nav-notify-anim 6s linear;
    }
  }
}

@keyframes nav-notify-anim {
  0% {
    width: 100%;
  }
  100% {
    width: 0%;
  }
}
</style>
