import fs from 'node:fs/promises'
import path from 'node:path'
import { load } from 'js-yaml'

const sensitiveProps = {
  auth0: ['clientSecret'],
  azure: ['cookieEncryptionKeyString'],
  discord: ['clientSecret'],
  dropbox: ['clientSecret'],
  facebook: ['clientSecret'],
  github: ['clientSecret'],
  gitlab: ['clientSecret'],
  google: ['clientSecret'],
  keycloak: ['clientSecret'],
  ldap: ['bindCredentials'],
  microsoft: ['clientSecret'],
  oauth2: ['clientSecret'],
  oidc: ['clientSecret'],
  okta: ['clientSecret'],
  rocketchat: ['clientSecret'],
  saml: ['privateKey', 'decryptionPvk'],
  slack: ['clientSecret'],
  twitch: ['clientSecret']
}

describe('authentication credential definitions', () => {
  it.each(Object.entries(sensitiveProps))('declares %s credentials as write-only', async (strategy, properties) => {
    const source = await fs.readFile(path.join(process.cwd(), 'server/modules/authentication', strategy, 'definition.yml'), 'utf8')
    const definition = load(source)
    for (const property of properties) {
      expect(definition.props[property].sensitive, `${strategy}.${property}`).toBe(true)
    }
  })
})
