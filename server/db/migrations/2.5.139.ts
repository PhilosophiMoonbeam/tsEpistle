import type { Knex } from 'knex'

const AGENT_TABLES_IN_DROP_ORDER = [
  'agentBrowserTargets',
  'agentArtifacts',
  'agentQuotaReservations',
  'agentQuotaDaily',
  'agentUsageLedger',
  'pageMutationOutbox',
  'agentActionExecutions',
  'agentApprovals',
  'agentProposals',
  'agentSkillUses',
  'agentRunSkills',
  'agentSessionSkills',
  'agentEvents',
  'agentRuns',
  'agentMessages',
  'agentLaunchHandoffs',
  'agentSessions',
  'agentSkillGrants',
  'agentSkillVersions',
  'agentSkills',
  'agentProviderGrants',
  'agentProviderConformanceReports',
  'agentProviderConfiguration',
  'agentProviderProfileVersions',
  'agentProviderProfiles'
] as const

const timestamps = (table: Knex.CreateTableBuilder, knex: Knex): void => {
  table.dateTime('createdAt').notNullable().defaultTo(knex.fn.now())
  table.dateTime('updatedAt').notNullable().defaultTo(knex.fn.now())
}

const userReference = (table: Knex.CreateTableBuilder, name: string, nullable = false): void => {
  const column = table.integer(name).unsigned()
  if (nullable) column.nullable()
  else column.notNullable()
  column.references('id').inTable('users').onDelete(nullable ? 'SET NULL' : 'RESTRICT')
}

const createProviderTables = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('agentProviderProfiles', table => {
    table.uuid('id').primary()
    table.string('displayName', 255).notNullable().unique()
    table.string('status', 16).notNullable().defaultTo('disabled')
    table.boolean('isGlobalDefault').notNullable().defaultTo(false)
    table.string('exposureMode', 32).notNullable().defaultTo('all_agent_users')
    table.uuid('currentVersionId').nullable()
    table.bigInteger('policyVersion').notNullable().defaultTo(1)
    table.boolean('conformed').notNullable().defaultTo(false)
    userReference(table, 'createdBy')
    userReference(table, 'updatedBy')
    timestamps(table, knex)
    table.index(['status', 'exposureMode'], 'agent_provider_profiles_status_exposure_idx')
  })

  await knex.schema.createTable('agentProviderProfileVersions', table => {
    table.uuid('id').primary()
    table.uuid('profileId').notNullable().references('id').inTable('agentProviderProfiles').onDelete('CASCADE')
    table.integer('version').unsigned().notNullable()
    table.string('transportKind', 32).notNullable()
    table.string('model', 255).notNullable()
    table.text('baseUrl').notNullable()
    table.string('authMode', 32).notNullable()
    table.string('secretReference', 255).nullable()
    table.text('adapterConfig').notNullable()
    table.text('capabilities').notNullable()
    table.string('capabilityRevision', 128).notNullable()
    table.text('policies').notNullable()
    table.string('pricingRevision', 128).notNullable()
    table.boolean('conformed').notNullable().defaultTo(false)
    userReference(table, 'createdBy')
    table.dateTime('createdAt').notNullable().defaultTo(knex.fn.now())
    table.unique(['profileId', 'version'], { indexName: 'agent_provider_versions_identity_unique' })
  })

  await knex.schema.alterTable('agentProviderProfiles', table => {
    table.foreign('currentVersionId', 'agent_provider_profiles_current_version_fk')
      .references('id').inTable('agentProviderProfileVersions').onDelete('RESTRICT')
  })

  await knex.schema.createTable('agentProviderConfiguration', table => {
    table.integer('id').primary()
    table.bigInteger('defaultGeneration').notNullable().defaultTo(1)
    table.dateTime('updatedAt').notNullable().defaultTo(knex.fn.now())
    userReference(table, 'updatedBy', true)
  })

  await knex.schema.createTable('agentProviderGrants', table => {
    table.uuid('profileId').notNullable().references('id').inTable('agentProviderProfiles').onDelete('CASCADE')
    table.integer('groupId').unsigned().notNullable().references('id').inTable('groups').onDelete('CASCADE')
    table.primary(['profileId', 'groupId'], { constraintName: 'agent_provider_grants_pk' })
  })

  await knex.schema.createTable('agentProviderConformanceReports', table => {
    table.uuid('id').primary()
    table.uuid('profileVersionId').notNullable().references('id').inTable('agentProviderProfileVersions').onDelete('CASCADE')
    table.string('status', 16).notNullable()
    table.text('checks').notNullable()
    table.string('errorCode', 128).nullable()
    userReference(table, 'actorId')
    table.dateTime('startedAt').notNullable()
    table.dateTime('completedAt').notNullable()
    table.index(['profileVersionId', 'completedAt'], 'agent_provider_conformance_version_time_idx')
  })

  await knex.raw(`CREATE UNIQUE INDEX agent_provider_one_default ON "agentProviderProfiles" ("isGlobalDefault") WHERE "isGlobalDefault" = true AND status = 'enabled' AND conformed = true AND "exposureMode" = 'all_agent_users'`)
}

