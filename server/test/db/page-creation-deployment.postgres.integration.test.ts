import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up, down } from '../../db/migrations/tsepistle-000068-page-creation-receipts.ts'
import { up as createNotes } from '../../db/migrations/tsepistle-000067-live-notes.ts'

const connection = getPostgresTestConnection('_page_receipt_deploy_test', import.meta.path)
const suite = connection ? describe : describe.skip
const requestId = '00000000-0000-4000-8000-000000000001'
const noteId = '00000000-0000-4000-8000-000000000002'

suite('page creation receipt deployment contract', () => {
  let db: Knex
  let directory: string
  let shell: string
  const receipt = () => ({ ownerId: 7, requestId, pageId: 42, sourceRevision: '1', createdAt: new Date('2026-10-01T00:00:00Z') })

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined })
    directory = await mkdtemp(path.join(tmpdir(), 'page-receipt-probe-'))
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
jq() { printf '%s\\n' native-page-creation-receipts-schema; }
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
    for (const table of ['pageCreationReceipts', 'liveNoteConnections', 'liveNoteRequests', 'liveNoteRevisions', 'liveNotes', 'pages', 'users']) {
      await db.schema.dropTableIfExists(table)
    }
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
    })
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
    })
    await createNotes(db)
    await up(db)
    await db('users').insert([{ id: 7 }, { id: 8 }])
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

  it('probes read-only, retains proof after source/destination deletion, and refuses destructive rollback', async () => {
    expect(probe().status).toBe(0)
    await db('pages').insert({ id: 42 })
    const now = new Date()
    await db('liveNotes').insert({ id: noteId, key: 'published-note', ownerId: 7, state: 'saved', createdAt: now, updatedAt: now, touchedAt: now })
    await db('pageCreationReceipts').insert({ ...receipt(), originKind: 'live-note', originId: noteId, originRevision: 0 })
    const before = await db('pageCreationReceipts')
    expect(probe().status).toBe(0)
    expect(await db('pageCreationReceipts')).toEqual(before)
    await db('pages').where({ id: 42 }).delete()
    await db('liveNotes').where({ id: noteId }).delete()
    expect(await db('pageCreationReceipts')).toEqual(before)
    expect(probe().status).toBe(0)
    await expect(down(db)).rejects.toThrow('authoritative success records')
    expect(await db('pageCreationReceipts')).toEqual(before)
    await db('users').where({ id: 7 }).delete()
    expect(await db('pageCreationReceipts')).toEqual([])
    await down(db)
    expect(await db.schema.hasTable('pageCreationReceipts')).toBe(false)
  })

  it('enforces owner/request uniqueness and actual account foreign keys while isolating owners', async () => {
    await db('pageCreationReceipts').insert(receipt())
    await expect(Promise.resolve(db('pageCreationReceipts').insert({ ...receipt(), pageId: 43 }))).rejects.toMatchObject({ code: '23505' })
    await db('pageCreationReceipts').insert({ ...receipt(), ownerId: 8, pageId: 44 })
    await expect(Promise.resolve(db('pageCreationReceipts').insert({ ...receipt(), ownerId: 99 }))).rejects.toMatchObject({ code: '23503' })
    expect(await db('pageCreationReceipts').orderBy('ownerId')).toMatchObject([
      { ownerId: 7, pageId: 42 },
      { ownerId: 8, pageId: 44 }
    ])
    expect(probe().status).toBe(0)
  })

  it.each([
    ['zero committed revision', { sourceRevision: '0' }, 'page_creation_source_revision_check'],
    ['missing note capture revision', { originKind: 'live-note', originId: noteId }, 'page_creation_origin_check'],
    ['unsafe note capture revision', { originKind: 'live-note', originId: noteId, originRevision: '9007199254740992' }, 'page_creation_origin_check'],
    ['negative note capture revision', { originKind: 'live-note', originId: noteId, originRevision: '-1' }, 'page_creation_origin_check'],
    ['answer without session', { originKind: 'agent-answer', originId: noteId }, 'page_creation_origin_check'],
    ['orphaned origin identity', { originId: noteId }, 'page_creation_origin_check'],
    ['unrecognized origin', { originKind: 'other', originId: noteId }, 'page_creation_origin_check']
  ] as const)('native writes reject %s', async (_name, invalid, constraint) => {
    await expect(Promise.resolve(db('pageCreationReceipts').insert({ ...receipt(), ...invalid }))).rejects.toMatchObject({ code: '23514', constraint })
    expect(await db('pageCreationReceipts')).toEqual([])
  })

  it.each([
    ['lost request uniqueness', 'ALTER TABLE "pageCreationReceipts" DROP CONSTRAINT "pageCreationReceipts_pkey"'],
    ['lost owner foreign key', 'ALTER TABLE "pageCreationReceipts" DROP CONSTRAINT "pagecreationreceipts_ownerid_foreign"'],
    ['lost origin index', 'DROP INDEX page_creation_origin_inventory_idx'],
    [
      'unvalidated origin check',
      'ALTER TABLE "pageCreationReceipts" DROP CONSTRAINT page_creation_origin_check; ALTER TABLE "pageCreationReceipts" ADD CONSTRAINT page_creation_origin_check CHECK (true) NOT VALID'
    ],
    ['lost committed revision check', 'ALTER TABLE "pageCreationReceipts" DROP CONSTRAINT page_creation_source_revision_check'],
    ['narrowed revision storage', 'ALTER TABLE "pageCreationReceipts" ALTER COLUMN "sourceRevision" TYPE integer'],
    ['destructive destination foreign key', 'ALTER TABLE "pageCreationReceipts" ADD FOREIGN KEY ("pageId") REFERENCES pages(id) ON DELETE CASCADE']
  ])('the executable probe rejects %s', async (_name, sql) => {
    await db.raw(sql)
    const result = probe()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Postcondition failed')
  })

  it('detects malformed authoritative rows even after a named check has been replaced with a tautology', async () => {
    await db.raw(
      'ALTER TABLE "pageCreationReceipts" DROP CONSTRAINT page_creation_origin_check; ALTER TABLE "pageCreationReceipts" ADD CONSTRAINT page_creation_origin_check CHECK (true)'
    )
    await db('pageCreationReceipts').insert({ ...receipt(), originKind: 'live-note', originId: noteId })
    const result = probe()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('invalid authoritative receipt rows')
    expect(await db('pageCreationReceipts')).toHaveLength(1)
  })
})
