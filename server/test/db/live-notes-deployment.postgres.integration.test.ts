import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up, down } from '../../db/migrations/tsepistle-000067-live-notes.ts'

const connection = getPostgresTestConnection('_live_notes_deploy_test', import.meta.path)
const suite = connection ? describe : describe.skip

suite('live notes deployment migration and executable PostgreSQL probe', () => {
  let db: Knex
  let directory: string
  let shell: string

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection })
    directory = await mkdtemp(path.join(tmpdir(), 'live-notes-probe-'))
    const source = await readFile('deploy/compose/upgrade.sh', 'utf8')
    const start = source.indexOf('verify_postconditions() {')
    const end = source.indexOf('\n}\n', start)
    if (start < 0 || end < 0) throw new Error('Deployment postcondition entry point unavailable')
    const require = createRequire(import.meta.url)
    await writeFile(
      path.join(directory, 'psql.cjs'),
      `
const { Client } = require(${JSON.stringify(require.resolve('pg'))});
const client = new Client(JSON.parse(process.env.PROBE_CONNECTION));
(async () => {
  await client.connect();
  await client.query('SET default_transaction_read_only = on');
  try {
    const result = await client.query(process.argv[2]);
    for (const part of Array.isArray(result) ? result : [result]) {
      for (const row of part.rows) console.log(Object.values(row).join('|'));
    }
  } finally { await client.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`
    )
    shell = `set -euo pipefail
${source.slice(start, end + 3)}
die() { printf '%s\\n' "$*" >&2; exit 1; }
jq() { printf '%s\\n' native-live-notes-schema; }
docker() {
  local sql="\${!#}"
  "$PROBE_NODE" "$PROBE_BRIDGE" "$sql"
}
TARGET_CONTRACTS='{}'
PLAN_FILE=/dev/null
verify_postconditions runtimePostconditions fixture fixture fixture
`
  })

  beforeEach(async () => {
    for (const table of ['liveNoteConnections', 'liveNoteRequests', 'liveNoteRevisions', 'liveNotes', 'users']) {
      await db.schema.dropTableIfExists(table)
    }
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
    })
    await up(db)
  })

  afterAll(async () => {
    await db?.destroy()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  const probe = () =>
    spawnSync('bash', ['-c', shell], {
      encoding: 'utf8',
      env: { ...process.env, PROBE_NODE: process.execPath, PROBE_BRIDGE: path.join(directory, 'psql.cjs'), PROBE_CONNECTION: JSON.stringify(connection) }
    })

  it('admits the real additive schema in a read-only session and refuses downgrade with authoritative history', async () => {
    expect(probe().status).toBe(0)
    await db('users').insert({ id: 1 })
    const id = '00000000-0000-0000-0000-000000000001'
    const now = new Date()
    await db('liveNotes').insert({ id, key: 'test-note', ownerId: 1, state: 'canonical', createdAt: now, updatedAt: now, touchedAt: now })
    await db('liveNoteRevisions').insert({ noteId: id, revision: 0, state: 'canonical', title: '', access: 'private', actorId: 1, createdAt: now })
    expect(probe().status).toBe(0)
    await expect(down(db)).rejects.toThrow('authoritative')
    await db('users').where({ id: 1 }).delete()
    expect((await db('liveNotes').first()).ownerId).toBeNull()
    expect(probe().status).toBe(0)
    await db('liveNotes').where({ id }).delete()
    expect(await db('liveNoteRevisions')).toHaveLength(0)
    await down(db)
    expect(await db.schema.hasTable('liveNotes')).toBe(false)
  })

  it.each([
    ['unsafe revisions', 'ALTER TABLE "liveNotes" DROP CONSTRAINT live_notes_revision_check'],
    ['unrestricted access', 'ALTER TABLE "liveNotes" DROP CONSTRAINT live_notes_access_check'],
    [
      'ineffective access allowlist',
      `ALTER TABLE "liveNotes" DROP CONSTRAINT live_notes_access_check;
      ALTER TABLE "liveNotes" ADD CONSTRAINT live_notes_access_check CHECK (access IN ('private', 'read', 'edit', 'invalid'))`
    ],
    [
      'empty access admitted',
      `ALTER TABLE "liveNotes" DROP CONSTRAINT live_notes_access_check;
      ALTER TABLE "liveNotes" ADD CONSTRAINT live_notes_access_check CHECK (access IN ('private', 'read', 'edit', ''))`
    ],
    [
      'malformed access literal',
      `ALTER TABLE "liveNotes" DROP CONSTRAINT live_notes_access_check;
      ALTER TABLE "liveNotes" ADD CONSTRAINT live_notes_access_check CHECK (access IN ('private', 're ad', 'edit'))`
    ],
    [
      'ineffective revision lower bound',
      `ALTER TABLE "liveNotes" DROP CONSTRAINT live_notes_revision_check;
      ALTER TABLE "liveNotes" ADD CONSTRAINT live_notes_revision_check CHECK (revision >= -1 AND revision <= 9007199254740991)`
    ],
    [
      'ineffective revision upper bound',
      `ALTER TABLE "liveNotes" DROP CONSTRAINT live_notes_revision_check;
      ALTER TABLE "liveNotes" ADD CONSTRAINT live_notes_revision_check CHECK (revision >= 0 AND revision <= 9007199254740992)`
    ],
    [
      'tautological revision check',
      `ALTER TABLE "liveNotes" DROP CONSTRAINT live_notes_revision_check;
      ALTER TABLE "liveNotes" ADD CONSTRAINT live_notes_revision_check CHECK (revision >= 0 OR revision <= 9007199254740991)`
    ],
    [
      'unvalidated access check',
      `ALTER TABLE "liveNotes" DROP CONSTRAINT live_notes_access_check;
      ALTER TABLE "liveNotes" ADD CONSTRAINT live_notes_access_check CHECK (access IN ('private', 'read', 'edit')) NOT VALID`
    ],
    ['lost request identity', 'ALTER TABLE "liveNoteRequests" DROP CONSTRAINT "liveNoteRequests_pkey"'],
    ['missing active lease index', 'DROP INDEX live_note_connections_active_idx'],
    ['wrong canonical storage type', 'ALTER TABLE "liveNotes" ALTER COLUMN state TYPE varchar(255)']
  ])('rejects %s', async (_name, sql) => {
    await db.raw(sql)
    const result = probe()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Postcondition failed')
  })

  it.each([
    ['malformed access', { access: 'invalid' }, 'live_notes_access_check'],
    ['empty access', { access: '' }, 'live_notes_access_check'],
    ['negative revision', { revision: '-1' }, 'live_notes_revision_check'],
    ['unsafe revision', { revision: '9007199254740992' }, 'live_notes_revision_check']
  ] as const)('the native schema rejects %s without using a production writer probe', async (_name, invalid, constraint) => {
    const now = new Date()
    await expect(
      Promise.resolve(
        db('liveNotes').insert({
          id: '00000000-0000-0000-0000-000000000003',
          key: 'invalid-note',
          state: 'canonical',
          createdAt: now,
          updatedAt: now,
          touchedAt: now,
          ...invalid
        })
      )
    ).rejects.toMatchObject({ code: '23514', constraint })
  })

  it.each([
    ['malformed history access', { access: 'invalid' }],
    ['negative history revision', { revision: '-1' }],
    ['unsafe history revision', { revision: '9007199254740992' }],
    ['history ahead of the canonical revision', { revision: '2' }]
  ] as const)('rejects persisted %s in a read-only session', async (_name, invalid) => {
    const now = new Date()
    const id = '00000000-0000-0000-0000-000000000004'
    await db('liveNotes').insert({ id, key: 'invalid-history', state: 'canonical', revision: 1, createdAt: now, updatedAt: now, touchedAt: now })
    await db('liveNoteRevisions').insert({ noteId: id, revision: 1, state: 'canonical', title: '', access: 'private', createdAt: now })
    await db('liveNoteRevisions').insert({ noteId: id, revision: 0, state: 'invalid', title: '', access: 'private', createdAt: now, ...invalid })
    const result = probe()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('invalid document/history rows')
  })

  it('rejects a document without its authoritative current revision', async () => {
    const now = new Date()
    await db('liveNotes').insert({
      id: '00000000-0000-0000-0000-000000000002',
      key: 'missing-history',
      state: 'canonical',
      createdAt: now,
      updatedAt: now,
      touchedAt: now
    })
    const result = probe()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('invalid document/history rows')
  })
})
