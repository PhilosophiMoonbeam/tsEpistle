<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        admin-hero(
          :title='$t("admin:tags.title")'
          :description='$t("admin:tags.subtitle")'
          icon='/_assets/svg/icon-tags.svg'
        )
          template(v-slot:actions)
            v-btn.animated.fadeInDown(
              variant="outlined"
              color='grey'
              @click='refresh'
              icon
              :loading='refreshing'
              :disabled='refreshing || saving || deleting'
              aria-label='Refresh tags'
            )
              v-icon mdi-refresh
        v-container.pa-0.mt-3(fluid)
          v-row
            v-col(cols='12', md='4', lg='3', style='min-width:0;')
              v-card.animated.fadeInUp
                v-toolbar(:color='$vuetify.theme.current.dark ? `grey-darken-3` : `grey-lighten-4`', flat)
                  v-text-field(
                    v-model='filter'
                    :label='$t(`admin:tags.filter`)'
                    hide-details
                    single-line
                    variant="solo"
                    flat
                    density="compact"
                    color='primary'
                    :bg-color='$vuetify.theme.current.dark ? `grey-darken-4` : `grey-lighten-2`'
                    prepend-inner-icon='mdi-magnify'
                  )
                v-divider
                async-state(v-if='loading', state='loading', title='Loading tags', message='Fetching the latest tag list.')
                async-state(v-else-if='errorMessage', state='error', title='Tags could not be loaded', :message='errorMessage', retry-label='Try again', @retry='refresh(false)')
                async-state(v-else-if='tags.length < 1', state='empty', :title='$t(`admin:tags.emptyList`)', :message='$t(`admin:tags.noItemsText`)')
                template(v-else)
                  v-list.py-2(density="compact", nav)
                    v-list-item(v-if='filteredTags.length < 1')
                      .text-body-small.text-medium-emphasis No tags match “{{ filter }}”.
                      template(v-slot:append)
                        v-btn(size='small', variant='text', color='primary', @click='filter = ""') Clear filter
                    v-list-item(
                      v-for='tag of filteredTags'
                      :key='tag.id'
                      :active='tag.id === current.id'
                      active-color='primary'
                      @click='selectTag(tag)'
                    )
                      template(v-slot:prepend)
                        v-avatar(size='24', rounded='0'): v-icon(size="18", color='primary') mdi-tag
                      v-list-item-title {{tag.tag}}
            v-col.animated.fadeInUp.wait-p2s(cols='12', md='8', lg='9', style='min-width:0;')
              template(v-if='current.id')
                v-card
                  v-toolbar(density="compact", color='teal', flat)
                    .text-body-large {{$t('admin:tags.edit')}}
                    v-spacer
                    v-btn.pl-4(
                      color='white'
                      variant="outlined"
                      size="small"
                      :href='`/t/` + current.tag'
                      )
                      span.text-none {{$t('admin:tags.viewLinkedPages')}}
                      v-icon(end) mdi-chevron-right
                  v-card-text
                    v-text-field(
                      variant="outlined"
                      :label='$t("admin:tags.tag")'
                      prepend-icon='mdi-tag'
                      v-model='current.tag'
                      counter='255'
                    )
                    v-text-field(
                      variant="outlined"
                      :label='$t("admin:tags.label")'
                      prepend-icon='mdi-format-title'
                      v-model='current.title'
                      hide-details
                    )
                  .tag-footer
                    .tag-footer-meta.text-body-small
                      i18next(path='admin:tags.date', tag='div')
                        strong(place='created') {{ $helpers.formatMoment(current.createdAt, 'from') }}
                        strong(place='updated') {{ $helpers.formatMoment(current.updatedAt, 'from') }}
                    .tag-footer-actions
                      v-dialog(v-model='deleteTagDialog', max-width='500')
                        template(v-slot:activator='{ props }')
                          v-btn(color='red', variant="outlined", v-bind='props', :disabled='deleting', aria-label='Delete tag')
                            v-icon(color='red') mdi-trash-can-outline
                        v-card
                          .dialog-header.is-red {{$t('admin:tags.deleteConfirm')}}
                          v-card-text.pa-4
                            i18next(tag='span', path='admin:tags.deleteConfirmText')
                              strong(place='tag') {{ current.tag }}
                          v-card-actions
                            v-spacer
                            v-btn(variant="text", @click='deleteTagDialog = false', :disabled='deleting') {{$t('common:actions.cancel')}}
                            v-btn(color='red', @click='deleteTag(current)', :loading='deleting', :disabled='deleting') {{$t('common:actions.delete')}}
                      v-btn.px-5.mr-2(color='success', variant="flat", @click='saveTag(current)', :loading='saving', :disabled='saving || deleting || !tagValid')
                        v-icon(start) mdi-content-save
                        span {{$t('common:actions.save')}}
              v-card(v-else-if='!loading && !errorMessage && tags.length > 0')
                v-card-text.text-medium-emphasis {{$t('admin:tags.noSelectionText')}}

