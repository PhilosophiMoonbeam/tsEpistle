import { reactive, type App } from 'vue'
import { createVuetify, type VuetifyOptions } from 'vuetify'

/** Real public Vuetify globals for script/template harnesses with visual stubs.
 * Does not replace the harness's stub components or install global styles.
 * Tests exercising real Vuetify controls should install the plugin instead.
 */
export function installVuetifyFixture(app: App, options: VuetifyOptions = {}): void {
  const vuetify = createVuetify(options)
  app.config.globalProperties.$vuetify = reactive({
    defaults: vuetify.defaults,
    display: vuetify.display,
    theme: vuetify.theme,
    icons: vuetify.icons,
    locale: vuetify.locale,
    date: vuetify.date.instance
  })
  app.onUnmount(() => vuetify.unmount())
}
