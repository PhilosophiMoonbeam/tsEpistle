import type { Knex } from 'knex'


export const up = async (knex: Knex) => {
  await knex.schema.renameTable('pageHistory', 'pageHistory_old')
  await knex.schema.createTable('pageHistory', table => {
    table.increments('id').primary()
    table.string('path').notNullable()
    table.string('hash').notNullable()
    table.string('title').notNullable()
    table.string('description')
    table.boolean('isPrivate').notNullable().defaultTo(false)
    table.boolean('isPublished').notNullable().defaultTo(false)
    table.string('publishStartDate')
    table.string('publishEndDate')
    table.text('content')
    table.string('contentType').notNullable()
    table.string('createdAt').notNullable()
    table.string('action').defaultTo('updated')

    table.integer('pageId').unsigned()
    table.string('editorKey').references('key').inTable('editors')
    table.string('localeCode', 5).references('code').inTable('locales')
    table.integer('authorId').unsigned().references('id').inTable('users')
  })
  await knex.raw(`INSERT INTO pageHistory SELECT id,path,hash,title,description,isPrivate,isPublished,publishStartDate,publishEndDate,content,contentType,createdAt,'updated' AS action,pageId,editorKey,localeCode,authorId FROM pageHistory_old;`)
  await knex.schema.dropTable('pageHistory_old')
}

export const down = async (knex: Knex) => {
  await knex.schema.renameTable('pageHistory', 'pageHistory_old')
  await knex.schema.createTable('pageHistory', table => {
    table.increments('id').primary()
    table.string('path').notNullable()
    table.string('hash').notNullable()
    table.string('title').notNullable()
    table.string('description')
    table.boolean('isPrivate').notNullable().defaultTo(false)
    table.boolean('isPublished').notNullable().defaultTo(false)
    table.string('publishStartDate')
    table.string('publishEndDate')
    table.text('content')
    table.string('contentType').notNullable()
    table.string('createdAt').notNullable()

    table.integer('pageId').unsigned().references('id').inTable('pages')
    table.string('editorKey').references('key').inTable('editors')
    table.string('localeCode', 5).references('code').inTable('locales')
    table.integer('authorId').unsigned().references('id').inTable('users')
  })
  await knex.raw('INSERT INTO pageHistory SELECT id,path,hash,title,description,isPrivate,isPublished,publishStartDate,publishEndDate,content,contentType,createdAt,NULL as pageId,editorKey,localeCode,authorId FROM pageHistory_old;')
  await knex.schema.dropTable('pageHistory_old')
}
