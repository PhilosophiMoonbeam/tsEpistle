<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-row()
      v-col(cols='12')
        .admin-header
          img(src='/_assets/svg/icon-web-design.svg', alt='Editor', style='width: 80px;')
          .admin-header-title
            .headline.primary--text Editor
            .subtitle-1.grey--text Configure the content editors #[v-chip(label, color='primary', small).white--text coming soon]
          v-spacer
          v-btn(outline, color='grey', @click='refresh', large)
            v-icon refresh
          v-btn(color='success', @click='save', depressed, large)
            v-icon(left) check
            span {{$t('common:actions.apply')}}

        v-card.mt-3
          v-tabs.text-white(v-model='tab', bg-color='grey-darken-2', color='white', fixed-tabs, slider-color='white', show-arrows)
            v-tab(value='settings'): v-icon settings
            v-tab(value='code') Markdown

          v-tabs-window(v-model='tab')
            v-tabs-window-item(value='settings', :transition='false', :reverse-transition='false')
              v-card.pa-3(flat, tile)
                .body-2.grey--text.text--darken-1 Select which editors to enable:
                .caption.grey--text.pb-2 Some editors require additional configuration in their dedicated tab (when selected).
                v-form
                  v-checkbox.my-0(
                    v-for='editor in editors'
                    v-model='editor.isEnabled'
                    :key='editor.key'
                    :label='editor.title'
                    color='primary'
                    disabled
                    hide-details
                  )
            v-tabs-window-item(value='code', :transition='false', :reverse-transition='false')
              v-card.wiki-form.pa-3(flat, tile)
                v-form
                  v-list-subheader Editor Configuration
                  .body-1.ml-3 This editor has no configuration options you can modify.
</template>

<script lang='ts'>
export default {
  data() {
    return {
      tab: 'settings',
      editors: [
        { title: 'API Docs', key: 'api', isEnabled: false },
        { title: 'Code', key: 'code', isEnabled: true },
        { title: 'Markdown', key: 'markdown', isEnabled: true },
        { title: 'Tabular', key: 'tabular', isEnabled: false },
        { title: 'Visual Builder', key: 'visual', isEnabled: false },
        { title: 'WikiText', key: 'wikitext', isEnabled: false }
      ]
    }
  },
  methods: {
    save() {},
    refresh() {}
  }
}
</script>

<style lang='scss'>

</style>
