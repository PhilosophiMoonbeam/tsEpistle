import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('hedgedocImports', table => {
    table.string('namespace', 128).notNullable()
    table.string('sourceId', 128).notNullable()
    table.string('sourceDigest', 64).notNullable()
    table.string('snapshotDigest', 64).notNullable()
    table.string('reviewDigest', 64).notNullable()
    table.uuid('noteId').notNullable().unique().references('id').inTable('liveNotes').onDelete('RESTRICT')
    table.bigInteger('nativeRevision').notNullable()
    table.integer('importedBy').nullable().references('id').inTable('users').onDelete('SET NULL')
    table.text('source').notNullable()
    table.text('assets').notNullable()
    table.timestamp('importedAt', { useTz: true }).notNullable()
    table.primary(['namespace', 'sourceId'])
  })
}
export const down = async (knex: Knex): Promise<void> => {
  await knex.transaction(async tx => {
    if (knex.client.config.client === 'pg') await tx.raw('LOCK TABLE "hedgedocImports" IN ACCESS EXCLUSIVE MODE')
    if (await tx('hedgedocImports').first()) throw new Error('Imported content provenance is authoritative recovery data; fix forward instead of dropping it.')
    await tx.schema.dropTable('hedgedocImports')
  })
}
