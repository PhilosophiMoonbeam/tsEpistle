import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import createKnex, { type Knex } from 'knex'
import * as ts from 'typescript'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import {
  postgresTestDatabaseName,
  readPostgresTestCredentials,
  validatePostgresTestNamespace,
  validatePostgresTestSuffix
} from '../test/postgres-test-connection.mts'

const root = resolve(import.meta.dir, '../..')
const helperPath = join(root, 'server/test/postgres-test-connection.mts')
const declarationName = 'getPostgresTestConnection'
const args = Bun.argv.slice(2)
const postgres = args[0] === '--postgres'
const requested = postgres ? args.slice(1) : args
let password = ''
const message = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error)
  return password ? text.replaceAll(password, '[REDACTED]') : text
}

interface TestJob {
  file: string
  suffix: string | null
}
interface TestFailure {
  file: string
  output: string
}

/** Parse, never import, test modules. The runtime call is the sole routing authority. */
const nativeSuffix = async (file: string): Promise<string | null> => {
  const text = await readFile(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  let imported = false
  let suffix: string | null = null
  const invalid: () => never = () => { throw new Error(`${file}: native declaration must be one unaliased getPostgresTestConnection('literal_suffix', import.meta.path) call imported from the shared helper.`) }
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const moduleName = statement.moduleSpecifier.text
    if (resolve(dirname(file), moduleName) !== helperPath) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) invalid()
    for (const binding of bindings.elements) {
      if ((binding.propertyName ?? binding.name).text !== declarationName) continue
      if (binding.propertyName || binding.isTypeOnly || statement.importClause?.isTypeOnly || imported) invalid()
      imported = true
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const moduleName = node.arguments[0]
      if (moduleName && ts.isStringLiteral(moduleName) && resolve(dirname(file), moduleName.text) === helperPath) invalid()
    }
    if (ts.isIdentifier(node) && node.text === declarationName) {
      if (ts.isImportSpecifier(node.parent)) return
      if (!ts.isCallExpression(node.parent) || node.parent.expression !== node || !imported || suffix !== null) invalid()
      const call = node.parent
      const [literal, location] = call.arguments
      if (call.arguments.length !== 2 || call.typeArguments || call.questionDotToken || !literal || !ts.isStringLiteral(literal) || !location ||
        !ts.isPropertyAccessExpression(location) || location.name.text !== 'path' ||
        !ts.isMetaProperty(location.expression) || location.expression.keywordToken !== ts.SyntaxKind.ImportKeyword || location.expression.name.text !== 'meta') invalid()
      validatePostgresTestSuffix(literal.text)
      suffix = literal.text
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (imported && suffix === null) invalid()
  if (suffix !== null) {
    const diagnostics = ts.transpileModule(text, { fileName: file, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve } }).diagnostics ?? []
    if (diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) throw new Error(`${file}: malformed native test source.`)
  }
  return suffix
}

const discoverTests = async (): Promise<TestJob[]> => {
  let files: string[]
  if (requested.length > 0) {
    files = requested.map(file => {
      if (!isAbsolute(file) && file.startsWith('-')) throw new Error(`Expected an exact test filename, not an option: ${file}`)
      return resolve(root, file)
    })
  } else {
    const glob = new Bun.Glob('**/*.{test,spec}.{js,jsx,ts,tsx}')
    files = (await Promise.all(['client', 'server', 'shared'].map(async directory =>
      Array.fromAsync(glob.scan({ cwd: join(root, directory), onlyFiles: true })).then(matches => matches.map(match => join(root, directory, match)))
    ))).flat().sort()
  }
  const jobs: TestJob[] = []
  for (const file of new Set(files)) {
    const suffix = await nativeSuffix(file)
    if (postgres && suffix === null) {
      if (requested.length > 0) throw new Error(`${file}: explicitly requested file has no native PostgreSQL declaration.`)
      continue
    }
    jobs.push({ file, suffix })
  }
  return jobs
}

const childEnvironment = (): Record<string, string | undefined> => {
  const env = { ...Bun.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('WIKI_TEST_POSTGRES_') || key === 'WIKI_AGENT_MEDIA_POSTGRES' || key === 'WIKI_AGENT_LARGE_PDF_PROOF') delete env[key]
  }
  env.WIKI_TEST_RUNNER_MODE = postgres ? 'postgres' : 'ordinary'
  return env
}

