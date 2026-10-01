import fs from 'node:fs/promises'
import path from 'node:path'
import { load } from 'js-yaml'
import { fetchAdminAuthStrategies } from '../../../client/helpers/auth-api.ts'

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

  it('publishes client-compatible Dropbox setup without explicit scopes', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'server/modules/authentication/dropbox/definition.yml'), 'utf8')
    const definition = load(source)

    expect(definition.key).toBe('dropbox')
    // Use the definition catalog's wire shape, retaining the real YAML setup metadata.
    const catalog = [{
      ...definition,
      isAvailable: definition.isAvailable === true,
      props: Object.entries(definition.props).map(([key, value]) => ({ key, value: JSON.stringify(value) }))
    }]
    const [strategy] = await fetchAdminAuthStrategies(async () => ({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => catalog
    }))
    expect(strategy.key).toBe('dropbox')
    expect(strategy).toHaveProperty('setup.documentationUrl')
    expect(new URL(strategy.setup.documentationUrl).protocol).toBe('https:')
    expect(definition).not.toHaveProperty('scopes')
  })
})
