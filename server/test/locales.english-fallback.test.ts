import { describe, expect, it } from 'vitest'
import englishLocale from '../locales/en.json'

describe('bundled English locale fallback', () => {
  it('contains the critical setup, authentication, and administration labels', () => {
    expect(englishLocale).toMatchObject({
      common: {
        welcome: {
          title: 'Welcome to your wiki!',
          createhome: 'Create Home Page'
        },
        header: {
          admin: 'Administration',
          account: 'Account'
        }
      },
      auth: {
        actions: {
          login: 'Log In'
        }
      },
      admin: {
        dashboard: {
          title: 'Dashboard'
        }
      }
    })
  })
})
