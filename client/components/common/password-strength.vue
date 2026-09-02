<template lang="pug">
  .password-strength(
    role="status"
    aria-live="polite"
    aria-atomic="true"
  )
    v-progress-linear(
      :color='passwordStrengthColor'
      :model-value='passwordStrength'
      height='2'
      role="progressbar"
      aria-label="Password strength"
      :aria-valuetext='passwordStrengthAnnouncement'
    )
    .text-body-small(v-if='!hideText', :class='`text-${passwordStrengthColor}`') {{passwordStrengthText}}
    .password-strength__sr-only(v-else) {{passwordStrengthAnnouncement}}

</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import zxcvbn from 'zxcvbn'
import debounce from 'lodash/debounce.js'

export default defineComponent({
  props: {
    modelValue: {
      type: String,
      default: ''
    },
    hideText: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      debouncedCheckPasswordStrength: null as ReturnType<typeof debounce> | null,
      passwordStrength: 0
    }
  },
  computed: {
    passwordStrengthColor(): string {
      if (this.passwordStrength === 0) return 'on-surface-variant'
      if (this.passwordStrength <= 20) return 'error'
      if (this.passwordStrength <= 40) return 'warning'
      if (this.passwordStrength <= 60) return 'info'
      return 'success'
    },
    passwordStrengthText(): string {
      if (this.passwordStrength === 0) return ''
      if (this.passwordStrength <= 20) return this.$t('common:password.veryWeak')
      if (this.passwordStrength <= 40) return this.$t('common:password.weak')
      if (this.passwordStrength <= 60) return this.$t('common:password.average')
      if (this.passwordStrength <= 80) return this.$t('common:password.strong')
      return this.$t('common:password.veryStrong')
    },
    passwordStrengthAnnouncement(): string {
      return this.passwordStrength === 0
        ? 'Password strength not set'
        : `${this.passwordStrengthText} (${this.passwordStrength}%)`
    }
  },
  watch: {
    modelValue(newValue: string) {
      this.debouncedCheckPasswordStrength?.(newValue)
    }
  },
  created() {
    this.debouncedCheckPasswordStrength = debounce((password: string) => {
      this.updatePasswordStrength(password)
    }, 100)
    this.debouncedCheckPasswordStrength(this.modelValue)
  },
  methods: {
    updatePasswordStrength(pwd: string) {
      this.passwordStrength = pwd ? (zxcvbn(pwd).score + 1) * 20 : 0
    }
  },
  beforeUnmount() {
    this.debouncedCheckPasswordStrength?.cancel()
  }
})
</script>

<style lang="scss">

.password-strength {
  display: block;
  width: 100%;
}

.password-strength > .text-body-small {
  display: block;
  width: 100%;
  margin-top: 4px;
}

.password-strength__sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

</style>
