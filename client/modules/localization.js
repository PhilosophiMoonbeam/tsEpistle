import i18next from 'i18next'
import Backend from 'i18next-chained-backend'
import LocalStorageBackend from 'i18next-localstorage-backend'
import i18nextXHR from 'i18next-xhr-backend'
import VueI18Next from '@panter/vue-i18next'
import _ from 'lodash'

/* global siteConfig */

export default {
  VueI18Next,
  init() {
    i18next
      .use(Backend)
      .init({
        backend: {
          backends: [
            LocalStorageBackend,
            i18nextXHR
          ],
          backendOptions: [
            {
              expirationTime: 1000 * 60 * 60 * 24 // 24h
            },
            {
              loadPath: '{{lng}}/{{ns}}',
              parse: (data) => data,
              ajax: (url, opts, cb, data) => {
                const langParams = url.split('/')
                window.fetch(`/_api/locales/${encodeURIComponent(langParams[0])}/strings?namespace=${encodeURIComponent(langParams[1])}`, {
                  credentials: 'same-origin',
                  headers: { Accept: 'application/json' }
                }).then(async response => {
                  if (!response.ok) throw new Error('Translations request failed')
                  const entries = await response.json()
                  const ns = {}
                  if (Array.isArray(entries)) {
                    entries.forEach(entry => {
                      _.set(ns, entry.key, entry.value)
                    })
                  }
                  return cb(ns, {status: '200'})
                }).catch(err => {
                  console.error(err)
                  return cb(null, {status: '404'})
                })
              }
            }
          ]
        },
        defaultNS: 'common',
        lng: siteConfig.lang,
        load: 'currentOnly',
        lowerCaseLng: true,
        fallbackLng: siteConfig.lang,
        ns: ['common', 'auth']
      })
    return new VueI18Next(i18next)
  }
}
