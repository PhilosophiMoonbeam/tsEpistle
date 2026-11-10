import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from '../bun-test.mts'

const repositoryRoot = process.cwd()
const gatePath = '/etc/ssh/sshd_config.d/90-tsepistle-firstboot.conf'
const sshConfiguration =
  'Include /etc/ssh/sshd_config.d/*.conf\nPermitRootLogin prohibit-password\nMatch User backup\n  ForceCommand /usr/local/bin/backup\nMatch all\n'
const unrelatedDropIn = 'PasswordAuthentication no\n'
const packages = ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin', 'docker-compose-plugin']

type Event = {
  command: string
  args: string[]
  name?: string
  source?: string
  target?: string
  shape?: string
  attempt?: number
  tcp?: boolean
  host?: string
  database?: string
  user?: string
}
type Container = { name: string; environment: Record<string, string>; mounts: { source: string; target: string; readonly: boolean }[] }

// These are external command boundaries, not replacements for any firstboot logic.
// Docker models the important -v behavior: an absent bind source becomes a directory.
const commandFixture = String.raw`
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const command = process.argv[2]
const args = process.argv.slice(3)
const record = event => fs.appendFileSync('/fixture/events.jsonl', JSON.stringify({ command, args, ...event }) + '\n')
const state = name => '/fixture/containers/' + name + '.json'
const option = (values, name) => {
  const index = values.indexOf(name)
  return index < 0 ? undefined : values[index + 1]
}
const fail = (message, status = 1) => { console.error(message); process.exit(status) }
const run = (executable, values) => {
  const result = spawnSync(executable, values, { stdio: 'inherit', env: process.env })
  process.exit(result.status ?? 1)
}
const guestRoot = process.env.FIXTURE_ROOT
const assertGuestPath = value => {
  if (!path.resolve(value).startsWith(guestRoot + '/')) fail('Filesystem boundary outside guest: ' + value)
}
if (command === 'sudo') {
  if (!args.length || !['apt-get', 'install', 'mkdir', 'chmod', 'chown', 'tee'].includes(args[0])) fail('Unexpected sudo boundary')
  run(path.join(guestRoot, 'fixture-bin', args[0]), args.slice(1))
}
if (command === 'apt-get') {
  if (!args.includes('install')) fail('Unexpected package operation')
  for (const value of args.filter(value => value.endsWith('.deb'))) assertGuestPath(value)
  record({}); process.exit(0)
}
if (command === 'systemctl') {
  if (!['enable docker', 'start docker', 'restart ssh', 'reload ssh', 'restart sshd', 'reload sshd'].includes(args.join(' '))) fail('Unexpected systemctl operation')
  if (process.env.FIXTURE_SSH_RELOAD_FAILURE && args.join(' ') === 'reload ssh') fail('Injected SSH reload failure', 23)
  record({}); process.exit(0)
}
if (command === 'sleep') {
  if (args.length !== 1 || !/^[0-9]+(?:\.[0-9]+)?$/.test(args[0])) fail('Unexpected sleep')
  record({}); process.exit(0)
}
if (['mkdir', 'install', 'chmod', 'chown', 'rm', 'mv', 'cp', 'touch', 'cat', 'tee', 'sed', 'mktemp', 'dirname', 'tar', 'sha256sum', 'stat'].includes(command)) {
  // Only explicitly rooted filesystem operands can reach real filesystem tools.
  // Relative tar archive members and mode/owner/option operands are not paths.
  for (const value of args) {
    if (value.startsWith('/')) assertGuestPath(value)
    if (value.includes('../')) fail('Unexpected parent traversal')
  }
  if (command === 'chown') {
    if (!['root:root', '0:0', 'root', '0'].includes(args.find(value => !value.startsWith('-')))) fail('Unexpected guest owner')
    record({}); process.exit(0)
  }
  if (command === 'mktemp' && !args.some(value => value.startsWith(guestRoot + '/'))) fail('Unrooted temporary file')
  if (command === 'stat' && (args.length !== 3 || args[0] !== '-c' || !['%a', '%s'].includes(args[1]))) fail('Unexpected stat boundary')
  record({})
  run('/usr/bin/' + command, args)
}
if (command === 'openssl') {
  record({})
  if (process.env.FIXTURE_RANDOMNESS === 'failure') process.exit(Number(process.env.FIXTURE_RANDOMNESS_STATUS ?? 1))
  if (process.env.FIXTURE_RANDOMNESS === 'empty') process.exit(0)
  run('/usr/bin/openssl', args)
}
if (command === 'jq') {
  // Package verification itself is covered by packer-release-provenance.test.ts.
  const entries = JSON.parse(fs.readFileSync(args.at(-1), 'utf8'))
  if (args[0] === '-e') process.exit(0)
  if (args[1] === '.[].file') console.log(entries.map(entry => entry.file).join('\n'))
  else if (args[1] === '.[] | [.sha256, .file] | @tsv') console.log(entries.map(entry => entry.sha256 + '\t' + entry.file).join('\n'))
  else fail('Unsupported package metadata query')
  process.exit(0)
}
if (command !== 'docker') fail('Unexpected fixture command')
if (args[0] === 'network' || args[0] === 'volume') { record({}); process.exit(0) }
if (args[0] === 'inspect') {
  if (args.length !== 4 || args[1] !== '--format' || args[2] !== '{{.State.Status}}' || args[3] !== 'db') fail('Unexpected container state inspection')
  record({ name: 'db' })
  console.log(JSON.parse(fs.readFileSync(state('db'), 'utf8')).status ?? 'created')
  process.exit(0)
}
if (args[0] === 'create') {
  const container = { name: '', environment: {}, mounts: [] }
  for (let index = 1; index < args.length; index++) {
    const argument = args[index]
    if (argument.startsWith('--name=')) container.name = argument.slice(7)
    else if (argument === '--name') container.name = args[++index]
    else if (argument === '-e' || argument === '--env' || argument.startsWith('--env=')) {
      const variable = argument.startsWith('--env=') ? argument.slice(6) : args[++index]
      const equals = variable.indexOf('=')
      container.environment[variable.slice(0, equals)] = variable.slice(equals + 1)
    } else if (argument === '-v' || argument === '--volume' || argument.startsWith('--volume=') || argument === '--mount' || argument.startsWith('--mount=')) {
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : args[++index]
      let source, target, readonly
      if (argument.startsWith('--mount')) {
        const fields = Object.fromEntries(value.split(',').map(field => field.split('=')))
        if (fields.type !== 'bind') continue
        source = fields.source ?? fields.src
        target = fields.target ?? fields.dst ?? fields.destination
        readonly = Object.hasOwn(fields, 'readonly') || Object.hasOwn(fields, 'ro')
        assertGuestPath(source)
        if (process.env.FIXTURE_REMOVE_BIND_SOURCE === container.name) fs.rmSync(source, { force: true })
        if (!fs.existsSync(source)) fail('Bind mount source does not exist')
      } else {
        const fields = value.split(':')
        ;[source, target] = fields
        readonly = (fields[2] ?? '').split(',').includes('ro')
        if (!source.startsWith('/')) continue
        assertGuestPath(source)
        if (process.env.FIXTURE_REMOVE_BIND_SOURCE === container.name) fs.rmSync(source, { force: true })
        if (!fs.existsSync(source)) fs.mkdirSync(source, { recursive: true })
      }
      container.mounts.push({ source, target, readonly })
      record({ name: container.name, source, target, shape: fs.statSync(source).isFile() ? 'file' : 'directory' })
    }
  }
  if (!['db', 'wiki'].includes(container.name)) fail('Unexpected container')
  fs.writeFileSync(state(container.name), JSON.stringify(container))
  record({ name: container.name })
  process.exit(0)
}
if (args[0] === 'start') {
  const name = args[1]
  record({ name })
  if (process.env.FIXTURE_START_FAILURE === name) fail('Injected container start failure')
  const container = JSON.parse(fs.readFileSync(state(name), 'utf8'))
  const credentialPath = container.environment[name === 'db' ? 'POSTGRES_PASSWORD_FILE' : 'DB_PASS_FILE']
  const mount = container.mounts.find(mount => mount.target === credentialPath)
  if (!mount || !fs.statSync(mount.source).isFile()) fail('Credential mount is not a file')
  if ((fs.statSync(mount.source).mode & 0o444) !== 0o444) fail('Mounted credential is unreadable to the container user')
  const credential = fs.readFileSync(mount.source, 'utf8')
  if (!credential.trim()) fail('Credential is empty')
  fs.writeFileSync('/fixture/consumed-' + name, credential)
  container.status = 'running'
  fs.writeFileSync(state(name), JSON.stringify(container))
  fs.appendFileSync('/fixture/events.jsonl', JSON.stringify({ command: 'started', args: [], name }) + '\n')
  process.exit(0)
}
if (args[0] === 'exec') {
  const databaseContainer = args.indexOf('db')
  const probe = args.slice(databaseContainer + 1)
  if (databaseContainer < 0 || probe[0] !== 'pg_isready') fail('Readiness must probe the actual database container')
  const countFile = '/fixture/probe-count'
  const attempt = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0) + 1
  fs.writeFileSync(countFile, String(attempt))
  const host = option(probe, '-h') ?? option(probe, '--host') ?? probe.find(value => value.startsWith('--host='))?.slice(7)
  const database = option(probe, '-d') ?? option(probe, '--dbname') ?? probe.find(value => value.startsWith('--dbname='))?.slice(9)
  const user = option(probe, '-U') ?? option(probe, '--username') ?? probe.find(value => value.startsWith('--username='))?.slice(11)
  const tcp = Boolean(host && !host.startsWith('/'))
  record({ name: 'db', attempt, tcp, host, database, user })
  if (host !== '127.0.0.1' || database !== 'wiki' || user !== 'wiki') fail('Wrong database readiness endpoint')
  if (process.env.FIXTURE_READINESS === 'never' || attempt < Number(process.env.FIXTURE_READY_AFTER ?? 3)) process.exit(1)
  fs.appendFileSync('/fixture/events.jsonl', JSON.stringify({ command: 'ready', args: [], name: 'db' }) + '\n')
  process.exit(0)
}
fail('Unsupported Docker operation')
`