</template>
<script lang='ts'>
import AsyncState from '@/components/common/async-state.vue'
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { deletePageTag, fetchPageTags, updatePageTag } from '../../helpers/pages-api'
import type { PageTagRow } from '../../helpers/pages-api'

type EditablePageTagRow = Omit<PageTagRow, 'updatedAt'> & {
  updatedAt: string | Date
}

const makeEmptyTag = (): EditablePageTagRow => ({
  id: 0,
  tag: '',
  title: null,
  createdAt: '',
  updatedAt: ''
})

export default {
  components: {
    AsyncState
  },
  data() {
    return {
      tags: [] as EditablePageTagRow[],
      current: makeEmptyTag(),
      filter: '',
      deleteTagDialog: false,
      loading: false,
      errorMessage: '',
      refreshing: false,
      saving: false,
      deleting: false
    }
  },
  computed: {
    filteredTags () {
      const query = this.filter.trim().toLocaleLowerCase()
      if (query.length > 0) {
        return _.filter(this.tags, t =>
          t.tag.toLocaleLowerCase().includes(query) ||
          (t.title?.toLocaleLowerCase().includes(query) ?? false)
        )
      }
      return this.tags
    },
    tagValid (): boolean {
      return this.current.tag.trim().length > 0
    }
  },
  methods: {
    selectTag(tag: EditablePageTagRow) {
      this.current = tag
    },
    async deleteTag(tag: EditablePageTagRow) {
      if (this.deleting) return
      this.deleting = true
      wikiStore.startLoading('admin-tags-delete')
      let deleted = false
      try {
        await deletePageTag(window.fetch.bind(window), tag.id)
        deleted = true
        wikiStore.showNotification({
          message: this.$t('admin:tags.deleteSuccess'),
          style: 'success',
          icon: 'check'
        })
        this.deleteTagDialog = false
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        this.deleting = false
        wikiStore.stopLoading('admin-tags-delete')
      }
      if (deleted) await this.refresh(false)
    },
    async saveTag(tag: EditablePageTagRow) {
      if (this.saving || this.deleting || !this.tagValid) return
      this.saving = true
      wikiStore.startLoading('admin-tags-save')
      try {
        await updatePageTag(window.fetch.bind(window), tag.id, tag.tag, tag.title)
        wikiStore.showNotification({
          message: this.$t('admin:tags.saveSuccess'),
          style: 'success',
          icon: 'check'
        })
        this.current.updatedAt = new Date()
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        this.saving = false
        wikiStore.stopLoading('admin-tags-save')
      }
    },
    async refresh(notify = true) {
      if (this.refreshing || this.saving || this.deleting) return
      this.refreshing = true
      this.loading = true
      this.errorMessage = ''
      wikiStore.startLoading('admin-tags-refresh')
      try {
        this.tags = _.cloneDeep(await fetchPageTags(window.fetch.bind(window)))
        this.current = makeEmptyTag()
        if (notify) {
          wikiStore.showNotification({
            message: this.$t('admin:tags.refreshSuccess'),
            style: 'success',
            icon: 'cached'
          })
        }
      } catch (err) {
        this.errorMessage = getErrorMessage(err) || this.$t('common:error.unexpected')
        wikiStore.showError(err)
      } finally {
        this.loading = false
        this.refreshing = false
        wikiStore.stopLoading('admin-tags-refresh')
      }
    }
  },
  mounted () {
    this.refresh(false)
  }
}
</script>

<style lang='scss' scoped>
.tag-footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 1rem;
  padding: .75rem 1rem;
}

.tag-footer-meta {
  flex: 1 1 100%;
  min-width: 0;
}

.tag-footer-actions {
  display: flex;
  justify-content: flex-end;
  flex: 1 1 auto;
  gap: .5rem;
  flex-wrap: wrap;
}
</style>
