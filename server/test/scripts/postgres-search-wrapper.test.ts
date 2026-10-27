import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from '../bun-test.mts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const script = path.join(root, 'dev/e2e/postgres-search-benchmark.sh')
const directories: string[] = []
const containerId = 'a'.repeat(64)

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function runFixture(overrides: Record<string, string> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'tsepistle-search-wrapper-'))
  directories.push(directory)
  const bin = path.join(directory, 'bin')
  const temporary = path.join(directory, 'tmp')
  mkdirSync(bin)
  mkdirSync(temporary)
  const log = path.join(directory, 'commands.jsonl')
  const state = path.join(directory, 'state.json')
  writeFileSync(state, JSON.stringify({ container: overrides.COLLISION === '1', volume: overrides.COLLISION === '1' }))
  writeFileSync(
    path.join(bin, 'docker'),
    `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.COMMAND_LOG, JSON.stringify(args) + '\\n');
const state = JSON.parse(readFileSync(process.env.RESOURCE_STATE, 'utf8'));
if (args[0] === 'container' && args[1] === 'inspect') process.exit(process.env.COLLISION === '1' ? 0 : 1);
if (args[0] === 'run') {
  const cidfile = args[args.indexOf('--cidfile') + 1];
  writeFileSync(cidfile, '${containerId}');
  writeFileSync(process.env.RESOURCE_STATE, JSON.stringify({ container: true, volume: true }));
  console.log('${containerId}');
  process.exit(process.env.FAIL_START === '1' ? 1 : 0);
}
if (args[0] === 'port') { console.log('127.0.0.1:55432'); process.exit(0); }
if (args[0] === 'exec') process.exit(0);
if (args[0] === 'rm') {
  if (process.env.FAIL_REMOVE === '1') process.exit(1);
  if (args.at(-1) !== '${containerId}') process.exit(2);
  state.container = false;
  if (args.includes('-v') || args.includes('--volumes')) state.volume = false;
  writeFileSync(process.env.RESOURCE_STATE, JSON.stringify(state));
  process.exit(0);
}
process.exit(3);
`,
    { mode: 0o700 }
  )
  writeFileSync(
    path.join(bin, 'bun'),
    `#!/bin/sh
printf '{}\\n' > "$POSTGRES_SEARCH_BENCHMARK_FILE"
exit "\${BENCHMARK_STATUS:-0}"
`,
    { mode: 0o700 }
  )
  const result = spawnSync('/bin/bash', [script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: directory,
      TMPDIR: temporary,
      COMMAND_LOG: log,
      RESOURCE_STATE: state,
      WIKI_TEST_NAMESPACE: 'tsepistle-ci-owned-search',
      WIKI_CI_POSTGRES_MEMORY: '1g',
      POSTGRES_SEARCH_BENCHMARK_FILE: path.join(directory, 'report.json'),
      ...overrides
    }
  })
  const commands = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as string[])
  return { result, commands, state: JSON.parse(readFileSync(state, 'utf8')), temporary }
}

describe('PostgreSQL search benchmark owned fixture lifecycle', () => {
  it.each([0, 7])('removes its container and anonymous volume after benchmark exit %s', status => {
    const fixture = runFixture({ BENCHMARK_STATUS: String(status) })
    expect(fixture.result.status).toBe(status)
    expect(fixture.state).toEqual({ container: false, volume: false })
    expect(fixture.commands.filter(args => args[0] === 'rm')).toHaveLength(1)
    expect(readdirSync(fixture.temporary)).toEqual([])
  })

  it('cleans up a container created before Docker reports a start failure', () => {
    const fixture = runFixture({ FAIL_START: '1' })
    expect(fixture.result.status).not.toBe(0)
    expect(fixture.state).toEqual({ container: false, volume: false })
    expect(fixture.commands.some(args => args[0] === 'port')).toBe(false)
    expect(readdirSync(fixture.temporary)).toEqual([])
  })

  it('refuses a namespace collision without removing the existing container or volume', () => {
    const fixture = runFixture({ COLLISION: '1' })
    expect(fixture.result.status).not.toBe(0)
    expect(fixture.state).toEqual({ container: true, volume: true })
    expect(fixture.commands.some(args => args[0] === 'run' || args[0] === 'rm')).toBe(false)
    expect(readdirSync(fixture.temporary)).toEqual([])
  })

  it('reports cleanup failure and retains the exact owned CID for a targeted retry', () => {
    const fixture = runFixture({ FAIL_REMOVE: '1' })
    expect(fixture.result.status).not.toBe(0)
    expect(fixture.result.stderr).toContain('Could not remove owned PostgreSQL')
    expect(fixture.state).toEqual({ container: true, volume: true })
    const retained = readdirSync(fixture.temporary)
    expect(retained).toHaveLength(1)
    expect(readFileSync(path.join(fixture.temporary, retained[0]!, 'container-id'), 'utf8')).toBe(containerId)
  })
})
