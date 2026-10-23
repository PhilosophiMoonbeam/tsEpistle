import * as yaml from 'js-yaml'
import { afterEach, expect, it } from '../bun-test.mts'
import configHelper from '../../helpers/config'

const keys = ['TSEPISTLE_TEST_DOMAIN', 'TSEPISTLE_TEST_EMAIL', 'TSEPISTLE_TEST_PORT'] as const
const original = new Map(keys.map(key => [key, process.env[key]]))

afterEach(() => {
  for (const key of keys) {
    const value = original.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

it('keeps unset optional YAML fields absent rather than manufacturing configured strings', () => {
  delete process.env.TSEPISTLE_TEST_DOMAIN
  delete process.env.TSEPISTLE_TEST_EMAIL

  const config = yaml.load(configHelper.parseConfigValue(`ssl:
  domain: $(TSEPISTLE_TEST_DOMAIN)
  subscriberEmail: $(TSEPISTLE_TEST_EMAIL)
`))

  expect(config).toEqual({ ssl: { domain: null, subscriberEmail: null } })
})

it('preserves supplied values and explicit defaults for empty and missing variables', () => {
  process.env.TSEPISTLE_TEST_DOMAIN = 'wiki.example.test'
  process.env.TSEPISTLE_TEST_EMAIL = ''
  delete process.env.TSEPISTLE_TEST_PORT

  const config = yaml.load(configHelper.parseConfigValue(`ssl:
  domain: $(TSEPISTLE_TEST_DOMAIN:default.example.test)
  subscriberEmail: $(TSEPISTLE_TEST_EMAIL:operator@example.test)
  port: $(TSEPISTLE_TEST_PORT:8443)
`))

  expect(config).toEqual({ ssl: { domain: 'wiki.example.test', subscriberEmail: 'operator@example.test', port: 8443 } })
})
