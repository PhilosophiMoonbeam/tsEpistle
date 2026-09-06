import { generateKeyPairSync, randomUUID } from 'node:crypto'
import knexModule, { type Knex } from 'knex'
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from '../bun-test.mts'
import { createMailWorkspaceStore } from '../../operations/mail-workspace.ts'
import { mailConfigurationKey } from '../../repositories/mail-configuration.ts'
import { up as migration } from '../../db/migrations/tsepistle-000024-mail-diagnostics.ts'
import type { MailRuntime } from '../../core/mail.ts'
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
suite('Mail workspace diagnostics on PostgreSQL', () => {
  let db: Knex, fallback: Record<string, unknown>
  let workspace: ReturnType<typeof createMailWorkspaceStore>, runtimeKey: string, runtimeEnabled: boolean
  const verify = vi.fn(),
    send = vi.fn(),
    render = vi.fn(),
    resolveTxt = vi.fn(),
    published = vi.fn()
  const waitForCheck = async (id: string, state: string) =>
    vi.waitFor(async () => expect((await db('mailChecks').where('id', id).first()).state).toBe(state), { timeout: 3000 })
  const raw = async () => (await db('settings').where('key', 'mail').first()).value
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
    await migration(db)
  })
  afterAll(async () => {
    if (db) {
      for (const table of ['mailChecks', 'settings', 'userGroups', 'groups', 'users']) await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })
  beforeEach(async () => {
    for (const table of ['mailChecks', 'settings', 'userGroups', 'groups', 'users']) await db(table).delete()
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
    runtimeKey = mailConfigurationKey(initial())
    runtimeEnabled = true
    verify.mockReset().mockResolvedValue(true)
    send.mockReset().mockResolvedValue({ accepted: ['recipient@example.test'], rejected: [] })
    render.mockReset().mockResolvedValue({ html: '<p>Actual renderer fixture</p>', subject: 'Sample' })
    resolveTxt.mockReset()
    published.mockReset().mockImplementation(value => {
      runtimeKey = mailConfigurationKey(value)
      runtimeEnabled = value.enabled !== false
    })
    const runtime = {
      runtime: () => ({ active: runtimeEnabled, configurationKey: runtimeKey, generation: 'fixture', paused: false, state: 'ready' }),
      verify,
      send,
      render
    } as unknown as MailRuntime
    workspace = createMailWorkspaceStore({
      db,
      reviewKey: 'fixture-only-mail-review-key',
      fallback: () => fallback,
      runtime: () => runtime,
      publish: published,
      resolveTxt
    })
  })
  it('applies only committed settings and reports an apply failure without losing the saved receipt', async () => {
    const input = body(await workspace.inspect(admin))
    input.policy.senderName = 'Committed sender'
    published.mockImplementation(value => {
      expect(value.senderName).toBe('Committed sender')
      runtimeKey = mailConfigurationKey(value)
    })
    const result = await workspace.save(admin, input)
    expect(result.applied).toBe(true)
    expect((await raw()).senderName).toBe('Committed sender')
    const next = body(await workspace.inspect(admin))
    next.policy.senderName = 'Saved despite apply failure'
    published.mockImplementation(() => {
      throw new Error('private failure')
    })
    const failed = await workspace.save(admin, next)
    expect(failed.applied).toBe(false)
    expect((await raw()).senderName).toBe('Saved despite apply failure')
    expect((await workspace.inspect(admin)).runtime.settingsCurrent).toBe(false)
  })
  it('does not publish process settings when configuration persistence rolls back', async () => {
    await db.raw(
      `CREATE FUNCTION reject_mail_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key = 'mailAdministration' THEN RAISE EXCEPTION 'fixture history failure'; END IF; RETURN NEW; END $$`
    )
    await db.raw('CREATE TRIGGER reject_mail_history BEFORE INSERT OR UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION reject_mail_history()')
    try {
      const input = body(await workspace.inspect(admin))
      input.policy.senderName = 'Must roll back'
      await expect(workspace.save(admin, input)).rejects.toThrow('fixture history failure')
      expect(published).not.toHaveBeenCalled()
      expect((await raw()).senderName).toBe('Wiki team')
    } finally {
      await db.raw('DROP TRIGGER reject_mail_history ON settings')
      await db.raw('DROP FUNCTION reject_mail_history()')
    }
  })
  it('rechecks current authority after recording a check and before any SMTP effect', async () => {
    const original = workspace.configuration.reviewState
    let release!: () => void,
      entered!: () => void,
      calls = 0
    const blocked = new Promise<void>(resolve => {
        release = resolve
      }),
      ready = new Promise<void>(resolve => {
        entered = resolve
      })
    workspace.configuration.reviewState = async (...args) => {
      calls++
      if (calls === 2) {
        entered()
        await blocked
      }
      return original(...args)
    }
    const fingerprint = (await workspace.inspect(admin)).fingerprint
    calls = 0
    const id = randomUUID()
    await workspace.startCheck(admin, { id, kind: 'test', fingerprint, recipient: 'recipient@example.test', confirmSend: true })
    await ready
    await db('groups').where('id', 1).update({ permissions: '[]' })
    release()
    await waitForCheck(id, 'failed')
    expect(send).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
    expect((await db('mailChecks').where('id', id).first()).summary).toContain('No diagnostic message was sent')
  })
  it('reapplies a current saved review, rejects stale apply and preserves credentials in public observations', async () => {
    const saved = await workspace.inspect(admin)
    runtimeKey = 'stale-key'
    expect((await workspace.inspect(admin)).runtime.settingsCurrent).toBe(false)
    expect((await workspace.apply(admin, { fingerprint: saved.fingerprint })).applied).toBe(true)
    expect((await workspace.inspect(admin)).runtime.settingsCurrent).toBe(true)
    await expect(workspace.apply(admin, { fingerprint: '0'.repeat(64) })).rejects.toMatchObject({ status: 409 })
    expect(JSON.stringify(await workspace.inspect(admin))).not.toContain('original-smtp-secret')
  })
  it('records a connection result without sending, and deduplicates an existing request ID', async () => {
    const input = { id: randomUUID(), kind: 'connection', fingerprint: (await workspace.inspect(admin)).fingerprint }
    expect((await workspace.startCheck(admin, input)).state).toBe('running')
    await waitForCheck(input.id, 'succeeded')
    const replay = await workspace.startCheck(admin, input)
    expect(replay.state).toBe('succeeded')
    expect(verify).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
    expect(replay.summary).toContain('No message was sent')
    expect(await workspace.receipt(admin, input.id)).toEqual(replay)
    await expect(workspace.receipt(admin, randomUUID())).rejects.toMatchObject({ status: 404 })
    expect(verify).toHaveBeenCalledTimes(1)
  })
  it('allows one running check and retains exact configuration evidence after a later save', async () => {
    let finish!: (value: true) => void
    verify.mockImplementation(
      () =>
        new Promise<true>(resolve => {
          finish = resolve
        })
    )
    const initial = await workspace.inspect(admin),
      id = randomUUID()
    await workspace.startCheck(admin, { id, kind: 'connection', fingerprint: initial.fingerprint })
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1))
    await expect(workspace.startCheck(admin, { id: randomUUID(), kind: 'connection', fingerprint: initial.fingerprint })).rejects.toMatchObject({ status: 409 })
    const input = body(initial)
    input.policy.senderName = 'New sender'
    await workspace.save(admin, input)
    finish(true)
    await waitForCheck(id, 'succeeded')
    const check = (await workspace.inspect(admin)).checks[0]!
    expect(check.configurationRevision).toBe(initial.revision)
    expect(check.configurationRevision).not.toBe((await workspace.inspect(admin)).revision)
  })
  it('requires an enabled current runtime, current access and a non-offline workspace before effects', async () => {
    let saved = await workspace.inspect(admin)
    runtimeKey = 'stale'
    await expect(workspace.startCheck(admin, { id: randomUUID(), kind: 'connection', fingerprint: saved.fingerprint })).rejects.toMatchObject({ status: 409 })
    runtimeKey = mailConfigurationKey(await raw())
    await db('settings').where('key', 'offline').update({ value: '{"v":true}' })
    saved = await workspace.inspect(admin)
    await expect(workspace.startCheck(admin, { id: randomUUID(), kind: 'connection', fingerprint: saved.fingerprint })).rejects.toMatchObject({ status: 409 })
    await db('groups').where('id', 1).update({ permissions: '[]' })
    await expect(workspace.startCheck(admin, { id: randomUUID(), kind: 'connection', fingerprint: saved.fingerprint })).rejects.toMatchObject({ status: 403 })
    expect(verify).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
  it('requires a single confirmed test recipient and records SMTP acceptance without claiming delivery', async () => {
    const saved = await workspace.inspect(admin)
    for (const input of [
      { id: randomUUID(), kind: 'test', fingerprint: saved.fingerprint, recipient: 'recipient@example.test' },
      { id: randomUUID(), kind: 'test', fingerprint: saved.fingerprint, recipient: 'one@example.test,two@example.test', confirmSend: true }
    ])
      await expect(workspace.startCheck(admin, input)).rejects.toMatchObject({ status: 400 })
    const input = { id: randomUUID(), kind: 'test', fingerprint: saved.fingerprint, recipient: 'recipient@example.test', confirmSend: true }
    await workspace.startCheck(admin, input)
    await waitForCheck(input.id, 'succeeded')
    expect(send).toHaveBeenCalledTimes(1)
    const check = (await workspace.inspect(admin)).checks[0]!
    expect(check.recipient).toBe(input.recipient)
    expect(check.summary).toContain('Check the recipient mailbox')
    await workspace.startCheck(admin, input)
    expect(send).toHaveBeenCalledTimes(1)
    await expect(workspace.startCheck(admin, { ...input, recipient: 'different@example.test' })).rejects.toMatchObject({ status: 409 })
  })
  it('keeps an uncertain send visible and requires explicit acknowledgement before another test', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('private SMTP trace'), { code: 'ESOCKET' }))
    const input = {
      id: randomUUID(),
      kind: 'test',
      fingerprint: (await workspace.inspect(admin)).fingerprint,
      recipient: 'recipient@example.test',
      confirmSend: true
    }
    await workspace.startCheck(admin, input)
    await waitForCheck(input.id, 'uncertain')
    expect(JSON.stringify(await workspace.inspect(admin))).not.toContain('private SMTP trace')
    await expect(workspace.startCheck(admin, { ...input, id: randomUUID() })).rejects.toMatchObject({ status: 409 })
    const next = { ...input, id: randomUUID(), acknowledgedUncertainId: input.id }
    await workspace.startCheck(admin, next)
    await waitForCheck(next.id, 'succeeded')
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('projects an abandoned check as uncertain and never replays it on refresh or repeated request', async () => {
    const saved = await workspace.inspect(admin),
      id = randomUUID()
    await db('mailChecks').insert({
      id,
      kind: 'test',
      state: 'running',
      actorId: 1,
      recipient: 'recipient@example.test',
      configurationRevision: saved.revision,
      reviewFingerprint: saved.fingerprint,
      createdAt: new Date(Date.now() - 180000).toISOString(),
      summary: 'Started'
    })
    expect((await workspace.inspect(admin)).checks[0]!.state).toBe('uncertain')
    expect(
      (await workspace.startCheck(admin, { id, kind: 'test', fingerprint: saved.fingerprint, recipient: 'recipient@example.test', confirmSend: true })).state
    ).toBe('uncertain')
    expect(send).not.toHaveBeenCalled()
    await expect(
      workspace.startCheck(admin, { id: randomUUID(), kind: 'test', fingerprint: saved.fingerprint, recipient: 'recipient@example.test', confirmSend: true })
    ).rejects.toMatchObject({ status: 409 })
    expect(send).not.toHaveBeenCalled()
  })
  it('checks a staged DKIM key before enabling signing or SMTP delivery', async () => {
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const input = body(await workspace.inspect(admin))
    input.policy.useDKIM = false
    input.policy.enabled = false
    input.secrets.dkimPrivateKey = { action: 'replace', value: pem }
    await workspace.save(admin, input)
    const saved = await workspace.inspect(admin)
    resolveTxt.mockResolvedValue([[saved.dkimRecord!.value]])
    const check = { id: randomUUID(), kind: 'dkim', fingerprint: saved.fingerprint }
    await workspace.startCheck(admin, check)
    await waitForCheck(check.id, 'succeeded')
    expect(saved.policy.enabled).toBe(false)
    expect(saved.runtime.allocated).toBe(false)
    expect(saved.policy.useDKIM).toBe(false)
    expect(resolveTxt).toHaveBeenCalledWith('wiki._domainkey.example.test')
    expect(send).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
  })
  it('previews only bundled templates with fixed sample data and without SMTP effects', async () => {
    const result = await workspace.preview(admin, 'account-welcome')
    expect(result.title).toBe('Account invitation')
    expect(render.mock.calls[0]![0]).toMatchObject({
      template: 'account-welcome',
      to: 'preview@example.test',
      data: { buttonLink: 'https://wiki.example.test/login' }
    })
    await expect(workspace.preview(admin, '../private')).rejects.toMatchObject({ status: 404 })
    expect(send).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
  })
})
