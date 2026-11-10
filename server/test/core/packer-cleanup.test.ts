import { spawnSync } from 'node:child_process'
import type { SpawnSyncReturns } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from '../bun-test.mts'

const repositoryRoot = process.cwd()
const unrelatedZeroFile = 'PREEXISTING_GUEST_FILE_MUST_NOT_BE_CHANGED\n'

type Scenario = {
  status: number
  diagnostic: string
  stdout?: string
  interrupt?: boolean
  cleanupFailure?: boolean
  available?: number | string
  dfStatus?: number
}

type Operation = {
  command: string
  output?: string
  locale?: string
  path?: string
  message?: string
}

// These are command boundaries, not another implementation of the cleanup script.
// In particular, dd only writes a few bytes and reports an independent outcome;
// the real shell script must decide whether that outcome permits success.
const commandFixture = `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const root = process.env.TEST_GUEST_ROOT
const events = process.env.TEST_EVENTS
const scenario = JSON.parse(process.env.TEST_SCENARIO)
const command = path.basename(process.argv[1])
const args = process.argv.slice(2)
const record = event => fs.appendFileSync(events, JSON.stringify(event) + '\\n')
const fail = message => { record({ command: 'fixture-error', message }); console.error(message); process.exit(97) }
const owned = candidate => {
  const resolved = path.resolve(candidate)
  if (resolved !== root && !resolved.startsWith(root + '/')) fail('Guest path escape: ' + candidate)
  // No fixture command creates symlinks; reject any introduced link before access.
  let current = resolved
  while (current.startsWith(root)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('Guest symlink escape: ' + candidate)
    if (current === root) break
    current = path.dirname(current)
  }
  return resolved
}
const operands = () => args.filter(arg => arg !== '--' && !arg.startsWith('-')).map(owned)
try {
  switch (command) {
    case 'apt-get':
      if (!['-y update', '-y purge droplet-agent', '-y autoremove', '-y autoclean'].includes(args.join(' '))) fail('Unsupported apt invocation')
      break
    case 'mkdir':
      for (const target of operands()) fs.mkdirSync(target, { recursive: args.includes('-p') })
      break
    case 'chmod': {
      if (!/^[0-7]{3,4}$/.test(args[0])) fail('Unsupported chmod mode')
      for (const target of args.slice(1)) fs.chmodSync(owned(target), parseInt(args[0], 8))
      break
    }
    case 'rm': {
      if (args.some(arg => arg.startsWith('-') && !['--', '-f', '-r', '-rf', '-fr'].includes(arg))) fail('Unsupported rm options')
      const previous = fs.readFileSync(events, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line))
      const written = previous.find(event => event.command === 'dd')?.output
      for (const target of operands()) {
        record({ command: 'rm', path: target })
        if (scenario.cleanupFailure && target === written) {
          console.error('rm: cannot remove ' + target + ': Permission denied')
          process.exit(13)
        }
        fs.rmSync(target, { force: args.some(arg => arg.startsWith('-') && arg.includes('f')), recursive: args.some(arg => arg.startsWith('-') && arg.includes('r')) })
      }
      break
    }
    case 'cat':
      for (const target of args.length ? args : [null]) {
        if (target === null) process.stdout.write(fs.readFileSync(0))
        else if (target !== '/dev/null') process.stdout.write(fs.readFileSync(owned(target)))
      }
      break
    case 'touch':
      for (const target of operands()) fs.closeSync(fs.openSync(target, 'a'))
      break
    case 'truncate': {
      if (args[0] !== '-s' || args[1] !== '0') fail('Unsupported truncate invocation')
      for (const target of args.slice(2)) fs.truncateSync(owned(target), 0)
      break
    }
    case 'find': {
      if (args.length !== 11 || args.slice(1).join(' ') !== '-mtime -1 -type f -exec truncate -s 0 {} ;') fail('Unsupported find invocation')
      const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const target = owned(path.join(directory, entry.name))
          if (entry.isDirectory()) visit(target)
          else if (entry.isFile()) fs.truncateSync(target, 0)
          else fail('Unsupported guest log entry')
        }
      }
      visit(owned(args[0]))
      break
    }
    case 'mktemp': {
      let directory = path.join(root, 'tmp')
      let template
      for (let index = 0; index < args.length; index++) {
        const arg = args[index]
        if (arg === '--') continue
        if (arg === '-p' || arg === '--tmpdir') directory = owned(args[++index])
        else if (arg.startsWith('--tmpdir=')) directory = owned(arg.slice('--tmpdir='.length))
        else if (arg.startsWith('-')) fail('Unsupported mktemp invocation')
        else if (template) fail('Multiple mktemp templates')
        else template = arg
      }
      template ??= 'tmp.XXXXXXXXXX'
      const target = owned(path.isAbsolute(template) ? template : path.join(directory, template))
      if (!/X{3,}/.test(target)) fail('Missing mktemp randomness')
      const output = target.replace(/X{3,}/, match => crypto.randomBytes(match.length).toString('hex').slice(0, match.length))
      fs.closeSync(fs.openSync(output, 'wx', 0o600))
      record({ command: 'mktemp', path: output })
      console.log(output)
      break
    }
    case 'dd': {
      if (args.some(arg => !/^(if|of|bs)=/.test(arg)) || args.filter(arg => arg.startsWith('of=')).length !== 1 || !args.includes('if=/dev/zero')) fail('Unsupported dd invocation')
      const output = owned(args.find(arg => arg.startsWith('of=')).slice(3))
      // A tiny bounded write models the partial file left by either success or error.
      fs.writeFileSync(output, Buffer.alloc(64))
      record({ command: 'dd', output, locale: process.env.LC_ALL })
      if (scenario.stdout) process.stdout.write(scenario.stdout)
      process.stderr.write(scenario.diagnostic + '\\n')
      if (scenario.interrupt) {
        process.on('SIGTERM', () => {
          record({ command: 'dd-stopped' })
          process.exit(scenario.status)
        })
        // An open watcher keeps the fixture alive without a timed sleep.
        fs.watch(output, () => {})
        process.kill(process.ppid, 'SIGTERM')
      } else {
        process.exit(scenario.status)
      }
      break
    }
    case 'df': {
      const targets = args.filter(arg => !arg.startsWith('-'))
      if (targets.length !== 1) fail('Unsupported df invocation')
      const target = owned(targets[0])
      fs.statSync(target)
      record({ command: 'df', path: target, locale: process.env.LC_ALL })
      // /run is a separate filesystem; its free space cannot prove root exhaustion.
      const run = path.join(root, 'run')
      const available = target === run || target.startsWith(run + '/') ? 1024 : scenario.available ?? 0
      process.stdout.write(args.some(arg => arg.startsWith('--output='))
        ? 'Avail\\n' + available + '\\n'
        : 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 2048 ' + (2048 - available) + ' ' + available + ' 100% ' + root + '\\n')
      process.exit(scenario.dfStatus ?? 0)
    }
    case 'grep': {
      let quiet = false
      let fixed = false
      let pattern
      const files = []
      let options = true
      for (const arg of args) {
        if (options && arg === '--') { options = false; continue }
        if (options && arg.startsWith('-')) {
          if (!/^-[qFE]+$/.test(arg)) fail('Unsupported grep options')
          quiet ||= arg.includes('q')
          fixed ||= arg.includes('F')
        } else if (pattern === undefined) pattern = arg
        else files.push(owned(arg))
      }
      if (pattern === undefined) fail('Missing grep pattern')
      const text = files.length ? files.map(file => fs.readFileSync(file, 'utf8')).join('') : fs.readFileSync(0, 'utf8')
      const matches = text.split('\\n').filter(line => fixed ? line.includes(pattern) : new RegExp(pattern).test(line))
      if (!quiet && matches.length) process.stdout.write(matches.join('\\n') + '\\n')
      process.exit(matches.length ? 0 : 1)
    }
    default:
      fail('Unsupported command: ' + command)
  }
} catch (error) {
  fail(command + ': ' + error.message)
}
`