type XmlNode = Record<string, unknown>
const xmlObject = (value: unknown): value is XmlNode => typeof value === 'object' && value !== null && !Array.isArray(value)
const xmlList = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value]
const junitAdmission = async (report: string): Promise<number> => {
  let xml: string
  try { xml = await readFile(report, 'utf8') } catch { throw new Error('Native child did not produce its JUnit report.') }
  if (XMLValidator.validate(xml) !== true || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Malformed native JUnit report.')
  const parsed: unknown = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false }).parse(xml)
  if (!xmlObject(parsed) || ('testsuites' in parsed) === ('testsuite' in parsed)) throw new Error('Native report must have one JUnit testsuites/testsuite root.')
  const problems: string[] = []
  const walk = (value: unknown, tag: string): number => {
    if (!xmlObject(value)) throw new Error(`Malformed JUnit ${tag}.`)
    const label = String(value['@_name'] ?? tag)
    for (const key of ['failures', 'errors', 'skipped', 'disabled', 'todo', 'pending']) {
      const counter = value[`@_${key}`]
      if (counter !== undefined && (typeof counter !== 'string' || !/^[0-9]+$/.test(counter))) throw new Error(`Invalid JUnit ${key} counter.`)
      if (counter !== undefined && Number(counter) !== 0) problems.push(`${label}: ${key}=${String(counter)}`)
    }
    for (const key of ['failure', 'error', 'skipped', 'todo', 'pending', 'disabled']) {
      if (key in value) problems.push(`${label}: ${key}`)
    }
    const status = value['@_status'] ?? value['@_result']
    if (status !== undefined && !['passed', 'pass', 'success', 'completed', 'run'].includes(String(status).toLowerCase())) problems.push(`${label}: status=${String(status)}`)
    let cases = tag === 'testcase' ? 1 : 0
    for (const key of ['testsuites', 'testsuite', 'testcase']) {
      for (const child of xmlList(value[key])) cases += walk(child, key)
    }
    const count = value['@_tests']
    if (count !== undefined && (typeof count !== 'string' || !/^[0-9]+$/.test(count) || Number(count) !== cases)) throw new Error(`JUnit test count does not match actual cases in ${label}.`)
    return cases
  }
  const cases = walk(parsed, 'report')
  if (problems.length > 0) throw new Error(`Native JUnit admission rejected failures/skips/todo:\n${problems.join('\n')}`)
  if (cases === 0) throw new Error('Native JUnit report contains no executed test cases.')
  return cases
}

