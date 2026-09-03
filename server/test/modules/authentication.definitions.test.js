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

  it('publishes the current Dropbox App Console setup without explicit scopes', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'server/modules/authentication/dropbox/definition.yml'), 'utf8')
    const definition = load(source)

    expect(definition).toMatchObject({
      key: 'dropbox',
      description: 'Authenticate users with their Dropbox accounts.',
      website: 'https://www.dropbox.com/developers/apps',
      props: {
        clientId: {
          title: 'App Key',
          hint: 'Copy the App key from the Dropbox App Console'
        },
        clientSecret: {
          title: 'App Secret',
          hint: 'Copy the App secret from the Dropbox App Console',
          sensitive: true
        }
      },
      setup: {
        title: 'Dropbox App Console setup',
        documentationUrl: 'https://developers.dropbox.com/oauth-guide',
        steps: [
          'Create a new app in the Dropbox App Console with Scoped access.',
          'Select the least-privilege App folder access type, not Full Dropbox.',
          'On Permissions, leave only the required account_info.read permission enabled.',
          'On Settings, disable the implicit grant.',
          'Under Settings > OAuth 2 > Redirect URIs, register the exact tsEpistle callback URL shown for this strategy; production requires HTTPS, while HTTP is only for localhost development.',
          'Copy the App key and App secret into the existing App Key and App Secret fields below.',
          'In Development status, a new app initially connects only its owner; click Enable additional users for a limited testing/internal audience; Production approval is needed for broader distribution.',
          "Enable and save the Dropbox strategy, then choose self-registration and groups according to your site's policy."
        ]
      }
    })
    expect(definition).not.toHaveProperty('scopes')
  })
})
