import { createApp } from 'vue'
import { createVuetify } from 'vuetify'
import boot from './modules/boot.ts'
import { createAsyncComponent } from './components/common/async-component-state.vue'

const Setup = createAsyncComponent(() => import('./components/setup.vue'))
const vuetify = createVuetify()

window.WIKI = null
window.boot = boot

boot.onDOMReady(() => {
  const app = createApp({})
  app.component('Setup', Setup)
  app.use(vuetify)
  window.WIKI = app
  app.mount('#root')
})
