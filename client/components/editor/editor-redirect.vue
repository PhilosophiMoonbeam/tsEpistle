<template lang='pug'>
  .editor-redirect
    .editor-redirect-main
      .editor-redirect-editor
        v-container.px-2.pt-1(fluid)
          v-row(density="compact")
            v-col(
              cols='12'
              lg='8'
              offset-lg='2'
              xl='6'
              offset-xl='3'
              )
              v-card.pt-2
                v-card-text
                  .pb-1
                    .text-label-large.text-primary When a user reaches this page
                    .text-body-small.text-grey-darken-1 and matches one of these rules...
                  v-timeline(density="compact")
                    v-slide-x-reverse-transition(group, hide-on-leave)
                      v-timeline-item(
                        key='cond-add-new'
                        hide-dot
                        )
                        v-btn(
                          color='primary'
                          )
                          v-icon(start) mdi-plus
                          span Add Conditional Rule
                      v-timeline-item(
                        key='cond-none'
                        size="small"
                        dot-color='grey'
                        )
                        v-card.bg-grey-lighten-5(flat)
                          v-card-text
                            .text-body-medium: strong No conditional rule
                            em Add conditional rules to direct users to a different page based on their group.
                      v-timeline-item(
                        key='cond-rule-1'
                        size="small"
                        dot-color='primary'
                        )
                        v-card.bg-blue-grey-lighten-5(flat)
                          v-card-text
                            .d-flex.align-center
                              .text-body-medium: strong User is a member of any of these groups:
                              v-select.ml-3(
                                color='primary'
                                :items='groups'
                                item-title='name'
                                item-value='id'
                                multiple
                                variant="solo"
                                flat
                                hide-details
                                density="compact"
                                chips
                                closable-chips
                                )
                            v-divider.my-3
                            .d-flex.align-center
                              .text-body-medium.mr-3 then redirect to
                              v-btn-toggle.mr-3(
                                v-model='fallbackMode'
                                mandatory
                                color='primary'
                                density="compact"
                                )
                                v-btn.text-none(value='page') Page
                                v-btn.text-none(value='url') External URL
                              v-btn.mr-3(
                                v-if='fallbackMode === `page`'
                                color='primary'
                                )
                                v-icon(start) mdi-magnify
                                span Select Page...
                              v-text-field(
                                v-if='fallbackMode === `url`'
                                label='External URL'
                                variant="outlined"
                                hint='Required - Title of the API'
                                hide-details
                                v-model='fallbackUrl'
                                density="compact"
                                single-line
                              )
                  v-divider.mb-5
                  .text-label-large.text-primary Otherwise, redirect to...
                  .text-body-small.text-grey-darken-1.pb-2 This fallback rule is mandatory and used if none of the conditional rules above applies.
                  .d-flex.align-center
                    v-btn-toggle.mr-3(
                      v-model='fallbackMode'
                      mandatory
                      color='primary'
                      density="compact"
                      )
                      v-btn.text-none(value='page') Page
                      v-btn.text-none(value='url') External URL
                    v-btn.mr-3(
                      v-if='fallbackMode === `page`'
                      color='primary'
                      )
                      v-icon(start) mdi-magnify
                      span Select Page...
                    v-text-field(
                      v-if='fallbackMode === `url`'
                      label='External URL'
                      variant="outlined"
                      hint='Required - Title of the API'
                      hide-details
                      v-model='fallbackUrl'
                      density="compact"
                      single-line
                    )

    v-system-bar.editor-status-bar.editor-redirect-sysbar(absolute, status, color="grey-darken-3")
      .text-body-small.editor-redirect-sysbar-locale {{locale.toUpperCase()}}
      .text-body-small.px-3 /{{path}}
      template(v-if='$vuetify.display.mdAndUp')
        v-spacer
        .text-body-small Redirect
        v-spacer
        .text-body-small 0 rules</template>

<script lang='ts'>
import { wikiStore } from '@/store/index.ts'
import { fetchGroupOptions, type GroupOption } from '../../helpers/groups-api'
import { setLoading } from '../../helpers/root-ui-store'

export default {
  data() {
    return {
      groups: [] as GroupOption[],
      fallbackMode: 'page',
      fallbackUrl: 'https://'
    }
  },
  computed: {
    isMobile() {
      return this.$vuetify.display.smAndDown
    },
    locale() {
      return wikiStore.page.locale
    },
    path() {
      return wikiStore.page.path
    },
    mode() {
      return wikiStore.editor.mode
    },
    activeModal: {
      get() {
        return wikiStore.editor.activeModal
      },
      set(value: string) {
        wikiStore.editor.activeModal = value
      }
    }
  },
  methods: {
  },
  async mounted() {
    wikiStore.editor.editorKey = 'redirect'

    if (this.mode === 'create') {
      wikiStore.editor.content = '<h1>Title</h1>\n\n<p>Some text here</p>'
    }
    setLoading(wikiStore, 'editor-redirect-groups', true)
    try {
      this.groups = await fetchGroupOptions(window.fetch.bind(window))
    } finally {
      setLoading(wikiStore, 'editor-redirect-groups', false)
    }
  }

}
</script>

<style lang='scss'>
$editor-height: calc(100dvh - 64px - 24px);
$editor-height-mobile: calc(100dvh - 56px - 16px);

.editor-redirect {
  &-main {
    display: flex;
    width: 100%;
  }

  &-editor {
    background-color: darken(mc('grey', '100'), 4.5%);
    flex: 1 1 50%;
    display: block;
    height: $editor-height;
    position: relative;

    @at-root .v-theme--dark & {
      background-color: darken(mc('grey', '900'), 4.5%);
    }
  }

  &-sidebar {
    width: 200px;
  }

  &-sysbar {
    padding-left: 0 !important;

    &-locale {
      background-color: rgba(255,255,255,.25);
      display:inline-flex;
      padding: 0 12px;
      height: 24px;
      width: 63px;
      justify-content: center;
      align-items: center;
    }
  }

}
</style>
