import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import './scss/app.scss'
import './themes/default/scss/app.scss'
import { offlinePresentation } from './helpers/offline-presentation.ts'

const { config, appearance } = offlinePresentation()
window.siteConfig = config
window.siteLangs = []
document.documentElement.lang = config.lang
document.documentElement.dir = config.rtl ? 'rtl' : 'ltr'
// Store/header modules read the bootstrap at module evaluation time.
const { mountOfflineApp } = await import('./offline-client.ts')
await mountOfflineApp(appearance)
