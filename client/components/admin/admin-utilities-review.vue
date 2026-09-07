<template lang="pug">
v-dialog(:model-value='open' max-width='620' :fullscreen='$vuetify.display.smAndDown' aria-labelledby='utility-review-title' @update:model-value='setOpen')
  v-card
    v-card-title#utility-review-title.text-wrap {{ title }}
    v-card-text
      .text-body-medium {{ effect }}
      dl.utility-review-parameters.mt-5(v-if='parameters.length' aria-label='Reviewed parameters')
        template(v-for='parameter in parameters' :key='parameter.label')
          dt {{ parameter.label }}
          dd {{ parameter.value }}
      v-alert.mt-4(v-if='uncertainReceipt' color='warning' variant='tonal' icon='mdi-alert-outline' role='alert')
        .text-body-medium A previous outcome is uncertain.
        .text-body-small.mt-1 {{ uncertainReceipt.summary }}
        .text-body-small.mt-1 Receipt ID: #[code {{ uncertainReceipt.id }}]
        v-checkbox.mt-2(v-model='acknowledged' label='I inspected this receipt and understand it will not be replayed.' hide-details :disabled='busy')
      v-alert.mt-4(v-if='submissionError' color='error' variant='tonal' role='alert') {{ submissionError }}
      v-textarea.mt-5(
        ref='reasonInput'
        v-model='reason'
        label='Administrative reason'
        hint='Recorded with the receipt. Do not include passwords, access tokens, private keys, connection strings, or server paths.'
        persistent-hint
        :counter='1000'
        maxlength='1000'
        :error-messages='reasonError'
        :disabled='busy'
        variant='outlined'
      )
      v-text-field.mt-4(
        v-model='confirmation'
        :label='`Type ${confirmText} to confirm`'
        :hint='`Exact confirmation: ${confirmText}`'
        persistent-hint
        :disabled='busy'
        variant='outlined'
        @keyup.enter='confirm'
      )
    v-card-actions
      v-btn(variant='text' @click='close') {{ busy ? 'Close review — request continues' : 'Cancel' }}
      v-spacer
      v-btn(color='primary' variant='flat' :loading='busy' :disabled='!ready' @click='confirm')
        template(#loader)
          v-progress-circular(indeterminate aria-label='Recording reviewed Utilities request')
        | Record and start
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import type { UtilityOperation } from '../../../shared/utilities-workspace.ts'

type ReviewedParameter = { label: string; value: string }

export default defineComponent({
  props: {
    open: { type: Boolean, required: true },
    title: { type: String, required: true },
    effect: { type: String, required: true },
    confirmText: { type: String, required: true },
    parameters: { type: Array as PropType<ReadonlyArray<ReviewedParameter>>, default: () => [] },
    submissionError: { type: String, default: '' },
    busy: { type: Boolean, default: false },
    uncertainReceipt: { type: Object as PropType<UtilityOperation | null>, default: null }
  },
  emits: ['update:open', 'confirm', 'dirty-state'],
  data: () => ({ reason: '', confirmation: '', acknowledged: false }),
  computed: {
    reasonError(): string {
      const length = this.reason.trim().length
      return !this.reason || length === 0
        ? ''
        : length < 3
          ? 'Enter a reason of at least 3 characters.'
          : length > 1000
            ? 'Keep the reason to 1000 characters or fewer.'
            : ''
    },
    ready(): boolean {
      const length = this.reason.trim().length
      return length >= 3 && length <= 1000 && this.confirmation === this.confirmText && (!this.uncertainReceipt || this.acknowledged)
    },
    dirty(): boolean {
      return this.open && Boolean(this.reason || this.confirmation || this.acknowledged)
    }
  },
  watch: {
    open(open: boolean) {
      if (!open) {
        this.$emit('dirty-state', false)
        return
      }
      this.reason = ''
      this.confirmation = ''
      this.acknowledged = false
      this.$nextTick(() => {
        const input = this.$refs.reasonInput as { focus?: () => void } | undefined
        input?.focus?.()
      })
    },
    dirty(dirty: boolean) {
      this.$emit('dirty-state', dirty)
    }
  },
  methods: {
    setOpen(open: boolean) {
      this.$emit('update:open', open)
    },
    close() {
      this.$emit('update:open', false)
    },
    confirm() {
      if (!this.ready) return
      this.$emit('confirm', { reason: this.reason.trim(), acknowledgedUncertainId: this.uncertainReceipt?.id })
    }
  }
})
</script>

<style lang="scss" scoped>
.utility-review-parameters {
  display: grid;
  grid-template-columns: minmax(9rem, max-content) minmax(0, 1fr);
  gap: 0.5rem 1rem;
  margin: 0;

  dt {
    color: rgb(var(--v-theme-on-surface-variant));
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
}
</style>
