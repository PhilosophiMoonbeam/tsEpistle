import type { Knex } from 'knex'
import {
  defaultNotificationCeilings,
  NOTIFICATION_CEILING_CATEGORIES,
  NOTIFICATION_CEILING_MODES,
  type NotificationCeilings,
  type PageNotificationCategory
} from '../../shared/site-notifications.ts'

export const NOTIFICATION_SETTINGS_KEY = 'notificationCeilings'
const NOTIFICATION_SETTINGS_LOCK = 771020
export interface NotificationCeilingState {
  ceilings: NotificationCeilings
  suppressedBefore: Partial<Record<PageNotificationCategory, { inApp?: string; email?: string }>>
}

export const lockNotificationSettings = async (transaction: Knex.Transaction, exclusive = false): Promise<void> => {
  if (transaction.client.config.client === 'pg')
    await transaction.raw(exclusive ? 'SELECT pg_advisory_xact_lock(?)' : 'SELECT pg_advisory_xact_lock_shared(?)', [NOTIFICATION_SETTINGS_LOCK])
}

export const readNotificationCeilings = async (database: Knex | Knex.Transaction): Promise<NotificationCeilingState> => {
  const row = await database('settings').where('key', NOTIFICATION_SETTINGS_KEY).first('value')
  const state: NotificationCeilingState = { ceilings: defaultNotificationCeilings(), suppressedBefore: {} }
  if (!row) return state
  const value: unknown = typeof row.value === 'string' ? JSON.parse(row.value) : row.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid saved notification ceilings')
  const ceilings = Reflect.get(value, 'ceilings')
  const cutoffs = Reflect.get(value, 'suppressedBefore')
  if (!ceilings || typeof ceilings !== 'object' || Array.isArray(ceilings)) throw new TypeError('Invalid saved notification ceilings')
  for (const category of NOTIFICATION_CEILING_CATEGORIES) {
    const mode: unknown = Reflect.get(ceilings, category)
    if (!(mode === undefined && (category === 'feedbackStatus' || category === 'reviewReminder' || category === 'pageLifecycle'))) {
      if (!NOTIFICATION_CEILING_MODES.some(known => known === mode)) throw new TypeError('Invalid saved notification ceiling')
      state.ceilings[category] = mode as NotificationCeilings[typeof category]
    }
    const cutoff = cutoffs && typeof cutoffs === 'object' ? Reflect.get(cutoffs, category) : undefined
    if (cutoff && typeof cutoff === 'object') {
      const channels: { inApp?: string; email?: string } = {}
      for (const channel of ['inApp', 'email'] as const) {
        const timestamp: unknown = Reflect.get(cutoff, channel)
        if (timestamp === undefined) continue
        if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) throw new TypeError('Invalid notification suppression cutoff')
        channels[channel] = timestamp
      }
      state.suppressedBefore[category] = channels
    }
  }
  return state
}

export const ceilingChannels = (
  state: NotificationCeilingState,
  category: PageNotificationCategory,
  eventCreatedAt: Date | string | number,
  channels: { inAppEnabled: boolean; emailEnabled: boolean }
): { inAppEnabled: boolean; emailEnabled: boolean } => {
  const mode = state.ceilings[category]
  const cutoff = state.suppressedBefore[category]
  const eventTime = eventCreatedAt instanceof Date ? eventCreatedAt.valueOf() : new Date(eventCreatedAt).valueOf()
  if (!Number.isFinite(eventTime)) throw new TypeError('Invalid notification event timestamp')
  return {
    inAppEnabled: channels.inAppEnabled && mode !== 'off' && (!cutoff?.inApp || eventTime > Date.parse(cutoff.inApp)),
    emailEnabled: channels.emailEnabled && mode === 'existing-consented-channels' && (!cutoff?.email || eventTime > Date.parse(cutoff.email))
  }
}
