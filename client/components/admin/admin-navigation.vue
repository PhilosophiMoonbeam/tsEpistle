<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-triangle-arrow.svg', alt='Navigation', style='width: 80px;')
          .admin-header-title
            .headline.primary--text.animated.fadeInLeft {{$t('admin:navigation.title')}}
            .subtitle-1.grey--text.animated.fadeInLeft.wait-p4s {{$t('admin:navigation.subtitle')}}
          v-spacer
          v-btn.animated.fadeInDown.wait-p3s(icon, outlined, color='grey', href='https://docs.requarks.io/navigation', target='_blank')
            v-icon mdi-help-circle
          v-btn.mx-3.animated.fadeInDown.wait-p2s.mr-3(icon, outlined, color='grey', @click='refresh')
            v-icon mdi-refresh
          v-btn.animated.fadeInDown(color='success', depressed, @click='save', large)
            v-icon(left) mdi-check
            span {{$t('common:actions.apply')}}
        v-container.pa-0.mt-3(fluid, grid-list-lg)
          v-row(dense)
            v-col(cols='3')
              v-card.animated.fadeInUp
                v-toolbar(color='teal', dark, dense, flat, height='56')
                  v-toolbar-title.subtitle-1 {{$t('admin:navigation.mode')}}
                v-list(nav, two-line)
                  v-list-item(value='TREE', :active='config.mode === `TREE`', @click='config.mode = `TREE`')
                    v-avatar
                      img(src='/_assets/svg/icon-tree-structure-dotted.svg', alt='Site Tree')
                    div.v-list-item-content
                      v-list-item-title {{$t('admin:navigation.modeSiteTree.title')}}
                      v-list-item-subtitle {{$t('admin:navigation.modeSiteTree.description')}}
                    v-avatar
                      v-icon(v-if='$vuetify.theme.current.dark', :color='config.mode === `TREE` ? `teal lighten-3` : `grey darken-2`') mdi-check-circle
                      v-icon(v-else, :color='config.mode === `TREE` ? `teal` : `grey lighten-3`') mdi-check-circle
                  v-list-item(value='STATIC', :active='config.mode === `STATIC`', @click='config.mode = `STATIC`')
                    v-avatar
                      img(src='/_assets/svg/icon-features-list.svg', alt='Static Navigation')
                    div.v-list-item-content
                      v-list-item-title {{$t('admin:navigation.modeStatic.title')}}
                      v-list-item-subtitle {{$t('admin:navigation.modeStatic.description')}}
                    v-avatar
                      v-icon(v-if='$vuetify.theme.current.dark', :color='config.mode === `STATIC` ? `teal lighten-3` : `grey darken-2`') mdi-check-circle
                      v-icon(v-else, :color='config.mode === `STATIC` ? `teal` : `grey lighten-3`') mdi-check-circle
                  v-list-item(value='MIXED', :active='config.mode === `MIXED`', @click='config.mode = `MIXED`')
                    v-avatar
                      img(src='/_assets/svg/icon-user-menu-male-dotted.svg', alt='Custom Navigation')
                    div.v-list-item-content
                      v-list-item-title {{$t('admin:navigation.modeCustom.title')}}
                      v-list-item-subtitle {{$t('admin:navigation.modeCustom.description')}}
                    v-avatar
                      v-icon(v-if='$vuetify.theme.current.dark', :color='config.mode === `MIXED` ? `teal lighten-3` : `grey darken-2`') mdi-check-circle
                      v-icon(v-else, :color='config.mode === `MIXED` ? `teal` : `grey lighten-3`') mdi-check-circle
                  v-list-item(value='NONE', :active='config.mode === `NONE`', @click='config.mode = `NONE`')
                    v-avatar
                      img(src='/_assets/svg/icon-cancel-dotted.svg', alt='None')
                    div.v-list-item-content
                      v-list-item-title {{$t('admin:navigation.modeNone.title')}}
                      v-list-item-subtitle {{$t('admin:navigation.modeNone.description')}}
                    v-avatar
                      v-icon(v-if='$vuetify.theme.current.dark', :color='config.mode === `NONE` ? `teal lighten-3` : `grey darken-2`') mdi-check-circle
                      v-icon(v-else, :color='config.mode === `NONE` ? `teal` : `grey lighten-3`') mdi-check-circle
            v-col(cols='9', v-if='config.mode === `MIXED` || config.mode === `STATIC`')
              v-card.animated.fadeInUp.wait-p2s
                v-row(no-gutters, align='stretch')
                  v-col(style='flex: 0 0 350px;')
                    v-card.grey(flat, style='height: 100%; border-radius: 4px 0 0 4px;', :class='$vuetify.theme.current.dark ? `darken-4-l5` : `lighten-3`')
                      .teal.lighten-1.pa-2.d-flex(style='margin-bottom: 1px; height:56px;')
                        v-select(
                          :disabled='locales.length < 2'
                          label='Locale'
                          hide-details
                          solo
                          flat
                          background-color='teal darken-2'
                          dark
                          dense
                          v-model='currentLang'
                          :items='locales'
                          item-text='nativeName'
                          item-value='code'
                        )
                        v-tooltip(top)
                          template(v-slot:activator='{ props }')
                            v-btn.ml-2(icon, tile, color='white', v-bind='props', @click='copyFromLocaleDialogIsShown = true')
                              v-icon mdi-arrange-send-backward
                          span {{$t('admin:navigation.copyFromLocale')}}
                      v-list.py-2(dense, nav, dark, class='blue darken-2', style='border-radius: 0;')
                        v-list-item(v-if='currentTree.length < 1')
                          v-avatar(size='24'): v-icon(color='blue lighten-3') mdi-alert
                          div.v-list-item-content
                            em.caption.blue--text.text--lighten-4 {{$t('admin:navigation.emptyList')}}
                        draggable(v-model='currentTree')
                          template(v-for='navItem in currentTree')
                            v-list-item(
                              v-if='navItem.kind === "link"'
                              :key='navItem.id'
                              :class='(navItem === current) ? "blue" : ""'
                              @click='selectItem(navItem)'
                              )
                              v-avatar(size='24', tile)
                                v-icon(v-if='navItem.icon.match(/fa[a-z] fa-/)', size='19') {{ navItem.icon }}
                                v-icon(v-else) {{ navItem.icon }}
                              v-list-item-title {{navItem.label}}
                            .py-2.clickable(
                              v-else-if='navItem.kind === "divider"'
                              :key='navItem.id'
                              :class='(navItem === current) ? "blue" : ""'
                              @click='selectItem(navItem)'
                              )
                              v-divider
                            v-list-subheader.pl-4.clickable(
                              v-else-if='navItem.kind === "header"'
                              :key='navItem.id'
                              :class='(navItem === current) ? "blue" : ""'
                              @click='selectItem(navItem)'
                              ) {{navItem.label}}
                      div.v-card-chin
                        v-menu(offset-y, bottom, min-width='200px', style='flex: 1 1;')
                          template(v-slot:activator='{ props }')
                            v-btn(v-bind='props', color='primary', depressed, block)
                              v-icon(left) mdi-plus
                              span {{$t('common:actions.add')}}
                          v-list
                            v-list-item(@click='addItem("link")')
                              v-avatar(size='24'): v-icon mdi-link
                              v-list-item-title {{$t('admin:navigation.link')}}
                            v-list-item(@click='addItem("header")')
                              v-avatar(size='24'): v-icon mdi-format-title
                              v-list-item-title {{$t('admin:navigation.header')}}
                            v-list-item(@click='addItem("divider")')
                              v-avatar(size='24'): v-icon mdi-minus
                              v-list-item-title {{$t('admin:navigation.divider')}}
                  v-col
                    v-card(flat, style='border-radius: 0 4px 4px 0;')
                      template(v-if='current.kind === "link"')
                        v-toolbar(height='56', color='teal lighten-1', flat, dark)
                          .subtitle-1 {{$t('admin:navigation.edit', { kind: $t('admin:navigation.link') })}}
                          v-spacer
                          v-btn.px-5(color='white', outlined, @click='deleteItem(current)')
                            v-icon(left) mdi-delete
                            span {{$t('admin:navigation.delete', { kind: $t('admin:navigation.link') })}}
                        v-card-text
                          v-text-field(
                            outlined
                            :label='$t("admin:navigation.label")'
                            prepend-icon='mdi-format-title'
                            v-model='current.label'
                            counter='255'
                          )
                          v-text-field(
                            outlined
                            :label='$t("admin:navigation.icon")'
                            prepend-icon='mdi-dice-5'
                            v-model='current.icon'
                            hide-details
                          )
                          .caption.pt-3.pl-5 The default icon set is #[strong Material Design Icons]. In order to use another icon set, you must first select it in the Theme administration section.
                          .caption.pt-3.pl-5: strong Material Design Icons
                          .caption.pl-5 Refer to the #[a(href='https://materialdesignicons.com/', target='_blank') Material Design Icons Reference] for the list of all possible values. You must prefix all values with #[code mdi-], e.g. #[code mdi-home]
                          .caption.pt-3.pl-5: strong Font Awesome 5
                          .caption.pl-5 Refer to the #[a(href='https://fontawesome.com/icons?d=gallery&m=free', target='_blank') Font Awesome 5 Reference] for the list of all possible values. You must prefix all values with #[code fas fa-], e.g. #[code fas fa-home]. Note that some icons use different prefixes (e.g. #[code fab], #[code fad], #[code fal], #[code far]).
                          .caption.pt-3.pl-5: strong Font Awesome 4
                          .caption.pl-5 Refer to the #[a(href='https://fontawesome.com/v4.7.0/icons/', target='_blank') Font Awesome 4 Reference] for the list of all possible values. You must prefix all values with #[code fa fa-], e.g. #[code fa fa-home]
                        v-divider
                        v-card-text
                          v-select(
                            outlined
                            :label='$t("admin:navigation.targetType")'
                            prepend-icon='mdi-near-me'
                            :items='navTypes'
                            v-model='current.targetType'
                            hide-details
                          )
                          v-text-field.mt-4(
                            v-if='current.targetType === `external` || current.targetType === `externalblank`'
                            outlined
                            :label='$t("admin:navigation.target")'
                            prepend-icon='mdi-near-me'
                            v-model='current.target'
                            hide-details
                          )
                          .d-flex.align-center.mt-4(v-else-if='current.targetType === "page"')
                            v-btn.ml-8(
                              color='primary'
                              dark
                              @click='selectPage'
                              )
                              v-icon(left) mdi-magnify
                              span {{$t('admin:navigation.selectPageButton')}}
                            .caption.ml-4.primary--text {{current.target}}
                          v-text-field(
                            v-else-if='current.targetType === `search`'
                            outlined
                            :label='$t("admin:navigation.navType.searchQuery")'
                            prepend-icon='search'
                            v-model='current.target'
                          )
                        v-divider

                      template(v-else-if='current.kind === "header"')
                        v-toolbar(height='56', color='teal lighten-1', flat, dark)
                          .subtitle-1 {{$t('admin:navigation.edit', { kind: $t('admin:navigation.header') })}}
                          v-spacer
                          v-btn.px-5(color='white', outlined, @click='deleteItem(current)')
                            v-icon(left) mdi-delete
                            span {{$t('admin:navigation.delete', { kind: $t('admin:navigation.header') })}}
                        v-card-text
                          v-text-field(
                            outlined
                            :label='$t("admin:navigation.label")'
                            prepend-icon='mdi-format-title'
                            v-model='current.label'
                          )
                        v-divider

                      div(v-else-if='current.kind === "divider"')
                        v-toolbar(height='56', color='teal lighten-1', flat, dark)
                          .subtitle-1 {{$t('admin:navigation.edit', { kind: $t('admin:navigation.divider') })}}
                          v-spacer
                          v-btn.px-5(color='white', outlined, @click='deleteItem(current)')
                            v-icon(left) mdi-delete
                            span {{$t('admin:navigation.delete', { kind: $t('admin:navigation.divider') })}}

                      v-card-text(v-if='current.kind')
                        v-radio-group.pl-8(v-model='current.visibilityMode', mandatory, hide-details)
                          v-radio(:label='$t("admin:navigation.visibilityMode.all")', value='all', color='primary')
                          v-radio.mt-3(:label='$t("admin:navigation.visibilityMode.restricted")', value='restricted', color='primary')
                        .pl-8
                          v-select.pl-8.mt-3(
                            item-text='name'
                            item-value='id'
                            outlined
                            prepend-icon='mdi-account-group'
                            label='Groups'
                            :disabled='current.visibilityMode !== `restricted`'
                            v-model='current.visibilityGroups'
                            :items='groups'
                            persistent-hint
                            clearable
                            multiple
                          )
                      template(v-else)
                        v-toolbar(height='56', color='teal lighten-1', flat, dark)
                        v-card-text.grey--text(v-if='currentTree.length > 0') {{$t('admin:navigation.noSelectionText')}}
                        v-card-text.grey--text(v-else) {{$t('admin:navigation.noItemsText')}}

    v-dialog(v-model='copyFromLocaleDialogIsShown', max-width='650', persistent)
      v-card
        .dialog-header.is-short.is-teal
          v-icon.mr-3(color='white') mdi-arrange-send-backward
          span {{$t('admin:navigation.copyFromLocale')}}
        v-card-text.pt-5
          .body-2 {{$t('admin:navigation.copyFromLocaleInfoText')}}
          v-select.mt-3(
            :items='locales'
            item-text='nativeName'
            item-value='code'
            outlined
            prepend-icon='mdi-web'
            v-model='copyFromLocaleCode'
            :label='$t(`admin:navigation.sourceLocale`)'
            :hint='$t(`admin:navigation.sourceLocaleHint`)'
            persistent-hint
            )
        div.v-card-chin
          v-spacer
          v-btn(text, @click='copyFromLocaleDialogIsShown = false') {{$t('common:actions.cancel')}}
          v-btn.px-3(depressed, color='primary', @click='copyFromLocale')
            v-icon(left) mdi-chevron-right
            span {{$t('common:actions.copy')}}

    page-selector(mode='select', v-model='selectPageModal', :open-handler='selectPageHandle', path='home', :locale='currentLang')
