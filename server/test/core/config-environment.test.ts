import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { afterAll, expect, it } from '../bun-test.mts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const directory = mkdtempSync(path.join(tmpdir(), 'tsepistle-config-environment-'))
const configFile = path.join(directory, 'config.yml')
const shipped = readFileSync(path.join(root, 'dev/build/config.yml'), 'utf8')
const startup = `
  import configService from './server/core/config.ts'
  globalThis.WIKI = { ROOTPATH: ${JSON.stringify(root)}, SERVERPATH: ${JSON.stringify(path.join(root, 'server'))} }
  configService.init()
  console.log(JSON.stringify({ db: WIKI.config.db, ssl: WIKI.config.ssl }))
`

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const start = (overrides: Record<string, string | undefined> = {}, source = shipped) => {
  writeFileSync(configFile, source, { mode: 0o600 })
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    CONFIG_FILE: configFile,
    DB_HOST: 'database.example.test',
    DB_PORT: '5432',
    DB_USER: 'fixture-user',
    DB_PASS: 'fixture-password',
    DB_NAME: 'fixture-database',
    DB_SSL: 'false',
    SSL_ACTIVE: 'false',
    HA_ACTIVE: 'false',
    ...overrides
  }
  const child = spawnSync(process.execPath, ['--no-env-file', '--eval', startup], { cwd: root, env, encoding: 'utf8', timeout: 20_000 })
  if (child.error) throw child.error
  const lastLine = child.stdout.trim().split('\n').at(-1)
  const config = child.status === 0 && lastLine ? JSON.parse(lastLine) : null
  return { status: child.status, stderr: child.stderr, config }
}

it('loads the shipped PostgreSQL configuration with absent optional TLS and unused storage variables', () => {
  const result = start()

  expect(result.status).toBe(0)
  expect(result.config.ssl).toMatchObject({ enabled: false, domain: null, subscriberEmail: null })
  expect(result.config.db).toMatchObject({ host: 'database.example.test', user: 'fixture-user', pass: 'fixture-password', port: 5432, db: 'fixture-database' })
})

it('rejects an unresolved quoted password before ambient PostgreSQL credentials can replace it', () => {
  const result = start({ DB_PASS: undefined, PGPASSWORD: 'unintended-ambient-password' })

  expect(result.status).toBe(1)
  expect(result.stderr).toContain('DB_PASS')
  expect(result.stderr).not.toContain('unintended-ambient-password')
})

it('rejects an unresolved unquoted port before ambient PostgreSQL target selection can replace it', () => {
  const result = start({ DB_PORT: undefined, PGPORT: '6543' })

  expect(result.status).toBe(1)
  expect(result.stderr).toContain('DB_PORT')
})

it('retains DATABASE_URL precedence over unresolved individual connection placeholders', () => {
  const result = start({
    DATABASE_URL: 'postgresql://fixture:fixture@url-database.example.test/fixture',
    DB_HOST: undefined,
    DB_USER: undefined,
    DB_PASS: undefined,
    DB_PORT: undefined,
    DB_NAME: undefined,
    LETSENCRYPT_DOMAIN: 'wiki.example.test',
    LETSENCRYPT_EMAIL: 'operator@example.test'
  })

  expect(result.status).toBe(0)
  expect(result.config.ssl).toMatchObject({ domain: 'wiki.example.test', subscriberEmail: 'operator@example.test' })
})

it('reads DB_PASS_FILE before validation when the shadowed password placeholder is absent', () => {
  const secretFile = path.join(directory, 'database-secret')
  writeFileSync(secretFile, 'file-owned-fixture-password\n', { mode: 0o600 })
  const result = start({ DB_PASS: undefined, DB_PASS_FILE: secretFile })

  expect(result.status).toBe(0)
  expect(result.config.db.pass).toBe('file-owned-fixture-password')
})

it('preserves intentionally literal empty database passwords', () => {
  const result = start({}, yaml.dump({ port: 3000, db: { type: 'postgres', host: 'database.example.test', user: 'fixture-user', pass: '', db: 'fixture-database' } }))

  expect(result.status).toBe(0)
  expect(result.config.db).toMatchObject({ host: 'database.example.test', user: 'fixture-user', pass: '' })
})

it('requires unresolved certificate options only when that TLS configuration is consumed', () => {
  const db = { type: 'postgres', host: 'database.example.test', user: 'fixture-user', pass: 'fixture-password', db: 'fixture-database', ssl: true, sslOptions: { auto: false, ca: '$(TSEPISTLE_MISSING_DATABASE_CA)' } }
  const active = start({}, yaml.dump({ port: 3000, db }))
  expect(active.status).toBe(1)
  expect(active.stderr).toContain('TSEPISTLE_MISSING_DATABASE_CA')

  const inactive = start({}, yaml.dump({ port: 3000, db: { ...db, ssl: false } }))
  expect(inactive.status).toBe(0)
  expect(inactive.config.db.ssl).toBe(false)
  expect(inactive.config.db.sslOptions.auto).toBe(false)
})
