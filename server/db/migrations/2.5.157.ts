import type { Knex } from 'knex'

const GOALS = 'agentGoals'

export const up = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasTable(GOALS)) {
    await knex.schema.createTable(GOALS, table => {
      table.uuid('id').primary()
      table.uuid('sessionId').notNullable().references('id').inTable('agentSessions').onDelete('CASCADE')
      table.integer('ownerId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.integer('createdByUserId').unsigned().notNullable().references('id').inTable('users').onDelete('RESTRICT')
      table.text('objective').notNullable()
      table.string('objectiveSha256', 64).notNullable()
      table.string('status', 24).notNullable().defaultTo('active')
      table.integer('version').unsigned().notNullable().defaultTo(1)
      table.integer('continuationCount').unsigned().notNullable().defaultTo(0)
      table.integer('maxContinuations').unsigned().notNullable()
      table.bigInteger('consumedTokens').notNullable().defaultTo(0)
      table.bigInteger('maxTokens').notNullable()
      table.integer('consumedToolCalls').unsigned().notNullable().defaultTo(0)
      table.integer('maxToolCalls').unsigned().notNullable()
      table.string('completionOutcome', 24).nullable()
      table.text('completionAssessment').nullable()
      table.string('completionAssessmentSha256', 64).nullable()
      table.string('errorCode', 128).nullable()
      table.text('errorMessage').nullable()
      table.dateTime('startedAt').notNullable().defaultTo(knex.fn.now())
      table.dateTime('deadlineAt').notNullable()
      table.dateTime('updatedAt').notNullable().defaultTo(knex.fn.now())
      table.dateTime('completedAt').nullable()
      table.index(['ownerId', 'updatedAt'], 'agent_goals_owner_activity_idx')
      table.index(['sessionId', 'status'], 'agent_goals_session_status_idx')
    })
    await knex.raw(`CREATE UNIQUE INDEX agent_goals_one_open_per_session ON "${GOALS}" ("sessionId") WHERE status IN ('active', 'paused', 'blocked')`)
  }

  if (!await knex.schema.hasColumn('agentRuns', 'goalId')) {
    await knex.schema.alterTable('agentRuns', table => {
      table.uuid('goalId').nullable().references('id').inTable(GOALS).onDelete('SET NULL')
      table.integer('goalContinuation').unsigned().nullable()
      table.string('completionOutcome', 24).nullable()
      table.text('completionAssessment').nullable()
      table.string('completionAssessmentSha256', 64).nullable()
      table.unique(['goalId', 'goalContinuation'], { indexName: 'agent_runs_goal_continuation_unique' })
      table.index(['goalId', 'queuedAt'], 'agent_runs_goal_activity_idx')
    })
  }

  if (!await knex.schema.hasColumn('agentMessages', 'isVisible')) {
    await knex.schema.alterTable('agentMessages', table => {
      table.boolean('isVisible').notNullable().defaultTo(true)
    })
  }
}

export const down = async (knex: Knex): Promise<void> => {
  if (await knex.schema.hasTable(GOALS)) {
    const existing = await knex(GOALS).first('id')
    if (existing) throw new Error('agentGoals contains durable goal state; refuse destructive rollback')
  }
  if (await knex.schema.hasColumn('agentMessages', 'isVisible')) {
    await knex.schema.alterTable('agentMessages', table => table.dropColumn('isVisible'))
  }
  if (await knex.schema.hasColumn('agentRuns', 'goalId')) {
    await knex.schema.alterTable('agentRuns', table => {
      table.dropIndex(['goalId', 'queuedAt'], 'agent_runs_goal_activity_idx')
      table.dropUnique(['goalId', 'goalContinuation'], 'agent_runs_goal_continuation_unique')
      table.dropColumn('completionAssessmentSha256')
      table.dropColumn('completionAssessment')
      table.dropColumn('completionOutcome')
      table.dropColumn('goalContinuation')
      table.dropColumn('goalId')
    })
  }
  if (await knex.schema.hasTable(GOALS)) await knex.schema.dropTable(GOALS)
}
