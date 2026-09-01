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
                    .text-body-small.text-medium-emphasis and matches one of these rules...
                  async-state(
                    v-if='groupsLoading'
                    state='loading'
                    title='Loading groups'
                  )
                  async-state(
                    v-else-if='groupsError'
                    state='error'
                    title='Groups could not be loaded'
                    :message='groupsError'
                    retry-label='Retry'
                    @retry='loadGroups'
                  )
                  async-state(
                    v-else-if='groups.length === 0'
                    state='empty'
                    title='No groups available'
                    message='Conditional redirects require at least one group.'
                  )
                  v-timeline(v-else density="compact")
                    v-slide-x-reverse-transition(group, hide-on-leave)
                      v-timeline-item(
                        key='cond-add-new'
                        hide-dot
                        )
                        v-btn(
                          color='primary'
                          @click='addConditionalRule'
                        )
                          v-icon(start) mdi-plus
                          span Add Conditional Rule
                      v-timeline-item(
                        v-if='conditionalRules.length === 0'
                        key='cond-none'
                        size="small"
                        dot-color='grey'
                        )
                        v-card.editor-redirect-empty(flat)
                          v-card-text
                            .text-body-medium: strong No conditional rule
                            em Add conditional rules to direct users to a different page based on their group.
                      v-timeline-item(
                        v-for='rule in conditionalRules'
                        :key='rule.key'
                        size="small"
                        dot-color='primary'
                        )
                        v-card.editor-redirect-rule(flat)
                          v-card-text
                            .editor-redirect-condition
                              .text-body-medium.editor-redirect-label
                                strong User is a member of any of these groups:
                              v-select.editor-redirect-groups(
                                v-model='rule.groups'
                                color='primary'
                                :items='groups'
                                item-title='name'
                                item-value='id'
                                aria-label='Groups used for this redirect rule'
                                multiple
                                variant="solo"
                                flat
                                hide-details
                                density="compact"
                                chips
                                closable-chips
                              )
                            v-divider.my-3
                            .editor-redirect-destination
                              .text-body-medium.editor-redirect-label then redirect to
                              v-btn-toggle.editor-redirect-toggle(
                                v-model='rule.mode'
                                mandatory
                                color='primary'
                                density="compact"
                              )
                                v-btn.text-none(value='page') Page
                                v-btn.text-none(value='url') External URL
                              v-btn.editor-redirect-page-button(
                                v-if='rule.mode === `page`'
                                variant='tonal'
                                color='primary'
                              )
                                v-icon(start) mdi-magnify
                                span Select Page...
                              v-text-field.editor-redirect-url(
                                v-if='rule.mode === `url`'
                                label='External URL'
                                variant="outlined"
                                hint='Required - destination URL'
                                hide-details
                                v-model='rule.url'
                                density="compact"
                                single-line
                              )
                  v-divider.mb-5
                  .text-label-large.text-primary Otherwise, redirect to...
                  .text-body-small.text-medium-emphasis.pb-2 This fallback rule is mandatory and used if none of the conditional rules above applies.
                  .editor-redirect-destination
                    .text-body-medium.editor-redirect-label then redirect to
                    v-btn-toggle.editor-redirect-toggle(
                      v-model='fallbackMode'
                      mandatory
                      color='primary'
                      density="compact"
                    )
                      v-btn.text-none(value='page') Page
                      v-btn.text-none(value='url') External URL
                    v-btn.editor-redirect-page-button(
                      v-if='fallbackMode === `page`'
                      variant='tonal'
                      color='primary'
                    )
                      v-icon(start) mdi-magnify
                      span Select Page...
                    v-text-field.editor-redirect-url(
                      v-if='fallbackMode === `url`'
                      label='External URL'
                      variant="outlined"
                      hint='Required - destination URL'
                      hide-details
                      v-model='fallbackUrl'
                      density="compact"
                      single-line
                    )

    v-system-bar.editor-status-bar.editor-redirect-sysbar(absolute, color="grey-darken-3")
      .text-body-small.editor-redirect-sysbar-locale {{locale.toUpperCase()}}
      .text-body-small.px-3 /{{path}}
      template(v-if='$vuetify.display.mdAndUp')
        v-spacer
        .text-body-small Redirect
        v-spacer
        .text-body-small {{conditionalRules.length}} {{conditionalRules.length === 1 ? 'rule' : 'rules'}}</template>

