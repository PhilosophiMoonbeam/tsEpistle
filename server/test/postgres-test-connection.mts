import { readFileSync } from 'node:fs'

export interface PostgresTestConnection {
  host: string
  port: number
  user: string
  password: string
  database: string
}

/** Shared by allocation and admission; no application or benchmark configuration is read. */
export const readPostgresTestCredentials = (): Omit<PostgresTestConnection, 'database'> => {
  const host = process.env.WIKI_TEST_POSTGRES_HOST
  const user = process.env.WIKI_TEST_POSTGRES_USER
  const portText = process.env.WIKI_TEST_POSTGRES_PORT
  if (!host?.trim() || !user?.trim() || !portText || !/^[1-9][0-9]*$/.test(portText)) {
    throw new Error('test:postgres requires explicit WIKI_TEST_POSTGRES_HOST, PORT and USER for a disposable PostgreSQL service.')
  }
  const port = Number(portText)
  if (!Number.isSafeInteger(port) || port > 65535) throw new Error('WIKI_TEST_POSTGRES_PORT must be between 1 and 65535.')
  const passwordFile = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE
  let password: string | undefined
  try {
    password = passwordFile ? readFileSync(passwordFile, 'utf8').trim() : process.env.WIKI_TEST_POSTGRES_PASSWORD
  } catch {
    throw new Error('Cannot read WIKI_TEST_POSTGRES_PASSWORD_FILE.')
  }
  if (!password) throw new Error('test:postgres requires WIKI_TEST_POSTGRES_PASSWORD or PASSWORD_FILE; use disposable service credentials only.')
  return { host, port, user, password }
}

export const validatePostgresTestSuffix = (suffix: string): void => {
  if (!/^_[a-z][a-z0-9_]*_test$/.test(suffix)) throw new Error(`Invalid PostgreSQL test suffix: ${suffix}`)
}

export const validatePostgresTestNamespace = (namespace: string): void => {
  if (!/^tsepistle_test_[0-9a-f]{16}$/.test(namespace)) {
    throw new Error('WIKI_TEST_POSTGRES_NAMESPACE must be tsepistle_test_ followed by 16 lowercase hexadecimal characters.')
  }
}

export const postgresTestDatabaseName = (namespace: string, ordinal: string, suffix: string): string => {
  validatePostgresTestNamespace(namespace)
  validatePostgresTestSuffix(suffix)
  if (!/^(0|[1-9a-z][0-9a-z]*)$/.test(ordinal)) throw new Error('Invalid PostgreSQL test job ordinal; use canonical base36 without leading zeroes.')
  const database = `${namespace}_${ordinal}${suffix}`
  if (database.length > 63) throw new Error(`PostgreSQL test database identifier exceeds 63 ASCII bytes: ${database}`)
  return database
}

/** A literal call in the participating file is also its runner discovery declaration. */
export const getPostgresTestConnection = (suffix: string, testFile: string): PostgresTestConnection | null => {
  validatePostgresTestSuffix(suffix)
  if (process.env.WIKI_TEST_RUNNER_MODE === 'ordinary') return null
  if (process.env.WIKI_TEST_RUNNER_MODE !== 'postgres' || process.env.WIKI_TEST_POSTGRES_REQUIRED !== '1') {
    throw new Error(`${testFile}: native PostgreSQL tests require an isolated runner assignment. Use bun run test:postgres [exact-test-file].`)
  }
  const namespace = process.env.WIKI_TEST_POSTGRES_NAMESPACE ?? ''
  const ordinal = process.env.WIKI_TEST_POSTGRES_JOB_ORDINAL ?? ''
  const database = postgresTestDatabaseName(namespace, ordinal, suffix)
  if (process.env.WIKI_TEST_POSTGRES_DATABASE !== database) {
    throw new Error(`${testFile}: WIKI_TEST_POSTGRES_DATABASE does not match the assigned namespace, ordinal and declared suffix. Use bun run test:postgres.`)
  }
  return { ...readPostgresTestCredentials(), database }
}
