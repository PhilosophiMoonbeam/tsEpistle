import type { Knex } from 'knex'

const INDEX = 'page_knowledge_projection_search_tokens_gin'

const usesPostgres = (db: Knex): boolean => ['pg', 'postgres', 'postgresql'].includes(String(db.client.config.client).toLocaleLowerCase())

export const up = async (db: Knex): Promise<void> => {
  const hasDictionary = await db.schema.hasColumn('pageKnowledgeProjections', 'searchDictionary')
  const hasTokens = await db.schema.hasColumn('pageKnowledgeProjections', 'searchTokens')
  if (!hasDictionary || !hasTokens) {
    await db.schema.alterTable('pageKnowledgeProjections', table => {
      if (!hasDictionary) table.string('searchDictionary', 64).nullable()
      if (!hasTokens) {
        if (usesPostgres(db)) table.specificType('searchTokens', 'tsvector').nullable()
        else table.text('searchTokens').nullable()
      }
    })
  }
  if (usesPostgres(db)) {
    await db.raw(`CREATE INDEX IF NOT EXISTS "${INDEX}" ON "pageKnowledgeProjections" USING GIN ("searchTokens")`)
  }
}

export const down = async (db: Knex): Promise<void> => {
  if (usesPostgres(db)) await db.raw(`DROP INDEX IF EXISTS "${INDEX}"`)
  const hasDictionary = await db.schema.hasColumn('pageKnowledgeProjections', 'searchDictionary')
  const hasTokens = await db.schema.hasColumn('pageKnowledgeProjections', 'searchTokens')
  if (hasDictionary || hasTokens) {
    await db.schema.alterTable('pageKnowledgeProjections', table => {
      if (hasDictionary) table.dropColumn('searchDictionary')
      if (hasTokens) table.dropColumn('searchTokens')
    })
  }
}
