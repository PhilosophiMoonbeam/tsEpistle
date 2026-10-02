<template lang="pug">
  v-dialog(
    ref='dialog'
    :model-value='request !== null'
    max-width='460'
    :aria-labelledby='request ? `confirm-dialog-title-${request.id}` : undefined'
    :aria-describedby='request && request.message ? `confirm-dialog-message-${request.id}` : undefined'
    @update:model-value='onModel'
    @after-leave='restoreFocus'
  )
    v-card.confirm-dialog(v-if='request', :key='request.id')
      v-card-title.confirm-dialog__title(:id='`confirm-dialog-title-${request.id}`')
        v-icon.confirm-dialog__icon(
          :icon='request.tone === `destructive` ? `mdi-alert-outline` : `mdi-help-circle-outline`'
          size='20'
          aria-hidden='true'
        )
        span {{ request.title }}
      v-card-text.confirm-dialog__message(v-if='request.message', :id='`confirm-dialog-message-${request.id}`') {{ request.message }}
      v-card-actions.confirm-dialog__actions
        v-spacer
        v-btn.confirm-dialog__cancel(variant='text', @click='answer(false)') {{ request.cancelLabel || cancelDefault }}
        v-btn.confirm-dialog__confirm(
          :color='request.tone === `destructive` ? `error` : `primary`'
          variant='flat'
          @click='answer(true)'
        ) {{ request.confirmLabel || confirmDefault }}
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { currentConfirmation, registerConfirmationHost, settleConfirmation } from './confirm-dialog.ts'
import type { PendingConfirmation } from './confirm-dialog.ts'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** Mount once per shell. Shows queued requestConfirmation() calls one at a time. */
export default defineComponent({
  data () {
    return {
      unregister: null as (() => void) | null,
      returnFocusTo: null as HTMLElement | null
    }
  },
  computed: {
    request (): PendingConfirmation | null {
      return currentConfirmation()
    },
    cancelDefault (): string {
      return this.translate('common:confirm.keepEditing', 'Keep editing')
    },
    confirmDefault (): string {
      return this.translate('common:confirm.discard', 'Discard')
    }
  },
  watch: {
    async request (request: PendingConfirmation | null, previous: PendingConfirmation | null) {
      if (!request) return
      this.returnFocusTo = null
      // Queued cards replace one another without re-entering VDialog. Keep
      // focus in the next card rather than on the removed action button.
      if (!previous) return
      await this.$nextTick()
      const dialog = this.$refs.dialog as { contentEl?: HTMLElement; globalTop?: boolean } | undefined
      if (this.request?.id === request.id && dialog?.globalTop && !dialog.contentEl?.contains(dialog.contentEl.ownerDocument.activeElement)) {
        dialog.contentEl?.focus({ preventScroll: true })
      }
    }
  },
  mounted () {
    this.unregister = registerConfirmationHost()
  },
  beforeUnmount () {
    this.returnFocusTo = null
    this.unregister?.()
    this.unregister = null
  },
  methods: {
    translate (key: string, fallback: string): string {
      const translate = (this as unknown as { $t?: Translate }).$t
      return typeof translate === 'function' ? translate(key, { defaultValue: fallback }) : fallback
    },
    answer (confirmed: boolean): void {
      if (!this.request) return
      this.returnFocusTo = confirmed ? null : this.request.returnFocusTo
      settleConfirmation(this.request.id, confirmed)
    },
    onModel (open: boolean): void {
      if (!open) this.answer(false)
    },
    restoreFocus (): void {
      const target = this.returnFocusTo
      this.returnFocusTo = null
      // Acceptance lets the caller navigate/focus its destination. Cancellation
      // waits for Vuetify's leave transition and never jumps behind a queued or
      // newly opened dialog, or back into a parent dialog that has also closed.
      if (this.request || !this.unregister || !target?.isConnected || target.matches(':disabled') ||
          target.closest('[inert], [aria-hidden="true"], .v-overlay:not(.v-overlay--active)')) return
      const document = target.ownerDocument
      const focusedOverlay = document.activeElement?.closest('.v-overlay--active')
      if (focusedOverlay && !focusedOverlay.contains(target)) return
      let topDialog: HTMLElement | null = null
      for (const dialog of document.querySelectorAll<HTMLElement>('.v-dialog.v-overlay--active')) {
        if (!topDialog || Number(dialog.style.zIndex) >= Number(topDialog.style.zIndex)) topDialog = dialog
      }
      if (topDialog && !topDialog.contains(target)) return
      target.focus({ preventScroll: true })
    }
  }
})
</script>

<style lang="scss">
.confirm-dialog {
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--wiki-panel-radius) !important;
  background: var(--wiki-surface-raised) !important;
  box-shadow: var(--wiki-shadow-lg) !important;

  &__title {
    display: flex;
    align-items: flex-start;
    gap: var(--wiki-space-3);
    padding: var(--wiki-space-5) var(--wiki-space-5) var(--wiki-space-2) !important;
    font-size: 1rem !important;
    font-weight: 680 !important;
    line-height: 1.4 !important;
    white-space: normal !important;
  }

  &__icon {
    flex: 0 0 auto;
    margin-top: .1rem;
    color: var(--wiki-text-muted);
  }

  &__message {
    padding: 0 var(--wiki-space-5) var(--wiki-space-2) calc(var(--wiki-space-5) + 20px + var(--wiki-space-3)) !important;
    color: var(--wiki-text-muted) !important;
    font-size: .875rem !important;
    line-height: 1.55 !important;
  }

  &__actions {
    gap: var(--wiki-space-2);
    padding: var(--wiki-space-3) var(--wiki-space-5) var(--wiki-space-4) !important;

    .v-btn {
      min-height: var(--wiki-control-height);
      border-radius: var(--wiki-control-radius);
      font-weight: 650;
      text-transform: none;
    }
  }
}
</style>
