import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up, down } from '../../db/migrations/tsepistle-000067-live-notes.ts'
import { up as retireSessions } from '../../db/migrations/tsepistle-000071-browser-session-retirement.ts'
import { up as createHedgedocImports } from '../../db/migrations/tsepistle-000072-hedgedoc-import.ts'
import { up as createFeedback } from '../../db/migrations/tsepistle-000073-page-feedback.ts'
import { up as createReviewRouting } from '../../db/migrations/tsepistle-000074-page-review-routing.ts'
import { up as createLifecycle } from '../../db/migrations/tsepistle-000075-page-lifecycle.ts'
import { up as createGovernedNotifications } from '../../db/migrations/tsepistle-000076-governed-notifications.ts'
import { up as createStorageImportOwners, down as downStorageImportOwners } from '../../db/migrations/tsepistle-000077-storage-page-import-owners.ts'

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
  await client.query("SELECT set_config('search_path', $1, false)", [process.env.PROBE_SCHEMA || 'public']);
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
jq() { printf '%s\\n' "$PROBE_NAME"; }
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

  const probe = (name = 'native-live-notes-schema', schema = 'public') => {
    // The full production function exceeds Linux's per-argument exec limit.
    const result = spawnSync('bash', ['-s'], {
      input: shell,
      encoding: 'utf8',
      env: {
        ...process.env,
        PROBE_NODE: process.execPath,
        PROBE_BRIDGE: path.join(directory, 'psql.cjs'),
        PROBE_CONNECTION: JSON.stringify(connection),
        PROBE_NAME: name,
        PROBE_SCHEMA: schema
      }
    })
    if (result.error) throw result.error
    expect(result.signal).toBeNull()
    expect(result.status).not.toBeNull()
    return result
  }

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

  describe('governance migration qualification through 000077', () => {
    let installed: Knex
    const schema = 'governance_deployment_fixture'
    const importReceipt = {
      pageId: 42,
      sourceKey: 'a'.repeat(64),
      sourcePath: 'en/owned.md',
      sourceSha256: 'b'.repeat(64),
      locationKey: 'c'.repeat(64),
      nativeRevision: '5',
      nativePath: 'owned',
      nativeLocaleCode: 'en',
      operationId: '00000000-0000-4000-8000-000000000077'
    }
    const importMoveBinding = {
      phase: 'moved',
      fromGitRevision: 'a'.repeat(40),
      toGitRevision: 'b'.repeat(64),
      oldSourcePath: 'en/original.md',
      newSourcePath: importReceipt.sourcePath,
      oldSourceSha256: 'd'.repeat(64),
      newSourceSha256: importReceipt.sourceSha256,
      previousNativeRevision: '4',
      previousNativePath: 'original',
      previousNativeLocaleCode: 'en',
      moveOperationId: importReceipt.operationId,
      moveNativeRevision: importReceipt.nativeRevision
    }
    const names = [
      'native-browser-session-retirement-schema',
      'native-hedgedoc-import-schema',
      'native-page-feedback-schema',
      'native-page-review-routing-schema',
      'native-page-lifecycle-schema',
      'native-governed-notifications-schema',
      'native-storage-page-import-owners-schema'
    ]

    beforeAll(() => {
      installed = knexModule({ client: 'pg', connection, searchPath: [schema] })
    })

    beforeEach(async () => {
      await installed.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema])
      await installed.raw('CREATE SCHEMA ??', [schema])
      for (const tableName of ['users', 'groups']) {
        await installed.schema.createTable(tableName, table => table.integer('id').primary())
      }
      for (const tableName of ['durableJobs', 'outboxEvents']) {
        await installed.schema.createTable(tableName, table => table.uuid('id').primary())
      }
      await installed.schema.createTable('pages', table => {
        table.integer('id').primary()
        table.text('content').notNullable()
        table.string('contentType').notNullable()
        table.bigInteger('sourceRevision').notNullable()
      })
      await installed('pages').insert({ id: 42, content: 'Preserved canonical source', contentType: 'markdown', sourceRevision: 5 })
      await up(installed)
      // This is the schema installed by the former session store, not a second
      // implementation of migration 71's backfill.
      await installed.schema.createTable('sessions', table => {
        table.string('sid').primary()
        table.json('sess').notNullable()
        table.timestamp('expired').notNullable().index()
      })
      await installed('sessions').insert({ sid: 'legacy-live-session', sess: { retained: true }, expired: new Date('2099-01-01T00:00:00Z') })
      for (const migrate of [retireSessions, createHedgedocImports, createFeedback, createReviewRouting, createLifecycle, createGovernedNotifications, createStorageImportOwners]) {
        await migrate(installed)
      }
    })

    afterAll(async () => {
      if (installed) {
        await installed.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema])
        await installed.destroy()
      }
    })

    it('retains deleted native ownership after page and root-outbox deletion, permits a new active association, and refuses destructive downgrade', async () => {
      await installed('outboxEvents').insert({ id: importReceipt.operationId })
      await installed('storagePageImportOwners').insert(importReceipt)
      expect(await installed('storagePageImportOwners').first()).toMatchObject({ status: 'active', mapped: false, deletedAt: null })
      expect(probe(names[6], schema).status).toBe(0)
      await expect(Promise.resolve(downStorageImportOwners(installed))).rejects.toThrow('durable accepted and deleted identities')
      await expect(Promise.resolve(installed('storagePageImportOwners').insert({ ...importReceipt, pageId: 43 }))).rejects.toMatchObject({ code: '23505' })
      await installed('storagePageImportOwners').where({ pageId: 42 }).update({ status: 'deleted', deletedAt: new Date() })
      await installed('storagePageImportOwners').insert({ ...importReceipt, pageId: 43, operationId: '00000000-0000-4000-8000-000000000078' })
      const before = await installed('storagePageImportOwners').orderBy('pageId')
      await installed('pages').where({ id: 42 }).delete()
      await installed('outboxEvents').where({ id: importReceipt.operationId }).delete()
      const result = probe(names[6], schema)
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(await installed('storagePageImportOwners').orderBy('pageId')).toEqual(before)
    })

    it.each([
      ['nonpositive native revision', { nativeRevision: '0' }, 'storage_page_import_native_identity_check'],
      ['nonpositive native identity', { pageId: 0 }, 'storage_page_import_native_identity_check'],
      ['raw-source proof corruption', { sourceSha256: 'invalid' }, 'storage_page_import_digest_check'],
      ['unbounded source identity', { sourcePath: 'x'.repeat(4097) }, 'storage_page_import_path_bounds_check'],
      ['retired identity without deletion time', { status: 'deleted' }, 'storage_page_import_status_check'],
      ['non-object move binding', { moveBinding: '[]' }, 'storage_page_import_move_binding_check']
    ] as const)('native ownership schema refuses %s', async (_name, invalid, constraint) => {
      await expect(Promise.resolve(installed('storagePageImportOwners').insert({ ...importReceipt, ...invalid }))).rejects.toMatchObject({ code: '23514', constraint })
      expect(await installed('storagePageImportOwners')).toHaveLength(0)
    })

    it('admits a complete retained native move binding without requiring its old root event to remain live', async () => {
      await installed('storagePageImportOwners').insert({ ...importReceipt, moveBinding: JSON.stringify(importMoveBinding) })
      const before = await installed('storagePageImportOwners').first()
      const result = probe(names[6], schema)
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(await installed('storagePageImportOwners').first()).toEqual(before)
    })

    it.each([
      ['extra binding keys', { version: 1 }],
      ['missing binding keys', { moveOperationId: undefined }],
      ['non-string revisions', { previousNativeRevision: 4 }],
      ['noncanonical revisions', { previousNativeRevision: '04' }],
      ['overflowing signed native revisions', { moveNativeRevision: '9223372036854775808' }],
      ['source traversal', { oldSourcePath: 'en/../original.md' }],
      ['empty source segments', { newSourcePath: 'en//owned.md' }],
      ['source backslashes', { newSourcePath: 'en\\owned.md' }],
      ['source control characters', { newSourcePath: 'en/\u001fowned.md' }],
      ['invalid locales', { previousNativeLocaleCode: 'en us' }],
      ['unbounded native paths', { previousNativePath: 'x'.repeat(2049) }],
      ['invalid Git object identity', { fromGitRevision: 'a'.repeat(39) }],
      ['invalid raw-source digest', { newSourceSha256: 'A'.repeat(64) }],
      ['invalid native root identity', { moveOperationId: 'not-a-uuid' }]
    ] as const)('rejects persisted %s in move bindings without rewriting receipts', async (_name, invalid) => {
      await installed('storagePageImportOwners').insert({ ...importReceipt, moveBinding: JSON.stringify({ ...importMoveBinding, ...invalid }) })
      const before = await installed('storagePageImportOwners').first()
      const result = probe(names[6], schema)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('invalid finite native move binding')
      expect(await installed('storagePageImportOwners').first()).toEqual(before)
    })

    it('admits the installed schemas read-only, preserves native data, and keeps optional features unenrolled', async () => {
      const sessionBefore = await installed('sessions').first()
      const pageBefore = await installed('pages').first()
      const clocksBefore = await installed('pageLifecycleClocks').first()
      const registry = JSON.parse(await readFile('server/db/migration-deployment-contracts.json', 'utf8')) as {
        migrations: Record<string, { rehearsalPostconditions: string[]; runtimePostconditions: string[] }>
      }
      const contracts = Object.entries(registry.migrations).filter(([name]) => /^tsepistle-00007[1-7]-.+\.js$/u.test(name))
      expect(contracts).toHaveLength(7)
      const registered = new Set<string>()
      for (const [, contract] of contracts) {
        for (const name of [...contract.rehearsalPostconditions, ...contract.runtimePostconditions]) registered.add(name)
      }
      for (const name of registered) {
        const result = probe(name, schema)
        expect(result.stderr).toBe('')
        expect(result.status).toBe(0)
      }
      expect(await installed('sessions').first()).toEqual(sessionBefore)
      expect(sessionBefore.sess).toEqual({ retained: true })
      expect(await installed('pages').first()).toEqual(pageBefore)
      expect(await installed('pageLifecycleClocks').first()).toEqual(clocksBefore)
      expect(clocksBefore).toMatchObject({
        pageId: 42,
        bodyObservedSourceRevision: '5',
        bodyAnchorKind: 'unknown',
        bodyAnchorAt: null,
        commentAnchorKind: 'unknown',
        commentAnchorAt: null
      })
      for (const table of ['hedgedocImports', 'feedbackBoards', 'pageReviewRouting', 'pageLifecycleRules', 'governedNotificationReceipts', 'governedNotificationEmailAttempts', 'storagePageImportOwners']) {
        expect(await installed(table)).toHaveLength(0)
      }
    })

    it.each([
      ['native-browser-session-retirement-schema', 'browserSessionLifecycles'],
      ['native-hedgedoc-import-schema', 'hedgedocImports'],
      ['native-page-feedback-schema', 'feedbackVotes'],
      ['native-page-review-routing-schema', 'pageReviewConsumed'],
      ['native-page-lifecycle-schema', 'pageLifecycleActionReceipts'],
      ['native-governed-notifications-schema', 'governedNotificationEmailAttempts'],
      ['native-storage-page-import-owners-schema', 'storagePageImportOwners']
    ])('rejects lost durable identity in %s (%s)', async (name, table) => {
      const { rows } = await installed.raw<{ rows: { conname: string }[] }>(
        `SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
         WHERE t.relnamespace=?::regnamespace AND t.relname=? AND c.contype='p'`,
        [schema, table]
      )
      expect(rows).toHaveLength(1)
      await installed.raw('ALTER TABLE ?? DROP CONSTRAINT ??', [table, rows[0]!.conname])
      const result = probe(name, schema)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('durable primary and unique identities')
    })

    it('rejects provenance relations changed from retained native notes to cascading deletion', async () => {
      const { rows } = await installed.raw<{ rows: { conname: string }[] }>(
        `SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
         JOIN pg_class target ON target.oid=c.confrelid
         WHERE t.relnamespace=?::regnamespace AND t.relname='hedgedocImports'
           AND c.contype='f' AND target.relname='liveNotes'`,
        [schema]
      )
      expect(rows).toHaveLength(1)
      await installed.raw('ALTER TABLE ?? DROP CONSTRAINT ??', ['hedgedocImports', rows[0]!.conname])
      await installed.raw('ALTER TABLE "hedgedocImports" ADD FOREIGN KEY ("noteId") REFERENCES "liveNotes" (id) ON DELETE CASCADE')
      const result = probe(names[1], schema)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('native foreign keys and retention actions')
    })

    it.each([
      ['native-browser-session-retirement-schema', 'ALTER TABLE "browserSessionLifecycles" ALTER COLUMN generation TYPE text', 'native columns'],
      ['native-hedgedoc-import-schema', 'ALTER TABLE "hedgedocImports" ALTER COLUMN "snapshotDigest" DROP NOT NULL', 'native columns'],
      ['native-page-feedback-schema', 'ALTER TABLE "feedbackBoards" ALTER COLUMN enabled SET DEFAULT true', 'native defaults'],
      ['native-page-review-routing-schema', 'DROP INDEX page_review_scan_due_idx', 'bounded lookup'],
      ['native-page-lifecycle-schema', 'ALTER TABLE "pageLifecycleRules" ALTER COLUMN "unattendedConsent" SET DEFAULT true', 'native defaults'],
      ['native-page-lifecycle-schema', 'ALTER TABLE "pageLifecycleRulePages" DROP COLUMN "attemptedBodyEpoch"', 'native columns'],
      ['native-page-lifecycle-schema', 'ALTER TABLE "pageLifecycleRulePages" ALTER COLUMN "attemptedIntervalHighWater" SET DEFAULT 0', 'native defaults'],
      ['native-governed-notifications-schema', 'DROP TABLE "governedNotificationEmailAttempts"', 'native columns'],
      ['native-storage-page-import-owners-schema', 'ALTER TABLE "storagePageImportOwners" ALTER COLUMN "operationId" TYPE text', 'native columns'],
      ['native-storage-page-import-owners-schema', 'ALTER TABLE "storagePageImportOwners" ALTER COLUMN mapped SET DEFAULT true', 'native unmapped'],
      ['native-storage-page-import-owners-schema', 'DROP INDEX storage_page_import_active_source_unique', 'active-only source uniqueness'],
      ['native-storage-page-import-owners-schema', `DROP INDEX storage_page_import_active_source_unique;
        CREATE UNIQUE INDEX storage_page_import_active_source_unique ON "storagePageImportOwners" ("sourceKey","sourcePath") WHERE status='deleted'`, 'active-only source uniqueness'],
      ['native-storage-page-import-owners-schema', 'ALTER TABLE "storagePageImportOwners" ADD FOREIGN KEY ("pageId") REFERENCES pages(id)', 'ownership must survive'],
      ['native-storage-page-import-owners-schema', `ALTER TABLE "storagePageImportOwners" DROP CONSTRAINT storage_page_import_digest_check;
        ALTER TABLE "storagePageImportOwners" ADD CONSTRAINT storage_page_import_digest_check CHECK (true)`, 'validated native identity']
    ])('rejects concrete schema corruption for %s', async (name, sql, diagnostic) => {
      await installed.raw(sql)
      const result = probe(name, schema)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(diagnostic)
    })

    it('rejects a missing session backfill and a resurrected retirement without repairing either', async () => {
      await installed('browserSessionLifecycles').delete()
      expect(probe(names[0], schema).status).not.toBe(0)
      await installed('browserSessionLifecycles').insert({
        sid: 'legacy-live-session',
        generation: '00000000-0000-4000-8000-000000000001',
        retiredAt: new Date(),
        expiresAt: new Date('2099-01-01T00:00:00Z')
      })
      expect(probe(names[0], schema).status).not.toBe(0)
      expect(await installed('sessions').first()).toBeDefined()
      expect((await installed('browserSessionLifecycles').first()).retiredAt).not.toBeNull()
    })

    it('rejects an independent schedule with a null interval even when its native nullable check admits it', async () => {
      const now = new Date()
      await installed('pageReviewRouting').insert({
        pageId: 42,
        scheduleMode: 'independent',
        independentAnchorAt: now,
        independentIntervalDays: null,
        observedSourceRevision: 5,
        unverifiedAt: now,
        createdAt: now,
        updatedAt: now
      })
      const result = probe(names[3], schema)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('invalid durable rows')
      expect(await installed('pageReviewRouting')).toHaveLength(1)
    })

    it('allows metadata-only source revisions but rejects missing clocks and invented unknown anchors', async () => {
      await installed('pages').where({ id: 42 }).update({ sourceRevision: 6 })
      expect(probe(names[4], schema).status).toBe(0)
      await installed('pageLifecycleClocks').where({ pageId: 42 }).update({ bodyAnchorAt: new Date() })
      expect(probe(names[4], schema).status).not.toBe(0)
      await installed('pageLifecycleClocks').where({ pageId: 42 }).delete()
      expect(probe(names[4], schema).status).not.toBe(0)
    })

    it('rejects a validated but ineffective notification status check', async () => {
      const { rows } = await installed.raw<{ rows: { conname: string }[] }>(
        `SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
         WHERE t.relnamespace=?::regnamespace AND t.relname='governedNotificationEmailAttempts'
           AND c.contype='c' AND pg_get_constraintdef(c.oid) LIKE '%status%'`,
        [schema]
      )
      expect(rows).toHaveLength(1)
      await installed.raw('ALTER TABLE ?? DROP CONSTRAINT ??', ['governedNotificationEmailAttempts', rows[0]!.conname])
      await installed.raw('ALTER TABLE "governedNotificationEmailAttempts" ADD CONSTRAINT ineffective_status CHECK (true)')
      const result = probe(names[5], schema)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('validated native value and revision checks')
    })
  })
})