function withCleanupFixture(scenario: Scenario, verify: (fixture: { result: SpawnSyncReturns<string>; guest: string; operations: Operation[] }) => void): void {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'packer-cleanup-'))
  const guest = path.join(temporaryDirectory, 'guest')
  const bin = path.join(temporaryDirectory, 'bin')
  const events = path.join(temporaryDirectory, 'events.jsonl')
  try {
    for (const directory of ['tmp', 'var/tmp', 'var/log', 'var/lib/cloud/instances', 'opt/digitalocean', 'root/.ssh', 'etc/ssh', 'run']) {
      fs.mkdirSync(path.join(guest, directory), { recursive: true })
    }
    fs.mkdirSync(bin)
    fs.writeFileSync(events, '')
    fs.writeFileSync(path.join(guest, 'zerofile'), unrelatedZeroFile)
    fs.writeFileSync(path.join(guest, 'tsepistle-zero-fill.preexisting'), unrelatedZeroFile)
    fs.writeFileSync(path.join(guest, 'root/.bash_history'), 'guest history\n')
    fs.writeFileSync(path.join(guest, 'var/log/application.log'), 'guest log\n')
    for (const command of ['apt-get', 'mkdir', 'chmod', 'rm', 'cat', 'touch', 'truncate', 'find', 'mktemp', 'dd', 'df', 'grep']) {
      fs.writeFileSync(path.join(bin, command), commandFixture, { mode: 0o755 })
    }
    // No host PATH fallback, and missing commands are recorded even if the script
    // subsequently handles their nonzero status. Neither apt nor dd can reach a
    // real executable. Only absolute guest filesystem prefixes are rebased.
    const boundary = path.join(temporaryDirectory, 'bash-env')
    fs.writeFileSync(
      boundary,
      `command_not_found_handle() { printf '{"command":"fixture-error","message":"unsupported command: %s"}\\n' "$1" >> "$TEST_EVENTS"; return 97; }\n`
    )
    const script = fs.readFileSync(path.join(repositoryRoot, 'dev/packer/scripts/900-cleanup.sh'), 'utf8')
    // Rebase only token-rooted paths, never a matching segment inside another path.
    const isolatedScript = script.replace(
      /(^|[\s"'=(:;<>])(\/(?:var\/(?:tmp|log|lib\/cloud)|root|etc|tmp|opt|run|zerofile|tsepistle-zero-fill)(?=\/|[.\s"';:]))/g,
      (_match, tokenBoundary, prefix) => tokenBoundary + guest + prefix
    )
    const scriptPath = path.join(temporaryDirectory, 'cleanup.sh')
    fs.writeFileSync(scriptPath, isolatedScript)
    const result = spawnSync('/bin/bash', [scriptPath], {
      cwd: guest,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: bin,
        HOME: path.join(guest, 'root'),
        TMPDIR: path.join(guest, 'run'),
        BASH_ENV: boundary,
        LC_ALL: 'C.UTF-8',
        TEST_GUEST_ROOT: guest,
        TEST_EVENTS: events,
        TEST_SCENARIO: JSON.stringify(scenario)
      }
    })
    const operations: Operation[] = fs
      .readFileSync(events, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
    expect(result.error).toBeUndefined()
    expect(operations.filter(operation => operation.command === 'fixture-error')).toEqual([])
    expect(operations.filter(operation => operation.command === 'dd')).toHaveLength(1)
    verify({ result, guest, operations })
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

function expectOwnedFill(guest: string, operations: Operation[], removed = true): string {
  const fill = operations.find(operation => operation.command === 'dd')!
  expect(fill.locale).toBe('C')
  expect(path.dirname(fill.output!)).toBe(guest)
  expect(fill.output).not.toBe(path.join(guest, 'zerofile'))
  expect(path.basename(fill.output!)).toMatch(/^tsepistle-zero-fill\.[A-Za-z0-9]+$/)
  expect(fs.existsSync(fill.output!)).toBe(!removed)
  expect(fs.readFileSync(path.join(guest, 'zerofile'), 'utf8')).toBe(unrelatedZeroFile)
  expect(fs.readFileSync(path.join(guest, 'tsepistle-zero-fill.preexisting'), 'utf8')).toBe(unrelatedZeroFile)
  expect(fs.readdirSync(path.join(guest, 'run'))).toEqual([])
  return fill.output!
}

describe('Packer guest disk-fill cleanup lifecycle', () => {
  for (const diagnostic of ['dd: error writing output: No space left on device', 'dd: IO error: No space left on device']) {
    it(`accepts exit 1 with ${diagnostic} only on a full filesystem and removes only its owned file`, () => {
      withCleanupFixture({ status: 1, diagnostic, available: 0 }, ({ result, guest, operations }) => {
        expect(result.status).toBe(0)
        expectOwnedFill(guest, operations)
      })
    })
  }

  for (const scenario of [
    { name: 'an unrelated write failure', status: 1, diagnostic: 'dd: error writing output: Input/output error' },
    { name: 'an ENOSPC diagnostic with the wrong exit code', status: 2, diagnostic: 'dd: error writing output: No space left on device' },
    { name: 'ENOSPC text only on stdout', status: 1, diagnostic: 'dd: failed to open output: Permission denied', stdout: 'No space left on device\n' },
    { name: 'unexpected success from an unbounded fill', status: 0, diagnostic: '1+0 records in\n1+0 records out' },
    { name: 'ENOSPC on a filesystem that still has free space', status: 1, diagnostic: 'dd: IO error: No space left on device', available: 1 },
    { name: 'indeterminate filesystem free space', status: 1, diagnostic: 'dd: IO error: No space left on device', available: '-' },
    { name: 'missing filesystem free space', status: 1, diagnostic: 'dd: IO error: No space left on device', available: '' },
    { name: 'a failed filesystem inspection despite zero output', status: 1, diagnostic: 'dd: IO error: No space left on device', available: 0, dfStatus: 1 }
  ]) {
    it(`fails for ${scenario.name} while removing its partial file`, () => {
      withCleanupFixture(scenario, ({ result, guest, operations }) => {
        expect(result.status).not.toBe(0)
        expect(result.signal).toBeNull()
        expectOwnedFill(guest, operations)
      })
    })
  }

  it('does not turn a failed removal into a successful image cleanup', () => {
    withCleanupFixture(
      { status: 1, diagnostic: 'dd: error writing output: No space left on device', cleanupFailure: true },
      ({ result, guest, operations }) => {
        expect(result.status).not.toBe(0)
        const fill = expectOwnedFill(guest, operations, false)
        expect(operations.some(operation => operation.command === 'rm' && operation.path === fill)).toBe(true)
        expect(String(result.stderr)).toContain('Permission denied')
      }
    )
  })

  it('removes its partial file when the cleanup shell receives TERM', () => {
    withCleanupFixture({ status: 143, diagnostic: 'dd: interrupted', interrupt: true }, ({ result, guest, operations }) => {
      expect(result.status).not.toBe(0)
      expectOwnedFill(guest, operations)
      const stopped = operations.findIndex(operation => operation.command === 'dd-stopped')
      const removed = operations.findIndex(
        operation => operation.command === 'rm' && operation.path === operations.find(event => event.command === 'dd')!.output
      )
      expect(stopped).toBeGreaterThan(-1)
      expect(removed).toBeGreaterThan(stopped)
    })
  })
})
