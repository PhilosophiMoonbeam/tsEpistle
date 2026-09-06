import type { Knex } from 'knex'
import { z } from 'zod'
import { MAIL_TEMPLATES, MailCheckRequestSchema, mailRecord, type MailCheck, type MailWorkspace, type MailTemplateKey } from '../../shared/mail-workspace.ts'
import type { MailRuntime } from '../core/mail.ts'
import type { PagePrincipal } from '../helpers/page-access.ts'
import { mailConfigurationKey, mailDkimPublicRecord } from '../repositories/mail-configuration.ts'
import { resolveMailDkimTxt, mailDkimDnsMatches, mailDiagnosticFailure } from '../repositories/mail-diagnostics.ts'
import { createMailConfigurationStore } from './mail-configuration.ts'
import errors from './errors.ts'

interface CheckRow extends Omit<MailCheck, 'createdAt' | 'completedAt'> {
  createdAt: Date | string
  completedAt: Date | string | null
  reviewFingerprint: string
}
interface Dependencies {
  db: Knex
  reviewKey: string
  fallback(): Record<string, unknown>
  runtime(): MailRuntime
  publish(configuration: Record<string, unknown>): void
  resolveTxt?(name: string): Promise<string[][]>
  now?(): Date
}
const fail = (message: string, status = 400): never => {
  throw new errors.ApplicationError(message, { status })
}
const active = new Set<string>()
const stamp = (value: Date | string) => new Date(value).toISOString()
const interrupted = (row: CheckRow, now: Date) => row.state === 'running' && !active.has(row.id) && new Date(row.createdAt).getTime() + 120000 < now.getTime()
const presentCheck = (row: CheckRow, now: Date): MailCheck => ({
  id: row.id,
  kind: row.kind,
  actorId: row.actorId,
  recipient: row.recipient,
  configurationRevision: row.configurationRevision,
  createdAt: stamp(row.createdAt),
  completedAt: row.completedAt ? stamp(row.completedAt) : null,
  state: interrupted(row, now) ? 'uncertain' : row.state,
  summary: interrupted(row, now) ? 'This check stopped reporting before its outcome was recorded. It has not been retried.' : row.summary
})
const ReviewSchema = z.object({ fingerprint: z.string().length(64) }).strict()
export const createMailWorkspaceStore = (deps: Dependencies) => {
  const configuration = createMailConfigurationStore(deps),
    now = () => deps.now?.() ?? new Date()
  // Order local publication independently of SMTP work already using a captured transport.
  let mutation: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const result = mutation.then(task, task)
    mutation = result.catch(() => {})
    return result
  }
  const runtimeView = (saved: Awaited<ReturnType<typeof configuration.reviewState>>): MailWorkspace['runtime'] => {
    const value = deps.runtime().runtime()
    return { allocated: value.active, settingsCurrent: value.configurationKey === mailConfigurationKey(saved.raw), offline: value.paused, state: value.state }
  }
  const inspect = async (requester: PagePrincipal): Promise<MailWorkspace> => {
    const tx = await deps.db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
    try {
      const saved = await configuration.reviewState(tx, requester),
        checks = await tx<CheckRow>('mailChecks').orderBy('createdAt', 'desc').orderBy('id', 'desc').limit(50)
      const result = { ...configuration.presentState(saved), runtime: runtimeView(saved), checks: checks.map(row => presentCheck(row, now())) }
      await tx.commit()
      return result
    } catch (error) {
      await tx.rollback()
      throw error
    }
  }
  const apply = async (requester: PagePrincipal, input: unknown, save: boolean) =>
    serial(async () => {
      const parsed = save ? null : ReviewSchema.safeParse(input)
      if (!save && !parsed?.success) return fail('Reload the saved settings before applying the transport.')
      const result = await deps.db.transaction(async tx => {
        const receipt = save ? await configuration.save(requester, input, tx) : null
        const saved = await configuration.reviewState(tx, requester, true)
        if (!save && parsed?.success && parsed.data.fingerprint !== saved.fingerprint)
          return fail('Mail settings or access changed. Reload and review again.', 409)
        return { receipt, saved }
      })
      let applied = false
      try {
        deps.publish(result.saved.raw)
        applied = runtimeView(result.saved).settingsCurrent && (!result.saved.runtime.enabled || deps.runtime().runtime().active)
      } catch {
        /* Persistence succeeded; report the need to apply again without claiming a rollback. */
      }
      return { revision: result.receipt?.revision ?? configuration.presentState(result.saved).revision, applied }
    })
  const execute = async (requester: PagePrincipal, id: string, kind: MailCheck['kind']) => {
    let startedEffect = false
    try {
      const checked = await deps.db.transaction(async tx => {
        const saved = await configuration.reviewState(tx, requester, true),
          row = await tx<CheckRow>('mailChecks').where('id', id).forUpdate().first()
        if (!row || row.state !== 'running') return null
        if (row.reviewFingerprint !== saved.fingerprint) return { failure: 'Mail settings or access changed before the check started.' } as const
        if (saved.configuration.offline === true || deps.runtime().runtime().paused)
          return { failure: 'Mail checks are paused while offline mode is enabled.' } as const
        if (kind !== 'dkim' && (!runtimeView(saved).settingsCurrent || !deps.runtime().runtime().active))
          return { failure: 'Apply the saved, enabled transport before running an SMTP check.' } as const
        return { saved, row }
      })
      if (!checked) return
      let outcome: Pick<MailCheck, 'state' | 'summary'>
      if ('failure' in checked) outcome = { state: 'failed', summary: checked.failure! }
      else if (kind === 'dkim') {
        const record = mailDkimPublicRecord(checked.saved.runtime, true)
        if (!record) outcome = { state: 'failed', summary: 'Configure DKIM signing before checking its DNS record.' }
        else {
          startedEffect = true
          const records = await (deps.resolveTxt ?? resolveMailDkimTxt)(record.name)
          const matches = mailDkimDnsMatches(records, record.value)
          outcome = {
            state: matches ? 'succeeded' : 'failed',
            summary: matches
              ? 'The published DKIM public key matches the saved signing key. This does not verify SPF, DMARC or recipient delivery.'
              : 'The selector does not contain one valid DKIM key matching the saved signing key. Review its TXT record and DNS propagation.'
          }
        }
      } else if (kind === 'connection') {
        startedEffect = true
        await deps.runtime().verify(mailConfigurationKey(checked.saved.raw))
        outcome = {
          state: 'succeeded',
          summary: 'The SMTP connection and configured authentication succeeded. No message was sent; sender acceptance and recipient delivery were not tested.'
        }
      } else {
        startedEffect = true
        const sent = await deps.runtime().send(
          {
            template: 'test',
            to: checked.row.recipient!,
            subject: 'Mail delivery test',
            text: 'This is the mail delivery test requested in your workspace administration.',
            data: { preheadertext: 'Your requested workspace delivery test.' }
          },
          mailConfigurationKey(checked.saved.raw)
        )
        outcome =
          sent.accepted?.length === 1 && !sent.rejected?.length
            ? { state: 'succeeded', summary: 'The SMTP server accepted this test message. Check the recipient mailbox and spam folder to confirm delivery.' }
            : {
                state: 'uncertain',
                summary:
                  'The SMTP response did not confirm one accepted recipient. Check the provider logs and recipient mailbox before requesting another test.'
              }
      }
      await deps
        .db('mailChecks')
        .where({ id, state: 'running' })
        .update({ ...outcome, completedAt: now().toISOString() })
    } catch (error) {
      const outcome = startedEffect
        ? mailDiagnosticFailure(kind, error)
        : { state: 'failed', summary: 'Access or saved settings could not be confirmed before this check started. No diagnostic message was sent.' }
      try {
        await deps
          .db('mailChecks')
          .where({ id, state: 'running' })
          .update({ ...outcome, completedAt: now().toISOString() })
      } catch {
        /* A stale running receipt becomes uncertain; never replay a send. */
      }
    } finally {
      active.delete(id)
    }
  }
  return {
    configuration,
    inspect,
    async receipt(requester: PagePrincipal, id: unknown): Promise<MailCheck> {
      const parsed = z.string().uuid().safeParse(id)
      if (!parsed.success) return fail('Choose a valid Mail check identifier.', 404)
      const tx = await deps.db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
      try {
        await configuration.reviewState(tx, requester)
        const row = await tx<CheckRow>('mailChecks').where('id', parsed.data).first()
        if (!row) return fail('This Mail check has not been recorded.', 404)
        const result = presentCheck(row, now())
        await tx.commit()
        return result
      } catch (error) {
        await tx.rollback()
        throw error
      }
    },
    save: (requester: PagePrincipal, input: unknown) => apply(requester, input, true),
    apply: (requester: PagePrincipal, input: unknown) => apply(requester, input, false),
    async preview(requester: PagePrincipal, key: unknown) {
      const saved = await configuration.inspect(requester)
      if (typeof key !== 'string' || !MAIL_TEMPLATES.some(row => row.key === key)) return fail('Choose a bundled mail template.', 404)
      const template = MAIL_TEMPLATES.find(row => row.key === key)!,
        publicUrl = /^https?:\/\//.test(saved.publicUrl) ? saved.publicUrl : 'https://wiki.example.test'
      const samples: Record<MailTemplateKey, { title: string; content: string; buttonText: string }> = {
        'account-verify': {
          title: 'Verify your account',
          content: 'Confirm your email address to gain access to the workspace.',
          buttonText: 'Verify your account'
        },
        'account-reset-pwd': {
          title: 'Reset your password',
          content: 'A password reset was requested for your account. If you did not request it, you can ignore this email.',
          buttonText: 'Reset password'
        },
        'account-welcome': {
          title: 'You are invited',
          content: 'Your team has invited you to its shared knowledge workspace. Sign in to start exploring.',
          buttonText: 'Open your workspace'
        },
        'page-watch': { title: 'A page you follow has changed', content: '', buttonText: 'Read the page' },
        test: { title: 'Your delivery test', content: '', buttonText: 'Open workspace' }
      }
      const rendered = await deps.runtime().render({
        template: key,
        to: 'preview@example.test',
        subject: template.title,
        data: {
          ...samples[template.key],
          preheadertext: 'Preview with sample content',
          buttonLink: `${publicUrl}/login`,
          actorName: 'Alex Rivera',
          action: 'updated',
          pageTitle: 'Writing knowledge that lasts',
          url: `${publicUrl}/en/handbook`
        }
      })
      return { key, title: template.title, description: template.description, html: rendered.html, subject: rendered.subject }
    },
    async startCheck(requester: PagePrincipal, input: unknown): Promise<MailCheck> {
      const parsed = MailCheckRequestSchema.safeParse(input)
      if (!parsed.success) return fail('Provide the current review and a valid check request. Sending a test requires one recipient and explicit confirmation.')
      const value = parsed.data
      const result = await serial(() =>
        deps.db.transaction(async tx => {
          const saved = await configuration.reviewState(tx, requester, true)
          const existing = await tx<CheckRow>('mailChecks').where('id', value.id).first()
          if (existing) {
            if (existing.kind !== value.kind || existing.recipient !== (value.kind === 'test' ? value.recipient : null))
              return fail('This request identifier belongs to a different check.', 409)
            return { row: existing, started: false }
          }
          if (saved.fingerprint !== value.fingerprint) return fail('Mail settings or access changed. Reload and review again.', 409)
          if (saved.configuration.offline === true || deps.runtime().runtime().paused) return fail('Mail checks are paused while offline mode is enabled.', 409)
          const running = await tx<CheckRow>('mailChecks').where('state', 'running').forUpdate()
          for (const row of running) {
            if (!interrupted(row, now())) return fail('A Mail check is already running. Wait for its outcome.', 409)
            await tx('mailChecks').where('id', row.id).update({
              state: 'uncertain',
              summary: 'This check stopped reporting before its outcome was recorded. It has not been retried.',
              completedAt: now().toISOString()
            })
          }
          if (value.kind === 'dkim') {
            try {
              if (!mailDkimPublicRecord(saved.runtime, true)) return fail('Configure DKIM signing before checking DNS.')
            } catch {
              return fail('Configure a valid DKIM domain, selector and signing key before checking DNS.')
            }
          } else if (!runtimeView(saved).settingsCurrent || !deps.runtime().runtime().active)
            return fail('Apply the saved, enabled transport before running an SMTP check.', 409)
          if (value.kind === 'test') {
            const previous = await tx<CheckRow>('mailChecks').where('kind', 'test').orderBy('createdAt', 'desc').orderBy('id', 'desc').first()
            if (previous?.state === 'uncertain' && value.acknowledgedUncertainId !== previous.id)
              return fail('Review the previous uncertain test before requesting another message.', 409)
          }
          const row: CheckRow = {
            id: value.id,
            kind: value.kind,
            state: 'running',
            actorId: saved.actorId,
            recipient: value.kind === 'test' ? value.recipient : null,
            configurationRevision: typeof saved.metadata.revision === 'string' ? saved.metadata.revision : '',
            reviewFingerprint: saved.fingerprint,
            createdAt: now().toISOString(),
            completedAt: null,
            summary: 'Check started. Its outcome will appear here.'
          }
          await tx('mailChecks').insert(row)
          return { row, started: true }
        })
      )
      if (result.started) {
        active.add(result.row.id)
        void execute(requester, result.row.id, result.row.kind)
      }
      return presentCheck(result.row, now())
    }
  }
}
let database: Knex | undefined, store: ReturnType<typeof createMailWorkspaceStore> | undefined
export const getMailWorkspaceStore = () => {
  const wiki = WIKI as unknown as { models: { knex: Knex }; config: Record<string, unknown> & { sessionSecret: string }; mail: MailRuntime }
  if (!store || database !== wiki.models.knex) {
    database = wiki.models.knex
    store = createMailWorkspaceStore({
      db: database,
      reviewKey: wiki.config.sessionSecret,
      fallback: () => wiki.config,
      runtime: () => wiki.mail,
      publish: configuration => {
        wiki.config.mail = structuredClone(configuration)
        wiki.mail.init()
      }
    })
  }
  return store
}
