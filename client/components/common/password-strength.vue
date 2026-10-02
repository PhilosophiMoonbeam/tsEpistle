<template lang="pug">
  .password-strength
    v-progress-linear(
      :color='passwordStrengthColor'
      :model-value='passwordStrength'
      height='2'
      :aria-label='text(`label`)'
      :aria-valuetext='passwordStrengthValueText'
    )
    .text-body-small(v-if='!hideText', :class='`text-${passwordStrengthColor}`') {{passwordStrengthText}}
    .password-strength__sr-only(
      role="status"
      aria-live="polite"
      aria-atomic="true"
    ) {{passwordStrengthAnnouncement}}

</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import zxcvbn from 'zxcvbn'
import debounce from 'lodash/debounce.js'

type StrengthText = 'label' | 'unset' | 'veryWeak' | 'weak' | 'average' | 'strong' | 'veryStrong'
type Translate = (key: string, options?: Record<string, unknown>) => string

// English fallbacks keep the meter usable on first-run setup, which has no i18n.
const STRENGTH_TEXT: Record<StrengthText, string> = {
  label: 'Password strength',
  unset: 'Not set',
  veryWeak: 'Very weak',
  weak: 'Weak',
  average: 'Average',
  strong: 'Strong',
  veryStrong: 'Very strong'
}

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
      if (this.passwordStrength <= 20) return this.text('veryWeak')
      if (this.passwordStrength <= 40) return this.text('weak')
      if (this.passwordStrength <= 60) return this.text('average')
      if (this.passwordStrength <= 80) return this.text('strong')
      return this.text('veryStrong')
    },
    passwordStrengthValueText(): string {
      return this.passwordStrength === 0
        ? this.text('unset')
        : `${this.passwordStrengthText} (${this.passwordStrength}%)`
    },
    passwordStrengthAnnouncement(): string {
      return `${this.text('label')}: ${this.passwordStrengthValueText}`
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
    text(key: StrengthText): string {
      const translate = (this as unknown as { $t?: Translate }).$t
      return typeof translate === 'function'
        ? translate(`common:password.${key}`, { defaultValue: STRENGTH_TEXT[key] })
        : STRENGTH_TEXT[key]
    },
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


@media (prefers-reduced-motion: reduce) {
  .password-strength .v-progress-linear,
  .password-strength .v-progress-linear__determinate {
    transition: none;
  }
}
</style>
