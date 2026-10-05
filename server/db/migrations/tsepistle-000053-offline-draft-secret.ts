import type { Knex } from 'knex'

interface SettingRow {
  readonly key: string
  readonly value: unknown
}

const INSTALLATION_KEYS = ['auth', 'certs', 'offlineDraftSiteId', 'offlineDraftSecret', 'sessionSecret', 'title']

const secretValue = (value: unknown, key: 'sessionSecret' | 'offlineDraftSecret'): string => {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      throw new Error(`Cannot initialize offline draft encryption: persisted ${key} is invalid.`)
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed, 'v')) {
    throw new Error(`Cannot initialize offline draft encryption: persisted ${key} is invalid.`)
  }
  const secret = Reflect.get(parsed, 'v') as unknown
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error(`Cannot initialize offline draft encryption: persisted ${key} is invalid.`)
  }
  return secret
}

export const up = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable('settings'))) return

  await knex.transaction(async transaction => {
    const settings = await transaction<SettingRow>('settings').whereIn('key', INSTALLATION_KEYS).orderBy('key').forUpdate().select('key', 'value').debug(false)
    const existingRoot = settings.find(row => row.key === 'offlineDraftSecret')
    if (existingRoot) secretValue(existingRoot.value, 'offlineDraftSecret')

    const session = settings.find(row => row.key === 'sessionSecret')
    if (!session) {
      if (settings.length > 0) throw new Error('Cannot initialize offline draft encryption: installation session secret is missing.')
      return
    }
    const originalSecret = secretValue(session.value, 'sessionSecret')
    if (existingRoot) return

    // Preserve the exact legacy derivation input before session/signing material can rotate.
    try {
      await transaction('settings').insert({
        key: 'offlineDraftSecret',
        value: JSON.stringify({ v: originalSecret }),
        updatedAt: new Date().toISOString()
      }).debug(false)
    } catch {
      // Database error messages may contain interpolated bindings; never expose the root.
      throw new Error('Cannot persist the offline draft encryption root.')
    }
  })
}

export const down = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable('settings'))) return
  if (await knex('settings').where({ key: 'offlineDraftSecret' }).first('key')) {
    throw new Error('Cannot discard the offline draft encryption root. Restore a pre-migration backup or apply a forward fix.')
  }
}
