<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-triangle-arrow.svg', alt='Navigation', style='width: 80px;')
          .admin-header-title
            .text-headline-medium.text-primary.animated.fadeInLeft {{$t('admin:navigation.title')}}
            .text-body-large.text-grey.animated.fadeInLeft.wait-p4s {{$t('admin:navigation.subtitle')}}
          v-spacer
          v-chip(v-if='dirty', color='warning', variant='tonal', size='small') Unsaved changes
          .d-flex.flex-wrap.align-center.ga-2
            v-btn(icon, variant="outlined", color='grey', href='https://docs.requarks.io/navigation', target='_blank', :aria-label='$t(`admin:navigation.title`)', title='Open navigation documentation')
              v-icon mdi-help-circle
            v-btn(icon, variant="outlined", color='grey', @click='refresh', :aria-label='$t(`common:actions.refresh`)', title='Refresh navigation settings', :loading='initialLoading')
              v-icon mdi-refresh
            v-btn(
              type='button'
              color='success'
              variant="flat"
              :loading='saving'
              :disabled='!loaded || initialLoading || saving || !dirty'
              @click='save'
            )
              v-icon(start) mdi-check
              span {{$t('common:actions.apply')}}
        v-alert(v-if='initialLoading', type='info', variant='tonal', role='status') Loading navigation settings…
        v-container.pa-0.mt-3(fluid, v-else-if='loaded')
          v-row(density="compact")
            v-col(cols='12', md='3')
              v-card.animated.fadeInUp
                v-toolbar(color='teal', density="compact", flat, height='56')
                  v-toolbar-title.text-body-large {{$t('admin:navigation.mode')}}
                v-list(nav, lines="two", role='radiogroup', :aria-label='$t(`admin:navigation.mode`)')
                  v-list-item(value='TREE', role='radio', :aria-checked='config.mode === `TREE`', :active='config.mode === `TREE`', @click='config.mode = `TREE`')
                    template(v-slot:prepend)
                      v-avatar
                        img(src='/_assets/svg/icon-tree-structure-dotted.svg', alt='Site Tree')
                    v-list-item-title {{$t('admin:navigation.modeSiteTree.title')}}
                    v-list-item-subtitle {{$t('admin:navigation.modeSiteTree.description')}}
                    template(v-slot:append)
                      v-avatar
                        v-icon(v-if='$vuetify.theme.current.dark', :color='config.mode === `TREE` ? `teal-lighten-3` : `grey-darken-2`') mdi-check-circle
                        v-icon(v-else, :color='config.mode === `TREE` ? `teal` : `grey-lighten-3`') mdi-check-circle
                  v-list-item(value='STATIC', role='radio', :aria-checked='config.mode === `STATIC`', :active='config.mode === `STATIC`', @click='config.mode = `STATIC`')
                    template(v-slot:prepend)
                      v-avatar
                        img(src='/_assets/svg/icon-features-list.svg', alt='Static Navigation')
                    v-list-item-title {{$t('admin:navigation.modeStatic.title')}}
                    v-list-item-subtitle {{$t('admin:navigation.modeStatic.description')}}
                    template(v-slot:append)
                      v-avatar
                        v-icon(v-if='$vuetify.theme.current.dark', :color='config.mode === `STATIC` ? `teal-lighten-3` : `grey-darken-2`') mdi-check-circle
                        v-icon(v-else, :color='config.mode === `STATIC` ? `teal` : `grey-lighten-3`') mdi-check-circle
                  v-list-item(value='MIXED', role='radio', :aria-checked='config.mode === `MIXED`', :active='config.mode === `MIXED`', @click='config.mode = `MIXED`')
                    template(v-slot:prepend)
                      v-avatar
                        img(src='/_assets/svg/icon-user-menu-male-dotted.svg', alt='Custom Navigation')
                    v-list-item-title {{$t('admin:navigation.modeCustom.title')}}
                    v-list-item-subtitle {{$t('admin:navigation.modeCustom.description')}}
                    template(v-slot:append)
                      v-avatar
                        v-icon(v-if='$vuetify.theme.current.dark', :color='config.mode === `MIXED` ? `teal-lighten-3` : `grey-darken-2`') mdi-check-circle
                        v-icon(v-else, :color='config.mode === `MIXED` ? `teal` : `grey-lighten-3`') mdi-check-circle
                  v-list-item(value='NONE', role='radio', :aria-checked='config.mode === `NONE`', :active='config.mode === `NONE`', @click='config.mode = `NONE`')
                    template(v-slot:prepend)
                      v-avatar
                        img(src='/_assets/svg/icon-cancel-dotted.svg', alt='None')
                    v-list-item-title {{$t('admin:navigation.modeNone.title')}}
                    v-list-item-subtitle {{$t('admin:navigation.modeNone.description')}}
                    template(v-slot:append)
                      v-avatar
                        v-icon(v-if='$vuetify.theme.current.dark', :color='config.mode === `NONE` ? `teal-lighten-3` : `grey-darken-2`') mdi-check-circle
                        v-icon(v-else, :color='config.mode === `NONE` ? `teal` : `grey-lighten-3`') mdi-check-circle
                v-card-text.pt-0
                  v-switch(
                    v-model='config.expandParent'
                    color='teal'
                    inset
                    hide-details
                    label='Open the current page parent by default'
                  )
                  .text-body-small.text-grey.mt-2 When enabled, Browse opens at the current page location. Disable it to start at the site root.
            v-col(cols='12', md='9', v-if='config.mode === `MIXED` || config.mode === `STATIC`')
              v-card.animated.fadeInUp.wait-p2s
                v-row.align-stretch(no-gutters)
                  v-col(cols='12', lg='5', xl='4')
                    v-card(flat, style='height: 100%; border-radius: 4px 0 0 4px;', :class='$vuetify.theme.current.dark ? `bg-grey-darken-4` : `bg-grey-lighten-3`')
                      .bg-teal-lighten-1.pa-2.d-flex(style='margin-bottom: 1px; height:56px;')
                        v-select(
                          :disabled='locales.length < 2'
                          label='Locale'
                          hide-details
                          variant="solo"
                          flat
                          bg-color='teal-darken-2'
                          density="compact"
                          v-model='currentLang'
                          :items='locales'
                          item-title='nativeName'
                          item-value='code'
                        )
                        v-tooltip(location="top")
                          template(v-slot:activator='{ props }')
                            v-btn.ml-2(icon, rounded='0', color='white', v-bind='props', @click='copyFromLocaleDialogIsShown = true')
                              v-icon mdi-arrange-send-backward
                          span {{$t('admin:navigation.copyFromLocale')}}
                      v-list.py-2(density="compact", nav, class="bg-blue-darken-2", style='border-radius: 0;')
                        v-list-item(v-if='currentTree.length < 1')
                          template(v-slot:prepend)
                            v-avatar(size='24'): v-icon(color="blue-lighten-3") mdi-alert
                          em.text-body-small.text-blue-lighten-4 {{$t('admin:navigation.emptyList')}}
                        draggable(v-model='currentTree', handle='.nav-drag-handle')
                          template(v-for='(navItem, idx) in currentTree')
                            v-list-item(
                              v-if='navItem.kind === "link"'
                              :key='navItem.id'
                              role='option'
                              :aria-selected='navItem === current'
                              tabindex='0'
                              :class='(navItem === current) ? "bg-blue" : ""'
                              @click='selectItem(navItem)'
                              @keydown.arrow-up.prevent='moveItem(idx, -1)'
                              @keydown.arrow-down.prevent='moveItem(idx, 1)'
                            )
                              template(v-slot:prepend)
                                v-btn.nav-drag-handle(icon, size='small', variant='text', :aria-label='`Reorder ${navItem.label}`', @click.stop='selectItem(navItem)')
                                  v-icon(size='18') mdi-drag-horizontal
                                v-avatar(size='24', rounded='0')
                                  v-icon(v-if='navItem.icon.match(/fa[a-z] fa-/)', size='19') {{ navItem.icon }}
                                  v-icon(v-else) {{ navItem.icon }}
                              v-list-item-title {{navItem.label}}
                            .py-2.clickable(
                              v-else-if='navItem.kind === "divider"'
                              :key='navItem.id'
                              role='option'
                              :aria-selected='navItem === current'
                              tabindex='0'
                              :class='(navItem === current) ? "bg-blue" : ""'
                              @click='selectItem(navItem)'
                              @keydown.enter.prevent='selectItem(navItem)'
                              @keydown.space.prevent='selectItem(navItem)'
                              @keydown.arrow-up.prevent='moveItem(idx, -1)'
                              @keydown.arrow-down.prevent='moveItem(idx, 1)'
                            )
                              v-btn.nav-drag-handle(icon, size='small', variant='text', :aria-label='`Reorder divider`', @click.stop='selectItem(navItem)')
                                v-icon(size='18') mdi-drag-horizontal
                              v-divider
                            v-list-subheader.pl-4.clickable(
                              v-else-if='navItem.kind === "header"'
                              :key='navItem.id'
                              role='option'
                              :aria-selected='navItem === current'
                              tabindex='0'
                              :class='(navItem === current) ? "bg-blue" : ""'
                              @click='selectItem(navItem)'
                              @keydown.enter.prevent='selectItem(navItem)'
                              @keydown.space.prevent='selectItem(navItem)'
                              @keydown.arrow-up.prevent='moveItem(idx, -1)'
                              @keydown.arrow-down.prevent='moveItem(idx, 1)'
                            )
                              v-btn.nav-drag-handle(icon, size='small', variant='text', :aria-label='`Reorder ${navItem.label}`', @click.stop='selectItem(navItem)')
                                v-icon(size='18') mdi-drag-horizontal
                              span {{navItem.label}}
                        v-menu(location="bottom", min-width='200px', style='flex: 1 1;')
                          template(v-slot:activator='{ props }')
                            v-btn(v-bind='props', color='primary', variant="flat", block)
                              v-icon(start) mdi-plus
                              span {{$t('common:actions.add')}}
                          v-list
                            v-list-item(@click='addItem("link")')
                              template(v-slot:prepend)
                                v-avatar(size='24'): v-icon mdi-link
                              v-list-item-title {{$t('admin:navigation.link')}}
                            v-list-item(@click='addItem("header")')
                              template(v-slot:prepend)
                                v-avatar(size='24'): v-icon mdi-format-title
                              v-list-item-title {{$t('admin:navigation.header')}}
                            v-list-item(@click='addItem("divider")')
                              template(v-slot:prepend)
                                v-avatar(size='24'): v-icon mdi-minus
                              v-list-item-title {{$t('admin:navigation.divider')}}
                  v-col(cols='12', lg='7', xl='8')
                    v-card(flat, style='border-radius: 0 4px 4px 0;')
                      template(v-if='current.kind === "link"')
                        v-toolbar(height='56', color="teal-lighten-1", flat)
                          .text-body-large {{$t('admin:navigation.edit', { kind: $t('admin:navigation.link') })}}
                          v-spacer
                          v-btn.px-5(color='error', variant="text", :disabled='saving', @click='deleteItem(current)')
                            v-icon(start) mdi-delete
                            span Remove item
                        v-card-text
                          v-text-field(
                            variant="outlined"
                            :label='$t("admin:navigation.label")'
                            prepend-icon='mdi-format-title'
                            v-model='current.label'
                            counter='255'
                          )
                          v-text-field(
                            variant="outlined"
                            :label='$t("admin:navigation.icon")'
                            prepend-icon='mdi-dice-5'
                            v-model='current.icon'
                            hide-details
                          )
                          .text-body-small.pt-3.pl-5 The default icon set is #[strong Material Design Icons]. In order to use another icon set, you must first select it in the Theme administration section.
                          .text-body-small.pt-3.pl-5: strong Material Design Icons
                          .text-body-small.pl-5 Refer to the #[a(href='https://materialdesignicons.com/', target='_blank') Material Design Icons Reference] for the list of all possible values. You must prefix all values with #[code mdi-], e.g. #[code mdi-home]
                          .text-body-small.pt-3.pl-5: strong Font Awesome 5
                          .text-body-small.pl-5 Refer to the #[a(href='https://fontawesome.com/icons?d=gallery&m=free', target='_blank') Font Awesome 5 Reference] for the list of all possible values. You must prefix all values with #[code fas fa-], e.g. #[code fas fa-home]. Note that some icons use different prefixes (e.g. #[code fab], #[code fad], #[code fal], #[code far]).
                          .text-body-small.pt-3.pl-5: strong Font Awesome 4
                          .text-body-small.pl-5 Refer to the #[a(href='https://fontawesome.com/v4.7.0/icons/', target='_blank') Font Awesome 4 Reference] for the list of all possible values. You must prefix all values with #[code fa fa-], e.g. #[code fa fa-home]
                        v-divider
                        v-card-text
                          v-select(
                            variant="outlined"
                            :label='$t("admin:navigation.targetType")'
                            prepend-icon='mdi-near-me'
                            :items='navTypes'
                            item-title='text'
                            v-model='current.targetType'
                            hide-details
                          )
                          v-text-field.mt-4(
                            v-if='current.targetType === `external` || current.targetType === `externalblank`'
                            variant="outlined"
                            :label='$t("admin:navigation.target")'
                            prepend-icon='mdi-near-me'
                            v-model='current.target'
                            hide-details
                          )
                          .d-flex.align-center.mt-4(v-else-if='current.targetType === "page"')
                            v-btn.ml-8(
                              color='primary'
                              @click='selectPage'
                              )
                              v-icon(start) mdi-magnify
                              span {{$t('admin:navigation.selectPageButton')}}
                            .text-body-small.ml-4.text-primary {{current.target}}
                          v-text-field(
                            v-else-if='current.targetType === `search`'
                            variant="outlined"
                            :label='$t("admin:navigation.navType.searchQuery")'
                            prepend-icon='search'
                            v-model='current.target'
                          )
                        v-divider

                      template(v-else-if='current.kind === "header"')
                        v-toolbar(height='56', color="teal-lighten-1", flat)
                          .text-body-large {{$t('admin:navigation.edit', { kind: $t('admin:navigation.header') })}}
                          v-spacer
                          v-btn.px-5(color='error', variant="text", :disabled='saving', @click='deleteItem(current)')
                            v-icon(start) mdi-delete
                            span Remove item
                        v-card-text
                          v-text-field(
                            variant="outlined"
                            :label='$t("admin:navigation.label")'
                            prepend-icon='mdi-format-title'
                            v-model='current.label'
                          )
                        v-divider

                      div(v-else-if='current.kind === "divider"')
                        v-toolbar(height='56', color="teal-lighten-1", flat)
                          .text-body-large {{$t('admin:navigation.edit', { kind: $t('admin:navigation.divider') })}}
                          v-spacer
                          v-btn.px-5(color='error', variant="text", :disabled='saving', @click='deleteItem(current)')
                            v-icon(start) mdi-delete
                            span Remove item

                      v-card-text(v-if='current.kind')
                        .text-label-large Visibility
                        .text-body-small.text-medium-emphasis Choose who can see this item.
                        v-divider.my-4
                        v-radio-group(v-model='current.visibilityMode', mandatory, hide-details, aria-label='Visibility')
                          v-radio(:label='$t("admin:navigation.visibilityMode.all")', value='all', color='primary')
                          v-radio.mt-3(:label='$t("admin:navigation.visibilityMode.restricted")', value='restricted', color='primary')
                        v-select.mt-3(
                          item-title='name'
                          item-value='id'
                          variant="outlined"
                          prepend-icon='mdi-account-group'
                          label='Groups'
                          :disabled='current.visibilityMode !== `restricted`'
                          :hint='current.visibilityMode !== `restricted` ? "Select Restricted to choose groups." : ""'
                          persistent-hint
                          v-model='current.visibilityGroups'
                          :items='groups'
                          clearable
                          multiple
                        )
                      template(v-else)
                        v-toolbar(height='56', color="teal-lighten-1", flat)
                        v-card-text.text-grey(v-if='currentTree.length > 0') {{$t('admin:navigation.noSelectionText')}}
                        v-card-text.text-grey(v-else) {{$t('admin:navigation.noItemsText')}}

        .d-flex.flex-wrap.justify-end.ga-2.mt-5.sticky-action-row
          v-btn(
            color='success'
            variant='flat'
            size='large'
            :loading='saving'
            :disabled='!loaded || initialLoading || saving || !dirty'
            @click='save'
          )
            v-icon(start) mdi-check
            span {{$t('common:actions.apply')}}
    v-dialog(v-model='copyFromLocaleDialogIsShown', max-width='650', persistent)
      v-card
        .dialog-header.is-short.is-teal
          v-icon.mr-3(color='white') mdi-arrange-send-backward
          span {{$t('admin:navigation.copyFromLocale')}}
        v-card-text.pt-5
          .text-body-medium {{$t('admin:navigation.copyFromLocaleInfoText')}}
          v-select.mt-3(
            :items='copyLocales'
            item-title='nativeName'
            item-value='code'
            variant="outlined"
            prepend-icon='mdi-web'
            v-model='copyFromLocaleCode'
            :label='$t(`admin:navigation.sourceLocale`)'
            :hint='$t(`admin:navigation.sourceLocaleHint`)'
            persistent-hint
            )
        div.v-card-chin
          v-spacer
          v-btn(variant="text", @click='copyFromLocaleDialogIsShown = false') {{$t('common:actions.cancel')}}
          v-btn.px-3(variant="flat", color='primary', :disabled='!copySourceCount', @click='copyFromLocale')
            v-icon(start) mdi-chevron-right
            span {{$t('common:actions.copy')}} ({{copySourceCount}})

    page-selector(mode='select', v-model='selectPageModal', :open-handler='selectPageHandle', path='home', :locale='currentLang')</template>

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
        mode: 'NONE',
        expandParent: true
      } as NavigationConfig,
      allLocales: [] as LocaleRow[],
      copyFromLocaleCode: 'en',
      initialLoading: true,
      loaded: false,
      saving: false,
      persistedConfig: null as NavigationConfig | null,
      persistedTrees: [] as NavigationTreeRow[]
    }
  },
  computed: {
    dirty (): boolean {
      return this.persistedConfig !== null && (
        JSON.stringify(this.config) !== JSON.stringify(this.persistedConfig) ||
        JSON.stringify(this.trees) !== JSON.stringify(this.persistedTrees)
      )
    },
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
    copyLocales () {
      return this.locales.filter(locale => locale.code !== this.currentLang)
    },
    copySourceCount () {
      return (_.find(this.trees, ['locale', this.copyFromLocaleCode])?.items || []).length
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
      if (!window.confirm(`Remove this ${item.kind}? This change will be pending until Apply.`)) return
      this.currentTree = _.pull(this.currentTree, item)
      this.current = createEmptyNavigationItem()
    },
    selectItem(item: NavigationItem) {
      this.current = item
    },
    moveItem(index: number, offset: number) {
      const target = index + offset
      if (target < 0 || target >= this.currentTree.length) return
      const next = [...this.currentTree]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      this.currentTree = next
    },
    selectPage() {
      this.selectPageModal = true
    },
    selectPageHandle ({ path, locale }: { path: string, locale: string }) {
      this.current.target = `/${locale}/${path}`
    },
    copyFromLocale () {
      const source = _.get(_.find(this.trees, ['locale', this.copyFromLocaleCode]), 'items', null) || []
      if (source.length < 1) return
      this.copyFromLocaleDialogIsShown = false
      this.currentTree = [...this.currentTree, ..._.cloneDeep(source)]
    },
    async save() {
      if (!this.loaded || this.initialLoading || this.saving || !this.dirty) return
      this.saving = true
      wikiStore.startLoading('admin-navigation-save')
      try {
        await saveNavigation(window.fetch.bind(window), this.trees, this.config.mode, this.config.expandParent)
        this.persistedConfig = _.cloneDeep(this.config)
        this.persistedTrees = _.cloneDeep(this.trees)
        wikiStore.showNotification({
          message: this.$t('admin:navigation.saveSuccess'),
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        this.saving = false
        wikiStore.stopLoading('admin-navigation-save')
      }
    },
    async loadNavigation(notify = false) {
      this.initialLoading = true
      this.loaded = false
      wikiStore.startLoading('admin-navigation-refresh')
      try {
        const navigation = await fetchNavigation(window.fetch.bind(window), 'Navigation response is invalid')
        this.config = _.cloneDeep(navigation.config)
        this.trees = _.cloneDeep(navigation.tree)
        this.persistedConfig = _.cloneDeep(this.config)
        this.persistedTrees = _.cloneDeep(this.trees)
        this.current = createEmptyNavigationItem()
        this.loaded = true
        if (notify) {
          wikiStore.showNotification({
            message: 'Navigation has been refreshed.',
            style: 'success',
            icon: 'cached'
          })
        }
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        this.initialLoading = false
        wikiStore.stopLoading('admin-navigation-refresh')
      }
    },
    async refresh() {
      if (this.dirty && !window.confirm('Discard unsaved navigation changes and refresh?')) return
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
