import { createHmac, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import {
  MailDraftSchema,
  MailConfigurationEventSchema,
  mailPolicyFromConfiguration,
  mailRecord,
  type MailConfigurationEvent,
  type MailConfigurationWorkspace
} from '../../shared/mail-workspace.ts'
import { mailRuntimeConfiguration, mailRuntimeIssues, mailDkimPublicRecord } from '../repositories/mail-configuration.ts'
import { accountSessionIsCurrent } from '../helpers/account-session.ts'
import { principalId, type PagePrincipal } from '../helpers/page-access.ts'
import errors from './errors.ts'

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item
  )
const fail = (message: string, status = 400): never => {
  throw new errors.ApplicationError(message, { status })
}
const WriteSchema = MailDraftSchema.extend({ fingerprint: z.string().length(64), reason: z.string().trim().min(3).max(1000) }).strict()
const settingKeys = ['mail', 'mailAdministration', 'offline', 'host', 'title', 'company', 'logoUrl']
interface Group {
  id: number
  permissions: string[]
  adminRevision: string
}
interface Account {
  id: number
  isActive: boolean
  authVersion: number
}
interface Setting {
  key: string
  value: unknown
  updatedAt: string
}
interface Dependencies {
  db: Knex
  reviewKey: string
  fallback(): Record<string, unknown>
  now?(): Date
}
const history = (metadata: Record<string, unknown>): MailConfigurationEvent[] =>
  (Array.isArray(metadata.history) ? metadata.history.slice(0, 50) : []).flatMap(value => {
    const parsed = MailConfigurationEventSchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
export const createMailConfigurationStore = (deps: Dependencies) => {
  const now = () => deps.now?.() ?? new Date()
  const state = async (tx: Knex.Transaction, requester: PagePrincipal, lock = false) => {
    const gq = tx<Group>('groups').select('id', 'permissions', 'adminRevision').orderBy('id'),
      groups = await (lock ? gq.forUpdate() : gq)
    if (!requester) return fail('An administrator sign-in is required.', 403)
    const actorId = principalId(requester)
    let ids: number[]
    if (actorId !== null) {
      const uq = tx<Account>('users').where('id', actorId).select('id', 'isActive', 'authVersion').first(),
        account = await (lock ? uq.forUpdate() : uq)
      if (!accountSessionIsCurrent({ id: actorId, authVersion: Reflect.get(requester, 'authVersion') }, account))
        return fail('Your account session changed. Sign in again.', 403)
      ids = (await tx<{ groupId: number }>('userGroups').where('userId', actorId).select('groupId')).map(row => row.groupId).sort((a, b) => a - b)
    } else {
      if (
        requester.ownershipUserId !== null ||
        requester.id !== 1 ||
        !Array.isArray(requester.groups) ||
        requester.groups.length !== 1 ||
        typeof requester.groups[0] !== 'number'
      )
        return fail('An administrator principal is required.', 403)
      ids = requester.groups as number[]
    }
    if (!groups.some(group => ids.includes(group.id) && group.permissions.includes('manage:system'))) return fail('System administration is required.', 403)
    const sq = tx<Setting>('settings').whereIn('key', settingKeys).orderBy('key'),
      settings = await (lock ? sq.forUpdate() : sq)
    const configuration = {
      ...deps.fallback(),
      ...Object.fromEntries(
        settings.map(row => [row.key, ['mail', 'mailAdministration'].includes(row.key) ? row.value : (mailRecord(row.value).v ?? row.value)])
      )
    }
    const raw = mailRecord(configuration.mail),
      runtime = mailRuntimeConfiguration(raw),
      metadata = mailRecord(configuration.mailAdministration)
    const fingerprint = createHmac('sha256', deps.reviewKey)
      .update(
        stable([
          settings,
          configuration.mail,
          configuration.offline,
          configuration.host,
          configuration.title,
          configuration.company,
          configuration.logoUrl,
          groups,
          actorId,
          ids
        ])
      )
      .digest('hex')
    return { raw, runtime, metadata, configuration, actorId, fingerprint }
  }
  const presentState = (current: Awaited<ReturnType<typeof state>>): MailConfigurationWorkspace => {
    let dkimRecord: MailConfigurationWorkspace['dkimRecord'] = null
    try {
      dkimRecord = mailDkimPublicRecord(current.runtime, true)
    } catch {
      /* Invalid saved signing keys have no publishable record. */
    }
    return {
      policy: mailPolicyFromConfiguration(current.raw),
      secrets: { pass: Boolean(current.runtime.pass), dkimPrivateKey: Boolean(current.runtime.dkimPrivateKey) },
      fingerprint: current.fingerprint,
      revision: typeof current.metadata.revision === 'string' ? current.metadata.revision : '',
      observedAt: now().toISOString(),
      offline: current.configuration.offline === true,
      publicUrl: typeof current.configuration.host === 'string' ? current.configuration.host : '',
      issues: mailRuntimeIssues(current.runtime),
      dkimRecord,
      history: history(current.metadata)
    }
  }
  const inspect = async (requester: PagePrincipal): Promise<MailConfigurationWorkspace> => {
    const tx = await deps.db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
    try {
      const result = presentState(await state(tx, requester))
      await tx.commit()
      return result
    } catch (error) {
      await tx.rollback()
      throw error
    }
  }
  return {
    inspect,
    reviewState: state,
    presentState,
    async save(requester: PagePrincipal, input: unknown, transaction?: Knex.Transaction): Promise<{ revision: string; fields: string[] }> {
      const parsed = WriteSchema.safeParse(input)
      if (!parsed.success) return fail('Provide complete mail settings, explicit credential actions and a review reason.')
      const publish = async (tx: Knex.Transaction) => {
        const current = await state(tx, requester, true),
          draft = parsed.data
        if (draft.fingerprint !== current.fingerprint) return fail('Mail settings or your access changed. Reload and review again.', 409)
        const previous = mailPolicyFromConfiguration(current.raw),
          next: Record<string, unknown> = { ...current.raw, ...draft.policy },
          fields: string[] = []
        for (const key of Object.keys(draft.policy) as Array<keyof typeof draft.policy>) if (draft.policy[key] !== previous[key]) fields.push(key)
        for (const key of ['pass', 'dkimPrivateKey'] as const) {
          const action = draft.secrets[key]
          if (action.action === 'keep') continue
          const value = action.action === 'clear' ? '' : action.value
          if (value !== current.runtime[key]) {
            next[key] = value
            fields.push('secret.' + key)
          }
        }
        // Keep the legacy projection coherent for consumers during the workspace migration.
        next.secure = draft.policy.tlsMode === 'implicit'
        const issues = mailRuntimeIssues(mailRuntimeConfiguration(next))
        if (issues.length) return fail(issues[0]!)
        if (!fields.length) return fail('There are no mail configuration changes to publish.')
        const event: MailConfigurationEvent = { id: randomUUID(), actorId: current.actorId, createdAt: now().toISOString(), reason: draft.reason, fields }
        for (const [key, value] of [
          ['mail', next],
          ['mailAdministration', { ...current.metadata, revision: event.id, history: [event, ...history(current.metadata)].slice(0, 50) }]
        ] as const)
          await tx('settings')
            .insert({ key, value: JSON.stringify(value), updatedAt: event.createdAt })
            .onConflict('key')
            .merge(['value', 'updatedAt'])
        return { revision: event.id, fields }
      }
      return transaction ? publish(transaction) : deps.db.transaction(publish)
    }
  }
}
