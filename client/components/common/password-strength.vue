<template lang="pug">
  .password-strength(
    role="status"
    aria-live="polite"
    aria-atomic="true"
  )
    v-progress-linear(
      :color='passwordStrengthColor'
      v-model='passwordStrength'
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
import _ from 'lodash'

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
      debouncedCheckPasswordStrength: null as ReturnType<typeof _.debounce> | null,
      passwordStrength: 0,
      passwordStrengthColor: 'on-surface-variant',
      passwordStrengthText: '',
      passwordStrengthAnnouncement: 'Password strength not set'
    }
  },
  watch: {
    modelValue(newValue: string) {
      this.debouncedCheckPasswordStrength?.(newValue)
    }
  },
  created() {
    this.debouncedCheckPasswordStrength = _.debounce((password: string) => {
      this.updatePasswordStrength(password)
    }, 100)
    this.debouncedCheckPasswordStrength(this.modelValue)
  },
  methods: {

    updatePasswordStrength(pwd: string) {
      if (!pwd || pwd.length < 1) {
        this.passwordStrength = 0
        this.passwordStrengthColor = 'on-surface-variant'
        this.passwordStrengthText = ''
        this.passwordStrengthAnnouncement = 'Password strength not set'
        return
      }
      const strength = zxcvbn(pwd)
      this.passwordStrength = _.round((strength.score + 1) / 5 * 100)
      if (this.passwordStrength <= 20) {
        this.passwordStrengthColor = 'error'
        this.passwordStrengthText = this.$t('common:password.veryWeak')
      } else if (this.passwordStrength <= 40) {
        this.passwordStrengthColor = 'warning'
        this.passwordStrengthText = this.$t('common:password.weak')
      } else if (this.passwordStrength <= 60) {
        this.passwordStrengthColor = 'info'
        this.passwordStrengthText = this.$t('common:password.average')
      } else if (this.passwordStrength <= 80) {
        this.passwordStrengthColor = 'success'
        this.passwordStrengthText = this.$t('common:password.strong')
      } else {
        this.passwordStrengthColor = 'success'
        this.passwordStrengthText = this.$t('common:password.veryStrong')
      }
      this.passwordStrengthAnnouncement = `${this.passwordStrengthText} (${this.passwordStrength}%)`
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