const createSkillTables = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('agentSkills', table => {
    table.uuid('id').primary()
    table.string('name', 64).notNullable().unique()
    table.integer('rootPageId').unsigned().notNullable().references('id').inTable('pages').onDelete('RESTRICT')
    table.text('rootPath').notNullable()
    table.integer('assetFolderId').unsigned().nullable().references('id').inTable('assetFolders').onDelete('SET NULL')
    table.string('status', 16).notNullable().defaultTo('disabled')
    table.string('exposureMode', 32).notNullable().defaultTo('all_agent_users')
    table.uuid('currentVersionId').nullable()
    userReference(table, 'createdBy')
    userReference(table, 'updatedBy')
    timestamps(table, knex)
    table.index(['status', 'name'], 'agent_skills_status_name_idx')
  })

  await knex.schema.createTable('agentSkillVersions', table => {
    table.uuid('id').primary()
    table.uuid('skillId').notNullable().references('id').inTable('agentSkills').onDelete('CASCADE')
    table.bigInteger('sourceRevision').notNullable()
    table.dateTime('sourceUpdatedAt').notNullable()
    table.integer('sourceHistoryId').unsigned().nullable().references('id').inTable('pageHistory').onDelete('SET NULL')
    table.text('skillMarkdown').notNullable()
    table.text('frontmatter').notNullable()
    table.binary('resourceBundle').notNullable()
    table.text('resourceManifest').notNullable()
    table.string('contentHash', 64).notNullable()
    table.string('approvalStatus', 16).notNullable()
    userReference(table, 'approvedBy', true)
    table.dateTime('approvedAt').nullable()
    table.dateTime('createdAt').notNullable().defaultTo(knex.fn.now())
    table.unique(['skillId', 'contentHash'], { indexName: 'agent_skill_versions_content_unique' })
  })

  await knex.schema.alterTable('agentSkills', table => {
    table.foreign('currentVersionId', 'agent_skills_current_version_fk')
      .references('id').inTable('agentSkillVersions').onDelete('RESTRICT')
  })

  await knex.schema.createTable('agentSkillGrants', table => {
    table.uuid('skillId').notNullable().references('id').inTable('agentSkills').onDelete('CASCADE')
    table.integer('groupId').unsigned().notNullable().references('id').inTable('groups').onDelete('CASCADE')
    table.primary(['skillId', 'groupId'], { constraintName: 'agent_skill_grants_pk' })
  })
}

