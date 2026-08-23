<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-tags.svg', alt='Tags', style='width: 80px;')
          .admin-header-title
            .text-headline-medium.text-primary.animated.fadeInLeft {{$t('admin:tags.title')}}
            .text-body-large.text-grey.animated.fadeInLeft.wait-p4s {{$t('admin:tags.subtitle')}}
          v-spacer
          v-btn.animated.fadeInDown(variant="outlined", color='grey', @click='refresh', icon)
            v-icon mdi-refresh
        v-container.pa-0.mt-3(fluid)
          v-row
            v-col(style='flex: 0 0 350px;')
              v-card.animated.fadeInUp
                v-toolbar(:color='$vuetify.theme.current.dark ? `grey-darken-3-d5` : `grey-lighten-4`', flat)
                  v-text-field(
                    v-model='filter'
                    :label='$t(`admin:tags.filter`)'
                    hide-details
                    single-line
                    variant="solo"
                    flat
                    density="compact"
                    color='teal'
                    :bg-color='$vuetify.theme.current.dark ? `grey-darken-4` : `grey-lighten-2`'
                    prepend-inner-icon='mdi-magnify'
                  )
                v-divider
                v-list.py-2(density="compact", nav)
                  v-list-item(v-if='tags.length < 1')
                    template(v-slot:prepend)
                      v-avatar(size='24'): v-icon(color='grey') mdi-compass-off
                    .text-body-small.text-grey {{$t('admin:tags.emptyList')}}
                  v-list-item(
                    v-for='tag of filteredTags'
                    :key='tag.id'
                    :class='(tag.id === current.id) ? "bg-teal" : ""'
                    @click='selectTag(tag)'
                    )
                    template(v-slot:prepend)
                      v-avatar(size='24', rounded='0'): v-icon(size='18', :color='tag.id === current.id ? `white` : `teal`') mdi-tag
                    v-list-item-title(:class='tag.id === current.id ? `text-white` : ``') {{tag.tag}}
            v-col.animated.fadeInUp.wait-p2s
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
                  div.v-card-chin
                    i18next.text-body-small.pl-3(path='admin:tags.date', tag='div')
                      strong(place='created') {{ $helpers.formatMoment(current.createdAt, 'from') }}
                      strong(place='updated') {{ $helpers.formatMoment(current.updatedAt, 'from') }}
                    v-spacer
                    v-dialog(v-model='deleteTagDialog', max-width='500')
                      template(v-slot:activator='{ props }')
                        v-btn(color='red', variant="outlined", v-bind='props')
                          v-icon(color='red') mdi-trash-can-outline
                      v-card
                        .dialog-header.is-red {{$t('admin:tags.deleteConfirm')}}
                        v-card-text.pa-4
                          i18next(tag='span', path='admin:tags.deleteConfirmText')
                            strong(place='tag') {{ current.tag }}
                        v-card-actions
                          v-spacer
                          v-btn(variant="text", @click='deleteTagDialog = false') {{$t('common:actions.cancel')}}
                          v-btn(color='red', @click='deleteTag(current)') {{$t('common:actions.delete')}}
                    v-btn.px-5.mr-2(color='success', variant="flat", @click='saveTag(current)')
                      v-icon(start) mdi-content-save
                      span {{$t('common:actions.save')}}
              v-card(v-else)
                v-card-text.text-grey(v-if='tags.length > 0') {{$t('admin:tags.noSelectionText')}}
                v-card-text.text-grey(v-else) {{$t('admin:tags.noItemsText')}}</template>

<script lang='ts'>
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'
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
  data() {
    return {
      tags: [] as EditablePageTagRow[],
      current: makeEmptyTag(),
      filter: '',
      deleteTagDialog: false
    }
  },
  computed: {
    filteredTags () {
      if (this.filter.length > 0) {
        return _.filter(this.tags, t => t.tag.indexOf(this.filter) >= 0 || (t.title?.indexOf(this.filter) ?? -1) >= 0)
      } else {
        return this.tags
      }
    }
  },
  methods: {
    selectTag(tag: EditablePageTagRow) {
      this.current = tag
    },
    async deleteTag(tag: EditablePageTagRow) {
      wikiStore.startLoading('admin-tags-delete')
      try {
        await deletePageTag(
          window.fetch.bind(window),
          tag.id
        )
        wikiStore.showNotification({
          message: this.$t('admin:tags.deleteSuccess'),
          style: 'success',
          icon: 'check'
        })
        this.refresh()
      } catch (err) {
        wikiStore.showError(err)
      }
      this.deleteTagDialog = false
      wikiStore.stopLoading('admin-tags-delete')
    },
    async saveTag(tag: EditablePageTagRow) {
      wikiStore.startLoading('admin-tags-save')
      try {
        await updatePageTag(
          window.fetch.bind(window),
          tag.id,
          tag.tag,
          tag.title
        )
        wikiStore.showNotification({
          message: this.$t('admin:tags.saveSuccess'),
          style: 'success',
          icon: 'check'
        })
        this.current.updatedAt = new Date()
      } catch (err) {
        wikiStore.showError(err)
      }
      wikiStore.stopLoading('admin-tags-save')
    },
    async refresh(notify = true) {
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
        wikiStore.showError(err)
      }
      wikiStore.stopLoading('admin-tags-refresh')
    }
  },
  mounted () {
    this.refresh(false)
  }
}
</script>

<style lang='scss' scoped>

.clickable {
  cursor: pointer;

  &:hover {
    background-color: rgba(mc('blue', '500'), .25);
  }
}

</style>
