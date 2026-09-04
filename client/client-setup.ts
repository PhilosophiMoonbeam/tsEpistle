import { createApp } from 'vue'
import { createVuetify } from 'vuetify'
import boot from './modules/boot.ts'
import { createAsyncComponent } from './components/common/async-component-state.vue'

const Setup = createAsyncComponent(() => import('./components/setup.vue'))
const vuetify = createVuetify({
  defaults: {
    VCard: {
      elevation: 0,
      rounded: 'lg',
      variant: 'flat'
    },
    VBtn: {
      elevation: 0,
      class: 'text-none'
    },
    VTextField: {
      baseColor: 'on-surface',
      color: 'primary',
      rounded: 'lg',
      variant: 'outlined'
    },
    VTextarea: {
      baseColor: 'on-surface',
      color: 'primary',
      rounded: 'lg',
      variant: 'outlined'
    },
    VSelect: {
      baseColor: 'on-surface',
      color: 'primary',
      rounded: 'lg',
      variant: 'outlined'
    },
    VDialog: {
      scrim: 'on-surface',
      transition: 'dialog-transition'
    },
    VMenu: {
      offset: 8,
      transition: 'fade-transition'
    },
    VTooltip: {
      location: 'bottom',
      offset: 8,
      openDelay: 400,
      transition: 'fade-transition'
    }
  }
})

window.WIKI = null
window.boot = boot

boot.onDOMReady(() => {
  const app = createApp({})
  app.component('Setup', Setup)
  app.use(vuetify)
  window.WIKI = app
  app.mount('#root')
})
