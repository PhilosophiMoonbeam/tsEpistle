import { createApp, defineAsyncComponent, type AsyncComponentLoader } from 'vue'
import { createVuetify } from 'vuetify'
import Hammer from 'hammerjs'
import moment from 'moment-timezone'
import _ from 'lodash'
import helpersPlugin from './helpers/index.ts'
import boot from './modules/boot.ts'
import localization from './modules/localization.ts'
import { pinia, wikiStore } from './store/index.ts'
import { router } from './router'
import { createWikiThemes, resolveThemeName } from './helpers/theme.ts'
import { normalizeThemeColors } from '../shared/theme-colors.ts'

const asyncComponent = (name: string, loader: AsyncComponentLoader) => [name, defineAsyncComponent(loader)] as const

const registrations = [
  asyncComponent('Admin', () => import('./components/admin.vue')),
  asyncComponent('Comments', () => import('./components/comments.vue')),
  asyncComponent('Editor', () => import('./components/editor.vue')),
  asyncComponent('History', () => import('./components/history.vue')),
  asyncComponent('Loader', () => import('./components/common/loader.vue')),
  asyncComponent('Login', () => import('./components/login.vue')),
  asyncComponent('NavHeader', () => import('./components/common/nav-header.vue')),
  asyncComponent('NewPage', () => import('./components/new-page.vue')),
  asyncComponent('Notify', () => import('./components/common/notify.vue')),
  asyncComponent('NotFound', () => import('./components/not-found.vue')),
  asyncComponent('PageSelector', () => import('./components/common/page-selector.vue')),
  asyncComponent('PageUnlock', () => import('./components/page-unlock.vue')),
  asyncComponent('PageSource', () => import('./components/source.vue')),
  asyncComponent('Profile', () => import('./components/profile.vue')),
  asyncComponent('Register', () => import('./components/register.vue')),
  asyncComponent('SearchResults', () => import('./components/common/search-results.vue')),
  asyncComponent('SocialSharing', () => import('./components/common/social-sharing.vue')),
  asyncComponent('Tags', () => import('./components/tags.vue')),
  asyncComponent('Unauthorized', () => import('./components/unauthorized.vue')),
  asyncComponent('VCardChin', () => import('./components/common/v-card-chin.vue')),
  asyncComponent('VCardInfo', () => import('./components/common/v-card-info.vue')),
  asyncComponent('Welcome', () => import('./components/welcome.vue')),
  asyncComponent('VueScroll', () => import('./components/common/vue-scroll.vue')),
  asyncComponent('NavFooter', () => import('./themes/default/components/nav-footer.vue')),
  asyncComponent('Page', () => import('./themes/default/components/page.vue'))
]


wikiStore.refreshAuth()

const vuetify = createVuetify({
  locale: { rtl: { [siteConfig.lang]: siteConfig.rtl }, locale: siteConfig.lang },
  theme: {
    defaultTheme: resolveThemeName(wikiStore.user.appearance, siteConfig.darkMode),
    themes: createWikiThemes(normalizeThemeColors(siteConfig.themeColors)),
    transition: { duration: '180ms' }
  }
})

const i18n = await localization.init()
const app = createApp({})

for (const [name, component] of registrations) app.component(name, component)

app.use(pinia)
app.use(router)
app.use(vuetify)
app.use(i18n)
app.use(helpersPlugin)


app.config.globalProperties.$lodash = _
app.config.globalProperties.$moment = moment

window.Hammer = Hammer
window.WIKI = app
window.boot = boot

moment.locale(siteConfig.lang)
if (wikiStore.user.dateFormat) {
  moment.updateLocale(moment.locale(), { longDateFormat: { L: wikiStore.user.dateFormat } } as moment.LocaleSpecification)
}
if (wikiStore.user.timezone) moment.tz.setDefault(wikiStore.user.timezone)

app.mount('#root')