const createSessionTables = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('agentSessions', table => {
    table.uuid('id').primary()
    table.integer('ownerId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.string('title', 255).notNullable()
    table.string('retention', 16).notNullable()
    table.uuid('providerProfileId').nullable().references('id').inTable('agentProviderProfiles').onDelete('RESTRICT')
    table.string('executionMode', 24).notNullable()
    table.integer('version').unsigned().notNullable().defaultTo(1)
    table.text('summary').nullable()
    table.integer('summaryThroughOrdinal').unsigned().nullable()
    table.dateTime('createdAt').notNullable().defaultTo(knex.fn.now())
    table.dateTime('updatedAt').notNullable().defaultTo(knex.fn.now())
    table.dateTime('lastActivityAt').notNullable().defaultTo(knex.fn.now())
    table.dateTime('expiresAt').nullable()
    table.dateTime('deletedAt').nullable()
    table.index(['ownerId', 'lastActivityAt'], 'agent_sessions_owner_activity_idx')
    table.index(['expiresAt'], 'agent_sessions_expiry_idx')
  })

  await knex.schema.createTable('agentLaunchHandoffs', table => {
    table.uuid('id').primary()
    table.binary('tokenSha256').notNullable().unique()
    table.integer('ownerId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.integer('pageId').unsigned().nullable().references('id').inTable('pages').onDelete('SET NULL')
    table.string('localeCode', 16).nullable()
    table.text('path').nullable()
    table.dateTime('observedUpdatedAt').nullable()
    table.binary('pageHintSha256').notNullable()
    table.dateTime('createdAt').notNullable().defaultTo(knex.fn.now())
    table.dateTime('expiresAt').notNullable()
    table.dateTime('consumedAt').nullable()
    table.index(['expiresAt'], 'agent_launch_handoffs_expiry_idx')
  })

  await knex.schema.createTable('agentMessages', table => {
    table.uuid('id').primary()
    table.uuid('sessionId').notNullable().references('id').inTable('agentSessions').onDelete('CASCADE')
    table.uuid('runId').nullable()
    table.integer('ordinal').unsigned().notNullable()
    table.string('role', 16).notNullable()
    table.string('status', 24).notNullable()
    table.text('content').notNullable()
    table.text('citations').nullable()
    table.binary('providerStateCiphertext').nullable()
    table.string('providerStateSha256', 64).nullable()
    timestamps(table, knex)
    table.unique(['sessionId', 'ordinal'], { indexName: 'agent_messages_session_ordinal_unique' })
  })
}

const createRunTables = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('agentRuns', table => {
    table.uuid('id').primary()
    table.uuid('sessionId').notNullable().references('id').inTable('agentSessions').onDelete('CASCADE')
    table.uuid('userMessageId').notNullable().references('id').inTable('agentMessages').onDelete('CASCADE')
    table.uuid('assistantMessageId').notNullable().references('id').inTable('agentMessages').onDelete('CASCADE')
    table.integer('ownerId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.uuid('clientRequestId').notNullable()
    table.string('clientRequestSha256', 64).notNullable()
    table.string('profileResolutionSha256', 64).notNullable()
    table.string('status', 32).notNullable()
    table.integer('attempts').unsigned().notNullable().defaultTo(0)
    table.integer('maxAttempts').unsigned().notNullable().defaultTo(3)
    table.integer('eventSequence').unsigned().notNullable().defaultTo(0)
    table.dateTime('availableAt').notNullable()
    table.string('leaseOwner', 255).nullable()
    table.uuid('leaseToken').nullable()
    table.dateTime('leaseExpiresAt').nullable()
    table.dateTime('cancelRequestedAt').nullable()
    table.boolean('sideEffectsStarted').notNullable().defaultTo(false)
    table.uuid('providerProfileVersionId').notNullable().references('id').inTable('agentProviderProfileVersions').onDelete('RESTRICT')
    table.string('transportKind', 32).notNullable()
    table.string('model', 255).notNullable()
    table.string('executionMode', 24).notNullable()
    table.bigInteger('profilePolicyVersion').notNullable()
    table.bigInteger('defaultGeneration').notNullable()
    table.string('capabilityRevision', 128).notNullable()
    table.string('pricingRevision', 128).notNullable()
    table.integer('promptVersion').unsigned().notNullable()
    table.bigInteger('inputTokens').notNullable().defaultTo(0)
    table.bigInteger('outputTokens').notNullable().defaultTo(0)
    table.bigInteger('estimatedCostMicros').nullable()
    table.binary('runtimeStateCiphertext').nullable()
    table.string('errorCode', 128).nullable()
    table.text('errorMessage').nullable()
    table.dateTime('queuedAt').notNullable().defaultTo(knex.fn.now())
    table.dateTime('startedAt').nullable()
    table.dateTime('updatedAt').notNullable().defaultTo(knex.fn.now())
    table.dateTime('completedAt').nullable()
    table.unique(['sessionId', 'clientRequestId'], { indexName: 'agent_runs_session_request_unique' })
    table.index(['status', 'availableAt'], 'agent_runs_status_available_idx')
    table.index(['leaseExpiresAt'], 'agent_runs_lease_expiry_idx')
    table.index(['ownerId', 'updatedAt'], 'agent_runs_owner_activity_idx')
  })

  await knex.schema.alterTable('agentMessages', table => {
    table.foreign('runId', 'agent_messages_run_fk').references('id').inTable('agentRuns').onDelete('SET NULL')
  })

  await knex.raw(`CREATE UNIQUE INDEX agent_runs_one_active_per_session ON "agentRuns" ("sessionId") WHERE status IN ('queued', 'running', 'awaiting_approval')`)

  await knex.schema.createTable('agentEvents', table => {
    table.uuid('id').primary()
    table.uuid('runId').notNullable().references('id').inTable('agentRuns').onDelete('CASCADE')
    table.integer('sequence').unsigned().notNullable()
    table.string('type', 64).notNullable()
    table.integer('attempt').unsigned().notNullable()
    table.integer('schemaVersion').unsigned().notNullable().defaultTo(1)
    table.string('dataSha256', 64).notNullable()
    table.text('data').notNullable()
    table.dateTime('createdAt').notNullable().defaultTo(knex.fn.now())
    table.unique(['runId', 'sequence'], { indexName: 'agent_events_run_sequence_unique' })
  })

  await knex.schema.createTable('agentSessionSkills', table => {
    table.uuid('sessionId').notNullable().references('id').inTable('agentSessions').onDelete('CASCADE')
    table.uuid('skillVersionId').notNullable().references('id').inTable('agentSkillVersions').onDelete('RESTRICT')
    table.integer('ordinal').unsigned().notNullable()
    userReference(table, 'selectedBy')
    table.dateTime('selectedAt').notNullable().defaultTo(knex.fn.now())
    table.unique(['sessionId', 'skillVersionId'], { indexName: 'agent_session_skills_version_unique' })
    table.unique(['sessionId', 'ordinal'], { indexName: 'agent_session_skills_ordinal_unique' })
  })

  await knex.schema.createTable('agentRunSkills', table => {
    table.uuid('runId').notNullable().references('id').inTable('agentRuns').onDelete('CASCADE')
    table.uuid('skillVersionId').notNullable().references('id').inTable('agentSkillVersions').onDelete('RESTRICT')
    table.integer('ordinal').unsigned().notNullable()
    table.primary(['runId', 'skillVersionId'], { constraintName: 'agent_run_skills_pk' })
    table.unique(['runId', 'ordinal'], { indexName: 'agent_run_skills_ordinal_unique' })
  })

  await knex.schema.createTable('agentSkillUses', table => {
    table.uuid('id').primary()
    table.uuid('skillVersionId').notNullable().references('id').inTable('agentSkillVersions').onDelete('RESTRICT')
    table.uuid('runId').nullable().references('id').inTable('agentRuns').onDelete('CASCADE')
    table.uuid('sessionId').nullable().references('id').inTable('agentSessions').onDelete('CASCADE')
    table.integer('requesterUserId').unsigned().nullable().references('id').inTable('users').onDelete('CASCADE')
    table.integer('requesterApiKeyId').unsigned().nullable().references('id').inTable('apiKeys').onDelete('RESTRICT')
    table.uuid('transportRequestId').notNullable()
    table.string('externalSessionSha256', 64).nullable()
    table.text('resourcePath').nullable()
    table.string('purpose', 16).notNullable()
    table.string('contentHash', 64).notNullable()
    table.dateTime('createdAt').notNullable().defaultTo(knex.fn.now())
    table.index(['skillVersionId', 'createdAt'], 'agent_skill_uses_version_time_idx')
  })
}

const createProposalTables = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('agentProposals', table => {
    table.uuid('id').primary()
    table.string('sourceKind', 16).notNullable()
    table.uuid('runId').nullable().references('id').inTable('agentRuns').onDelete('CASCADE')
    table.uuid('sessionId').nullable().references('id').inTable('agentSessions').onDelete('CASCADE')
    table.integer('requesterUserId').unsigned().nullable().references('id').inTable('users').onDelete('RESTRICT')
    table.integer('requesterApiKeyId').unsigned().nullable().references('id').inTable('apiKeys').onDelete('RESTRICT')
    table.uuid('requesterRequestId').notNullable()
    table.string('actionCallId', 128).notNullable()
    table.string('actionName', 128).notNullable()
    table.string('risk', 32).notNullable()
    table.text('summary').notNullable()
    table.string('status', 24).notNullable()
    table.text('input').nullable()
    table.string('inputHash', 64).notNullable()
    table.integer('authorityVersion').unsigned().notNullable()
    table.string('authoritySha256', 64).notNullable()
    table.integer('pageId').unsigned().nullable().references('id').inTable('pages').onDelete('SET NULL')
    table.bigInteger('baseSourceRevision').nullable()
    table.string('baseLineEnding', 8).nullable()
    table.boolean('baseFinalNewline').nullable()
    table.string('baseRawSha256', 64).nullable()
    table.string('baseCanonicalSha256', 64).nullable()
    table.string('disclosedRangesSha256', 64).nullable()
    table.string('patchFormat', 64).nullable()
    table.integer('patchEngineVersion').unsigned().nullable()
    table.string('patchSha256', 64).nullable()
    table.text('patch').nullable()
    table.text('operation').notNullable()
    table.string('operationSha256', 64).notNullable()
    table.string('resultRawSha256', 64).nullable()
    table.string('resultCanonicalSha256', 64).nullable()
    table.integer('diffRendererVersion').unsigned().nullable()
    table.string('diffSha256', 64).nullable()
    table.text('diff').nullable()
    table.dateTime('expiresAt').notNullable()
    table.dateTime('createdAt').notNullable().defaultTo(knex.fn.now())
    table.dateTime('appliedAt').nullable()
    table.dateTime('contentPurgedAt').nullable()
    table.text('applyResult').nullable()
    table.index(['status', 'expiresAt'], 'agent_proposals_status_expiry_idx')
  })

  await knex.raw(`CREATE UNIQUE INDEX agent_proposals_agent_request_unique ON "agentProposals" ("runId", "actionCallId") WHERE "sourceKind" = 'agent'`)
  await knex.raw(`CREATE UNIQUE INDEX agent_proposals_mcp_request_unique ON "agentProposals" ("requesterApiKeyId", "requesterRequestId", "actionCallId") WHERE "sourceKind" = 'mcp'`)

  await knex.schema.createTable('agentApprovals', table => {
    table.uuid('id').primary()
    table.uuid('proposalId').notNullable().unique().references('id').inTable('agentProposals').onDelete('CASCADE')
    table.uuid('runId').nullable().references('id').inTable('agentRuns').onDelete('CASCADE')
    table.integer('requesterUserId').unsigned().nullable().references('id').inTable('users').onDelete('RESTRICT')
    table.integer('requesterApiKeyId').unsigned().nullable().references('id').inTable('apiKeys').onDelete('RESTRICT')
    table.string('status', 16).notNullable()
    table.string('inputHash', 64).notNullable()
    table.integer('authorityVersion').unsigned().notNullable()
    table.string('authoritySha256', 64).notNullable()
    table.string('patchSha256', 64).nullable()
    table.string('resultCanonicalSha256', 64).nullable()
    table.string('diffSha256', 64).nullable()
    table.string('operationSha256', 64).notNullable()
    table.dateTime('requestedAt').notNullable().defaultTo(knex.fn.now())
    table.dateTime('expiresAt').notNullable()
    table.dateTime('decidedAt').nullable()
    table.integer('approvedByUserId').unsigned().nullable().references('id').inTable('users').onDelete('RESTRICT')
    table.text('decisionNote').nullable()
    table.index(['status', 'expiresAt'], 'agent_approvals_status_expiry_idx')
  })

  await knex.schema.createTable('agentActionExecutions', table => {
    table.uuid('id').primary()
    table.uuid('proposalId').notNullable().unique().references('id').inTable('agentProposals').onDelete('CASCADE')
    table.uuid('runId').nullable().references('id').inTable('agentRuns').onDelete('CASCADE')
    table.string('actionName', 128).notNullable()
    table.integer('requesterUserId').unsigned().nullable().references('id').inTable('users').onDelete('RESTRICT')
    table.integer('requesterApiKeyId').unsigned().nullable().references('id').inTable('apiKeys').onDelete('RESTRICT')
    table.integer('approvedByUserId').unsigned().notNullable().references('id').inTable('users').onDelete('RESTRICT')
    table.string('idempotencyKey', 128).notNullable().unique()
    table.uuid('leaseToken').nullable()
    table.string('status', 24).notNullable()
    table.string('inputHash', 64).notNullable()
    table.dateTime('startedAt').notNullable().defaultTo(knex.fn.now())
    table.dateTime('completedAt').nullable()
    table.text('result').nullable()
    table.text('error').nullable()
  })
}

