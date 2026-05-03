<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-layout(row, wrap)
      v-flex(xs12)
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-winter.svg', alt='Mail', style='width: 80px;')
          .admin-header-title
            .headline.primary--text.animated.fadeInLeft {{ $t('admin:webhooks.title') }}
            .subtitle-1.grey--text.animated.fadeInLeft.wait-p4s {{ $t('admin:webhooks.subtitle') }}
          v-spacer
          v-btn.animated.fadeInDown(color='success', depressed, large, disabled)
            v-icon(left) check
            span {{$t('common:actions.apply')}}

      v-flex(lg3, xs12)
        v-card.animated.fadeInUp
          v-toolbar(flat, color='primary', dark, dense)
            .subtitle-1 Webhooks
            v-spacer
            v-btn(outline, small)
              v-icon.mr-2 add
              span New
          v-list(two-line, dense).py-0
            template(v-for='(str, idx) in hooks')
              v-list-item(:key='str.key', @click='selectedHook = str.key')
                v-list-item-avatar
                  v-icon(color='primary', v-if='str.isEnabled', v-ripple, @click='str.isEnabled = false') check_box
                  v-icon(color='grey', v-else, v-ripple, @click='str.isEnabled = true') check_box_outline_blank
                v-list-item-content
                  v-list-item-title.body-2(:class='!str.isAvailable ? `grey--text` : (selectedHook === str.key ? `primary--text` : ``)') {{ str.title }}
                  v-list-item-sub-title.caption(:class='!str.isAvailable ? `grey--text text--lighten-1` : (selectedHook === str.key ? `blue--text ` : ``)') {{ str.description }}
                v-list-item-avatar(v-if='selectedHook === str.key')
                  v-icon.animated.fadeInLeft(color='primary') arrow_forward_ios
              v-divider(v-if='idx < hooks.length - 1')

      v-flex(xs12, lg9)
        v-card.wiki-form.animated.fadeInUp.wait-p2s
          v-toolbar(color='primary', dense, flat, dark)
            .subtitle-1 {{hook.title}}
          v-card-text
            v-form
              .authlogo
                img(:src='hook.logo', :alt='hook.title')
              .caption.pt-3 {{hook.description}}
              .caption.pb-3: a(:href='hook.website') {{hook.website}}
              .body-2(v-if='hook.isEnabled')
                span This hook is

</template>

<script>
import _ from 'lodash'
// import { get } from 'vuex-pathify'

export default {
  data() {
    return {
      hooks: [],
      selectedHook: ''
    }
  },
  computed: {
    hook() {
      return _.find(this.hooks, ['id', this.selectedHook]) || {}
    }
  }
}
</script>

<style lang='scss'>

</style>
