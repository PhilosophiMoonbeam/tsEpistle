import { createHmac, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { Duration } from 'luxon'
import { z } from 'zod'
import {
  StorageTargetDraftSchema,
  storageConfigurationIssues,
  type StorageConfigurationEvent,
  type StorageConfigurationWorkspace,
  type StorageModuleDefinition
} from '../../shared/storage-workspace.ts'
import { storageRecord, storageTargetView, type StorageConfigurationRow } from '../repositories/storage-configuration.ts'
import { accountSessionIsCurrent } from '../helpers/account-session.ts'
import { principalId, type PagePrincipal } from '../helpers/page-access.ts'
import { nativeStorageMutationConfigurationKey } from '../helpers/storage-configuration-key.ts'
import { lockAssetMutationFence } from '../helpers/asset-location-lock.ts'
import { lockSearchIndex } from '../helpers/search-contract.ts'
import { assertStorageTargetPathsAvailable } from '../helpers/storage-path-admission.ts'
import { rebindAssetRelocationConfiguration } from '../jobs/asset-relocation.ts'
import errors from './errors.ts'

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item
  )
const fail = (message: string, status = 400): never => {
  throw new errors.ApplicationError(message, { status })
}
const schema = z
  .object({ targets: z.array(StorageTargetDraftSchema).max(100), fingerprint: z.string().length(64), reason: z.string().trim().min(3).max(1000) })
  .strict()
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
interface Dependencies {
  db: Knex
  reviewKey: string
  definitions(): StorageModuleDefinition[]
  offline?(): boolean
  now?(): Date
}
const settingKey = 'storageAdministration'
export const createStorageConfigurationStore = (deps: Dependencies) => {
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
    if (!groups.some(g => ids.includes(g.id) && g.permissions.includes('manage:system'))) return fail('System administration is required.', 403)
    const mq = tx<{ key: string; value: unknown }>('settings').where('key', settingKey).first(),
      metadata = storageRecord((await (lock ? mq.forUpdate() : mq))?.value)
    const sq = tx<StorageConfigurationRow>('storage').orderBy('key'),
      rows = await (lock ? sq.forUpdate() : sq),
      definitions = deps.definitions(),
      offline = deps.offline?.() ?? false
    const configuration = rows.map(({ key, isEnabled, mode, syncInterval, config }) => ({ key, isEnabled, mode, syncInterval, config }))
    const fingerprint = createHmac('sha256', deps.reviewKey)
      .update(stable([configuration, metadata, groups, actorId, ids, definitions, offline]))
      .digest('hex')
    return { rows, metadata, definitions, actorId, fingerprint, offline }
  }
  const presentState = (saved: Awaited<ReturnType<typeof state>>): StorageConfigurationWorkspace => {
    return {
      targets: saved.rows.map(row =>
        storageTargetView(
          row,
          saved.definitions.find(d => d.key === row.key)
        )
      ),
      fingerprint: saved.fingerprint,
      offline: saved.offline,
      revision: typeof saved.metadata.revision === 'string' ? saved.metadata.revision : '',
      observedAt: now().toISOString(),
      history: Array.isArray(saved.metadata.history) ? (saved.metadata.history.slice(0, 50) as StorageConfigurationEvent[]) : []
    }
  }
  const inspect = async (requester: PagePrincipal): Promise<StorageConfigurationWorkspace> => {
    const tx = await deps.db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
    try {
      const saved = await state(tx, requester)
      const result = presentState(saved)
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
    async save(requester: PagePrincipal, input: unknown, transaction?: Knex.Transaction): Promise<{ revision: string; changedTargets: string[] }> {
      const parsed = schema.safeParse(input)
      if (!parsed.success) return fail('Provide a complete storage draft, current review and administrative reason.')
      const publish = async (tx: Knex.Transaction) => {
        // Match canonical writer order before state() acquires target UPDATE locks.
        // These fences retain absent page/asset paths through publication commit.
        await lockAssetMutationFence(tx)
        await lockSearchIndex(tx, true)
        const current = await state(tx, requester, true),
          draft = parsed.data
        if (await tx('storageOperations').whereIn('state', ['queued', 'running', 'interrupted']).first('id'))
          return fail('Finish or resolve the current storage operation before changing configuration.', 409)
        if (draft.fingerprint !== current.fingerprint) return fail('Storage settings or your access changed. Reload and review again.', 409)
        if (
          new Set(draft.targets.map(row => row.key)).size !== draft.targets.length ||
          draft.targets.length !== current.rows.length ||
          current.rows.some(row => !draft.targets.some(d => d.key === row.key))
        )
          return fail('Include each current storage target exactly once.')
        const assertDestinationChangeAllowed = async (original: StorageConfigurationRow, next: StorageConfigurationRow): Promise<boolean> => {
          if (nativeStorageMutationConfigurationKey(original) === nativeStorageMutationConfigurationKey(next)) return false
          // state() owns ordered target UPDATE locks. Canonical admission holds SHARE
          // locks through commit, so no admitted old-destination work can pass this check.
          const outstanding = await tx('durableJobs')
            .where({ type: 'storage-mutation', version: 1 })
            .whereNot('state', 'succeeded')
            .whereRaw("??::jsonb ->> 'targetKey' = ?", ['payload', original.key])
            .first('id')
          if (outstanding)
            return fail(
              'Canonical storage changes are still outstanding. Restore access to the existing destination and let them finish before disabling or changing its destination or mode.',
              409
            )
          return true
        }
        const changes: StorageConfigurationEvent['targets'] = []
        for (const target of draft.targets) {
          const original = current.rows.find(row => row.key === target.key)!,
            definition = current.definitions.find(row => row.key === target.key),
            view = storageTargetView(original, definition)
          if (!definition?.isAvailable) {
            if (
              target.isEnabled ||
              target.mode !== view.mode ||
              target.syncInterval !== view.syncInterval ||
              stable(target.config) !== stable(view.config) ||
              Object.keys(target.secrets).length !== Object.keys(view.secrets).length ||
              Object.entries(target.secrets).some(([key, action]) => !Object.hasOwn(view.secrets, key) || action.action !== 'keep')
            )
              return fail('An unavailable target may only be disabled.')
            if (original.isEnabled) {
              const next = { ...original, isEnabled: false }
              await rebindAssetRelocationConfiguration(tx, original, next)
              await assertDestinationChangeAllowed(original, next)
              await tx('storage').where('key', target.key).update({ isEnabled: false })
              changes.push({ key: target.key, fields: ['isEnabled'] })
            }
            continue
          }
          const publicFields = definition.fields.filter(field => !field.sensitive),
            secretFields = definition.fields.filter(field => field.sensitive)
          if (
            Object.keys(target.config).length !== publicFields.length ||
            publicFields.some(field => !Object.hasOwn(target.config, field.key)) ||
            Object.keys(target.secrets).length !== secretFields.length ||
            secretFields.some(field => !Object.hasOwn(target.secrets, field.key))
          )
            return fail(`Include each known configuration field for ${definition.title}.`)
          const config = { ...storageRecord(original.config) },
            fields: string[] = []
          for (const field of publicFields) {
            const value = target.config[field.key]
            if (
              (target.isEnabled || stable(value) !== stable(view.config[field.key])) &&
              (typeof value !== field.type || (field.options.length && !field.options.some(option => option.value === String(value))))
            )
              return fail(`${field.title} has an invalid value for ${definition.title}.`)
            if (stable(value) !== stable(view.config[field.key]) || (!original.isEnabled && target.isEnabled && stable(config[field.key]) !== stable(value))) {
              config[field.key] = value
              fields.push('config.' + field.key)
            }
          }
          for (const field of secretFields) {
            const action = target.secrets[field.key]!
            if (action.action === 'keep') continue
            const value = action.action === 'clear' ? '' : action.value
            if (config[field.key] !== value) {
              config[field.key] = value
              fields.push('secret.' + field.key)
            }
          }
          if ((target.isEnabled || target.mode !== view.mode) && !definition.modes.includes(target.mode))
            return fail(`Choose a supported synchronization direction for ${definition.title}.`)
          const interval = Duration.fromISO(target.syncInterval),
            millis = interval.toMillis()
          if (
            (target.isEnabled || target.syncInterval !== view.syncInterval) &&
            (!interval.isValid || !Number.isFinite(millis) || millis < 0 || millis > 2073600000 || (millis > 0 && millis < 10000))
          )
            return fail('Choose no scheduled sync or an interval from 10 seconds to 24 days.')
          if ((target.isEnabled || target.syncInterval !== view.syncInterval) && !definition.schedule && millis !== 0)
            return fail(`${definition.title} has no configurable synchronization schedule.`)
          const syncInterval = millis === 0 ? 'P0D' : target.syncInterval
          if (target.isEnabled) {
            const issues = storageConfigurationIssues(storageTargetView({ ...original, config }, definition))
            if (issues.length) return fail(issues[0]!)
          }
          for (const key of ['isEnabled', 'mode', 'syncInterval'] as const)
            if ((key === 'syncInterval' ? syncInterval : target[key]) !== original[key]) fields.push(key)
          if (!fields.length) continue
          const next = { ...original, isEnabled: target.isEnabled, mode: target.mode, syncInterval, config }
          await rebindAssetRelocationConfiguration(tx, original, next)
          const destinationChanged = await assertDestinationChangeAllowed(original, next)
          if (next.isEnabled && destinationChanged) await assertStorageTargetPathsAvailable(tx, next)
          await tx('storage')
            .where('key', target.key)
            .update({ isEnabled: target.isEnabled, mode: target.mode, syncInterval, config: JSON.stringify(config) })
          changes.push({ key: target.key, fields })
        }
        if (!changes.length) return fail('There are no storage configuration changes to publish.')
        const event: StorageConfigurationEvent = {
          id: randomUUID(),
          createdAt: now().toISOString(),
          actorId: current.actorId,
          reason: draft.reason,
          targets: changes
        }
        const metadata = {
          ...current.metadata,
          revision: event.id,
          history: [event, ...(Array.isArray(current.metadata.history) ? current.metadata.history : [])].slice(0, 50)
        }
        await tx('settings')
          .insert({ key: settingKey, value: JSON.stringify(metadata), updatedAt: event.createdAt })
          .onConflict('key')
          .merge(['value', 'updatedAt'])
        return { revision: event.id, changedTargets: changes.map(row => row.key) }
      }
      return transaction ? publish(transaction) : deps.db.transaction(publish)
    }
  }
}
