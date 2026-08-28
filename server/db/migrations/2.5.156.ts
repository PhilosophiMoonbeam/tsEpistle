import type { Knex } from 'knex'

const TASKS = 'agentRunTasks'

export const up = async (knex: Knex): Promise<void> => {
  if (await knex.schema.hasTable(TASKS)) return
  await knex.schema.createTable(TASKS, table => {
    table.uuid('id').primary()
    table.uuid('runId').notNullable().references('id').inTable('agentRuns').onDelete('CASCADE')
    table.uuid('parentTaskId').nullable().references('id').inTable(TASKS).onDelete('CASCADE')
    table.uuid('subagentRunId').nullable().unique()
    table.integer('ordinal').unsigned().notNullable()
    table.integer('depth').unsigned().notNullable().defaultTo(1)
    table.string('kind', 32).notNullable()
    table.string('title', 120).notNullable()
    table.text('question').notNullable()
    table.text('sourceScope').notNullable()
    table.integer('requiredEvidenceCount').unsigned().notNullable()
    table.boolean('required').notNullable().defaultTo(true)
    table.string('status', 24).notNullable().defaultTo('pending')
    table.string('outcome', 24).nullable()
    table.integer('attempt').unsigned().notNullable().defaultTo(0)
    table.integer('evidenceCount').unsigned().notNullable().defaultTo(0)
    table.string('authoritySha256', 64).nullable()
    table.string('resultSha256', 64).nullable()
    table.text('result').nullable()
    table.string('errorCode', 128).nullable()
    table.text('errorMessage').nullable()
    table.dateTime('createdAt').notNullable().defaultTo(knex.fn.now())
    table.dateTime('updatedAt').notNullable().defaultTo(knex.fn.now())
    table.dateTime('startedAt').nullable()
    table.dateTime('completedAt').nullable()
    table.unique(['runId', 'ordinal'], { indexName: 'agent_run_tasks_run_ordinal_unique' })
    table.index(['runId', 'status'], 'agent_run_tasks_run_status_idx')
  })
}

export const down = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasTable(TASKS)) return
  const existing = await knex(TASKS).first('id')
  if (existing) throw new Error('agentRunTasks contains durable research state; refuse destructive rollback')
  await knex.schema.dropTable(TASKS)
}