</template>

<script lang='ts'>
import _ from 'lodash'

import { fetchGroupOptions, type GroupOption } from '../../helpers/groups-api'
import { fetchLocales, type LocaleRow } from '../../helpers/locales-api'
import { fetchNavigation, saveNavigation, type NavigationConfig, type NavigationItem, type NavigationTreeRow } from '../../helpers/navigation-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'

import draggable from '@/components/common/draggable-list.vue'

/* global siteConfig, siteLangs */

const createEmptyNavigationItem = (): NavigationItem => ({
  id: '',
  kind: '',
  visibilityGroups: []
})

export default {
  components: {
    draggable
  },
  data() {
    return {
      selectPageModal: false,
      trees: [] as NavigationTreeRow[],
      current: createEmptyNavigationItem(),
      currentLang: siteConfig.lang,
      groups: [] as GroupOption[],
      copyFromLocaleDialogIsShown: false,
      config: {
        mode: 'NONE'
      } as NavigationConfig,
      allLocales: [] as LocaleRow[],
      copyFromLocaleCode: 'en'
    }
  },
  computed: {
    navTypes () {
      return [
        { text: this.$t('admin:navigation.navType.external'), value: 'external' },
        { text: this.$t('admin:navigation.navType.externalblank'), value: 'externalblank' },
        { text: this.$t('admin:navigation.navType.home'), value: 'home' },
        { text: this.$t('admin:navigation.navType.page'), value: 'page' }
        // { text: this.$t('admin:navigation.navType.searchQuery'), value: 'search' }
      ]
    },
    locales () {
      const allowedCodes = new Set([...siteLangs.map(locale => locale.code), 'en', siteConfig.lang])
      return this.allLocales.filter(locale => allowedCodes.has(locale.code))
    },
    currentTree: {
      get () {
        return _.get(_.find(this.trees, ['locale', this.currentLang]), 'items', null) || []
      },
      set (val: NavigationItem[]) {
        const tree = _.find(this.trees, ['locale', this.currentLang])
        if (tree) {
          tree.items = val
        } else {
          this.trees = [...this.trees, {
            locale: this.currentLang,
            items: val
          }]
        }
      }
    }
  },
  watch: {
    currentLang () {
      this.$nextTick(() => {
        if (this.currentTree.length > 0) {
          this.current = this.currentTree[0]!
        } else {
          this.current = createEmptyNavigationItem()
        }
      })
    }
  },
  methods: {
    async loadAllLocales() {
      wikiStore.startLoading('admin-navigation-locales')
      try {
        this.allLocales = await fetchLocales(window.fetch.bind(window), 'Locales response is invalid')
      } catch (err) {
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      }
      wikiStore.stopLoading('admin-navigation-locales')
    },
    async loadGroups() {
      wikiStore.startLoading('admin-navigation-groups')
      try {
        this.groups = await fetchGroupOptions(window.fetch.bind(window), 'Groups response is invalid')
      } catch (err) {
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      }
      wikiStore.stopLoading('admin-navigation-groups')
    },
    addItem(kind: string) {
      let newItem: NavigationItem = {
        id: crypto.randomUUID(),
        kind,
        visibilityMode: 'all',
        visibilityGroups: []
      }
      switch (kind) {
        case 'link':
          newItem = {
            ...newItem,
            label: this.$t('admin:navigation.untitled', { kind: this.$t('admin:navigation.link') }),
            icon: 'mdi-chevron-right',
            targetType: 'home',
            target: ''
          }
          break
        case 'header':
          newItem.label = this.$t('admin:navigation.untitled', { kind: this.$t('admin:navigation.header') })
          break
      }
      this.currentTree = [...this.currentTree, newItem]
      this.current = newItem
    },
    deleteItem(item: NavigationItem) {
      this.currentTree = _.pull(this.currentTree, item)
      this.current = createEmptyNavigationItem()
    },
    selectItem(item: NavigationItem) {
      this.current = item
    },
    selectPage() {
      this.selectPageModal = true
    },
    selectPageHandle ({ path, locale }: { path: string, locale: string }) {
      this.current.target = `/${locale}/${path}`
    },
    copyFromLocale () {
      this.copyFromLocaleDialogIsShown = false
      this.currentTree = [...this.currentTree, ..._.get(_.find(this.trees, ['locale', this.copyFromLocaleCode]), 'items', null) || []]
    },
    async save() {
      wikiStore.startLoading('admin-navigation-save')
      try {
        await saveNavigation(window.fetch.bind(window), this.trees, this.config.mode)
        wikiStore.showNotification({
          message: this.$t('admin:navigation.saveSuccess'),
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
      }
      wikiStore.stopLoading('admin-navigation-save')
    },
    async loadNavigation(notify = false) {
      wikiStore.startLoading('admin-navigation-refresh')
      try {
        const navigation = await fetchNavigation(window.fetch.bind(window), 'Navigation response is invalid')
        this.config = _.cloneDeep(navigation.config)
        this.trees = _.cloneDeep(navigation.tree)
        this.current = createEmptyNavigationItem()
        if (notify) {
          wikiStore.showNotification({
            message: 'Navigation has been refreshed.',
            style: 'success',
            icon: 'cached'
          })
        }
      } catch (err) {
        wikiStore.showError(err)
      }
      wikiStore.stopLoading('admin-navigation-refresh')
    },
    async refresh() {
      await this.loadNavigation(true)
    }
  },
  created() {
    this.loadAllLocales()
    this.loadGroups()
    this.loadNavigation()
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
