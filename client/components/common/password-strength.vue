<template lang="pug">
  .password-strength
    v-progress-linear(
      :color='passwordStrengthColor'
      v-model='passwordStrength'
      height='2'
    )
    .caption(v-if='!hideText', :class='passwordStrengthColor + "--text"') {{passwordStrengthText}}
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
      passwordStrengthColor: 'grey',
      passwordStrengthText: ''
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
        this.passwordStrengthColor = 'grey'
        this.passwordStrengthText = ''
        return
      }
      const strength = zxcvbn(pwd)
      this.passwordStrength = _.round((strength.score + 1) / 5 * 100)
      if (this.passwordStrength <= 20) {
        this.passwordStrengthColor = 'red'
        this.passwordStrengthText = this.$t('common:password.veryWeak')
      } else if (this.passwordStrength <= 40) {
        this.passwordStrengthColor = 'orange'
        this.passwordStrengthText = this.$t('common:password.weak')
      } else if (this.passwordStrength <= 60) {
        this.passwordStrengthColor = 'teal'
        this.passwordStrengthText = this.$t('common:password.average')
      } else if (this.passwordStrength <= 80) {
        this.passwordStrengthColor = 'green'
        this.passwordStrengthText = this.$t('common:password.strong')
      } else {
        this.passwordStrengthColor = 'green'
        this.passwordStrengthText = this.$t('common:password.veryStrong')
      }
    }
  },
  beforeUnmount() {
    this.debouncedCheckPasswordStrength?.cancel()
  }
})
</script>

<style lang="scss">

.password-strength > .caption {
  width: 100%;
  left: 0;
  margin: 0;
  position: absolute;
  top: calc(100% + 5px);
}

</style>
