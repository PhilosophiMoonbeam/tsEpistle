/* global siteConfig */

import Vue from 'vue'
import VueRouter from 'vue-router'
import VueClipboards from 'vue-clipboards'
import Vuetify from 'vuetify/lib'
import Vuescroll from 'vuescroll/dist/vuescroll-native'
import Hammer from 'hammerjs'
import moment from 'moment-timezone'
import store from './store'

// ====================================
// Load Modules
// ====================================

import boot from './modules/boot'
import localization from './modules/localization'

// ====================================
// Load Helpers
// ====================================

import helpers from './helpers'

// ====================================
// Initialize Global Vars
// ====================================

window.WIKI = null
window.boot = boot
window.Hammer = Hammer

moment.locale(siteConfig.lang)

store.commit('user/REFRESH_AUTH')

// ====================================
// Initialize Vue Modules
// ====================================

Vue.config.productionTip = false

Vue.use(VueRouter)
Vue.use(VueClipboards)
Vue.use(localization.VueI18Next)
Vue.use(helpers)
Vue.use(Vuetify)
Vue.use(Vuescroll)

// ====================================
// Register Vue Components
// ====================================

Vue.component('Admin', () => import(/* webpackChunkName: "admin" */ './components/admin.vue'))
Vue.component('Comments', () => import(/* webpackChunkName: "comments" */ './components/comments.vue'))
Vue.component('Editor', () => import(/* webpackPrefetch: -100, webpackChunkName: "editor" */ './components/editor.vue'))
Vue.component('History', () => import(/* webpackChunkName: "history" */ './components/history.vue'))
Vue.component('Loader', () => import(/* webpackPrefetch: true, webpackChunkName: "ui-extra" */ './components/common/loader.vue'))
Vue.component('Login', () => import(/* webpackPrefetch: true, webpackChunkName: "login" */ './components/login.vue'))
Vue.component('NavHeader', () => import(/* webpackMode: "eager" */ './components/common/nav-header.vue'))
Vue.component('NewPage', () => import(/* webpackChunkName: "new-page" */ './components/new-page.vue'))
Vue.component('Notify', () => import(/* webpackMode: "eager" */ './components/common/notify.vue'))
Vue.component('NotFound', () => import(/* webpackChunkName: "not-found" */ './components/not-found.vue'))
Vue.component('PageSelector', () => import(/* webpackPrefetch: true, webpackChunkName: "ui-extra" */ './components/common/page-selector.vue'))
Vue.component('PageSource', () => import(/* webpackChunkName: "source" */ './components/source.vue'))
Vue.component('Profile', () => import(/* webpackChunkName: "profile" */ './components/profile.vue'))
Vue.component('Register', () => import(/* webpackChunkName: "register" */ './components/register.vue'))
Vue.component('SearchResults', () => import(/* webpackPrefetch: true, webpackChunkName: "ui-extra" */ './components/common/search-results.vue'))
Vue.component('SocialSharing', () => import(/* webpackPrefetch: true, webpackChunkName: "ui-extra" */ './components/common/social-sharing.vue'))
Vue.component('Tags', () => import(/* webpackChunkName: "tags" */ './components/tags.vue'))
Vue.component('Unauthorized', () => import(/* webpackChunkName: "unauthorized" */ './components/unauthorized.vue'))
Vue.component('VCardChin', () => import(/* webpackPrefetch: true, webpackChunkName: "ui-extra" */ './components/common/v-card-chin.vue'))
Vue.component('VCardInfo', () => import(/* webpackPrefetch: true, webpackChunkName: "ui-extra" */ './components/common/v-card-info.vue'))
Vue.component('Welcome', () => import(/* webpackChunkName: "welcome" */ './components/welcome.vue'))

Vue.component('NavFooter', () => import(/* webpackChunkName: "theme" */ './themes/' + siteConfig.theme + '/components/nav-footer.vue'))
Vue.component('Page', () => import(/* webpackChunkName: "theme" */ './themes/' + siteConfig.theme + '/components/page.vue'))

let bootstrap = () => {
  // ====================================
  // Notifications
  // ====================================

  window.addEventListener('beforeunload', () => {
    store.dispatch('startLoading')
  })

  // ====================================
  // Bootstrap Vue
  // ====================================

  const i18n = localization.init()

  let darkModeEnabled = siteConfig.darkMode
  if ((store.get('user/appearance') || '').length > 0) {
    darkModeEnabled = (store.get('user/appearance') === 'dark')
  }

  window.WIKI = new Vue({
    el: '#root',
    components: {},
    mixins: [helpers],
    store,
    i18n,
    vuetify: new Vuetify({
      rtl: siteConfig.rtl,
      theme: {
        dark: darkModeEnabled
      }
    }),
    mounted () {
      this.$moment.locale(siteConfig.lang)
      if ((store.get('user/dateFormat') || '').length > 0) {
        this.$moment.updateLocale(this.$moment.locale(), {
          longDateFormat: {
            'L': store.get('user/dateFormat')
          }
        })
      }
      if ((store.get('user/timezone') || '').length > 0) {
        this.$moment.tz.setDefault(store.get('user/timezone'))
      }
    }
  })

  // ----------------------------------
  // Dispatch boot ready
  // ----------------------------------

  boot.notify('vue')
}

boot.onDOMReady(bootstrap)
