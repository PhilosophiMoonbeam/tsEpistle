import type { Knex } from 'knex'

/** Administrative policy is not authored content; retain identity and audit after deletion. */
export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('pageEditLocks', table => {
    table.integer('pageId').primary()
    table.boolean('isEditLocked').notNullable().defaultTo(false)
    table.bigInteger('lockVersion').notNullable().defaultTo(0)
    table.integer('updatedBy').notNullable()
    table.text('reason').notNullable()
    table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.check('?? > 0 AND ?? >= 0 AND ?? > 0', ['pageId', 'lockVersion', 'updatedBy'], 'page_edit_lock_identity_check')
    table.check('length(??) BETWEEN 1 AND 500', ['reason'], 'page_edit_lock_reason_check')
  })
  await knex.schema.createTable('pageEditLockAudit', table => {
    table.uuid('id').primary()
    table.integer('pageId').notNullable()
    table.bigInteger('lockVersion').notNullable()
    table.boolean('wasEditLocked').notNullable()
    table.boolean('isEditLocked').notNullable()
    table.integer('actorId').notNullable()
    table.text('reason').notNullable()
    table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.unique(['pageId', 'lockVersion'], { indexName: 'page_edit_lock_audit_version_unique' })
    table.check('?? > 0 AND ?? > 0 AND ?? > 0', ['pageId', 'lockVersion', 'actorId'], 'page_edit_lock_audit_identity_check')
    table.check('length(??) BETWEEN 1 AND 500', ['reason'], 'page_edit_lock_audit_reason_check')
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.transaction(async transaction => {
    if (knex.client.config.client === 'pg') await transaction.raw('LOCK TABLE "pageEditLocks", "pageEditLockAudit" IN ACCESS EXCLUSIVE MODE')
    if (await transaction('pageEditLocks').first('pageId') || await transaction('pageEditLockAudit').first('id')) {
      throw new Error('Page edit-lock state and audit must be retained; fix forward instead of dropping administrative policy.')
    }
    await transaction.schema.dropTable('pageEditLockAudit')
    await transaction.schema.dropTable('pageEditLocks')
  })
}
