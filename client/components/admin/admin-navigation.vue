<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        admin-hero(
          icon='/_assets/svg/icon-triangle-arrow.svg'
          :title='$t(`admin:navigation.title`)'
          :description='$t(`admin:navigation.subtitle`)'
        )
          template(v-slot:status)
            v-chip(v-if='dirty', color='warning', variant='tonal', size='small') Unsaved changes
          template(v-slot:actions)
            v-btn(
              icon
              variant="outlined"
              href='https://docs.requarks.io/navigation'
              target='_blank'
              rel='noopener'
              aria-label='Open navigation documentation in a new tab'
              title='Open navigation documentation'
            )
              v-icon mdi-help-circle
            v-btn(
              icon
              variant="outlined"
              @click='refresh'
              :aria-label='$t(`common:actions.refresh`)'
              title='Refresh navigation settings'
              :loading='initialLoading'
            )
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
        v-alert(
          v-else-if='loadError'
          type='error'
          variant='tonal'
          icon='mdi-alert-circle-outline'
        )
          .text-body-medium Navigation settings could not be loaded.
          .text-body-small.mt-1 {{ loadError }}
          v-btn.mt-3(
            type='button'
            variant='outlined'
            size='small'
            prepend-icon='mdi-refresh'
            @click='loadNavigation()'
          ) Retry
        v-container.pa-0.mt-3(fluid, v-else-if='loaded')
          v-row(density="compact")
            v-col(cols='12', md='3')
              v-card.animated.fadeInUp
                v-toolbar(color='primary', density="compact", flat, height='56')
                  v-toolbar-title.text-body-large {{$t('admin:navigation.mode')}}
                v-list(
                  nav
                  lines='two'
                  role='radiogroup'
                  aria-orientation='vertical'
                  :aria-label='$t(`admin:navigation.mode`)'
                )
                  v-list-item(
                    ref='navigationModeTree'
                    value='TREE'
                    role='radio'
                    :aria-checked='config.mode === `TREE`'
                    :tabindex='config.mode === `TREE` ? 0 : -1'
                    :active='config.mode === `TREE`'
                    @click='selectNavigationMode(`TREE`, true)'
                    @keydown='onNavigationModeKeydown($event, `TREE`)'
                  )
                    template(v-slot:prepend)
                      v-avatar
                        img(src='/_assets/svg/icon-tree-structure-dotted.svg', alt='')
                    v-list-item-title {{$t('admin:navigation.modeSiteTree.title')}}
                    v-list-item-subtitle {{$t('admin:navigation.modeSiteTree.description')}}
                    template(v-slot:append)
                      v-avatar
                        v-icon(:color='config.mode === `TREE` ? `primary` : undefined') mdi-check-circle
                  v-list-item(
                    ref='navigationModeStatic'
                    value='STATIC'
                    role='radio'
                    :aria-checked='config.mode === `STATIC`'
                    :tabindex='config.mode === `STATIC` ? 0 : -1'
                    :active='config.mode === `STATIC`'
                    @click='selectNavigationMode(`STATIC`, true)'
                    @keydown='onNavigationModeKeydown($event, `STATIC`)'
                  )
                    template(v-slot:prepend)
                      v-avatar
                        img(src='/_assets/svg/icon-features-list.svg', alt='')
                    v-list-item-title {{$t('admin:navigation.modeStatic.title')}}
                    v-list-item-subtitle {{$t('admin:navigation.modeStatic.description')}}
                    template(v-slot:append)
                      v-avatar
                        v-icon(:color='config.mode === `STATIC` ? `primary` : undefined') mdi-check-circle
                  v-list-item(
                    ref='navigationModeMixed'
                    value='MIXED'
                    role='radio'
                    :aria-checked='config.mode === `MIXED`'
                    :tabindex='config.mode === `MIXED` ? 0 : -1'
                    :active='config.mode === `MIXED`'
                    @click='selectNavigationMode(`MIXED`, true)'
                    @keydown='onNavigationModeKeydown($event, `MIXED`)'
                  )
                    template(v-slot:prepend)
                      v-avatar
                        img(src='/_assets/svg/icon-user-menu-male-dotted.svg', alt='')
                    v-list-item-title {{$t('admin:navigation.modeCustom.title')}}
                    v-list-item-subtitle {{$t('admin:navigation.modeCustom.description')}}
                    template(v-slot:append)
                      v-avatar
                        v-icon(:color='config.mode === `MIXED` ? `primary` : undefined') mdi-check-circle
                  v-list-item(
                    ref='navigationModeNone'
                    value='NONE'
                    role='radio'
                    :aria-checked='config.mode === `NONE`'
                    :tabindex='config.mode === `NONE` ? 0 : -1'
                    :active='config.mode === `NONE`'
                    @click='selectNavigationMode(`NONE`, true)'
                    @keydown='onNavigationModeKeydown($event, `NONE`)'
                  )
                    template(v-slot:prepend)
                      v-avatar
                        img(src='/_assets/svg/icon-cancel-dotted.svg', alt='')
                    v-list-item-title {{$t('admin:navigation.modeNone.title')}}
                    v-list-item-subtitle {{$t('admin:navigation.modeNone.description')}}
                    template(v-slot:append)
                      v-avatar
                        v-icon(:color='config.mode === `NONE` ? `primary` : undefined') mdi-check-circle
                v-card-text.pt-0
                  v-switch(
                    v-model='config.expandParent'
                    color='primary'
                    inset
                    hide-details
                    label='Open the current page parent by default'
                  )
                  .text-body-small.text-medium-emphasis.mt-2 When enabled, Browse opens at the current page location. Disable it to start at the site root.
            v-col(cols='12', md='9', v-if='config.mode === `MIXED` || config.mode === `STATIC`')
              v-card.animated.fadeInUp.wait-p2s
                v-row.align-stretch(gap='0')
                  v-col(cols='12', lg='5', xl='4')
                    v-card.navigation-builder(flat)
                      .navigation-builder__locale.pa-2.d-flex
                        v-select(
                          :disabled='locales.length < 2'
                          label='Locale'
                          hide-details
                          variant="solo"
                          flat
                          bg-color='surface'
                          density="compact"
                          v-model='currentLang'
                          :items='locales'
                          item-title='nativeName'
                          item-value='code'
                        )
                        v-tooltip(location="top")
                          template(v-slot:activator='{ props }')
                            v-btn.ml-2(icon, variant='text', v-bind='props', :aria-label='$t(`admin:navigation.copyFromLocale`)', :disabled='copyLocales.length < 1', @click='openCopyFromLocaleDialog')
                              v-icon mdi-arrange-send-backward
                          span {{$t('admin:navigation.copyFromLocale')}}
                      v-list.navigation-tree.py-2(density="compact", nav)
                        v-list-item.navigation-tree__home
                          template(v-slot:prepend)
                            v-avatar(size='24', rounded='0')
                              v-icon mdi-home
                          v-list-item-title {{$t('common:header.home')}}
                          template(v-slot:append)
                            v-icon(size='18', aria-hidden='true') mdi-lock
                        v-list-item(v-if='currentTree.length < 1')
                          template(v-slot:prepend)
                            v-avatar(size='24'): v-icon(color="secondary") mdi-alert
                          em.text-body-small.text-medium-emphasis {{$t('admin:navigation.emptyList')}}
                        draggable(v-model='currentTree', handle='.nav-drag-handle')
                          template(v-for='navItem in currentTree', :key='navItem.id')
                            v-list-item(
                              v-if='navItem.kind === "link"'
                              tabindex='0'
                              :aria-label='itemSelectionLabel(navItem)'
                              :class='{ "is-selected": navItem === current }'
                              @click='selectItem(navItem)'
                            )
                              template(v-slot:prepend)
                                v-btn.nav-drag-handle(icon, size='small', variant='text', :aria-label='`Reorder ${navItem.label}`', @click.stop='selectItem(navItem)')
                                  v-icon(size='18') mdi-drag-horizontal
                                v-avatar(size='24', rounded='0')
                                  v-icon(v-if='navItem.icon?.match(/fa[a-z] fa-/)', size='19') {{ navItem.icon }}
                                  v-icon(v-else) {{ navItem.icon }}
                              v-list-item-title {{navItem.label}}
                            .py-2.clickable(
                              v-else-if='navItem.kind === "divider"'
                              tabindex='0'
                              :aria-label='itemSelectionLabel(navItem)'
                              :class='{ "is-selected": navItem === current }'
                              @click='selectItem(navItem)'
                              @keydown.enter.prevent='selectItem(navItem)'
                              @keydown.space.prevent='selectItem(navItem)'
                            )
                              v-btn.nav-drag-handle(icon, size='small', variant='text', :aria-label='`Reorder divider`', @click.stop='selectItem(navItem)')
                                v-icon(size='18') mdi-drag-horizontal
                              v-divider
                            v-list-subheader.pl-4.clickable(
                              v-else-if='navItem.kind === "header"'
                              tabindex='0'
                              :aria-label='itemSelectionLabel(navItem)'
                              :class='{ "is-selected": navItem === current }'
                              @click='selectItem(navItem)'
                              @keydown.enter.prevent='selectItem(navItem)'
                              @keydown.space.prevent='selectItem(navItem)'
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
                    v-card(flat, style='border-radius: 0 var(--wiki-control-radius) var(--wiki-control-radius) 0;')
                      template(v-if='current.kind === "link"')
                        v-toolbar(height='56', color="surface-variant", flat)
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
                          .text-body-small.pl-5 Refer to the #[a(href='https://materialdesignicons.com/', target='_blank', rel='noopener') Material Design Icons Reference] for the list of all possible values. You must prefix all values with #[code mdi-], e.g. #[code mdi-home]
                          .text-body-small.pt-3.pl-5: strong Font Awesome 5
                          .text-body-small.pl-5 Refer to the #[a(href='https://fontawesome.com/icons?d=gallery&m=free', target='_blank', rel='noopener') Font Awesome 5 Reference] for the list of all possible values. You must prefix all values with #[code fas fa-], e.g. #[code fas fa-home]. Note that some icons use different prefixes (e.g. #[code fab], #[code fad], #[code fal], #[code far]).
                          .text-body-small.pt-3.pl-5: strong Font Awesome 4
                          .text-body-small.pl-5 Refer to the #[a(href='https://fontawesome.com/v4.7.0/icons/', target='_blank', rel='noopener') Font Awesome 4 Reference] for the list of all possible values. You must prefix all values with #[code fa fa-], e.g. #[code fa fa-home]
                        v-divider
                        v-card-text
                          v-select(
                            variant="outlined"
                            :label='$t("admin:navigation.targetType")'
                            prepend-icon='mdi-near-me'
                            :items='navTypes'
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
                        v-toolbar(height='56', color="surface-variant", flat)
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
                        v-toolbar(height='56', color="surface-variant", flat)
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
                        v-toolbar(height='56', color="surface-variant", flat)
                        v-card-text.text-medium-emphasis(v-if='currentTree.length > 0') {{$t('admin:navigation.noSelectionText')}}
                        v-card-text.text-medium-emphasis(v-else) {{$t('admin:navigation.noItemsText')}}

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
    v-dialog(v-model='copyFromLocaleDialogIsShown', max-width='650', persistent, aria-labelledby='copy-navigation-dialog-title')
      v-card
        .dialog-header.is-short.is-primary
          v-icon.mr-3(color='white') mdi-arrange-send-backward
          span#copy-navigation-dialog-title {{$t('admin:navigation.copyFromLocale')}}
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
import { markRaw } from 'vue'

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

const isHomeLink = (item: NavigationItem): boolean =>
  item.kind === 'link' && item.targetType === 'home'

const normalizeNavigationItems = (items: NavigationItem[]): NavigationItem[] =>
  items.filter(item => !isHomeLink(item))

const normalizeNavigationTrees = (trees: NavigationTreeRow[]): NavigationTreeRow[] =>
  trees.map(tree => ({
    ...tree,
    items: normalizeNavigationItems(tree.items)
  }))

const NAVIGATION_MODES = ['TREE', 'STATIC', 'MIXED', 'NONE'] as const
type NavigationMode = typeof NAVIGATION_MODES[number]

const NAVIGATION_MODE_REFS: Record<NavigationMode, string> = {
  TREE: 'navigationModeTree',
  STATIC: 'navigationModeStatic',
  MIXED: 'navigationModeMixed',
  NONE: 'navigationModeNone'
}

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
      copyFromLocaleCode: '',
      initialLoading: true,
      loaded: false,
      saving: false,
      persistedConfig: null as NavigationConfig | null,
      persistedTrees: [] as NavigationTreeRow[],
      loadError: ''
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
        { title: this.$t('admin:navigation.navType.external'), value: 'external' },
        { title: this.$t('admin:navigation.navType.externalblank'), value: 'externalblank' },
        { title: this.$t('admin:navigation.navType.page'), value: 'page' }
        // { title: this.$t('admin:navigation.navType.searchQuery'), value: 'search' }
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
      return normalizeNavigationItems(_.find(this.trees, ['locale', this.copyFromLocaleCode])?.items || []).length
    },
    currentTree: {
      get () {
        return _.get(_.find(this.trees, ['locale', this.currentLang]), 'items', null) || []
      },
      set (val: NavigationItem[]) {
        const tree = _.find(this.trees, ['locale', this.currentLang])
        if (tree) {
          tree.items = normalizeNavigationItems(val)
        } else {
          this.trees = [...this.trees, {
            locale: this.currentLang,
            items: normalizeNavigationItems(val)
          }]
        }
      }
    }
  },
  watch: {
    currentLang () {
      this.current = this.currentTree[0] || createEmptyNavigationItem()
    }
  },
  methods: {
    async loadAllLocales() {
      wikiStore.startLoading('admin-navigation-locales')
      try {
        this.allLocales = markRaw(await fetchLocales(window.fetch.bind(window), 'Locales response is invalid'))
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
        this.groups = markRaw(await fetchGroupOptions(window.fetch.bind(window), 'Groups response is invalid'))
      } catch (err) {
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      }
      wikiStore.stopLoading('admin-navigation-groups')
    },
    selectNavigationMode (mode: NavigationMode, focus = false) {
      this.config.mode = mode
      if (focus) this.focusNavigationMode(mode)
    },
    focusNavigationMode (mode: NavigationMode) {
      this.$nextTick(() => {
        const control = this.$refs[NAVIGATION_MODE_REFS[mode]] as {
          focus?: () => void
          $el?: HTMLElement
        } | undefined
        if (control?.focus) control.focus()
        else control?.$el?.focus()
      })
    },
    onNavigationModeKeydown (event: KeyboardEvent, mode: NavigationMode) {
      const currentIndex = NAVIGATION_MODES.indexOf(mode)
      let targetIndex = currentIndex
      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowRight':
          targetIndex = (currentIndex + 1) % NAVIGATION_MODES.length
          break
        case 'ArrowUp':
        case 'ArrowLeft':
          targetIndex = (currentIndex - 1 + NAVIGATION_MODES.length) % NAVIGATION_MODES.length
          break
        case 'Home':
          targetIndex = 0
          break
        case 'End':
          targetIndex = NAVIGATION_MODES.length - 1
          break
        case ' ':
          break
        default:
          return
      }
      event.preventDefault()
      const targetMode = NAVIGATION_MODES[targetIndex]
      this.selectNavigationMode(targetMode, true)
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
            targetType: 'page',
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
      this.currentTree = this.currentTree.filter(candidate => candidate !== item)
      this.current = createEmptyNavigationItem()
    },
    selectItem(item: NavigationItem) {
      this.current = item
    },
    itemSelectionLabel (item: NavigationItem) {
      const label = item.kind === 'divider' ? 'Divider' : item.label || 'Untitled navigation item'
      return item === this.current ? `${label}, selected` : label
    },
    selectPage() {
      this.selectPageModal = true
    },
    selectPageHandle ({ path, locale }: { path: string, locale: string }) {
      this.current.target = `/${locale}/${path}`
    },
    openCopyFromLocaleDialog () {
      if (!this.copyLocales.some(locale => locale.code === this.copyFromLocaleCode)) {
        this.copyFromLocaleCode = this.copyLocales[0]?.code || ''
      }
      this.copyFromLocaleDialogIsShown = true
    },
    copyFromLocale () {
      if (!this.copyLocales.some(locale => locale.code === this.copyFromLocaleCode)) return
      const source = normalizeNavigationItems(_.get(_.find(this.trees, ['locale', this.copyFromLocaleCode]), 'items', null) || [])
      if (source.length < 1) return
      this.copyFromLocaleDialogIsShown = false
      const copies = _.cloneDeep(source).map(item => ({ ...item, id: crypto.randomUUID() }))
      this.currentTree = [...this.currentTree, ...copies]
    },
    async save() {
      if (!this.loaded || this.initialLoading || this.saving || !this.dirty) return
      this.saving = true
      wikiStore.startLoading('admin-navigation-save')
      try {
        const normalizedTrees = normalizeNavigationTrees(this.trees)
        const savedTrees = _.cloneDeep(normalizedTrees)
        const savedConfig = _.cloneDeep(this.config)
        this.trees = normalizedTrees
        await saveNavigation(window.fetch.bind(window), savedTrees, savedConfig.mode, savedConfig.expandParent)
        this.persistedConfig = markRaw(savedConfig)
        this.persistedTrees = markRaw(savedTrees)
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
      this.loadError = ''
      wikiStore.startLoading('admin-navigation-refresh')
      try {
        const navigation = await fetchNavigation(window.fetch.bind(window), 'Navigation response is invalid')
        const normalizedTrees = normalizeNavigationTrees(navigation.tree)
        this.config = _.cloneDeep(navigation.config)
        this.trees = _.cloneDeep(normalizedTrees)
        this.persistedConfig = markRaw(_.cloneDeep(this.config))
        this.persistedTrees = markRaw(_.cloneDeep(normalizedTrees))
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
        this.loadError = getErrorMessage(err)
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

.navigation-builder {
  height: 100%;
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-radius-sm) 0 0 var(--wiki-radius-sm) !important;
  background: var(--wiki-surface-soft);
}

.navigation-builder__locale {
  height: 56px;
  gap: var(--wiki-space-2);
  align-items: center;
  border-bottom: 1px solid var(--wiki-surface-border);
  background:
    radial-gradient(circle at 0 0, color-mix(in srgb, rgb(var(--v-theme-primary)) 14%, transparent), transparent 62%),
    rgb(var(--v-theme-surface-variant));
}

.navigation-tree {
  min-height: 14rem;
  border-radius: 0 !important;
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 94%, rgb(var(--v-theme-primary)) 6%) !important;
  color: rgb(var(--v-theme-on-surface));
}

.navigation-tree :deep(.v-list-item),
.clickable {
  margin: 2px var(--wiki-space-2);
  border: 1px solid transparent;
  border-radius: var(--wiki-radius-xs);
  transition:
    background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    border-color var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.navigation-tree :deep(.is-selected),
.clickable.is-selected {
  border-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 32%, transparent);
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 16%, transparent) !important;
  color: rgb(var(--v-theme-on-surface)) !important;
}

.clickable {
  cursor: pointer;

  &:hover {
    background-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, transparent);
  }
}

</style>
