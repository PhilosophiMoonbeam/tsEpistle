import type { Knex } from 'knex'

const PROVIDERS = {
  comentario: { instanceUrl: '' },
  discourse: { discourseUrl: '', discourseUserName: '' },
  giscus: { repo: '', repoId: '', category: 'Announcements', categoryId: '', theme: 'preferred_color_scheme', reactionsEnabled: true, lang: 'en' },
  hyvortalk: { websiteId: 0, colorScheme: 'os' },
  isso: { server: '' },
  remark42: { host: '', siteId: 'remark', theme: 'light', maxShownComments: 15 },
  waline: { serverURL: '', clientUrl: 'https://unpkg.com/@waline/client@3.15.2/dist/waline.js', styleUrl: 'https://unpkg.com/@waline/client@3.15.2/dist/waline.css', lang: 'en', reaction: false }
} as const
const KEYS = Object.keys(PROVIDERS)
const ROLLBACK_ERROR = 'Cannot remove configured Scarlett discussion providers. Preserve their configuration and use a forward fix or restore a compatible database backup.'

interface ProviderRow { key: keyof typeof PROVIDERS; isEnabled: boolean; config: unknown }
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
const configValue = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

export const up = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable('commentProviders'))) return
  await knex.transaction(async transaction => {
    for (const [key, config] of Object.entries(PROVIDERS)) await transaction('commentProviders').insert({ key, isEnabled: false, config }).onConflict('key').ignore()
  })
}

export const down = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable('commentProviders'))) return
  await knex.transaction(async transaction => {
    const rows = await transaction<ProviderRow>('commentProviders').whereIn('key', KEYS).forUpdate().select('key', 'isEnabled', 'config')
    for (const row of rows) if (row.isEnabled || canonical(configValue(row.config)) !== canonical(PROVIDERS[row.key])) throw new Error(ROLLBACK_ERROR)
    await transaction('commentProviders').whereIn('key', KEYS).delete()
  })
}
