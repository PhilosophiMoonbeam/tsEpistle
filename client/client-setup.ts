import { createApp, defineAsyncComponent } from 'vue'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import boot from './modules/boot.ts'

const Setup = defineAsyncComponent(() => import('./components/setup.vue'))
const vuetify = createVuetify({ components, directives })

window.WIKI = null
window.boot = boot

boot.onDOMReady(() => {
  const app = createApp({})
  app.component('Setup', Setup)
  app.use(vuetify)
  window.WIKI = app
  app.mount('#root')
})
