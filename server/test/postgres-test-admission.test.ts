import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from './bun-test.mts'
import { postgresTestDatabaseName } from './postgres-test-connection.mts'

const root = resolve(import.meta.dir, '../..')
const helper = join(import.meta.dir, 'postgres-test-connection.mts')
const runner = join(root, 'server/scripts/run-tests.ts')
const namespace = 'tsepistle_test_0123456789abcdef'
const suffix = '_admission_test'
const assignedDatabase = `${namespace}_a${suffix}`
const cleanEnvironment = (): Record<string, string | undefined> => {
  const env = { ...Bun.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('WIKI_TEST_POSTGRES_') || key === 'WIKI_TEST_RUNNER_MODE' || key === 'WIKI_AGENT_MEDIA_POSTGRES' || key === 'WIKI_AGENT_LARGE_PDF_PROOF') delete env[key]
  }
  return env
}
const assignment: Record<string, string> = {
  WIKI_TEST_RUNNER_MODE: 'postgres',
  WIKI_TEST_POSTGRES_REQUIRED: '1',
  WIKI_TEST_POSTGRES_NAMESPACE: namespace,
  WIKI_TEST_POSTGRES_JOB_ORDINAL: 'a',
  WIKI_TEST_POSTGRES_DATABASE: assignedDatabase,
  WIKI_TEST_POSTGRES_HOST: '127.0.0.1',
  WIKI_TEST_POSTGRES_PORT: '5432',
  WIKI_TEST_POSTGRES_USER: 'disposable-test-user',
  WIKI_TEST_POSTGRES_PASSWORD: 'disposable-test-password'
}
const execute = async (args: string[], env: Record<string, string | undefined>) => {
  const child = Bun.spawn([process.execPath, ...args], { cwd: root, env: { ...cleanEnvironment(), ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, exitCode }
}
const admissionScript = `
  import { getPostgresTestConnection } from ${JSON.stringify(helper)};
  try {
    const connection = getPostgresTestConnection(${JSON.stringify(suffix)}, import.meta.path);
    console.log(JSON.stringify(connection === null ? null : {
      host: connection.host, port: connection.port, user: connection.user, database: connection.database,
      passwordMatches: connection.password === process.env.EXPECTED_TEST_PASSWORD
    }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
`

describe('isolated PostgreSQL test admission', () => {
  it('accepts an exact assignment and rejects same-suffix targets from another ordinal or namespace', async () => {
    const accepted = await execute(['-e', admissionScript], { ...assignment, EXPECTED_TEST_PASSWORD: assignment.WIKI_TEST_POSTGRES_PASSWORD })
    expect(accepted.exitCode).toBe(0)
    expect(JSON.parse(accepted.stdout)).toEqual({ host: '127.0.0.1', port: 5432, user: 'disposable-test-user', database: assignedDatabase, passwordMatches: true })
    for (const database of [`${namespace}_b${suffix}`, `tsepistle_test_fedcba9876543210_a${suffix}`, `${namespace}_a_other_test`]) {
      const refused = await execute(['-e', admissionScript], { ...assignment, WIKI_TEST_POSTGRES_DATABASE: database })
      expect(refused.exitCode).not.toBe(0)
      expect(refused.stderr).toContain('WIKI_TEST_POSTGRES_DATABASE')
    }
  })

  it('fails raw native invocation even with valid credentials and never resolves poisoned credentials in ordinary mode', async () => {
    const raw = await execute(['-e', admissionScript], { ...assignment, WIKI_TEST_RUNNER_MODE: undefined })
    expect(raw.exitCode).not.toBe(0)
    expect(raw.stderr).toContain('bun run test:postgres')
    const ordinary = await execute(['-e', admissionScript], { ...assignment, WIKI_TEST_RUNNER_MODE: 'ordinary', WIKI_TEST_POSTGRES_PASSWORD_FILE: '/does-not-exist/native-test-password' })
    expect(ordinary.exitCode).toBe(0)
    expect(JSON.parse(ordinary.stdout)).toBeNull()
  })

  it('honors password-file precedence without silently falling back after a file read failure or missing password', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'postgres-admission-password-'))
    try {
      const passwordFile = join(directory, 'password')
      await writeFile(passwordFile, '  file-test-password\n')
      const fromFile = await execute(['-e', admissionScript], { ...assignment, WIKI_TEST_POSTGRES_PASSWORD_FILE: passwordFile, EXPECTED_TEST_PASSWORD: 'file-test-password' })
      expect(fromFile.exitCode).toBe(0)
      expect(JSON.parse(fromFile.stdout).passwordMatches).toBe(true)
      const unreadable = await execute(['-e', admissionScript], { ...assignment, WIKI_TEST_POSTGRES_PASSWORD_FILE: join(directory, 'missing') })
      expect(unreadable.exitCode).not.toBe(0)
      expect(unreadable.stderr).toContain('WIKI_TEST_POSTGRES_PASSWORD_FILE')
      const missing = await execute(['-e', admissionScript], { ...assignment, WIKI_TEST_POSTGRES_PASSWORD: undefined })
      expect(missing.exitCode).not.toBe(0)
      expect(missing.stderr).toContain('WIKI_TEST_POSTGRES_PASSWORD')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects invalid assignment metadata and overlength identifiers instead of truncating them', () => {
    const boundarySuffix = `_${'a'.repeat(24)}_test`
    expect(postgresTestDatabaseName(namespace, '0', boundarySuffix)).toBe(`${namespace}_0${boundarySuffix}`)
    expect(() => postgresTestDatabaseName(namespace, '0', `_${'a'.repeat(25)}_test`)).toThrow()
    expect(() => postgresTestDatabaseName('wiki_production', '0', suffix)).toThrow()
    expect(() => postgresTestDatabaseName(namespace, '00', suffix)).toThrow()
    expect(() => postgresTestDatabaseName(namespace, 'A', suffix)).toThrow()
    expect(() => postgresTestDatabaseName(namespace, '0', '_unsafe"_test')).toThrow()
  })

  it('runs only an exact requested file and clears inherited native flags before ordinary fixture admission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'postgres-admission-runner-'))
    try {
      const file = join(directory, 'selected.test.ts')
      const sibling = join(directory, 'selected.test.ts.unrelated.test.ts')
      const marker = join(directory, 'unrelated-ran')
      await writeFile(file, `
        import { expect, test } from 'bun:test';
        import { getPostgresTestConnection } from ${JSON.stringify(helper)};
        const connection = getPostgresTestConnection('_admission_test', import.meta.path);
        test('ordinary fixture stays SQLite-only', () => {
          expect(connection).toBeNull();
          expect(process.env.WIKI_TEST_RUNNER_MODE).toBe('ordinary');
          expect(Object.keys(process.env).filter(key => key.startsWith('WIKI_TEST_POSTGRES_'))).toEqual([]);
          expect(process.env.WIKI_AGENT_MEDIA_POSTGRES).toBeUndefined();
          expect(process.env.WIKI_AGENT_LARGE_PDF_PROOF).toBeUndefined();
        });
      `)
      await writeFile(sibling, `import { test } from 'bun:test'; test('not requested', async () => { await Bun.write(${JSON.stringify(marker)}, 'ran'); });`)
      const result = await execute([runner, file], { ...assignment, WIKI_AGENT_MEDIA_POSTGRES: '1', WIKI_AGENT_LARGE_PDF_PROOF: '1' })
      expect(result.exitCode).toBe(0)
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)

  it('rejects parent database targets and dynamic, aliased, ambiguous or absent native declarations before allocation', async () => {
    const target = await execute([runner, '--postgres', import.meta.path], { WIKI_TEST_POSTGRES_DATABASE: 'wiki_production' })
    expect(target.exitCode).not.toBe(0)
    expect(target.stderr).toContain('WIKI_TEST_POSTGRES_DATABASE')
    const directory = await mkdtemp(join(tmpdir(), 'postgres-admission-declaration-'))
    try {
      const file = join(directory, 'declaration.test.ts')
      const sources = [
        `import { getPostgresTestConnection } from ${JSON.stringify(helper)}; getPostgresTestConnection(process.env.SUFFIX, import.meta.path);`,
        `import { getPostgresTestConnection as connection } from ${JSON.stringify(helper)}; connection('_admission_test', import.meta.path);`,
        `import { getPostgresTestConnection } from ${JSON.stringify(helper)}; getPostgresTestConnection('_admission_test', import.meta.path); getPostgresTestConnection('_admission_test', import.meta.path);`,
        `import { test } from 'bun:test'; test('ordinary-only case', () => {});`
      ]
      for (const [index, source] of sources.entries()) {
        await writeFile(file, source)
        const result = await execute([runner, '--postgres', file], {})
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain(index === 3 ? file : 'getPostgresTestConnection')
        expect(result.stderr).not.toContain('WIKI_TEST_POSTGRES_HOST')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)
})
