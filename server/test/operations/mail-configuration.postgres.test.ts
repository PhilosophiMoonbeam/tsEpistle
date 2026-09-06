import { generateKeyPairSync } from 'node:crypto'
import knexModule, { type Knex } from 'knex'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from '../bun-test.mts'
import { createMailConfigurationStore } from '../../operations/mail-configuration.ts'
import type { MailConfigurationWorkspace, MailDraft } from '../../../shared/mail-workspace.ts'
const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? '',
  password = process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  database.endsWith('_mail_test') && password
    ? { host: '127.0.0.1', port: Number(process.env.WIKI_TEST_POSTGRES_PORT), user: 'wiki', database, password }
    : null
const suite = connection ? describe : describe.skip,
  admin = { id: 1, authVersion: 0 } as never
const initial = () => ({
  senderName: 'Wiki team',
  senderEmail: 'wiki@example.test',
  host: 'smtp.example.test',
  port: 587,
  secure: false,
  verifySSL: true,
  user: 'x',
  pass: 'original-smtp-secret',
  name: '',
  useDKIM: false,
  dkimDomainName: 'example.test',
  dkimKeySelector: 'wiki',
  dkimPrivateKey: 'retained-inactive-key',
  opaque: { secret: 'unowned-private-config' }
})
const body = (workspace: MailConfigurationWorkspace): MailDraft & { fingerprint: string; reason: string } => ({
  policy: structuredClone(workspace.policy),
  secrets: { pass: { action: 'keep' }, dkimPrivateKey: { action: 'keep' } },
  fingerprint: workspace.fingerprint,
  reason: 'Review mail configuration'
})
suite('Reviewed mail configuration on PostgreSQL', () => {
  let db: Knex, store: ReturnType<typeof createMailConfigurationStore>, fallback: Record<string, unknown>
  const read = () => store.inspect(admin),
    raw = async () => (await db('settings').where('key', 'mail').first()).value
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 6 } })
    await db.schema.createTable('settings', t => {
      t.string('key').primary()
      t.jsonb('value')
      t.string('updatedAt').notNullable()
    })
    await db.schema.createTable('users', t => {
      t.integer('id').primary()
      t.boolean('isActive')
      t.integer('authVersion')
    })
    await db.schema.createTable('groups', t => {
      t.integer('id').primary()
      t.jsonb('permissions')
      t.string('adminRevision')
    })
    await db.schema.createTable('userGroups', t => {
      t.integer('userId')
      t.integer('groupId')
    })
  })
  afterAll(async () => {
    if (db) {
      for (const table of ['settings', 'userGroups', 'groups', 'users']) await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })
  beforeEach(async () => {
    for (const table of ['settings', 'userGroups', 'groups', 'users']) await db(table).delete()
    await db('users').insert([
      { id: 1, isActive: true, authVersion: 0 },
      { id: 3, isActive: true, authVersion: 0 }
    ])
    await db('groups').insert([
      { id: 1, permissions: '["manage:system"]', adminRevision: 'initial' },
      { id: 2, permissions: '[]', adminRevision: 'initial' }
    ])
    await db('userGroups').insert([
      { userId: 1, groupId: 1 },
      { userId: 3, groupId: 2 }
    ])
    for (const [key, value] of [
      ['mail', initial()],
      ['offline', { v: false }],
      ['host', { v: 'https://wiki.example.test' }]
    ] as const)
      await db('settings').insert({ key, value: JSON.stringify(value), updatedAt: '2026-09-06T00:00:00.000Z' })
    fallback = { mail: { pass: 'stale-runtime-secret' }, host: 'https://stale.example.test', offline: true }
    store = createMailConfigurationStore({ db, reviewKey: 'fixture-only-mail-review-key', fallback: () => fallback })
  })
  it('reads persisted settings and credential presence without private or unowned material', async () => {
    const workspace = await read(),
      json = JSON.stringify(workspace)
    expect(workspace).toMatchObject({
      policy: { tlsMode: 'opportunistic', enabled: true, user: 'x' },
      offline: false,
      publicUrl: 'https://wiki.example.test',
      secrets: { pass: true, dkimPrivateKey: true },
      issues: [],
      dkimRecord: null
    })
    for (const secret of ['original-smtp-secret', 'retained-inactive-key', 'unowned-private-config', 'stale-runtime-secret']) expect(json).not.toContain(secret)
    expect(workspace.fingerprint).toHaveLength(64)
  })
  it('preserves opaque values and credentials while recording changed fields atomically', async () => {
    const input = body(await read())
    input.policy.replyTo = 'help@example.test'
    const receipt = await store.save(admin, input),
      workspace = await read()
    expect(await raw()).toMatchObject({ ...initial(), replyTo: 'help@example.test' })
    expect(workspace.history).toEqual(
      [{ ...receipt, actorId: 1, createdAt: workspace.history[0]!.createdAt, reason: input.reason, id: receipt.revision }].map(
        ({ revision: _revision, ...event }) => event
      )
    )
    expect(receipt.fields).toEqual(['replyTo'])
    expect(workspace.revision).toBe(receipt.revision)
    expect(fallback.mail).toEqual({ pass: 'stale-runtime-secret' })
  })
  it('supports literal secret replacement, keeping and clearing without returning values', async () => {
    let input = body(await read())
    input.secrets.pass = { action: 'replace', value: '********' }
    await store.save(admin, input)
    expect((await raw()).pass).toBe('********')
    input = body(await read())
    input.policy.senderName = 'Changed team'
    await store.save(admin, input)
    expect((await raw()).pass).toBe('********')
    input = body(await read())
    input.policy.user = ''
    input.secrets.pass = { action: 'clear' }
    input.secrets.dkimPrivateKey = { action: 'clear' }
    await store.save(admin, input)
    const workspace = await read()
    expect(workspace.secrets).toEqual({ pass: false, dkimPrivateKey: false })
    expect(JSON.stringify(workspace.history)).not.toContain('********')
  })
  it('pauses without removing credentials and permits incomplete inactive configuration', async () => {
    const input = body(await read())
    input.policy.enabled = false
    input.policy.host = ''
    input.policy.useDKIM = true
    await store.save(admin, input)
    expect((await read()).issues).toEqual([])
    expect(await raw()).toMatchObject({ enabled: false, host: '', pass: 'original-smtp-secret', dkimPrivateKey: 'retained-inactive-key' })
    const resume = body(await read())
    resume.policy.enabled = true
    await expect(store.save(admin, resume)).rejects.toMatchObject({ status: 400 })
  })
  it('requires current account sessions and persisted system authority for reads and saves', async () => {
    const input = body(await read())
    input.policy.senderName = 'Changed team'
    for (const requester of [undefined, { id: 2 }, { id: 3, authVersion: 0 }, { id: 1, authVersion: 1 }]) {
      await expect(store.inspect(requester as never)).rejects.toMatchObject({ status: 403 })
      await expect(store.save(requester as never, input)).rejects.toMatchObject({ status: 403 })
    }
    await db('users').where('id', 1).update({ isActive: false })
    await expect(read()).rejects.toMatchObject({ status: 403 })
    await db('users').where('id', 1).update({ isActive: true })
    await db('groups').where('id', 1).update({ permissions: '[]' })
    await expect(read()).rejects.toMatchObject({ status: 403 })
  })
  it('accepts only the current granted group of an unowned API principal', async () => {
    expect((await store.inspect({ id: 1, ownershipUserId: null, groups: [1] } as never)).policy.enabled).toBe(true)
    for (const requester of [
      { id: 1, ownershipUserId: null, groups: [2] },
      { id: 1, ownershipUserId: null, groups: [1, 2] },
      { id: 3, ownershipUserId: null, groups: [1] }
    ])
      await expect(store.inspect(requester as never)).rejects.toMatchObject({ status: 403 })
  })
  it('rejects stale and ABA reviews even when the sender returns to its original value', async () => {
    const first = body(await read()),
      next = structuredClone(first)
    next.policy.senderName = 'Interim team'
    await store.save(admin, next)
    const reset = body(await read())
    reset.policy.senderName = first.policy.senderName
    await store.save(admin, reset)
    first.policy.senderName = 'Stale team'
    await expect(store.save(admin, first)).rejects.toMatchObject({ status: 409 })
    expect((await raw()).senderName).toBe('Wiki team')
  })
  it('fences reviews after dependency, membership, access or secret changes', async () => {
    let input = body(await read())
    input.policy.senderName = 'Changed'
    await db('settings').where('key', 'offline').update({ value: '{"v":true}' })
    await expect(store.save(admin, input)).rejects.toMatchObject({ status: 409 })
    input = body(await read())
    input.policy.senderName = 'Changed'
    await db('groups').where('id', 1).update({ adminRevision: 'new-revision' })
    await expect(store.save(admin, input)).rejects.toMatchObject({ status: 409 })
    input = body(await read())
    input.policy.senderName = 'Changed'
    await db('settings')
      .where('key', 'mail')
      .update({ value: JSON.stringify({ ...initial(), pass: 'changed-elsewhere' }) })
    await expect(store.save(admin, input)).rejects.toMatchObject({ status: 409 })
    input = body(await read())
    input.policy.senderName = 'Changed'
    await db('userGroups').insert({ userId: 1, groupId: 2 })
    await expect(store.save(admin, input)).rejects.toMatchObject({ status: 409 })
  })
  it('serializes competing publications so a review can commit only once', async () => {
    const first = body(await read()),
      second = structuredClone(first)
    first.policy.senderName = 'First'
    second.policy.senderName = 'Second'
    const results = await Promise.allSettled([store.save(admin, first), store.save(admin, second)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409 })
    expect((await read()).history).toHaveLength(1)
  })
  it('rejects malformed drafts and enabled signing with invalid keys without partial persistence', async () => {
    const before = await raw(),
      input = body(await read())
    input.policy.useDKIM = true
    input.policy.senderName = 'Must not persist'
    await expect(store.save(admin, input)).rejects.toMatchObject({ status: 400 })
    expect(await raw()).toEqual(before)
    expect((await read()).history).toEqual([])
    for (const malformed of [
      { ...body(await read()), pass: 'unreviewed' },
      { ...body(await read()), secrets: { pass: { action: 'keep' } } },
      { ...body(await read()), policy: { ...input.policy, port: 0 } }
    ])
      await expect(store.save(admin, malformed)).rejects.toMatchObject({ status: 400 })
  })
  it('derives DNS publication from the actual saved signing key and never exposes private key material', async () => {
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const input = body(await read())
    input.policy.useDKIM = true
    input.secrets.dkimPrivateKey = { action: 'replace', value: pem }
    await store.save(admin, input)
    const workspace = await read()
    expect(workspace.dkimRecord).toMatchObject({ name: 'wiki._domainkey.example.test', bits: 2048 })
    expect(workspace.dkimRecord!.value).toStartWith('v=DKIM1; k=rsa; p=')
    expect(JSON.stringify(workspace)).not.toContain(pem)
    expect(workspace.issues).toEqual([])
  })
  it('rolls configuration back if its history cannot be persisted', async () => {
    await db.raw(
      `CREATE FUNCTION reject_mail_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key = 'mailAdministration' THEN RAISE EXCEPTION 'fixture history failure'; END IF; RETURN NEW; END $$`
    )
    await db.raw('CREATE TRIGGER reject_mail_history BEFORE INSERT OR UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION reject_mail_history()')
    try {
      const before = await raw(),
        input = body(await read())
      input.policy.senderName = 'Must roll back'
      await expect(store.save(admin, input)).rejects.toThrow('fixture history failure')
      expect(await raw()).toEqual(before)
      expect(fallback.mail).toEqual({ pass: 'stale-runtime-secret' })
    } finally {
      await db.raw('DROP TRIGGER reject_mail_history ON settings')
      await db.raw('DROP FUNCTION reject_mail_history()')
    }
  })
  it('bounds configuration history and rejects empty publications', async () => {
    await expect(store.save(admin, body(await read()))).rejects.toMatchObject({ status: 400 })
    for (let i = 0; i < 52; i++) {
      const input = body(await read())
      input.policy.senderName = `Team ${i}`
      await store.save(admin, input)
    }
    const workspace = await read()
    expect(workspace.history).toHaveLength(50)
    expect(workspace.history[0]!.id).toBe(workspace.revision)
  })
})
