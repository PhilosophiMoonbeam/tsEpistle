import type { Knex } from 'knex'

const USERS = 'users'
const PAGES = 'pages'
const PAGE_HISTORY = 'pageHistory'
const LOCALES = 'locales'
const PAGE_RATINGS = 'pageRatings'
const DELETED_PAGE_RECOVERY = 'deletedPageRecovery'
const CONTENT_TEXT_SIZE_CHECK = 'users_content_text_size_check'
const COMMUNICATION_LOCALE_FK = 'users_communication_locale_fk'

const isPostgres = (knex: Knex): boolean => ['pg', 'postgres', 'postgresql'].includes(String(knex.client.config.client).toLowerCase())

const requireTables = async (knex: Knex, tables: readonly string[]): Promise<void> => {
  for (const table of tables) {
    if (!(await knex.schema.hasTable(table))) throw new Error(`Cannot apply Scarlett native adaptations without the ${table} table.`)
  }
}

export const up = async (knex: Knex): Promise<void> => {
  await knex.transaction(async transaction => {
    await requireTables(transaction, [USERS, PAGES, PAGE_HISTORY, LOCALES])

    await transaction.schema.alterTable(USERS, table => {
      table.boolean('reduceMotion').notNullable().defaultTo(false)
      table.boolean('underlineLinks').notNullable().defaultTo(false)
      table.string('contentTextSize', 16).notNullable().defaultTo('default')
      table.string('communicationLocale', 35).nullable()
      table.foreign('communicationLocale', COMMUNICATION_LOCALE_FK).references('code').inTable(LOCALES).onDelete('SET NULL')
      table.check('"contentTextSize" IN (\'default\', \'large\', \'larger\')', undefined, CONTENT_TEXT_SIZE_CHECK)
    })

    await transaction.schema.createTable(PAGE_RATINGS, table => {
      table.integer('pageId').unsigned().notNullable()
      table.integer('userId').unsigned().notNullable()
      table.string('kind', 8).notNullable()
      table.integer('value').notNullable()
      table.timestamp('createdAt', { useTz: true }).notNullable()
      table.timestamp('updatedAt', { useTz: true }).notNullable()
      table.foreign('pageId', 'page_ratings_page_fk').references('id').inTable(PAGES).onDelete('CASCADE')
      table.foreign('userId', 'page_ratings_user_fk').references('id').inTable(USERS).onDelete('CASCADE')
      table.unique(['pageId', 'userId'], 'page_ratings_page_user_unique')
      table.index(['pageId', 'kind'], 'page_ratings_page_kind_idx')
      table.check(
        "(\"kind\" = 'thumbs' AND \"value\" IN (-1, 1)) OR (\"kind\" = 'stars' AND \"value\" BETWEEN 1 AND 5)",
        undefined,
        'page_ratings_kind_value_check'
      )
    })

    await transaction.schema.createTable(DELETED_PAGE_RECOVERY, table => {
      table.integer('pageId').unsigned().notNullable()
      table.integer('deletionVersionId').unsigned().notNullable()
      table.bigInteger('deletionRevision').notNullable()
      table.jsonb('securityContext').notNullable()
      table.timestamp('createdAt', { useTz: true }).notNullable()
      table.primary(['pageId', 'deletionVersionId'], 'deleted_page_recovery_pkey')
      // Recovery records intentionally survive page deletion, but follow retained deletion history.
      table.foreign('deletionVersionId', 'deleted_page_recovery_history_fk')
        .references('id')
        .inTable(PAGE_HISTORY)
        .onDelete('CASCADE')
      table.index(['deletionVersionId'], 'deleted_page_recovery_version_idx')
    })
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.transaction(async transaction => {
    if (isPostgres(transaction)) {
      await transaction.raw('LOCK TABLE "users", "pageRatings", "deletedPageRecovery" IN ACCESS EXCLUSIVE MODE')
    }

    if (await transaction(DELETED_PAGE_RECOVERY).first('pageId')) {
      throw new Error('Cannot roll down Scarlett native adaptations while deleted-page recovery records exist. Preserve them and apply a forward fix or restore a compatible backup.')
    }
    if (await transaction(PAGE_RATINGS).first(['pageId', 'userId'])) {
      throw new Error('Cannot roll down Scarlett native adaptations while page ratings exist. Preserve them and apply a forward fix or restore a compatible backup.')
    }
    const customizedPreference = await transaction(USERS)
      .where(query =>
        query
          .where('reduceMotion', true)
          .orWhere('underlineLinks', true)
          .orWhereNot('contentTextSize', 'default')
          .orWhereNotNull('communicationLocale')
      )
      .first('id')
    if (customizedPreference) {
      throw new Error('Cannot roll down Scarlett native adaptations after user preferences have been saved. Preserve them and apply a forward fix or restore a compatible backup.')
    }

    await transaction.schema.dropTable(DELETED_PAGE_RECOVERY)
    await transaction.schema.dropTable(PAGE_RATINGS)
    await transaction.schema.alterTable(USERS, table => {
      table.dropForeign(['communicationLocale'], COMMUNICATION_LOCALE_FK)
      table.dropChecks([CONTENT_TEXT_SIZE_CHECK])
      table.dropColumn('communicationLocale')
      table.dropColumn('contentTextSize')
      table.dropColumn('underlineLinks')
      table.dropColumn('reduceMotion')
    })
  })
}
