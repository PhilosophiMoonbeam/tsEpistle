import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('pageApprovalRequests', table => {
    table.uuid('id').primary()
    table.integer('pageId').unsigned().notNullable().references('id').inTable('pages').onDelete('CASCADE')
    table.integer('submitterId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.integer('assigneeId').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
    table.string('status', 32).notNullable()
    table.integer('revisionId').unsigned().notNullable().references('id').inTable('pageHistory').onDelete('CASCADE')
    table.dateTime('revisionUpdatedAt').notNullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.dateTime('closedAt').nullable()
    table.index(['pageId', 'status'], 'page_approval_requests_page_status_lookup')
    table.index(['assigneeId', 'status', 'updatedAt'], 'page_approval_requests_assignee_inbox')
    table.index(['submitterId', 'updatedAt'], 'page_approval_requests_submitter_lookup')
  })

  await knex.schema.createTable('pageApprovalTransitions', table => {
    table.uuid('id').primary()
    table.uuid('requestId').notNullable().references('id').inTable('pageApprovalRequests').onDelete('CASCADE')
    table.string('fromStatus', 32).nullable()
    table.string('toStatus', 32).notNullable()
    table.integer('actorId').unsigned().notNullable().references('id').inTable('users').onDelete('RESTRICT')
    table.integer('revisionId').unsigned().notNullable().references('id').inTable('pageHistory').onDelete('RESTRICT')
    table.text('comment').nullable()
    table.dateTime('createdAt').notNullable()
    table.index(['requestId', 'createdAt'], 'page_approval_transitions_history')
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.dropTableIfExists('pageApprovalTransitions')
  await knex.schema.dropTableIfExists('pageApprovalRequests')
}
