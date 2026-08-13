<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-tags.svg', alt='Tags', style='width: 80px;')
          .admin-header-title
            .headline.primary--text.animated.fadeInLeft {{$t('admin:tags.title')}}
            .subtitle-1.grey--text.animated.fadeInLeft.wait-p4s {{$t('admin:tags.subtitle')}}
          v-spacer
          v-btn.animated.fadeInDown(outlined, color='grey', @click='refresh', icon)
            v-icon mdi-refresh
        v-container.pa-0.mt-3(fluid, grid-list-lg)
          v-row
            v-col(style='flex: 0 0 350px;')
              v-card.animated.fadeInUp
                v-toolbar(:color='$vuetify.theme.current.dark ? `grey darken-3-d5` : `grey lighten-4`', flat)
                  v-text-field(
                    v-model='filter'
                    :label='$t(`admin:tags.filter`)'
                    hide-details
                    single-line
                    solo
                    flat
                    dense
                    color='teal'
                    :background-color='$vuetify.theme.current.dark ? `grey darken-4` : `grey lighten-2`'
                    prepend-inner-icon='mdi-magnify'
                  )
                v-divider
                v-list.py-2(dense, nav)
                  v-list-item(v-if='tags.length < 1')
                    v-avatar(size='24'): v-icon(color='grey') mdi-compass-off
                    div.v-list-item-content
                      .caption.grey--text {{$t('admin:tags.emptyList')}}
                  v-list-item(
                    v-for='tag of filteredTags'
                    :key='tag.id'
                    :class='(tag.id === current.id) ? "teal" : ""'
                    @click='selectTag(tag)'
                    )
                    v-avatar(size='24', tile): v-icon(size='18', :color='tag.id === current.id ? `white` : `teal`') mdi-tag
                    v-list-item-title(:class='tag.id === current.id ? `white--text` : ``') {{tag.tag}}
            v-col.animated.fadeInUp.wait-p2s
              template(v-if='current.id')
                v-card
                  v-toolbar(dense, color='teal', flat, dark)
                    .subtitle-1 {{$t('admin:tags.edit')}}
                    v-spacer
                    v-btn.pl-4(
                      color='white'
                      dark
                      outlined
                      small
                      :href='`/t/` + current.tag'
                      )
                      span.text-none {{$t('admin:tags.viewLinkedPages')}}
                      v-icon(right) mdi-chevron-right
                  v-card-text
                    v-text-field(
                      outlined
                      :label='$t("admin:tags.tag")'
                      prepend-icon='mdi-tag'
                      v-model='current.tag'
                      counter='255'
                    )
                    v-text-field(
                      outlined
                      :label='$t("admin:tags.label")'
                      prepend-icon='mdi-format-title'
                      v-model='current.title'
                      hide-details
                    )
                  div.v-card-chin
                    i18next.caption.pl-3(path='admin:tags.date', tag='div')
                      strong(place='created') {{ $helpers.formatMoment(current.createdAt, 'from') }}
                      strong(place='updated') {{ $helpers.formatMoment(current.updatedAt, 'from') }}
                    v-spacer
                    v-dialog(v-model='deleteTagDialog', max-width='500')
                      template(v-slot:activator='{ props }')
                        v-btn(color='red', outlined, v-bind='props')
                          v-icon(color='red') mdi-trash-can-outline
                      v-card
                        .dialog-header.is-red {{$t('admin:tags.deleteConfirm')}}
                        v-card-text.pa-4
                          i18next(tag='span', path='admin:tags.deleteConfirmText')
                            strong(place='tag') {{ current.tag }}
                        v-card-actions
                          v-spacer
                          v-btn(text, @click='deleteTagDialog = false') {{$t('common:actions.cancel')}}
                          v-btn(color='red', dark, @click='deleteTag(current)') {{$t('common:actions.delete')}}
                    v-btn.px-5.mr-2(color='success', depressed, dark, @click='saveTag(current)')
                      v-icon(left) mdi-content-save
                      span {{$t('common:actions.save')}}
              v-card(v-else)
                v-card-text.grey--text(v-if='tags.length > 0') {{$t('admin:tags.noSelectionText')}}
                v-card-text.grey--text(v-else) {{$t('admin:tags.noItemsText')}}
</template>

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
