import { createApp } from 'vue'
import OfflineApp from './offline-app.vue'

const mountPoint = document.getElementById('offline-app')
if (!mountPoint) throw new Error('The neutral offline shell mount point is missing.')

createApp(OfflineApp).mount(mountPoint)
