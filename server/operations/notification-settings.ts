import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import {
  NOTIFICATION_CEILING_CATEGORIES,
  NOTIFICATION_CEILING_MODES,
  type NotificationCeilings,
  type NotificationSettingsResponse
} from '../../shared/site-notifications.ts'
import { accountSessionIsCurrent } from '../helpers/account-session.ts'
import { principalId, type PagePrincipal } from '../helpers/page-access.ts'
import { lockNotificationSettings, NOTIFICATION_SETTINGS_KEY, readNotificationCeilings, type NotificationCeilingState } from '../jobs/notification-ceilings.ts'
import errors from './errors.ts'

const fail = (message: string, status = 400): never => { throw new errors.ApplicationError(message, { status }) }
const authorize = async (tx: Knex.Transaction, requester: PagePrincipal | undefined): Promise<void> => {
  if (!requester) return fail('An administrator sign-in is required.', 403)
  const groups = await tx<{ id: number; permissions: string[] }>('groups').select('id', 'permissions').orderBy('id').forShare()
  const actorId = principalId(requester)
  let ids: number[]
  if (actorId !== null) {
    const account = await tx('users').where('id', actorId).first('id', 'isActive', 'authVersion').forShare()
    if (!accountSessionIsCurrent({ id: actorId, authVersion: Reflect.get(requester, 'authVersion') }, account))
      return fail('Your account session changed. Sign in again.', 403)
    ids = (await tx<{ groupId: number }>('userGroups').where('userId', actorId).select('groupId')).map(row => row.groupId)
  } else {
    if (requester.ownershipUserId !== null || requester.id !== 1 || !Array.isArray(requester.groups) || requester.groups.length !== 1 || typeof requester.groups[0] !== 'number')
      return fail('An administrator principal is required.', 403)
    ids = requester.groups as number[]
  }
  if (!groups.some(group => ids.includes(group.id) && group.permissions.includes('manage:system')))
    return fail('Full system administration is required.', 403)
}
const fingerprint = (state: NotificationCeilingState): string => createHash('sha256').update(JSON.stringify(state)).digest('hex')
export const getNotificationSettings = async (knex: Knex, requester: PagePrincipal | undefined): Promise<NotificationSettingsResponse> =>
  knex.transaction(async tx => {
    await authorize(tx, requester)
    await lockNotificationSettings(tx)
    const state = await readNotificationCeilings(tx)
    return { ceilings: state.ceilings, fingerprint: fingerprint(state) }
  })

export const updateNotificationSettings = async (knex: Knex, requester: PagePrincipal | undefined, input: unknown): Promise<NotificationSettingsResponse> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Invalid notification settings.')
  const ceilings: unknown = Reflect.get(input, 'ceilings')
  if (!ceilings || typeof ceilings !== 'object' || Array.isArray(ceilings) || Object.keys(ceilings).length !== NOTIFICATION_CEILING_CATEGORIES.length ||
    !NOTIFICATION_CEILING_CATEGORIES.every(category => NOTIFICATION_CEILING_MODES.some(mode => mode === Reflect.get(ceilings, category))))
    return fail('Choose a supported ceiling for every notification category.')
  return knex.transaction(async tx => {
    await authorize(tx, requester)
    await lockNotificationSettings(tx, true)
    const state = await readNotificationCeilings(tx)
    if (Reflect.get(input, 'fingerprint') !== fingerprint(state)) return fail('Notification settings changed. Reload before saving.', 409)
    const now = new Date().toISOString()
    for (const category of NOTIFICATION_CEILING_CATEGORIES) {
      const previous = state.ceilings[category]
      const next = Reflect.get(ceilings, category) as NotificationCeilings[typeof category]
      const cutoff = state.suppressedBefore[category] ?? {}
      // Close the disabled interval as well as entering it: audience work may not
      // observe events created while this channel was unavailable until re-enable.
      if (next === 'off' || previous === 'off') cutoff.inApp = now
      if (next !== 'existing-consented-channels' || previous !== 'existing-consented-channels') cutoff.email = now
      if (Object.keys(cutoff).length) state.suppressedBefore[category] = cutoff
      state.ceilings[category] = next
    }
    await tx('settings').insert({ key: NOTIFICATION_SETTINGS_KEY, value: JSON.stringify(state), updatedAt: now }).onConflict('key').merge(['value', 'updatedAt'])
    return { ceilings: state.ceilings, fingerprint: fingerprint(state) }
  })
}
