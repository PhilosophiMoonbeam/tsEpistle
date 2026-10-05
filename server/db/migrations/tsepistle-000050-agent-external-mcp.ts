import type { Knex } from 'knex'

export const up = async (db: Knex): Promise<void> => {
  await db.schema.createTable('agentExternalMcpServers', table => {
    table.uuid('id').primary()
    table.string('displayName', 100).notNullable()
    table.text('endpointUrl').notNullable()
    table.string('scope', 16).notNullable()
    table.integer('ownerId').nullable().references('id').inTable('users').onDelete('CASCADE')
    table.string('status', 16).notNullable()
    table.integer('revision').notNullable()
    table.string('authMode', 16).notNullable()
    table.string('secretReference', 128).nullable()
    table.integer('createdBy').nullable().references('id').inTable('users').onDelete('SET NULL')
    table.integer('updatedBy').nullable().references('id').inTable('users').onDelete('SET NULL')
    table.timestamp('createdAt', { useTz: true }).notNullable()
    table.timestamp('updatedAt', { useTz: true }).notNullable()
    table.index(['scope', 'ownerId', 'status'])
    table.check('("scope" = \'admin\' AND "ownerId" IS NULL) OR ("scope" = \'personal\' AND "ownerId" IS NOT NULL)')
    table.check("\"status\" IN ('enabled', 'disabled')")
    table.check("\"authMode\" IN ('none', 'bearer')")
    table.check('"revision" > 0')
    table.check(
      '("authMode" = \'none\' AND "secretReference" IS NULL) OR ("authMode" = \'bearer\' AND "secretReference" IS NOT NULL AND "secretReference" LIKE \'managed:%\')'
    )
  })
  await db.schema.createTable('agentExternalMcpGrants', table => {
    table.uuid('serverId').notNullable().references('id').inTable('agentExternalMcpServers').onDelete('CASCADE')
    table.integer('groupId').notNullable().references('id').inTable('groups').onDelete('CASCADE')
    table.primary(['serverId', 'groupId'])
    table.index(['groupId', 'serverId'])
  })
  await db.schema.createTable('agentExternalMcpGroupPolicies', table => {
    table.integer('groupId').primary().references('id').inTable('groups').onDelete('CASCADE')
    table.boolean('allowPersonalEndpoints').notNullable().defaultTo(false)
    table.integer('revision').notNullable()
    table.integer('updatedBy').nullable().references('id').inTable('users').onDelete('SET NULL')
    table.timestamp('updatedAt', { useTz: true }).notNullable()
    table.check('"revision" > 0')
  })
}

export const down = async (db: Knex): Promise<void> => {
  if ((await db('agentExternalMcpServers').first('id')) || (await db('agentExternalMcpGroupPolicies').first('groupId'))) {
    throw new Error('Cannot discard external MCP configuration or credentials. Apply a forward migration.')
  }
  await db.schema.dropTable('agentExternalMcpGroupPolicies')
  await db.schema.dropTable('agentExternalMcpGrants')
  await db.schema.dropTable('agentExternalMcpServers')
}
