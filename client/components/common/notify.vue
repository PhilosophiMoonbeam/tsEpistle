<template lang='pug'>
  v-snackbar.nav-notify(
    :key='notificationRevision'
    :color='notificationColor'
    location='bottom center'
    min-height='60'
    v-model='notificationState'
    :timeout='notificationTimeout'
    :timer='notificationTimeout > 0 ? "bottom" : false'
    :timer-color='notificationTimerColor'
  )
    .nav-notify-content
      v-icon.nav-notify-icon(:icon='notificationIcon' size='21' aria-hidden='true')
      span.nav-notify-message {{ notification.message }}
      v-btn.nav-notify-close(
        icon='mdi-close'
        variant='text'
        size='small'
        :aria-label='$t(`common:actions.close`)'
        @click='dismissNotification'
      )
</template>

<script lang='ts'>
import { wikiStore, type Notification } from '@/store/index.ts'

type NotificationKind = 'success' | 'error' | 'info' | 'progress'

export default {
  data() {
    return {
      notificationRevision: 0
    }
  },
  computed: {
    notification(): Notification { return wikiStore.notification },
    notificationState: {
      get(): boolean { return wikiStore.notification.isActive },
      set(value: boolean) { wikiStore.setNotificationActive(value) }
    },
    notificationKind(): NotificationKind {
      const style = this.notification.style.toLowerCase()
      if (style === 'error' || style === 'red' || style === 'danger') return 'error'
      if (style === 'success' || style === 'green') return 'success'
      if (style === 'progress' || style === 'loading') return 'progress'
      return 'info'
    },
    notificationColor(): string {
      switch (this.notificationKind) {
        case 'success': return 'success'
        case 'error': return 'error'
        case 'progress': return 'primary'
        default: return 'surface-variant'
      }
    },
    notificationTimerColor(): string {
      return this.notificationKind === 'success' ? 'on-success' : 'on-surface-variant'
    },
    notificationIcon(): string {
      switch (this.notificationKind) {
        case 'success': return 'mdi-check-circle-outline'
        case 'error': return 'mdi-alert-circle-outline'
        case 'progress': return 'mdi-progress-clock'
        default: return 'mdi-information-outline'
      }
    },
    notificationTimeout(): number {
      return this.notificationKind === 'error' || this.notificationKind === 'progress' ? -1 : 6000
    }
  },
  watch: {
    notification(): void {
      this.notificationRevision += 1
    }
  },
  methods: {
    dismissNotification(): void {
      this.notificationState = false
    }
  }
}
</script>

<style lang='scss'>
.nav-notify {
  margin-bottom: calc(var(--wiki-footer-height) + 12px + env(safe-area-inset-bottom));

  .v-snackbar__wrapper {
    position: relative;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 18%, transparent);
    border-radius: var(--wiki-panel-radius, 14px);
    box-shadow: 0 18px 48px color-mix(in srgb, rgb(var(--v-theme-on-surface)) 26%, transparent);
  }

  .v-snackbar__timer .v-progress-linear {
    --v-progress-linear-height: 2px;
    opacity: .46;
  }

}

.nav-notify-content {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 11px;
  font-weight: 600;
  line-height: 1.4;
}

.nav-notify-icon {
  flex: 0 0 auto;
}

.nav-notify-message {
  min-width: 0;
  overflow-wrap: anywhere;
}

.nav-notify-close {
  flex: 0 0 auto;
  margin-inline-start: auto;
}


@media (max-width: 599px) {
  .nav-notify {
    margin-inline: 12px;
  }

  .nav-notify-content {
    align-items: flex-start;
  }
}

@media (prefers-reduced-motion: reduce) {
  .nav-notify .v-snackbar__timer {
    display: none;
  }
}
</style>