const createMutationAndUsageTables = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('pageMutationOutbox', table => {
    table.uuid('id').primary()
    table.integer('pageId').unsigned().notNullable()
    table.bigInteger('sourceRevision').notNullable()
    table.string('effectKind', 64).notNullable()
    table.string('effectKey', 255).notNullable()
    table.string('desiredState', 32).notNullable()
    table.string('payloadSha256', 64).notNullable()
    table.text('payload').notNullable()
    table.string('status', 24).notNullable().defaultTo('pending')
    table.integer('attempts').unsigned().notNullable().defaultTo(0)
    table.string('leaseOwner', 255).nullable()
    table.uuid('leaseToken').nullable()
    table.dateTime('leaseExpiresAt').nullable()
    table.dateTime('availableAt').notNullable().defaultTo(knex.fn.now())
    table.text('result').nullable()
    table.text('postcondition').nullable()
    table.dateTime('createdAt').notNullable().defaultTo(knex.fn.now())
    table.dateTime('updatedAt').notNullable().defaultTo(knex.fn.now())
    table.unique(['pageId', 'sourceRevision', 'effectKind'], { indexName: 'page_mutation_outbox_revision_effect_unique' })
    table.index(['status', 'availableAt'], 'page_mutation_outbox_status_available_idx')
  })

  await knex.schema.createTable('agentUsageLedger', table => {
    table.uuid('id').primary()
    table.uuid('runId').notNullable().references('id').inTable('agentRuns').onDelete('CASCADE')
    table.integer('ownerId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.uuid('providerProfileVersionId').notNullable().references('id').inTable('agentProviderProfileVersions').onDelete('RESTRICT')
    table.string('model', 255).notNullable()
    table.bigInteger('inputTokens').notNullable().defaultTo(0)
    table.bigInteger('outputTokens').notNullable().defaultTo(0)
    table.bigInteger('cachedTokens').nullable()
    table.bigInteger('reasoningTokens').nullable()
    table.bigInteger('estimatedCostMicros').nullable()
    table.string('remoteRequestIdSha256', 64).nullable()
    table.dateTime('createdAt').notNullable().defaultTo(knex.fn.now())
    table.index(['ownerId', 'createdAt'], 'agent_usage_owner_time_idx')
  })

  await knex.schema.createTable('agentQuotaDaily', table => {
    table.integer('ownerId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.date('day').notNullable()
    table.bigInteger('reservedTokens').notNullable().defaultTo(0)
    table.bigInteger('consumedTokens').notNullable().defaultTo(0)
    table.bigInteger('reservedCostMicros').notNullable().defaultTo(0)
    table.bigInteger('consumedCostMicros').notNullable().defaultTo(0)
    table.dateTime('updatedAt').notNullable().defaultTo(knex.fn.now())
    table.primary(['ownerId', 'day'], { constraintName: 'agent_quota_daily_pk' })
  })

  await knex.schema.createTable('agentQuotaReservations', table => {
    table.uuid('runId').primary().references('id').inTable('agentRuns').onDelete('CASCADE')
    table.integer('ownerId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.date('day').notNullable()
    table.bigInteger('reservedTokens').notNullable()
    table.bigInteger('reservedCostMicros').notNullable()
    table.bigInteger('consumedTokens').notNullable().defaultTo(0)
    table.bigInteger('consumedCostMicros').notNullable().defaultTo(0)
    table.string('status', 24).notNullable()
    table.dateTime('expiresAt').notNullable()
    table.dateTime('heartbeatAt').notNullable().defaultTo(knex.fn.now())
    table.dateTime('reconciledAt').nullable()
    table.index(['status', 'expiresAt'], 'agent_quota_reservations_expiry_idx')
  })

  await knex.schema.createTable('agentArtifacts', table => {
    table.uuid('id').primary()
    table.uuid('sessionId').notNullable().references('id').inTable('agentSessions').onDelete('CASCADE')
    table.uuid('runId').notNullable().references('id').inTable('agentRuns').onDelete('CASCADE')
    table.integer('ownerId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.string('kind', 32).notNullable()
    table.string('mimeType', 32).notNullable()
    table.integer('byteLength').unsigned().notNullable()
    table.string('sha256', 64).notNullable()
    table.binary('payload').nullable()
    table.integer('width').unsigned().notNullable()
    table.integer('height').unsigned().notNullable()
    table.dateTime('createdAt').notNullable().defaultTo(knex.fn.now())
    table.dateTime('expiresAt').nullable()
    table.text('metadata').nullable()
    table.index(['ownerId', 'createdAt'], 'agent_artifacts_owner_time_idx')
    table.index(['expiresAt'], 'agent_artifacts_expiry_idx')
  })

  await knex.schema.createTable('agentBrowserTargets', table => {
    table.uuid('id').primary()
    table.text('canonicalUrl').notNullable().unique()
    table.boolean('enabled').notNullable().defaultTo(false)
    table.string('policySha256', 64).notNullable()
    userReference(table, 'createdBy')
    userReference(table, 'updatedBy')
    timestamps(table, knex)
  })
}

const addSourceRevision = async (knex: Knex): Promise<void> => {
  await knex.schema.alterTable('pages', table => {
    table.bigInteger('sourceRevision').notNullable().defaultTo(1)
  })
  await knex.schema.alterTable('pageHistory', table => {
    table.bigInteger('sourceRevision').notNullable().defaultTo(1)
  })
  await knex.raw(`
    CREATE FUNCTION wiki_increment_page_source_revision() RETURNS trigger AS $$
    BEGIN
      IF ROW(NEW.path, NEW.hash, NEW.title, NEW.description, NEW.visibility, NEW."ownerId", NEW."isPublished", NEW."publishStartDate", NEW."publishEndDate", NEW.content, NEW."contentType", NEW."editorKey", NEW."localeCode", NEW."authorId", NEW."creatorId", NEW.extra::text)
        IS DISTINCT FROM
        ROW(OLD.path, OLD.hash, OLD.title, OLD.description, OLD.visibility, OLD."ownerId", OLD."isPublished", OLD."publishStartDate", OLD."publishEndDate", OLD.content, OLD."contentType", OLD."editorKey", OLD."localeCode", OLD."authorId", OLD."creatorId", OLD.extra::text)
      THEN
        NEW."sourceRevision" := OLD."sourceRevision" + 1;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `)
  await knex.raw(`CREATE TRIGGER pages_source_revision_trigger BEFORE UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION wiki_increment_page_source_revision()`)
}

const addIdentityChecks = async (knex: Knex): Promise<void> => {
  await knex.raw(`ALTER TABLE "agentSkillUses" ADD CONSTRAINT agent_skill_uses_requester_check CHECK ((("requesterUserId" IS NOT NULL)::int + ("requesterApiKeyId" IS NOT NULL)::int) = 1)`)
  await knex.raw(`ALTER TABLE "agentProposals" ADD CONSTRAINT agent_proposals_requester_check CHECK ((("requesterUserId" IS NOT NULL)::int + ("requesterApiKeyId" IS NOT NULL)::int) = 1)`)
  await knex.raw(`ALTER TABLE "agentApprovals" ADD CONSTRAINT agent_approvals_requester_check CHECK ((("requesterUserId" IS NOT NULL)::int + ("requesterApiKeyId" IS NOT NULL)::int) = 1)`)
  await knex.raw(`ALTER TABLE "agentActionExecutions" ADD CONSTRAINT agent_executions_requester_check CHECK ((("requesterUserId" IS NOT NULL)::int + ("requesterApiKeyId" IS NOT NULL)::int) = 1)`)
  await knex.raw(`ALTER TABLE "agentArtifacts" ADD CONSTRAINT agent_artifacts_png_check CHECK (kind = 'browser-screenshot' AND "mimeType" = 'image/png')`)
}

export const up = async (knex: Knex): Promise<void> => {
  await addSourceRevision(knex)
  await createProviderTables(knex)
  await createSkillTables(knex)
  await createSessionTables(knex)
  await createRunTables(knex)
  await createProposalTables(knex)
  await createMutationAndUsageTables(knex)
  await addIdentityChecks(knex)
}

export const down = async (knex: Knex): Promise<void> => {
  for (const tableName of AGENT_TABLES_IN_DROP_ORDER) {
    if (!await knex.schema.hasTable(tableName)) continue
    const row = await knex(tableName).count<{ count: string }[]>({ count: '*' }).first()
    if (Number(row?.count ?? 0) > 0) {
      throw new Error(`Cannot roll down agent architecture migration while ${tableName} contains data`)
    }
  }
  await knex.raw('ALTER TABLE "agentMessages" DROP CONSTRAINT IF EXISTS agent_messages_run_fk')
  await knex.raw('ALTER TABLE "agentSkills" DROP CONSTRAINT IF EXISTS agent_skills_current_version_fk')
  await knex.raw('ALTER TABLE "agentProviderProfiles" DROP CONSTRAINT IF EXISTS agent_provider_profiles_current_version_fk')


  for (const tableName of AGENT_TABLES_IN_DROP_ORDER) {
    await knex.schema.dropTableIfExists(tableName)
  }
  await knex.raw('DROP TRIGGER IF EXISTS pages_source_revision_trigger ON pages')
  await knex.raw('DROP FUNCTION IF EXISTS wiki_increment_page_source_revision()')
  await knex.schema.alterTable('pageHistory', table => {
    table.dropColumn('sourceRevision')
  })
  await knex.schema.alterTable('pages', table => {
    table.dropColumn('sourceRevision')
  })
}
