import type { Knex } from 'knex'

export interface LocaleRelationMovePage {
  id: number
  localeCode: string
  localeGroupId: string | null
}

export const localeRelationMovePatch = async (
  transaction: Knex.Transaction,
  page: LocaleRelationMovePage,
  destinationLocale: string
): Promise<{ localeGroupId?: null }> => {
  if (!page.localeGroupId || destinationLocale === page.localeCode) return {}
  const conflict = await transaction('pages')
    .select('id')
    .where({ localeGroupId: page.localeGroupId, localeCode: destinationLocale })
    .whereNot({ id: page.id })
    .first()
  return conflict ? { localeGroupId: null } : {}
}
