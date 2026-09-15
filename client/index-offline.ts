import { createApp } from 'vue'
import OfflineApp from './offline-app.vue'
import { registerPwa, setReloadSafetyProvider } from './helpers/pwa.ts'

const mountPoint = document.getElementById('offline-app')
if (!mountPoint) throw new Error('The neutral offline shell mount point is missing.')

// The neutral shell has no editor memory or publish request, so the lifecycle
// can acknowledge that a foreground update reload is safe.
setReloadSafetyProvider(() => true)
void registerPwa({
  onNeedReload: () => {
    window.location.reload()
  }
})
createApp(OfflineApp).mount(mountPoint)
