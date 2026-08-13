import type { App } from 'vue'
import i18next from 'i18next'
import Backend from 'i18next-chained-backend'
import LocalStorageBackend from 'i18next-localstorage-backend'
import HttpBackend from 'i18next-http-backend'
import _ from 'lodash'

const parseKey = (key: string): { namespace: string, path: string } => {
  const separator = key.indexOf(':')
  return separator < 0
    ? { namespace: 'common', path: key }
    : { namespace: key.slice(0, separator), path: key.slice(separator + 1) }
}

const plugin = {
  install (app: App) {
    app.config.globalProperties.$t = (key: string, options?: Record<string, unknown>) => {
      const { namespace, path } = parseKey(key)
      return i18next.t(path, { ns: namespace, ...options })
    }
    app.config.globalProperties.$i18n = i18next
  }
}

export default {
  init () {
    void i18next
      .use(Backend)
      .init({
        backend: {
          backends: [LocalStorageBackend, HttpBackend],
          backendOptions: [
            { expirationTime: 1000 * 60 * 60 * 24 },
            {
              loadPath: '/_api/locales/{{lng}}/strings?namespace={{ns}}',
              requestOptions: {
                credentials: 'same-origin',
                headers: { Accept: 'application/json' }
              },
              parse: (data: string) => {
                const entries: unknown = JSON.parse(data)
                const strings: Record<string, unknown> = {}
                if (Array.isArray(entries)) {
                  for (const entry of entries) {
                    if (
                      typeof entry === 'object' &&
                      entry !== null &&
                      'key' in entry &&
                      typeof entry.key === 'string' &&
                      'value' in entry
                    ) {
                      _.set(strings, entry.key, entry.value)
                    }
                  }
                }
                return strings
              }
            }
          ]
        },
        defaultNS: 'common',
        lng: siteConfig.lang,
        load: 'currentOnly',
        lowerCaseLng: true,
        fallbackLng: siteConfig.lang,
        ns: ['common', 'auth', 'admin', 'editor', 'history', 'profile', 'tags']
      })
    return plugin
  }
}