<script lang='ts'>
import { wikiStore } from '@/store/index.ts'
import { fetchGroupOptions, type GroupOption } from '../../helpers/groups-api'
import { getErrorMessage, setLoading } from '../../helpers/root-ui-store'
import AsyncState from '@/components/common/async-state.vue'

type RedirectMode = 'page' | 'url'
type ConditionalRedirectRule = {
  key: number
  groups: number[]
  mode: RedirectMode
  url: string
}

export default {
  components: { AsyncState },

  data() {
    return {
      groups: [] as GroupOption[],
      groupsLoading: false,
      groupsError: '',
      groupsAbortController: null as AbortController | null,
      conditionalRules: [] as ConditionalRedirectRule[],
      nextRuleKey: 0,
      fallbackMode: 'page' as RedirectMode,
      fallbackUrl: 'https://'
    }
  },
  computed: {
    locale() {
      return wikiStore.page.locale
    },
    path() {
      return wikiStore.page.path
    },
    mode() {
      return wikiStore.editor.mode
    }
  },
  methods: {
    addConditionalRule () {
      this.conditionalRules.push({
        key: this.nextRuleKey++,
        groups: [],
        mode: 'page',
        url: 'https://'
      })
    },
    async loadGroups () {
      this.groupsAbortController?.abort()
      const wasLoading = this.groupsLoading
      const abortController = new AbortController()
      this.groupsAbortController = abortController
      this.groupsLoading = true
      this.groupsError = ''
      if (!wasLoading) {
        setLoading(wikiStore, 'editor-redirect-groups', true)
      }
      try {
        const groups = await fetchGroupOptions((url, init) => window.fetch(url, {
          ...init,
          signal: abortController.signal
        }))
        if (this.groupsAbortController === abortController && !abortController.signal.aborted) {
          this.groups = groups
        }
      } catch (error) {
        if (this.groupsAbortController === abortController && !abortController.signal.aborted) {
          this.groups = []
          this.groupsError = getErrorMessage(error)
        }
      } finally {
        if (this.groupsAbortController === abortController) {
          this.groupsAbortController = null
          this.groupsLoading = false
          setLoading(wikiStore, 'editor-redirect-groups', false)
        }
      }
    }
  },
  async mounted() {
    wikiStore.editor.editorKey = 'redirect'

    if (this.mode === 'create') {
      wikiStore.editor.content = '<h1>Title</h1>\n\n<p>Some text here</p>'
    }
    await this.loadGroups()
  },
  beforeUnmount() {
    this.groupsAbortController?.abort()
    this.groupsAbortController = null
    if (this.groupsLoading) {
      this.groupsLoading = false
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
    overflow-y: auto;
    box-sizing: border-box;
    padding-bottom: 32px;

    @at-root .v-theme--dark & {
      background-color: darken(mc('grey', '900'), 4.5%);
    }
  }

  &-empty,
  &-rule {
    background-color: color-mix(in srgb, rgb(var(--v-theme-surface)) 92%, rgb(var(--v-theme-primary)));
    color: rgb(var(--v-theme-on-surface));
  }

  &-condition,
  &-destination {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  &-label {
    flex: 1 1 auto;
    min-width: 0;
  }

  &-groups {
    flex: 1 1 18rem;
    min-width: 12rem;
  }

  &-toggle {
    flex: 0 0 auto;
  }

  &-page-button,
  &-url {
    flex: 1 1 12rem;
    min-width: 0;
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
@media (max-width: $tablet - 0.02px) {
  .editor-redirect-editor {
    height: $editor-height-mobile;
    padding-bottom: 40px;
  }

  .editor-redirect-condition,
  .editor-redirect-destination {
    align-items: stretch;
    flex-direction: column;
  }

  .editor-redirect-groups,
  .editor-redirect-toggle,
  .editor-redirect-page-button,
  .editor-redirect-url {
    width: 100%;
    min-width: 0;
    margin-left: 0 !important;
    margin-right: 0 !important;
  }
}
</style>