class Guest {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'packer-firstboot-'))
  readonly manifestDigest: string

  constructor() {
    try {
      for (const directory of [
        'etc/wiki',
        'etc/ssh/sshd_config.d',
        'root',
        'tmp/runtime-inputs',
        'fixture/containers',
        'fixture/packages/docker-packages',
        'fixture-bin',
        'scripts'
      ]) {
        fs.mkdirSync(this.file(`/${directory}`), { recursive: true })
      }
      fs.writeFileSync(this.file('/etc/ssh/sshd_config'), sshConfiguration)
      fs.writeFileSync(this.file('/etc/ssh/sshd_config.d/10-local.conf'), unrelatedDropIn)
      fs.writeFileSync(this.file('/fixture/events.jsonl'), '')
      fs.writeFileSync(this.file('/tmp/runtime-inputs/runtime-inputs.json'), '{}\n')
      fs.writeFileSync(this.file('/etc/openssl.cnf'), '')
      for (const script of ['001-onboot.sh', '010-docker.sh', '020-force-ssh-logout.sh']) {
        const source = fs.readFileSync(path.join(repositoryRoot, 'dev/packer/scripts', script), 'utf8')
        const isolated = source.replace(/\/(?:etc|root|tmp|run|var\/lib|var\/log)(?=\/|["'\s;])/g, prefix => this.root + prefix)
        fs.writeFileSync(this.file(`/scripts/${script}`), isolated)
      }
      fs.writeFileSync(this.file('/fixture/command.mjs'), commandFixture.replaceAll('/fixture/', `${this.root}/fixture/`))
      for (const command of [
        'docker',
        'sudo',
        'systemctl',
        'apt-get',
        'sleep',
        'openssl',
        'jq',
        'mkdir',
        'install',
        'chmod',
        'chown',
        'rm',
        'mv',
        'cp',
        'touch',
        'cat',
        'tee',
        'sed',
        'mktemp',
        'dirname',
        'tar',
        'sha256sum',
        'stat'
      ]) {
        fs.writeFileSync(
          this.file(`/fixture-bin/${command}`),
          `#!/bin/bash\nexec '${process.execPath}' '${this.file('/fixture/command.mjs')}' '${command}' "$@"\n`,
          { mode: 0o755 }
        )
      }
      const manifest = packages.map(packageName => {
        const file = `${packageName}.deb`
        const contents = `fixture package ${packageName}\n`
        fs.writeFileSync(this.file(`/fixture/packages/docker-packages/${file}`), contents)
        return { package: packageName, architecture: 'amd64', file, sha256: createHash('sha256').update(contents).digest('hex') }
      })
      const manifestBytes = JSON.stringify(manifest)
      this.manifestDigest = createHash('sha256').update(manifestBytes).digest('hex')
      fs.writeFileSync(this.file('/fixture/packages/docker-packages/docker-packages.json'), manifestBytes)
      const archive = this.run([
        this.file('/fixture-bin/tar'),
        '-cf',
        this.file('/tmp/runtime-inputs/docker-packages.tar'),
        '-C',
        this.file('/fixture/packages'),
        'docker-packages'
      ])
      if (archive.status !== 0) throw new Error(`Cannot create isolated guest archive: ${archive.error?.message ?? archive.stderr}`)
    } catch (error) {
      this.close()
      throw error
    }
  }

  file(filename: string) {
    return filename.startsWith(this.root + '/') ? filename : path.join(this.root, filename)
  }
  read(filename: string) {
    return fs.readFileSync(this.file(filename), 'utf8')
  }
  events(): Event[] {
    return this.read('/fixture/events.jsonl')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Event)
  }
  container(name: string): Container {
    return JSON.parse(this.read(`/fixture/containers/${name}.json`)) as Container
  }
  close() {
    fs.rmSync(this.root, { recursive: true, force: true })
  }

  run(command: string[], environment: Record<string, string> = {}) {
    // Rebase guest filesystem literals only; execute the production control flow.
    // PATH contains only guarded fixtures, never real sudo, Docker or systemctl.
    const result = spawnSync('/usr/bin/setsid', command, {
      cwd: this.root,
      encoding: 'utf8',
      timeout: 15_000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      env: {
        PATH: this.file('/fixture-bin'),
        HOME: this.file('/root'),
        LANG: 'C',
        BASH_ENV: '',
        ENV: '',
        DATABASE_URL: '',
        FIXTURE_ROOT: this.root,
        TMPDIR: this.file('/tmp'),
        OPENSSL_CONF: this.file('/etc/openssl.cnf'),
        application_image: `ghcr.io/philosophimoonbeam/wiki@sha256:${'a'.repeat(64)}`,
        postgres_image: `docker.io/library/postgres@sha256:${'b'.repeat(64)}`,
        docker_package_manifest_sha256: this.manifestDigest ?? '',
        ...environment
      }
    })
    // Retire only this invocation's process group, including children on timeout.
    try {
      if (result.pid > 0) process.kill(-result.pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    return result
  }

  script(name: string, environment: Record<string, string> = {}) {
    return this.run(['/bin/bash', this.file(`/scripts/${name}`)], environment)
  }

  provision() {
    const result = this.script('010-docker.sh')
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    return result
  }

  installGate() {
    const result = this.script('020-force-ssh-logout.sh')
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
  }

  expectSshPreserved() {
    expect(this.read('/etc/ssh/sshd_config')).toBe(sshConfiguration)
    expect(this.read('/etc/ssh/sshd_config.d/10-local.conf')).toBe(unrelatedDropIn)
    expect(fs.existsSync(this.file(gatePath))).toBe(false)
  }
}

function withGuest(action: (guest: Guest) => void) {
  const guest = new Guest()
  try {
    action(guest)
  } finally {
    guest.close()
  }
}

function secretMount(guest: Guest, name = 'wiki') {
  const container = guest.container(name)
  const target = container.environment[name === 'db' ? 'POSTGRES_PASSWORD_FILE' : 'DB_PASS_FILE']
  const mount = container.mounts.find(mount => mount.target === target)
  expect(mount).toBeDefined()
  return mount!
}

function expectNoWikiStart(guest: Guest, output: string) {
  expect(guest.events().filter(event => event.command === 'started' && event.name === 'wiki')).toEqual([])
  expect(output).not.toMatch(/(?:wiki\s+(?:started|is running)|(?:successfully\s+)?started\s+wiki)/i)
}

describe('Packer instance firstboot', () => {
  it('prepares regular empty bind files without baking a credential or injecting an administrator password', () => {
    withGuest(guest => {
      const result = guest.provision()
      for (const name of ['db', 'wiki']) {
        const mount = secretMount(guest, name)
        expect(mount.readonly).toBe(true)
        expect(fs.statSync(guest.file(mount.source)).isFile()).toBe(true)
        expect(guest.read(mount.source)).toBe('')
        expect(fs.statSync(guest.file(mount.source)).mode & 0o777).toBe(0o444)
        expect(fs.statSync(guest.file(path.dirname(mount.source))).mode & 0o777).toBe(0o700)
        expect(guest.container(name).mounts.some(binding => binding.source === path.dirname(mount.source))).toBe(false)
        expect(Object.keys(guest.container(name).environment).some(key => key.startsWith('ADMIN_PASS'))).toBe(false)
      }
      expect(guest.events().filter(event => event.command === 'openssl')).toEqual([])
      expect(guest.events().filter(event => event.command === 'started')).toEqual([])
      expect(result.stdout + result.stderr).not.toMatch(/ADMIN_PASS=/)
    })
  })

  it('fails instead of creating a directory when a single-file bind source disappears', () => {
    withGuest(guest => {
      const result = guest.script('010-docker.sh', { FIXTURE_REMOVE_BIND_SOURCE: 'db' })
      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(0)
      expect(fs.existsSync(guest.file('/etc/wiki/.db-secret'))).toBe(false)
      expect(fs.existsSync(guest.file('/fixture/containers/wiki.json'))).toBe(false)
    })
  })

  it('uses an owned SSH drop-in with a terminated root match and preserves unrelated SSH policy', () => {
    withGuest(guest => {
      guest.installGate()
      expect(guest.read('/etc/ssh/sshd_config')).toBe(sshConfiguration)
      expect(guest.read('/etc/ssh/sshd_config.d/10-local.conf')).toBe(unrelatedDropIn)
      const configuration = guest
        .read(gatePath)
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
      expect(configuration[0]).toBe('Match User root')
      expect(configuration.some(line => /^ForceCommand\s+\S/.test(line))).toBe(true)
      expect(configuration.at(-1)).toBe('Match all')
      expect(fs.statSync(guest.file(gatePath)).mode & 0o777).toBe(0o600)
      const original = guest.read(gatePath)
      guest.installGate()
      expect(guest.read(gatePath)).toBe(original)
    })
  })

  for (const change of ['contents', 'permissions', 'symlink'] as const) {
    it(`refuses an unrecognized reserved SSH drop-in after changed ${change}`, () => {
      withGuest(guest => {
        guest.provision()
        guest.installGate()
        if (change === 'contents') fs.appendFileSync(guest.file(gatePath), '# operator override\n')
        if (change === 'permissions') fs.chmodSync(guest.file(gatePath), 0o644)
        if (change === 'symlink') {
          fs.unlinkSync(guest.file(gatePath))
          fs.symlinkSync(guest.file('/etc/ssh/sshd_config.d/10-local.conf'), guest.file(gatePath))
        }
        const original = guest.read(gatePath)
        const installation = guest.script('020-force-ssh-logout.sh')
        expect(installation.error).toBeUndefined()
        expect(installation.status).not.toBe(0)
        const firstboot = guest.script('001-onboot.sh')
        expect(firstboot.error).toBeUndefined()
        expect(firstboot.status).not.toBe(0)
        expect(guest.read(gatePath)).toBe(original)
        expect(fs.lstatSync(guest.file(gatePath)).isSymbolicLink()).toBe(change === 'symlink')
        expect(guest.read('/etc/ssh/sshd_config')).toBe(sshConfiguration)
        expect(guest.read('/etc/ssh/sshd_config.d/10-local.conf')).toBe(unrelatedDropIn)
        expect(guest.events().filter(event => event.command === 'openssl' || (event.command === 'docker' && event.args[0] === 'start'))).toEqual([])
      })
    })
  }

  for (const state of ['directory', 'symlink', 'whitespace', 'multiline', 'nul', 'unreadable', 'public parent'] as const) {
    it(`rejects ${state} credential state without replacing it or starting containers`, () => {
      withGuest(guest => {
        guest.provision()
        guest.installGate()
        const secret = guest.file('/etc/wiki/.db-secret')
        const target = guest.file('/fixture/original-credential')
        const original = 'keep-this-existing-password-unchanged\n'
        if (state === 'directory' || state === 'symlink') {
          fs.unlinkSync(secret)
          if (state === 'directory') fs.mkdirSync(secret)
          else {
            fs.writeFileSync(target, original)
            fs.symlinkSync(target, secret)
          }
        } else {
          fs.chmodSync(secret, 0o600)
          fs.writeFileSync(
            secret,
            state === 'whitespace' ? '   \n' : state === 'multiline' ? 'first\nsecond\n' : state === 'nul' ? 'first\0second\n' : original
          )
          fs.chmodSync(secret, state === 'unreadable' ? 0o400 : 0o444)
          if (state === 'public parent') fs.chmodSync(guest.file('/etc/wiki'), 0o755)
        }
        const contents = state === 'directory' ? undefined : fs.readFileSync(secret)
        const result = guest.script('001-onboot.sh')
        expect(result.error).toBeUndefined()
        expect(result.status).not.toBe(0)
        expect(guest.events().filter(event => event.command === 'openssl' || (event.command === 'docker' && event.args[0] === 'start'))).toEqual([])
        if (contents) expect(fs.readFileSync(secret)).toEqual(contents)
        expect(fs.lstatSync(secret).isDirectory()).toBe(state === 'directory')
        expect(fs.lstatSync(secret).isSymbolicLink()).toBe(state === 'symlink')
        if (state === 'symlink') expect(fs.readFileSync(target, 'utf8')).toBe(original)
        guest.expectSshPreserved()
      })
    })
  }

  for (const state of ['missing', 'empty'] as const) {
    it(`refuses a replacement when an initialized database credential becomes ${state}`, () => {
      withGuest(guest => {
        guest.provision()
        const initial = guest.script('001-onboot.sh')
        expect(initial.error).toBeUndefined()
        expect(initial.status).toBe(0)
        const consumed = guest.read('/fixture/consumed-db')
        const previousStarts = guest.events().filter(event => event.command === 'docker' && event.args[0] === 'start').length
        const secret = guest.file('/etc/wiki/.db-secret')
        if (state === 'missing') fs.unlinkSync(secret)
        else {
          fs.chmodSync(secret, 0o600)
          fs.writeFileSync(secret, '')
          fs.chmodSync(secret, 0o444)
        }
        guest.installGate()
        const result = guest.script('001-onboot.sh')
        expect(result.error).toBeUndefined()
        expect(result.status).not.toBe(0)
        expect(guest.events().filter(event => event.command === 'openssl')).toHaveLength(1)
        expect(guest.events().filter(event => event.command === 'docker' && event.args[0] === 'start')).toHaveLength(previousStarts)
        expect(guest.read('/fixture/consumed-db')).toBe(consumed)
        expect(result.stdout + result.stderr).not.toContain(consumed.trim())
        if (state === 'missing') expect(fs.existsSync(secret)).toBe(false)
        else expect(fs.readFileSync(secret, 'utf8')).toBe('')
        guest.expectSshPreserved()
      })
    })
  }

  for (const originalFailure of [false, true]) {
    it(`reports SSH reload failure without masking ${originalFailure ? 'the original failure status' : 'successful startup'}`, () => {
      withGuest(guest => {
        guest.provision()
        guest.installGate()
        const result = guest.script('001-onboot.sh', {
          FIXTURE_SSH_RELOAD_FAILURE: 'yes',
          ...(originalFailure ? { FIXTURE_RANDOMNESS: 'failure', FIXTURE_RANDOMNESS_STATUS: '17' } : {})
        })
        expect(result.error).toBeUndefined()
        if (originalFailure) {
          expect(result.status).toBe(17)
          expectNoWikiStart(guest, result.stdout + result.stderr)
        } else {
          expect(result.status).not.toBe(0)
          expect(guest.events().some(event => event.command === 'started' && event.name === 'wiki')).toBe(true)
        }
        expect(fs.readdirSync(guest.file('/etc/wiki')).filter(name => name.startsWith('.db-secret.'))).toEqual([])
        guest.expectSshPreserved()
      })
    })
  }

  it('generates distinct per-instance credentials once, keeps retries stable, and mounts readable files rather than exposing the host directory', () => {
    const credentials: string[] = []
    for (let instance = 0; instance < 2; instance++) {
      withGuest(guest => {
        guest.provision()
        guest.installGate()
        const first = guest.script('001-onboot.sh')
        expect(first.error).toBeUndefined()
        expect(first.status).toBe(0)
        const mount = secretMount(guest)
        const credential = guest.read(mount.source)
        expect(credential.trim().length).toBeGreaterThanOrEqual(32)
        expect(fs.statSync(guest.file(path.dirname(mount.source))).mode & 0o777).toBe(0o700)
        expect(fs.statSync(guest.file(mount.source)).mode & 0o777).toBe(0o444)
        // The test process is the isolated guest's provisioner/root identity.
        // Real root ownership and a kernel bind-mount read are a separate image smoke.
        expect(fs.statSync(guest.file(path.dirname(mount.source))).uid).toBe(process.getuid!())
        for (const name of ['db', 'wiki']) expect(guest.read(`/fixture/consumed-${name}`)).toBe(credential)
        expect(first.stdout + first.stderr).not.toContain(credential.trim())
        guest.expectSshPreserved()
        const second = guest.script('001-onboot.sh')
        expect(second.error).toBeUndefined()
        expect(second.status).toBe(0)
        expect(guest.read(mount.source)).toBe(credential)
        expect(second.stdout + second.stderr).not.toContain(credential.trim())
        expect(guest.events().filter(event => event.command === 'openssl')).toHaveLength(1)
        guest.expectSshPreserved()
        credentials.push(credential)
      })
    }
    expect(credentials[0]).not.toBe(credentials[1])
  })

  it('starts the DB, waits for TCP readiness of wiki as wiki, then starts the wiki', () => {
    withGuest(guest => {
      guest.provision()
      const result = guest.script('001-onboot.sh', { FIXTURE_READY_AFTER: '3' })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      const events = guest.events()
      const dbStart = events.findIndex(event => event.command === 'started' && event.name === 'db')
      const ready = events.findIndex(event => event.command === 'ready')
      const wikiStart = events.findIndex(event => event.command === 'started' && event.name === 'wiki')
      expect(dbStart).toBeGreaterThanOrEqual(0)
      expect(ready).toBeGreaterThan(dbStart)
      expect(wikiStart).toBeGreaterThan(ready)
      const probes = events.filter(event => event.command === 'docker' && event.args[0] === 'exec')
      expect(probes.length).toBeGreaterThan(1)
      for (const probe of probes) {
        expect(probe.tcp).toBe(true)
        expect(probe.host).toBe('127.0.0.1')
        expect(probe.database).toBe('wiki')
        expect(probe.user).toBe('wiki')
      }
    })
  })

  for (const [scenario, environment] of [
    ['randomness failure', { FIXTURE_RANDOMNESS: 'failure' }],
    ['empty randomness', { FIXTURE_RANDOMNESS: 'empty' }],
    ['DB startup failure', { FIXTURE_START_FAILURE: 'db' }],
    ['readiness exhaustion', { FIXTURE_READINESS: 'never' }],
    ['wiki startup failure', { FIXTURE_START_FAILURE: 'wiki' }]
  ] as const) {
    it(`fails closed on ${scenario}, restores SSH access, and never claims wiki startup`, () => {
      withGuest(guest => {
        guest.provision()
        guest.installGate()
        const result = guest.script('001-onboot.sh', environment)
        expect(result.error).toBeUndefined()
        expect(result.status).not.toBe(0)
        expect(result.signal).toBeNull()
        expectNoWikiStart(guest, result.stdout + result.stderr)
        guest.expectSshPreserved()
        expect(fs.readdirSync(guest.file('/etc/wiki')).filter(name => name.startsWith('.db-secret.'))).toEqual([])
        if (scenario !== 'wiki startup failure') {
          expect(guest.events().filter(event => event.command === 'docker' && event.args[0] === 'start' && event.name === 'wiki')).toEqual([])
        }
        if (scenario === 'readiness exhaustion') {
          const probes = guest.events().filter(event => event.command === 'docker' && event.args[0] === 'exec')
          expect(probes.length).toBeGreaterThan(0)
          expect(probes.length).toBeLessThanOrEqual(300)
        }
        const mount = secretMount(guest)
        const credential = guest.read(mount.source)
        if (credential.trim()) expect(result.stdout + result.stderr).not.toContain(credential.trim())
        if (scenario === 'randomness failure' || scenario === 'empty randomness') {
          expect(guest.events().filter(event => event.command === 'docker' && event.args[0] === 'start')).toEqual([])
        } else {
          expect(credential.trim().length).toBeGreaterThanOrEqual(32)
        }
        // Failure recovery must generate only an absent/empty secret, never rotate
        // the password that an already initialized database has consumed.
        const retry = guest.script('001-onboot.sh')
        expect(retry.error).toBeUndefined()
        expect(retry.status).toBe(0)
        const retriedCredential = guest.read(mount.source)
        expect(retriedCredential.trim().length).toBeGreaterThanOrEqual(32)
        if (credential.trim()) expect(retriedCredential).toBe(credential)
        expect(retry.stdout + retry.stderr).not.toContain(retriedCredential.trim())
      })
    }, 20_000)
  }

  it('keeps DATABASE_URL firstboot free of local DB startup and readiness probes', () => {
    withGuest(guest => {
      guest.provision()
      guest.installGate()
      const result = guest.script('001-onboot.sh', { DATABASE_URL: 'postgres://external.invalid/wiki' })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(guest.events().some(event => event.command === 'docker' && event.args[0] === 'start' && event.name === 'db')).toBe(false)
      expect(guest.events().some(event => event.command === 'docker' && event.args[0] === 'exec')).toBe(false)
      expect(guest.events().some(event => event.command === 'docker' && event.args[0] === 'inspect')).toBe(false)
      expect(guest.events().some(event => event.command === 'started' && event.name === 'wiki')).toBe(true)
      guest.expectSshPreserved()
    })
  })
})