const main = async (): Promise<void> => {
  if (postgres && process.env.WIKI_TEST_POSTGRES_DATABASE !== undefined) throw new Error('WIKI_TEST_POSTGRES_DATABASE is child-only output. Remove it and use bun run test:postgres with disposable service credentials.')
  const jobs = await discoverTests()
  if (jobs.length === 0) throw new Error('No test files matched this execution mode.')
  const defaults = postgres ? 1 : 8
  const workerCount = Math.max(1, Math.min(Number.parseInt(Bun.env.BUN_TEST_JOBS ?? String(defaults), 10) || defaults, jobs.length))
  const failures: TestFailure[] = []
  const env = childEnvironment()
  const active = new Set<Bun.Subprocess<'ignore', 'pipe', 'pipe'>>()
  const killTimers = new Set<NodeJS.Timeout>()
  const owned = new Set<string>()
  const cleanupAttempted = new Set<string>()
  let interrupted = false
  let nextJob = 0
  let passed = 0
  let reportDirectory: string | undefined
  let admin: Knex | undefined
  let allocatorConnection: unknown
  let namespace = ''
  let locked = false
  const stop = (): void => {
    if (interrupted) return
    interrupted = true
    for (const child of active) {
      try { child.kill('SIGTERM') } catch (error) { failures.push({ file: 'interruption', output: message(error) }) }
      const timer = setTimeout(() => {
        killTimers.delete(timer)
        if (active.has(child)) {
          try { child.kill('SIGKILL') } catch (error) { failures.push({ file: 'interruption', output: message(error) }) }
        }
      }, 5000)
      timer.unref()
      killTimers.add(timer)
    }
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  const sql = (query: string, bindings: readonly (string | number)[] = []) => {
    if (!admin || !allocatorConnection) throw new Error('Native allocator connection is unavailable.')
    return admin.raw(query, [...bindings]).connection(allocatorConnection)
  }
  const cleanup = async (database: string): Promise<void> => {
    if (!owned.has(database) || cleanupAttempted.has(database)) return
    cleanupAttempted.add(database)
    try {
      await sql(`DROP DATABASE "${database}" WITH (FORCE)`)
      owned.delete(database)
    } catch (error) {
      failures.push({ file: database, output: `Cleanup failed; owned database remains: ${database}. ${message(error)}` })
    }
  }
  try {
    let databases: string[] = []
    if (postgres) {
      const credentials = readPostgresTestCredentials()
      password = credentials.password
      namespace = process.env.WIKI_TEST_POSTGRES_NAMESPACE ?? `tsepistle_test_${randomBytes(8).toString('hex')}`
      validatePostgresTestNamespace(namespace)
      databases = jobs.map((job, ordinal) => postgresTestDatabaseName(namespace, ordinal.toString(36), job.suffix!))
      Object.assign(env, {
        WIKI_TEST_POSTGRES_HOST: credentials.host,
        WIKI_TEST_POSTGRES_PORT: String(credentials.port),
        WIKI_TEST_POSTGRES_USER: credentials.user,
        WIKI_TEST_POSTGRES_PASSWORD: credentials.password,
        WIKI_TEST_POSTGRES_NAMESPACE: namespace,
        WIKI_TEST_POSTGRES_REQUIRED: '1',
        WIKI_AGENT_MEDIA_POSTGRES: '1',
        WIKI_AGENT_LARGE_PDF_PROOF: '1'
      })
      reportDirectory = await mkdtemp(join(tmpdir(), 'tsepistle-native-junit-'))
      admin = createKnex({ client: 'pg', connection: { ...credentials, database: 'postgres' }, pool: { min: 0, max: 1 } })
      allocatorConnection = await admin.client.acquireConnection()
      // Hold one session lock until final cleanup, including concurrent explicit-namespace invocations.
      const lock = await sql('SELECT pg_try_advisory_lock(hashtextextended(?, 0)) AS acquired', [namespace])
      if (lock.rows[0]?.acquired !== true) throw new Error(`Native namespace is already in use: ${namespace}`)
      locked = true
      const existing = await sql('SELECT datname FROM pg_catalog.pg_database WHERE datname = ? OR left(datname, ?) = ?', [namespace, namespace.length + 1, `${namespace}_`])
      if (existing.rows.length > 0) throw new Error(`Native namespace contains existing databases; refusing reuse without modifying them: ${namespace}`)
    }
    const runWorker = async (): Promise<void> => {
      while (!interrupted && nextJob < jobs.length) {
        const ordinal = nextJob++
        const job = jobs[ordinal]!
        const database = databases[ordinal]
        let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
        let output = ''
        try {
          if (database) {
            await sql(`CREATE DATABASE "${database}"`)
            owned.add(database)
          }
          if (interrupted) continue
          const report = reportDirectory ? join(reportDirectory, `${ordinal.toString(36)}.xml`) : undefined
          child = Bun.spawn([process.execPath, 'test', job.file, ...(report ? ['--reporter=junit', `--reporter-outfile=${report}`] : [])], {
            cwd: root,
            env: database ? { ...env, WIKI_TEST_POSTGRES_JOB_ORDINAL: ordinal.toString(36), WIKI_TEST_POSTGRES_DATABASE: database } : env,
            stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'
          })
          active.add(child)
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited
          ])
          output = `${stdout}${stderr}`.trim()
          if (interrupted) throw new Error('Native/isolated execution interrupted.')
          if (exitCode !== 0) throw new Error(`Child exited with code ${exitCode}.`)
          if (report) {
            const cases = await junitAdmission(report)
            console.log(`PostgreSQL PASS ${job.file} (${database}): ${cases} executed cases, zero skips/todo.`)
          }
          passed++
        } catch (error) {
          failures.push({ file: job.file, output: message(`${output}\n${message(error)}`).trim() })
        } finally {
          if (child) {
            // Even an output/report exception must not race database cleanup with a live child.
            if (child.exitCode === null) {
              try { child.kill('SIGKILL') } catch (error) { failures.push({ file: job.file, output: message(error) }) }
            }
            await child.exited
            active.delete(child)
          }
          if (database) await cleanup(database)
        }
      }
    }
    const workers = await Promise.allSettled(Array.from({ length: workerCount }, runWorker))
    for (const worker of workers) {
      if (worker.status === 'rejected') failures.push({ file: 'worker', output: message(worker.reason) })
    }
  } catch (error) {
    failures.push({ file: 'runner', output: message(error) })
  } finally {
    if (active.size > 0) {
      stop()
      await Promise.allSettled(Array.from(active, child => child.exited))
      active.clear()
    }
    for (const database of owned) await cleanup(database)
    if (locked) {
      try { await sql('SELECT pg_advisory_unlock(hashtextextended(?, 0))', [namespace]) } catch (error) { failures.push({ file: 'allocator', output: message(error) }) }
    }
    if (admin) {
      if (allocatorConnection) {
        try { await admin.client.releaseConnection(allocatorConnection) } catch (error) { failures.push({ file: 'allocator', output: message(error) }) }
      }
      try { await admin.destroy() } catch (error) { failures.push({ file: 'allocator', output: message(error) }) }
    }
    if (reportDirectory) {
      try { await rm(reportDirectory, { recursive: true, force: true }) } catch (error) { failures.push({ file: 'reports', output: message(error) }) }
    }
    for (const timer of killTimers) clearTimeout(timer)
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
  for (const failure of failures) console.error(`\n::group::${failure.file}\n${failure.output}\n::endgroup::`)
  if (!postgres) {
    const nativeBranches = jobs.filter(job => job.suffix !== null).length
    console.log(`Ordinary mode: native PostgreSQL branches in ${nativeBranches} files were not exercised; media callers used SQLite and the large-PDF proof was not enabled.`)
  }
  if (failures.length > 0 || interrupted) {
    console.error(`${passed}/${jobs.length} test files passed; ${failures.length} failures${interrupted ? '; interrupted' : ''}.`)
    process.exitCode = interrupted ? 130 : 1
  } else {
    console.log(`${passed}/${jobs.length} test files passed in isolated Bun processes (${postgres ? 'native PostgreSQL, zero skips/todo' : 'ordinary mode; not native coverage'}).`)
  }
}

try { await main() } catch (error) { console.error(message(error)); process.exitCode = 1 }
