import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('liveNotes', table => {
    table.uuid('id').primary()
    table.string('key', 64).notNullable().unique()
    table.integer('ownerId').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
    table.string('access', 8).notNullable().defaultTo('private')
    table.text('state').notNullable()
    table.string('title', 200).notNullable().defaultTo('')
    table.bigInteger('revision').notNullable().defaultTo(0)
    table.boolean('everEdited').notNullable().defaultTo(false)
    table.timestamp('createdAt', { useTz: true }).notNullable()
    table.timestamp('updatedAt', { useTz: true }).notNullable()
    table.timestamp('touchedAt', { useTz: true }).notNullable()
    table.timestamp('deletedAt', { useTz: true }).nullable()
    table.index(['ownerId', 'id'], 'live_notes_owner_inventory_idx')
    table.index(['everEdited', 'touchedAt'], 'live_notes_untouched_idx')
    table.check("?? IN ('private', 'read', 'edit')", ['access'], 'live_notes_access_check')
    table.check('?? >= 0 AND ?? <= 9007199254740991', ['revision', 'revision'], 'live_notes_revision_check')
  })
  await knex.schema.createTable('liveNoteRevisions', table => {
    table.uuid('noteId').notNullable().references('id').inTable('liveNotes').onDelete('CASCADE')
    table.bigInteger('revision').notNullable()
    table.text('state').notNullable()
    table.string('title', 200).notNullable()
    table.string('access', 8).notNullable()
    table.integer('actorId').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
    table.timestamp('createdAt', { useTz: true }).notNullable()
    table.primary(['noteId', 'revision'])
  })
  await knex.schema.createTable('liveNoteRequests', table => {
    table.uuid('noteId').notNullable().references('id').inTable('liveNotes').onDelete('CASCADE')
    table.integer('actorId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.string('requestId', 128).notNullable()
    table.string('updateHash', 64).notNullable()
    table.primary(['noteId', 'actorId', 'requestId'])
  })
  await knex.schema.createTable('liveNoteConnections', table => {
    table.string('id', 128).primary()
    table.uuid('noteId').notNullable().references('id').inTable('liveNotes').onDelete('CASCADE')
    table.timestamp('expiresAt', { useTz: true }).notNullable()
    table.index(['noteId', 'expiresAt'], 'live_note_connections_active_idx')
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.transaction(async tx => {
    if (knex.client.config.client === 'pg') await tx.raw('LOCK TABLE "liveNotes", "liveNoteRevisions" IN ACCESS EXCLUSIVE MODE')
    const note = await tx('liveNotes').first('id')
    const revision = await tx('liveNoteRevisions').first('noteId')
    if (note || revision) throw new Error('Live notes contain authoritative documents or history; fix forward instead of dropping user data.')
    await tx.schema.dropTable('liveNoteConnections')
    await tx.schema.dropTable('liveNoteRequests')
    await tx.schema.dropTable('liveNoteRevisions')
    await tx.schema.dropTable('liveNotes')
  })
}
